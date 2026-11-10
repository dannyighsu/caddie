import { describe, expect, it } from "vitest";
import { ARTIFACTS, resolve, type Entry } from "./artifacts";

const ACL: Record<string, Entry> = {
  "q3-deck.pdf": { password: "PW_Q3" },
  "demo/": { password: "PW_DEMO", index: "index.html" },
  "demo/private/": { password: "PW_PRIVATE" },
  "wedding/menus/": { password: "PW_WEDDING", group: "wedding" },
  "wedding/seating.pdf": { password: "PW_WEDDING", group: "wedding" },
  "og-image.png": { public: true },
};

const r = (p: string) => resolve(p, ACL);

/** The links `publish_artifact` (harness/tools/artifacts-publish.mjs) hands out. */
describe("the shared/ entry", () => {
  it("serves a published folder's index and its subresources", () => {
    expect(resolve("/shared/abc123/")).toMatchObject({ key: "shared/abc123/index.html", scope: "k:shared/" });
    expect(resolve("/shared/abc123/img/chart.png")).toMatchObject({ key: "shared/abc123/img/chart.png", scope: "k:shared/" });
    expect(resolve("/shared/abc123/floor%20plan.pdf")).toMatchObject({ key: "shared/abc123/floor plan.pdf" });
  });

  it("is password-gated and doesn't share a scope with demo/", () => {
    expect(resolve("/shared/abc123/")?.entry).toMatchObject({ password: "PW_SHARED" });
    expect(resolve("/demo/")?.scope).not.toBe(resolve("/shared/abc123/")?.scope);
  });
});

describe("resolve", () => {
  it("denies anything not listed", () => {
    expect(r("/secret.pdf")).toBeNull();
    expect(r("/demoX/index.html")).toBeNull();
    expect(r("/")).toBeNull();
  });

  it("refuses path traversal", () => {
    expect(r("/demo/../q3-deck.pdf")).toBeNull();
    expect(r("/demo/%2e%2e/q3-deck.pdf")).toBeNull();
  });

  it("matches exact keys", () => {
    expect(r("/q3-deck.pdf")).toMatchObject({ key: "q3-deck.pdf", scope: "k:q3-deck.pdf" });
  });

  it("covers subresources under a prefix", () => {
    expect(r("/demo/app.js")).toMatchObject({ key: "demo/app.js", scope: "k:demo/" });
  });

  it("serves the index for a directory, with or without a trailing slash", () => {
    expect(r("/demo/")).toMatchObject({ key: "demo/index.html" });
    expect(r("/demo")).toMatchObject({ key: "demo/index.html" });
  });

  it("lets the longest prefix win", () => {
    expect(r("/demo/private/notes.html")).toMatchObject({ scope: "k:demo/private/" });
  });

  it("scopes a cookie per entry unless a group says otherwise", () => {
    // Different scopes → the demo password cannot open the Q3 deck.
    expect(r("/demo/index.html")!.scope).not.toBe(r("/q3-deck.pdf")!.scope);
    // Same group → one unlock covers both, deliberately.
    expect(r("/wedding/menus/a.html")!.scope).toBe(r("/wedding/seating.pdf")!.scope);
    expect(r("/wedding/seating.pdf")!.scope).toBe("g:wedding");
  });

  it("marks public entries public", () => {
    expect(r("/og-image.png")!.entry).toEqual({ public: true });
  });
});
