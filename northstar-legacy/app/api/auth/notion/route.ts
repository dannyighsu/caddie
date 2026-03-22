import { getAppConfig } from "@/lib/config/app-config";
import { NextResponse } from "next/server";

export async function GET() {
  const config = getAppConfig();

  // If using internal integration, no OAuth needed
  if (config.NOTION_INTERNAL_TOKEN) {
    return NextResponse.redirect(
      `${config.BASE_URL}/settings?success=notion&mode=internal`
    );
  } else {
    return NextResponse.error();
  }

  // OAuth flow requires client ID
  // if (!config.NOTION_CLIENT_ID || !config.NOTION_REDIRECT_URI) {
  //   return NextResponse.redirect(
  //     `${config.BASE_URL}/settings?error=notion_not_configured`
  //   );
  // }

  // const params = new URLSearchParams({
  //   client_id: config.NOTION_CLIENT_ID,
  //   redirect_uri: config.NOTION_REDIRECT_URI,
  //   response_type: "code",
  //   owner: "user",
  // });

  // const authUrl = `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;

  // return NextResponse.redirect(authUrl);
}
