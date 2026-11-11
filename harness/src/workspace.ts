/**
 * Where the agent's working directory lives.
 *
 * Deliberately outside the repo: a workspace is the agent's data (standing
 * config, mounts, artifacts), not app code, and it has to survive the repo
 * being moved, re-cloned or wiped.
 */

import { homedir } from "os";
import { resolve } from "path";

/** `$WORKSPACE_DIR` if set (a leading `~` expands), otherwise `~/.caddie`. */
export function workspaceDir(): string {
  const override = process.env.WORKSPACE_DIR;
  if (!override) return resolve(homedir(), ".caddie");
  return resolve(override.replace(/^~(?=$|\/)/, homedir()));
}
