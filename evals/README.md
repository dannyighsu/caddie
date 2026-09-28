# Evals

Replay real situations through a real agent run, with every side effect faked,
and check what the agent did.

```bash
pnpm eval email-inbound                    # whole suite, Sonnet, judge on
pnpm eval email-inbound --case agua-       # cases by id prefix
pnpm eval email-inbound --tag triage/drop --trials 3
pnpm eval email-inbound --model claude-opus-5 --no-judge
pnpm eval list                             # suites
pnpm eval list email-inbound               # cases and tags
```

Each run writes `evals/results/<suite>-<timestamp>/` (gitignored):
- `report.md`: pass/fail per case, and for every failure the assertions that
  failed, the tool calls, and what would have been sent
- `summary.json`: the same data, for tooling
- `<case>/trial-N/`: `evidence.json` (prompt, tool calls, outbound effects,
  grades) and `transcript.jsonl`

The exit code is non-zero if any case fails.

## The bar

- **Model.** Cases run on **Sonnet** by default, while production runs Opus.
  A case that only passes on the stronger model is relying on the model rather
  than on clear instructions.
- **Trials.** A case passes only if **every** trial passes. Use `--trials 3`
  before trusting a persona or skill change.
- **Standing instructions.** Cases are graded against the **current** config in
  `workspace/<agent>/config/`, anonymized. When a standing instruction changes,
  the expectations that depend on it change too. Each such assertion's `why`
  names its instruction.

## How a run works

```
case.yaml ──▶ driver ──▶ sandbox (temp harness root + workspace) ──▶ claude -p
                │                                                      │
                │   prompt built by northstar's own assembleInboundPrompt
                ▼                                                      ▼
          fake control API  ◀── real reply / email / email-team MCP servers
          (records sends,        (unchanged, PORTAL_URL points at the fake)
           sends nothing)
                                 stub google-calendar / google-gmail (fixtures)
```

- **Sandbox** (`core/sandbox.ts`):
  - Runs from a *copy* of the agent definition, so ticket writes and config
    journaling stay out of the repo.
  - Uses the real `permissions.json`, so guest and team tiers behave as they
    do in production.
  - Leaves out Notion, the browser and the `.agent-venv` tools, because they
    reach real services. It also blocks WebFetch and WebSearch, and shadows
    `gog`, `gcloud` and `gh` on the PATH.
  - A case may only *require* tools that are faked: the messaging tools and
    the Calendar/Gmail stubs (`FAKED_TOOLS` in `drivers/inbound-message.ts`).
    The loader rejects a case that expects anything else, because it would be
    grading the fake, not the agent.
- **Same code path as production.** The prompt is built by
  `northstar/lib/inbound-prompt.ts`, the one production uses, together with the
  real envelope summary and identity helpers. The one-time "you didn't reply"
  reminder is replayed as well.
- **Fake team.** Every run uses the Danny/Betty roster at `@team.example` and
  the agent inbox `buri@assistant.example` (`core/team.ts`).

## Writing a case

A case is one YAML file in `suites/<suite>/cases/`. To start from a real run:

```bash
pnpm --filter @agints/evals extract-case <sessionId> <case-id> --agent-address <agent's real inbox>
```

This pulls the envelope, history, current time and inbound message out of the
session transcript, plus the Gmail and Calendar results the run saw as
fixtures. It maps every address and phone number onto fakes, applies the
gitignored `evals/.scrub.json` (`{"Full Name": "First"}`, for names in headers
and signatures), and
writes a skeleton with an empty `expect` list. The skeleton fails validation
until you fill that in. Names and body text are kept, so read the file before
committing it.

Assertions (all text checks are case-insensitive):

| Assertion | Passes when |
|---|---|
| `not_called: reply` | the tool was never called |
| `called: email_team` (+ `times: {min, max}`, `where: {field: match}`) | enough calls match; fields are the tool's arguments plus `body` (message or html) and `recipients` |
| `no_external_send: true` | nothing reached anyone outside the team: no reply on a thread with outsiders, no mail to a non-team address |
| `every_call: send_email`, `where: {…}` | the tool was called, and every call matches |
| `external_only_to: [addr, "@domain"]` | anything that reached outsiders went only to these |
| `external_outbound: {not_contains: [...]}` | every message that reached an outsider passes the checks (internal notes exempt) |
| `all_outbound: {not_contains: [...]}` | every message sent (reply, email, email_team) passes the checks |
| `rubric: "…"` | a judge model (`--judge-model`, default Opus) answers PASS for this one criterion |

Text matches take `contains`, `contains_all`, `contains_any`, `not_contains`,
`matches` and `not_matches` (regex).

- **Prefer deterministic checks.** Add a `rubric` only for judgment that string
  matching can't capture, such as "no filler" or "doesn't re-ask what was
  answered".
- **Give every assertion a `why`.** The report shows it on failure.

## Adding a new kind of eval

- **A new suite** is a directory with `suite.yaml` (`driver`, `agent`,
  `defaults`) and `cases/`.
- **A new driver** is needed only when the run itself has a different shape,
  such as a scheduled job, a Slack thread or a portal chat:
  1. Implement `Driver` (`core/types.ts`): `validate` checks the
     driver-specific fields of a case, and `run` returns `Evidence`.
  2. Register it in `core/load.ts`.
- **What doesn't change:** graders, the runner and the report work on
  `Evidence`, so they carry over to any new driver.

## Known gaps

- **Gmail and Calendar are stubs.** Fixtures come from what the real run saw
  (`extract-case` rebuilds them from the transcript). Search supports `OR` and
  `from:`/`to:`/`cc:`/`subject:`, and ignores other operators.
- **Attachments aren't reproduced.** A case can mention one in its text, but
  no file exists.
- **Stub schemas are approximate.** The Google stubs use production's tool
  names with simplified schemas. That matters only for team-tier cases, and the
  current suite is all guest-tier.
- **Team-tier cases still get built-in tools.** Bash included, just as in
  production. CLIs that reach real services (`gog`, `gcloud`, `gh`) are
  shadowed by failing shims, but a team-tier case is still less isolated than a
  guest-tier one. Guest-tier runs have no built-in tools at all.
