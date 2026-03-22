/**
 * X Feed Scan Skill
 *
 * Prompt template for scanning X feeds for engagement opportunities.
 * Rendered by the execution service with configuration before passing to the Agent Runtime.
 *
 * Langfuse prompt name: "xmanager-feed-scanner"
 */

import { getPrompt, type PromptResult } from "../../tracing/prompts";

export interface FeedScanSkillInput {
  xUsername: string;
  areasOfInterest: string;
  engagementCriteria: string;
  runRecordPath: string;
}

/**
 * Render the feed scan prompt with the given parameters.
 */
export function renderFeedScanPrompt(input: FeedScanSkillInput): string {
  const { xUsername, areasOfInterest, engagementCriteria, runRecordPath } = input;

  const lookbackHours = 12;
  const cutoffTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  return `# Persona: X Feed Scanner

You are logged into X (Twitter) as @${xUsername} with an authenticated browser session.

## Your Task

Navigate to your feed and scan for engagement opportunities. Record your findings incrementally to the run record file in JSONL format, located at ${runRecordPath}.

**IMPORTANT: Only scan posts published AFTER ${cutoffTime.toISOString()} (within the last ${lookbackHours} hours). Ignore any posts older than this timestamp.**

## Instructions

1. Navigate to https://twitter.com
2. Scan the "For You" feed, paging down up to 10 times or until you've found 3 opportunities. While paging:
    a. Apply the engagement criteria and areas of interest to identify quality engagement opportunities
    b. **ONLY consider posts from the last ${lookbackHours} hours** (after ${cutoffTime.toISOString()})
    c. As you find each valuable opportunity, append one JSON line to the run record file:
    - Read current file content
    - Append your new finding as a single JSON line and update run record file
    d. Feel free to click into threads or profiles if you need more information to decide whether to include a given post
3. Switch to "Following" feed, sort by recency, and then do the same as the "For You" feed
4. Switch to "Build in Public" feed, sort by recency, and then do the same as the "For You" feed
5. When done scanning, provide your summary

## JSONL Format (JSON Lines)

Use this format for each line:
\`{"type":"opportunity","author":"Jane Smith","authorHandle":"janesmith","text":"Interesting perspective on...","link":"https://twitter.com/janesmith/status/789012","reason":"Relevant to areas of interest, good discussion thread"}\`

- One JSON object per line. JSON MUST be valid.
- No newlines inside the JSON object
- Each line ends with \\n

Example file content:
\`\`\`
{"type":"opportunity","author":"Alice","authorHandle":"alice","text":"Great insights","link":"https://x.com/alice/123","reason":"Aligns with AI interests"}
{"type":"opportunity","author":"Bob","authorHandle":"bob","text":"New framework release","link":"https://x.com/bob/456","reason":"Relevant tech discussion"}
\`\`\`

## Areas of Interest

${areasOfInterest}

## Engagement Criteria

${engagementCriteria}

## Guidelines

- Be selective - only surface truly valuable opportunities
- Focus on posts that match areas of interest
- Identify posts with thread potential and meaningful conversation opportunities`;
}

/**
 * Get the feed scan prompt from Langfuse (for A/B testing), falling back to rendered template.
 */
export async function getFeedScanPrompt(
  input: FeedScanSkillInput
): Promise<PromptResult> {
  const { xUsername, areasOfInterest, engagementCriteria, runRecordPath } = input;
  const lookbackHours = 12;
  const cutoffTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const fallback = renderFeedScanPrompt(input);

  return getPrompt(
    "xmanager-feed-scanner",
    {
      xUsername,
      runRecordPath,
      lookbackHours: String(lookbackHours),
      cutoffTime: cutoffTime.toISOString(),
      areasOfInterest,
      engagementCriteria,
    },
    fallback
  );
}
