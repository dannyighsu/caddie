# Email Setup

Buri sends and receives email through its own **Gmail account** via the Gmail API.
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

In `northstar/.env.local` (already present for Calendar):

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# Optional:
# GMAIL_ADDRESS=you@yourdomain.com   # else read from the account profile
# GMAIL_POLL_INTERVAL_MS=60000       # inbound poll cadence (default 60s)
# GOOGLE_TOKENS_FILE=...             # override the shared token path
```

Household identity for the auth gate:

```bash
DANNY_EMAIL=...
BETTY_EMAIL=...
```

## How it works

**Inbound** (`northstar/lib/gmail/poller.ts`)
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
   header (spf/dkim/dmarc must pass) → `household` or `guest`.

**Outbound** (`northstar/lib/gmail/transport.ts`)
- `send_email` / `reply` route through the control API → `sendEmail` /
  `replyToEmail`. Replies resolve the thread, reconstruct recipients (reply-all
  rebuilds To+Cc minus self), set `In-Reply-To`/`References`, and send within the
  Gmail thread.

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Gmail API has not been used in project … or it is disabled` | Enable the Gmail API in the Cloud project (step 1). |
| Sends fail with insufficient permission | Token lacks `gmail.modify` — re-run `make google-auth`. |
| No inbound picked up | Confirm the poller started (server logs `[Gmail Poller] Started`) and messages are actually `INBOX`+`UNREAD`. |
| Wrong sender identity / everyone is guest | Check `DANNY_EMAIL`/`BETTY_EMAIL` and that inbound carries a passing `Authentication-Results` header. |
