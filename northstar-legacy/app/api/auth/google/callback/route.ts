import { NextRequest, NextResponse } from "next/server";
import { getAppConfig } from "@/lib/config/app-config";
import { upsertOAuthCredential } from "@/lib/db/oauth-repository";

export async function GET(request: NextRequest) {
  const config = getAppConfig();
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error) {
    console.error("[Google OAuth] Error:", error);
    return NextResponse.redirect(
      `${config.BASE_URL}/settings?error=google_auth_failed`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${config.BASE_URL}/settings?error=no_code`
    );
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.GOOGLE_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("[Google OAuth] Token exchange failed:", errorData);
      return NextResponse.redirect(
        `${config.BASE_URL}/settings?error=token_exchange_failed`
      );
    }

    const tokens = await tokenResponse.json();

    // Calculate expiration time
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    // Get user info for metadata
    const userInfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );

    let metadata: Record<string, unknown> = {};
    if (userInfoResponse.ok) {
      const userInfo = await userInfoResponse.json();
      metadata = {
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
      };
    }

    // Store credentials
    await upsertOAuthCredential({
      provider: "google",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      scopes: tokens.scope?.split(" ") || null,
      metadata,
    });

    console.log("[Google OAuth] Successfully stored credentials");

    return NextResponse.redirect(`${config.BASE_URL}/settings?success=google`);
  } catch (error) {
    console.error("[Google OAuth] Error:", error);
    return NextResponse.redirect(
      `${config.BASE_URL}/settings?error=google_auth_failed`
    );
  }
}
