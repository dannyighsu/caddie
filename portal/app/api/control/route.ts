/**
 * Control API — /api/control
 *
 * The control-plane command surface: an internal API for triggering agent
 * executions, sending notifications, and managing scheduled jobs. Called by the
 * portal UI and by the agent's own tools/skills (never by external senders —
 * inbound channel traffic arrives at the webhook routes instead). See
 * docs/BACKEND.md for the API server's client classes.
 *
 * Actions:
 *   notify  — Send a message to Slack, Telegram, or email (immediately or scheduled)
 *   email_team — Email team members by id (or "all"); addresses come from the roster
 *   run     — Execute the agent (immediately or scheduled)
 *   schedule — Create a recurring job (an agent run, or a shell command via type: "command")
 *   list_slack_channels — List the workspace's Slack channels (id, name, whether the bot can post)
 *
 * Supports `scheduledFor` for one-shot deferred execution,
 * or `cron` for recurring jobs.
 *
 * Examples:
 *   curl -X POST localhost:3000/api/control -d '{"action":"notify","channel":"slack","message":"done"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"notify","channel":"telegram","to":"123456789","message":"done"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"run"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"run","profile":"extended"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"run","scheduledFor":"2026-03-28T09:00:00Z"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"schedule","cron":"0,30 * * * *","description":"Feed scan every 30 min"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"schedule","cron":"0,5,10,15,20,25 * * * *","type":"command","command":"./poll.sh","onOutput":"run","prompt":"/handle-poll"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"list_slack_channels","nameFilter":"eng"}'
 */

import { NextRequest, NextResponse } from "next/server";
import { sendMessage, replyInThread, uploadFile, recordOutboundSlackThread, isSlackConfigured, listChannels } from "@/lib/slack";
import { normalizeBlocks, withAttribution } from "@/lib/slack-blocks";
import { sendTelegramMessage, isTelegramConfigured } from "@/lib/telegram";
import { sendEmail, replyToEmail, recordEmailReply, isEmailConfigured, htmlToText } from "@/lib/email";
import type { NotificationChannel } from "@/lib/notification-channels";
import type { ReplyTarget } from "@/lib/messaging";
import { portalIdentity, toRunIdentity, parsePortalOwner, type TrustTier, type UserId } from "@/lib/identity";
import type { ThreadContext } from "@/lib/thread-context";
import { getLauncher } from "@/lib/harness";
import { getSetting, appendAssistantReply } from "@/lib/db";
import { currentTimePST } from "@/lib/helpers";
import { scheduleOneShot, scheduleRecurring, scheduleNotification, listJobs, deleteJob, getJob, upsertJob } from "@/lib/redis";
import { parseCommandSpec } from "@/lib/command-job";
import { workspace } from "@/lib/harness";
import { executeJob, isJobActive } from "@/lib/scheduler";
import { createTraceId, createTrace, completeTrace } from "@/lib/tracing";
import { purgeContent } from "@/lib/purge";
import type { PurgeReason } from "@/lib/db";
import { rebuildIndex, ragEnabled } from "@/lib/workspace-index";
import { getTeamRoster } from "@/lib/team";

interface ControlRequest {
  action:
    | "notify"
    | "email_team"
    | "reply"
    | "run"
    | "schedule"
    | "update_schedule"
    | "trigger"
    | "list_slack_channels"
    | "purge"
    | "rag_rebuild";

  // --- reply fields ---
  /**
   * Where to deliver the reply, injected into the run as CADDIE_REPLY_TARGET
   * and forwarded verbatim by the reply MCP tool. Not agent-supplied, so a reply
   * can only land in the current conversation. Uses `message` for the body.
   */
  replyTarget?: ReplyTarget;
  /**
   * Email reply scope. Defaults to reply-all (true) when omitted, so group
   * threads stay group threads; the agent sets `false` to answer just the
   * sender. Ignored for non-email channels, which have no CC concept.
   */
  replyAll?: boolean;

