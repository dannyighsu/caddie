/**
 * Structured Output Schemas
 *
 * JSON Schemas passed to the Agent Runtime for structured output validation.
 * Each execution mode has its own schema defining the expected output shape.
 */

/** Check-in / Conversation output schema */
export const CHECK_IN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The agent's response to the user.",
    },
    nextCheckInTime: {
      type: "number",
      description:
        "Minutes until the next scheduled check-in. Omit or set to null for conversation mode.",
    },
  },
  required: ["message"],
} as const;

/** X Manager sub-task output schema (feed scan, metrics check) */
export const XMANAGER_SUBTASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Brief summary of what the sub-task accomplished.",
    },
    itemsFound: {
      type: "number",
      description: "Number of items written to the run record.",
    },
  },
  required: ["summary", "itemsFound"],
} as const;

/** X Manager orchestration output schema (not used directly — orchestration is in the execution service) */
export const XMANAGER_ORCHESTRATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    slackMessage: {
      type: "string",
      description: "Slack-formatted digest of the run.",
    },
    runRecordPath: {
      type: "string",
      description: "Path to the JSONL run record file.",
    },
    nextRunMinutes: {
      type: "number",
      description: "Minutes until the next scheduled X Manager run.",
    },
  },
  required: ["slackMessage", "runRecordPath"],
} as const;

/** Typed output interfaces */
export interface CheckInOutput {
  message: string;
  nextCheckInTime?: number;
}

export interface XManagerSubTaskOutput {
  summary: string;
  itemsFound: number;
}
