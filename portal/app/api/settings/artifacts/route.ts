/**
 * Artifacts Settings API
 *
 * The `artifacts` capability's origin, password and R2 token. GET reports
 * whether the password and the R2 secret are set but never returns them (see
 * lib/artifacts-settings.ts). POST merges: a blank secret keeps the stored one.
 */

import { getSetting, setSetting, deleteSetting } from "@/lib/db";
import { ARTIFACTS_SETTING_KEY, applyUpdate, viewOf, type ArtifactsSettings } from "@/lib/artifacts-settings";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(viewOf(await getSetting<ArtifactsSettings>(ARTIFACTS_SETTING_KEY)));
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const result = applyUpdate(await getSetting<ArtifactsSettings>(ARTIFACTS_SETTING_KEY), body);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  await setSetting(ARTIFACTS_SETTING_KEY, result.settings);
  return NextResponse.json(viewOf(result.settings));
}

export async function DELETE() {
  const deleted = await deleteSetting(ARTIFACTS_SETTING_KEY);
  return NextResponse.json({ success: true, deleted });
}
