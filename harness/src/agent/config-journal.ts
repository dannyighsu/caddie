/**
 * Config Journal
 *
 * `workspace/<agent>/config/` holds the only copy of everything the agent has
 * been told to remember — shared preferences and each member's standing
 * instructions. It is unversioned, gitignored, and written by both the agent and
 * whoever is at the keyboard, with no locking and no change detection. An editor
 * or script saving a stale copy over it wins silently, and the instruction is
 * gone with no error anywhere. That is how a recorded sign-off preference was
 * lost on 2026-09-19 — the agent had already confirmed "saved that as a standing
 * instruction" and nothing afterwards said otherwise.
 *
 * So the harness keeps its own copy. At the start and end of every run, each
 * config file whose contents have changed is written to a new timestamped
 * snapshot under the agent *definition* (`harness/agents/<agent>/config-history/`).
 * Living outside the workspace is the point: a write that clobbers the live file
 * cannot reach the backup. Snapshots are append-only — nothing here is ever
 * overwritten or pruned, since deletion is the failure mode being defended
 * against — and the newest is simply the last one by name.
 *
 * Snapshotting at *both* ends of a run is what makes a loss detectable rather
 * than merely recoverable: the run-end snapshot records what the agent left
 * behind, so anything missing when the next run starts went missing while no run
 * was in progress — an out-of-band write. `detectConfigDrift` reports exactly
 * that, and reports only *removals*: a human adding a line is ordinary, a line
 * disappearing is the thing nobody notices.
 */

import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { resolve, dirname, basename, posix } from "path";

/** Directory under the agent definition that holds the snapshots. */
export const JOURNAL_DIRNAME = "config-history";

/**
 * Snapshot suffix: the ISO timestamp with `:` swapped for `-` so it is a legal
 * filename. Fixed width, so lexical order is chronological order.
 */
const SNAPSHOT_SUFFIX = /\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;

/**
 * Files this large aren't durable memory — they're data someone parked in
 * `config/`. Snapshotting one on every change would grow the journal without
 * protecting anything.
 */
const MAX_SNAPSHOT_BYTES = 1_000_000;

export interface ConfigDrift {
  /** Path relative to the workspace, e.g. `config/team/betty.md`. */
  relPath: string;
  /** The snapshot the live file was compared against. */
  snapshotPath: string;
  /** The live file is gone entirely, not just shorter. */
  deleted: boolean;
  /** Non-blank lines present in the snapshot and absent from the live file. */
  removedLines: string[];
}

/**
 * Monotonic so two snapshots taken in the same millisecond get different names.
 * A journal that overwrote an entry would lose exactly what it exists to keep.
 */
let lastStamp = 0;
function timestamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString().replace(/:/g, "-");
}

/**
 * Write one snapshot, never over an existing one. `wx` also covers the case the
 * monotonic clock can't: a second process journaling the same agent.
 */
async function writeSnapshot(
  journalRoot: string,
  relPath: string,
  content: string
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const dest = resolve(journalRoot, `${relPath}.${timestamp()}`);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await writeFile(dest, content, { encoding: "utf-8", flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 5) throw err;
    }
  }
}

/** Every file under `dir`, as paths relative to it. Dotfiles are skipped. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // No config directory yet.
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await listFiles(resolve(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      found.push(rel);
    }
  }
  return found;
}

/** The config paths that have history, derived from the snapshot names. */
async function listJournaledPaths(journalRoot: string): Promise<string[]> {
  const snapshots = await listFiles(journalRoot);
  const paths = new Set<string>();
  for (const snapshot of snapshots) {
    if (!SNAPSHOT_SUFFIX.test(snapshot)) continue;
    paths.add(snapshot.replace(SNAPSHOT_SUFFIX, ""));
  }
  return [...paths].sort();
}

