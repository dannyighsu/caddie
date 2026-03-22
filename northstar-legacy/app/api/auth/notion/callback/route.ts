import { getAppConfig } from "@/lib/config/app-config";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const config = getAppConfig();
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error) {
    console.error("[Notion OAuth] Error:", error);
    return NextResponse.redirect(
      `${config.BASE_URL}/settings?error=notion_auth_failed`
    );
  }

  if (!code) {
    return NextResponse.redirect(`${config.BASE_URL}/settings?error=no_code`);
  }

  return NextResponse.error();

  // try {
  //   // Exchange code for tokens
  //   const credentials = Buffer.from(
  //     `${config.NOTION_CLIENT_ID}:${config.NOTION_CLIENT_SECRET}`
  //   ).toString("base64");

  //   const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
  //     method: "POST",
  //     headers: {
  //       Authorization: `Basic ${credentials}`,
  //       "Content-Type": "application/json",
  //     },
  //     body: JSON.stringify({
  //       grant_type: "authorization_code",
  //       code,
  //       redirect_uri: config.NOTION_REDIRECT_URI,
  //     }),
  //   });

  //   if (!tokenResponse.ok) {
  //     const errorData = await tokenResponse.text();
  //     console.error("[Notion OAuth] Token exchange failed:", errorData);
  //     return NextResponse.redirect(
  //       `${config.BASE_URL}/settings?error=token_exchange_failed`
  //     );
  //   }

  //   const tokens = await tokenResponse.json();

  //   // Store credentials with workspace info
  //   await upsertOAuthCredential({
  //     provider: "notion",
  //     accessToken: tokens.access_token,
  //     refreshToken: null, // Notion doesn't provide refresh tokens
  //     expiresAt: null, // Notion tokens don't expire
  //     metadata: {
  //       workspace_id: tokens.workspace_id,
  //       workspace_name: tokens.workspace_name,
  //       workspace_icon: tokens.workspace_icon,
  //       bot_id: tokens.bot_id,
  //       owner: tokens.owner,
  //     },
  //   });

  //   console.log("[Notion OAuth] Successfully stored credentials");

  //   return NextResponse.redirect(`${config.BASE_URL}/settings?success=notion`);
  // } catch (error) {
  //   console.error("[Notion OAuth] Error:", error);
  //   return NextResponse.redirect(
  //     `${config.BASE_URL}/settings?error=notion_auth_failed`
  //   );
  // }
}