  // --- notify fields ---
  channel?: NotificationChannel;
  message?: string;
  from?: string;
  slackChannel?: string;
  threadTs?: string;
  /**
   * A file to attach to the Slack post (slack channel only), sent as bytes so
   * the portal never reads a caller-supplied path off disk. `message` becomes
   * the comment that introduces it.
   */
  file?: { filename: string; contentBase64: string; title?: string };
  /**
   * Block Kit layout for a Slack post (slack channel only) — an array of blocks,
   * or the JSON string / `{"blocks": [...]}` wrapper a job script produces.
   * `message` stays required and becomes the notification fallback text, as
   * Slack's API expects. Not supported with `file` (a file share carries only a
   * plain comment) or with `scheduledFor` (the job payload carries text only).
   */
  blocks?: unknown;
  /**
   * Telegram chat ID (numeric string), or email recipient(s) — the email
   * channel accepts a comma-separated list. For `email_team`, a member id or
   * "all".
   */
  to?: string;
  /** Additional email recipients, comma-separated (email channel only). */
  cc?: string;
  bcc?: string;
  /**
   * Continue an existing Gmail thread (email channel only) rather than starting
   * a new one — for a follow-up on a thread the agent itself opened. Without
   * it, each follow-up is a separate thread in the recipient's mailbox.
   */
  threadId?: string;
  /** Email subject line */
  subject?: string;
  /**
   * Formatted HTML body (email channel only). An alternative to `message`, not
   * an addition: when only `html` is given the plain-text part is derived from
   * it, so the two MIME alternatives cannot drift apart. Ignored by the other
   * channels, which have their own markup, and by deferred (`scheduledFor`)
   * notifications, which carry only a plain body through the job payload.
   */
  html?: string;
  /**
   * Source-task facts to attach to the email thread this send creates (email
   * channel only). Forwarded by email-mcp from the run's CADDIE_THREAD_CONTEXT.
   */
  threadContext?: ThreadContext;

  // --- run fields ---
  profile?: string;
  prompt?: string;
  context?: Record<string, string>;
  /**
   * Trust tier for scheduled/one-shot agent runs. Defaults to "team" at
   * execution time (these are the team's own automations). Set "guest" to
   * pin a job to least privilege.
   */
  trustTier?: TrustTier;

  // --- scheduling ---
  scheduledFor?: string;    // ISO timestamp for one-shot deferred execution
  cron?: string;            // Cron expression for recurring jobs
  jobId?: string;           // For deleting a job
  description?: string;
  /**
   * What a scheduled job does when it fires. "agent" (the default) launches an
   * agent run with `prompt`. "command" runs `command` in a shell and only
   * escalates if it printed something — see `onOutput` and lib/command-job.ts.
   * Maps to the stored job's `action` ("run" / "command").
   */
  type?: "agent" | "command";

  // --- command-job fields (type: "command") ---
  /** The shell command line to run on each tick. Required for a command job. */
  command?: string;
  /** Workspace-relative working directory. Defaults to the workspace root. */
  cwd?: string;
  /**
   * What to do when the command writes to stdout. "run" (default) launches the
   * agent with the output appended to `prompt`; "notify" sends the output to the
   * notification channel; "ignore" only logs it. Empty stdout always does
   * nothing — that is the point of a command job.
   */
  onOutput?: "run" | "notify" | "ignore";
  /** Per-tick wall-clock limit for the command. Defaults to 60s, capped at 10m. */
  commandTimeoutMs?: number;
  /**
   * Names of environment variables to forward from the portal process to the
   * command. Nothing is forwarded by default beyond PATH/HOME/LANG/TZ, so a
   * command that needs a token has to name it here.
   */
  commandEnv?: string[];
  /**
   * For scheduled run/notify jobs: the channel to deliver the result/notification on.
   * Defaults to "slack". Set to "telegram" or "email" to override.
   */
  notificationChannel?: NotificationChannel;
  /**
   * For scheduled jobs: channel-specific recipient override (Slack channel ID,
   * Telegram chat ID, or email). If omitted, uses the channel's configured default.
   */
  notificationRecipient?: string;

  // --- list_slack_channels fields ---
  /**
   * Slack conversation types to include, as `conversations.list` takes them
   * (e.g. "public_channel", "public_channel,private_channel"). Defaults to
   * public plus the private channels the bot is in.
   */
  types?: string;
  /** Case-insensitive substring match on the channel name. */
  nameFilter?: string;
  /** Include archived channels. Off by default — they can't be posted to. */
  includeArchived?: boolean;
  /** Cap on channels returned after filtering. */
  limit?: number;

