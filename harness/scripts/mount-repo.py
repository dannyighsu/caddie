#!/usr/bin/env python3
"""Mount a git repo into the current agent workspace — always a shallow clone
of its remote `main`, never a local copy.

Usage (from the agent workspace):
  python3 "$HARNESS_ROOT/scripts/mount-repo.py" <url-or-local-path> [--ttl HOURS] [--name NAME]

- A local path is resolved to its `origin` URL; a path without one is an error.
- One mount per remote: if a sidecar in mounts/.meta/ already has this source,
  that mount is reused (refreshed to origin/main when it's clean on main, left
  alone otherwise) and its expiry extended. Nothing is cloned twice.
- Otherwise the repo is cloned into mounts/<name>/ (name defaults to the repo
  basename) and a sidecar is written.

Prints the mount path and what happened on stdout. Exits non-zero on failure.
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_TTL_HOURS = 24
BRANCH = "main"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True)


def fail(msg: str) -> None:
    print(f"mount-repo: {msg}", file=sys.stderr)
    sys.exit(1)


def resolve_url(source: str) -> str:
    """A URL passes through; a local path is replaced by its origin URL."""
    path = Path(source).expanduser()
    if not path.exists():
        return source
    r = git("-C", str(path), "remote", "get-url", "origin", check=False)
    if r.returncode != 0 or not r.stdout.strip():
        fail(f"{source} has no `origin` remote — mounts come from a remote, not a local copy")
    return r.stdout.strip()


def repo_key(url: str) -> str:
    """Normalise a remote URL so SSH and HTTPS spellings of one repo compare
    equal: git@github.com:org/repo.git and https://github.com/org/repo both
    become github.com/org/repo."""
    u = url.strip().rstrip("/")
    u = re.sub(r"\.git$", "", u)
    u = re.sub(r"^[a-z+]+://", "", u)       # scheme
    u = re.sub(r"^[^@/]+@", "", u)          # user@
    u = re.sub(r"^([^/:]+):(?!\d)", r"\1/", u)  # scp-style host:path
    return u.lower()


def default_name(url: str) -> str:
    base = repo_key(url).rsplit("/", 1)[-1]
    return re.sub(r"[^a-z0-9._-]+", "-", base).strip("-") or "repo"


def load_sidecars(meta_dir: Path) -> dict[str, dict]:
    out = {}
    for p in sorted(meta_dir.glob("*.json")):
        try:
            out[p.stem] = json.loads(p.read_text())
        except Exception:
            continue
    return out


def write_sidecar(meta_dir: Path, name: str, url: str, mounted_at: str, expires: datetime) -> None:
    (meta_dir / f"{name}.json").write_text(json.dumps({
        "name": name,
        "kind": "clone",
        "source": url,
        "mountedAt": mounted_at,
        "expiresAt": expires.isoformat(),
    }, indent=2) + "\n")


def has_work(repo: Path) -> bool:
    """Uncommitted changes, untracked files, or commits on no remote."""
    if git("status", "--porcelain", cwd=repo).stdout.strip():
        return True
    return bool(git("rev-list", "--branches", "--not", "--remotes", cwd=repo).stdout.strip())


def refresh(repo: Path) -> str:
    # Check before fetching: a shallow fetch disconnects the old commit from
    # the new origin/main, so afterwards clean history reads as unpushed.
    current = git("branch", "--show-current", cwd=repo).stdout.strip()
    clean_main = current == BRANCH and not has_work(repo)
    main_synced = git("rev-parse", BRANCH, cwd=repo, check=False).stdout == \
        git("rev-parse", f"origin/{BRANCH}", cwd=repo, check=False).stdout
    git("fetch", "--depth=1", "origin", BRANCH, cwd=repo)
    if current != BRANCH and main_synced:
        # Keep an untouched local main in step, or the sweep would read it as unpushed.
        git("update-ref", f"refs/heads/{BRANCH}", f"origin/{BRANCH}", cwd=repo)
    if clean_main:
        git("reset", "--hard", f"origin/{BRANCH}", cwd=repo)
        return f"refreshed to origin/{BRANCH}"
    return (f"not refreshed — on `{current or 'detached HEAD'}` with work in progress; "
            f"origin/{BRANCH} is fetched, branch new work from it")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="remote URL, or a local path whose origin to clone")
    ap.add_argument("--ttl", type=float, default=DEFAULT_TTL_HOURS, help="hours until the sweep removes it")
    ap.add_argument("--name", help="mount directory name (default: repo basename)")
    args = ap.parse_args()

    mounts = Path.cwd() / "mounts"
    meta_dir = mounts / ".meta"
    meta_dir.mkdir(parents=True, exist_ok=True)

    url = resolve_url(args.source)
    key = repo_key(url)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(hours=args.ttl)
    sidecars = load_sidecars(meta_dir)

    # Reuse: the same remote is only ever mounted once.
    for name, meta in sidecars.items():
        if repo_key(meta.get("source", "")) != key or not (mounts / name).is_dir():
            continue
        if meta.get("kind") != "clone" or (mounts / name).is_symlink():
            fail(f"mounts/{name} is a legacy local mount of this repo — unmount it and re-run")
        status = refresh(mounts / name)
        prev = meta.get("expiresAt", "")
        try:
            expires = max(expires, datetime.fromisoformat(prev.replace("Z", "+00:00")))
        except ValueError:
            pass
        write_sidecar(meta_dir, name, url, meta.get("mountedAt", now.isoformat()), expires)
        print(f"mounts/{name}: already mounted, {status}; expires {expires.isoformat()}")
        return

    name = args.name or default_name(url)
    if not NAME_RE.match(name):
        fail(f"invalid mount name {name!r} — use short kebab-case")
    if (mounts / name).exists() or (mounts / name).is_symlink() or name in sidecars:
        fail(f"mounts/{name} is already taken by another repo — pass --name")

    branch_note = ""
    has_main = git("ls-remote", "--exit-code", "--heads", url, BRANCH, check=False)
    if has_main.returncode == 0:
        clone = git("clone", "--depth=1", "--branch", BRANCH, url, str(mounts / name), check=False)
    elif has_main.returncode == 2:
        clone = git("clone", "--depth=1", url, str(mounts / name), check=False)
        if clone.returncode == 0:
            got = git("branch", "--show-current", cwd=mounts / name).stdout.strip()
            branch_note = f" (no `{BRANCH}` on the remote — cloned default branch `{got}`)"
    else:
        fail(f"can't reach {url}: {has_main.stderr.strip()}")
    if clone.returncode != 0:
        fail(f"clone failed: {clone.stderr.strip()}")
    # A shallow clone tracks only its one branch, so pushing a PR branch would
    # leave no origin/<branch> ref and the sweep would read it as unpushed.
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*", cwd=mounts / name)

    write_sidecar(meta_dir, name, url, now.isoformat(), expires)
    print(f"mounts/{name}: cloned {url}{branch_note}; expires {expires.isoformat()}")


if __name__ == "__main__":
    main()
