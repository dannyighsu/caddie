#!/bin/bash
# Turn limit soft-warning hook for PostToolUse.
# Counts assistant turns in the transcript and emits an additionalContext
# warning when the agent approaches HARNESS_MAX_TURNS (default 150).

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null)

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

MAX_TURNS="${HARNESS_MAX_TURNS:-150}"
WARN_AT=$(( MAX_TURNS * 9 / 10 ))

# Count assistant turns from the JSONL transcript
TURNS=$(grep -c '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null || echo 0)

if [ "$TURNS" -ge "$WARN_AT" ]; then
  REMAINING=$(( MAX_TURNS - TURNS ))
  if [ "$REMAINING" -lt 0 ]; then
    REMAINING=0
  fi
  cat <<EOJSON
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TURN LIMIT WARNING: You have used approximately ${TURNS} of ${MAX_TURNS} turns (~${REMAINING} remaining). You MUST begin wrapping up immediately. Finish the current step, save progress, and produce your final output. Do not start new tasks."}}
EOJSON
fi
