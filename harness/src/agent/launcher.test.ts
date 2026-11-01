import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLauncher, resolveProfileCapabilities } from "./launcher.js";
import type { AgentRuntime, AgentRuntimeOutput } from "../runtime/types.js";
import * as fs from "fs/promises";
import { resolveCapabilities } from "../capability/mcp-resolver.js";
import { filterCapabilitiesByPolicy } from "../policy/permissions.js";
import { journalConfig, detectConfigDrift, describeConfigDrift } from "./config-journal.js";

vi.mock("fs/promises");
vi.mock("../capability/mcp-resolver.js", () => ({
  resolveCapabilities: vi.fn().mockResolvedValue({
    servers: {},
    flags: [],
    disallowedTools: [],
    warnings: [],
    skipped: [],
  }),
}));
vi.mock("../policy/permissions.js", () => ({
  loadPermissions: vi.fn().mockResolvedValue({ team: {}, guest: {} }),
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
// The journal does real filesystem work; fs is mocked here, so stub it out and
// drive it per test. The launcher tolerates undefined returns from these (a
// backup must never take down a run), which is what a restored mock gives back.
vi.mock("./config-journal.js", () => ({
  journalConfig: vi.fn().mockResolvedValue([]),
  watchJournal: vi.fn().mockResolvedValue(async () => {}),
  detectConfigDrift: vi.fn().mockResolvedValue([]),
  describeConfigDrift: vi.fn().mockReturnValue(""),
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
  capabilities: [],
};

const ID = {
  trustTier: "team" as const,
  senderIdentity: "test",
  originChannel: "test",
};

describe("createLauncher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    // Default mocks: agent.json, PERSONA.md and SYSTEM.md
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify(baseAgentConfig);
      }
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) {
        return "You are {{role}}. Today is {{date}}.";
      }
      throw new Error(`Unmocked readFile: ${path}`);
    });

    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.lstat.mockRejectedValue(new Error("ENOENT")); // no existing symlinks
    mockFs.symlink.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([] as any); // no config/team by default
  });

  it("launches an agent and returns success result", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    const result = await launcher.launch({
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
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
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
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
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
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      identity: ID,
      prompt: "Do the task",
    });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.prompt).toContain("---");
    expect(call.prompt).toContain("Do the task");
  });

  it("puts the install's persona before the shared system prompt", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (p.endsWith("PERSONA.md")) return "You are {{role}}.";
      if (p.endsWith("SYSTEM.md")) return "How you work.";
      throw new Error(`Unmocked readFile: ${path}`);
    });
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await launcher.launch({ identity: ID, prompt: "go", context: { role: "Ada" } });

    const { prompt } = (runtime.execute as any).mock.calls[0][0];
    expect(prompt.startsWith("You are Ada.\n\nHow you work.")).toBe(true);
  });

  it("refuses to run without a PERSONA.md", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (p.endsWith("SYSTEM.md")) return "How you work.";
      throw new Error("ENOENT");
    });
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await expect(launcher.launch({ identity: ID, prompt: "go" })).rejects.toThrow(
      /Copy PERSONA\.example\.md/
    );
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("orders the prompt static-first: persona, then run context (identity), then time, then user message", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      identity: { trustTier: "team", senderIdentity: "Danny (owner)", originChannel: "portal" },
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
    expect(prompt).toContain("Trust tier: team");
    expect(iTime).toBeGreaterThan(iIdentity);
    expect(iUser).toBeGreaterThan(iTime);
  });

  it("derives the run-record path from an injected clock", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      identity: ID,
      prompt: "go",
      now: new Date("2026-09-22T19:03:00Z"),
    });

    // A replayed run must not show the real date anywhere in its context.
    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("Run record path: runs/2026-09/22_tuesday/run-record-2026-09-22T19-03-00.jsonl");
  });

  it("skips persona prefix on session resume", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
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
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    const result = await launcher.launch({
      identity: ID,
      prompt: "test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("timeout");
  });

  it("applies profile overrides, adjusting capabilities rather than replacing them", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({
          ...baseAgentConfig,
          capabilities: ["reply", "browser", "notion"],
          maxTurns: 10,
          profiles: {
            heavy: {
              addCapabilities: ["web-search"],
              removeCapabilities: ["notion"],
              maxTurns: 50,
            },
          },
        });
      }
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) {
        return "persona";
      }
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      identity: ID,
      prompt: "go",
      profile: "heavy",
    });

    expect((runtime.execute as any).mock.calls[0][0].maxTurns).toBe(50);

    const [names] = vi.mocked(filterCapabilitiesByPolicy).mock.calls[0];
    expect(names).toContain("web-search");
    expect(names).not.toContain("notion");
    // The load-bearing assertion: a profile can't drop what it never mentioned.
    expect(names).toContain("reply");
    expect(names).toContain("browser");
  });

  it("gives capability servers the agent's workspace, trust tier and disallowed tools", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({ ...baseAgentConfig, capabilities: ["local-rag"] });
      }
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });
    vi.mocked(resolveCapabilities).mockResolvedValueOnce({
      servers: { "local-rag": { command: "node", args: ["rag.js"], env: { DB_PATH: "/x" } } },
      flags: [],
      disallowedTools: ["mcp__local-rag__delete_file"],
      warnings: [],
      skipped: [],
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
      workspace: "/ws",
    });

    await launcher.launch({
      identity: { ...ID, trustTier: "guest" },
      prompt: "go",
    });

    // Capability JSON can reference the workspace (a per-agent DB path).
    const provided = vi.mocked(resolveCapabilities).mock.calls.at(-1)![2];
    expect(provided).toMatchObject({ CADDIE_WORKSPACE: "/ws" });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.mcpServers["local-rag"].env).toMatchObject({
      DB_PATH: "/x",
      CADDIE_WORKSPACE: "/ws",
      CADDIE_TRUST_TIER: "guest",
    });
    expect(call.disallowedTools).toEqual(["mcp__local-rag__delete_file"]);
  });

  it("warns and falls back to base config when the profile name is unknown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({
          ...baseAgentConfig,
          capabilities: ["reply"],
          maxTurns: 10,
          profiles: { extended: { maxTurns: 300 } },
        });
      }
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    // "feed-scan" is a skill, not a profile — the mistake the scheduling tool
    // used to invite. It must not pass silently.
    await launcher.launch({
      identity: ID,
      prompt: "go",
      profile: "feed-scan",
    });

    expect((runtime.execute as any).mock.calls[0][0].maxTurns).toBe(10);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown profile "feed-scan"')
    );
  });

  it("uses default maxTurns when not specified", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({ identity: ID, prompt: "test" });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.maxTurns).toBe(150);
  });

  it("passes the identity's trust tier (guest) to the capability filter", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({ ...baseAgentConfig, capabilities: ["calendar", "web-search"] });
      }
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
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
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      identity: { trustTier: "team", senderIdentity: "h", originChannel: "h" },
      prompt: "go",
    });

    expect(filterCapabilitiesByPolicy).toHaveBeenCalledWith(
      ["calendar"],
      expect.anything(),
      "team",
    );
  });

  it("only resolves capabilities that survived the trust filter", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({ ...baseAgentConfig, capabilities: ["calendar", "web-search"] });
      }
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });

    vi.mocked(filterCapabilitiesByPolicy).mockReturnValueOnce({
      kept: ["web-search"],
      dropped: ["calendar"],
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({
      identity: { trustTier: "guest", senderIdentity: "g", originChannel: "g" },
      prompt: "go",
    });

    // ...LastCalledWith, not ...CalledWith: this module mock accumulates calls
    // across tests, so a plain "was called with" can match an earlier test's.
    // The third argument holds paths the launcher computes rather than reads
    // from the environment.
    expect(resolveCapabilities).toHaveBeenLastCalledWith(
      ["web-search"],
      "/caps",
      expect.objectContaining({ HARNESS_ROOT: "/" })
    );
  });

  it("injects the job's state file when a stateKey is provided", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (/(PERSONA|SYSTEM)\.md$/.test(p)) return "persona";
      if (p.endsWith("state/golf-tee-times.md")) {
        return "## Directives\n- Only check Saturday. (expires: 2099-01-01)\n\n## State\npaused_until: none";
      }
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await launcher.launch({
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

  it("injects the job's instructions file, before the state, when a stateKey is provided", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (/(PERSONA|SYSTEM)\.md$/.test(p)) return "persona";
      if (p.endsWith("jobs/golf-tee-times.md")) return "PROCEDURE: check GolfNow";
      if (p.endsWith("state/golf-tee-times.md")) return "## State\npaused_until: none";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await launcher.launch({
      identity: ID,
      prompt: "PROMPT_MARKER",
      stateKey: "golf-tee-times",
    });

    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("Job instructions (jobs/golf-tee-times.md):");
    expect(prompt).toContain("PROCEDURE: check GolfNow");
    // Instructions (the stable procedure) land before the current state,
    // and both land in run context before the user message.
    expect(prompt.indexOf("Job instructions")).toBeLessThan(prompt.indexOf("Job state"));
    expect(prompt.indexOf("Job state")).toBeLessThan(prompt.indexOf("PROMPT_MARKER"));
  });

  it("still injects state when the job has instructions but no state file, and vice versa", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (/(PERSONA|SYSTEM)\.md$/.test(p)) return "persona";
      if (p.endsWith("jobs/golf-tee-times.md")) return "PROCEDURE";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await launcher.launch({
      identity: ID,
      prompt: "go",
      stateKey: "golf-tee-times",
    });

    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("Job instructions (jobs/golf-tee-times.md):");
    expect(prompt).not.toContain("Job state");
  });

  it("does not inject anything when the job has no state file yet", async () => {
    // Default mock throws for state/*.md (unmocked) — the read is swallowed.
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await launcher.launch({
      identity: ID,
      prompt: "hello",
      stateKey: "golf-tee-times",
    });

    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(prompt).not.toContain("Job state");
    expect(prompt).not.toContain("Job instructions");
  });

  it("sanitizes the stateKey so the read cannot escape the state/ directory", async () => {
    const seen: string[] = [];
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (/(PERSONA|SYSTEM)\.md$/.test(p)) return "persona";
      if (p.includes("/state/")) { seen.push(p); throw new Error("ENOENT"); }
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await launcher.launch({
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

  it("injects team member files on a team turn, but not on a guest turn", async () => {
    mockFs.readdir.mockImplementation(async (path: any) => {
      if (String(path).endsWith("config/team")) return ["betty.md", "danny.md"] as any;
      return [] as any;
    });
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (/(PERSONA|SYSTEM)\.md$/.test(p)) return "persona";
      if (p.endsWith("team/danny.md")) return "# Danny\n- Founder of Deep Agents";
      if (p.endsWith("team/betty.md")) return "# Betty\n- PM at Peregrine";
      throw new Error(`Unmocked: ${path}`);
    });

    // Team turn: both member files injected.
    const runtime = mockRuntime();
    const hh = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });
    await hh.launch({
      identity: { trustTier: "team", senderIdentity: "Danny", originChannel: "email" },
      prompt: "go",
    });
    const hhPrompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(hhPrompt).toContain("Team member — danny:");
    expect(hhPrompt).toContain("Founder of Deep Agents");
    expect(hhPrompt).toContain("Team member — betty:");

    // Guest turn: member files must NOT be injected.
    const guestRt = mockRuntime();
    const guest = createLauncher(guestRt, { agentDir: "/agent", capabilitiesDir: "/caps" });
    await guest.launch({
      identity: { trustTier: "guest", senderIdentity: "stranger", originChannel: "email" },
      prompt: "go",
    });
    const guestPrompt: string = (guestRt.execute as any).mock.calls[0][0].prompt;
    expect(guestPrompt).not.toContain("Team member —");
    expect(guestPrompt).not.toContain("Founder of Deep Agents");
  });

  it("injects the team directory from the roster on a team turn only", async () => {
    const team = () => [
      {
        id: "danny",
        name: "Danny",
        emails: ["danny@example.com", "danny@alt.example.com"],
        isOwner: true,
      },
      { id: "veronica", name: "Veronica", emails: ["veronica@example.com"], isOwner: false },
    ];

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps", team });
    await launcher.launch({ identity: ID, prompt: "go" });
    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;

    expect(prompt).toContain("Team directory");
    expect(prompt).toContain("- Danny: danny@example.com (also: danny@alt.example.com)");
    // The roster is the only source of names — no hardcoded pair survives.
    expect(prompt).toContain("- Veronica: veronica@example.com");

    // A guest run must never see private addresses.
    const guestRt = mockRuntime();
    const guest = createLauncher(guestRt, { agentDir: "/agent", capabilitiesDir: "/caps", team });
    await guest.launch({
      identity: { trustTier: "guest", senderIdentity: "stranger", originChannel: "email" },
      prompt: "go",
    });
    const guestPrompt: string = (guestRt.execute as any).mock.calls[0][0].prompt;
    expect(guestPrompt).not.toContain("Team directory");
    expect(guestPrompt).not.toContain("veronica@example.com");
  });

  it("puts the agent's secrets in a team run's env, by name only in the prompt, and never in a guest run", async () => {
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (/(PERSONA|SYSTEM)\.md$/.test(p)) return "persona";
      if (p === "/agent/.env") return "# comment\nWEATHER_API_TOKEN=tok-123\nOTHER=\"quoted\"\n";
      throw new Error(`Unmocked: ${path}`);
    });

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });
    await launcher.launch({ identity: ID, prompt: "go", additionalEnv: { OTHER: "caller" } });
    const call = (runtime.execute as any).mock.calls[0][0];
    // The caller's env wins over the file.
    expect(call.additionalEnv).toEqual({ WEATHER_API_TOKEN: "tok-123", OTHER: "caller" });
    expect(call.prompt).toContain("Secrets in your environment");
    expect(call.prompt).toContain("OTHER, WEATHER_API_TOKEN");
    expect(call.prompt).not.toContain("tok-123");

    const guestRt = mockRuntime();
    const guest = createLauncher(guestRt, { agentDir: "/agent", capabilitiesDir: "/caps" });
    await guest.launch({
      identity: { trustTier: "guest", senderIdentity: "stranger", originChannel: "email" },
      prompt: "go",
    });
    const guestCall = (guestRt.execute as any).mock.calls[0][0];
    expect(guestCall.additionalEnv).toEqual({});
    expect(guestCall.prompt).not.toContain("WEATHER_API_TOKEN");
  });

  it("omits the team directory when the roster is empty", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });
    await launcher.launch({ identity: ID, prompt: "go" });
    const prompt: string = (runtime.execute as any).mock.calls[0][0].prompt;
    expect(prompt).not.toContain("Team directory");
  });

  it("passes harnessRoot to runtime", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
    });

    await launcher.launch({ identity: ID, prompt: "test" });

    const call = (runtime.execute as any).mock.calls[0][0];
    expect(call.harnessRoot).toBe("/");
  });
});

