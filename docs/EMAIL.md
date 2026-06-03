# Email Setup

Send and receive via [AgentMail](https://agentmail.to). Each agent gets a real inbox; replies thread automatically.

## 1. AgentMail account

1. Sign up at [agentmail.to](https://agentmail.to) and grab your API key
2. (Optional) Attach a custom domain in the dashboard if you want a branded sender — otherwise inboxes live on `@agentmail.to`

## 2. Provision the inbox + webhook

For local development, expose `localhost:3000` with ngrok first.

```bash
AGENTMAIL_API_KEY=... \
AGENTMAIL_WEBHOOK_URL=https://your-host/api/email/webhook \
  npx tsx harness/scripts/agentmail-setup.ts
```

The script creates (or fetches by `clientId`) the inbox and registers the webhook for `message.received`, then prints the values for the next step.

Optional env vars: `AGENTMAIL_INBOX_USERNAME`, `AGENTMAIL_INBOX_DOMAIN`, `AGENTMAIL_INBOX_CLIENT_ID` (default `agints-primary`).

## 3. Add to `northstar/.env.local`

```bash
AGENTMAIL_API_KEY=...
AGENTMAIL_INBOX_ID=agent@agentmail.to     # printed by the setup script
AGENTMAIL_WEBHOOK_SECRET=whsec_xxxxx      # printed by the setup script
```

## How it works

1. Someone emails the inbox address
2. AgentMail POSTs a `message.received` webhook to `/api/email/webhook` with the full message inline
3. We verify the Svix signature, then hand the message to the messaging handler
4. `extractedText` (quoted history already stripped) is what the agent sees
5. Agent replies via `messages.reply(inboxId, messageId, …)` — AgentMail preserves threading

## Behavior

- Conversations are keyed by AgentMail's `threadId`, so two unrelated threads from the same sender are separate conversations
- Emails from the inbox's own address are ignored (no loops)
- No routing confirmation emails are sent (too noisy)

## Sending via gateway

```bash
curl -X POST localhost:3000/api/gateway \
  -H 'Content-Type: application/json' \
  -d '{"action":"notify","channel":"email","to":"user@example.com","subject":"Hello","message":"Hi there"}'
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No emails received | Check the webhook URL is publicly reachable and registered for `message.received` |
| Webhook 401 | `AGENTMAIL_WEBHOOK_SECRET` must match the secret from `client.webhooks.get(webhookId).secret` |
| Sends fail | Confirm `AGENTMAIL_INBOX_ID` matches an existing inbox under your API key |
