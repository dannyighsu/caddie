---
name: log-outreach
description: Log an outreach entry. Extracts structured data from a natural language description, asks clarifying questions if needed, and writes a JSONL record.
---

## Log Outreach

Record an outreach interaction as a structured entry.

### Step 1: Extract from what the user told you

Pull out whatever you can from the user's message:
- **Medium**: phone, email, linkedin, physical, other
- **Contact name**
- **Company**
- **Role / title** (if mentioned)
- **Industry** (infer if obvious)
- **Summary**: what happened / what was discussed
- **Needs discovered**: any problems, pain points, or goals they mentioned
- **Outcome**: 1–5 scale (1 = dead end, 2 = cold/unresponsive, 3 = neutral, 4 = positive signal, 5 = strong lead)
- **Follow-up needed**: yes/no

### Step 2: Ask for anything missing

Ask only about fields you couldn't infer. Batch them into one message — don't ask one at a time. Fields required (always ask if missing):
- Medium
- Outcome score (always confirm — don't assume)

Fields optional (skip if not naturally available):
- Industry
- Tags

### Step 3: Write the entry

Determine the current ISO week: `YYYY-Www` (e.g. `2026-W19`).

Write one JSON line to `outreach/YYYY-Www.jsonl`, appending to the file (create if it doesn't exist):

```json
{"id":"<uuid>","timestamp":"<ISO8601>","week":"2026-W19","medium":"phone","contact":{"name":"...","company":"...","role":"...","industry":"..."},"summary":"...","needs":["..."],"outcome":4,"outcome_notes":"...","follow_up":true,"tags":[]}
```

To append: read the current file content (empty string if it doesn't exist), add a newline + new JSON line, and write it back.

### Step 4: Confirm

Reply with a brief confirmation: contact name, medium, outcome score, and whether follow-up is flagged. One line.

### Guidelines

- Infer industry from company name when obvious (e.g. "Acme Health" → healthcare). Don't ask.
- Outcome notes should capture the key quote or signal, not a full retelling.
- `needs` is an array of short phrases, not sentences.
- Never modify existing entries in a file.
- Use `""` for unknown string fields, `[]` for unknown arrays. Never use null.
- Tags are optional — only add if the user explicitly mentions them.
