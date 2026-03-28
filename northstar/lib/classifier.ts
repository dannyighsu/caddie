/**
 * Agent Classifier
 *
 * Lightweight LLM classifier that routes an incoming message to the right agent.
 * Uses OpenRouter for a fast, cheap classification call.
 */

import { listAgents } from "./harness";

interface ClassificationResult {
  agentId: string;
  agentName: string;
  confidence: "high" | "medium" | "low";
}

const FALLBACK_AGENT_ID = "checkin";

/**
 * Classify an incoming message to determine which agent should handle it.
 * Returns the agent ID and a confidence level.
 */
export async function classifyMessage(
  message: string
): Promise<ClassificationResult> {
  const agents = await listAgents();

  if (agents.length === 0) {
    return { agentId: FALLBACK_AGENT_ID, agentName: "Check-In Manager", confidence: "low" };
  }

  if (agents.length === 1) {
    return { agentId: agents[0].id, agentName: agents[0].name, confidence: "high" };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[Classifier] OPENROUTER_API_KEY not set, falling back to default agent");
    return { agentId: FALLBACK_AGENT_ID, agentName: "Check-In Manager", confidence: "low" };
  }

  // Build agent descriptions for the classifier
  const agentList = agents
    .filter((a) => a.mode !== "triggered") // Don't route to triggered-only agents
    .map((a) => `- ${a.id}: ${a.name}`)
    .join("\n");

  const prompt = `You are a message router. Given a user message, classify which agent should handle it.

Available agents:
${agentList}

User message: "${message}"

Respond with ONLY a JSON object: {"agentId": "<id>", "confidence": "high|medium|low"}
No explanation, no markdown, just the JSON.`;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-v3.2",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 50,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.error("[Classifier] OpenRouter error:", res.status, await res.text());
      return { agentId: FALLBACK_AGENT_ID, agentName: "Check-In Manager", confidence: "low" };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";

    // Parse JSON response
    const parsed = JSON.parse(content);
    const agentId = parsed.agentId;
    const confidence = parsed.confidence ?? "medium";

    // Validate agent exists
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      console.warn(`[Classifier] Unknown agent "${agentId}", falling back`);
      return { agentId: FALLBACK_AGENT_ID, agentName: "Check-In Manager", confidence: "low" };
    }

    return { agentId: agent.id, agentName: agent.name, confidence };
  } catch (err) {
    console.error("[Classifier] Failed:", err instanceof Error ? err.message : err);
    return { agentId: FALLBACK_AGENT_ID, agentName: "Check-In Manager", confidence: "low" };
  }
}
