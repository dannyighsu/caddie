/**
 * Feed Scanner Evaluation Script
 *
 * Runs the feed scan skill via the UnifiedAgent against a Langfuse dataset
 * and scores results with programmatic + LLM-as-judge evaluators.
 *
 * Usage: pnpm eval:feed-scanner
 */

// Load .env.local BEFORE any imports that touch getAppConfig
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { generateText } from "ai";
import { v4 as uuidv4 } from "uuid";

import { getAppConfig } from "../lib/config/app-config";
import { LocalFilesystemBackend } from "agent-backend";
import {
  createBrowserUseMCPClient,
  type BrowserUseMCPClient,
} from "../lib/ai/browser-use-mcp-client";
import { getModel } from "../lib/ai/openrouter-client";
import { UnifiedAgent } from "../lib/agents/unified-agent";
import { getFeedScanPrompt } from "../lib/agents/skills/x-feed-scan";
import { createXManagerSubTaskFinishToolSet } from "../lib/ai/tool-sets";

export interface EngagementOpportunity {
  author: string;
  authorHandle: string;
  text: string;
  link: string;
  reason: string;
}

export interface FeedScannerInput {
  xUsername: string;
  areasOfInterest: string;
  engagementCriteria: string;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (avoid static import of agent-backend/adapters which
// only has an ESM export and fails under tsx CJS resolution)
// ---------------------------------------------------------------------------

function createBackend() {
  const config = getAppConfig();
  return new LocalFilesystemBackend({
    rootDir: config.CONSTELLATION_WORKSPACE_ROOT,
    preventDangerous: false,
    shell: "auto",
    isolation: "none",
  });
}

async function createBackendMCPClient(options: { userId: string; workspace: string }) {
  const config = getAppConfig();
  const backend = createBackend();
  const workspace = options.workspace ?? config.CONSTELLATION_WORKSPACE;
  const scopedBackend = backend.scope(workspace);

  // Dynamic import to use ESM resolution for agent-backend/adapters
  const { VercelAIAdapter } = await import("agent-backend/adapters");
  const adapter = new VercelAIAdapter(scopedBackend);
  const mcpClient = await adapter.getMCPClient();

  const tools = await mcpClient.tools();
  console.log("[Eval MCP] Tools available:", Object.keys(tools));

  return {
    tools: async () => tools,
    async close() {
      await backend.destroy();
    },
  };
}

type MCPClient = Awaited<ReturnType<typeof createBackendMCPClient>>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalOutput {
  opportunities: EngagementOpportunity[];
  scanTimestamp: string;
  runRecordPath: string;
}

// ---------------------------------------------------------------------------
// OTEL / Langfuse initialization
// ---------------------------------------------------------------------------

let sdk: NodeSDK | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;

function initOtel() {
  const config = getAppConfig();
  if (!config.LANGFUSE_ENABLED) {
    console.log("[Eval] Langfuse disabled - skipping OTEL init");
    return;
  }

  spanProcessor = new LangfuseSpanProcessor({
    secretKey: config.LANGFUSE_SECRET_KEY,
    publicKey: config.LANGFUSE_PUBLIC_KEY,
    baseUrl: config.LANGFUSE_BASE_URL,
  });

  sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();
  console.log("[Eval] OTEL initialized with Langfuse span processor");
}

async function shutdownOtel() {
  if (spanProcessor) {
    await spanProcessor.forceFlush();
  }
  if (sdk) {
    await sdk.shutdown();
  }
  console.log("[Eval] OTEL shutdown complete");
}

// ---------------------------------------------------------------------------
// Task function
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runFeedScannerTask(params: any): Promise<EvalOutput> {
  const input = params.input as FeedScannerInput;
  const sessionId = `eval-feed-scanner-${uuidv4()}`;

  // Build run record path
  const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const runRecordPath = `evals/feed-scanner/${timestamp}/run-record.jsonl`;
  const dirPath = runRecordPath.substring(0, runRecordPath.lastIndexOf("/"));

  console.log(`\n[Eval] Starting task | session=${sessionId}`);
  console.log(`[Eval]   runRecordPath=${runRecordPath}`);
  console.log(`[Eval]   input.xUsername=${input.xUsername}`);

  // Create clients
  let browserClient: BrowserUseMCPClient | null = null;
  let constellationClient: MCPClient | null = null;

  try {
    // 1. Browser MCP client
    browserClient = await createBrowserUseMCPClient();
    const browserTools = await browserClient!.tools();

    // 2. Constellation MCP client
    constellationClient = await createBackendMCPClient({
      userId: "default",
      workspace: "xmanager",
    });
    const constellationTools = await constellationClient.tools();

    // 3. Init run record file
    const backend = createBackend();
    try {
      const scope = backend.scope("xmanager");
      await scope.mkdir(dirPath);
      await scope.write(runRecordPath, "");
      console.log(`[Eval] Initialized empty run record: ${runRecordPath}`);
    } finally {
      await backend.destroy();
    }

    // 4. Build tool set
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { retry_with_browser_use_agent, ...filteredBrowserTools } = browserTools;
    const finishToolSet = createXManagerSubTaskFinishToolSet();
    const tools = {
      ...filteredBrowserTools,
      ...constellationTools,
      ...finishToolSet.tools,
    };

    // 5. Get skill prompt
    const { compiled: systemPrompt, promptObject: langfusePromptObject } =
      await getFeedScanPrompt({
        xUsername: input.xUsername,
        areasOfInterest: input.areasOfInterest,
        engagementCriteria: input.engagementCriteria,
        runRecordPath,
      });

    // 6. Execute via unified agent
    const agent = new UnifiedAgent({
      sessionId,
      maxSteps: 20,
    });

    await agent.execute("Begin your task.", {
      systemPrompt,
      tools,
      langfusePromptObject,
      functionId: "xmanager-feed-scanner",
    });

    // 7. Read back JSONL results
    const opportunities = await readOpportunities(runRecordPath);

    console.log(`[Eval] Task complete | found ${opportunities.length} opportunities`);

    return {
      opportunities,
      scanTimestamp: new Date().toISOString(),
      runRecordPath,
    };
  } finally {
    // Cleanup: close browser windows then clients
    if (browserClient) {
      try {
        const tools = await browserClient.tools();
        if (tools.browser_close_all) {
          await tools.browser_close_all.execute(
            {},
            { toolCallId: "eval-cleanup", messages: [] },
          );
        }
      } catch (err) {
        console.error("[Eval] Error closing browser windows:", err);
      }
      try {
        await browserClient.close();
      } catch (err) {
        console.error("[Eval] Error closing browser client:", err);
      }
    }
    if (constellationClient) {
      try {
        await constellationClient.close();
      } catch (err) {
        console.error("[Eval] Error closing constellation client:", err);
      }
    }
  }
}

/**
 * Read opportunities from the JSONL run record file.
 */
async function readOpportunities(
  runRecordPath: string,
): Promise<EngagementOpportunity[]> {
  const backend = createBackend();
  try {
    const scope = backend.scope("xmanager");
    const content = (await scope.read(runRecordPath)) as string;
    const lines = content.trim().split("\n").filter((l) => l.trim());

    const opportunities: EngagementOpportunity[] = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.type === "opportunity") {
          opportunities.push({
            author: item.author,
            authorHandle: item.authorHandle,
            text: item.text,
            link: item.link,
            reason: item.reason,
          });
        }
      } catch {
        console.warn(`[Eval] Failed to parse JSONL line: ${line}`);
      }
    }
    return opportunities;
  } finally {
    await backend.destroy();
  }
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

