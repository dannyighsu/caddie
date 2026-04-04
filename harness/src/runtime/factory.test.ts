import { describe, it, expect, afterEach, vi } from "vitest";
import { createRuntime } from "./factory.js";
import { ClaudeCodeRuntime } from "./claude-code.js";

describe("createRuntime", () => {
  afterEach(() => {
    delete process.env.AGENT_RUNTIME;
  });

  it("returns ClaudeCodeRuntime by default", () => {
    const runtime = createRuntime();
    expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
    expect(runtime.name).toBe("claude-code");
  });

  it("returns ClaudeCodeRuntime when type is explicit", () => {
    const runtime = createRuntime({ type: "claude-code" });
    expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
  });

  it("falls back to ClaudeCodeRuntime for unknown type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createRuntime({ type: "nonexistent" });
    expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown runtime type "nonexistent"')
    );
    warn.mockRestore();
  });

  it("reads AGENT_RUNTIME from env when no type given", () => {
    process.env.AGENT_RUNTIME = "claude-code";
    const runtime = createRuntime();
    expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
  });

  it("passes options through to ClaudeCodeRuntime", () => {
    const runtime = createRuntime({
      type: "claude-code",
      options: { claudeBinary: "/usr/bin/claude", model: "opus", timeoutMs: 5000 },
    });
    // Verify via internal state (lightweight check)
    expect((runtime as any).binary).toBe("/usr/bin/claude");
    expect((runtime as any).model).toBe("opus");
    expect((runtime as any).timeoutMs).toBe(5000);
  });
});
