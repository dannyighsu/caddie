import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  journalConfig,
  detectConfigDrift,
  describeConfigDrift,
  JOURNAL_DIRNAME,
} from "./config-journal.js";

let root: string;
let agentDir: string;
let workspace: string;

const BULLET =
  "- When emailing outside parties, sign as \"Buri H.\" (Betty, 2026-09-19)";

async function writeConfig(relPath: string, content: string): Promise<void> {
  const path = resolve(workspace, "config", relPath);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

/** Snapshots recorded for one config file, oldest first. */
async function snapshots(relPath: string): Promise<string[]> {
  const dir = resolve(agentDir, JOURNAL_DIRNAME, relPath, "..");
  return (await readdir(dir).catch(() => []))
    .filter((name) => name.startsWith(`${relPath.split("/").pop()}.`))
    .sort();
}

beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), "config-journal-"));
  agentDir = resolve(root, "agent");
  workspace = resolve(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("journalConfig", () => {
  it("snapshots every config file, including nested ones", async () => {
    await writeConfig("preferences.md", "# Preferences\n");
    await writeConfig("team/betty.md", `## Standing instructions\n${BULLET}\n`);

    const written = await journalConfig(agentDir, workspace);

    expect(written.sort()).toEqual(["config/preferences.md", "config/team/betty.md"]);
    const [snapshot] = await snapshots("team/betty.md");
    const content = await readFile(
      resolve(agentDir, JOURNAL_DIRNAME, "team", snapshot),
      "utf-8"
    );
    expect(content).toContain(BULLET);
  });

  it("does not re-snapshot a file that hasn't changed", async () => {
    await writeConfig("preferences.md", "# Preferences\n");
    await journalConfig(agentDir, workspace);

    expect(await journalConfig(agentDir, workspace)).toEqual([]);
    expect(await snapshots("preferences.md")).toHaveLength(1);
  });

  it("keeps the old snapshot when a file changes", async () => {
    await writeConfig("team/betty.md", `## Standing instructions\n${BULLET}\n`);
    await journalConfig(agentDir, workspace);
    await writeConfig("team/betty.md", "## Standing instructions\n");
    await journalConfig(agentDir, workspace);

    const versions = await snapshots("team/betty.md");
    expect(versions).toHaveLength(2);
    const oldest = await readFile(
      resolve(agentDir, JOURNAL_DIRNAME, "team", versions[0]),
      "utf-8"
    );
    expect(oldest).toContain(BULLET);
  });

  it("is a no-op when the agent has no config directory", async () => {
    expect(await journalConfig(agentDir, workspace)).toEqual([]);
  });
});

describe("detectConfigDrift", () => {
  it("reports a line that disappeared since the last snapshot", async () => {
    await writeConfig("team/betty.md", `## Standing instructions\n${BULLET}\n`);
    await journalConfig(agentDir, workspace);

    // An out-of-band write puts back an older copy of the file.
    await writeConfig("team/betty.md", "## Standing instructions\n");

    const [drift, ...rest] = await detectConfigDrift(agentDir, workspace);
    expect(rest).toEqual([]);
    expect(drift.relPath).toBe("config/team/betty.md");
    expect(drift.deleted).toBe(false);
    expect(drift.removedLines).toEqual([BULLET]);
    expect(drift.snapshotPath).toContain(JOURNAL_DIRNAME);
  });

  it("reports a config file that was deleted outright", async () => {
    await writeConfig("preferences.md", "# Preferences\n- Keep it short\n");
    await journalConfig(agentDir, workspace);
    await rm(resolve(workspace, "config", "preferences.md"));

    const [drift] = await detectConfigDrift(agentDir, workspace);
    expect(drift.deleted).toBe(true);
    expect(drift.removedLines).toContain("- Keep it short");
  });

  it("stays quiet when a file only gained lines", async () => {
    await writeConfig("preferences.md", "# Preferences\n");
    await journalConfig(agentDir, workspace);
    await writeConfig("preferences.md", "# Preferences\n- A new rule\n");

    expect(await detectConfigDrift(agentDir, workspace)).toEqual([]);
  });

  it("ignores re-indenting and blank-line churn", async () => {
    await writeConfig("preferences.md", `# Preferences\n${BULLET}\n`);
    await journalConfig(agentDir, workspace);
    await writeConfig("preferences.md", `# Preferences\n\n   ${BULLET}\n\n`);

    expect(await detectConfigDrift(agentDir, workspace)).toEqual([]);
  });

  it("stays quiet about the agent's own edits once they are journaled", async () => {
    await writeConfig("team/betty.md", "## Standing instructions\n- Old rule\n");
    await journalConfig(agentDir, workspace);

    // A run supersedes the bullet, then the run-end snapshot records it.
    await writeConfig("team/betty.md", `## Standing instructions\n${BULLET}\n`);
    await journalConfig(agentDir, workspace);

    expect(await detectConfigDrift(agentDir, workspace)).toEqual([]);
  });

  it("is a no-op with no journal yet", async () => {
    await writeConfig("preferences.md", "# Preferences\n");
    expect(await detectConfigDrift(agentDir, workspace)).toEqual([]);
  });
});

describe("describeConfigDrift", () => {
  it("returns an empty string when nothing drifted", () => {
    expect(describeConfigDrift([])).toBe("");
  });

  it("quotes the removed lines and names the file", () => {
    const note = describeConfigDrift([
      {
        relPath: "config/team/betty.md",
        snapshotPath: "/agents/buri/config-history/team/betty.md.stamp",
        deleted: false,
        removedLines: [BULLET],
      },
    ]);

    expect(note).toContain("config/team/betty.md lost these lines:");
    expect(note).toContain(BULLET);
    // The decision is the team member's — the note must not order a rewrite.
    expect(note).toContain("ask the team member");
    // The snapshot lives outside the workspace, so never point the agent at it.
    expect(note).not.toContain("config-history");
  });

  it("caps how much it quotes", () => {
    const removedLines = Array.from({ length: 14 }, (_, i) => `- rule ${i}`);
    const note = describeConfigDrift([
      { relPath: "config/preferences.md", snapshotPath: "s", deleted: false, removedLines },
    ]);

    expect(note).toContain("- rule 9");
    expect(note).not.toContain("- rule 10");
    expect(note).toContain("…and 4 more line(s)");
  });
});
