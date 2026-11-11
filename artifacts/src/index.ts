/**
 * Password-gated artifact server.
 *
 * The guarantee is structural, not a policy anyone has to remember:
 *
 *   • The R2 bucket is private. No public access, r2.dev disabled, no custom
 *     domain on the bucket. The only route to an object is this Worker.
 *   • This file contains exactly one `env.BUCKET.get()` call, and the code path
 *     to it passes through one auth check whose default branch is deny.
 *   • A key with no entry in artifacts.ts is a 404, so uploading a file does
 *     not publish it.
 *
 * Nothing is enforced in the browser: an unauthorised request never receives a
 * byte of artifact content, so view-source and curl see the login page too.
 */

import { ARTIFACTS, resolve, type Entry } from "./artifacts";
import { hasValidCookie, mintCookie, setCookieHeader, constantTimeMatch } from "./auth";
import { loginPage } from "./login";

export interface Env {
  BUCKET: R2Bucket;
  SESSION_SECRET: string;
  // Artifact passwords are additional secrets, referenced by name from
  // artifacts.ts (PW_Q3, PW_DEMO, …).
  [secret: string]: unknown;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/_auth") return handleAuth(req, env);
    if (url.pathname === "/" || url.pathname === "") return loginPage(200, "/");
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const hit = resolve(url.pathname);
    if (!hit) return notFound();

    // ---- the single gate; every branch above or below it denies by default ---
    if (!("public" in hit.entry)) {
      if (!(await hasValidCookie(req, hit.scope, env.SESSION_SECRET))) {
        return loginPage(401, url.pathname + url.search);
      }
    }

    const range = parseRange(req.headers.get("range"));
    const obj = await env.BUCKET.get(hit.key, range ? { range } : undefined);
    if (!obj) return notFound();

    const headers = artifactHeaders(obj, "public" in hit.entry, url.origin);
    if (req.method === "HEAD") return new Response(null, { status: 200, headers });

    if (range && obj.range && "offset" in obj.range) {
      const offset = obj.range.offset ?? 0;
      const length = obj.range.length ?? obj.size - offset;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      return new Response(obj.body, { status: 206, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  },
} satisfies ExportedHandler<Env>;

function artifactHeaders(obj: R2Object, isPublic: boolean, origin: string): Headers {
  return new Headers({
    // R2 serves what was stored; there is no extension sniffing, so the upload
    // script is what makes HTML render instead of download. See scripts/upload.ts.
    "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
    "content-disposition": obj.httpMetadata?.contentDisposition ?? "inline",
    "x-content-type-options": "nosniff",
    // A cached 200 replayed to an unauthenticated request is the classic way
    // this design leaks. Public artifacts may be cached; gated ones never.
    "cache-control": isPublic ? "public, max-age=3600" : "private, no-store",
    "accept-ranges": "bytes",
    "referrer-policy": "no-referrer",
    etag: obj.httpEtag,
    // `sandbox` applies even when the artifact is opened top-level rather than
    // framed, so artifact JS cannot reach this origin's cookies or storage.
    // `sandbox` gives the document an opaque origin, which means 'self' no
    // longer matches anything — subresources have to be allowed by explicit
    // host, or an HTML artifact's own js/css/images 404 at the CSP layer.
    "content-security-policy":
      `default-src 'none'; img-src ${origin} data: blob:; media-src ${origin} data: blob:; ` +
      `font-src ${origin} data:; style-src ${origin} 'unsafe-inline'; ` +
      `script-src ${origin} 'unsafe-inline'; connect-src ${origin}; ` +
      "frame-ancestors 'self'; sandbox allow-scripts allow-popups allow-forms",
  });
}

async function handleAuth(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? "/"));

  const hit = resolve(new URL(next, "https://x").pathname);
  // Don't say whether the key exists — same denial either way.
  if (!hit || "public" in hit.entry) return loginPage(401, next, "Incorrect password.");

  const expected = env[(hit.entry as { password: string }).password];
  if (typeof expected !== "string" || expected.length === 0) {
    // The ACL names a secret that was never set. Deny — never fall open.
    console.error(`missing Worker secret: ${(hit.entry as { password: string }).password}`);
    return loginPage(401, next, "Incorrect password.");
  }

  if (!(await constantTimeMatch(password, expected, env.SESSION_SECRET))) {
    return loginPage(401, next, "Incorrect password.");
  }

  const cookie = await mintCookie(hit.scope, env.SESSION_SECRET);
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": setCookieHeader(cookie.name, cookie.value),
      "cache-control": "private, no-store",
    },
  });
}

/** Only a same-origin relative path may be redirected to after login. */
function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

function parseRange(header: string | null): { offset: number; length?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  if (startRaw === "") return null; // suffix ranges: let R2 serve the whole object
  const offset = Number(startRaw);
  if (endRaw === "") return { offset };
  return { offset, length: Number(endRaw) - offset + 1 };
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

// Re-exported so the guard test and upload script can read the same ACL.
export { ARTIFACTS, type Entry };
