#!/usr/bin/env bash
# wsl-check.sh — Read-only: compare both clones' sync state.
#
# Run from either clone. Reports branch, HEAD, dirty count and relationship
# (ahead/behind/diverged). Exit 0 = in sync; exit 1 = out of sync.
#
# Never modifies anything. Single-clone machines: no-op.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/bash_helpers.sh
source "$SCRIPT_DIR/bash_helpers.sh"

# ---------------------------------------------------------------------------
# Detect topology
# ---------------------------------------------------------------------------
WSL_CLONE=""
WIN_MOUNT=""

origin_url="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)"
wsl_url="$(git -C "$REPO_ROOT" config --get remote.wsl.url 2>/dev/null || true)"

if [ -n "$wsl_url" ]; then
    WIN_MOUNT="$REPO_ROOT"
    WSL_CLONE="${wsl_url%.git}"
    WSL_CLONE="${WSL_CLONE%/}"
elif [[ "$origin_url" == /mnt/* ]]; then
    WSL_CLONE="$REPO_ROOT"
    WIN_MOUNT="$origin_url"
else
    echo_yellow "wsl-check: two-clone setup not detected (single-clone machine?). Nothing to check."
    exit 0
fi

for d in "$WSL_CLONE" "$WIN_MOUNT"; do
    if [ ! -e "$d/.git" ]; then
        echo_stderr_red "wsl-check: $d doesn't look like a git repo."
        exit 2
    fi
done

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
wsl_branch="$(git -C "$WSL_CLONE" rev-parse --abbrev-ref HEAD)"
win_branch="$(git -C "$WIN_MOUNT" rev-parse --abbrev-ref HEAD)"
wsl_head="$(git -C "$WSL_CLONE" rev-parse --short HEAD)"
win_head="$(git -C "$WIN_MOUNT" rev-parse --short HEAD)"
wsl_dirty="$(git -C "$WSL_CLONE" status --porcelain | grep -c . || true)"
win_dirty="$(git -C "$WIN_MOUNT" status --porcelain | grep -c . || true)"

echo_blue "=== wsl-check ==="
echo "  WSL clone    : $WSL_CLONE"
echo "    branch=$wsl_branch  head=$wsl_head  dirty=$wsl_dirty"
echo "  Windows mount: $WIN_MOUNT"
echo "    branch=$win_branch  head=$win_head  dirty=$win_dirty"

status=0

if [ "$wsl_branch" != "$win_branch" ]; then
    echo_red "  [MISMATCH] branches differ: WSL=$wsl_branch  WIN=$win_branch"
    status=1
fi

if [ "$wsl_head" != "$win_head" ]; then
    wsl_full="$(git -C "$WSL_CLONE" rev-parse HEAD)"
    win_full="$(git -C "$WIN_MOUNT" rev-parse HEAD)"

    if git -C "$WSL_CLONE" merge-base --is-ancestor "$win_full" "$wsl_full" 2>/dev/null; then
        echo_yellow "  [AHEAD] WSL is ahead — run 'scripts/wsl-push.sh' to sync."
    elif git -C "$WSL_CLONE" merge-base --is-ancestor "$wsl_full" "$win_full" 2>/dev/null; then
        echo_yellow "  [BEHIND] WSL is behind — run 'scripts/wsl-pull.sh' to sync."
    else
        echo_yellow "  [DIVERGED] both sides have unique commits — pull or push will create a merge commit."
    fi
    status=1
else
    echo_green "  [OK] HEADs match ($wsl_head)"
fi

# git identity
if [ -z "$(git -C "$WSL_CLONE" config --get user.email 2>/dev/null || true)" ]; then
    echo_yellow "  [note] WSL clone has no git user.email — set one before committing:"
    echo_yellow "    git -C \"$WSL_CLONE\" config user.name  \"Aphix\""
    echo_yellow "    git -C \"$WSL_CLONE\" config user.email \"aphix@users.noreply.github.com\""
fi

if [ "$status" -eq 0 ]; then
    echo_green "=== in sync ==="
else
    echo_yellow "=== out of sync (see above) ==="
fi
exit "$status"
