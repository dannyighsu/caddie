import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveCapabilities } from "./mcp-resolver.js";
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
    expect(result.skipped).toEqual([]);
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
    expect(result.skipped).toEqual([]);
  });

  it("skips a capability with unset env vars instead of mounting it blank", async () => {
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

    // Not mounted — a blank credential would give the agent tools that fail at
    // first use, mid-run, rather than simply being absent.
    expect(result.servers).not.toHaveProperty("needs-env");
    expect(result.skipped).toEqual([
      { name: "needs-env", missingVars: ["MISSING_VAR"] },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("MISSING_VAR");
    expect(result.warnings[0]).toContain("NOT mounted");
    warn.mockRestore();
  });

  it("skipping one capability does not disturb the others", async () => {
    mockReadFile
      .mockResolvedValueOnce(
        JSON.stringify({ name: "ok", server: { command: "run", args: ["--fine"] } })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ name: "broken", server: { command: "run", args: ["${NOPE}"] } })
      );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await resolveCapabilities(["ok", "broken"], "/caps");

    // The run proceeds with what IS configured — nothing throws.
    expect(Object.keys(result.servers)).toEqual(["ok"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["broken"]);
    warn.mockRestore();
  });

  it("reports every unset var for a capability, not just the first", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "multi",
        server: {
          command: "${CMD_VAR}",
          args: ["${ARG_VAR}"],
          env: { TOKEN: "${ENV_VAR}" },
        },
      })
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await resolveCapabilities(["multi"], "/caps");
    expect(result.skipped[0].missingVars.sort()).toEqual(["ARG_VAR", "CMD_VAR", "ENV_VAR"]);
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

  it("qualifies a mounted capability's disallowed tools with its server name", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "local-rag",
        disallowedTools: ["ingest_file", "delete_file"],
        server: { command: "node", args: ["rag.js"] },
      })
    );

    const result = await resolveCapabilities(["local-rag"], "/caps");
    expect(result.disallowedTools).toEqual([
      "mcp__local-rag__ingest_file",
      "mcp__local-rag__delete_file",
    ]);
  });

  it("drops the disallowed tools of a capability that wasn't mounted", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "local-rag",
        disallowedTools: ["ingest_file"],
        server: { command: "node", args: ["${UNSET_RAG_ENTRY}"] },
      })
    );

    const result = await resolveCapabilities(["local-rag"], "/caps");
    expect(result.servers).toEqual({});
    expect(result.disallowedTools).toEqual([]);
  });

  it("resolves caller-provided substitutions before process.env", async () => {
    process.env.TEST_HOST = "from-env";
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        name: "per-agent",
        server: {
          command: "node",
          args: ["srv.js"],
          env: { DB_PATH: "${IGNIS_WORKSPACE}/.rag/db", HOST: "${TEST_HOST}" },
        },
      })
    );

    const result = await resolveCapabilities(["per-agent"], "/caps", {
      IGNIS_WORKSPACE: "/ws/buri",
    });
    expect(result.servers["per-agent"].env).toEqual({ DB_PATH: "/ws/buri/.rag/db", HOST: "from-env" });
    expect(result.skipped).toEqual([]);
  });

  it("returns empty result for empty input", async () => {
    const result = await resolveCapabilities([], "/caps");
    expect(result.servers).toEqual({});
    expect(result.flags).toEqual([]);
    expect(result.disallowedTools).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
