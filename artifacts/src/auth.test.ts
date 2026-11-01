import { describe, expect, it, vi } from "vitest";
import { cookieName, hasValidCookie, mintCookie, constantTimeMatch, SESSION_TTL_SECONDS } from "./auth";

const SECRET = "test-session-secret";
const req = (cookie?: string) =>
  new Request("https://artifacts.test/q3-deck.pdf", cookie ? { headers: { cookie } } : undefined);

async function cookieFor(scope: string, secret = SECRET) {
  const { name, value } = await mintCookie(scope, secret);
  return `${name}=${value}`;
}

describe("session cookies", () => {
  it("accepts a fresh cookie for its own scope", async () => {
    expect(await hasValidCookie(req(await cookieFor("k:a")), "k:a", SECRET)).toBe(true);
  });

  it("rejects no cookie", async () => {
    expect(await hasValidCookie(req(), "k:a", SECRET)).toBe(false);
  });

  it("rejects a cookie minted for another scope", async () => {
    const other = await cookieFor("k:b");
    // Even renamed to this scope's cookie name, the MAC is over the scope.
    const renamed = `${await cookieName("k:a", SECRET)}=${other.split("=")[1]}`;
    expect(await hasValidCookie(req(renamed), "k:a", SECRET)).toBe(false);
  });

  it("rejects a tampered MAC", async () => {
    const c = await cookieFor("k:a");
    expect(await hasValidCookie(req(c.slice(0, -1) + "0"), "k:a", SECRET)).toBe(false);
    expect(await hasValidCookie(req(c.slice(0, -1) + "1"), "k:a", SECRET)).toBe(false);
  });

  it("rejects a cookie signed with a different secret (rotation logs everyone out)", async () => {
    expect(await hasValidCookie(req(await cookieFor("k:a", "old-secret")), "k:a", SECRET)).toBe(false);
  });

  it("rejects an expired cookie even though its MAC is valid", async () => {
    const c = await cookieFor("k:a");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + (SESSION_TTL_SECONDS + 60) * 1000);
      expect(await hasValidCookie(req(c), "k:a", SECRET)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a cookie with a forged later expiry", async () => {
    const { name, value } = await mintCookie("k:a", SECRET);
    const sig = value.split(".")[1];
    const forged = `${name}=${Math.floor(Date.now() / 1000) + 10 * 365 * 86400}.${sig}`;
    expect(await hasValidCookie(req(forged), "k:a", SECRET)).toBe(false);
  });
});

describe("password comparison", () => {
  it("matches only the exact password", async () => {
    expect(await constantTimeMatch("hunter2", "hunter2", SECRET)).toBe(true);
    expect(await constantTimeMatch("hunter2", "hunter3", SECRET)).toBe(false);
    expect(await constantTimeMatch("", "hunter2", SECRET)).toBe(false);
    expect(await constantTimeMatch("hunter2 ", "hunter2", SECRET)).toBe(false);
  });
});
