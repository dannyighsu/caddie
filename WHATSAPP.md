# WhatsApp Setup

Two connection modes are supported. Use one or both.

| | Baileys (personal) | Cloud API (business) |
|---|---|---|
| Account type | Your personal WhatsApp | Meta Business account + dedicated number |
| Setup | Scan QR code | Configure webhook + env vars |
| Bot identity | Operates as you | Has its own phone number |
| Groups | Yes (via @mention) | No (DMs only) |
| Stability | Unofficial, can break | Official Meta API |

If both are configured, outbound messages prefer Cloud API. Inbound messages work independently on each.

---

## Option A: Baileys (WhatsApp Web protocol)

No Meta Business account needed — just scan a QR code. The bot operates as a linked device on your personal WhatsApp account.

### 1. Add to `northstar/.env.local`

```bash
WHATSAPP_BOT_NAME=Buri          # optional, for @mention detection in groups
```

### 2. Start and scan

```bash
make run
```

A QR code prints in the terminal. On your phone: **WhatsApp > Settings > Linked Devices > Link a Device** > scan it. You'll see `[Baileys] Connected to WhatsApp` in the logs.

Auth is saved to `.baileys-auth/` so you only scan once.

### Behavior

- **DMs** — every message triggers the agent
- **Groups** — only @mentions of `WHATSAPP_BOT_NAME` trigger it; other messages are stored for context

### Troubleshooting

| Problem | Fix |
|---------|-----|
| No QR code | Ensure the app is running (`make run`) |
| `Logged out` error | Delete `.baileys-auth/` and restart |
| Disconnects | Phone must stay online; WhatsApp unlinks after ~14 days offline |
| No response in groups | Set `WHATSAPP_BOT_NAME` and @mention it |

### Caveats

Baileys is unofficial/reverse-engineered — WhatsApp could break it or ban accounts with spammy behavior. Best for personal/small-team use.

---

## Option B: Cloud API (Meta WhatsApp Business)

Official Meta API. The bot has its own phone number — users message it directly.

### 1. Meta setup

1. Go to [Meta for Developers](https://developers.facebook.com/) and create an app (type: Business)
2. Add the **WhatsApp** product
3. In WhatsApp > API Setup, note your **Phone Number ID** and generate a **permanent access token**
4. Add a phone number (or use the test number provided)

### 2. Add to `northstar/.env.local`

```bash
WHATSAPP_ACCESS_TOKEN=EAAx...     # permanent access token
WHATSAPP_PHONE_NUMBER_ID=123...   # from API Setup page
WHATSAPP_APP_SECRET=abc...        # App Settings > Basic > App Secret
WHATSAPP_VERIFY_TOKEN=any-string  # you choose this, used during webhook setup
```

### 3. Configure webhook

In Meta dashboard > WhatsApp > Configuration:

- **Callback URL:** `https://your-domain.com/api/whatsapp/webhook`
- **Verify token:** same value as `WHATSAPP_VERIFY_TOKEN`
- **Subscribe to:** `messages`

For local development, use ngrok or similar to expose `localhost:3000`.

### Behavior

- Every DM to the business number triggers the agent
- Bot replies come from the business number

---

## Sending messages (both modes)

```bash
curl -X POST localhost:3000/api/gateway \
  -H 'Content-Type: application/json' \
  -d '{"action":"notify","channel":"whatsapp","to":"12125551234","message":"Hello"}'
```

Phone number in international format, no `+`. Set a default via `/api/settings/whatsapp`.

If both Cloud API and Baileys are configured, outbound messages use Cloud API.
