import { describe, it, expect, vi } from "vitest";
import * as fs from "fs/promises";
import {
  isAllowed,
  filterCapabilitiesByPolicy,
  loadPermissions,
  BASE_TOOLS_KEY,
  type PermissionPolicy,
} from "./permissions.js";

vi.mock("fs/promises");

const policy: PermissionPolicy = {
  team: { notion: true, egress: true, "base-tools": true },
  guest: {},
};

describe("isAllowed (default-deny)", () => {
  it("grants explicitly-true keys", () => {
    expect(isAllowed(policy, "team", "notion")).toBe(true);
    expect(isAllowed(policy, "team", BASE_TOOLS_KEY)).toBe(true);
  });

  it("denies keys not present for the tier", () => {
    expect(isAllowed(policy, "team", "browser")).toBe(false);
  });

  it("denies everything for a tier with no grants (guest = default-deny)", () => {
    expect(isAllowed(policy, "guest", "notion")).toBe(false);
    expect(isAllowed(policy, "guest", BASE_TOOLS_KEY)).toBe(false);
  });

  it("denies unknown tiers", () => {
    expect(isAllowed(policy, "admin" as never, "notion")).toBe(false);
  });
});

describe("filterCapabilitiesByPolicy", () => {
  it("keeps granted capabilities and drops denied ones", () => {
    const r = filterCapabilitiesByPolicy(["notion", "browser", "egress"], policy, "team");
    expect(r.kept).toEqual(["notion", "egress"]);
    expect(r.dropped).toEqual(["browser"]);
  });

  it("drops everything for guest", () => {
    const r = filterCapabilitiesByPolicy(["notion", "egress"], policy, "guest");
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(["notion", "egress"]);
  });
});

describe("loadPermissions", () => {
  it("reads and parses permissions.json from harnessRoot", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(policy) as never);
    const loaded = await loadPermissions("/harness");
    expect(loaded).toEqual(policy);
    expect(fs.readFile).toHaveBeenCalledWith(
      expect.stringContaining("permissions.json"),
      "utf-8",
    );
  });
});
