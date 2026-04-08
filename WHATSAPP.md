# WhatsApp Setup

Uses [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web protocol). No Meta Business account or webhook URL needed — just scan a QR code.

## 1. Add to `northstar/.env.local`

```bash
WHATSAPP_BAILEYS=true
WHATSAPP_BOT_NAME=Buri          # optional, for @mention detection in groups
```

## 2. Start and scan

```bash
make run
```

A QR code prints in the terminal. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device** → scan it. You'll see `[Baileys] Connected to WhatsApp` in the logs.

Auth is saved to `.baileys-auth/` so you only scan once.

## Behavior

- **DMs** — every message triggers the agent
- **Groups** — only @mentions of `WHATSAPP_BOT_NAME` trigger it; other messages are stored for context

## Sending messages

```bash
curl -X POST localhost:3000/api/gateway \
  -H 'Content-Type: application/json' \
  -d '{"action":"notify","channel":"whatsapp","to":"12125551234","message":"Hello"}'
```

Phone number in international format, no `+`. Set a default via `/api/settings/whatsapp`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No QR code | Check `WHATSAPP_BAILEYS=true` is set |
| `Logged out` error | Delete `.baileys-auth/` and restart |
| Disconnects | Phone must stay online; WhatsApp unlinks after ~14 days offline |
| No response in groups | Set `WHATSAPP_BOT_NAME` and @mention it |

## Caveats

Baileys is unofficial/reverse-engineered — WhatsApp could break it or ban accounts with spammy behavior. Best for personal/small-team use.
