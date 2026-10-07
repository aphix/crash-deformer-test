#!/usr/bin/env bash
# wsl-push.sh — End of task: push WSL commits into the Windows mount.
#
# Run this FROM the WSL clone (~/github/crash-deformer-test) after you've committed your
# work. It reaches across to the Windows mount and fast-forwards the WSL
# commits in, so the Windows side is ready for `git push` to GitHub.
#
# What it does:
#   1. Ensures the Windows mount has a `wsl` remote pointing at the
#      WSL clone (adds it if missing; never edits existing remotes).
#   2. Fetches wsl/$branch on the Windows mount.
#   3. Fast-forwards wsl/$branch into the Windows mount's current branch.
#      Fast-forward ONLY — never creates merge commits, never rebases.
#      If the Windows side has diverged, fails cleanly.
#   4. Stashes uncommitted work on the Windows mount before the ff,
#      restores it after.
#
# What it never does:
#   - Touch the Windows mount's `origin` remote or tracking refs.
#   - Push to GitHub (you do that yourself).
#   - Force-overwrite, reset, rebase, or merge.
#
# Single-clone machines: no-op.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/bash_helpers.sh
source "$SCRIPT_DIR/bash_helpers.sh"

# ---------------------------------------------------------------------------
# Detect topology
# ---------------------------------------------------------------------------
origin_url="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)"

if [[ "$origin_url" != /mnt/* ]]; then
    echo_green "wsl-push: origin is not a /mnt/ path — single-clone machine, nothing to do."
    exit 0
fi

WIN_MOUNT="$origin_url"
if [ ! -e "$WIN_MOUNT/.git" ]; then
    echo_red "wsl-push: Windows mount $WIN_MOUNT does not exist or is not a git repo."
    exit 1
fi

branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
win_branch="$(git -C "$WIN_MOUNT" rev-parse --abbrev-ref HEAD 2>/dev/null)"

if [ "$win_branch" != "$branch" ]; then
    echo_red "wsl-push: branch mismatch — WSL is on '$branch', Windows mount is on '$win_branch'."
    echo_red "  Checkout '$branch' on the Windows mount first."
    exit 1
fi

# ---------------------------------------------------------------------------
# Ensure `wsl` remote on the Windows mount (additive only)
# ---------------------------------------------------------------------------
existing_wsl="$(git -C "$WIN_MOUNT" config --get remote.wsl.url 2>/dev/null || true)"
if [ -z "$existing_wsl" ]; then
    echo_blue "  adding 'wsl' remote on Windows mount -> $REPO_ROOT/.git"
    git -C "$WIN_MOUNT" remote add wsl "$REPO_ROOT/.git"
fi

echo_blue "wsl-push: Windows mount ($WIN_MOUNT) <- WSL clone (wsl/$branch)"

# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------
echo_blue "  fetching wsl..."
if ! git -C "$WIN_MOUNT" fetch wsl 2>&1; then
    echo_red "wsl-push: fetch failed."
    exit 1
fi

if ! git -C "$WIN_MOUNT" rev-parse "wsl/$branch" >/dev/null 2>&1; then
    echo_red "wsl-push: wsl/$branch not found after fetch."
    exit 1
fi

cur="$(git -C "$WIN_MOUNT" rev-parse HEAD)"
src="$(git -C "$WIN_MOUNT" rev-parse "wsl/$branch")"

# ---------------------------------------------------------------------------
# Already in sync?
# ---------------------------------------------------------------------------
if [ "$cur" = "$src" ]; then
    echo_green "wsl-push: already in sync at ${cur:0:9}. Nothing to do."
    exit 0
fi

# ---------------------------------------------------------------------------
# Stash uncommitted work on the Windows mount
# ---------------------------------------------------------------------------
did_stash=false
dirty="$(git -C "$WIN_MOUNT" status --porcelain --untracked-files=no | grep -c . || true)"
if [ "$dirty" -ne 0 ]; then
    echo_yellow "  stashing $dirty uncommitted change(s) on Windows mount..."
    if git -C "$WIN_MOUNT" stash push -m "wsl-push auto-stash"; then
        did_stash=true
    else
        echo_stderr_red "  stash failed. Aborting — nothing changed."
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Fast-forward ONLY (never merge, never rebase)
# ---------------------------------------------------------------------------
if ! git -C "$WIN_MOUNT" merge --ff-only "wsl/$branch" 2>&1; then
    if [ "$did_stash" = true ]; then
        echo_blue "  restoring stash on Windows mount..."
        if ! git -C "$WIN_MOUNT" stash pop 2>&1; then
            retained="$(git -C "$WIN_MOUNT" stash list --max-count=1)"
            echo_stderr_red "wsl-push: FAILED — fast-forward refused AND the stash pop conflicted; your changes are RETAINED in:"
            echo_stderr_red "  $retained"
            echo_stderr_red "  Resolve the UU paths on the Windows mount, then 'git stash drop'."
            exit 1
        fi
    fi
    if git -C "$WIN_MOUNT" merge-base --is-ancestor HEAD "wsl/$branch"; then
        echo_red "wsl-push: FAILED — the Windows mount is an ancestor of WSL (no Windows-only commits), so git refused for a"
        echo_red "  working-tree reason: see the lines above (typically an UNTRACKED file the incoming commits also add)."
        echo_red "  Fix: compare that file to the WSL copy (cmp); if identical, delete the mount's copy and re-run."
    else
        echo_red "wsl-push: FAILED — cannot fast-forward. The Windows mount has commits not on WSL."
        echo_red "  Pull those Windows commits into WSL first (scripts/wsl-pull.sh), then re-run."
        echo_red "  Mount repair after a genuine divergence: git -C \"$WIN_MOUNT\" fetch wsl && git -C \"$WIN_MOUNT\" reset --keep wsl/$branch"
        echo_red "  (--keep, never --hard: the mount carries uncommitted owner files)."
    fi
    exit 1
fi

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------
new_head="$(git -C "$WIN_MOUNT" rev-parse --short HEAD)"
echo_green "  fast-forwarded ${cur:0:9} -> $new_head."

if [ "$did_stash" = true ]; then
    echo_yellow "  restoring uncommitted changes on Windows mount..."
    if ! git -C "$WIN_MOUNT" stash pop 2>&1; then
        echo_stderr_red "wsl-push: FAILED — fast-forwarded to $new_head but the stash pop conflicted."
        echo_stderr_red "  Resolve the UU paths on the Windows mount, then 'git stash drop'."
        exit 1
    fi
    echo_green "  uncommitted changes restored."
fi

ahead="$(git -C "$WIN_MOUNT" rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo '?')"
echo_green "wsl-push: done. Windows mount is at $new_head (${ahead} commit(s) ahead of GitHub)."
echo_green "  Push when ready: git -C \"$WIN_MOUNT\" push"
