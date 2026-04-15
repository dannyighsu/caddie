#!/bin/bash
# PreToolUse hook that blocks git commands in Bash tool calls.
# Agents should never interact with git — the harness manages persistence.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)

# Only inspect Bash tool calls
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

# Check if the command contains git operations
if echo "$COMMAND" | grep -qE '\bgit\b'; then
  cat <<EOJSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Git commands are blocked. You are not in a git repository. The harness manages persistence externally. Do not use git add, git commit, git push, git status, or any other git commands. Write your data to the run record file and artifacts directory instead."}}
EOJSON
else
  exit 0
fi
