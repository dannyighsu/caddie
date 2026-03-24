---
name: metrics-check
description: Check performance metrics on recent X posts. Records findings as JSONL.
---

## Metrics Check Instructions

Check metrics on recent posts (last {{lookbackHours}} hours).

### Steps

1. Navigate to https://twitter.com/{{xUsername}}
2. Identify posts from the last {{lookbackHours}} hours
3. Click into each post to view full metrics
4. As you collect metrics for each post, append one JSON line to the run record file:
   - Read current file content
   - Append your new finding as a single JSON line and update the file
5. When done, provide your summary

### JSONL Format

Use this format for each line:
`{"type":"metric","postLink":"https://twitter.com/username/status/123456","postText":"My recent post about...","impressions":1250,"likes":42,"replies":8,"retweets":12,"engagementRate":4.96}`

### Guidelines

- Focus on posts within the lookback window
- If no recent posts exist, just provide a summary noting no posts found
- Capture all available metrics for each post (omit fields that aren't available)
