/**
 * Owner Alerts
 *
 * Last-resort delivery path for "the automation itself is broken" messages: an
 * email straight to the team owner. Used when there is no working chat channel
 * to put the problem on — either because the failure is infrastructure the owner
 * must fix (see run-alerts) or because the job's own notification channel is the
 * thing that couldn't deliver (see job-failure-alerts).
 *
 * Best-effort by contract: returns false instead of throwing, so an alert that
 * can't be delivered never masks the failure it was describing.
 */

import { sendEmail, isEmailConfigured } from "./email";
import { teamOwner } from "@caddie/harness";
import { getTeamRoster } from "./team";

/**
 * Email the team owner. Returns true only if the mail was actually handed off.
 * Every failure path logs and returns false.
 */
export async function emailOwner(subject: string, body: string): Promise<boolean> {
  const to = teamOwner(await getTeamRoster().catch(() => []))?.emails[0];
  if (!to) {
    console.error(`[OwnerAlert] No team owner with an email; dropping: ${subject}`);
    return false;
  }
  if (!isEmailConfigured()) {
    console.error(`[OwnerAlert] Email is not configured; dropping: ${subject}`);
    return false;
  }
  try {
    await sendEmail(to, subject, body);
    console.log(`[OwnerAlert] Emailed ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[OwnerAlert] Failed to deliver "${subject}":`, err);
    return false;
  }
}
