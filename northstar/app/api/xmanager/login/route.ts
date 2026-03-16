import { NextResponse } from "next/server";
import { getXManagerExecutionService } from "@/lib/services/xmanager-execution-service";

export async function POST() {
  try {
    console.log("[API] Starting X Manager login flow");

    const xManagerService = getXManagerExecutionService();
    const result = await xManagerService.openLoginBrowser();

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API] X Manager login error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
