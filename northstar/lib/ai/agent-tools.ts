import { tool } from "ai";
import { z } from "zod";

/**
 * Finish tool - call this when the agent has completed its task.
 * Returns structured output with the message and next check-in time.
 */
export const finishTool = tool({
  description:
    "Call this tool when you are done with the check-in or conversation. Provide your final message to the user and suggest when the next check-in should be.",
  inputSchema: z.object({
    message: z
      .string()
      .describe("The message to send to the user"),
    nextCheckInTime: z
      .number()
      .describe(
        "The time to schedule the next check-in, in minutes from now. For example, 60 for 1 hour, 120 for 2 hours."
      ),
  }),
  execute: async ({ message, nextCheckInTime }) => {
    // The execute function returns the structured output
    // We'll extract this from the tool results in the agent loop
    return { message, nextCheckInTime };
  },
});

export type FinishToolResult = {
  message: string;
  nextCheckInTime: number;
};
