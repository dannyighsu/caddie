import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLauncher } from "./launcher.js";
import type { AgentRuntime, AgentRuntimeOutput } from "../runtime/types.js";
import * as fs from "fs/promises";
import { resolveCapabilities } from "../capability/mcp-resolver.js";
import { filterCapabilitiesByPolicy } from "../policy/permissions.js";

vi.mock("fs/promises");
vi.mock("../capability/mcp-resolver.js", () => ({
  resolveCapabilities: vi.fn().mockResolvedValue({
    servers: {},
    flags: [],
    warnings: [],
  }),
}));
vi.mock("../policy/permissions.js", () => ({
  loadPermissions: vi.fn().mockResolvedValue({ household: {}, guest: {} }),
  isAllowed: vi.fn().mockReturnValue(true),
  filterCapabilitiesByPolicy: vi.fn((names: string[]) => ({
    kept: names,
    dropped: [],
  })),
  BASE_TOOLS_KEY: "base-tools",
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

const ID = {
  trustTier: "household" as const,
  senderIdentity: "test",
  originChannel: "test",
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
    mockFs.readdir.mockResolvedValue([] as any); // no config/household by default
  });

  it("launches an agent and returns success result", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    const result = await launcher.launch({
      agentId: "test-agent",
      identity: ID,
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
      identity: ID,
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
      identity: ID,
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
      identity: ID,
      prompt: "Do the task",
    });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.prompt).toContain("---");
    expect(call.prompt).toContain("Do the task");
  });

  it("orders the prompt static-first: persona, then run context (identity), then time, then user message", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      identity: { trustTier: "household", senderIdentity: "Danny (owner)", originChannel: "portal" },
      prompt: "PROMPT_MARKER",
      context: { currentTime: "2025-01-01 10:00" },
    });

    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    const iPersona = prompt.indexOf("You are"); // static persona (mock)
    const iIdentity = prompt.indexOf("Origin channel: portal");
    const iTime = prompt.indexOf("[Current time: 2025-01-01 10:00]");
    const iUser = prompt.indexOf("PROMPT_MARKER");

    // Static persona first, then run-context identity, then volatile time, then the message.
    expect(iPersona).toBeGreaterThanOrEqual(0);
    expect(iIdentity).toBeGreaterThan(iPersona);
    expect(prompt).toContain("Sender: Danny (owner)");
    expect(prompt).toContain("Trust tier: household");
    expect(iTime).toBeGreaterThan(iIdentity);
    expect(iUser).toBeGreaterThan(iTime);
  });

  it("skips persona prefix on session resume", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      agentId: "test-agent",
      identity: ID,
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
      identity: ID,
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
      identity: ID,
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

    await launcher.launch({ agentId: "test-agent", identity: ID, prompt: "test" });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.maxTurns).toBe(150);
  });

  it("passes the identity's trust tier (guest) to the capability filter", async () => {
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

    await launcher.launch({
      agentId: "test-agent",
      identity: { trustTier: "guest", senderIdentity: "g", originChannel: "g" },
      prompt: "go",
    });

    expect(filterCapabilitiesByPolicy).toHaveBeenCalledWith(
      ["calendar", "web-search"],
      expect.anything(),
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
      identity: { trustTier: "household", senderIdentity: "h", originChannel: "h" },
      prompt: "go",
    });

    expect(filterCapabilitiesByPolicy).toHaveBeenCalledWith(
      ["calendar"],
      expect.anything(),
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

    vi.mocked(filterCapabilitiesByPolicy).mockReturnValueOnce({
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
      identity: { trustTier: "guest", senderIdentity: "g", originChannel: "g" },
      prompt: "go",
    });

    expect(resolveCapabilities).toHaveBeenCalledWith(["web-search"], "/caps");
  });

  it("injects the job's state file when a stateKey is provided", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (p.endsWith("persona.md")) return "persona";
      if (p.endsWith("state/golf-tee-times.md")) {
        return "## Directives\n- Only check Saturday. (expires: 2099-01-01)\n\n## State\npaused_until: none";
      }
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentsDir: "/agents", capabilitiesDir: "/caps" });

    await launcher.launch({
      agentId: "test-agent",
      identity: ID,
      prompt: "PROMPT_MARKER",
      stateKey: "golf-tee-times",
    });

    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("Job state (state/golf-tee-times.md):");
    expect(prompt).toContain("Only check Saturday. (expires: 2099-01-01)");
    // State is run context, so it lands before the user message.
    expect(prompt.indexOf("Job state")).toBeLessThan(prompt.indexOf("PROMPT_MARKER"));
  });

  it("does not inject anything when the job has no state file yet", async () => {
    // Default mock throws for state/*.md (unmocked) — the read is swallowed.
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentsDir: "/agents", capabilitiesDir: "/caps" });

    await launcher.launch({
      agentId: "test-agent",
      identity: ID,
      prompt: "hello",
      stateKey: "golf-tee-times",
    });

    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(prompt).not.toContain("Job state");
  });

  it("sanitizes the stateKey so the read cannot escape the state/ directory", async () => {
    const seen: string[] = [];
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (p.endsWith("persona.md")) return "persona";
      if (p.includes("/state/")) { seen.push(p); throw new Error("ENOENT"); }
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentsDir: "/agents", capabilitiesDir: "/caps" });

    await launcher.launch({
      agentId: "test-agent",
      identity: ID,
      prompt: "go",
      stateKey: "../../config/preferences",
    });

    // Slashes are stripped, so the resolved path stays a direct child of state/.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/state/");
    expect(seen[0]).not.toContain("config/preferences");
    expect(seen[0].endsWith("/state/....configpreferences.md")).toBe(true);
  });

  it("injects household member files on a household turn, but not on a guest turn", async () => {
    mockFs.readdir.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config/household")) return ["betty.md", "danny.md"] as any;
      return [] as any;
    });
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (p.endsWith("persona.md")) return "persona";
      if (p.endsWith("household/danny.md")) return "# Danny\n- Founder of Deep Agents";
      if (p.endsWith("household/betty.md")) return "# Betty\n- PM at Peregrine";
      throw new Error(`Unmocked: ${path}`);
    });

    // Household turn: both member files injected.
    const runtime = mockRuntime();
    const hh = createLauncher(runtime, { agentsDir: "/agents", capabilitiesDir: "/caps" });
    await hh.launch({
      agentId: "test-agent",
      identity: { trustTier: "household", senderIdentity: "Danny", originChannel: "email" },
      prompt: "go",
    });
    const hhPrompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(hhPrompt).toContain("Household member — danny:");
    expect(hhPrompt).toContain("Founder of Deep Agents");
    expect(hhPrompt).toContain("Household member — betty:");

    // Guest turn: member files must NOT be injected.
    const guestRt = mockRuntime();
    const guest = createLauncher(guestRt, { agentsDir: "/agents", capabilitiesDir: "/caps" });
    await guest.launch({
      agentId: "test-agent",
      identity: { trustTier: "guest", senderIdentity: "stranger", originChannel: "email" },
      prompt: "go",
    });
    const guestPrompt: string = (guestRt.execute as any).mock.calls[0][0].prompt;
    expect(guestPrompt).not.toContain("Household member");
    expect(guestPrompt).not.toContain("Founder of Deep Agents");
  });

  it("passes harnessRoot to runtime", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentsDir: "/agents",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({ agentId: "test-agent", identity: ID, prompt: "test" });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.harnessRoot).toBe("/");
  });
});
