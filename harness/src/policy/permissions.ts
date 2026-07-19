/**
 * Permission Policy
 *
 * Single source of truth for what each trust tier may do. Loaded from
 * `harness/permissions.json`, keyed by trust tier → permission key → allowed.
 * Permission keys are capability names (see harness/capabilities/) plus the
 * synthetic `base-tools` key, which governs the built-in Claude Code tools
 * (Bash, Read, Write, Edit, WebFetch, ...).
 *
 * DEFAULT-DENY: any (tier, key) not explicitly `true` is denied. A new
 * capability is therefore off for everyone until granted, and guests — who have
 * no grants — get nothing.
 *
 * See docs/PERMISSIONS.md.
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import type { TrustTier } from "../agent/types.js";

/** Governs the built-in Claude Code tool set (Bash, Read, Write, Edit, ...). */
export const BASE_TOOLS_KEY = "base-tools";

/** tier → (permission key → allowed). Absent or false ⇒ denied. */
export type PermissionPolicy = Record<string, Record<string, boolean>>;

/** Load the permission policy from `<harnessRoot>/permissions.json`. */
export async function loadPermissions(harnessRoot: string): Promise<PermissionPolicy> {
  const filePath = resolve(harnessRoot, "permissions.json");
  return JSON.parse(await readFile(filePath, "utf-8")) as PermissionPolicy;
}

/**
 * Whether `tier` is granted `key`. Default-deny: anything not explicitly `true`
 * is denied (including unknown tiers and keys).
 */
export function isAllowed(policy: PermissionPolicy, tier: TrustTier, key: string): boolean {
  return policy[tier]?.[key] === true;
}

export interface CapabilityFilterResult {
  /** Capability names granted to this tier. */
  kept: string[];
  /** Capability names denied to this tier. */
  dropped: string[];
}

/**
 * Filter an agent's declared capability names by the policy for `tier`. A
 * capability is kept only if explicitly granted (default-deny).
 */
export function filterCapabilitiesByPolicy(
  capabilityNames: string[],
  policy: PermissionPolicy,
  tier: TrustTier
): CapabilityFilterResult {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const name of capabilityNames) {
    if (isAllowed(policy, tier, name)) kept.push(name);
    else dropped.push(name);
  }
  return { kept, dropped };
}
