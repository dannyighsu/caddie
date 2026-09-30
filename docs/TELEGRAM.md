# Telegram Setup

Connect your agent to Telegram via the official Bot API. No extra phone number needed — the bot has its own identity, and you just message it from any Telegram account.

## 1. Create a bot with @BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts (choose a name and a username ending in `bot`)
3. Save the **bot token** BotFather gives you (looks like `123456:ABC-DEF1234...`)

Optionally, tune the bot:
- `/setprivacy` → **Disable** if you want the bot to read all group messages (needed to detect @mentions in groups). With privacy enabled, the bot only receives commands and direct replies.
- `/setdescription`, `/setuserpic`, etc.

## 2. Add to `portal/.env.local`

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234...    # from BotFather
TELEGRAM_BOT_USERNAME=your_bot              # without the @ — used for @mention detection in groups
TELEGRAM_WEBHOOK_SECRET=some-random-string  # optional, but recommended in production
```

## 3. Register the webhook

Telegram is webhook-based — you tell their servers where to POST updates. Make sure Ignis is reachable publicly (via Tailscale Funnel, ngrok, etc.), then register:

```bash
curl -F "url=https://your-domain.com/api/telegram/webhook" \
     -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
     "https://api.telegram.org/bot<TOKEN>/setWebhook"
```

Verify it registered:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

To remove the webhook later:

```bash
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

## 4. Find your chat ID (for default outbound recipient)

Start a conversation with your bot on Telegram, send any message, then:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Look for `message.chat.id` in the response — that's your chat ID.

Set it as the default recipient for outbound notifications:

```bash
curl -X POST localhost:3000/api/settings/telegram \
  -H 'Content-Type: application/json' \
  -d '{"defaultRecipient":"123456789"}'
```

## Behavior

- **DMs** (private chats) — every message triggers the agent
- **Groups / supergroups** — only messages mentioning `@TELEGRAM_BOT_USERNAME` trigger the agent; other messages are stored for context in active conversations
- The bot replies inline (as a reply to the user's message)

## Sending messages

```bash
curl -X POST localhost:3000/api/control \
  -H 'Content-Type: application/json' \
  -d '{"action":"notify","channel":"telegram","to":"123456789","message":"Hello"}'
```

Omit `to` to use the configured default recipient.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Webhook returns 401 | `TELEGRAM_WEBHOOK_SECRET` mismatch — check `.env.local` matches what you registered |
| Webhook returns 503 | `TELEGRAM_BOT_TOKEN` missing from environment |
| Bot doesn't respond in groups | Either disable privacy mode (`/setprivacy` with BotFather) or make sure `TELEGRAM_BOT_USERNAME` is set and users @mention it |
| Not receiving updates | Check `getWebhookInfo` — look at `last_error_date` and `last_error_message` |
