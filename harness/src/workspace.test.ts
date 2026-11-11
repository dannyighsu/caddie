import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "os";
import { resolve } from "path";
import { workspaceDir } from "./workspace.js";

describe("workspaceDir", () => {
  const saved = process.env.WORKSPACE_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = saved;
  });

  it("defaults to ~/.caddie, outside the repo", () => {
    delete process.env.WORKSPACE_DIR;
    expect(workspaceDir()).toBe(resolve(homedir(), ".caddie"));
  });

  it("honors WORKSPACE_DIR, expanding a leading ~", () => {
    process.env.WORKSPACE_DIR = "~/elsewhere";
    expect(workspaceDir()).toBe(resolve(homedir(), "elsewhere"));
    process.env.WORKSPACE_DIR = "/srv/caddie";
    expect(workspaceDir()).toBe("/srv/caddie");
  });
});
