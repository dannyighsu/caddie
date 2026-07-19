# Permissions

One file decides what every agent run may do: **`harness/permissions.json`**.

It's a grid of `trust tier → permission key → allowed`:

```json
{
  "household": { "notion": true,  ..., "base-tools": true  },
  "guest":     { "notion": false, ..., "base-tools": false }
}
```

- **Permission keys** are every capability name (see `harness/capabilities/`) plus
  the synthetic **`base-tools`** key, which governs the built-in Claude Code
  tools (Bash, Read, Write, Edit, WebFetch, …).
- **Default-deny.** Anything not explicitly `true` is denied — so a new
  capability is off for everyone until you grant it here, and `guest`, which
  grants nothing, gets nothing.

## How it's enforced

At launch (`harness/src/agent/launcher.ts`), the run's trust tier is resolved
(from the sender's identity, or `household` for scheduled/owner runs) and the
policy is applied in two places:

1. **MCP capabilities** — the agent's declared `capabilities` are filtered to the
   ones granted for the tier (`filterCapabilitiesByPolicy`). Denied capabilities
   are never mounted. So what a run actually gets = *agent's capabilities ∩
   policy grants for the tier*.
2. **Built-in tools** — if `base-tools` is not granted, the runtime launches with
   `--tools ""`, which disables **all** built-in tools. MCP tools are unaffected
   (they're governed by #1).

The policy is the single source of truth: capability JSONs no longer carry a
`trust` field.

## Where trust comes from — the run identity

`launcher.launch()` takes a **required** `identity` object that bundles the three
origin facts so they always travel together (you can't set one without the
others):

```ts
identity: { trustTier, senderIdentity, originChannel }
```

Each entry point builds it:

- **Channels** (`messaging.ts`) — from the resolved sender: verified household
  member → `household`; unverified → `guest`.
- **Portal** (`/api/agents/[id]/run`, `/api/control` immediate run) — always
  `household`, attributed to the household member picked in the header's *Acting
  as* selector (persisted in the `portal_owner` cookie; both options are
  household-trust, so it's attribution only). The portal is gated to
  localhost/tailnet, so its runs are owner-initiated by definition.
- **Scheduled / triggered runs** (`scheduler.ts`) — `household` (the household's
  own automations), sender "Automated run".

`senderIdentity` and `originChannel` are rendered into the persona
(`{{senderIdentity}}`, `{{originChannel}}`); `trustTier` drives this policy.

## Current defaults

| Tier | Capabilities | Built-in tools |
|---|---|---|
| **household** | all granted | on |
| **guest** | **none** | **off** |

A guest run is therefore conversational only — no MCP capabilities and no Bash /
Read / Write / etc. This also closes the guest→schedule escalation: with no Bash
there's no `curl` to `/api/control`, and with `egress` denied the scheduling
tools aren't mounted either.

## Changing permissions

Edit `harness/permissions.json` and restart the control plane. To grant a guest
a capability, set its key to `true` under `guest`.

> **Note — `base-tools` is a superset.** Bash can reach anything on the box
> (the control API, the browser profile, other capabilities' credentials). So
> granting a tier `base-tools` effectively grants it everything, regardless of
> the other toggles. That's fine for `household`; just don't expect
> "base-tools on + egress off" to actually contain a tier.

## Related

- [BACKEND.md](./BACKEND.md) — the API server's client classes and endpoint groups
- `harness/src/policy/permissions.ts` — the loader + default-deny logic
