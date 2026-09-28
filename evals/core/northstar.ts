/**
 * The northstar modules the eval reuses, so it builds prompts exactly as
 * production does.
 *
 * northstar isn't `"type": "module"`, so tsx loads its files as CommonJS and
 * named ESM imports of them fail at runtime. Importing the namespace and
 * unwrapping `default` works under both module systems, and keeps the types.
 */

import * as inboundPromptNs from "../../northstar/lib/inbound-prompt.ts";
import * as emailThreadingNs from "../../northstar/lib/email-threading.ts";
import * as identityNs from "../../northstar/lib/identity.ts";
import * as replyCheckNs from "../../northstar/lib/reply-check.ts";

function unwrap<T>(ns: T): T {
  return ((ns as { default?: T }).default ?? ns) as T;
}

export const { assembleInboundPrompt } = unwrap(inboundPromptNs);
export const { summarizeEnvelope } = unwrap(emailThreadingNs);
export const { toRunIdentity } = unwrap(identityNs);
export const { REPLY_NUDGE_PROMPT, needsReplyNudge, mergeUsage } = unwrap(replyCheckNs);

export type { ResolvedIdentity } from "../../northstar/lib/identity.ts";
export type { Message } from "../../northstar/lib/db.ts";