describe("resolveProfileCapabilities", () => {
  const base = ["reply", "browser", "notion"];

  it("returns the base set unchanged with no profile", () => {
    expect(resolveProfileCapabilities(base)).toEqual(base);
  });

  it("returns the base set unchanged for a profile that adjusts nothing", () => {
    expect(resolveProfileCapabilities(base, { maxTurns: 300 })).toEqual(base);
  });

  it("adds and removes relative to the base set", () => {
    const result = resolveProfileCapabilities(base, {
      addCapabilities: ["web-search"],
      removeCapabilities: ["browser"],
    });
    expect(result).toEqual(["reply", "notion", "web-search"]);
  });

  it("applies removals before adds, so a name in both survives", () => {
    const result = resolveProfileCapabilities(base, {
      addCapabilities: ["notion"],
      removeCapabilities: ["notion"],
    });
    expect(result).toContain("notion");
  });

  it("ignores removals for capabilities the agent doesn't have", () => {
    expect(
      resolveProfileCapabilities(base, { removeCapabilities: ["nonexistent"] })
    ).toEqual(base);
  });

  it("does not duplicate a capability the base set already has", () => {
    const result = resolveProfileCapabilities(base, { addCapabilities: ["reply"] });
    expect(result.filter((c) => c === "reply")).toHaveLength(1);
  });
});

