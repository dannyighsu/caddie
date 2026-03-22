import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Open Chrome and navigate to X for manual login.
 * With Claude-in-Chrome, the browser session persists via the Chrome profile.
 */
export async function POST() {
  try {
    console.log("[API] Opening Chrome for X login...");

    // On macOS, open Chrome to X directly
    await execFileAsync("open", ["-a", "Google Chrome", "https://x.com"]);

    return NextResponse.json({
      success: true,
      message: "Chrome opened to x.com. Please log in manually — the session will persist via your Chrome profile.",
    });
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
