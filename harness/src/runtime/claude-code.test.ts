import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { ClaudeCodeRuntime, DEFAULT_TIMEOUT_MS, agentBaseEnv } from "./claude-code.js";

describe("ClaudeCodeRuntime", () => {
  describe("constructor defaults", () => {
    it("uses default binary, no model, and default timeout", () => {
      const rt = new ClaudeCodeRuntime();
      expect((rt as any).binary).toBe("claude");
      expect((rt as any).model).toBeUndefined();
      expect((rt as any).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("accepts custom options", () => {
      const rt = new ClaudeCodeRuntime({
        claudeBinary: "/opt/claude",
        model: "sonnet",
        timeoutMs: 1000,
      });
      expect((rt as any).binary).toBe("/opt/claude");
      expect((rt as any).model).toBe("sonnet");
      expect((rt as any).timeoutMs).toBe(1000);
    });
  });

  describe("buildArgs", () => {
    const rt = new ClaudeCodeRuntime({ model: "opus" });
    const buildArgs = (rt as any).buildArgs.bind(rt);

    it("produces base args for minimal input", () => {
      const args: string[] = buildArgs({
        prompt: "hello",
        maxTurns: 5,
        workingDirectory: "/tmp",
      });
      expect(args).toContain("-p");
      expect(args).toContain("hello");
      expect(args).toContain("--output-format");
      expect(args).toContain("json");
      expect(args).toContain("--max-turns");
      expect(args).toContain("5");
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--model");
      expect(args).toContain("opus");
    });

    it("always passes --strict-mcp-config so host/claude.ai MCP servers never load", () => {
      const args: string[] = buildArgs({
        prompt: "hi",
        maxTurns: 5,
        workingDirectory: "/tmp",
      });
      expect(args).toContain("--strict-mcp-config");
    });

    it("disables all built-in tools with --tools \"\" when disableBuiltinTools is set", () => {
      const args: string[] = buildArgs({
        prompt: "hi",
        maxTurns: 5,
        workingDirectory: "/tmp",
        disableBuiltinTools: true,
      });
      const idx = args.indexOf("--tools");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("");
    });

    it("passes disallowed tools as one comma-separated --disallowedTools value", () => {
      const args: string[] = buildArgs({
        prompt: "hi",
        maxTurns: 5,
        workingDirectory: "/tmp",
        disallowedTools: ["mcp__local-rag__ingest_file", "mcp__local-rag__delete_file"],
      });
      const idx = args.indexOf("--disallowedTools");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("mcp__local-rag__ingest_file,mcp__local-rag__delete_file");
    });

    it("omits --disallowedTools when nothing is disallowed", () => {
      const args: string[] = buildArgs({ prompt: "hi", maxTurns: 5, workingDirectory: "/tmp", disallowedTools: [] });
      expect(args).not.toContain("--disallowedTools");
    });

    it("does not pass --tools when built-in tools are allowed", () => {
      const args: string[] = buildArgs({
        prompt: "hi",
        maxTurns: 5,
        workingDirectory: "/tmp",
      });
      expect(args).not.toContain("--tools");
    });

    it("includes maxTurns as string in args", () => {
      const args: string[] = buildArgs({
        prompt: "test",
        maxTurns: 150,
        workingDirectory: "/tmp",
      });
      const idx = args.indexOf("--max-turns");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("150");
    });

    it("adds --resume when sessionId is provided", () => {
      const args: string[] = buildArgs({
        prompt: "continue",
        maxTurns: 10,
        workingDirectory: "/tmp",
        sessionId: "sess-123",
      });
      expect(args).toContain("--resume");
      expect(args).toContain("sess-123");
    });

    it("adds --json-schema when outputSchema is provided", () => {
      const schema = { type: "object", properties: { answer: { type: "string" } } };
      const args: string[] = buildArgs({
        prompt: "test",
        maxTurns: 1,
        workingDirectory: "/tmp",
        outputSchema: schema,
      });
      expect(args).toContain("--json-schema");
      expect(args).toContain(JSON.stringify(schema));
    });

    it("adds --chrome when enableChrome is true", () => {
      const args: string[] = buildArgs({
        prompt: "test",
        maxTurns: 1,
        workingDirectory: "/tmp",
        enableChrome: true,
      });
      expect(args).toContain("--chrome");
    });

    it("appends additionalArgs", () => {
      const args: string[] = buildArgs({
        prompt: "test",
        maxTurns: 1,
        workingDirectory: "/tmp",
        additionalArgs: ["--verbose", "--debug"],
      });
      expect(args).toContain("--verbose");
      expect(args).toContain("--debug");
    });
  });

  describe("buildEnv", () => {
    const rt = new ClaudeCodeRuntime();
    const buildEnv = (rt as any).buildEnv.bind(rt);

    it("sets HARNESS_MAX_TURNS from input maxTurns", () => {
      const env = buildEnv({
        prompt: "test",
        maxTurns: 150,
        workingDirectory: "/tmp",
      });
      expect(env.HARNESS_MAX_TURNS).toBe("150");
    });

    it("sets HARNESS_ROOT from input harnessRoot", () => {
      const env = buildEnv({
        prompt: "test",
        maxTurns: 100,
        workingDirectory: "/tmp",
        harnessRoot: "/path/to/harness",
      });
      expect(env.HARNESS_ROOT).toBe("/path/to/harness");
    });

    it("defaults HARNESS_ROOT to empty string when not provided", () => {
      const env = buildEnv({
        prompt: "test",
        maxTurns: 100,
        workingDirectory: "/tmp",
      });
      expect(env.HARNESS_ROOT).toBe("");
    });

    it("merges additionalEnv with harness vars", () => {
      const env = buildEnv({
        prompt: "test",
        maxTurns: 50,
        workingDirectory: "/tmp",
        additionalEnv: { CUSTOM_VAR: "hello" },
      });
      expect(env.CUSTOM_VAR).toBe("hello");
      expect(env.HARNESS_MAX_TURNS).toBe("50");
    });

    it("defaults CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS to the process timeout", () => {
      const env = buildEnv({
        prompt: "test",
        maxTurns: 100,
        workingDirectory: "/tmp",
      });
      expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(
        String(DEFAULT_TIMEOUT_MS)
      );
    });

    it("leaves PATH alone when the agent venv hasn't been built", () => {
      const env = buildEnv({
        prompt: "test",
        maxTurns: 100,
        workingDirectory: "/tmp",
        harnessRoot: "/nonexistent/harness",
      });
      expect(env.PATH).toBeUndefined();
    });

    it("puts the agent venv first on PATH when it exists", () => {
      const root = mkdtempSync(join(tmpdir(), "harness-"));
      mkdirSync(join(root, ".agent-venv", "bin"), { recursive: true });
      try {
        const env = buildEnv({
          prompt: "test",
          maxTurns: 100,
          workingDirectory: "/tmp",
          harnessRoot: root,
          additionalEnv: { PATH: "/usr/bin" },
        });
        expect(env.PATH).toBe(`${join(root, ".agent-venv", "bin")}${delimiter}/usr/bin`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("uses an explicit bgWaitCeilingMs when provided", () => {
      const custom = new ClaudeCodeRuntime({ bgWaitCeilingMs: 0 });
      const env = (custom as any).buildEnv.bind(custom)({
        prompt: "test",
        maxTurns: 100,
        workingDirectory: "/tmp",
      });
      expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("0");
    });
  });

  describe("agentBaseEnv", () => {
    it("passes the basics and the agent's own vars through", () => {
      const env = agentBaseEnv({
        PATH: "/usr/bin",
        HOME: "/home/a",
        LC_ALL: "en_US.UTF-8",
        PORTAL_URL: "http://localhost:3000",
        GOG_ACCOUNT: "agent@example.com",
        CLAUDE_CONFIG_DIR: "/home/a/.claude",
      });
      expect(env).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/a",
        LC_ALL: "en_US.UTF-8",
        PORTAL_URL: "http://localhost:3000",
        GOG_ACCOUNT: "agent@example.com",
        CLAUDE_CONFIG_DIR: "/home/a/.claude",
      });
    });

    it("drops the portal's infrastructure and secrets", () => {
      const env = agentBaseEnv({
        PATH: "/usr/bin",
        POSTGRES_URL: "postgres://x",
        REDIS_URL: "redis://x",
        SLACK_BOT_TOKEN: "xoxb",
        TELEGRAM_BOT_TOKEN: "t",
        NOTION_INTERNAL_TOKEN: "n",
        GOOGLE_CLIENT_SECRET: "g",
        LANGFUSE_SECRET_KEY: "l",
        CLAUDECODE: "1",
      });
      expect(env).toEqual({ PATH: "/usr/bin" });
    });
  });

  describe("parseOutput", () => {
    const rt = new ClaudeCodeRuntime();
    const parseOutput = (rt as any).parseOutput.bind(rt);

    it("parses valid JSON output", () => {
      const json = JSON.stringify({
        result: "Hello world",
        session_id: "sess-abc",
        structured_output: { answer: 42 },
        is_error: false,
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.01,
        duration_ms: 1500,
        num_turns: 3,
      });
      const out = parseOutput(json);
      expect(out.output).toEqual({ answer: 42 });
      expect(out.sessionId).toBe("sess-abc");
      expect(out.rawText).toBe("Hello world");
      expect(out.error).toBeUndefined();
      expect(out.usage).toMatchObject({
        input_tokens: 100,
        totalCostUsd: 0.01,
        durationMs: 1500,
        numTurns: 3,
      });
    });

    it("returns error when is_error is true", () => {
      const json = JSON.stringify({
        result: "Something went wrong",
        session_id: "sess-err",
        is_error: true,
      });
      const out = parseOutput(json);
      expect(out.error).toBe("Something went wrong");
    });

    it("handles invalid JSON gracefully", () => {
      const out = parseOutput("not json at all");
      expect(out.output).toBeNull();
      expect(out.rawText).toBe("not json at all");
      expect(out.error).toBe("Failed to parse structured output from runtime");
    });

    it("handles missing optional fields", () => {
      const json = JSON.stringify({ result: "ok" });
      const out = parseOutput(json);
      expect(out.output).toBeNull();
      expect(out.sessionId).toBe("");
      expect(out.rawText).toBe("ok");
      expect(out.error).toBeUndefined();
      expect(out.usage).toBeUndefined();
    });
  });
});
