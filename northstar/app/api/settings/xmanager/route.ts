import { NextRequest, NextResponse } from "next/server";
import {
  getXManagerConfig,
  setXManagerConfig,
  clearXManagerConfig,
  XManagerConfig,
} from "@/lib/db/settings-repository";

export async function GET() {
  try {
    const config = await getXManagerConfig();
    return NextResponse.json({ config });
  } catch (error) {
    console.error("[Settings] Error getting X Manager config:", error);
    return NextResponse.json(
      { error: "Failed to get X Manager config" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { xUsername, modelId } = body as Partial<XManagerConfig>;

    if (!xUsername) {
      return NextResponse.json(
        { error: "xUsername is required" },
        { status: 400 }
      );
    }

    const config: XManagerConfig = { xUsername };
    if (modelId) {
      config.modelId = modelId;
    }

    await setXManagerConfig(config);

    console.log(
      `[Settings] Set X Manager config: xUsername=${xUsername}, modelId=${modelId || "default"}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Settings] Error setting X Manager config:", error);
    return NextResponse.json(
      { error: "Failed to set X Manager config" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const deleted = await clearXManagerConfig();
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error("[Settings] Error clearing X Manager config:", error);
    return NextResponse.json(
      { error: "Failed to clear X Manager config" },
      { status: 500 }
    );
  }
}
