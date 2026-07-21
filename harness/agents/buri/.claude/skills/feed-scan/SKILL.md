---
name: feed-scan
description: Scan X feeds for engagement opportunities. Finds posts worth replying to based on areas of interest and engagement criteria.
---

## Feed Scan

You are logged into X (Twitter) with an authenticated browser session.

Your job is to find engagement opportunities — posts worth replying to. You must find **at least 1** opportunity (and ideally several).

## Scanning Process

### Step 1: Scan feeds

Navigate to https://twitter.com and scan both feeds:

1. **Following feed** — switch to Following, scroll at least 5 times
2. **For You feed** — switch to For You, scroll at least 5 times

Also check the **sidebar trending/news topics** — click into any current news stories relevant to your areas of interest.

### Step 2: Fallback search (if no opportunities found)

If you haven't found any opportunities from the feeds, do NOT give up. Instead:
1. Use web search to find current hot topics in your areas of interest
2. Search X directly for those topics
3. Find posts with active discussion on those topics

### Step 3: Report findings

For each opportunity, provide:
- Brief description of the post
- Link to the post
- 2-3 suggested engagement ideas (what to reply with)
- How you found it (e.g., "Found via Following feed", "Searched for 'AI security' after no feed hits")

## Filtering Criteria

**Time window**: Posts from the last 6 hours only.

**Poster profile** (hover over the poster's name to check):
- Follower count between 1K and 100K
- Must be an **individual**, not an organization (skip TechCrunch, Google, AWS, etc.)
- Check the **original poster**, not whoever retweeted

**Post quality**:
- Prefer highly technical posts — these have material to engage on
- Prefer posts with bold statements or strong opinions
- Must have potential for meaningful conversation
- Must be within or adjacent to areas of interest

**Skip**:
- Ads
- Retweets where the original poster doesn't meet criteria
- Posts from organizations/brands
- Low-effort content (memes, engagement bait)

## Config

Before starting the scan, read these files from the working directory using the Read tool:
1. `config/x_username.txt` — the X account username you are logged in as
2. `config/areas_of_interest.md` — defines your topic focus
3. `config/engagement_criteria.md` — defines filtering and engagement style rules

Use the content of these files to guide your scanning and filtering.

## Recording

Record each opportunity to the run record file as JSONL. The run record path will be provided by the user. Create the directory if needed.

```
{"type":"opportunity","author":"Jane Smith","authorHandle":"janesmith","followerCount":"12.5K","text":"Bold take: most AI agent frameworks are just wrappers around...","link":"https://x.com/janesmith/status/789012","suggestedEngagement":["Challenge the premise with a specific counterexample","Share your experience building production agents","Ask about their framework evaluation criteria"],"discoveryMethod":"Found on Following feed, 3rd scroll"}
```

## Posting Results

After completing the scan, post a summary to Slack using the `post_to_slack` tool with `from` set to `"Feed Scan"`.

The message should include:
- A count of opportunities found
- For each opportunity: the author handle, follower count, a short snippet of the post, suggested engagement ideas, and a link to the post
- If no opportunities were found, a brief note explaining what was scanned

## Engagement Execution

If the user reviews the opportunities and **explicitly approves** a reply (e.g., "yes go ahead and reply with that", "reply with ..."), then:
1. Navigate to the post
2. Post the reply on behalf of the user
3. Confirm the reply was posted
4. Include a link to the reply

Do NOT post replies unless the user explicitly approves. Suggesting engagement ideas is not the same as approval.
