#!/bin/bash
# SessionStart hook — thin wrapper around sweep-mounts.py.
exec python3 "$(dirname "$0")/sweep-mounts.py"
