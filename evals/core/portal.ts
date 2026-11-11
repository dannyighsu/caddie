/**
 * The portal modules the eval reuses, so it builds prompts exactly as
 * production does.
 *
 * The portal isn't `"type": "module"`, so tsx loads its files as CommonJS and
 * named ESM imports of them fail at runtime. Importing the namespace and
 * unwrapping `default` works under both module systems, and keeps the types.
 */

import * as inboundPromptNs from "../../portal/lib/inbound-prompt.ts";
import * as emailThreadingNs from "../../portal/lib/email-threading.ts";
import * as identityNs from "../../portal/lib/identity.ts";
import * as replyCheckNs from "../../portal/lib/reply-check.ts";
import * as teamNs from "../../portal/lib/team.ts";
import * as dbNs from "../../portal/lib/db.ts";

function unwrap<T>(ns: T): T {
  return ((ns as { default?: T }).default ?? ns) as T;
}

export const { assembleInboundPrompt } = unwrap(inboundPromptNs);
export const { summarizeEnvelope } = unwrap(emailThreadingNs);
export const { toRunIdentity } = unwrap(identityNs);
export const { REPLY_NUDGE_PROMPT, needsReplyNudge, mergeUsage } = unwrap(replyCheckNs);
export const { primeTeamRoster, readTeamRoster } = unwrap(teamNs);
export const { getPool } = unwrap(dbNs);

export type { ResolvedIdentity } from "../../portal/lib/identity.ts";
export type { Message } from "../../portal/lib/db.ts";
