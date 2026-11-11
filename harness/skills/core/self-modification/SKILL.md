---
name: self-modification
description: Change how you yourself work — your system prompt, a core skill, the harness or the portal — by mounting the caddie repo and opening a pull request. Use when a team member asks you to change your own prompting, instructions or behaviour, or when you find a defect in your own machinery that the fix belongs in code.
---

## Changing your own code

Your prompting, your core skills and the harness you run on all live in one git
repo: **caddie**. Changing how you work means changing that repo, and the only
route is a **pull request** — never an edit to the live install you are running
from, and never a note to yourself in the workspace.

### When this applies

- A team member asks you to change your own behaviour: "update your prompting
  so…", "you shouldn't do X any more", "make this change to your own code",
  "fix how you handle Y".
- You investigated a run and landed on a defect in your own machinery — a tool
  that fails like a bug, a capability that isn't mounted, a run that went wrong
  for a reason none of your instructions explain — **and** the fix is in this
  repo.

It does **not** apply to:

| Looks similar | Where it actually goes |
|---|---|
| A standing preference ("always cc me") | `config/preferences.md` or `config/team/<member>.md` |
| A change to one of **this agent's own** skills | the `manage-skills` skill |
| One-off steering for a recurring job | an expiring directive in `state/<job>.md` |
| A defect that isn't yours to fix (a third-party tool, an access problem, a decision the team owes you) | raise it with the team in your reply or by `email_team`, and file it in the team's tracker if they keep one |

### The procedure

1. **Mount the repo.** Read the `repo-mount` skill — it has the script, the
   rule against working in the live checkout, and the list of files that govern
   you and that you must propose rather than change.
2. **Make the change**, branched from `origin/main`.
3. **Open a PR** per `repo-mount`: a specific-path `git add`, a commit message
   that says what changed and why, and a body that says you opened it, what
   prompted it, and how you verified it (or plainly that you couldn't).
4. **Tell the person** in your reply: the PR link, what's in it, and anything
   you flagged in the PR rather than deciding yourself.

Never merge it. Review is the point.

### When to ask instead

A change to your own instructions is in force the moment it merges, and a vague
one is worse than none. **Ask for clarification before opening a PR** when:

- the request has more than one plausible reading, and they'd produce
  materially different prompt text;
- you can see *what* is wrong but not what the right behaviour should be;
- the fix seems to need one of the files `repo-mount` tells you never to change
  (`permissions.json`, `agent.json`, the hooks). Say so and propose it — that
  proposal *is* the job.

One question with your best guess attached beats a PR nobody asked for.
