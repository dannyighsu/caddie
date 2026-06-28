import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLauncher } from "./launcher.js";
import type { AgentRuntime, AgentRuntimeOutput } from "../runtime/types.js";
import * as fs from "fs/promises";
import {
  filterCapabilitiesByTrust,
  resolveCapabilities,
} from "../capability/mcp-resolver.js";

vi.mock("fs/promises");
vi.mock("../capability/mcp-resolver.js", () => ({
  resolveCapabilities: vi.fn().mockResolvedValue({
    servers: {},
    flags: [],
    warnings: [],
  }),
  filterCapabilitiesByTrust: vi.fn(async (names: string[]) => ({
    kept: names,
    dropped: [],
  })),
}));
vi.mock("../resolver/runner.js", () => ({
  runResolvers: vi.fn().mockResolvedValue({}),
}));

const mockFs = vi.mocked(fs);

function mockRuntime(output?: Partial<AgentRuntimeOutput>): AgentRuntime {
  return {
    name: "mock",
    execute: vi.fn().mockResolvedValue({
      output: null,
      sessionId: "sess-1",
      rawText: "done",
      ...output,
    }),
  };
}

const baseAgentConfig = {
  id: "test-agent",
  name: "Test Agent",
  persona: "./persona.md",
  capabilities: [],
};

describe("createLauncher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    // Default mocks: agent.json and persona.md
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify(baseAgentConfig);
      }
      if (String(path).endsWith("persona.md")) {
        return "You are {{role}}. Today is {{date}}.";
      }
      throw new Error(`Unmocked readFile: ${path}`);
    });

    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.lstat.mockRejectedValue(new Error("ENOENT")); // no existing symlinks
    mockFs.symlink.mockResolvedValue(undefined);
  });

  it("launches an agent and returns success result", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    const result = await launcher.launch({
      agentId: "test-agent",
      prompt: "Do something",
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sess-1");
    expect(result.rawText).toBe("done");
  });

  it("interpolates persona template variables from context", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      prompt: "hello",
      context: { role: "assistant", date: "2025-01-01" },
    });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.prompt).toContain("You are assistant. Today is 2025-01-01.");
  });

  it("preserves unresolved template vars", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      prompt: "hello",
      context: { role: "bot" }, // date is not provided
    });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.prompt).toContain("You are bot.");
    expect(call.prompt).toContain("Today is {{date}}.");
  });

  it("combines persona and prompt with separator", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      prompt: "Do the task",
    });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.prompt).toContain("---");
    expect(call.prompt).toContain("Do the task");
  });

  it("skips persona prefix on session resume", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      prompt: "continue working",
      sessionId: "sess-existing",
    });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.prompt).toBe("continue working");
    expect(call.sessionId).toBe("sess-existing");
  });

  it("returns error result when runtime fails", async () => {
    const runtime = mockRuntime({ error: "timeout" });
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    const result = await launcher.launch({
      agentId: "test-agent",
      prompt: "test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("timeout");
  });

  it("applies profile overrides", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({
          ...baseAgentConfig,
          capabilities: ["base-cap"],
          maxTurns: 10,
          profiles: {
            heavy: {
              capabilities: ["heavy-cap"],
              maxTurns: 50,
            },
          },
        });
      }
      if (String(path).endsWith("persona.md")) {
        return "persona";
      }
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      prompt: "go",
      profile: "heavy",
    });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.maxTurns).toBe(50);
  });

  it("uses default maxTurns when not specified", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({ agentId: "test-agent", prompt: "test" });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.maxTurns).toBe(150);
  });

  it("defaults to guest trust tier when none is provided", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({ ...baseAgentConfig, capabilities: ["calendar", "web-search"] });
      }
      if (String(path).endsWith("persona.md")) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({ agentId: "test-agent", prompt: "go" });

    expect(filterCapabilitiesByTrust).toHaveBeenCalledWith(
      ["calendar", "web-search"],
      "/caps",
      "guest",
    );
  });

  it("passes trustTier through to the capability filter", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({ ...baseAgentConfig, capabilities: ["calendar"] });
      }
      if (String(path).endsWith("persona.md")) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      prompt: "go",
      trustTier: "household",
    });

    expect(filterCapabilitiesByTrust).toHaveBeenCalledWith(
      ["calendar"],
      "/caps",
      "household",
    );
  });

  it("only resolves capabilities that survived the trust filter", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({ ...baseAgentConfig, capabilities: ["calendar", "web-search"] });
      }
      if (String(path).endsWith("persona.md")) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });

    vi.mocked(filterCapabilitiesByTrust).mockResolvedValueOnce({
      kept: ["web-search"],
      dropped: ["calendar"],
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      prompt: "go",
      trustTier: "guest",
    });

    expect(resolveCapabilities).toHaveBeenCalledWith(["web-search"], "/caps");
  });

  it("passes harnessRoot to runtime", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({ agentId: "test-agent", prompt: "test" });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.harnessRoot).toBe("/");
  });
});
