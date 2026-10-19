# Permissions

One file decides what every agent run may do: **`harness/permissions.json`**.

It's a grid of `trust tier → permission key → allowed`:

```json
{
  "team": { "notion": true,  ..., "base-tools": true  },
  "guest":     { "notion": false, ..., "base-tools": false }
}
```

- **Permission keys** are every capability name (see `harness/capabilities/`) plus
  the synthetic **`base-tools`** key, which governs the built-in Claude Code
  tools (Bash, Read, Write, Edit, WebFetch, …).
- **Default-deny.** Anything not explicitly `true` is denied — so a new
  capability is off for everyone until you grant it here, and `guest` gets
  only what's explicitly granted to it.

## How it's enforced

At launch (`harness/src/agent/launcher.ts`), the run's trust tier is resolved
(from the sender's identity, or `team` for scheduled/owner runs) and the
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

- **Channels** (`messaging.ts`) — from the resolved sender: verified team
  member → `team`; unverified → `guest`.
- **Portal** (`/api/agent/run`, `/api/control` immediate run) — always
  `team`, attributed to the team member picked in the header's *Acting
  as* selector (persisted in the `portal_owner` cookie; both options are
  team-trust, so it's attribution only). The portal is gated to
  localhost/tailnet, so its runs are owner-initiated by definition.
- **Scheduled / triggered runs** (`scheduler.ts`) — `team` (the team's
  own automations), sender "Automated run".

`senderIdentity` and `originChannel` are rendered into the system prompt
(`{{senderIdentity}}`, `{{originChannel}}`); `trustTier` drives this policy.

## Current defaults

| Tier | Capabilities | Built-in tools |
|---|---|---|
| **team** | all granted | on |
| **guest** | `reply`, `email-team`, `purge` only | **off** |

A guest run is therefore conversational only — no Bash / Read / Write / etc.,
and only the minimal-privilege tools whose reach the harness fixes: `reply`
(the current thread), `email_team` (the team), and `purge_content` (the
message being handled; see `portal/lib/purge.ts`). This also closes the
guest→schedule escalation: with no Bash there's no `curl` to `/api/control`, and with `egress` denied the scheduling
tools aren't mounted either.

## Changing permissions

Edit `harness/permissions.json` and restart the control plane. To grant a guest
a capability, set its key to `true` under `guest`.

> **Note — `base-tools` is a superset.** Bash can reach anything on the box
> (the control API, the browser profile, other capabilities' credentials). So
> granting a tier `base-tools` effectively grants it everything, regardless of
> the other toggles. That's fine for `team`; just don't expect
> "base-tools on + egress off" to actually contain a tier.

## The agent's environment

The agent's process doesn't inherit the portal's environment wholesale. The
runtime passes an allowlist (`AGENT_ENV_NAMES` in
`harness/src/runtime/claude-code.ts`): OS basics, proxies, `PORTAL_URL`,
`GOG_ACCOUNT`, and `ANTHROPIC_*` and `CLAUDE_*`. The Postgres and Redis URLs,
bot tokens and API keys stay with the portal, so a team run with Bash can't
reach the database. That matters most for the team roster: being on it is what
grants the team tier, and it lives in Postgres. Capability servers get their
secrets through `${VAR}` substitution in their JSON, not by inheritance, so
they're unaffected. If something the agent runs needs another variable, add it
to the allowlist. Don't add a secret the portal holds for itself.

## Related

- [BACKEND.md](./BACKEND.md) — the API server's client classes and endpoint groups
- `harness/src/policy/permissions.ts` — the loader + default-deny logic
