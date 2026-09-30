#!/usr/bin/env node

/**
 * RAG worker: the single writer to one agent's local search index.
 *
 * Spawned and driven by lib/workspace-index.ts. It loads mcp-local-rag's
 * ingest pipeline straight from the built server (the checkout next to this
 * repo, found through LOCAL_RAG_ENTRY) so the embedding model loads once per
 * worker, not once per file the way spawning the CLI per file would. That
 * matters because the conversation mirror writes one file per message, and a
 * backfill is thousands of them.
 *
 * Protocol: one JSON request per stdin line, one JSON response per stdout line.
 *   { id, op: "ingest", path }   → { id, ok, chunks }
 *   { id, op: "delete", path }   → { id, ok, removed }
 *   { id, op: "optimize" }       → { id, ok }
 * Failures answer { id, ok: false, error }. Logs go to stderr.
 *
 * Env: LOCAL_RAG_ENTRY, DB_PATH, CACHE_DIR, MODEL_NAME, BASE_DIRS (JSON array).
 */

import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const entry = process.env.LOCAL_RAG_ENTRY;
if (!entry) {
  console.error("[rag-worker] LOCAL_RAG_ENTRY is not set");
  process.exit(1);
}
const dist = dirname(entry);
const load = (rel) => import(pathToFileURL(join(dist, rel)).href);

const [{ ingestSingleFile }, { createEmbedder, createVectorStore }, { DocumentParser }, { buildChunker }] =
  await Promise.all([
    load("cli/ingest.js"),
    load("cli/common.js"),
    load("parser/index.js"),
    load("chunker/index.js"),
  ]);

const config = {
  dbPath: process.env.DB_PATH,
  cacheDir: process.env.CACHE_DIR,
  modelName: process.env.MODEL_NAME,
};
const baseDirs = JSON.parse(process.env.BASE_DIRS ?? "[]");

const parser = new DocumentParser({ baseDirs, maxFileSize: 10 * 1024 * 1024 });
// Same chunker the MCP server's CLI ingest uses by default (recursive).
const chunker = buildChunker({});
const embedder = createEmbedder(config);
const store = createVectorStore(config);
await store.initialize();

async function handle(req) {
  switch (req.op) {
    case "ingest":
      return { chunks: await ingestSingleFile(req.path, parser, chunker, embedder, store, { visual: false }) };
    case "delete":
      return { removed: await store.deleteChunks(req.path) };
    case "optimize":
      await store.optimize();
      return {};
    default:
      throw new Error(`unknown op: ${req.op}`);
  }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// Requests are handled strictly one at a time: LanceDB writes to one table
// must not interleave.
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  chain = chain.then(async () => {
    let req;
    try {
      req = JSON.parse(line);
      send({ id: req.id, ok: true, ...(await handle(req)) });
    } catch (err) {
      send({ id: req?.id ?? null, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}).on("close", () => {
  chain.finally(async () => {
    await embedder.dispose?.().catch(() => {});
    process.exit(0);
  });
});

send({ ready: true });
