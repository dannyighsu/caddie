/**
 * Linear Settings API
 *
 * The OAuth app's client ID and secret and the webhook signing secret, plus the
 * connection the OAuth redirect stores. GET reports whether each secret is set
 * but never returns one (see lib/linear-settings.ts). POST merges: a blank
 * secret keeps the stored one. DELETE revokes the install and removes it all.
 */

import { NextRequest, NextResponse } from "next/server";
import { deleteSetting, setSetting } from "@/lib/db";
import { loadLinearSettings, revokeInstall } from "@/lib/linear";
import { LINEAR_SETTING_KEY, applyUpdate, viewOf } from "@/lib/linear-settings";

function urls(request: NextRequest) {
  return { publicUrl: process.env.PUBLIC_URL, requestOrigin: request.nextUrl.origin };
}

export async function GET(request: NextRequest) {
  return NextResponse.json(viewOf(await loadLinearSettings(), urls(request)));
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const current = await loadLinearSettings();
  const result = applyUpdate(current, body);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (current?.installation && !result.settings.installation) {
    // The client ID changed, so the old app's install is dropped. Revoke it too.
    await revokeInstall(current);
  }
  await setSetting(LINEAR_SETTING_KEY, result.settings);
  return NextResponse.json(viewOf(result.settings, urls(request)));
}

export async function DELETE() {
  await revokeInstall(await loadLinearSettings());
  const deleted = await deleteSetting(LINEAR_SETTING_KEY);
  return NextResponse.json({ success: true, deleted });
}
