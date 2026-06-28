import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveCapabilities, filterCapabilitiesByTrust } from "./mcp-resolver.js";
import * as fs from "fs/promises";

vi.mock("fs/promises");

const mockReadFile = vi.mocked(fs.readFile);

describe("resolveCapabilities", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
    delete process.env.TEST_HOST;
  });

  it("resolves a capability with server config", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "my-mcp",
        server: {
          command: "npx",
          args: ["-y", "mcp-server"],
          env: { API_KEY: "static-key" },
        },
      })
    );

    const result = await resolveCapabilities(["my-mcp"], "/caps");
    expect(result.servers["my-mcp"]).toEqual({
      command: "npx",
      args: ["-y", "mcp-server"],
      env: { API_KEY: "static-key" },
    });
    expect(result.flags).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("resolves env vars in server config", async () => {
    process.env.TEST_API_KEY = "secret123";
    process.env.TEST_HOST = "example.com";

    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "api-server",
        server: {
          command: "node",
          args: ["--host", "${TEST_HOST}"],
          env: { KEY: "${TEST_API_KEY}" },
        },
      })
    );

    const result = await resolveCapabilities(["api-server"], "/caps");
    expect(result.servers["api-server"].args).toEqual(["--host", "example.com"]);
    expect(result.servers["api-server"].env).toEqual({ KEY: "secret123" });
    expect(result.warnings).toEqual([]);
  });

  it("warns on missing env vars", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "needs-env",
        server: {
          command: "run",
          args: ["${MISSING_VAR}"],
        },
      })
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await resolveCapabilities(["needs-env"], "/caps");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("MISSING_VAR");
    expect(result.servers["needs-env"].args).toEqual([""]);
    warn.mockRestore();
  });

  it("handles flag-only capabilities (no server)", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "chrome",
        description: "Browser automation",
      })
    );

    const result = await resolveCapabilities(["chrome"], "/caps");
    expect(result.flags).toEqual(["chrome"]);
    expect(Object.keys(result.servers)).toHaveLength(0);
  });

  it("handles failed capability load gracefully", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await resolveCapabilities(["missing"], "/caps");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Failed to load capability "missing"');
    expect(Object.keys(result.servers)).toHaveLength(0);
    err.mockRestore();
  });

  it("processes multiple capabilities", async () => {
    mockReadFile
      .mockResolvedValueOnce(
        JSON.stringify({ name: "chrome" }) // flag-only
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          name: "github",
          server: { command: "gh-mcp", args: [] },
        })
      );

    const result = await resolveCapabilities(["chrome", "github"], "/caps");
    expect(result.flags).toEqual(["chrome"]);
    expect(result.servers["github"]).toBeDefined();
  });

  it("returns empty result for empty input", async () => {
    const result = await resolveCapabilities([], "/caps");
    expect(result.servers).toEqual({});
    expect(result.flags).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("filterCapabilitiesByTrust", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("drops household-trust capabilities when tier is guest", async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ name: "calendar", trust: "household", server: { command: "x", args: [] } }))
      .mockResolvedValueOnce(JSON.stringify({ name: "web-search", server: { command: "y", args: [] } }));

    const result = await filterCapabilitiesByTrust(["calendar", "web-search"], "/caps", "guest");
    expect(result.kept).toEqual(["web-search"]);
    expect(result.dropped).toEqual(["calendar"]);
  });

  it("preserves all capabilities when tier is household", async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ name: "calendar", trust: "household" }))
      .mockResolvedValueOnce(JSON.stringify({ name: "web-search" }));

    const result = await filterCapabilitiesByTrust(["calendar", "web-search"], "/caps", "household");
    expect(result.kept).toEqual(["calendar", "web-search"]);
    expect(result.dropped).toEqual([]);
  });

  it("treats missing trust field as public (allowed at any tier)", async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ name: "egress" }));

    const result = await filterCapabilitiesByTrust(["egress"], "/caps", "guest");
    expect(result.kept).toEqual(["egress"]);
  });

  it("silently drops capabilities that fail to load (resolveCapabilities surfaces the warning)", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await filterCapabilitiesByTrust(["missing"], "/caps", "household");
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});
