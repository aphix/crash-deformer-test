#!/usr/bin/env bash
# wsl-pull.sh — Start of task: pull Windows-mount commits into the WSL clone.
#
# Run this FROM the WSL clone (~/github/crash-deformer-test) at the start of every session
# to pick up any commits made on the Windows side (manual edits, GitHub
# pulls, other agents' work).
#
# What it does:
#   1. Fetches from origin (= the Windows mount, NOT GitHub).
#   2. Merges origin/$branch into the current branch.
#      - Fast-forward when possible (no merge commit).
#      - Real merge when both sides have commits.
#      - Only stops on actual file-level CONFLICTS (aborts cleanly, reports).
#   3. Stashes uncommitted work before merging, restores it after.
#
# What it never does:
#   - Touch `origin` remote config.
#   - Push to GitHub.
#   - Force-overwrite or reset anything.
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
    echo_yellow "wsl-pull: origin is not a /mnt/ path — this doesn't look like the WSL clone."
    echo_yellow "  (origin=$origin_url)"
    echo_yellow "  On a single-clone machine this is a no-op. If you meant to sync the other"
    echo_yellow "  direction (WSL -> Windows), use scripts/wsl-push.sh from the Windows mount."
    exit 0
fi

WIN_MOUNT="$origin_url"
if [ ! -e "$WIN_MOUNT/.git" ]; then
    echo_stderr_red "wsl-pull: Windows mount at $WIN_MOUNT doesn't look like a git repo."
    exit 2
fi

branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
echo_blue "wsl-pull: WSL ($REPO_ROOT) <- Windows mount (origin/$branch)"

# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------
echo_blue "  fetching origin..."
if ! git -C "$REPO_ROOT" fetch origin 2>&1; then
    echo_stderr_red "  fetch failed. Nothing changed."
    exit 1
fi

if ! git -C "$REPO_ROOT" rev-parse "origin/$branch" >/dev/null 2>&1; then
    echo_stderr_red "  ref 'origin/$branch' not found after fetch."
    exit 1
fi

cur="$(git -C "$REPO_ROOT" rev-parse HEAD)"
src="$(git -C "$REPO_ROOT" rev-parse "origin/$branch")"

# ---------------------------------------------------------------------------
# Already in sync?
# ---------------------------------------------------------------------------
if [ "$cur" = "$src" ]; then
    echo_green "  already in sync ($(git -C "$REPO_ROOT" rev-parse --short HEAD)). Nothing to do."
    exit 0
fi

# ---------------------------------------------------------------------------
# Stash uncommitted work
# ---------------------------------------------------------------------------
did_stash=false
dirty="$(git -C "$REPO_ROOT" status --porcelain | grep -c . || true)"
if [ "$dirty" -ne 0 ]; then
    echo_yellow "  stashing $dirty uncommitted change(s)..."
    if git -C "$REPO_ROOT" stash push -m "wsl-pull auto-stash" --include-untracked; then
        did_stash=true
    else
        echo_stderr_red "  stash failed. Aborting — nothing changed."
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------
merge_ok=true
if ! git -C "$REPO_ROOT" merge --no-edit "origin/$branch" 2>&1; then
    merge_ok=false
fi

if [ "$merge_ok" = false ]; then
    echo_stderr_red "  MERGE CONFLICT. Conflicted files:"
    git -C "$REPO_ROOT" diff --name-only --diff-filter=U 2>/dev/null | while IFS= read -r f; do
        echo_stderr_red "    $f"
    done
    echo_stderr_yellow "  aborting merge — restoring previous state..."
    git -C "$REPO_ROOT" merge --abort 2>/dev/null || true

    if [ "$did_stash" = true ]; then
        echo_yellow "  popping stash (your uncommitted changes are safe)..."
        git -C "$REPO_ROOT" stash pop 2>/dev/null \
            || echo_stderr_yellow "  stash pop had issues; check 'git stash list'."
    fi
    echo_stderr_red "  resolve the conflict manually, then re-run."
    exit 1
fi

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------
new_head="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
if git -C "$REPO_ROOT" merge-base --is-ancestor "$cur" "$src" 2>/dev/null; then
    echo_green "  fast-forwarded ${cur:0:9} -> $new_head."
else
    echo_green "  merged (merge commit $new_head)."
fi

if [ "$did_stash" = true ]; then
    echo_yellow "  restoring uncommitted changes from stash..."
    if ! git -C "$REPO_ROOT" stash pop 2>&1; then
        echo_stderr_yellow "  stash pop conflicted with the merge result."
        echo_stderr_yellow "  Your changes are safe in 'git stash list'. Apply with 'git stash pop'."
    else
        echo_green "  uncommitted changes restored."
    fi
fi

echo_green "wsl-pull: done. WSL clone is at $new_head."
