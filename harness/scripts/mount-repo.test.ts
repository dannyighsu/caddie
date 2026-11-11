import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const MOUNT = join(__dirname, "mount-repo.py");
const SWEEP = join(__dirname, "sweep-mounts.py");

let root: string;
let ws: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

/** A bare "remote" at <root>/remotes/<name>.git with one commit on `branch`. */
function makeRemote(name: string, branch = "main"): { url: string; push: (file: string) => void } {
  const bare = join(root, "remotes", `${name}.git`);
  const work = join(root, "work", name);
  mkdirSync(bare, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(bare, "init", "--bare", "-q", "-b", branch);
  git(work, "init", "-q", "-b", branch);
  git(work, "remote", "add", "origin", bare);
  const push = (file: string) => {
    writeFileSync(join(work, file), file);
    git(work, "add", file);
    git(work, "commit", "-q", "-m", file);
    git(work, "push", "-q", "origin", branch);
  };
  push("first");
  return { url: `file://${bare}`, push };
}

function mount(...args: string[]) {
  const r = spawnSync("python3", [MOUNT, ...args], { cwd: ws, encoding: "utf-8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function sweep(): string {
  return execFileSync("python3", [SWEEP], { cwd: ws, input: "{}", encoding: "utf-8" }).trim();
}

function sidecar(name: string) {
  return JSON.parse(readFileSync(join(ws, "mounts", ".meta", `${name}.json`), "utf-8"));
}

function expire(name: string) {
  const meta = sidecar(name);
  meta.expiresAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(ws, "mounts", ".meta", `${name}.json`), JSON.stringify(meta));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mount-repo-test-"));
  ws = join(root, "ws");
  mkdirSync(ws);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("mount-repo.py", () => {
  it("shallow-clones remote main and writes a sidecar", () => {
    const { url } = makeRemote("widget");
    const r = mount(url);
    expect(r.code).toBe(0);
    const repo = join(ws, "mounts", "widget");
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(git(repo, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(sidecar("widget")).toMatchObject({ name: "widget", kind: "clone", source: url });
  });

  it("clones a local path's origin, not the local tree", () => {
    const { url } = makeRemote("widget");
    const local = join(root, "work", "widget");
    writeFileSync(join(local, "local-only"), "uncommitted");
    git(local, "checkout", "-q", "-b", "feature");

    expect(mount(local).code).toBe(0);
    const repo = join(ws, "mounts", "widget");
    expect(lstatSync(repo).isSymbolicLink()).toBe(false);
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(existsSync(join(repo, "local-only"))).toBe(false);
    expect(sidecar("widget").source).toBe(url.replace("file://", ""));
  });

  it("refuses a local path with no origin", () => {
    const bare = join(root, "no-origin");
    mkdirSync(bare);
    git(bare, "init", "-q");
    const r = mount(bare);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/no `origin` remote/);
    expect(existsSync(join(ws, "mounts", "no-origin"))).toBe(false);
  });

  it("reuses an existing mount of the same remote, refreshed, with a later expiry", () => {
    const { url, push } = makeRemote("widget");
    mount(url, "--ttl", "1");
    const firstExpiry = sidecar("widget").expiresAt;
    push("second");

    const r = mount(url, "--name", "other-name");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already mounted, refreshed/);
    expect(readdirSync(join(ws, "mounts")).filter((n) => n !== ".meta")).toEqual(["widget"]);
    expect(existsSync(join(ws, "mounts", "widget", "second"))).toBe(true);
    expect(new Date(sidecar("widget").expiresAt) > new Date(firstExpiry)).toBe(true);
  });

  it("treats SSH and HTTPS spellings of one repo as the same remote", () => {
    const r = spawnSync("python3", ["-c", `
import importlib.util
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(MOUNT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.repo_key("git@github.com:Org/widget.git") == m.repo_key("https://github.com/org/widget/"))
`], { encoding: "utf-8" });
    expect(r.stdout.trim()).toBe("True");
  });

  it("doesn't reset a mount with work in progress", () => {
    const { url, push } = makeRemote("widget");
    mount(url);
    const repo = join(ws, "mounts", "widget");
    git(repo, "checkout", "-q", "-b", "fix");
    writeFileSync(join(repo, "wip"), "wip");
    push("second");

    const r = mount(url);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not refreshed/);
    expect(git(repo, "branch", "--show-current")).toBe("fix");
    expect(existsSync(join(repo, "wip"))).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s", "origin/main")).toBe("second");
  });

  it("leaves a pushed branch sweepable after a refresh", () => {
    const { url, push } = makeRemote("widget");
    mount(url);
    const repo = join(ws, "mounts", "widget");
    git(repo, "checkout", "-q", "-b", "fix");
    writeFileSync(join(repo, "change"), "change");
    git(repo, "add", "change");
    git(repo, "commit", "-q", "-m", "change");
    git(repo, "push", "-q", "-u", "origin", "fix");
    push("second");

    mount(url);
    expire("widget");
    sweep();
    expect(existsSync(repo)).toBe(false);
  });

  it("refuses a name held by a different repo", () => {
    mount(makeRemote("widget").url);
    const other = join(root, "elsewhere");
    mkdirSync(other);
    const bare = join(other, "widget.git");
    git(other, "clone", "-q", "--bare", join(root, "remotes", "widget.git"), bare);
    const r = mount(`file://${bare}`);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/already taken/);
  });

  it("falls back to the default branch when the remote has no main", () => {
    const { url } = makeRemote("legacy", "master");
    const r = mount(url);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no `main`.*`master`/);
  });
});

describe("sweep-mounts.py", () => {
  it("removes an expired clean mount and its sidecar", () => {
    mount(makeRemote("widget").url);
    expire("widget");
    expect(sweep()).toBe("");
    expect(existsSync(join(ws, "mounts", "widget"))).toBe(false);
    expect(existsSync(join(ws, "mounts", ".meta", "widget.json"))).toBe(false);
  });

  it("leaves unexpired mounts alone", () => {
    mount(makeRemote("widget").url);
    sweep();
    expect(existsSync(join(ws, "mounts", "widget"))).toBe(true);
  });

  it("keeps an expired mount with uncommitted changes and tells the agent", () => {
    mount(makeRemote("widget").url);
    writeFileSync(join(ws, "mounts", "widget", "draft"), "draft");
    expire("widget");
    expect(sweep()).toMatch(/mounts\/widget was kept: it has uncommitted changes/);
    expect(existsSync(join(ws, "mounts", "widget", "draft"))).toBe(true);
  });

  it("keeps an expired mount with unpushed commits", () => {
    mount(makeRemote("widget").url);
    const repo = join(ws, "mounts", "widget");
    git(repo, "checkout", "-q", "-b", "fix");
    writeFileSync(join(repo, "change"), "change");
    git(repo, "add", "change");
    git(repo, "commit", "-q", "-m", "change");
    expire("widget");
    expect(sweep()).toMatch(/commits not pushed/);
    expect(existsSync(repo)).toBe(true);
  });

  it("drops an orphan sidecar", () => {
    mount(makeRemote("widget").url);
    rmSync(join(ws, "mounts", "widget"), { recursive: true });
    sweep();
    expect(existsSync(join(ws, "mounts", ".meta", "widget.json"))).toBe(false);
  });
});