describe("skill mounting", () => {
  const AGENT_SKILLS = "/agent/.claude/skills";
  const CORE_SKILLS = "/skills/core";
  const DEST = "/workspace/.claude/skills";

  /** readdir that returns the given directory names for the given paths. */
  function dirs(byPath: Record<string, string[]>) {
    return async (path: any) => {
      const names = byPath[String(path)] ?? [];
      return names.map((name) => ({
        name,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      })) as any;
    };
  }

  function launcher(runtime: any) {
    return createLauncher(runtime, {
      agentDir: "/agent",
      capabilitiesDir: "/caps",
      workspace: "/workspace",
      coreSkillsDir: CORE_SKILLS,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockFs.readFile.mockImplementation(async (path: any) => {
      if (String(path).endsWith("agent.json")) {
        return JSON.stringify({
          ...baseAgentConfig,
          capabilities: [],
          profiles: { scoped: { skills: ["feed-scan"] } },
        });
      }
      if (/(PERSONA|SYSTEM)\.md$/.test(String(path))) return "persona";
      throw new Error(`Unmocked: ${path}`);
    });
    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.symlink.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.rm.mockResolvedValue(undefined);
    mockFs.lstat.mockRejectedValue(new Error("ENOENT"));
    mockFs.readlink.mockRejectedValue(new Error("ENOENT"));
    mockFs.readdir.mockImplementation(dirs({}));
  });

  it("mounts core skills and the agent's own side by side", async () => {
    mockFs.readdir.mockImplementation(
      dirs({ [CORE_SKILLS]: ["manage-schedules"], [AGENT_SKILLS]: ["feed-scan"] })
    );
    mockFs.lstat.mockImplementation(async (p: any) =>
      String(p) === AGENT_SKILLS ? ({ isSymbolicLink: () => false } as any) : Promise.reject(new Error("ENOENT"))
    );

    const runtime = mockRuntime();
    await launcher(runtime).launch({ identity: ID, prompt: "go" });

    expect(mockFs.symlink).toHaveBeenCalledWith(
      `${CORE_SKILLS}/manage-schedules`, `${DEST}/manage-schedules`
    );
    expect(mockFs.symlink).toHaveBeenCalledWith(
      `${AGENT_SKILLS}/feed-scan`, `${DEST}/feed-scan`
    );
  });

  it("lets an agent skill override a core skill of the same name", async () => {
    mockFs.readdir.mockImplementation(
      dirs({ [CORE_SKILLS]: ["repo-mount"], [AGENT_SKILLS]: ["repo-mount"] })
    );

    const runtime = mockRuntime();
    await launcher(runtime).launch({ identity: ID, prompt: "go" });

    expect(mockFs.symlink).toHaveBeenCalledWith(
      `${AGENT_SKILLS}/repo-mount`, `${DEST}/repo-mount`
    );
    expect(mockFs.symlink).not.toHaveBeenCalledWith(
      `${CORE_SKILLS}/repo-mount`, `${DEST}/repo-mount`
    );
  });

  it("mounts only what a profile grants, across both sources", async () => {
    mockFs.readdir.mockImplementation(
      dirs({ [CORE_SKILLS]: ["manage-schedules"], [AGENT_SKILLS]: ["feed-scan", "checkin"] })
    );

    const runtime = mockRuntime();
    await launcher(runtime).launch({
      identity: ID, prompt: "go", profile: "scoped",
    });

    const linked = mockFs.symlink.mock.calls.map((c: any) => String(c[1]));
    expect(linked).toContain(`${DEST}/feed-scan`);
    expect(linked).not.toContain(`${DEST}/checkin`);
    expect(linked).not.toContain(`${DEST}/manage-schedules`);
  });

  it("unlinks (never recursively removes) a legacy whole-set symlink at the mount point", async () => {
    mockFs.readdir.mockImplementation(dirs({ [AGENT_SKILLS]: ["feed-scan"] }));
    mockFs.lstat.mockImplementation(async (p: any) =>
      String(p) === DEST
        ? ({ isSymbolicLink: () => true } as any)
        : Promise.reject(new Error("ENOENT"))
    );

    const runtime = mockRuntime();
    await launcher(runtime).launch({ identity: ID, prompt: "go" });

    // Recursing through that link would delete the agent's real skills.
    expect(mockFs.unlink).toHaveBeenCalledWith(DEST);
    expect(mockFs.rm).not.toHaveBeenCalledWith(DEST, expect.objectContaining({ recursive: true }));
  });

  it("sweeps a link this run doesn't want", async () => {
    mockFs.readdir.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p === AGENT_SKILLS) return [{ name: "feed-scan", isDirectory: () => true, isSymbolicLink: () => false }] as any;
      if (p === DEST) return [{ name: "metrics-check", isDirectory: () => false, isSymbolicLink: () => true }] as any;
      return [] as any;
    });

    const runtime = mockRuntime();
    await launcher(runtime).launch({ identity: ID, prompt: "go" });
    expect(mockFs.unlink).toHaveBeenCalledWith(`${DEST}/metrics-check`);
  });

  it("links skills-src to the agent's own skills, so authoring persists", async () => {
    mockFs.readdir.mockImplementation(dirs({ [AGENT_SKILLS]: ["feed-scan"] }));
    mockFs.lstat.mockImplementation(async (p: any) =>
      String(p) === AGENT_SKILLS ? ({ isSymbolicLink: () => false } as any) : Promise.reject(new Error("ENOENT"))
    );

    const runtime = mockRuntime();
    await launcher(runtime).launch({ identity: ID, prompt: "go" });

    expect(mockFs.symlink).toHaveBeenCalledWith(
      AGENT_SKILLS, "/workspace/.claude/skills-src"
    );
  });

  it("creates the agent's skills directory on a fresh install, so skills-src has a target", async () => {
    const runtime = mockRuntime();
    await launcher(runtime).launch({ identity: ID, prompt: "go" });

    expect(mockFs.mkdir).toHaveBeenCalledWith(AGENT_SKILLS, { recursive: true });
    expect(mockFs.symlink).toHaveBeenCalledWith(AGENT_SKILLS, "/workspace/.claude/skills-src");
  });

  it("relinks skills-src that still points at the repo's old path", async () => {
    const LINK = "/workspace/.claude/skills-src";
    mockFs.readdir.mockImplementation(dirs({ [AGENT_SKILLS]: ["feed-scan"] }));
    mockFs.lstat.mockImplementation(async (p: any) => {
      const path = String(p);
      if (path === AGENT_SKILLS) return { isSymbolicLink: () => false } as any;
      if (path === LINK) return { isSymbolicLink: () => true } as any;
      throw new Error("ENOENT");
    });
    mockFs.readlink.mockResolvedValue("/old-repo/agent/.claude/skills" as any);

    const runtime = mockRuntime();
    await launcher(runtime).launch({ identity: ID, prompt: "go" });

    // A link that exists but points elsewhere is dangling after a repo move.
    expect(mockFs.unlink).toHaveBeenCalledWith(LINK);
    expect(mockFs.symlink).toHaveBeenCalledWith(AGENT_SKILLS, LINK);
  });
});

