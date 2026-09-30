/**
 * Shared eval types.
 *
 * A **suite** is a directory under `suites/` with a `suite.yaml` naming its
 * driver and defaults, plus `cases/*.yaml`. A **driver** turns one case into a
 * real agent run inside a sandbox and returns the evidence. **Graders** turn the
 * case's `expect` list plus that evidence into pass/fail results.
 *
 * Adding a use case is adding a suite (and, if the run shape is new, a driver).
 * The runner, graders and report don't change.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Assertions — the `expect` list of a case
// ---------------------------------------------------------------------------

/** Case-insensitive text checks. All given checks must hold. */
export const TextMatch = z
  .object({
    contains: z.string().optional(),
    contains_all: z.array(z.string()).optional(),
    contains_any: z.array(z.string()).optional(),
    not_contains: z.array(z.string()).optional(),
    matches: z.string().optional(), // regex, case-insensitive
    not_matches: z.string().optional(),
  })
  .strict();
export type TextMatch = z.infer<typeof TextMatch>;

const Count = z.object({ min: z.number().int().optional(), max: z.number().int().optional() }).strict();

export const Assertion = z.union([
  z.object({ called: z.string(), times: Count.optional(), where: z.record(TextMatch).optional(), why: z.string().optional() }).strict(),
  z.object({ not_called: z.string(), why: z.string().optional() }).strict(),
  /** The tool was called at least once, and EVERY call matches. */
  z.object({ every_call: z.string(), where: z.record(TextMatch), why: z.string().optional() }).strict(),
  /** Anything that reached outsiders went only to these addresses (or `@domain` suffixes). */
  z.object({ external_only_to: z.array(z.string()).min(1), why: z.string().optional() }).strict(),
  /** Nothing reached anyone outside the team: no reply on a thread with outsiders, no send to a non-team address. */
  z.object({ no_external_send: z.literal(true), why: z.string().optional() }).strict(),
  /** Every message that reached someone outside the team must satisfy the match (internal notes are exempt). */
  z.object({ external_outbound: TextMatch, why: z.string().optional() }).strict(),
  /** Every outbound body (reply, send_email, email_team) must satisfy the match. */
  z.object({ all_outbound: TextMatch, why: z.string().optional() }).strict(),
  /** Judged by a model against the run's tool calls and outbound text. */
  z.object({ rubric: z.string(), why: z.string().optional() }).strict(),
]);
export type Assertion = z.infer<typeof Assertion>;

// ---------------------------------------------------------------------------
// Evidence — what a driver hands the graders
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Short tool name, e.g. `reply`, `email_team`, `list_events`. */
  name: string;
  /** Full name as the model saw it, e.g. `mcp__reply__reply`. */
  fullName: string;
  input: Record<string, unknown>;
  /** Stringified tool result, when the transcript has one. */
  result?: string;
  isError?: boolean;
}

/** One side effect the fake control plane received. */
export interface OutboundEffect {
  kind: "reply" | "email" | "slack" | "purge" | "other";
  /** Recipients as far as the harness can tell. */
  to: string[];
  /** True if any recipient is outside the team. */
  external: boolean;
  subject?: string;
  body: string;
  raw: Record<string, unknown>;
}

export interface Evidence {
  caseId: string;
  trial: number;
  model: string;
  success: boolean;
  error?: string;
  sessionId?: string;
  /** The exact prompt the run was given (after the persona + run context). */
  prompt: string;
  toolCalls: ToolCall[];
  outbound: OutboundEffect[];
  finalText?: string;
  /** Whether the one-time reply reminder was sent (inbound-message driver). */
  nudged?: boolean;
  durationMs: number;
  usage?: Record<string, unknown>;
  /** Path to the copied session transcript. */
  transcriptPath?: string;
}

export interface AssertionResult {
  assertion: Assertion;
  label: string;
  status: "pass" | "fail" | "skipped";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Suites, cases, drivers
// ---------------------------------------------------------------------------

export const SuiteConfig = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    driver: z.string(),
    agent: z.string().default("buri"),
    /** Driver-specific defaults merged under each case. */
    defaults: z.record(z.unknown()).default({}),
  })
  .strict();
export type SuiteConfig = z.infer<typeof SuiteConfig>;

/** Fields every case has; drivers validate the rest. */
export const CaseBase = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string(),
    tags: z.array(z.string()).default([]),
    /** Where the case came from (real session, correction that followed, etc.). */
    source: z.record(z.unknown()).optional(),
    notes: z.string().optional(),
    expect: z.array(Assertion).min(1),
  })
  .passthrough();
export type CaseBase = z.infer<typeof CaseBase>;

export interface LoadedCase extends CaseBase {
  /** Absolute path of the YAML file. */
  file: string;
}

export interface RunOptions {
  model: string;
  effort?: string;
  trial: number;
  /** Scratch directory for this trial's sandbox (deleted afterwards unless kept). */
  runDir: string;
  /** Where this trial's evidence goes (transcript copy); kept with the results. */
  evidenceDir: string;
  keepSandbox: boolean;
}

export interface Driver {
  name: string;
  /** Validate the driver-specific part of a case; throw with a clear message if invalid. */
  validate(c: LoadedCase, suite: SuiteConfig): void;
  run(c: LoadedCase, suite: SuiteConfig, opts: RunOptions): Promise<Evidence>;
}
