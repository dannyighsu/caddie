# Setting up an install

How to stand up a Caddie install on a fresh machine, in order. Written so that a
coding agent can follow it end to end; the steps that need a person — a browser
sign-in, an admin console — say so.

An install is one machine running one agent. Everything that makes it *this*
agent rather than another lives outside git: `portal/.env.local`,
`harness/agent/PERSONA.md`, `harness/agent/.env`, `harness/credentials/`, the workspace at
`~/.caddie/`, `harness/agent/.claude/skills/` and `harness/agent/pre-run`. Two installs share the repo
and nothing else.

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

**Google Chrome** is what the `browser` capability drives. Its MCP server,
Playwright MCP, comes with `pnpm install`, but it opens the installed Chrome
rather than a bundled browser, so without Chrome the agent has no browser.

```bash
brew install --cask google-chrome
```

The browser is headed: it opens a real window. So the macOS user running Caddie
has to stay logged in to the desktop. With the lid closed and the machine kept
awake (step 7), the window still opens. Its profile lives in
`harness/.browser-profile/` and keeps logins between runs. It starts empty on
a new machine, so the first time the agent needs a site behind a login, a
person signs in through that window.

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
createdb caddie
```

Homebrew's Postgres trusts local connections from your macOS user, so the URLs
need no password:

```bash
POSTGRES_URL=postgresql://<your macOS username>@localhost:5432/caddie
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

**`portal/.env.local`** — fill in the `REQUIRED` block: the two URLs above and
Google credentials (step 4). Everything else either has a
working default or is an optional feature that stays off until configured; the
file says which is which. Set `AGENT_NAME` to what the portal and alerts should
call the agent.

The **team roster** is who the agent trusts. An inbound sender whose email,
Slack id or Telegram id isn't on it is a guest, and guests are granted nothing,
so with an empty roster the agent boots and can't do anything for anyone. It
lives in Postgres, not `.env.local`: once the portal is running, its dashboard
asks for the owner (portal runs are attributed to them and failure alerts go to
them), and everyone else is added under **Settings → Team**. Without a browser:

```bash
make team-add NAME="Your Name" EMAIL="you@example.com,you@work.example.com"
```

The first member added is the owner. A member's id (a slug of the name unless
you give one) is fixed once added, because conversation history and
`config/team/<id>.md` refer to it.

**`harness/agent/PERSONA.md`** — who this agent is: its name, its role, whom it
serves, how it sounds. It comes first in the system prompt, ahead of
`harness/agent/SYSTEM.md`, which says how the agent works and is shared by every
install. A run refuses to start without a persona.

A new install starts with the shared core skills, a blank
`config/preferences.md` and no team profiles. Its own skills
(`harness/agent/.claude/skills/`) start empty; the agent writes them there when
a team member asks, and the directory is not tracked.

**`harness/agent/.env`** (optional) — API tokens the agent's own jobs use, as
`NAME=value` lines. Every team-tier run gets them as environment variables and
sees their names, never their values, in its context; guest runs get none. It's
read on each run, so adding a token needs no restart. Keep the portal's own
secrets in `.env.local`. Only what's put here reaches the agent.

**`harness/agent/pre-run`** (optional) — an executable that `make run` and
`make serve` run from the repo root before every start, for this install's own
steps, such as syncing its skills from an agent-config profile. Start from
`harness/agent/pre-run.example`. If it fails, the run warns and starts anyway.

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
make run        # portal on http://localhost:3000, inside tmux session "caddie"
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

On Linux, `tailscaled` takes serve and Funnel changes only from root or its
operator. Make the user that runs the portal the operator, once, or every
`make expose` step fails with "Access denied: serve config denied":

```bash
sudo tailscale set --operator=$USER
```

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
Slack, run `make slack-app` to get a link that creates the app, then see the
Slack section in [portal/README.md](../portal/README.md) for the rest; Slack
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
`~/.caddie/conversations/` and indexes the workspace into `~/.caddie/.rag/`, then
keeps both current as runs write files. The agent reaches the index through the
`local-rag` capability (`query_documents`), and the `recall` skill says how to
use it. The first sync downloads an embedding model of about 90 MB; index status
shows in portal health. After an embedding-model change or a workspace move,
run `make rag-rebuild`.

## 10. Optional: publishing artifacts

The `artifacts` capability gives team-tier runs `publish_artifact`, which puts
files from a run's `artifacts/` directory on a password-protected link that
opens from any device. Until all five of its settings are saved, the capability
isn't mounted.

It needs the Worker from [artifacts/README.md](../artifacts/README.md) deployed,
with the `shared/` entry from `artifacts/src/artifacts.ts`. After that,
publishing uploads straight to R2 and needs no Worker deploy.

Generate a long random password and give it to the Worker. The same password
opens everything the agent publishes.

```bash
cd artifacts
openssl rand -base64 32                       # keep this for the settings below
pnpm exec wrangler secret put PW_SHARED       # paste it at the prompt
pnpm --filter @caddie/artifacts run deploy    # only if `shared/` isn't live yet
pnpm exec wrangler whoami                     # prints the account id
```

In the Cloudflare dashboard — a person has to do this — go to **R2** and create
an API token with **Object Read & Write** permission, limited to the
`caddie-artifacts` bucket.

In the portal, open **Settings → Artifacts** and enter:

- the origin the Worker serves, such as `https://artifacts.example.com`
- the `PW_SHARED` password
- the account ID from `wrangler whoami`
- the token's S3 credentials: the **Access Key ID** (32 hex characters) and
  **Secret Access Key** (64 hex characters) shown once when the token is
  created. Not the token value itself (`cfat_…`); R2's S3 API rejects that with
  a 400, and the form refuses it.

The launcher reads these at the start of every run, so saving needs no restart.
The password and the secret are never shown again; leave their fields blank to
keep the saved values. Until all five are saved, each run logs
`Capability "artifacts" unavailable this run — unset: …` with the `ARTIFACTS_*`
names it had no value for. The tool logs in and fetches each new link before
returning it, so a password that disagrees with `PW_SHARED` comes back as an
error, not a dead link.

## The host's own Claude configuration

Agent runs are `claude` processes running as your macOS user, so they read
that user's `~/.claude/` — settings, user-level skills, plugins, hooks — as an
interactive session would. The harness keeps out the host's MCP servers
(`--strict-mcp-config`) and nothing else. On a machine where you also use
Claude Code yourself, what you configure for yourself applies to the agent too.

To keep the two apart, run the install under a macOS user of its own, or run
Caddie in a container. The repo does not provide container scaffolding yet.
