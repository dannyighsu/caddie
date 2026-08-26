# Job definitions

One file per recurring job, named for the job: `jobs/<job>.md`.

**These are deliberately not committed.** A job names real courses, restaurants,
recipients, and match criteria for one team — it belongs to the install,
not to the repo. Everything here except this README is gitignored, so a fresh
clone starts with no jobs and you author the ones that instance needs.

## What a job file is

The job's stable procedure: what to check, where, what counts as a match, and
how to report it. On a scheduled run the launcher injects the relevant file into
the run context as **"Job instructions"**, so the agent has its playbook without
having to go looking for it.

A job has a second file, `state/<job>.md` in the workspace, which the agent
writes: dedup markers, pauses, and expiring one-off directives. Keep transient
steering there — the procedure here should stay stable.

## The schedule lives elsewhere

Creating the file does not schedule anything. Cadence lives in Redis, set
through the control API (`action: "schedule"`) or by asking the agent, which
uses its `manage-schedules` skill. So standing up a job on a new instance is two
steps: write the file, then schedule it.

> Worth knowing when porting: because the schedule is Redis state rather than
> anything in the repo, it does not travel with a clone and does not survive a
> Redis flush. Moving the cadence into this file's frontmatter is a planned
> change.
