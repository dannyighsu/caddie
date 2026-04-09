#!/bin/bash
# Turn limit warning hook for PostToolUse.
# Counts assistant turns in the transcript and emits escalating warnings
# as the agent approaches HARNESS_MAX_TURNS (default 150).

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null)

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

MAX_TURNS="${HARNESS_MAX_TURNS:-150}"

# Count assistant turns from the JSONL transcript
TURNS=$(grep -c '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null || echo 0)

REMAINING=$(( MAX_TURNS - TURNS ))
if [ "$REMAINING" -lt 0 ]; then
  REMAINING=0
fi

if [ "$REMAINING" -le 5 ]; then
  cat <<EOJSON
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"CRITICAL: You have ${REMAINING} turns left. YOU MUST END NOW. Post your summary and final output THIS TURN. Do not start any new steps."}}
EOJSON
elif [ "$REMAINING" -le 10 ]; then
  cat <<EOJSON
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TURN LIMIT WARNING: You have ${REMAINING} turns left. You MUST start wrapping up NOW. Finish your current step, post your summary, and end the run. Do not start new tasks."}}
EOJSON
elif [ "$REMAINING" -le 20 ]; then
  cat <<EOJSON
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TURN LIMIT NOTICE: You have ${REMAINING} turns left out of ${MAX_TURNS}. Start planning to wrap up. Finish what you're doing and prepare your final summary."}}
EOJSON
fi
