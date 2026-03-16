import { StepResult, ToolSet } from "ai";
import { UnifiedAgent } from "../agents/unified-agent";
import { getCheckInPrompt } from "../agents/skills/check-in";
import {
  createCalendarToolSet,
  createCheckinFinishToolSet,
  createNotionToolSet,
  createWorkspaceToolSet,
  mergeToolSets,
  type ToolSetHandle,
} from "../ai/tool-sets";
import type { FinishToolResult } from "../ai/agent-tools";
import {
  clearActiveRun,
  isRunActive,
  scheduleCheckIn,
  setActiveRun,
} from "../clients/redis-client";
import {
  flushLangfuse,
  generateSessionId,
  withLangfuseSession,
} from "../tracing/langfuse";
import {
  formatEventsForPrompt,
  getTodayEvents,
} from "./gcal-service";
import {
  formatPagesForPrompt,
  getAllAccessiblePages,
} from "./notion-service";

// Track step numbers for logging
let stepCounter = 0;

/**
 * Format and log step result with detailed information
 */
function logStepResult<T extends ToolSet>(stepResult: StepResult<T>): void {
  stepCounter++;
  const stepNum = stepCounter;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[Agent] Step ${stepNum} | Finish Reason: ${stepResult.finishReason}`);
  console.log(`${"=".repeat(60)}`);

  // Log reasoning if present
  if (stepResult.reasoningText) {
    console.log(`\n[Agent] Reasoning:`);
    const truncatedReasoning = stepResult.reasoningText.length > 2000
      ? stepResult.reasoningText.substring(0, 2000) + "... (truncated)"
      : stepResult.reasoningText;
    console.log(truncatedReasoning);
  }

  // Log text output if present
  if (stepResult.text) {
    console.log(`\n[Agent] Text Output:`);
    const truncatedText = stepResult.text.length > 2000
      ? stepResult.text.substring(0, 2000) + "... (truncated)"
      : stepResult.text;
    console.log(truncatedText);
  }

  // Log tool calls and match with results
  if (stepResult.toolCalls.length > 0) {
    console.log(`\n[Agent] Tool Calls (${stepResult.toolCalls.length}):`);

    // Create a map of tool results by ID for easy lookup
    const resultsByCallId = new Map<string, { output: unknown }>();
    for (const result of stepResult.toolResults) {
      resultsByCallId.set(result.toolCallId, { output: result.output });
    }

    for (const call of stepResult.toolCalls) {
      console.log(`\n  ┌─ Tool: ${call.toolName}`);
      console.log(`  │  ID: ${call.toolCallId}`);

      // Format input
      const inputStr = JSON.stringify(call.input, null, 2);
      const truncatedInput = inputStr.length > 500
        ? inputStr.substring(0, 500) + "... (truncated)"
        : inputStr;
      console.log(`  │  Input: ${truncatedInput.replace(/\n/g, "\n  │  ")}`);

      // Find and display matching result
      const matchingResult = resultsByCallId.get(call.toolCallId);
      if (matchingResult) {
        const outputStr = JSON.stringify(matchingResult.output, null, 2);
        const truncatedOutput = outputStr.length > 500
          ? outputStr.substring(0, 500) + "... (truncated)"
          : outputStr;
        console.log(`  │  Output: ${truncatedOutput.replace(/\n/g, "\n  │  ")}`);
      } else {
        console.log(`  │  Output: (pending or not available)`);
      }
      console.log(`  └─`);
    }
  }

  // Log usage stats
  if (stepResult.usage) {
    console.log(`\n[Agent] Token Usage: input=${stepResult.usage.inputTokens ?? 0}, output=${stepResult.usage.outputTokens ?? 0}, total=${stepResult.usage.totalTokens ?? 0}`);
  }

  // Log any warnings
  if (stepResult.warnings && stepResult.warnings.length > 0) {
    console.log(`\n[Agent] Warnings:`);
    for (const warning of stepResult.warnings) {
      console.log(`  - ${JSON.stringify(warning)}`);
    }
  }

  console.log(`${"=".repeat(60)}\n`);
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentRunResult {
  success: boolean;
  messages: AgentMessage[];
  suggestedNextCheckIn?: Date;
  error?: string;
}

export class AgentExecutionService {
  private getCurrentTimePST(): string {
    const now = new Date();
    return now.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  private async buildContextPrompt(
    isCheckIn: boolean,
    conversationMessages?: AgentMessage[]
  ): Promise<string> {
    const parts: string[] = [];

    // Current time
    parts.push(`Current time (PST): ${this.getCurrentTimePST()}`);
    parts.push("");

    // Google Calendar events
    try {
      const events = await getTodayEvents();
      const gcalContext = formatEventsForPrompt(events);
      parts.push("## Today's Calendar");
      parts.push(gcalContext);
      parts.push("");
    } catch (error) {
      console.error("[Agent] Error fetching calendar:", error);
      parts.push("## Today's Calendar");
      parts.push("Unable to fetch calendar events.");
      parts.push("");
    }

    // Notion pages - fetch ALL accessible pages (not just 5)
    try {
      const pages = await getAllAccessiblePages();
      const notionContext = formatPagesForPrompt(pages);
      parts.push("## Notion Pages (All Accessible)");
      parts.push(notionContext);
      parts.push("");
    } catch (error) {
      console.error("[Agent] Error fetching Notion:", error);
      parts.push("## Notion Pages (All Accessible)");
      parts.push("Unable to fetch Notion pages.");
      parts.push("");
    }

    // Conversation messages
    if (conversationMessages && conversationMessages.length > 0) {
      parts.push("## Recent Messages to Review");
      for (const msg of conversationMessages) {
        parts.push(`[${msg.role}]: ${msg.content}`);
      }
      parts.push("");
    }

    if (isCheckIn) {
      parts.push(`You are conducting a check-in with the user.`);
    } else {
      parts.push(`Reply to the user's message.`);
    }

    return parts.join("\n");
  }

  /**
   * Create the tool sets for a check-in or conversation execution.
   */
  private async createCheckinToolSets(userId: string): Promise<ToolSetHandle> {
    const [calendarTools, notionTools, workspaceTools, finishTools] =
      await Promise.all([
        createCalendarToolSet(),
        createNotionToolSet(userId),
        createWorkspaceToolSet({ userId }),
        Promise.resolve(createCheckinFinishToolSet()),
      ]);

    return mergeToolSets(calendarTools, notionTools, workspaceTools, finishTools);
  }

  async executeCheckIn(
    userId: string = "default",
    conversationMessages?: AgentMessage[]
  ): Promise<AgentRunResult> {
    // Check if a run is already active
    if (await isRunActive(userId)) {
      throw new Error("A check-in is already in progress");
    }

    // Mark run as active
    await setActiveRun(userId);

    // Generate session ID for this run
    const sessionId = generateSessionId("northstar-checkin");

    // Track tool set handle for cleanup — using an object wrapper
    // to avoid TypeScript's control flow narrowing in finally blocks
    const cleanup = { toolSetHandle: null as ToolSetHandle | null };

    try {
      // Wrap entire execution in Langfuse session context
      return await withLangfuseSession(
        { sessionId, agentType: "northstar", runType: "check-in" },
        async () => {
          // Build context from calendar and Notion
          const context = await this.buildContextPrompt(true, conversationMessages);

          // Build prompt with conversation history included as text
          let prompt = `Here is the current context for the check-in:\n\n${context}`;

          // Add conversation history to the prompt if available
          if (conversationMessages && conversationMessages.length > 0) {
            prompt += "\n\n## Previous Conversation:\n";
            for (const msg of conversationMessages) {
              prompt += `\n[${msg.role}]: ${msg.content}`;
            }
          }

          prompt += "\n\nPlease provide a helpful check-in response. When you are done, call the 'finish' tool with your message and suggested next check-in time.";

          console.log("[Agent] Running Vercel AI SDK inference...");
          console.log("[Agent] Session ID:", sessionId);
          console.log("[Agent] Prompt preview:", prompt.substring(0, 300) + "...");

          // Reset step counter for this execution
          stepCounter = 0;

          // Create tool sets
          cleanup.toolSetHandle = await this.createCheckinToolSets(userId);

          // Get system prompt from skill module
          const { compiled: systemPrompt, promptObject: langfusePromptObject } =
            await getCheckInPrompt();

          // Create and run the unified agent
          const agent = new UnifiedAgent({
            sessionId,
            onStepFinish: logStepResult,
          });

          const result = await agent.execute(prompt, {
            systemPrompt,
            tools: cleanup.toolSetHandle.tools,
            langfusePromptObject,
            functionId: "northstar-agent",
          });

          let responseMessage = "";
          let nextCheckInMinutes = 120; // Default 2 hours

          // Extract finish result from steps
          const finishResult = this.extractFinishResult(result.steps);
          if (finishResult) {
            responseMessage = finishResult.message;
            nextCheckInMinutes = finishResult.nextCheckInTime;
          } else {
            // Fallback to text response if no finish tool was called
            responseMessage = result.text || "I apologize, but I wasn't able to complete the check-in properly.";
          }

          console.log("[Agent] Response:", responseMessage.substring(0, 200) + "...");
          console.log("[Agent] Next check-in in:", nextCheckInMinutes, "minutes");

          const agentMessages: AgentMessage[] = [
            {
              role: "assistant",
              content: responseMessage,
            },
          ];

          // Schedule the next check-in
          const suggestedNextCheckIn = new Date(Date.now() + nextCheckInMinutes * 60 * 1000);
          await scheduleCheckIn(userId, suggestedNextCheckIn);

          return {
            success: true,
            messages: agentMessages,
            suggestedNextCheckIn,
          };
        }
      );
    } finally {
      if (cleanup.toolSetHandle) {
        await cleanup.toolSetHandle.close();
      }
      await clearActiveRun(userId);
      // Flush traces before function returns
      await flushLangfuse();
    }
  }

  async continueConversation(
    userId: string,
    userMessage: string,
    previousMessages: AgentMessage[]
  ): Promise<AgentRunResult> {
    if (await isRunActive(userId)) {
      return {
        success: false,
        messages: [],
        error: "A check-in is already in progress",
      };
    }

    await setActiveRun(userId);

    // Generate session ID for this conversation turn
    const sessionId = generateSessionId("northstar-conversation");

    const cleanup = { toolSetHandle: null as ToolSetHandle | null };

    try {
      // Wrap entire execution in Langfuse session context
      return await withLangfuseSession(
        { sessionId, agentType: "northstar", runType: "conversation" },
        async () => {
          console.log("[Agent] Continuing conversation...");
          console.log("[Agent] Session ID:", sessionId);
          console.log("[Agent] User message:", userMessage.substring(0, 100) + "...");
          console.log("[Agent] Previous messages:", previousMessages.length);

          // Build context from calendar and Notion
          const context = await this.buildContextPrompt(false, previousMessages);

          // Build prompt with context and conversation history
          let prompt = `Here is the current context:\n\n${context}`;

          // Add conversation history
          prompt += "\n\n## Previous Conversation:\n";
          for (const msg of previousMessages) {
            prompt += `\n[${msg.role}]: ${msg.content}`;
          }
          prompt += `\n\n[user]: ${userMessage}\n\nPlease respond to the user's message. When you are done, call the 'finish' tool with your response.`;

          console.log("[Agent] Prompt preview:", prompt.substring(0, 300) + "...");

          // Reset step counter for this execution
          stepCounter = 0;

          // Create tool sets
          cleanup.toolSetHandle = await this.createCheckinToolSets(userId);

          // Get system prompt from skill module
          const { compiled: systemPrompt, promptObject: langfusePromptObject } =
            await getCheckInPrompt();

          // Create and run the unified agent
          const agent = new UnifiedAgent({
            sessionId,
            onStepFinish: logStepResult,
          });

          const result = await agent.execute(prompt, {
            systemPrompt,
            tools: cleanup.toolSetHandle.tools,
            langfusePromptObject,
            functionId: "northstar-agent",
          });

          let responseMessage = "";

          // Extract finish result from steps
          const finishResult = this.extractFinishResult(result.steps);
          if (finishResult) {
            responseMessage = finishResult.message;
          } else {
            // Fallback to text response if no finish tool was called
            responseMessage = result.text || "I apologize, but I wasn't able to respond properly.";
          }

          // Build updated message list
          const agentMessages: AgentMessage[] = [...previousMessages];
          agentMessages.push({ role: "user", content: userMessage });
          agentMessages.push({ role: "assistant", content: responseMessage });

          return {
            success: true,
            messages: agentMessages,
          };
        }
      );
    } finally {
      if (cleanup.toolSetHandle) {
        await cleanup.toolSetHandle.close();
      }
      await clearActiveRun(userId);
      // Flush traces before function returns
      await flushLangfuse();
    }
  }

  /**
   * Extract the finish tool result from agent steps.
   */
  private extractFinishResult(
    steps: Array<{ toolResults: Array<{ toolName: string; output: unknown }> }>
  ): FinishToolResult | null {
    for (const step of steps) {
      for (const toolResult of step.toolResults) {
        if (toolResult.toolName === "finish") {
          return toolResult.output as FinishToolResult;
        }
      }
    }
    return null;
  }
}

let agentExecutionServiceInstance: AgentExecutionService | null = null;

export function getAgentExecutionService(): AgentExecutionService {
  if (!agentExecutionServiceInstance) {
    agentExecutionServiceInstance = new AgentExecutionService();
  }
  return agentExecutionServiceInstance;
}