/**
 * Structure evaluator (programmatic).
 * Checks that each opportunity has non-empty required fields and a valid X URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function structureEvaluator(params: any) {
  const { opportunities } = params.output;

  if (opportunities.length === 0) {
    return {
      name: "structure",
      value: 0,
      comment: "No opportunities found",
    };
  }

  const xUrlPattern = /^https?:\/\/(twitter\.com|x\.com)\/.+\/status\/\d+/;
  let validCount = 0;
  const issues: string[] = [];

  for (let i = 0; i < opportunities.length; i++) {
    const opp = opportunities[i];
    const missing: string[] = [];

    if (!opp.author?.trim()) missing.push("author");
    if (!opp.authorHandle?.trim()) missing.push("authorHandle");
    if (!opp.text?.trim()) missing.push("text");
    if (!opp.link?.trim()) missing.push("link");
    else if (!xUrlPattern.test(opp.link)) missing.push("link (invalid X URL)");
    if (!opp.reason?.trim()) missing.push("reason");

    if (missing.length === 0) {
      validCount++;
    } else {
      issues.push(`[${i}] missing: ${missing.join(", ")}`);
    }
  }

  const score = validCount / opportunities.length;
  return {
    name: "structure",
    value: score,
    comment:
      score === 1
        ? `All ${opportunities.length} opportunities have valid structure`
        : `${validCount}/${opportunities.length} valid. Issues: ${issues.join("; ")}`,
  };
}

/**
 * Relevance evaluator (LLM-as-judge).
 * Scores how well opportunities match the stated areas of interest and engagement criteria.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function relevanceEvaluator(params: any) {
  const input = params.input as FeedScannerInput;
  const output = params.output as EvalOutput;
  const { opportunities } = output;

  if (opportunities.length === 0) {
    return {
      name: "relevance",
      value: 0,
      comment: "No opportunities to evaluate",
    };
  }

  const oppsText = opportunities
    .map(
      (o, i) =>
        `${i + 1}. @${o.authorHandle}: "${o.text}" | Reason: ${o.reason} | Link: ${o.link}`,
    )
    .join("\n");

  const { text } = await generateText({
    model: getModel(),
    prompt: `You are evaluating whether engagement opportunities found by an X feed scanner are relevant to the user's stated interests.

**Areas of Interest:**
${input.areasOfInterest}

**Engagement Criteria:**
${input.engagementCriteria}

**Opportunities Found:**
${oppsText}

Score the overall relevance from 0.0 to 1.0:
- 1.0 = All opportunities are highly relevant to the areas of interest and match the engagement criteria
- 0.5 = Mixed relevance, some match and some don't
- 0.0 = None are relevant

Respond with EXACTLY this JSON format (no other text):
{"score": <number>, "reasoning": "<brief explanation>"}`,
  });

  try {
    const result = JSON.parse(text);
    return {
      name: "relevance",
      value: Math.max(0, Math.min(1, result.score)),
      comment: result.reasoning,
    };
  } catch {
    console.warn("[Eval] Failed to parse relevance LLM response:", text);
    return {
      name: "relevance",
      value: 0,
      comment: `Failed to parse LLM response: ${text.substring(0, 200)}`,
    };
  }
}

/**
 * Quality evaluator (LLM-as-judge).
 * Evaluates reason specificity, author diversity, and actionability.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function qualityEvaluator(params: any) {
  const output = params.output as EvalOutput;
  const { opportunities } = output;

  if (opportunities.length === 0) {
    return {
      name: "quality",
      value: 0,
      comment: "No opportunities to evaluate",
    };
  }

  const oppsText = opportunities
    .map(
      (o, i) =>
        `${i + 1}. Author: ${o.author} (@${o.authorHandle}) | Text: "${o.text}" | Reason: ${o.reason} | Link: ${o.link}`,
    )
    .join("\n");

  const { text } = await generateText({
    model: getModel(),
    prompt: `You are evaluating the quality of engagement opportunities found by an X feed scanner.

**Opportunities Found:**
${oppsText}

Evaluate on these dimensions:
1. **Reason specificity** - Are the reasons detailed and specific, or generic/vague?
2. **Author diversity** - Are opportunities from different authors, or concentrated on one?
3. **Actionability** - Could a user clearly act on these (reply, quote tweet, etc.)?

Score the overall quality from 0.0 to 1.0:
- 1.0 = Excellent reasons, diverse authors, clearly actionable
- 0.5 = Adequate quality but room for improvement
- 0.0 = Poor quality, generic reasons, no diversity

Respond with EXACTLY this JSON format (no other text):
{"score": <number>, "reasoning": "<brief explanation>"}`,
  });

  try {
    const result = JSON.parse(text);
    return {
      name: "quality",
      value: Math.max(0, Math.min(1, result.score)),
      comment: result.reasoning,
    };
  } catch {
    console.warn("[Eval] Failed to parse quality LLM response:", text);
    return {
      name: "quality",
      value: 0,
      comment: `Failed to parse LLM response: ${text.substring(0, 200)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Feed Scanner Evaluation ===\n");

  // 1. Init OTEL
  initOtel();

  // 2. Create Langfuse client & fetch dataset
  const langfuse = new LangfuseClient();
  console.log("[Eval] Fetching dataset 'feed-scanner' from Langfuse...");
  const dataset = await langfuse.dataset.get("feed-scanner");
  console.log(`[Eval] Dataset loaded: ${dataset.items.length} items\n`);

  // 3. Run experiment
  const result = await dataset.runExperiment({
    name: "feed-scanner-eval",
    task: runFeedScannerTask,
    evaluators: [structureEvaluator, relevanceEvaluator, qualityEvaluator],
    maxConcurrency: 1,
  });

  // 4. Print results
  const formatted = await result.format({ includeItemResults: true });
  console.log("\n=== Results ===\n");
  console.log(formatted);

  if (result.datasetRunUrl) {
    console.log(`\nView in Langfuse: ${result.datasetRunUrl}`);
  }

  // 5. Shutdown
  await shutdownOtel();
}

main().catch((err) => {
  console.error("[Eval] Fatal error:", err);
  process.exit(1);
});
