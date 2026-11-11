/**
 * The deterministic guard: proves against a *deployed* Worker that an
 * unauthenticated request cannot get artifact bytes. Make it a test, not a
 * habit — run it on every deploy, and it fails loudly the day someone flips
 * the bucket public to debug something.
 *
 *   pnpm --filter @caddie/artifacts guard
 *
 * Required env:
 *   ARTIFACT_ORIGIN   https://artifacts.example.com
 *   GUARD_KEY         key of a gated artifact that exists
 *   GUARD_PASSWORD    its password
 *   GUARD_CANARY      a string that appears in that artifact's content
 * Optional env (each enables one more check):
 *   GUARD_OTHER_KEY   a gated artifact in a DIFFERENT scope — proves one
 *                     artifact's cookie does not unlock another
 *   GUARD_UNLISTED    a key with no entry in artifacts.ts (default: a random one)
 *   R2_PUBLIC_URL     the bucket's r2.dev URL — asserts it is disabled
 */

const origin = required("ARTIFACT_ORIGIN").replace(/\/$/, "");
const key = required("GUARD_KEY");
const password = required("GUARD_PASSWORD");
const canary = required("GUARD_CANARY");
const otherKey = process.env.GUARD_OTHER_KEY;
const unlisted = process.env.GUARD_UNLISTED ?? `guard-unlisted-${Math.random().toString(36).slice(2)}`;
const r2PublicUrl = process.env.R2_PUBLIC_URL;

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const url = (k: string) => `${origin}/${k.split("/").map(encodeURIComponent).join("/")}`;

async function main() {
  console.log(`guard: ${origin}\n`);

  await check("no cookie → 401 and no artifact bytes", async () => {
    const res = await fetch(url(key), { redirect: "manual" });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    const body = await res.text();
    assert(!body.includes(canary), "canary string leaked in the denial body");
  });

  await check("HEAD with no cookie → 401", async () => {
    const res = await fetch(url(key), { method: "HEAD", redirect: "manual" });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("tampered cookie → 401", async () => {
    // Every cookie name is wrong except the real one, so send a plausible pair
    // plus a mangled copy of whatever a real login would set.
    const real = await login(key, password);
    const [name, value] = real.split("=");
    const tampered = `${name}=${value!.slice(0, -1)}${value!.endsWith("a") ? "b" : "a"}`;
    const res = await fetch(url(key), { headers: { cookie: tampered }, redirect: "manual" });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(!(await res.text()).includes(canary), "canary leaked to a tampered cookie");
  });

  await check("wrong password → 401, no cookie set", async () => {
    const res = await fetch(`${origin}/_auth`, {
      method: "POST",
      body: new URLSearchParams({ password: `${password}-wrong`, next: `/${key}` }),
      redirect: "manual",
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(!res.headers.has("set-cookie"), "a cookie was set for a wrong password");
  });

  await check("unlisted key → 404", async () => {
    const res = await fetch(url(unlisted), { redirect: "manual" });
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("POST to an artifact path → 405", async () => {
    const res = await fetch(url(key), { method: "POST", redirect: "manual" });
    assert(res.status === 405, `expected 405, got ${res.status}`);
  });

  await check("correct password → 200, content, uncacheable", async () => {
    const cookie = await login(key, password);
    const res = await fetch(url(key), { headers: { cookie }, redirect: "manual" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert((await res.text()).includes(canary), "authenticated response did not contain the canary");
    const cc = res.headers.get("cache-control") ?? "";
    assert(cc.includes("no-store"), `gated response is cacheable: cache-control: ${cc}`);
    assert(
      (res.headers.get("cf-cache-status") ?? "MISS").toUpperCase() !== "HIT",
      "gated response was served from the edge cache",
    );
    assert(res.headers.get("x-content-type-options") === "nosniff", "missing nosniff");
    assert((res.headers.get("content-security-policy") ?? "").includes("sandbox"), "missing CSP sandbox");
  });

  if (otherKey) {
    await check("cookie for one artifact does not unlock another", async () => {
      const cookie = await login(key, password);
      const res = await fetch(url(otherKey), { headers: { cookie }, redirect: "manual" });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });
  } else {
    console.log("  skip  cross-artifact cookie replay (set GUARD_OTHER_KEY)");
  }

  if (r2PublicUrl) {
    await check("bucket r2.dev subdomain is disabled", async () => {
      const res = await fetch(`${r2PublicUrl.replace(/\/$/, "")}/${key}`, { redirect: "manual" });
      assert(res.status !== 200, `r2.dev served the object (${res.status}) — public access is ON`);
    });
  } else {
    console.log("  skip  r2.dev disabled (set R2_PUBLIC_URL)");
  }

  console.log("");
  if (failures.length) {
    console.error(`guard FAILED: ${failures.length} check(s)\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("guard passed");
}

/** Log in and return the Cookie header value. */
async function login(forKey: string, pw: string): Promise<string> {
  const res = await fetch(`${origin}/_auth`, {
    method: "POST",
    body: new URLSearchParams({ password: pw, next: `/${forKey}` }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`login failed (${res.status}): no Set-Cookie`);
  return setCookie.split(";")[0]!;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`guard: missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

main();
