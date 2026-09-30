#!/usr/bin/env python3
"""SessionStart hook — sweeps expired repo mounts in the current agent's
workspace (cwd). Whatever it prints on stdout lands in the agent's context, so
only what the agent should act on goes there; routine logging goes to stderr.

Layout (relative to cwd, which is the agent workspace):
  mounts/<name>/              — the mount (a clone made by mount-repo.py)
  mounts/.meta/<name>.json    — sidecar with expiresAt, source, kind

For each sidecar:
  - If the mount no longer exists, remove the orphan sidecar.
  - If expiresAt has passed, remove the mount and the sidecar — unless the
    mount holds uncommitted changes or commits on no remote. Those are kept
    (and reported) until the work is pushed or the mount is removed by hand.

Failures are logged to stderr but never abort the session.
"""

import json
import shutil
import subprocess
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


def unpushed_work(path: Path) -> str | None:
    """Describe work that deleting this mount would lose, or None if there's none."""
    if path.is_symlink() or not (path / ".git").exists():
        return None

    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=path, capture_output=True, text=True, check=True).stdout.strip()

    if git("status", "--porcelain"):
        return "uncommitted changes"
    if git("rev-list", "--branches", "--not", "--remotes"):
        return "commits not pushed to any remote"
    return None


def remove_mount(path: Path) -> None:
    # Never rmtree through a symlink — it would delete the linked repo.
    if path.is_symlink():
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)
        return
    if path.exists():
        path.unlink()


def sweep(workspace: Path, now: datetime) -> None:
    meta_dir = workspace / "mounts" / ".meta"
    if not meta_dir.is_dir():
        return

    for meta_path in sorted(meta_dir.glob("*.json")):
        name = meta_path.stem
        mount_path = workspace / "mounts" / name

        try:
            meta = json.loads(meta_path.read_text())
        except Exception as exc:
            print(f"sweep-mounts: skipping unreadable {meta_path}: {exc}", file=sys.stderr)
            continue

        # Orphan sidecar — mount is gone, drop the metadata.
        if not mount_path.exists() and not mount_path.is_symlink():
            try:
                meta_path.unlink()
                print(f"sweep-mounts: removed orphan sidecar {mount_path}", file=sys.stderr)
            except Exception as exc:
                print(f"sweep-mounts: failed to remove orphan {mount_path}: {exc}", file=sys.stderr)
            continue

        expires = parse_iso(meta.get("expiresAt", ""))
        if expires is None or now < expires:
            continue

        try:
            work = unpushed_work(mount_path)
        except Exception as exc:
            print(f"sweep-mounts: keeping {mount_path}, couldn't check it for work: {exc}", file=sys.stderr)
            continue
        if work:
            print(f"Expired mount mounts/{name} was kept: it has {work}. "
                  f"Push it (or tell the user), then unmount it.")
            continue

        try:
            remove_mount(mount_path)
            meta_path.unlink()
            print(f"sweep-mounts: removed expired mount {mount_path}", file=sys.stderr)
        except Exception as exc:
            print(f"sweep-mounts: failed to remove {mount_path}: {exc}", file=sys.stderr)


def main() -> None:
    # Hook provides JSON on stdin; we don't need it, but drain to avoid SIGPIPE.
    try:
        sys.stdin.read()
    except Exception:
        pass
    sweep(Path.cwd(), datetime.now(timezone.utc))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"sweep-mounts: unexpected error: {exc}", file=sys.stderr)
    sys.exit(0)
