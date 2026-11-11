/**
 * Stateless session cookies: value is `exp.HMAC(scope|exp)`, signed with
 * SESSION_SECRET. Nothing to store, nothing to expire server-side, and a cookie
 * minted for one scope fails the MAC check for any other.
 */

const enc = new TextEncoder();

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Cookie name for a scope. Hashed so the name leaks neither key nor group. */
export async function cookieName(scope: string, secret: string): Promise<string> {
  const digest = await hmac(secret, `cookie-name|${scope}`);
  return `__a_${digest.slice(0, 16)}`;
}

export async function mintCookie(scope: string, secret: string): Promise<{ name: string; value: string }> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await hmac(secret, `${scope}|${exp}`);
  return { name: await cookieName(scope, secret), value: `${exp}.${sig}` };
}

/** True only for a cookie whose MAC matches this scope and whose expiry is in the future. */
export async function hasValidCookie(req: Request, scope: string, secret: string): Promise<boolean> {
  const name = await cookieName(scope, secret);
  const raw = readCookie(req.headers.get("cookie"), name);
  if (!raw) return false;

  const dot = raw.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return false;

  return timingSafeEqual(sig, await hmac(secret, `${scope}|${exp}`));
}

/**
 * `SameSite=None` rather than `Lax`, deliberately. The CSP `sandbox` directive
 * on artifact responses gives the document an opaque origin, so its own
 * subresource requests count as cross-site and a Lax cookie would not be sent —
 * a gated HTML artifact would load and then 401 on its own js/css. Same story
 * when an artifact is embedded in an iframe elsewhere. There is no CSRF surface
 * to trade away: the only non-GET endpoint is /_auth, which ignores cookies and
 * requires the password.
 */
export function setCookieHeader(name: string, value: string): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two secrets without leaking length or position through timing. Both
 * sides are hashed first so the comparison is always over equal-length digests.
 */
export async function constantTimeMatch(a: string, b: string, secret: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hmac(secret, `cmp|${a}`), hmac(secret, `cmp|${b}`)]);
  return timingSafeEqual(ha, hb);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
