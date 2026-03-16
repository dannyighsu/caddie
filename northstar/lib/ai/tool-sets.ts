/**
 * Tool Sets
 *
 * Composable tool set factories that can be merged depending on the execution context.
 * Each tool set is independently initializable and manages its own lifecycle.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  getTodayEvents,
  getUpcomingEvents,
  getEventsInRange,
  formatEventsForPrompt,
} from "../services/gcal-service";
import { createBackendMCPClient } from "./filesystems";
import { createNotionMCPClient } from "./notion-mcp";
import {
  createBrowserUseMCPClient,
} from "./browser-use-mcp-client";
import { finishTool } from "./agent-tools";

/**
 * A tool set with lifecycle management.
 * Call close() when done to release underlying resources (MCP clients, etc.).
 */
export interface ToolSetHandle {
  tools: ToolSet;
  close(): Promise<void>;
}

// ============================================================================
// Calendar Tools
// ============================================================================

export async function createCalendarToolSet(): Promise<ToolSetHandle> {
  const tools: ToolSet = {
    get_today_events: tool({
      description:
        "Fetch today's calendar events from Google Calendar. Returns formatted event list with times in PST.",
      inputSchema: z.object({}),
      execute: async () => {
        const events = await getTodayEvents();
        return formatEventsForPrompt(events);
      },
    }),
    get_upcoming_events: tool({
      description: "Fetch upcoming calendar events.",
      inputSchema: z.object({
        maxResults: z
          .number()
          .optional()
          .default(10)
          .describe("Maximum number of events to return"),
      }),
      execute: async ({ maxResults }) => {
        const events = await getUpcomingEvents(maxResults);
        return formatEventsForPrompt(events);
      },
    }),
    get_events_in_range: tool({
      description: "Fetch calendar events in a date range.",
      inputSchema: z.object({
        startDate: z
          .string()
          .describe("Start date in ISO 8601 format"),
        endDate: z
          .string()
          .describe("End date in ISO 8601 format"),
      }),
      execute: async ({ startDate, endDate }) => {
        const events = await getEventsInRange(
          new Date(startDate),
          new Date(endDate)
        );
        return formatEventsForPrompt(events);
      },
    }),
  };

  return { tools, close: async () => {} };
}

// ============================================================================
// Workspace (Filesystem) Tools — Constellation MCP
// ============================================================================

export async function createWorkspaceToolSet(options: {
  userId: string;
  workspace?: string;
}): Promise<ToolSetHandle> {
  const client = await createBackendMCPClient(options);
  const tools = await client.tools() as ToolSet;

  return {
    tools,
    close: () => client.close(),
  };
}

// ============================================================================
// Notion Tools — Notion MCP
// ============================================================================

export async function createNotionToolSet(
  userId: string
): Promise<ToolSetHandle> {
  const client = await createNotionMCPClient({ userId });
  if (!client) {
    return { tools: {}, close: async () => {} };
  }

  const tools = await client.tools() as ToolSet;
  return {
    tools,
    close: () => client.close(),
  };
}

// ============================================================================
// Browser Tools — browser-use MCP
// ============================================================================

export async function createBrowserToolSet(options?: {
  profileId?: string;
}): Promise<ToolSetHandle> {
  const client = await createBrowserUseMCPClient(options);
  if (!client) {
    return { tools: {}, close: async () => {} };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: any = await client.tools();

  // Exclude retry_with_browser_use_agent to maintain authenticated sessions
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { retry_with_browser_use_agent, ...filteredTools } = allTools;

  return {
    tools: filteredTools as ToolSet,
    close: async () => {
      // Close browser windows first, then the MCP client
      if (allTools.browser_close_all) {
        try {
          await allTools.browser_close_all.execute(
            {},
            { toolCallId: "toolset-cleanup", messages: [] }
          );
        } catch (err) {
          console.error("[ToolSets] Error closing browser windows:", err);
        }
      }
      await client.close();
    },
  };
}

// ============================================================================
// Finish Tools
// ============================================================================

export function createCheckinFinishToolSet(): ToolSetHandle {
  return {
    tools: { finish: finishTool },
    close: async () => {},
  };
}

export function createXManagerSubTaskFinishToolSet(): ToolSetHandle {
  const subTaskFinishTool = tool({
    description:
      "Signal that you have completed your task. All findings should already be written to the run record file.",
    inputSchema: z.object({
      completed: z
        .boolean()
        .describe("Set to true to signal completion")
        .default(true),
    }),
    execute: async (input) => input,
  });

  return {
    tools: { finish: subTaskFinishTool },
    close: async () => {},
  };
}

// ============================================================================
// Composition Utilities
// ============================================================================

/**
 * Merge multiple tool set handles into one.
 * The merged handle's close() calls all underlying close() methods.
 */
export function mergeToolSets(...handles: ToolSetHandle[]): ToolSetHandle {
  return {
    tools: Object.assign({}, ...handles.map((h) => h.tools)),
    async close() {
      await Promise.all(handles.map((h) => h.close()));
    },
  };
}
