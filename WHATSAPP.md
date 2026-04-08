# WhatsApp Setup (Baileys)

Connect your agent to WhatsApp using [Baileys](https://github.com/WhiskeySockets/Baileys) — a library that speaks the WhatsApp Web multi-device protocol directly. No Meta Business account, webhook URL, or Cloud API tokens needed. Works like Slack Socket Mode: outbound connection from your server, scan a QR code, done.

## Prerequisites

- A personal WhatsApp account (the one on your phone)
- Northstar running (`make run`)

## Setup

### 1. Set environment variables

Add to `northstar/.env.local`:

```bash
WHATSAPP_BAILEYS=true

# Optional: bot display name for @mention detection in group chats
WHATSAPP_BOT_NAME=Buri

# Optional: custom path for auth state persistence (default: .baileys-auth in project root)
# WHATSAPP_BAILEYS_AUTH_DIR=/path/to/auth
```

### 2. Start Northstar

```bash
make run
```

On first startup, a QR code will print in the terminal.

### 3. Link your phone

Open WhatsApp on your phone:
1. Go to **Settings** (or tap the three dots menu)
2. Tap **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code in your terminal

You should see `[Baileys] Connected to WhatsApp` in the server logs.

### 4. Done

Your agent now receives WhatsApp messages. Auth credentials are saved locally (default: `.baileys-auth/` in the project root) so you won't need to scan again unless you log out or delete the auth folder.

## How it works

**DMs:** Every message triggers the agent — no @mention needed.

**Group chats:** Only messages that @mention the bot (by `WHATSAPP_BOT_NAME` or phone number) trigger the agent. Other messages in active group chats are stored for conversation context (last 20 messages).

**Outbound notifications** via the gateway:

```bash
curl -X POST localhost:3000/api/gateway \
  -H 'Content-Type: application/json' \
  -d '{"action":"notify","channel":"whatsapp","to":"12125551234","message":"Hello from the agent"}'
```

The `to` field is the recipient's phone number in international format (no `+` prefix). You can also set a default recipient via `/api/settings/whatsapp`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| QR code doesn't appear | Make sure `WHATSAPP_BAILEYS=true` is set and Northstar is running |
| `Logged out` error | Delete the `.baileys-auth/` folder and restart to re-scan |
| Disconnects frequently | Your phone must stay connected to the internet. WhatsApp unlinks devices if the phone is offline for ~14 days |
| Bot doesn't respond in groups | Set `WHATSAPP_BOT_NAME` and @mention it, or message it in a DM |
| Messages not arriving | Check server logs for `[Baileys]` entries. Ensure the phone didn't unlink the device |

## Caveats

- **Unofficial protocol.** Baileys reverse-engineers WhatsApp Web. WhatsApp/Meta could break it or ban accounts. Avoid spammy behavior.
- **Phone must stay online.** The linked device session requires the primary phone to be connected.
- **Not for high-scale.** This is best for personal/small-team use. For business-scale messaging, use the official WhatsApp Business API instead.
