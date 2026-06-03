/**
 * AgentMail Setup
 *
 * One-time provisioning for the AgentMail email integration.
 * Creates (or fetches by clientId) an inbox and registers the inbound webhook.
 * Prints the values to copy into northstar/.env.local.
 *
 * Usage:
 *   AGENTMAIL_API_KEY=... AGENTMAIL_WEBHOOK_URL=https://your-host/api/email/webhook \
 *     npx tsx harness/scripts/agentmail-setup.ts
 *
 * Optional env:
 *   AGENTMAIL_INBOX_CLIENT_ID  — idempotency key for the inbox (default "agints-primary")
 *   AGENTMAIL_INBOX_USERNAME   — desired local-part of the inbox address
 *   AGENTMAIL_INBOX_DOMAIN     — custom verified domain (omit to use agentmail.to)
 */

import { AgentMailClient } from "agentmail";

async function main() {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  const webhookUrl = process.env.AGENTMAIL_WEBHOOK_URL;
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY is required");
  if (!webhookUrl) throw new Error("AGENTMAIL_WEBHOOK_URL is required");

  const client = new AgentMailClient({ apiKey });

  const inbox = await client.inboxes.create({
    clientId: process.env.AGENTMAIL_INBOX_CLIENT_ID ?? "agints-primary",
    username: process.env.AGENTMAIL_INBOX_USERNAME,
    domain: process.env.AGENTMAIL_INBOX_DOMAIN,
  });
  // The SDK returns the inbox address as inboxId.
  const inboxId = (inbox as { inboxId?: string }).inboxId;
  console.log(`Inbox ready: ${inboxId}`);

  const webhook = await client.webhooks.create({
    url: webhookUrl,
    events: ["message.received"],
  });
  const webhookId = (webhook as { webhookId?: string }).webhookId;
  const detail = await client.webhooks.get(webhookId!);
  const secret = (detail as { secret?: string }).secret;

  console.log("\n--- copy into northstar/.env.local ---");
  console.log(`AGENTMAIL_INBOX_ID=${inboxId}`);
  console.log(`AGENTMAIL_WEBHOOK_SECRET=${secret}`);
  console.log("--------------------------------------\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
