/**
 * Agent Classifier
 *
 * Routes an incoming message to the right agent profile.
 * Uses OpenRouter for a fast, cheap classification call.
 */

import { listAgents } from "./harness";
import type { AgentConfig } from "@agints/harness";

export interface ClassificationResult {
  agentId: string;
  profile?: string;
  label: string;
  confidence: "high" | "medium" | "low";
}

const FALLBACK: ClassificationResult = {
  agentId: "buri",
  label: "Buri",
  confidence: "low",
};

/**
 * Build the list of routable profiles from agent configs.
 */
function buildProfileList(agents: AgentConfig[]): Array<{ agentId: string; profile?: string; label: string; description: string }> {
  const entries: Array<{ agentId: string; profile?: string; label: string; description: string }> = [];

  for (const agent of agents) {
    // Base agent (no profile)
    entries.push({
      agentId: agent.id,
      label: agent.name,
      description: `Default — capabilities: ${agent.capabilities.join(", ")}`,
    });

    // Each profile
    if (agent.profiles) {
      for (const [profileName, profile] of Object.entries(agent.profiles)) {
        entries.push({
          agentId: agent.id,
          profile: profileName,
          label: `${agent.name} (${profileName})`,
          description: `capabilities: ${(profile.capabilities ?? agent.capabilities).join(", ")}`,
        });
      }
    }
  }

  return entries;
}

/**
 * Classify an incoming message to determine which agent profile should handle it.
 */
export async function classifyMessage(
  message: string
): Promise<ClassificationResult> {
  const agents = await listAgents();

  if (agents.length === 0) {
    return FALLBACK;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[Classifier] OPENROUTER_API_KEY not set, falling back to default");
    return FALLBACK;
  }

  const profiles = buildProfileList(agents);
  const profileList = profiles
    .map((p) => `- ${p.agentId}${p.profile ? `:${p.profile}` : ""} — ${p.label} (${p.description})`)
    .join("\n");

  const prompt = `You are a message router. Given a user message, classify which agent profile should handle it.

Available profiles:
${profileList}

Rules:
- If the message is about X/Twitter, social media engagement, or posting, route to the xmanager profile.
- If the message is about writing articles, blog posts, or content creation, route to the writer profile.
- For general questions, tasks, scheduling, or check-ins, route to the default (no profile).

User message: "${message}"

Respond with ONLY a JSON object: {"agentId": "<id>", "profile": "<profile or null>", "confidence": "high|medium|low"}
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
        max_tokens: 80,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.error("[Classifier] OpenRouter error:", res.status, await res.text());
      return FALLBACK;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";

    const parsed = JSON.parse(content);
    const agentId = parsed.agentId;
    const profile = parsed.profile === "null" || !parsed.profile ? undefined : parsed.profile;
    const confidence = parsed.confidence ?? "medium";

    // Validate
    const match = profiles.find(
      (p) => p.agentId === agentId && (p.profile ?? undefined) === profile
    );
    if (!match) {
      console.warn(`[Classifier] Unknown profile "${agentId}:${profile}", falling back`);
      return FALLBACK;
    }

    return { agentId: match.agentId, profile: match.profile, label: match.label, confidence };
  } catch (err) {
    console.error("[Classifier] Failed:", err instanceof Error ? err.message : err);
    return FALLBACK;
  }
}
