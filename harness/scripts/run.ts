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

function parseArgs(): { agentId: string; prompt: string } {
  const args = process.argv.slice(2);
  let agentId = "buri";
  let prompt = "Suggest 3 article ideas about AI agents in production. Keep it brief.";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) {
      agentId = args[++i];
    } else if (args[i] === "--prompt" && args[i + 1]) {
      prompt = args[++i];
    }
  }

  return { agentId, prompt };
}

async function main() {
  const { agentId, prompt } = parseArgs();

  console.log(`[smoke] Launching agent: ${agentId}`);
  console.log(`[smoke] Prompt: ${prompt.substring(0, 80)}...`);

  const runtime = createRuntime();
  const launcher = createLauncher(runtime, {
    agentsDir: resolve(harnessRoot, "agents"),
    capabilitiesDir: resolve(harnessRoot, "capabilities"),
    resolversDir: resolve(harnessRoot, "resolvers"),
    workspaceRoot: resolve(harnessRoot, "workspace"),
  });

  const result = await launcher.launch({
    agentId,
    identity: {
      trustTier: "team",
      senderIdentity: "CLI (smoke test)",
      originChannel: "cli",
    },
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
