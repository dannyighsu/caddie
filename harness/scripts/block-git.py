#!/usr/bin/env python3
"""PreToolUse hook that blocks `git push` when it would target the containing
ignis repo rather than a mounted repo under <workspace>/mounts/.

Invoked by harness/.claude/settings.json. Reads the hook payload from stdin
(JSON with tool_name and tool_input.command) and emits a deny decision when
the command would push the ignis repo. All other git commands are allowed.
"""

import json
import re
import sys

DENY_MSG = (
    "`git push` is blocked unless scoped into a mounted repo under "
    "mounts/ in your workspace. The ignis repo is managed by the "
    "harness — do not push it. To push a mounted repo, prefix with "
    "`cd mounts/<name> &&` or use `git -C mounts/<name> push`."
)

MOUNT_PATH_RE = re.compile(r'mounts/[^\s/;&|]+')
CD_RE = re.compile(r'^\s*cd\s+(\S+)')
ANY_PUSH_RE = re.compile(r'\bgit\s+(?:\S+\s+)*push\b')
GIT_C_PUSH_RE = re.compile(r'\bgit\s+-C\s+(\S+)\s+[^;&|]*\bpush\b')
GIT_PUSH_RE = re.compile(r'\bgit\s+(?:(?!-C\b)\S+\s+)*push\b')


def deny() -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": DENY_MSG,
        }
    }))
    sys.exit(0)


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = data.get("tool_input", {}).get("command", "")

    if not ANY_PUSH_RE.search(cmd):
        sys.exit(0)

    segments = re.split(r'(?:\|\||&&|;|\|)', cmd)

    in_mount = False
    for seg in segments:
        m = CD_RE.match(seg)
        if m:
            in_mount = bool(MOUNT_PATH_RE.search(m.group(1)))
            continue

        gc = GIT_C_PUSH_RE.search(seg)
        if gc:
            if not MOUNT_PATH_RE.search(gc.group(1)):
                deny()
            continue

        if GIT_PUSH_RE.search(seg):
            if not in_mount:
                deny()

    sys.exit(0)


if __name__ == "__main__":
    main()
