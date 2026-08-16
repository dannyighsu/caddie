# Job: Weekend golf tee-time watch

Check Monarch Bay, Metropolitan, TPC Harding Park, Presidio, and Corica Park (North & South) for weekend 18-hole tee times matching Danny's criteria, and notify him immediately when one is found. This is the procedure for the recurring golf tee-time watch — follow it on a scheduled run, or if Danny asks you to check tee times manually.

## Goal

Every run, check whether an 18-hole tee time has opened up for the **upcoming Saturday or Sunday** at any of these six courses, matching:
- **18 holes** (not 9)
- **Start time between 6:30 AM and 9:30 AM** inclusive
- **Room for 3 or 4 golfers**

If a match is found, notify Danny **immediately** via both Slack and email — don't wait to check the remaining courses first if you find one early, but do still finish checking the rest so you can report every match found this run, not just the first.

## 0. Check the job state first

This job's state lives in `state/golf-tee-times.md`, which holds two sections: **Directives** (expiring steering from Danny) and **State** (`paused_until`, maintained by you). On a scheduled run its contents are already injected into your run context under **"Job state"**; still read the file directly (create it if missing, with an empty Directives section and `paused_until: none`) since you'll be writing updates back to it.

**Directives** — apply every directive whose `(expires: YYYY-MM-DD)` is today or later, then **delete any directive whose expiry has already passed** and save the file. Directives narrow or adjust this run — e.g. "Only check Saturday this weekend" means skip the Sunday checks for this run only. If a directive fully suppresses the run (e.g. "skip this week entirely"), end quietly like a pause.

**Pause (`paused_until`)** —
- If `paused_until` is a date **on or after today**, Danny told you to stand down for that weekend. **Skip the checks entirely** and end the run quietly (no Slack/email, no reply needed — this is a background job).
- If `paused_until` has passed (today is after it), reset it to `none` and proceed with checks normally — the pause was for a single weekend only and has expired.

### Handling steering instructions from Danny

