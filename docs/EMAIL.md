# Email Setup

The agent sends and receives email through its own **Gmail account** via the Gmail API.
Outbound goes through `gmail.users.messages.send`; inbound is pulled by an
in-process poller (no webhook). Auth reuses the same Google OAuth token as Google
Calendar.

## 1. Google Cloud + OAuth

Email rides the same OAuth client and token file as Calendar (see the Calendar
setup / `make google-auth`). Two things are specific to email:

1. **Enable the Gmail API** in the Cloud project behind your OAuth client
   (console → APIs & Services → Enable APIs → "Gmail API"), or:
   ```bash
   gcloud services enable gmail.googleapis.com --project=<your-project>
   ```
2. **Authorize the `gmail.modify` scope.** `harness/scripts/google-auth.ts`
   requests `calendar` + `gmail.modify` (modify covers read, send, and marking
   messages read). Re-run the consent flow so the token carries it:
   ```bash
   make google-auth
   ```

The token is written to `harness/credentials/google-calendar-tokens.json` and is
shared by Calendar, the Gmail MCP, and the email transport.

## 2. Environment

In `portal/.env.local` (already present for Calendar):

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# Optional:
# GMAIL_ADDRESS=you@yourdomain.com   # else read from the account profile
# GMAIL_POLL_INTERVAL_MS=60000       # inbound poll cadence (default 60s)
# GOOGLE_TOKENS_FILE=...             # override the shared token path
# EMAIL_MIN_IMAGE_BYTES=8192         # below this an inbound image is chrome, not content
# EMAIL_MAX_IMAGE_BYTES=10485760     # skip anything larger (bounds the workspace)
# EMAIL_MAX_IMAGES=5                 # per message, largest first
```

Team identity for the auth gate — the roster (see `portal/.env.example`):

```bash
TEAM_MEMBER_A_NAME=...
TEAM_MEMBER_A_EMAIL=...        # comma-separated; first is primary
# TEAM_MEMBER_B_NAME=...
# TEAM_MEMBER_B_EMAIL=...
```

## How it works

**Inbound** (`portal/lib/gmail/poller.ts`)
1. Every `GMAIL_POLL_INTERVAL_MS` the poller lists `label:INBOX label:UNREAD` —
   the mailbox's own UNREAD state is the queue.
2. Each message is fetched, parsed into a `ReceivedEmail`, and dispatched to the
   shared handler. It's marked read **only after** successful dispatch, so a
   failure just leaves it UNREAD to retry next tick.
3. Two bodies are computed locally: `fullText` (quoted history intact) and
   `extractedText` (quote-stripped via `email-reply-parser`). `email-threading`
   decides which the agent sees (stripped normally; full for forwards / gaps /
   loop-ins).
4. Identity is resolved from the `From` address + the `Authentication-Results`
   header (spf/dkim/dmarc must pass) → `team` or `guest`.
5. Attached and inline images are selected, downloaded, and passed to the agent
   (see **Inbound images** below).

**Outbound** (`portal/lib/gmail/transport.ts`)
- `send_email` / `reply` route through the control API → `sendEmail` /
  `replyToEmail`. Replies resolve the thread, reconstruct recipients (reply-all
  rebuilds To+Cc minus self), set `In-Reply-To`/`References`, and send within the
  Gmail thread.

**Inbound images**
- Selection is metadata-only and happens at parse time
  (`portal/lib/gmail/parts.ts`), so a message that gets skipped never costs a
  fetch. Bytes are downloaded only once the message is going to the agent.
- What survives: viewable raster images (SVG excluded — it's markup, not a
  viewable image) between `EMAIL_MIN_IMAGE_BYTES` and `EMAIL_MAX_IMAGE_BYTES`,
  capped at `EMAIL_MAX_IMAGES` per message (largest kept, in message order). The
  size floor is what keeps tracking pixels, signature logos, and marketing-mail
  scaffolding out; a 1×1 pixel is ~43 bytes.
- Inline and attached images are treated alike — a screenshot pasted into Gmail
  arrives inline with a `cid:`, and is exactly what someone means by "see the
  image" — so size, not disposition, does the filtering.
- Files land in the thread's run-artifacts directory
  (`~/.ignis/runs/<month>/<day>/artifacts/email-<threadId>/`), named
  `<messageId>-<sanitized name>` so two messages on one thread can't clobber each
  other. The agent gets each one as a path it reads to view the image — the same
  channel-agnostic `Attachment` path Telegram uses.
- The stored message text carries an `[attachment:<fileName>]` marker per image;
  that's how the messaging layer matches images to turns when the thread is
  re-read later. Artifacts are dated per run, so a marker from an earlier day is
  simply omitted rather than resolved.
- An **image-only email** (a forwarded screenshot, a photo with no caption) is
  now dispatched rather than dropped as an empty body.
- Images referenced by remote URL in an HTML body are deliberately **not**
  fetched: those are the tracking-beacon vector, and retrieving one tells the
  sender the mail was opened.

**HTML formatting**
- `send_email` and `email_team` accept an `html` body in place of `message`.
  The send becomes a `multipart/alternative`: the HTML as given, plus a
  plain-text alternative derived from it by `htmlToText`
  (`portal/lib/gmail/html-text.ts`), which keeps link URLs (`text (url)`) and
  list bullets so text-only clients lose nothing. That same derived text — never
  the markup — is what gets stored as conversation history.
- Supply `message`, `html`, or both. With both, each is used verbatim; with only
  `html`, the plain part is derived. A `from` attribution is prefixed onto both.
- Agent-written HTML must be a body fragment (no `<html>`/`<head>`/`<body>`) and
  must carry all styling in inline `style=` attributes — mail clients strip
  `<style>` blocks. This is stated in the tool schemas and the persona.
- **Not** supported on: `reply` (channel-agnostic — the same tool serves Slack
  and Telegram, so HTML there would leak tags into the wrong channel), and
  deferred `scheduledFor` notifications (the job payload carries a plain body
  only; an `html` field on a scheduled notify is dropped, and the plain part is
  derived from it up front).

## Behavior

- Conversations are keyed by Gmail's `threadId` — different threads from the same
  sender stay separate.
- Emails from the account's own address are ignored (no loops).
- Promotional / marketing mail is never replied to (see the persona).

## Sending via the control API

```bash
curl -X POST localhost:3000/api/control \
  -H 'Content-Type: application/json' \
  -d '{"action":"notify","channel":"email","to":"user@example.com","subject":"Hello","message":"Hi there"}'
```

With an HTML body (the plain-text alternative is derived automatically):

```bash
curl -X POST localhost:3000/api/control \
  -H 'Content-Type: application/json' \
  -d '{"action":"notify","channel":"email","to":"user@example.com","subject":"Hello",
       "html":"<p>Hi there — <a href=\"https://example.com\">the doc</a>.</p>"}'
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Gmail API has not been used in project … or it is disabled` | Enable the Gmail API in the Cloud project (step 1). |
| Sends fail with insufficient permission | Token lacks `gmail.modify` — re-run `make google-auth`. |
| No inbound picked up | Confirm the poller started (server logs `[Gmail Poller] Started`) and messages are actually `INBOX`+`UNREAD`. |
| Inbound image never reaches the agent | Likely under `EMAIL_MIN_IMAGE_BYTES` (8KB default) or past the 5-image cap; check the `[Email Attachments]` logs. |
| Wrong sender identity / everyone is guest | Check the sender's address is on the `TEAM_MEMBER_*_EMAIL` roster and that inbound carries a passing `Authentication-Results` header. |
