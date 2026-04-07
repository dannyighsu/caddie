/**
 * Smoke test — launches an agent via the harness CLI.
 *
 * Usage:
 *   pnpm smoke                                    # defaults to writer agent
 *   pnpm smoke -- --agent writer --prompt "..."
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRuntime } from "../src/runtime/factory.js";
import { createLauncher } from "../src/agent/launcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, "..");

function parseArgs(): { agentId: string; prompt: string; maxTurns?: number } {
  const args = process.argv.slice(2);
  let agentId = "buri";
  let prompt = "Suggest 3 article ideas about AI agents in production. Keep it brief.";
  let maxTurns: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) {
      agentId = args[++i];
    } else if (args[i] === "--prompt" && args[i + 1]) {
      prompt = args[++i];
    } else if (args[i] === "--max-turns" && args[i + 1]) {
      maxTurns = parseInt(args[++i], 10);
      if (isNaN(maxTurns) || maxTurns < 1) {
        console.error("[smoke] --max-turns must be a positive integer");
        process.exit(1);
      }
    }
  }

  return { agentId, prompt, maxTurns };
}

async function main() {
  const { agentId, prompt, maxTurns } = parseArgs();

  console.log(`[smoke] Launching agent: ${agentId}`);
  console.log(`[smoke] Prompt: ${prompt.substring(0, 80)}...`);
  if (maxTurns) console.log(`[smoke] Max turns: ${maxTurns}`);

  const runtime = createRuntime();
  const launcher = createLauncher(runtime, {
    agentsDir: resolve(harnessRoot, "agents"),
    capabilitiesDir: resolve(harnessRoot, "capabilities"),
    resolversDir: resolve(harnessRoot, "resolvers"),
    workspaceRoot: resolve(harnessRoot, "workspace"),
  });

  const result = await launcher.launch({
    agentId,
    prompt,
    maxTurns,
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
