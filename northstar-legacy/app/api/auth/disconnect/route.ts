import { NextRequest, NextResponse } from "next/server";
import {
  deleteOAuthCredential,
  OAuthProvider,
} from "@/lib/db/oauth-repository";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const provider = body.provider as OAuthProvider;

    if (!provider || !["google", "notion", "slack"].includes(provider)) {
      return NextResponse.json(
        { error: "Invalid provider" },
        { status: 400 }
      );
    }

    const deleted = await deleteOAuthCredential(provider);

    if (deleted) {
      console.log(`[Auth] Disconnected ${provider}`);
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }
  } catch (error) {
    console.error("[Auth Disconnect] Error:", error);
    return NextResponse.json(
      { error: "Failed to disconnect" },
      { status: 500 }
    );
  }
}
