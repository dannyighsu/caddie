/**
 * Publish workspace files to the password-gated artifact host (artifacts/).
 *
 * Everything lands under one ACL entry, `shared/` in artifacts/src/artifacts.ts,
 * so publishing needs no Worker deploy and this code needs no access to the
 * Worker: an R2 token scoped to the bucket is enough. That entry has one
 * password, so a random id per publish is what keeps artifacts apart.
 *
 * Only `runs/<month>/<day>/artifacts/` is publishable. This is the one path
 * from the workspace to the internet, and config, conversations and tickets
 * must never be a stray `paths: ["."]` away from it.
 */

import { randomBytes } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { AwsClient } from "aws4fetch";

const BUCKET = "caddie-artifacts";
const PREFIX = "shared";
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Something inside a run's artifacts directory, never the directory itself. */
const PUBLISHABLE = /^runs\/[^/]+\/[^/]+\/artifacts\/.+/;

/**
 * R2 serves back the stored Content-Type and does no sniffing. Same table as
 * artifacts/scripts/upload.ts, which can't be imported from here.
 */
const TYPES = {
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

const toPosix = (p) => p.split(sep).join("/");
const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

/** Longest directory containing every given directory. */
function commonDir(dirs) {
  const split = dirs.map((d) => d.split(sep));
  let n = 0;
  while (split.every((s) => n < s.length && s[n] === split[0][n])) n++;
  return split[0].slice(0, n).join(sep) || sep;
}

/** Every file under `dir`. Dotfiles are skipped; a symlink stops the publish. */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${entry.name} is a symlink, and links aren't published. Copy the real file in instead.`);
    }
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Resolve `paths` to the files to upload, each with its name relative to the
 * artifact's root. Folder structure is kept, so a page's relative links work.
 * Throws a message meant for the model.
 */
export async function collectFiles(workspace, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("Pass at least one path.");

  const root = await realpath(workspace);
  const targets = [];
  for (const path of paths) {
    let abs;
    try {
      abs = await realpath(resolve(root, path));
    } catch {
      throw new Error(`Not found: ${path}`);
    }
    if (!PUBLISHABLE.test(toPosix(relative(root, abs)))) {
      throw new Error(`${path} can't be published: copy it into today's run artifacts/ directory first, and publish it from there.`);
    }
    targets.push({ abs, isDir: (await stat(abs)).isDirectory() });
  }

  const base = targets.length === 1 && targets[0].isDir ? targets[0].abs : commonDir(targets.map((t) => dirname(t.abs)));

  const found = new Set();
  for (const { abs, isDir } of targets) {
    for (const file of isDir ? await walk(abs) : [abs]) found.add(file);
  }

  if (found.size === 0) throw new Error("Nothing to publish: no files found at those paths.");
  if (found.size > MAX_FILES) throw new Error(`${found.size} files is too many; the limit is ${MAX_FILES}.`);

  let total = 0;
  const files = [];
  for (const abs of found) {
    const name = toPosix(relative(base, abs));
    const contentType = TYPES[extname(abs).toLowerCase()];
    if (!contentType) throw new Error(`${name} can't be published: ${extname(abs) || "no extension"} isn't a supported file type.`);
    // The Worker refuses any key containing "..", so the link would be dead.
    if (name.includes("..")) throw new Error(`${name} can't be published: rename it so it doesn't contain "..".`);
    total += (await stat(abs)).size;
    files.push({ abs, name, contentType });
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`These files total ${total} bytes; the limit is ${MAX_TOTAL_BYTES}.`);

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Open the link the way a recipient would. The usual reason it fails is this
 * install's password disagreeing with the Worker's, and that has to surface
 * here instead of as a dead link in someone's inbox.
 */
async function verifyLink(link, password) {
  const { origin, pathname } = new URL(link);
  const auth = await fetch(`${origin}/_auth`, {
    method: "POST",
    body: new URLSearchParams({ password, next: pathname }),
    redirect: "manual",
  });
  const cookie = auth.headers.get("set-cookie")?.split(";")[0];
  if (auth.status !== 303 || !cookie) {
    throw new Error(
      `Uploaded, but logging in to the link failed (${auth.status}), so don't send it. ` +
        "ARTIFACTS_PASSWORD probably doesn't match the Worker's PW_SHARED secret. File a ticket.",
    );
  }
  const res = await fetch(link, { method: "HEAD", headers: { cookie }, redirect: "manual" });
  if (res.status !== 200) {
    throw new Error(`Uploaded, but the link returned ${res.status} after logging in, so don't send it. File a ticket.`);
  }
}

/**
 * Upload `paths` as one artifact and return its links: the folder when there's
 * an index.html at the root, otherwise one per file.
 *
 * `config`: { origin, password, accountId, accessKeyId, secretAccessKey }
 */
export async function publish(workspace, paths, config) {
  const files = await collectFiles(workspace, paths);
  const root = `${PREFIX}/${randomBytes(16).toString("hex")}`;

  const r2 = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
    retries: 3,
  });
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com/${BUCKET}`;

  for (const file of files) {
    const res = await r2.fetch(`${endpoint}/${encodeKey(`${root}/${file.name}`)}`, {
      method: "PUT",
      headers: { "content-type": file.contentType },
      body: await readFile(file.abs),
    });
    if (!res.ok) throw new Error(`Upload of ${file.name} failed (${res.status}). Nothing was published.`);
  }

  const origin = config.origin.replace(/\/$/, "");
  const links = files.some((f) => f.name === "index.html")
    ? [`${origin}/${root}/`]
    : files.map((f) => `${origin}/${encodeKey(`${root}/${f.name}`)}`);

  await verifyLink(links[0], config.password);
  return { files: files.map((f) => f.name), links };
}
