/**
 * Upload a file (or a directory) to the artifacts bucket with the right
 * Content-Type.
 *
 *   pnpm --filter @caddie/artifacts upload <path> [--key <key>] [--remote]
 *
 * Why a script rather than `wrangler r2 object put` by hand: R2 serves back
 * exactly the Content-Type stored at upload time and does no extension
 * sniffing. Get it wrong and the browser downloads your HTML as a file or
 * renders your PDF as mojibake. This sets it from the extension every time.
 *
 * Uploading does NOT publish. The key also needs an entry in src/artifacts.ts,
 * or the Worker 404s it.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { extname, join, posix, relative, resolve as resolvePath } from "node:path";
import { ARTIFACTS } from "../src/artifacts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
};

function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("usage: upload <file-or-dir> [--key <key>] [--remote]");
    process.exit(1);
  }
  const keyFlag = args.indexOf("--key");
  const keyPrefix = keyFlag >= 0 ? args[keyFlag + 1] : null;
  const remote = args.includes("--remote");

  const abs = resolvePath(path);
  const isDir = statSync(abs).isDirectory();
  const files = isDir ? walk(abs) : [abs];

  const uploaded: string[] = [];
  for (const file of files) {
    const key = isDir
      ? posix.join(keyPrefix ?? posix.basename(abs), relative(abs, file).split(/[\\/]/).join("/"))
      : (keyPrefix ?? posix.basename(abs));
    const type = TYPES[extname(file).toLowerCase()];
    if (!type) {
      console.error(`! no Content-Type mapped for ${extname(file)} (${file}) — add it to TYPES`);
      process.exit(1);
    }
    put(key, file, type, remote);
    uploaded.push(key);
    console.log(`→ ${key}  (${type})`);
  }

  warnIfUnlisted(uploaded);
}

function put(key: string, file: string, contentType: string, remote: boolean) {
  const bucket = "caddie-artifacts";
  const args = [
    "wrangler", "r2", "object", "put", `${bucket}/${key}`,
    "--file", file,
    "--content-type", contentType,
    remote ? "--remote" : "--local",
  ];
  execFileSync("pnpm", ["exec", ...args], { stdio: "inherit" });
}

/** Loud reminder that the ACL, not the bucket, is what publishes a key. */
function warnIfUnlisted(keys: string[]) {
  const covered = (key: string) =>
    Object.keys(ARTIFACTS).some((e) => (e.endsWith("/") ? key.startsWith(e) : e === key));
  const unlisted = keys.filter((k) => !covered(k));
  if (unlisted.length === 0) return;
  console.log("\nUploaded but NOT reachable (no entry in src/artifacts.ts):");
  for (const k of unlisted) console.log(`  ${k}`);
  console.log("Add an entry, then `pnpm --filter @caddie/artifacts deploy`.");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

main();
