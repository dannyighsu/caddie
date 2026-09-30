#!/bin/bash
# PreToolUse hook that blocks Claude Code's built-in cron/schedule tools
# and redirects the agent to use the Ignis manage-schedules skill instead.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)

# Log every invocation for debugging — verifies the hook is firing.
LOG_DIR="${HARNESS_ROOT:-/tmp}/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
echo "$(date -Iseconds) tool=$TOOL_NAME" >> "$LOG_DIR/cron-block.log" 2>/dev/null

# Match any cron- or schedule-related built-in tool, case-insensitively.
shopt -s nocasematch
case "$TOOL_NAME" in
  Cron*|Schedule*|RemoteTrigger)
    cat <<EOJSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The built-in ${TOOL_NAME} tool is blocked. ALWAYS use the manage-schedules skill instead — it calls the portal control API, which has no plan limits, persists across restarts, and integrates with the rest of the system. Read the manage-schedules skill for the exact curl commands to use for scheduling."}}
EOJSON
    ;;
  *)
    # Allow all other tools
    exit 0
    ;;
esac
