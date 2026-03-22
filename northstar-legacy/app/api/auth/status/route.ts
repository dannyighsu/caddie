import { NextResponse } from "next/server";
import { getAllOAuthCredentials } from "@/lib/db/oauth-repository";
import { getAppConfig } from "@/lib/config/app-config";

export interface ConnectionStatus {
  provider: string;
  connected: boolean;
  metadata?: Record<string, unknown>;
  connectedAt?: string;
}

export async function GET() {
  try {
    const config = getAppConfig();
    const credentials = await getAllOAuthCredentials();

    const status: Record<string, ConnectionStatus> = {
      google: { provider: "google", connected: false },
      notion: { provider: "notion", connected: false },
    };

    // Check for Notion internal integration token
    if (config.NOTION_INTERNAL_TOKEN) {
      status.notion = {
        provider: "notion",
        connected: true,
        metadata: { mode: "internal" },
      };
    }

    // Override with database credentials (OAuth takes precedence)
    for (const cred of credentials) {
      status[cred.provider] = {
        provider: cred.provider,
        connected: true,
        metadata: cred.metadata,
        connectedAt: cred.created_at.toISOString(),
      };
    }

    return NextResponse.json(status);
  } catch (error) {
    console.error("[Auth Status] Error:", error);
    return NextResponse.json(
      { error: "Failed to get connection status" },
      { status: 500 }
    );
  }
}
