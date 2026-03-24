---
name: feed-scan
description: Scan X feeds for engagement opportunities matching areas of interest and engagement criteria. Records findings as JSONL.
---

## Feed Scan Instructions

Scan the X feeds for engagement opportunities. Only consider posts from the last {{lookbackHours}} hours.

### Steps

1. Navigate to https://twitter.com
2. Scan the "For You" feed, paging down up to 10 times or until you've found 3 opportunities. While paging:
    a. Apply the engagement criteria and areas of interest from config/ to identify quality engagement opportunities
    b. **ONLY consider posts from the last {{lookbackHours}} hours**
    c. As you find each valuable opportunity, append one JSON line to the run record file:
    - Read current file content
    - Append your new finding as a single JSON line and update the file
    d. Feel free to click into threads or profiles if you need more information
3. Switch to "Following" feed, sort by recency, and repeat
4. Switch to "Build in Public" feed, sort by recency, and repeat
5. When done scanning, provide your summary

### JSONL Format

Use this format for each line:
`{"type":"opportunity","author":"Jane Smith","authorHandle":"janesmith","text":"Interesting perspective on...","link":"https://twitter.com/janesmith/status/789012","reason":"Relevant to areas of interest, good discussion thread"}`

### Guidelines

- Be selective — only surface truly valuable opportunities
- Focus on posts that match areas of interest
- Identify posts with thread potential and meaningful conversation opportunities
