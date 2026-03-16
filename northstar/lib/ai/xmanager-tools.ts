import { tool } from "ai";
import { z } from "zod";

/**
 * Schema for a reply that needs attention
 */
const replySchema = z.object({
  author: z.string().describe("Display name of the reply author"),
  authorHandle: z.string().describe("X handle of the reply author (without @)"),
  text: z.string().describe("Reply text, truncated to 200 characters"),
  link: z.string().describe("Direct link to the reply"),
  priority: z
    .enum(["high", "medium", "low"])
    .describe("Priority level based on engagement criteria"),
  reason: z.string().describe("Brief reason why this reply needs attention"),
});

/**
 * Schema for an engagement opportunity
 */
const opportunitySchema = z.object({
  author: z.string().describe("Display name of the post author"),
  authorHandle: z.string().describe("X handle of the post author (without @)"),
  text: z.string().describe("Post text, truncated to 200 characters"),
  link: z.string().describe("Direct link to the post"),
  reason: z.string().describe("Why this is a good engagement opportunity"),
});

/**
 * Schema for performance metrics on a post
 */
const performanceSchema = z.object({
  postLink: z.string().describe("Link to the post"),
  postText: z
    .string()
    .optional()
    .describe("Brief excerpt of the post for context"),
  impressions: z.number().optional().describe("Number of impressions"),
  likes: z.number().optional().describe("Number of likes"),
  replies: z.number().optional().describe("Number of replies"),
  retweets: z.number().optional().describe("Number of retweets/reposts"),
  engagementRate: z
    .number()
    .optional()
    .describe("Engagement rate as percentage"),
});

/**
 * X Manager finish tool - call this when the X scan is complete.
 * Returns structured output for Slack messaging and state persistence.
 *
 * Note: Insights files are managed directly by the agent via filesystem MCP tools,
 * not through this finish tool.
 */
export const xManagerFinishTool = tool({
  description:
    "Call this tool when you have completed scanning X notifications and feed. Provide the Slack message and structured run data.",
  inputSchema: z.object({
    slackMessage: z
      .string()
      .describe("The formatted Slack message to send to the user"),
    runRecord: z
      .object({
        timestamp: z.string().describe("ISO timestamp of when the scan was run"),
        repliesFound: z
          .array(replySchema)
          .describe("Replies to user's posts that need attention"),
        opportunitiesFound: z
          .array(opportunitySchema)
          .describe("Posts worth engaging with"),
        performanceMetrics: z
          .array(performanceSchema)
          .optional()
          .describe("Performance data for recent posts"),
        summary: z
          .string()
          .optional()
          .describe("Brief summary of insights from this run"),
      })
      .describe("Structured record of the run for storage"),
    nextRunMinutes: z
      .number()
      .default(60)
      .describe("Minutes until next scheduled run (default 60 minutes)"),
  }),
  execute: async (input) => {
    return input;
  },
});

export type XManagerFinishToolResult = {
  slackMessage: string;
  runRecord: {
    timestamp: string;
    repliesFound: Array<{
      author: string;
      authorHandle: string;
      text: string;
      link: string;
      priority: "high" | "medium" | "low";
      reason: string;
    }>;
    opportunitiesFound: Array<{
      author: string;
      authorHandle: string;
      text: string;
      link: string;
      reason: string;
    }>;
    performanceMetrics?: Array<{
      postLink: string;
      postText?: string;
      impressions?: number;
      likes?: number;
      replies?: number;
      retweets?: number;
      engagementRate?: number;
    }>;
    summary?: string;
  };
  nextRunMinutes: number;
};
