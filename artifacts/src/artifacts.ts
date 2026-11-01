/**
 * The entire access-control list for artifacts, in git, reviewable in a diff.
 *
 * Default-deny by construction: a key that is not covered by an entry here is a
 * 404. Uploading a file does not publish it — you also add a line below. So a
 * forgotten artifact is locked, not exposed.
 *
 * Two kinds of key:
 *   "q3-deck.pdf"   exact object key
 *   "demo/"         prefix (trailing slash) — covers every key under it, which
 *                   is what an HTML artifact with subresources needs
 *
 * Two kinds of entry:
 *   { password: "PW_FOO" }  name of a Worker secret holding the password.
 *                           NEVER the password itself — this file is public.
 *   { public: true }        explicit opt-in to no auth. Loud in review.
 *
 * `group` lets several entries share one unlock, so a password typed for one
 * artifact works for the others in that group. Without it, each entry is its
 * own scope and a cookie minted for A does nothing for B.
 */

export type Entry =
  | { password: string; group?: string; index?: string }
  | { public: true; index?: string };

export const ARTIFACTS: Record<string, Entry> = {
  // --- examples; replace with real artifacts ---------------------------------
  // "q3-deck.pdf": { password: "PW_Q3" },
  // "demo/": { password: "PW_DEMO", index: "index.html" },
  // "wedding/menus/": { password: "PW_WEDDING", group: "wedding" },
  // "wedding/seating.pdf": { password: "PW_WEDDING", group: "wedding" },
  // "og-image.png": { public: true },
};

export type Resolved = { key: string; entry: Entry; scope: string };

/**
 * Resolve a request path to an object key + the entry that guards it.
 *
 * Exact keys win over prefixes; among prefixes the longest wins, so
 * "demo/private/" can be tighter than "demo/". Returns null for anything not
 * covered — the caller turns that into a 404.
 */
export function resolve(pathname: string, acl: Record<string, Entry> = ARTIFACTS): Resolved | null {
  const key = decodeURIComponent(pathname.replace(/^\/+/, ""));

  // Path traversal and absolute keys never reach the bucket.
  if (key.includes("..") || key.startsWith("/")) return null;

  const exact = acl[key];
  if (exact) return { key: keyFor(key, exact), entry: exact, scope: scopeFor(key, exact) };

  let bestPrefix: string | null = null;
  for (const candidate of Object.keys(acl)) {
    if (!candidate.endsWith("/")) continue;
    if (!key.startsWith(candidate)) continue;
    if (bestPrefix === null || candidate.length > bestPrefix.length) bestPrefix = candidate;
  }
  if (bestPrefix === null) {
    // "demo" with no trailing slash, where "demo/" is an entry → treat as the
    // directory itself so a bare link works.
    const asDir = `${key}/`;
    const dirEntry = acl[asDir];
    if (key !== "" && dirEntry) {
      return { key: keyFor(asDir, dirEntry), entry: dirEntry, scope: scopeFor(asDir, dirEntry) };
    }
    return null;
  }

  const entry = acl[bestPrefix]!;
  return { key: keyFor(key, entry), entry, scope: scopeFor(bestPrefix, entry) };
}

/** A directory key resolves to its index file; anything else is itself. */
function keyFor(key: string, entry: Entry): string {
  return key.endsWith("/") ? key + (entry.index ?? "index.html") : key;
}

/**
 * The cookie scope. A group shares one unlock; otherwise the scope is the entry
 * that matched, so the demo password cannot open the Q3 deck.
 */
function scopeFor(entryKey: string, entry: Entry): string {
  if ("password" in entry && entry.group) return `g:${entry.group}`;
  return `k:${entryKey}`;
}
