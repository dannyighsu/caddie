/**
 * Where agent working directories live.
 *
 * Deliberately outside the repo: a workspace is the agent's data (standing
 * config, mounts, artifacts), not app code, and it has to survive the repo
 * being moved, re-cloned or wiped.
 */

import { homedir } from "os";
import { resolve } from "path";

/** `$WORKSPACE_ROOT` if set (a leading `~` expands), otherwise `~/.ignis`. */
export function defaultWorkspaceRoot(): string {
  const override = process.env.WORKSPACE_ROOT;
  if (!override) return resolve(homedir(), ".ignis");
  return resolve(override.replace(/^~(?=$|\/)/, homedir()));
}