  // --- purge fields (see lib/purge.ts) ---
  // `trustTier` (above) is the run's, injected by the harness.
  /** The inbound message the run is handling, injected by the harness. */
  currentMessage?: { conversationId: string; seq: number };
  /** Purge the message being handled. */
  current?: boolean;
  /** Workspace path to purge: a `conversations/` message file or any other file. */
  path?: string;
  reason?: PurgeReason;
  note?: string;
  traceId?: string;
}

// --- Action execution ---

async function executeAction(req: ControlRequest, portalOwner: UserId): Promise<Record<string, unknown>> {
  switch (req.action) {
    case "notify":
      return executeNotify(req);
    case "email_team":
      return executeEmailTeam(req);
    case "reply":
      return executeReply(req);
    case "run":
      return executeRun(req, portalOwner);
    case "schedule":
      return executeSchedule(req);
    case "update_schedule":
      return executeUpdateSchedule(req);
    case "trigger":
      return executeTrigger(req);
    case "list_slack_channels":
      return executeListSlackChannels(req);
    case "purge":
      return executePurge(req);
    case "rag_rebuild":
      return executeRagRebuild();
    default:
      return { success: false, error: `Unknown action: ${req.action}` };
  }
}

/**
 * Deliver an agent's reply into the current conversation.
 *
 * Unlike `notify`/`send_email` (which start or address arbitrary threads), reply
 * targets the exact conversation the run is handling — the target is injected by
 * the harness (CADDIE_REPLY_TARGET), not chosen by the agent, so a reply can
 * only land where the inbound message came from. On success it records the sent
 * turn locally so replayed history mirrors the real thread.
 */
async function executeReply(req: ControlRequest): Promise<Record<string, unknown>> {
  const target = req.replyTarget;
  const message = req.message;
  if (!target || !message) {
    return { success: false, error: "reply requires `replyTarget` and `message`" };
  }

  // Best-effort local record — a failed record must not fail the delivery.
  const record = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error(`[Control] reply delivered but failed to record locally:`, err);
    }
  };

  switch (target.channel) {
    case "email": {
      if (!isEmailConfigured()) return { success: false, error: "email is not configured" };
      if (!target.email?.messageId) {
        return { success: false, error: "reply target is missing email.messageId" };
      }
      const sent = await replyToEmail(target.email.messageId, message, {
        replyAll: req.replyAll,
      });
      await record(() => recordEmailReply(target.externalId, sent.messageId, message));
      return { success: true, messageId: sent.messageId };
    }
    case "slack": {
      if (!isSlackConfigured()) return { success: false, error: "slack is not configured" };
      if (!target.slack) return { success: false, error: "reply target is missing slack handle" };
      await replyInThread(target.slack.channel, target.slack.threadTs, message);
      await record(() => appendAssistantReply(target.externalId, message));
      return { success: true };
    }
    case "telegram": {
      if (!isTelegramConfigured()) return { success: false, error: "telegram is not configured" };
      if (!target.telegram) return { success: false, error: "reply target is missing telegram handle" };
      await sendTelegramMessage(
        target.telegram.chatId,
        message,
        target.telegram.replyToMessageId
          ? { replyToMessageId: target.telegram.replyToMessageId }
          : undefined,
      );
      await record(() => appendAssistantReply(target.externalId, message));
      return { success: true };
    }
    default:
      return { success: false, error: `reply not supported for channel: ${target.channel}` };
  }
}

/**
 * Purge suspected phishing / prompt-injection content (the `purge_content`
 * tool). The run's trust tier and current message come from the
 * harness-injected tool env, so a guest run can only ever purge the message
 * it's handling — enforced in lib/purge.ts.
 */
async function executePurge(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!req.reason) {
    return { success: false, error: "purge requires `reason`" };
  }
  return purgeContent({
    trustTier: req.trustTier ?? "guest",
    currentMessage: req.currentMessage,
    current: req.current,
    path: req.path,
    reason: req.reason,
    note: req.note,
    traceId: req.traceId,
  });
}

/**
 * Drop and rebuild the workspace search index (`make rag-rebuild`). Runs in this
 * process, behind the indexer's own queue, so it never races a sync.
 */
