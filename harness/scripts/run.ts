/**
 * Smoke test — launches a workflow via the harness CLI.
 *
 * Usage:
 *   pnpm smoke                                    # defaults to writer workflow
 *   pnpm smoke -- --workflow writer --prompt "..."
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdir } from "fs/promises";
import { createRuntime } from "../src/runtime/factory.js";
import { createLauncher } from "../src/workflow/launcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, "..");

// Parse CLI args
function parseArgs(): { workflowId: string; prompt: string } {
  const args = process.argv.slice(2);
  let workflowId = "writer";
  let prompt = "Suggest 3 article ideas about AI agents in production. Keep it brief.";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workflow" && args[i + 1]) {
      workflowId = args[++i];
    } else if (args[i] === "--prompt" && args[i + 1]) {
      prompt = args[++i];
    }
  }

  return { workflowId, prompt };
}

async function main() {
  const { workflowId, prompt } = parseArgs();

  console.log(`[smoke] Launching workflow: ${workflowId}`);
  console.log(`[smoke] Prompt: ${prompt.substring(0, 80)}...`);

  const runtime = createRuntime();
  const workspaceRoot = resolve(harnessRoot, "workspace");

  // Ensure workspace exists
  await mkdir(resolve(workspaceRoot, "default", workflowId), { recursive: true });

  const launcher = createLauncher(runtime, {
    workflowsDir: resolve(harnessRoot, "workflows"),
    capabilitiesDir: resolve(harnessRoot, "capabilities"),
    workspaceRoot,
  });

  const result = await launcher.launch({
    workflowId,
    prompt,
    context: {
      currentTime: new Date().toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
    },
  });

  console.log("\n[smoke] === Result ===");
  console.log("[smoke] Success:", result.success);
  console.log("[smoke] Session ID:", result.sessionId);

  if (result.error) {
    console.error("[smoke] Error:", result.error);
    process.exit(1);
  }

  if (result.output) {
    console.log("[smoke] Structured output:", JSON.stringify(result.output, null, 2));
  }

  console.log("[smoke] Raw text:", result.rawText.substring(0, 500));
}

main().catch((err) => {
  console.error("[smoke] Fatal:", err);
  process.exit(1);
});
