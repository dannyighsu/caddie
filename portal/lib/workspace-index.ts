/**
 * Workspace index: keeps the local search index in sync with the workspace.
 *
 * The agent searches the index through the `local-rag` capability
 * (mcp-local-rag, read-only for the agent). This module is the index's only
 * writer. Every change goes through one queue, drained by a worker
 * process (scripts/rag-worker.mjs) that keeps the embedding model loaded.
 *
 * Changes are found by content hash against a manifest
 * (`<workspace>/.rag/manifest.json`). The workspace isn't a git repo, so the
 * library's git-diff approach doesn't apply. A sync runs:
 *   - shortly after a conversation message is mirrored (debounced),
 *   - after any agent run finishes (it may have written files),
 *   - at startup, after the mirror backfill,
 *   - every 15 minutes, to catch edits made outside a run.
 * Requests that arrive while a sync is running coalesce into one follow-up.
 *
 * Nothing here runs on the path of an inbound message or an agent run, and
 * nothing here throws to a caller. Indexing is best-effort and self-repairing:
 * a failed file is retried on every later sync.
 *
 * Enabled when LOCAL_RAG_ENTRY points at a built mcp-local-rag (`make rag-setup`).
 */

import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { resolve } from "path";
import { createInterface } from "readline";
import { workspaceDir } from "@caddie/harness";
import {
  RAG_DIR,
  RAG_MODEL_NAME,
  emptyManifest,
  isExcludedDir,
  isIndexableFile,
  planSync,
  rebuildReason,
  type FileFingerprint,
  type RagManifest,
} from "./rag-files";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** Mirror writes arrive in bursts (a thread's turns, a backfill); sync once per burst. */
export const MIRROR_SYNC_DEBOUNCE_MS = 5_000;
/** Free the worker (and the embedding model's memory) when there's nothing to do. */
const WORKER_IDLE_MS = 2 * 60 * 1000;
const WORKER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Save progress this often during a long sync, so a crash costs little rework. */
const MANIFEST_SAVE_EVERY = 50;

/** Whether indexing is configured on this install. */
export function ragEnabled(): boolean {
  const entry = process.env.LOCAL_RAG_ENTRY;
  return !!entry && existsSync(entry);
}

export interface IndexStatus {
  enabled: boolean;
  syncing: boolean;
  lastSync: string | null;
  indexedFiles: number;
  failures: number;
  /** Set when the index must be rebuilt before it can sync (`make rag-rebuild`). */
  rebuildRequired: string | null;
  lastError: string | null;
}

// --- Worker client ---

type WorkerOp = { op: "ingest"; path: string } | { op: "delete"; path: string } | { op: "optimize" };

class RagWorker {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly ready: Promise<void>;
  exited = false;

  constructor(workspace: string) {
    const ragDir = resolve(workspace, RAG_DIR);
    this.proc = spawn(process.execPath, [resolve(process.cwd(), "scripts", "rag-worker.mjs")], {
      env: {
        ...process.env,
        DB_PATH: resolve(ragDir, "db"),
        CACHE_DIR: resolve(ragDir, "models"),
        MODEL_NAME: RAG_MODEL_NAME,
        BASE_DIRS: JSON.stringify([workspace]),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let markReady: () => void;
    let failReady: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      markReady = res;
      failReady = rej;
    });

    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ready) return markReady();
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg);
      else waiter.reject(new Error(msg.error ?? "worker error"));
    });

    let stderrTail = "";
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    this.proc.on("exit", (code) => {
      this.exited = true;
      const err = new Error(`rag worker exited (${code})${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ""}`);
      failReady(err);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    });
    this.proc.on("error", (err) => failReady(err));
  }

  request<T = Record<string, unknown>>(op: WorkerOp): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`rag worker timed out on ${op.op}`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.proc.stdin!.write(`${JSON.stringify({ id, ...op })}\n`);
    });
  }

  stop(): void {
    if (!this.exited) this.proc.stdin!.end();
  }
}

// --- The index ---

class WorkspaceIndex {
  readonly workspace: string;
  private readonly ragDir: string;
  private readonly manifestPath: string;
  private readonly lockPath: string;
  /** Serial queue: syncs, purge deletions and rebuilds never overlap. */
  private chain: Promise<void> = Promise.resolve();
  private syncQueued = false;
  private debounce: NodeJS.Timeout | null = null;
  private worker: RagWorker | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** rel path → last seen size/mtime/hash, so unchanged files aren't re-read every sync. */
  private hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  private status: Omit<IndexStatus, "enabled">;

  constructor() {
    this.workspace = workspaceDir();
    this.ragDir = resolve(this.workspace, RAG_DIR);
    this.manifestPath = resolve(this.ragDir, "manifest.json");
    this.lockPath = resolve(this.ragDir, "writer.lock");
    this.status = { syncing: false, lastSync: null, indexedFiles: 0, failures: 0, rebuildRequired: null, lastError: null };
  }

