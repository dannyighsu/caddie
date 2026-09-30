import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "os";
import { resolve } from "path";
import { defaultWorkspaceRoot } from "./workspace.js";

describe("defaultWorkspaceRoot", () => {
  const saved = process.env.WORKSPACE_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = saved;
  });

  it("defaults to ~/.ignis, outside the repo", () => {
    delete process.env.WORKSPACE_ROOT;
    expect(defaultWorkspaceRoot()).toBe(resolve(homedir(), ".ignis"));
  });

  it("honors WORKSPACE_ROOT, expanding a leading ~", () => {
    process.env.WORKSPACE_ROOT = "~/elsewhere";
    expect(defaultWorkspaceRoot()).toBe(resolve(homedir(), "elsewhere"));
    process.env.WORKSPACE_ROOT = "/srv/agents";
    expect(defaultWorkspaceRoot()).toBe("/srv/agents");
  });
});
