/**
 * Linear Connect
 *
 * GET: start installing the Caddie app in a Linear workspace. Records a pending
 * request (its state, redirect URI and the page to come back to) and sends the
 * browser to Linear's consent screen. Linear sends it back to the OAuth
 * redirect route. Installing as an app requires a Linear workspace admin.
 */

import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { loadLinearSettings } from "@/lib/linear";
import {
  LINEAR_OAUTH_PENDING_KEY,
  authorizeUrl,
  isConfigured,
  redirectUriFor,
  type LinearOAuthPending,
} from "@/lib/linear-settings";

export async function GET(request: NextRequest) {
  const settings = await loadLinearSettings();
  if (!isConfigured(settings)) {
    return NextResponse.json({ error: "Save the client ID, client secret and webhook secret first." }, { status: 400 });
  }

  const pending: LinearOAuthPending = {
    state: randomBytes(24).toString("base64url"),
    redirectUri: redirectUriFor(process.env.PUBLIC_URL, request.nextUrl.origin),
    returnTo: request.nextUrl.origin,
    createdAt: Date.now(),
  };
  await setSetting(LINEAR_OAUTH_PENDING_KEY, pending);

  return NextResponse.redirect(
    authorizeUrl({ clientId: settings.clientId, redirectUri: pending.redirectUri, state: pending.state }),
  );
}
