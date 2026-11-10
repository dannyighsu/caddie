/**
 * Linear OAuth Redirect
 *
 * GET: where Linear sends the browser after a workspace admin installs the app
 * (started from Settings → Linear → Connect). Checks the state against the
 * pending request, exchanges the code for app-actor tokens, stores the
 * installation, and sends the browser back to Settings.
 *
 * Reachable on the public URL, since that's usually what Linear redirects to.
 * The state check is what keeps a stranger's request from installing anything.
 */

import { NextRequest, NextResponse } from "next/server";
import { deleteSetting, getSetting } from "@/lib/db";
import { completeInstall, loadLinearSettings } from "@/lib/linear";
import {
  LINEAR_OAUTH_PENDING_KEY,
  isConfigured,
  pendingMatches,
  type LinearOAuthPending,
} from "@/lib/linear-settings";

function backToSettings(returnTo: string, outcome: { connected: true } | { error: string }) {
  const url = new URL("/settings", returnTo);
  if ("error" in outcome) url.searchParams.set("linear_error", outcome.error);
  else url.searchParams.set("linear", "connected");
  url.hash = "linear";
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const pending = await getSetting<LinearOAuthPending>(LINEAR_OAUTH_PENDING_KEY);

  if (!pendingMatches(pending, params.get("state"), Date.now())) {
    // Without a matching request there's no trusted page to send them back to.
    return NextResponse.json(
      { error: "This Linear install link has expired or wasn't started here. Start again from Settings → Linear." },
      { status: 400 },
    );
  }
  await deleteSetting(LINEAR_OAUTH_PENDING_KEY);

  const denied = params.get("error");
  if (denied) {
    return backToSettings(pending.returnTo, { error: params.get("error_description") ?? denied });
  }

  const code = params.get("code");
  const settings = await loadLinearSettings();
  if (!code || !isConfigured(settings)) {
    return backToSettings(pending.returnTo, { error: "Linear didn't return a code, or the settings were removed." });
  }

  try {
    const inst = await completeInstall(settings, code, pending.redirectUri);
    console.log(`[Linear] Installed in ${inst.organizationName} as app user ${inst.appUserId}`);
    return backToSettings(pending.returnTo, { connected: true });
  } catch (err) {
    console.error("[Linear] Install failed:", err);
    return backToSettings(pending.returnTo, { error: err instanceof Error ? err.message : "Install failed." });
  }
}
