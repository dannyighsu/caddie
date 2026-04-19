#!/usr/bin/env python3
"""SessionStart hook — sweeps expired repo mounts in the current agent's
workspace.

Layout (relative to cwd, which is the agent workspace):
  mounts/<name>/              — the mount (symlink or cloned directory)
  mounts/.meta/<name>.json    — sidecar with expiresAt, source, kind

For each sidecar:
  - If expiresAt has passed, remove the mount and the sidecar.
  - If the mount no longer exists, remove the orphan sidecar.

Failures are logged to stderr but never abort the session.
"""

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    try:
        # datetime.fromisoformat handles "+00:00" but not "Z" until 3.11+.
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def remove_mount(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)
        return
    if path.exists():
        path.unlink()


def main() -> None:
    # Hook provides JSON on stdin; we don't need it, but drain to avoid SIGPIPE.
    try:
        sys.stdin.read()
    except Exception:
        pass

    cwd = Path.cwd()
    meta_dir = cwd / "mounts" / ".meta"
    if not meta_dir.is_dir():
        return

    now = datetime.now(timezone.utc)

    for meta_path in sorted(meta_dir.glob("*.json")):
        name = meta_path.stem
        mount_path = cwd / "mounts" / name

        try:
            meta = json.loads(meta_path.read_text())
        except Exception as exc:
            print(f"sweep-mounts: skipping unreadable {meta_path.name}: {exc}", file=sys.stderr)
            continue

        expires = parse_iso(meta.get("expiresAt", ""))

        # Orphan sidecar — mount is gone, drop the metadata.
        if not mount_path.exists() and not mount_path.is_symlink():
            try:
                meta_path.unlink()
                print(f"sweep-mounts: removed orphan sidecar {name}", file=sys.stderr)
            except Exception as exc:
                print(f"sweep-mounts: failed to remove orphan {name}: {exc}", file=sys.stderr)
            continue

        if expires is None:
            continue

        if now >= expires:
            try:
                remove_mount(mount_path)
                meta_path.unlink()
                print(f"sweep-mounts: removed expired mount {name}", file=sys.stderr)
            except Exception as exc:
                print(f"sweep-mounts: failed to remove {name}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"sweep-mounts: unexpected error: {exc}", file=sys.stderr)
    sys.exit(0)