async function executeRagRebuild(): Promise<Record<string, unknown>> {
  if (!ragEnabled()) return { success: false, error: "LOCAL_RAG_ENTRY is not set (see `make rag-setup`)" };
  await rebuildIndex();
  return { success: true };
}

/**
 * Trigger an existing scheduled job to run immediately ("run now").
 *
 * Runs the job's stored payload out-of-band via the shared executor. The
 * schedule is preserved: recurring jobs keep their cron/nextRun untouched (this
 * is an EXTRA fire), while one-shot jobs are consumed (deleted) after running
 * so they don't also fire at their scheduled time.
 *
 * If a run for the same profile is already in progress, the job is not run and
 * the caller is told to retry later.
 */
async function executeTrigger(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!req.jobId) {
    return { success: false, error: "jobId is required for trigger" };
  }

  const job = await getJob(req.jobId);
  if (!job) {
    return { success: false, error: `Job not found: ${req.jobId}` };
  }

  // Immediate "already running" feedback so we don't fire (or consume a
  // one-shot) while a run for the same profile is in flight.
  if (await isJobActive(job)) {
    return { success: false, skipped: true, error: "A run is already in progress for this profile" };
  }

  // One-shot jobs are consumed (deleted) once they run, so they don't also fire
  // at their scheduled time. Recurring jobs stay on their schedule — a manual
  // trigger is just an extra run.
  const consumed = !job.cron;

  // A command job whose output doesn't wake the agent is bounded by its own
  // timeout, so run it inline and hand the caller the command's output — that
  // is what makes "run now" useful for testing a poller. One whose output does
  // launch an agent falls through to the async path below.
  // `onOutput` defaults to "run" when unset, so compare the effective value.
  if (job.action === "command" && (job.params?.onOutput ?? "run") !== "run") {
    const result = await executeJob(job, { source: "trigger" });
    if (result.success && consumed) {
      await deleteJob(job.id);
    }
    return {
      success: result.success,
      output: result.rawText ?? "",
      error: result.error,
      consumed: result.success && consumed,
    };
  }

  // Notify jobs are fast — run inline and report the result.
  if (job.action === "notify") {
    const result = await executeJob(job, { source: "trigger" });
    if (result.success && consumed) {
      await deleteJob(job.id);
    }
    return { success: result.success, error: result.error, consumed: result.success && consumed };
  }

  // Agent "run" jobs can take minutes — fire async so the request returns
  // promptly (mirrors how the scheduler fires). Consume a one-shot only after
  // it actually ran (not if the concurrency lock was lost in the meantime).
  executeJob(job, { source: "trigger" })
    .then(async (result) => {
      if (result.skipped) {
        console.log(`[Control] Trigger ${job.id} skipped: ${result.error}`);
        return;
      }
      if (consumed) {
        await deleteJob(job.id);
      }
    })
    .catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Control] Trigger ${job.id} failed:`, error);
    });

  return { success: true, started: true, recurring: !!job.cron, consumed };
}

/**
 * List the workspace's Slack channels so a caller can resolve a channel by name
 * instead of being handed an ID. Read-only: it touches no conversation state.
 *
 * `canPost` is the field that matters, not `isMember`: with `chat:write.public`
 * the bot can post to a public channel it never joined.
 */
async function executeListSlackChannels(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!isSlackConfigured()) {
    return { success: false, error: "SLACK_BOT_TOKEN not configured" };
  }

  const { channels, truncated } = await listChannels({
    types: req.types,
    nameFilter: req.nameFilter,
    includeArchived: req.includeArchived,
    limit: req.limit,
  });

  return { success: true, count: channels.length, truncated, channels };
}

/**
 * Email team members, chosen by id (or "all"), for the `email_team` tool. The
 * address is looked up here from the roster, never supplied by the caller, so
 * the tool can't be pointed at anyone outside the team — which is why it's safe
 * at guest trust. One message per member, each its own thread, through the same
 * path as `notify` so a reply comes back with context.
 */
async function executeEmailTeam(req: ControlRequest): Promise<Record<string, unknown>> {
  const to = req.to ?? "all";
  const roster = await getTeamRoster();
  const selected = to === "all" ? roster : roster.filter((m) => m.id === to);
  if (selected.length === 0) {
    return { success: false, error: `No team member with id "${to}".` };
  }

  const sent: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const member of selected) {
    const address = member.emails[0];
    if (!address) {
      missing.push(member.id);
      continue;
    }
    try {
      const result = await executeNotify({
        action: "notify",
        channel: "email",
        to: address,
        subject: req.subject,
        message: req.message,
        html: req.html,
        threadContext: req.threadContext,
      });
      if (result.success) sent.push(member.id);
      else failed.push(`${member.id} (${result.error ?? "unknown error"})`);
    } catch (err) {
      failed.push(`${member.id} (${(err as Error).message})`);
    }
  }
  return { success: sent.length > 0, sent, missing, failed };
}

async function executeNotify(req: ControlRequest): Promise<Record<string, unknown>> {
  // An HTML-only send is legitimate (the agent wrote the body as markup), so
  // derive the plain-text body rather than demanding the caller write it twice.
  const message = req.message ?? (req.html ? htmlToText(req.html) : undefined);
  if (!message) {
    return { success: false, error: "message is required" };
  }

  // Handle deferred notification
  if (req.scheduledFor) {
    if (req.file) {
      return { success: false, error: "file attachments can't be scheduled; post them immediately" };
    }
    if (req.blocks) {
      return { success: false, error: "Block Kit blocks can't be scheduled; post them immediately" };
    }
    const runAt = new Date(req.scheduledFor);
    if (isNaN(runAt.getTime())) {
      return { success: false, error: "Invalid scheduledFor timestamp" };
    }
    // Channel for scheduled notify: prefer notificationChannel, fall back to channel, default slack
    const notificationChannel = req.notificationChannel ?? req.channel;
    // Recipient resolution: notificationRecipient > channel-specific (slackChannel/to) > none
    const notificationRecipient =
      req.notificationRecipient ??
      (notificationChannel === "slack" ? req.slackChannel : undefined) ??
      (notificationChannel === "telegram" || notificationChannel === "email"
        ? req.to
        : undefined);

    // Validate up front, mirroring the immediate-send paths below. Email has no
    // default recipient, so a missing one can never be resolved at fire time —
    // reject now instead of accepting the job and failing later in the scheduler.
    if (notificationChannel === "email" && !notificationRecipient) {
      return { success: false, error: "Email recipient (to) is required" };
    }

    const job = await scheduleNotification(runAt, {
      message,
      from: req.from,
      description: req.description,
      notificationChannel,
      notificationRecipient,
    });
    return { success: true, scheduled: true, jobId: job.id, nextRun: new Date(job.nextRun).toISOString() };
  }

  if (req.channel === "slack" || !req.channel) {
    if (!isSlackConfigured()) {
      return { success: false, error: "SLACK_BOT_TOKEN not configured" };
    }

    let channelId = req.slackChannel;
    if (!channelId) {
      const defaultChannel = await getSetting<{ channelId: string }>("default_slack_channel");
      channelId = defaultChannel?.channelId;
    }
    if (!channelId) {
      return { success: false, error: "No Slack channel specified and no default configured" };
    }

    const { blocks, error: blocksError } = normalizeBlocks(req.blocks);
    if (blocksError) {
      return { success: false, error: blocksError };
    }
    if (blocks && req.file) {
      return {
        success: false,
        error: "blocks can't be combined with a file: a file share carries only plain comment text",
      };
    }

    const formatted = req.from
      ? `*[${req.from}]* ${message}`
      : message;
    // With blocks, `formatted` is only the fallback text, so the attribution has
    // to be rendered into the layout too or it disappears from the post itself.
    const layout = blocks ? withAttribution(blocks, req.from) : undefined;

    // Resolve the thread root: the parent thread_ts when replying into an
    // existing thread, otherwise the new top-level message's own ts. Register it
    // so a reply in this thread matches a conversation and — for posts from the
    // agent's own tasks — carries the source-task facts (see recordOutboundSlackThread).
    let threadTs = req.threadTs;
    if (req.file) {
      const file = {
        filename: req.file.filename,
        data: Buffer.from(req.file.contentBase64, "base64"),
        title: req.file.title,
      };
      threadTs = await uploadFile(channelId, file, formatted, threadTs);
    } else if (threadTs) {
      await replyInThread(channelId, threadTs, formatted, { blocks: layout });
    } else {
      threadTs = await sendMessage(channelId, formatted, { blocks: layout });
    }
    if (threadTs) {
      await recordOutboundSlackThread(channelId, threadTs, formatted, req.threadContext);
    }

    return { success: true, channel: "slack", channelId, threadTs };
  }

  if (req.channel === "telegram") {
    if (!isTelegramConfigured()) {
      return { success: false, error: "Telegram not configured (TELEGRAM_BOT_TOKEN missing)" };
    }

    let recipient = req.to;
    if (!recipient) {
      const config = await getSetting<{ defaultRecipient?: string }>("telegram_config");
      recipient = config?.defaultRecipient;
    }
    if (!recipient) {
      return { success: false, error: "No Telegram recipient specified and no default configured" };
    }

    const formatted = req.from
      ? `*[${req.from}]* ${message}`
      : message;

    await sendTelegramMessage(recipient, formatted);
    return { success: true, channel: "telegram", to: recipient };
  }

  if (req.channel === "email") {
    if (!isEmailConfigured()) {
      return { success: false, error: "Email not configured (missing Google OAuth credentials or token file)" };
    }

    if (!req.to) {
      return { success: false, error: "Email recipient (to) is required" };
    }

    // A follow-up on an existing thread inherits that thread's subject, so the
    // generic default must not be substituted in and rename the conversation.
    const subject = req.subject ?? (req.threadId ? "" : "Notification");
    // The `from` attribution is prefixed onto BOTH alternatives — prefixing only
    // the plain part would drop it for every recipient who reads the HTML.
    const html = req.html
      ? req.from
        ? `<p>[${req.from}]</p>\n${req.html}`
        : req.html
      : undefined;
    const formatted = req.from ? `[${req.from}] ${message}` : message;

    // Return the sent ids: `threadId` is what a later run passes back as
    // `threadId` to continue this same thread instead of opening a new one.
    const sent = await sendEmail(req.to, subject, formatted, {
      threadContext: req.threadContext,
      html,
      cc: req.cc,
      bcc: req.bcc,
      threadId: req.threadId,
    });
    return {
      success: true,
      channel: "email",
      to: req.to,
      ...(req.cc && { cc: req.cc }),
      messageId: sent.messageId,
      threadId: sent.threadId,
    };
  }

  return { success: false, error: `Unsupported channel: ${req.channel}` };
}

async function executeRun(req: ControlRequest, portalOwner: UserId): Promise<Record<string, unknown>> {
  // Handle deferred one-shot execution
  if (req.scheduledFor) {
    const runAt = new Date(req.scheduledFor);
    if (isNaN(runAt.getTime())) {
      return { success: false, error: "Invalid scheduledFor timestamp" };
    }
    const job = await scheduleOneShot(runAt, {
      profile: req.profile,
      params: { prompt: req.prompt, ...req.context },
      description: req.description,
      notificationChannel: req.notificationChannel,
      notificationRecipient: req.notificationRecipient,
      trustTier: req.trustTier,
    });
    return { success: true, scheduled: true, jobId: job.id, nextRun: new Date(job.nextRun).toISOString() };
  }

  const traceId = createTraceId();
  await createTrace(traceId, {
    trigger: "control",
    profile: req.profile,
  });

  const launcher = getLauncher();
  const result = await launcher.launch({
    profile: req.profile,
    // An immediate run through the control API is owner-initiated from the
    // portal (the endpoint is network-gated to localhost/tailnet), so it runs
    // as the selected team owner.
    identity: toRunIdentity(portalIdentity(portalOwner)),
    prompt: req.prompt ?? "Run.",
    context: {
      currentTime: currentTimePST(),
      ...req.context,
    },
    additionalEnv: { CADDIE_TRACE_ID: traceId },
  });

  await completeTrace(traceId, {
    success: result.success,
    error: result.error,
  });

  return {
    success: result.success,
    rawText: result.rawText,
    error: result.error,
  };
}

async function executeSchedule(req: ControlRequest): Promise<Record<string, unknown>> {
  // Delete a job
  if (req.jobId && !req.cron) {
    await deleteJob(req.jobId);
    return { success: true, deleted: req.jobId };
  }

  // Create a recurring job
  if (!req.cron) {
    return { success: false, error: "cron expression is required for schedule action" };
  }

  const isCommand = req.type === "command";

  // Validate a command spec up front rather than letting it fail on every tick.
  // Throws with a message naming the offending field.
  if (isCommand) {
    try {
      parseCommandSpec(commandParams(req), workspace);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const jobId = req.jobId ?? `recurring:${req.profile ?? "default"}:${req.cron.replace(/\s+/g, "_")}`;
  try {
    const job = await scheduleRecurring(jobId, req.cron, {
      action: isCommand ? "command" : undefined,
      profile: req.profile,
      params: isCommand
        ? { ...commandParams(req), ...req.context }
        : { prompt: req.prompt, ...req.context },
      description: req.description,
      notificationChannel: req.notificationChannel,
      notificationRecipient: req.notificationRecipient,
      trustTier: req.trustTier,
    });
    return {
      success: true,
      jobId: job.id,
      action: job.action ?? "run",
      cron: job.cron,
      nextRun: new Date(job.nextRun).toISOString(),
      description: job.description,
    };
  } catch (err) {
    return { success: false, error: `Invalid cron expression: ${err instanceof Error ? err.message : err}` };
  }
}

/** The command-job half of a control request, as stored in `job.params`. */
function commandParams(req: ControlRequest): Record<string, unknown> {
  return {
    command: req.command,
    prompt: req.prompt,
    cwd: req.cwd,
    onOutput: req.onOutput,
    commandTimeoutMs: req.commandTimeoutMs,
    commandEnv: req.commandEnv,
  };
}

async function executeUpdateSchedule(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!req.jobId) {
    return { success: false, error: "jobId is required for update_schedule" };
  }

  const existing = await getJob(req.jobId);
  if (!existing) {
    return { success: false, error: `Job not found: ${req.jobId}` };
  }

  // Merge provided fields into the existing job
  if (req.cron !== undefined) {
    const { CronExpressionParser } = await import("cron-parser");
    try {
      const interval = CronExpressionParser.parse(req.cron, { currentDate: new Date() });
      existing.cron = req.cron;
      existing.nextRun = interval.next().getTime();
    } catch (err) {
      return { success: false, error: `Invalid cron expression: ${err instanceof Error ? err.message : err}` };
    }
  }
  if (req.prompt !== undefined) {
    existing.params = { ...existing.params, prompt: req.prompt };
  }
  // Command-job fields. Merged individually so a partial update leaves the rest
  // of the spec alone, then revalidated as a whole — an edit that would break
  // the job is rejected here rather than failing on every future tick.
  if (existing.action === "command") {
    for (const key of ["command", "cwd", "onOutput", "commandTimeoutMs", "commandEnv"] as const) {
      if (req[key] !== undefined) {
        existing.params = { ...existing.params, [key]: req[key] };
      }
    }
    try {
      parseCommandSpec(existing.params, workspace);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else if (req.command !== undefined) {
    return {
      success: false,
      error: `Job ${existing.id} is not a command job — its action is "${existing.action ?? "run"}"`,
    };
  }
  if (req.description !== undefined) {
    existing.description = req.description;
  }
  if (req.profile !== undefined) {
    existing.profile = req.profile;
  }
  if (req.notificationChannel !== undefined) {
    existing.notificationChannel = req.notificationChannel;
  }
  if (req.notificationRecipient !== undefined) {
    existing.notificationRecipient = req.notificationRecipient;
  }
  if (req.trustTier !== undefined) {
    existing.trustTier = req.trustTier;
  }

  await upsertJob(existing);

  return {
    success: true,
    jobId: existing.id,
    action: existing.action ?? "run",
    cron: existing.cron,
    nextRun: new Date(existing.nextRun).toISOString(),
    description: existing.description,
  };
}

// --- Route handler ---

export async function POST(request: NextRequest) {
  const req = (await request.json()) as ControlRequest;

  if (!req.action) {
    return NextResponse.json(
      { success: false, error: "action is required (notify | email_team | reply | run | schedule | update_schedule | trigger | list_slack_channels | purge | rag_rebuild)" },
      { status: 400 }
    );
  }

  const portalOwner = parsePortalOwner(request.cookies.get("portal_owner")?.value);

  try {
    const result = await executeAction(req, portalOwner);
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Control] Action failed:", error);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}

export async function GET() {
  try {
    const jobs = await listJobs();
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json({ jobs: [], error: String(err) });
  }
}