  getStatus(): IndexStatus {
    return { enabled: ragEnabled(), ...this.status };
  }

  /** Ask for a sync `delayMs` from now; repeated requests within the window collapse. */
  requestSync(delayMs = 0): void {
    if (!ragEnabled()) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.enqueueSync();
    }, delayMs);
  }

  private enqueueSync(): void {
    // At most one sync waits behind the running one; it will see every change
    // that prompted the requests it absorbed.
    if (this.syncQueued) return;
    this.syncQueued = true;
    this.enqueue(async () => {
      this.syncQueued = false;
      await this.sync();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task).catch((err) => {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[RagIndex] ${this.status.lastError}`);
    });
    this.chain = run;
    return run;
  }

  /** Remove one workspace file's entries from the index now (purge). */
  removeNow(relPath: string): Promise<void> {
    if (!ragEnabled()) return Promise.resolve();
    return this.enqueue(async () => {
      await this.withLock(async () => {
        const manifest = await this.loadManifest();
        await (await this.getWorker()).request({ op: "delete", path: resolve(this.workspace, relPath) });
        delete manifest.files[relPath];
        manifest.failures = manifest.failures.filter((p) => p !== relPath);
        this.hashCache.delete(relPath);
        await this.saveManifest(manifest);
        console.log(`[RagIndex] removed ${relPath}`);
      });
      this.scheduleWorkerIdle();
    });
  }

  /** Drop the index and build it again from the workspace. */
  rebuild(): Promise<void> {
    return this.enqueue(async () => {
      this.worker?.stop();
      this.worker = null;
      await rm(resolve(this.ragDir, "db"), { recursive: true, force: true });
      await rm(this.manifestPath, { force: true });
      this.hashCache.clear();
      this.status.rebuildRequired = null;
      console.log(`[RagIndex] index dropped for rebuild`);
      await this.sync();
    });
  }

  private async sync(): Promise<void> {
    if (!ragEnabled()) return;
    await this.withLock(async () => {
      const manifest = await this.loadManifest();
      const reason = rebuildReason(manifest, this.workspace);
      if (reason) {
        this.status.rebuildRequired = reason;
        console.warn(`[RagIndex] not syncing — rebuild required: ${reason}. Run: make rag-rebuild`);
        return;
      }
      this.status.rebuildRequired = null;
      this.status.syncing = true;
      try {
        await this.syncWith(manifest);
      } finally {
        this.status.syncing = false;
      }
    });
    this.scheduleWorkerIdle();
  }

  private async syncWith(manifest: RagManifest): Promise<void> {
    const onDisk = await this.scan();
    const { ingest, remove } = planSync(manifest, onDisk);
    // A failure for a file that's gone is moot.
    manifest.failures = manifest.failures.filter((p) => onDisk.has(p));

    if (ingest.length > 0 || remove.length > 0) {
      const worker = await this.getWorker();
      let done = 0;
      const checkpoint = async () => {
        if (++done % MANIFEST_SAVE_EVERY === 0) await this.saveManifest(manifest);
      };

      let removed = 0;
      for (const rel of remove) {
        try {
          await worker.request({ op: "delete", path: resolve(this.workspace, rel) });
          delete manifest.files[rel];
          removed++;
        } catch (err) {
          console.error(`[RagIndex] delete failed for ${rel}: ${(err as Error).message}`);
        }
        await checkpoint();
      }

      let ingested = 0;
      const failed = new Set(manifest.failures);
      for (const rel of ingest) {
        try {
          await worker.request({ op: "ingest", path: resolve(this.workspace, rel) });
          manifest.files[rel] = onDisk.get(rel)!;
          failed.delete(rel);
          ingested++;
        } catch (err) {
          failed.add(rel);
          console.error(`[RagIndex] ingest failed for ${rel}: ${(err as Error).message}`);
        }
        manifest.failures = [...failed].sort();
        await checkpoint();
      }

      await worker.request({ op: "optimize" });
      console.log(
        `[RagIndex] sync: ${ingested} ingested, ${removed} removed, ${manifest.failures.length} failing`
      );
    }

    manifest.last_sync = new Date().toISOString();
    await this.saveManifest(manifest);
    this.status.lastSync = manifest.last_sync;
    this.status.lastError = null;
  }

  /** Every eligible file in the workspace, with its content fingerprint. */
  private async scan(): Promise<Map<string, FileFingerprint>> {
    const found = new Map<string, FileFingerprint>();
    const walk = async (relDir: string): Promise<void> => {
      const abs = relDir ? resolve(this.workspace, relDir) : this.workspace;
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        // Never follow links: skills and the harness settings point into the repo.
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!isExcludedDir(rel)) await walk(rel);
          continue;
        }
        if (!e.isFile()) continue;
        let st;
        try {
          st = await stat(resolve(this.workspace, rel));
        } catch {
          continue;
        }
        if (!isIndexableFile(rel, st.size)) continue;
        const cached = this.hashCache.get(rel);
        if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
          found.set(rel, { sha256: cached.sha256, size: st.size });
          continue;
        }
        try {
          const sha256 = createHash("sha256").update(await readFile(resolve(this.workspace, rel))).digest("hex");
          this.hashCache.set(rel, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
          found.set(rel, { sha256, size: st.size });
        } catch {
          // Vanished between readdir and read.
        }
      }
    };
    await walk("");
    return found;
  }

  private async getWorker(): Promise<RagWorker> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.worker || this.worker.exited) {
      await mkdir(this.ragDir, { recursive: true });
      this.worker = new RagWorker(this.workspace);
    }
    await this.worker.ready;
    return this.worker;
  }

  private scheduleWorkerIdle(): void {
    if (!this.worker) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.worker?.stop();
      this.worker = null;
      this.idleTimer = null;
    }, WORKER_IDLE_MS);
    this.idleTimer.unref();
  }

  private async loadManifest(): Promise<RagManifest> {
    let manifest: RagManifest;
    try {
      manifest = JSON.parse(await readFile(this.manifestPath, "utf-8")) as RagManifest;
    } catch {
      manifest = emptyManifest(this.workspace);
    }
    this.status.indexedFiles = Object.keys(manifest.files).length;
    this.status.failures = manifest.failures.length;
    return manifest;
  }

  private async saveManifest(manifest: RagManifest): Promise<void> {
    await mkdir(this.ragDir, { recursive: true });
    const tmp = `${this.manifestPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 1));
    await rename(tmp, this.manifestPath);
    this.status.indexedFiles = Object.keys(manifest.files).length;
    this.status.failures = manifest.failures.length;
  }

  /**
   * Hold the writer lock for `fn`. Only one process may write an
   * index; a second portal (say `make dev` beside `make run`) skips its sync
   * rather than interleaving writes with the first.
   */
  private async withLock(fn: () => Promise<void>): Promise<void> {
    await mkdir(this.ragDir, { recursive: true });
    try {
      const holder = Number((await readFile(this.lockPath, "utf-8")).trim());
      if (holder && holder !== process.pid && processAlive(holder)) {
        console.warn(`[RagIndex] another process (pid ${holder}) owns the index; skipping`);
        return;
      }
    } catch {
      // No lock yet.
    }
    await writeFile(this.lockPath, String(process.pid));
    try {
      await fn();
    } finally {
      await rm(this.lockPath, { force: true });
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// --- Process-wide registry ---
//
// On globalThis rather than module scope: Next.js bundles instrumentation and
// route handlers separately, so a module-level map would give each bundle its
// own indexer, and two writers.

interface Registry {
  index: WorkspaceIndex | null;
  started: boolean;
}

function registry(): Registry {
  const g = globalThis as { __caddieRagIndex?: Registry };
  g.__caddieRagIndex ??= { index: null, started: false };
  return g.__caddieRagIndex;
}

function theIndex(): WorkspaceIndex {
  const reg = registry();
  reg.index ??= new WorkspaceIndex();
  return reg.index;
}

/** Request a sync of the index. Never throws; a no-op when indexing is off. */
export function requestIndexSync(delayMs = 0): void {
  try {
    theIndex().requestSync(delayMs);
  } catch (err) {
    console.error(`[RagIndex] could not request sync:`, err);
  }
}

/** Remove a file's entries from the index right away (queued behind any running sync). */
export function removeFromIndex(relPath: string): Promise<void> {
  return theIndex().removeNow(relPath);
}

/** Drop and rebuild the index. Resolves when the rebuild finishes. */
export function rebuildIndex(): Promise<void> {
  return theIndex().rebuild();
}

export function indexStatus(): IndexStatus {
  return theIndex().getStatus();
}

/**
 * Start indexing. Idempotent. `prepare` runs first (the conversation mirror's
 * backfill), so the first sync sees a complete mirror.
 */
export function startWorkspaceIndex(prepare?: () => Promise<void>): void {
  const reg = registry();
  if (reg.started) return;
  reg.started = true;

  if (!ragEnabled()) {
    console.log("[RagIndex] LOCAL_RAG_ENTRY not set (or not built) — workspace search is off. See `make rag-setup`.");
  }

  (async () => {
    try {
      await prepare?.();
    } catch (err) {
      console.error(`[RagIndex] startup prepare failed:`, err);
    }
    requestIndexSync();
  })();

  const sweep = setInterval(() => requestIndexSync(), SWEEP_INTERVAL_MS);
  sweep.unref();
}