/** The most recent snapshot of one config file, or null if it has none. */
async function newestSnapshot(
  journalRoot: string,
  relPath: string
): Promise<{ path: string; content: string } | null> {
  const dir = resolve(journalRoot, dirname(relPath));
  const name = basename(relPath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const versions = entries
    .filter((e) => e.startsWith(`${name}.`) && SNAPSHOT_SUFFIX.test(e))
    .sort();
  const newest = versions.at(-1);
  if (!newest) return null;
  const path = resolve(dir, newest);
  try {
    return { path, content: await readFile(path, "utf-8") };
  } catch {
    return null;
  }
}

/**
 * Snapshot every config file whose contents differ from its newest snapshot.
 * Returns the workspace-relative paths that were written, for logging.
 */
export async function journalConfig(
  agentDir: string,
  workingDirectory: string
): Promise<string[]> {
  const configRoot = resolve(workingDirectory, "config");
  const journalRoot = resolve(agentDir, JOURNAL_DIRNAME);
  const written: string[] = [];

  for (const relPath of await listFiles(configRoot)) {
    const livePath = resolve(configRoot, relPath);
    const size = await stat(livePath).then((s) => s.size).catch(() => Infinity);
    if (size > MAX_SNAPSHOT_BYTES) continue;

    let live: string;
    try {
      live = await readFile(livePath, "utf-8");
    } catch {
      continue; // Vanished or unreadable mid-walk — drift detection will say so.
    }

    const previous = await newestSnapshot(journalRoot, relPath);
    if (previous?.content === live) continue;

    await writeSnapshot(journalRoot, relPath, live);
    written.push(posix.join("config", relPath));
  }

  return written;
}

/**
 * Compare each journaled config file against the live one and report what was
 * removed. Called at run start, before journaling, so the comparison is against
 * the state the previous run left behind — every difference found here happened
 * with no run in progress.
 */
export async function detectConfigDrift(
  agentDir: string,
  workingDirectory: string
): Promise<ConfigDrift[]> {
  const configRoot = resolve(workingDirectory, "config");
  const journalRoot = resolve(agentDir, JOURNAL_DIRNAME);
  const drifts: ConfigDrift[] = [];

  for (const relPath of await listJournaledPaths(journalRoot)) {
    const previous = await newestSnapshot(journalRoot, relPath);
    if (!previous) continue;

    const live = await readFile(resolve(configRoot, relPath), "utf-8").catch(
      () => null
    );
    if (live === previous.content) continue;

    // Compare trimmed lines: re-wrapping or re-indenting a bullet is not a loss.
    const survivors = new Set(
      (live ?? "").split("\n").map((line) => line.trim())
    );
    const removedLines = previous.content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !survivors.has(line));
    if (removedLines.length === 0) continue; // Additions only — ordinary editing.

    drifts.push({
      relPath: posix.join("config", relPath),
      snapshotPath: previous.path,
      deleted: live === null,
      removedLines,
    });
  }

  return drifts;
}

/** Files listed in the run-context note before it stops enumerating. */
const NOTE_MAX_FILES = 5;
/** Removed lines quoted per file. */
const NOTE_MAX_LINES = 10;

/**
 * Render drift as a run-context note, or "" when there is nothing to say.
 *
 * Deliberately does not tell the agent to restore anything. A removal with no
 * run in progress is either a clobber or a team member editing the file by hand,
 * and nothing on disk distinguishes them — so the note surfaces the fact and
 * leaves the decision to the person, which is also the rule the persona already
 * sets for durable memory.
 */
export function describeConfigDrift(drifts: ConfigDrift[]): string {
  if (drifts.length === 0) return "";

  const blocks = drifts.slice(0, NOTE_MAX_FILES).map((drift) => {
    const quoted = drift.removedLines
      .slice(0, NOTE_MAX_LINES)
      .map((line) => `  ${line}`);
    const extra = drift.removedLines.length - quoted.length;
    if (extra > 0) quoted.push(`  …and ${extra} more line(s)`);
    const what = drift.deleted ? "was deleted" : "lost these lines";
    return `${drift.relPath} ${what}:\n${quoted.join("\n")}`;
  });
  const extraFiles = drifts.length - blocks.length;
  if (extraFiles > 0) blocks.push(`…and ${extraFiles} more file(s)`);

  return (
    `Durable memory changed outside a run: the lines below were in your config ` +
    `files when your last run ended and are gone now. No run of yours removed ` +
    `them, so either a team member edited the file by hand or something ` +
    `overwrote it. Don't assume which, and don't rewrite the file on your own — ` +
    `but if one of these lines bears on what you're doing this turn, say so and ` +
    `ask the team member whether it still stands.\n\n${blocks.join("\n\n")}`
  );
}
