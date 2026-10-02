/**
 * Smoke test — launches the agent via the harness CLI.
 *
 * Usage:
 *   pnpm smoke
 *   pnpm smoke -- --profile extended --prompt "..."
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRuntime } from "../src/runtime/factory.js";
import { createLauncher } from "../src/agent/launcher.js";
import { workspaceDir } from "../src/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(__dirname, "..");

function parseArgs(): { profile?: string; prompt: string } {
  const args = process.argv.slice(2);
  let profile: string | undefined;
  let prompt = "Suggest 3 article ideas about AI agents in production. Keep it brief.";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" && args[i + 1]) {
      profile = args[++i];
    } else if (args[i] === "--prompt" && args[i + 1]) {
      prompt = args[++i];
    }
  }

  return { profile, prompt };
}

async function main() {
  const { profile, prompt } = parseArgs();

  console.log(`[smoke] Launching the agent (profile: ${profile ?? "default"})`);
  console.log(`[smoke] Prompt: ${prompt.substring(0, 80)}...`);

  const runtime = createRuntime();
  const launcher = createLauncher(runtime, {
    agentDir: resolve(harnessRoot, "agent"),
    capabilitiesDir: resolve(harnessRoot, "capabilities"),
    resolversDir: resolve(harnessRoot, "resolvers"),
    // Same workspace the server uses, so a smoke run exercises the real one.
    workspace: workspaceDir(),
  });

  const result = await launcher.launch({
    profile,
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