describe("config journal", () => {
  const drift = [
    {
      relPath: "config/team/betty.md",
      snapshotPath: "/agent/config-history/team/betty.md.stamp",
      deleted: false,
      removedLines: ["- Sign outside mail as \"Buri H.\" (Betty, 2026-09-19)"],
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFs.readFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("agent.json")) return JSON.stringify(baseAgentConfig);
      if (/(PERSONA|SYSTEM)\.md$/.test(p)) return "persona";
      throw new Error(`Unmocked readFile: ${path}`);
    });
    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.lstat.mockRejectedValue(new Error("ENOENT"));
    mockFs.symlink.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([] as any);

    // Module mocks accumulate calls across tests — clear before counting.
    vi.mocked(journalConfig).mockClear().mockResolvedValue([]);
    vi.mocked(detectConfigDrift).mockClear().mockResolvedValue([]);
    vi.mocked(describeConfigDrift).mockClear().mockReturnValue("");
  });

  it("snapshots config before and after the run", async () => {
    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps", workspace: "/workspace" });

    await launcher.launch({ identity: ID, prompt: "go" });

    // Both ends: the run-start snapshot preserves what was there, the run-end
    // one becomes the baseline the next run's drift check compares against.
    expect(journalConfig).toHaveBeenCalledTimes(2);
    expect(journalConfig).toHaveBeenCalledWith("/agent", "/workspace");
    // Detection runs before the snapshot, or the loss would be journaled as fact.
    expect(detectConfigDrift).toHaveBeenCalledBefore(vi.mocked(journalConfig));
  });

  it("snapshots config even when the run throws", async () => {
    const runtime = mockRuntime();
    (runtime.execute as any).mockRejectedValue(new Error("boom"));
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });

    await expect(
      launcher.launch({ identity: ID, prompt: "go" })
    ).rejects.toThrow("boom");

    // A crashed run still edited files; a missed snapshot becomes phantom drift.
    expect(journalConfig).toHaveBeenCalledTimes(2);
  });

  it("injects the drift note on a team turn, but not on a guest turn", async () => {
    vi.mocked(detectConfigDrift).mockResolvedValue(drift);
    vi.mocked(describeConfigDrift).mockReturnValue("DRIFT_NOTE");

    const runtime = mockRuntime();
    const team = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });
    await team.launch({
      identity: { trustTier: "team", senderIdentity: "Danny", originChannel: "email" },
      prompt: "go",
    });
    expect((runtime.execute as any).mock.calls[0][0].prompt).toContain("DRIFT_NOTE");

    // Guest turn: config content is team-private and never surfaces.
    const guestRt = mockRuntime();
    const guest = createLauncher(guestRt, { agentDir: "/agent", capabilitiesDir: "/caps" });
    await guest.launch({
      identity: { trustTier: "guest", senderIdentity: "stranger", originChannel: "email" },
      prompt: "go",
    });
    expect((guestRt.execute as any).mock.calls[0][0].prompt).not.toContain("DRIFT_NOTE");
  });

  it("runs the agent anyway when journaling fails", async () => {
    vi.mocked(detectConfigDrift).mockRejectedValue(new Error("disk full"));
    vi.mocked(journalConfig).mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runtime = mockRuntime();
    const launcher = createLauncher(runtime, { agentDir: "/agent", capabilitiesDir: "/caps" });
    const result = await launcher.launch({ identity: ID, prompt: "go" });

    expect(result.success).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Config journal failed"));
  });
});
