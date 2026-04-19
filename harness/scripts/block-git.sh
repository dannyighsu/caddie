#!/bin/bash
# PreToolUse hook — thin wrapper around block-git.py.
exec python3 "$(dirname "$0")/block-git.py"
