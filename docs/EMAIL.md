# Email Setup

Send and receive via [Resend](https://resend.com). No IMAP, no Gmail — just DNS records on a subdomain and a webhook.

## 1. Resend setup

1. Sign up at [resend.com](https://resend.com)
2. Add a domain (e.g. `mail.agints.io`) and add the DNS records Resend gives you (MX, SPF, DKIM)
3. In the Resend dashboard, grab your **API key**

## 2. Webhook setup

1. In Resend dashboard > Webhooks, create a new webhook
2. **Endpoint URL:** `https://your-domain.com/api/email/webhook`
3. **Events:** select `email.received`
4. Copy the **signing secret**

For local development, use ngrok or similar to expose `localhost:3000`.

## 3. Add to `northstar/.env.local`

```bash
RESEND_API_KEY=re_xxxxx
RESEND_WEBHOOK_SECRET=whsec_xxxxx    # from webhook setup
EMAIL_FROM=Buri <buri@mail.agints.io> # must match verified Resend domain
```

## How it works

1. Someone emails `buri@mail.agints.io`
2. Resend receives it (MX records point to Resend)
3. Resend POSTs a webhook event to `/api/email/webhook`
4. We fetch the full email body via Resend API
5. Quoted reply text is stripped — agent only sees the latest message
6. Agent responds, reply is sent via Resend with proper threading headers

## Behavior

- Conversations are threaded by sender email address
- Replies include `In-Reply-To` and `References` headers so email clients thread correctly
- Emails from `EMAIL_FROM` are ignored (no loops)
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
| No emails received | Check MX records on your subdomain, verify webhook URL is reachable |
| Webhook 401 | Check `RESEND_WEBHOOK_SECRET` matches the Resend dashboard |
| Replies not threading | Ensure `EMAIL_FROM` is on the verified domain |
| Sends fail | Verify domain in Resend, check DNS propagation |
