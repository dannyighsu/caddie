# Job: House of Prime Rib reservation watch

Check House of Prime Rib (SF) on OpenTable for open reservations on the upcoming Thursday, Friday, or Saturday night, for parties of 4-8 between 6-8PM, and notify Danny immediately when one is found. This is the procedure for the recurring HOPR reservation watch — follow it on a scheduled run, or if Danny asks you to check HOPR availability manually.

## Goal

Every run, check whether a reservation has opened up at **House of Prime Rib** (1906 Van Ness Ave, San Francisco) on OpenTable for the **upcoming Thursday, Friday, or Saturday night**, matching:
- **Party size 4-8**
- **Start time between 6:00 PM and 8:00 PM** inclusive

If a match is found, notify Danny **immediately** via both Slack and email — don't wait to finish the remaining checks first, but do still finish them so you can report every match found this run, not just the first.

## 0. Check the job state first

This job's state lives in `state/hopr-reservations.md`, which holds two sections: **Directives** (expiring steering from Danny) and **State** (`paused_until`, maintained by you). On a scheduled run its contents are already injected into your run context under **"Job state"**; still read the file directly (create it if missing, with an empty Directives section and `paused_until: none`) since you'll be writing updates back to it.

**Directives** — apply every directive whose `(expires: YYYY-MM-DD)` is today or later, then **delete any directive whose expiry has already passed** and save the file. Directives narrow or adjust this run — e.g. "Only check Saturday this week" means skip the Thursday/Friday checks for this run only. If a directive fully suppresses the run (e.g. "skip this week entirely"), end quietly like a pause.

**Pause (`paused_until`)** —
- If `paused_until` is a date **on or after today**, Danny told you to stand down. **Skip the checks entirely** and end the run quietly (no Slack/email, no reply needed — this is a background job).
- If `paused_until` has passed (today is after it), reset it to `none` and proceed with checks normally.

### Handling steering instructions from Danny

If, in any conversation (not just this scheduled run), Danny says something like:
- **"stop looking this week" / "I'm out of town" / "already got a reservation" / "don't bother this week"** — set `paused_until: <upcoming Monday's date>` in the State section (so checks resume automatically once the following week's runs roll around).
- **A narrower steer** like "only check Saturday this week" or "just look for a table of 6" — add it to the **Directives** section as a line ending with `(expires: <upcoming Monday's date>)` so it self-clears after the week.

Then confirm back to him what you've recorded. Either way you don't need to touch the schedule itself — the recurring job keeps firing, it just adapts (or no-ops) based on this file.

## 1. Determine target dates

Compute the **next upcoming Thursday, Friday, and Saturday** relative to today (Pacific time) — if today itself is one of those days, use today for that one (a same-day cancellation is still worth surfacing). All three dates get checked every run.

## 2. Restaurant and party sizes to check

House of Prime Rib is on OpenTable, restaurant id `1779`, one consistent URL pattern:

`https://www.opentable.com/house-of-prime-rib?covers=<N>&dateTime=<YYYY-MM-DD>T19%3A00`

Check **two party sizes per date: 4 and 8** (the bounds of Danny's 4-8 range) — larger parties have less availability than smaller ones, so checking both bounds catches partial availability (e.g. a table for 4-6 open but not 7-8) without needing to check every size in between. `dateTime` is fixed at `19:00` (7 PM, the center of the target window) each check — OpenTable's widget surfaces the nearest available times around that anchor, which is enough to cover the full 6-8PM window.

6 checks total per run: 3 dates x 2 party sizes.

## 3. How to check each date/party size

1. Navigate to the URL above with `covers` and `dateTime` set.
2. Take a page snapshot and find the "Make a reservation" widget. Confirm the party size selector and date button reflect what you requested (sanity check the params applied).
3. Two possible outcomes near that widget:
   - **"Select a time" / "Available time slots" list** — a live list of bookable buttons, each labeled like `"Reserve table at House of Prime Rib at <TIME> on <DATE>, for a party of <N>"`. (Note: the `<N>` in this label is sometimes wrong/stale — trust the party size *you searched with*, not the label text.)
   - **"At the moment, there's no online availability within 3.5 hours of <TIME>."** with a "Notify me" button, plus a separate "Next available is <date>" block showing the next open slot on some future date — that fallback date is usually well past your target window and doesn't count as a match unless it happens to land on one of your three target dates within 6-8PM.
4. Parse whichever slot times are shown and filter to **6:00 PM-8:00 PM inclusive**.
5. Record every qualifying slot: date, day of week, time, party size searched, and construct the booking link from the "Reserve table..." button/link's `/book/validate?...` URL, prefixed with `https://www.opentable.com`.

## 4. If matches are found

Compose one message summarizing all matches found this run (there may be several across dates/party sizes). For each: date, day of week, time, party size, and booking link.

- **Slack**: use `post_to_slack` (default channel) with the summary.
- **Email**: use `send_email` to dannyighsu@gmail.com with a clear subject like "HOPR table found: Sat 8/8 6:30PM (party of 4)" and the same details in the body.

Send both — don't skip one because you already sent the other. Do this immediately upon finding a match rather than batching until all 6 checks finish, but still complete the remaining checks afterward so a single run can surface more than one option.

## 5. If no matches are found

No notification needed — stay silent. This is a background watch job; only interrupt Danny when there's something actionable.

## Trial run notes (from initial setup, 2026-07-31)

- Confirmed live: `https://www.opentable.com/house-of-prime-rib?covers=4&dateTime=2026-08-06T18:00` correctly pre-fills the party size and date/time widget to match the query params.
- No login is needed to view availability — only to complete a booking. This job only checks and notifies — it does not book. If Danny wants Buri to book automatically in the future, that needs an account + payment method set up first and should be treated as a separate, explicit ask.
- House of Prime Rib is a famously hard reservation (often booked out weeks/months ahead per public reporting), so most runs are expected to find nothing — that's normal, not a sign the check is broken.
