/**
 * Agent Execution Service
 *
 * Orchestrates check-in and conversation executions.
 * Pre-fetches context (calendar, Notion), renders skill prompts,
 * invokes the Agent Runtime, and handles results.
 */

import type { AgentRuntime } from "../agents/runtime";
import type { MCPServerConfig } from "../agents/runtime";
import { CHECK_IN_OUTPUT_SCHEMA, type CheckInOutput } from "../agents/schemas";
import {
  renderCheckInPrompt,
  renderConversationPrompt,
} from "../agents/skills/check-in";
import {
  clearActiveRun,
  isRunActive,
  scheduleCheckIn,
  setActiveRun,
} from "../clients/redis-client";
import {
  formatEventsForPrompt,
  getTodayEvents,
} from "./gcal-service";
import {
  formatPagesForPrompt,
  getAllAccessiblePages,
} from "./notion-service";
import { getAppConfig } from "../config/app-config";
import { resolve } from "path";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentRunResult {
  success: boolean;
  messages: AgentMessage[];
  suggestedNextCheckIn?: Date;
  sessionId?: string;
  error?: string;
}

export class AgentExecutionService {
  private runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

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

  private getWorkspaceDir(userId: string): string {
    const config = getAppConfig();
    const workspaceRoot =
      config.WORKSPACE_ROOT ?? resolve(process.cwd(), "workspace");
    return resolve(workspaceRoot, userId);
  }

  private async fetchContext(): Promise<{
    calendarEvents: string;
    notionPages: string;
  }> {
    let calendarEvents: string;
    try {
      const events = await getTodayEvents();
      calendarEvents = formatEventsForPrompt(events);
    } catch (error) {
      console.error("[Agent] Error fetching calendar:", error);
      calendarEvents = "Unable to fetch calendar events.";
    }

    let notionPages: string;
    try {
      const pages = await getAllAccessiblePages();
      notionPages = formatPagesForPrompt(pages);
    } catch (error) {
      console.error("[Agent] Error fetching Notion:", error);
      notionPages = "Unable to fetch Notion pages.";
    }

    return { calendarEvents, notionPages };
  }

  private buildNotionMCPConfig(): Record<string, MCPServerConfig> | undefined {
    const config = getAppConfig();
    if (!config.NOTION_INTERNAL_TOKEN) return undefined;

    return {
      notion: {
        command: "npx",
        args: ["-y", "@notionhq/notion-mcp-server"],
        env: {
          ...process.env as Record<string, string>,
          NOTION_TOKEN: config.NOTION_INTERNAL_TOKEN,
        },
      },
    };
  }

  async executeCheckIn(
    userId: string = "default",
    conversationMessages?: AgentMessage[]
  ): Promise<AgentRunResult> {
    if (await isRunActive(userId)) {
      throw new Error("A check-in is already in progress");
    }

    await setActiveRun(userId);

    try {
      const context = await this.fetchContext();
      const currentTime = this.getCurrentTimePST();

      let prompt: string;
      if (conversationMessages && conversationMessages.length > 0) {
        const history = conversationMessages
          .map((m) => `[${m.role}]: ${m.content}`)
          .join("\n");
        prompt = renderCheckInPrompt({
          currentTime,
          calendarEvents: context.calendarEvents,
          notionPages: context.notionPages,
        });
        prompt += `\n\n## Previous Conversation:\n${history}\n\nPlease provide a helpful check-in response.`;
      } else {
        prompt = renderCheckInPrompt({
          currentTime,
          calendarEvents: context.calendarEvents,
          notionPages: context.notionPages,
        });
      }

      console.log("[Agent] Running check-in via", this.runtime.name);
      console.log("[Agent] Prompt preview:", prompt.substring(0, 300) + "...");

      const result = await this.runtime.execute({
        prompt,
        outputSchema: CHECK_IN_OUTPUT_SCHEMA,
        maxTurns: 20,
        workingDirectory: this.getWorkspaceDir(userId),
        mcpServers: this.buildNotionMCPConfig(),
      });

      if (result.error || !result.output) {
        console.error("[Agent] Runtime error:", result.error);
        return {
          success: false,
          messages: [],
          error: result.error ?? "Agent failed to produce structured output",
        };
      }

      const output = result.output as unknown as CheckInOutput;
      const responseMessage = output.message;
      const nextCheckInMinutes = output.nextCheckInTime ?? 120;

      console.log("[Agent] Response:", responseMessage.substring(0, 200) + "...");
      console.log("[Agent] Next check-in in:", nextCheckInMinutes, "minutes");

      const suggestedNextCheckIn = new Date(
        Date.now() + nextCheckInMinutes * 60 * 1000
      );
      await scheduleCheckIn(userId, suggestedNextCheckIn);

      return {
        success: true,
        messages: [{ role: "assistant", content: responseMessage }],
        suggestedNextCheckIn,
        sessionId: result.sessionId,
      };
    } finally {
      await clearActiveRun(userId);
    }
  }

  async continueConversation(
    userId: string,
    userMessage: string,
    previousMessages: AgentMessage[],
    resumeSessionId?: string
  ): Promise<AgentRunResult> {
    if (await isRunActive(userId)) {
      return {
        success: false,
        messages: [],
        error: "A check-in is already in progress",
      };
    }

    await setActiveRun(userId);

    try {
      console.log("[Agent] Continuing conversation...");
      console.log("[Agent] User message:", userMessage.substring(0, 100) + "...");
      console.log("[Agent] Previous messages:", previousMessages.length);
      if (resumeSessionId) {
        console.log("[Agent] Resuming session:", resumeSessionId);
      }

      let prompt: string;

      if (resumeSessionId) {
        // When resuming a session, just send the new user message.
        // The runtime has the full prior context from the original session.
        prompt = userMessage;
      } else {
        // Fresh conversation — build full context
        const context = await this.fetchContext();
        const currentTime = this.getCurrentTimePST();
        const history = previousMessages
          .map((m) => `[${m.role}]: ${m.content}`)
          .join("\n");

        prompt = renderConversationPrompt({
          currentTime,
          calendarEvents: context.calendarEvents,
          notionPages: context.notionPages,
          conversationHistory: history,
          userMessage,
        });
      }

      const result = await this.runtime.execute({
        prompt,
        outputSchema: CHECK_IN_OUTPUT_SCHEMA,
        maxTurns: 20,
        workingDirectory: this.getWorkspaceDir(userId),
        sessionId: resumeSessionId,
        mcpServers: this.buildNotionMCPConfig(),
      });

      let responseMessage: string;
      if (result.error || !result.output) {
        // Fall back to raw text if structured output failed
        responseMessage =
          result.rawText || "I apologize, but I wasn't able to respond properly.";
      } else {
        const output = result.output as unknown as CheckInOutput;
        responseMessage = output.message;
      }

      const agentMessages: AgentMessage[] = [...previousMessages];
      agentMessages.push({ role: "user", content: userMessage });
      agentMessages.push({ role: "assistant", content: responseMessage });

      return {
        success: true,
        messages: agentMessages,
        sessionId: result.sessionId,
      };
    } finally {
      await clearActiveRun(userId);
    }
  }
}

let agentExecutionServiceInstance: AgentExecutionService | null = null;

export function getAgentExecutionService(): AgentExecutionService {
  if (!agentExecutionServiceInstance) {
    // Lazy import to avoid circular dependencies
    const { createDefaultRuntime } = require("../agents/runtimes/factory");
    agentExecutionServiceInstance = new AgentExecutionService(
      createDefaultRuntime()
    );
  }
  return agentExecutionServiceInstance;
}