If, in any conversation (not just this scheduled run), Danny says something like:
- **"stop looking this weekend" / "I'm out of town" / "already got a tee time" / "don't bother this week"** — set `paused_until: <upcoming Monday's date>` in the State section (so checks resume automatically once the following Sunday's run rolls around).
- **A narrower steer** like "only check Saturday this weekend" or "I only want mornings after 8 this week" — add it to the **Directives** section as a line ending with `(expires: <upcoming Monday's date>)` so it self-clears after the weekend.

Then confirm back to him what you've recorded. Either way you don't need to touch the schedule itself — the recurring job keeps firing, it just adapts (or no-ops) based on this file.

## 1. Determine target dates

Compute the **next upcoming Saturday and Sunday** relative to today (Pacific time). Both dates get checked every run — Danny wants either day to work.

## 2. Courses to check

Five of the six are bookable through GolfNow, one consistent site, one consistent URL pattern, no per-course logins. Facility IDs (verified working as of 2026-07-21):

| Course | GolfNow URL |
|---|---|
| Monarch Bay (Tony Lema 18) | `https://www.golfnow.com/tee-times/facility/458-monarch-bay-golf-club-lema-18/search#date=YYYY-MM-DD` |
| TPC Harding Park | `https://www.golfnow.com/tee-times/facility/8276-tpc-harding-park-golf-club/search#date=YYYY-MM-DD` |
| Presidio Golf Course | `https://www.golfnow.com/tee-times/facility/148-presidio-golf-course/search#date=YYYY-MM-DD` |
| Corica Park – North Course | `https://www.golfnow.com/tee-times/facility/514-corica-park-north-course/search#date=YYYY-MM-DD` |
| Corica Park – South Course | `https://www.golfnow.com/tee-times/facility/8136-corica-park-south-course/search#date=YYYY-MM-DD` |

Note: Monarch Bay also has a separate "Marina 9" GolfNow listing — ignore it, that's the 9-hole course, not what Danny wants.

**Metropolitan Golf Links is checked differently** — see "Metropolitan: direct site workaround" below. GolfNow has listed it as "not currently offering tee times at this course" for 51+ consecutive runs (since 2026-07-29), which is a broken GolfNow listing, not real unavailability — confirmed by checking Metropolitan's own booking site directly, which shows real inventory. Don't bother checking GolfNow for Metropolitan anymore; go straight to the direct site.

(Presidio was also investigated for a similar direct-site workaround on 2026-08-16 — see "Presidio: no workaround available" below. It stays on GolfNow for now.)

## 3. How to check each course/date

### GolfNow courses (Monarch Bay, TPC Harding Park, Presidio, Corica Park North & South × 2 dates = 10 checks)

1. Navigate to the course's URL with `#date=` set to the target date (`YYYY-MM-DD`). The date is passed as a URL hash fragment — GolfNow's app reads it client-side and loads that day's tee sheet directly, no need to click through the calendar picker.
2. Take a page snapshot. Each available tee time renders as a link whose accessible name follows the pattern:
   `"<TIME><AM/PM> $<price> Online Rate <HOLES> /  <MIN>-<MAX> /  $<rate> + $<fee> fee"`
   e.g. `"7:41AM $5149 9 HOLES RIDING 9 /  1-4 /  $4900 + $249 fee"` or `"6:51AM $6200 Online Rate 18 /  1-4 /  $5900 + $300 fee"`.
   - The `<HOLES>` field tells you 9 vs 18 — only count entries showing **18**.
   - The `<MIN>-<MAX>` field is the golfer range GolfNow will book for that slot (usually `1-4`) — treat it as a match if **3 or 4 falls within that range**, since you can always book fewer than the max.
3. Parse the time and filter to the window **6:30 AM–9:30 AM inclusive**. Times are in the course's local (Pacific) time as displayed.
4. If the page shows "0 tee times matching your current filter options" or similar, there's nothing available that day — move on.
5. Record every qualifying slot: course name, date, time, price, and the booking link (`https://www.golfnow.com` + the relative `/tee-times/facility/.../tee-time/...` URL from the link).

Don't bother with GolfNow's on-page Time/Holes/Golfers filter widgets — they're UI-only widgets that require multiple clicks and don't reliably reflect in the URL. It's faster and more reliable to load the full unfiltered day and parse the listing text yourself per the pattern above.

### Metropolitan: direct site workaround (2 checks — one per target date)

Metropolitan has its own direct booking site, `https://metro.totaleintegrated.net/web/tee-times` (linked from playmetro.com), no login needed to **view** times (login is only required to book). It needs to be driven interactively — a cold request to its underlying API 400s, since the page sets up session context client-side first — so use the browser tool:

1. Navigate to `https://metro.totaleintegrated.net/web/tee-times`. If an aerification/notice banner is showing, dismiss it (doesn't block the form).
2. Click the **"Choose date"** textbox — it opens an inline calendar. Click the target date's day-button (labelled e.g. `"Sat, Aug 22, 2026"`).
3. Leave **Players** at its default (4) and **Holes** at its default (18 Holes, already selected) — both match Danny's criteria as-is, no need to touch them.
4. Click the time textbox (default `05:00AM`) to open the time dropdown, and select **6:30AM**. Leave the **"After"** radio selected (not "Closest") — this returns every slot from 6:30AM onward for the day, which you then filter yourself to ≤9:30AM.
5. Click **Search**.
6. Take a page snapshot. Each result renders as a card with: a time (e.g. `"11:51 AM"`), course name, price (e.g. `"$96.00 Per Player"`), a **Players** field (e.g. `"1-4"`), and a **Holes** field (e.g. `"18"`). Since the search already fixed Holes=18 and Players=4, every card returned is already an 18-hole slot — just filter to:
   - Time **6:30 AM–9:30 AM inclusive**
   - Players range includes 3 or 4 (should always be true given the Players=4 filter used in the search, but double check the displayed range)
7. Record every qualifying slot: date, time, price, players range. There's no per-slot deep link on this site (results aren't individually linkable the way GolfNow's are) — note the search parameters used (date, players, holes) so Danny can reproduce the search at `https://metro.totaleintegrated.net/web/tee-times` if he wants to book.

Verified working live on 2026-08-16 for Sat 8/22 (returned real inventory starting 11:51AM — no slots in the 6:30-9:30AM window that day, consistent with what GolfNow's broken listing was masking).

### Presidio: no workaround available (stays on GolfNow)

Investigated on 2026-08-16 for a Metropolitan-style workaround, since Presidio has the same "not currently offering tee times" GolfNow issue (51+ runs straight). No clean equivalent exists:
- **TeeOff.com** (same GolfNow/EZLinks family, alternate frontend) — same "not currently offering tee times at this course" result. Doesn't route around the underlying data problem.
- **Chronogolf** (chronogolf.com/club/presidio-golf-course) — no online booking widget for Presidio at all, just a "Contact the course directly" card.
- **Presidio's own official booking site**, `https://presidio.cps.golf/` (linked from presidiogolf.com as "Book a Tee Time") — unlike Metropolitan's site, this one gates the tee-time search behind an account: it redirects straight to an email/Google/Facebook login screen (`/auth/verify-email?returnUrl=/search-teetime`) before showing any availability. Viewing times, not just booking them, requires a logged-in account here, which is a materially bigger step than Metropolitan (no anonymous view mode).

Bottom line: no free/no-login way to check Presidio besides GolfNow, so it stays on GolfNow's broken listing for now. Options if Danny wants better Presidio coverage: (a) call the Golf Shop directly (415-561-4661 ext. 1) periodically, (b) set up a Presidio account (email/password or Google/Facebook) so Buri can log into presidio.cps.golf and check — a bigger ask since it means real credentials, or (c) leave it as-is and accept Presidio checks are unreliable until GolfNow fixes their listing.

## 4. If matches are found

Compose one message summarizing all matches found this run (there may be several across courses/dates). For each: course, date, day of week, time, party size available, price, and booking link.

- **Slack**: use `post_to_slack` (default channel) with the summary.
- **Email**: use `send_email` to dannyighsu@gmail.com with a clear subject like "Tee time found: <course> Sat 7/25 7:10AM" and the same details in the body.

Send both — don't skip one because you already sent the other. Do this immediately upon finding a match rather than batching until all 12 checks (10 GolfNow + 2 Metropolitan) finish, but still complete the remaining checks afterward so a single run can surface more than one option.

## 5. If no matches are found

No notification needed — stay silent. This is a background watch job; only interrupt Danny when there's something actionable.

## Trial run notes (from initial setup, 2026-07-21)

- All six GolfNow facility pages load correctly with the `#date=YYYY-MM-DD` hash and immediately show that day's tee sheet — confirmed live for all six URLs above.
- GolfNow tee sheets typically only show useful availability roughly 1-14 days out; very far-out Saturdays/Sundays may show nothing yet, which is expected and not an error.
- The site occasionally throws a benign console warning/error on load (unrelated tracking scripts) — ignore it, the tee sheet itself still renders.
- No login/account is needed just to view availability and pricing; login is only required to actually complete a booking. This job only checks and notifies — it does not book. If Danny wants Buri to book automatically in the future, that needs an account + payment method set up first and should be treated as a separate, explicit ask.
