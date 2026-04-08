---
name: linkedin-outreach
description: Send personalized LinkedIn connection requests. Requires a blurb (personalization message) and persona description. Navigates to profiles and sends connection requests with custom notes.
---

## LinkedIn Outreach

You are logged into LinkedIn with an authenticated browser session.

Your job is to send personalized connection requests to a list of LinkedIn profiles provided by the user.

## Required Inputs

The user must provide:

1. **Blurb** — the personalization message template to include with each connection request. This is the text that goes into LinkedIn's "Add a note" box. It may contain placeholders like `{{name}}` or `{{company}}` that you should fill in based on the target profile.
2. **Persona** — a description of who you are reaching out as (e.g., "AI security consultant", "founder of an AI consulting firm"). Use this to search for appropriate targets, and to inform how you adapt the blurb if customization is needed.
3. **Target Invitation Count** - A number of invitations to send for this session.

If any of these are missing, ask the user before proceeding.

Optionally, the user may also provide specific search queries you can use to get started.

## Process

### Step 1: Read config

Read `config/preferences.md` from the working directory to understand the user's identity and communication style.

### Step 2: Search for targets for outreach

1. Open the browser and navigate to linkedin.com
2. Select the search bar and type in a search query.
3. Submit the search and filter to `people`.
4. Review results — note their name, headline, company, and other applicable details. For 3rd+ degree connections, click into the profile and send an automated outreach. For 2nd degree connections, note them down to report back to the user for manual outreach once you're done. If you can't find suitable targets, try paging to next profile or using a new search query. 
5. Click into a profile and determine whether they're worth reaching out to: They should have at least a few hundred connections/followers to indicate they're active on LinkedIn. Their profile info should be consistent with what we're looking for. If you determine they sholud be contacted, write out the full blurb to be used; replace any placeholders with real values from their profile.
6. Send the connection request:
   a. Click the "Connect" button on their profile. This is usually a top-level button but can sometimes be under the "More" section.
   b. If a modal appears asking "How do you know [name]?", click "Other". If the request requires email or some other verification that we don't have info for, skip.
   c. Click "Add a note"
   d. Write the customized blurb into the personalization text box (max 300 characters — truncate gracefully if needed)
   e. Click "Send"
7. Click back to search history and find the next profile, going back to step 4. Do this until you're done.

### Step 3: Report results

After processing all targets, provide a summary via Slack:
- Total requests sent
- For each target: name, profile URL, the customized blurb used, and status (sent / already connected / failed)
- Any 2nd degree connections for manual outreach

## Error Handling

- **"Connect" button not visible**: The person may already be a connection, have a pending request, or require "Follow" first. Check for "Pending", "Message", or "Following" indicators. Report the status and skip.
- **"Add a note" not available**: LinkedIn sometimes restricts personalized notes. If this happens, ask the user whether to send without a note or skip.
- **Profile not found**: If searching by name yields multiple results or no results, report back and ask the user to clarify.
- **Rate limiting**: If LinkedIn shows a warning or blocks connection requests, stop immediately and report to the user. Do NOT retry.

## Guidelines

- Use Slack when you need to communicate with the user. The user will reply on the same thread.
- If you have trouble getting to the target invitation for some reason, early exit and inform the user of this. Do NOT send low quality invitations that don't fit the criteria and the persona.
- **NEVER** take any actions on a profile that are not explicitly part of this workflow.
- Play close attention to the persona and find close matches. Ask the user if you need more clarification on the persona.
- Never send more than 25 connection requests in a single run to avoid LinkedIn rate limits.
- Always wait for each page to fully load before interacting.
- Do not modify the user's blurb beyond filling in placeholders — the tone and content are intentional.
- If the blurb exceeds LinkedIn's 300-character limit after customization, truncate from the end and ensure it still reads naturally. Inform the user which messages were truncated.
