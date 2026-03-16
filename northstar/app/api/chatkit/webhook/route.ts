import { getPorterClient } from "@/lib/clients/porter-client";
import { getAppConfig } from "@/lib/config/app-config";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { agentId } = await request.json();

    if (!agentId) {
      return NextResponse.json(
        { error: "agentId is required" },
        { status: 400 }
      );
    }

    const config = getAppConfig();
    const porterClient = getPorterClient();

    // Build the webhook URL
    const webhookUrl = `${config.BASE_URL}/api/agent/webhook`;

    // Create the message receive hook
    const hook = await porterClient.createMessageReceiveHook(agentId, {
      url: webhookUrl,
      secret: config.CHATKIT_SECRET,
      modelName: "",
      promptBase: "",
      tokenLimit: 0,
    });

    return NextResponse.json({
      success: true,
      hook: {
        url: hook.url,
        modelName: hook.modelName,
      },
      message: `Webhook registered for agent ${agentId}`,
    });
  } catch (error) {
    console.error("[ChatKit Webhook] Error registering webhook:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to register webhook" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId");

    if (!agentId) {
      return NextResponse.json(
        { error: "agentId query parameter is required" },
        { status: 400 }
      );
    }

    const porterClient = getPorterClient();
    const hooks = await porterClient.getMessageReceiveHooks(agentId);

    return NextResponse.json({
      success: true,
      hooks: hooks.map(h => ({
        url: h.url,
        modelName: h.modelName,
      })),
    });
  } catch (error) {
    console.error("[ChatKit Webhook] Error fetching webhooks:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch webhooks" },
      { status: 500 }
    );
  }
}
