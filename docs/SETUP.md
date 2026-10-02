# Setting up an install

How to stand up an Ignis install on a fresh machine, in order. Written so that a
coding agent can follow it end to end; the steps that need a person — a browser
sign-in, an admin console — say so.

An install is one machine running one agent. Everything that makes it *this*
agent rather than another lives outside git: `portal/.env.local`,
`harness/agent/PERSONA.md`, `harness/credentials/`, and the workspace at
`~/.ignis/`. Two installs share the repo and nothing else.

The steps assume macOS with [Homebrew](https://brew.sh). Each one is
idempotent.

## 1. Host tools

```bash
brew install node tmux          # Node 22+; tmux keeps `make run` alive after the terminal closes
corepack enable                 # pnpm at the version package.json pins
pnpm install
make agent-tools                # poppler + a Python venv with pypdf, so the agent can read PDFs
```

**The `claude` CLI** is the runtime: every agent run is a `claude -p`
subprocess. Install it and sign in once, interactively — a person has to do
this, since it opens a browser:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude        # then /login; the account you sign in with is billed for every run
```

**Bun** is optional. Only the `notion` and `web-search` capabilities need it
(they launch their MCP servers with `bunx`); without it those two sit out.

```bash
curl -fsSL https://bun.sh/install | bash
```

The agent runs directly on this machine, not in a container, so any
command-line tool it reaches for from Bash has to be installed here.

## 2. Postgres and Redis

Postgres holds conversations, settings and the run ledger; Redis holds the
schedule queue and run locks. Both run as Homebrew services, which start at
login.

```bash
brew install postgresql@17 redis
brew services start postgresql@17
brew services start redis
createdb ignis
```

Homebrew's Postgres trusts local connections from your macOS user, so the URLs
need no password:

```bash
POSTGRES_URL=postgresql://<your macOS username>@localhost:5432/ignis
REDIS_URL=redis://localhost:6379
```

The empty database is enough. The portal creates its tables on first start;
there is no migration step.

Each install needs a database and a Redis of its own. A hosted Redis works as
well as a local one, but two installs pointed at the same one share a schedule
queue, so each fires the other's jobs.

## 3. Configure

```bash
cp portal/.env.example portal/.env.local
cp harness/agent/PERSONA.example.md harness/agent/PERSONA.md
```

**`portal/.env.local`** — fill in the `REQUIRED` block: the two URLs above, the
team roster, and Google credentials (step 4). Everything else either has a
working default or is an optional feature that stays off until configured; the
file says which is which. Set `AGENT_NAME` to what the portal and alerts should
call the agent.

The **team roster** (`TEAM_MEMBER_A_*`, `TEAM_MEMBER_B_*`) is who the agent
trusts. An inbound sender who isn't on it is a guest, and guests are granted
nothing, so with an empty roster the agent boots and can't do anything for
anyone.

**`harness/agent/PERSONA.md`** — who this agent is: its name, its role, whom it
serves, how it sounds. It comes first in the system prompt, ahead of
`harness/agent/SYSTEM.md`, which says how the agent works and is shared by every
install. A run refuses to start without a persona.

## 4. Google (Calendar and Gmail)

Gmail is the agent's inbox and Calendar its calendar. The agent should have a
Google account of its own.

In [Google Cloud](https://console.cloud.google.com/apis/credentials) — a person
has to do this:

1. Enable the **Calendar** and **Gmail** APIs.
2. Configure the OAuth consent screen. On a Google Workspace domain, choose
   **Internal**. An **External** app left in *Testing* has its refresh tokens
   expire after seven days, which silently stops email and calendar a week after
   setup. A Workspace admin may also have to allow the app.
3. Create an OAuth client of type **Desktop app**, with
   `http://localhost:3456/oauth2callback` as an authorized redirect URI.

Put the client id and secret in `.env.local`, then authorize as the agent's
account:

```bash
make google-auth      # opens a browser; writes harness/credentials/ (gitignored)
```

**Optional: Sheets, Docs and Slides.** Enable the Sheets, Docs, Slides and
Drive APIs in the same project, then:

```bash
brew install openclaw/tap/gogcli
make gog-auth ACCOUNT=<the agent's Google account>   # token goes in the macOS keychain
```

and set `GOG_ACCOUNT` to the same address.

## 5. Check it runs

```bash
make smoke      # one run through the harness; needs no server, Postgres or Redis
make run        # portal on http://localhost:3000, inside tmux session "ignis"
```

`make smoke` reports any capability whose credentials are unset as skipped
rather than failing, so read its output: a capability you expected and don't
see means a variable didn't land. Then open the portal and talk to the agent
from **Conversations**.

## 6. Tailscale

Tailscale is how the install is reached from anywhere but this machine. `make
run` configures it on every start (see
[Network exposure](../README.md#network-exposure)): the full portal on `:8443`
to your tailnet only, and the webhook paths in `FUNNEL_PATHS` on `:443` to the
public internet through Funnel. Without Tailscale the portal still runs, on
localhost only, and no webhook can reach it.

### Install the daemon, not the app

```bash
brew install tailscale
sudo brew services start tailscale     # runs tailscaled as root, at boot
sudo tailscale up                      # prints a sign-in URL — a person opens it
```

Use the Homebrew formula run as a root service. The Tailscale app from the Mac
App Store or tailscale.com runs only while somebody is logged in to the desktop,
and an install with its lid closed usually has nobody logged in.

### Configure the tailnet

In the [Tailscale admin console](https://login.tailscale.com/admin) — a person
has to do this:

1. **DNS → MagicDNS**: on. **DNS → HTTPS Certificates**: on. Serve and Funnel
   both need them.
2. **Access controls**: grant Funnel. The policy file needs a `nodeAttrs` entry
   giving this machine the `funnel` attribute, for example:

   ```json
   "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
   ```

   If it is missing, `make expose` warns and links to the setting.
3. **Machines → this machine → Disable key expiry.** Node keys otherwise expire
   after 180 days, and the machine silently drops off the tailnet until somebody
   signs in on it again.

### Name the machine

The machine's Tailscale name is part of every URL the install has:
`https://<machine>.<tailnet>.ts.net`. Set it deliberately before pointing
anything at it, since renaming it later means updating `PUBLIC_URL` and
registering the Telegram webhook again.

```bash
sudo tailscale set --hostname=<machine>
```

### Which tailnet

A device reaches the portal only if it is on the same tailnet as the install.
Joining a second install to the tailnet you already use means one phone reaches
both. A separate tailnet keeps them apart, but then each device has to be
signed in to the right one.

### Expose and verify

```bash
make expose               # also runs on every `make run`
tailscale serve status    # the Funnel paths on :443, the full portal on :8443 (tailnet only)
```

Then set `PUBLIC_URL=https://<machine>.<tailnet>.ts.net` in `.env.local`. It
turns on the middleware's host gate, which 404s every non-webhook route on the
public host as a second line behind Tailscale. Restart with `make run`.

## 7. Keep the laptop awake

An install on a laptop has to keep running with its lid closed.

```bash
make keep-awake       # sudo pmset -a disablesleep 1
make allow-sleep      # undo
```

This sets one system-wide flag that stops all sleep, idle and lid alike, and it
survives a reboot. The machine then runs on battery with its lid closed too, so
keep it on power, and don't put it in a bag while the flag is set: it will stay
awake and get hot.

`make keep-awake` is macOS only. On Linux, the equivalent is
`sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`
plus `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf`.

## 8. Channels

Each channel is optional and independent. Email works once step 4 is done. For
Telegram, see [TELEGRAM.md](TELEGRAM.md); it needs step 6 to be reachable. For
Slack, see the Slack section in [portal/README.md](../portal/README.md); Slack
uses an outbound socket and needs no public URL.

## 9. Optional: workspace search

Workspace search lets the agent search every conversation it has had and the
files in its workspace, locally, with nothing leaving the machine. Without it,
the agent sees only the recent turns of the current thread.

```bash
make rag-setup        # clones and builds mcp-local-rag beside this repo; prints LOCAL_RAG_ENTRY
```

Add the printed `LOCAL_RAG_ENTRY=…` line to `.env.local` and restart. On
startup the portal mirrors each conversation message into
`~/.ignis/conversations/` and indexes the workspace into `~/.ignis/.rag/`, then
keeps both current as runs write files. The agent reaches the index through the
`local-rag` capability (`query_documents`), and the `recall` skill says how to
use it. The first sync downloads an embedding model of about 90 MB; index status
shows in portal health. After an embedding-model change or a workspace move,
run `make rag-rebuild`.

## The host's own Claude configuration

Agent runs are `claude` processes running as your macOS user, so they read
that user's `~/.claude/` — settings, user-level skills, plugins, hooks — as an
interactive session would. The harness keeps out the host's MCP servers
(`--strict-mcp-config`) and nothing else. On a machine where you also use
Claude Code yourself, what you configure for yourself applies to the agent too.

To keep the two apart, run the install under a macOS user of its own, or run
Ignis in a container. The repo does not provide container scaffolding yet.
