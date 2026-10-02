#!/usr/bin/env bash
# Pull-based deploy for the self-hosted node server (docs/DEPLOY.md).
#
# Run by crush-deploy.service (root, resource-capped) on a timer. One pass:
#   fetch CRUSH_BRANCH from CRUSH_REPO -> nothing new? exit quietly
#   -> build it as the unprivileged service user in CRUSH_ROOT/src
#   -> copy .output into a fresh CRUSH_ROOT/releases/<stamp>-<sha>
#   -> health-check that release on CRUSH_CHECK_PORT (in-memory DB)
#   -> swap the CRUSH_ROOT/current symlink atomically, restart CRUSH_UNIT
#   -> health-check the live port; on failure swap back and restart again
#   -> prune old releases.
# A commit that fails to build or check is recorded in state/failed-<sha> and
# skipped until that file is deleted, so a bad push is not rebuilt every poll.
#
# Root only swaps a symlink, runs systemctl and curl. Everything that touches
# repository content (git, npm, node) runs as CRUSH_USER via setpriv.
#
# Install by copying to a temp name and `mv`-ing over the old file: a running
# bash reads its script by offset, so overwriting in place corrupts a live run.
# The body is one function, parsed whole before it starts, for the same reason.
set -euo pipefail

log() { printf 'crush-deploy: %s\n' "$*"; }

# Unprivileged, clean environment: nothing from the unit's env reaches repository
# code except what is listed here, and the deploy lock (fd 9) is not inherited.
# `user`, `node_bin` and `base` are main's locals (bash scoping is dynamic).
as_user() {
  setpriv --reuid="$user" --regid="$user" --init-groups --inh-caps=-all \
    env -i HOME="$CRUSH_ROOT/cache" PATH="$node_bin:/usr/bin:/bin" LANG=C.UTF-8 "$@" 9>&-
}

main() {
  : "${CRUSH_ROOT:?}" "${CRUSH_REPO:?}" "${CRUSH_BRANCH:?}" "${PORT:?}" "${CRUSH_CHECK_PORT:?}"
  local user=${CRUSH_USER:-crush} unit=${CRUSH_UNIT:-crush.service}
  local base=${APP_BASE:-/} keep=${CRUSH_KEEP:-3}
  local node_bin="$CRUSH_ROOT/node/bin"
  cd "$CRUSH_ROOT"

  exec 9>state/deploy.lock
  if ! flock -n 9; then
    log "another deploy is running"
    return 0
  fi

  [[ -d src/.git ]] || as_user git init -q src
  as_user git -C src fetch -q --no-tags "$CRUSH_REPO" "+refs/heads/$CRUSH_BRANCH:refs/remotes/deploy/head"
  local want live=""
  want=$(as_user git -C src rev-parse refs/remotes/deploy/head)
  [[ -e current/REVISION ]] && live=$(<current/REVISION)
  [[ $want == "$live" ]] && return 0
  if [[ -e state/failed-$want ]]; then
    return 0
  fi

  # Load average also counts I/O waiters, but as a reason to wait two minutes
  # it is good enough: the live relays on this box always win.
  local load
  read -r load _ </proc/loadavg
  if ((${load%.*} >= $(nproc))); then
    log "load $load >= $(nproc) cores; deferring ${want:0:12}"
    return 0
  fi

  log "building ${want:0:12} (live: ${live:0:12})"
  local rel
  rel="releases/$(date -u +%Y%m%dT%H%M%SZ)-${want:0:12}"
  if ! build "$want" "$rel"; then
    fail "$want" "build failed"
    rm -rf -- "$rel"
    return 1
  fi

  local pid
  as_user HOST=127.0.0.1 PORT="$CRUSH_CHECK_PORT" NODE_ENV=production \
    node "$CRUSH_ROOT/$rel/server/index.mjs" >/dev/null 2>&1 &
  pid=$!
  if ! health "$CRUSH_CHECK_PORT"; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    fail "$want" "pre-swap health check failed on the check port"
    rm -rf -- "$rel"
    return 1
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  local prev=""
  [[ -L current ]] && prev=$(readlink current)
  swap "$rel"
  systemctl restart "$unit" || true
  if ! health "$PORT"; then
    fail "$want" "live health check failed after restart"
    if [[ -n $prev ]]; then
      swap "$prev"
      systemctl restart "$unit" || true
      log "rolled back to $prev"
    fi
    return 1
  fi
  log "live: $rel"

  # Globs sort by name and names start with a UTC stamp: oldest first.
  local old=(releases/*/) r
  old=("${old[@]%/}")
  for r in "${old[@]:0:$((${#old[@]} > keep ? ${#old[@]} - keep : 0))}"; do
    [[ $r == "$rel" || $r == "$prev" ]] || rm -rf -- "$r"
  done
}

build() {
  local sha=$1 rel=$2
  as_user git -C src checkout -q --force --detach "$sha" &&
    as_user git -C src clean -q -ffdx -e node_modules &&
    (cd src && as_user npm ci --no-audit --no-fund --loglevel=error) &&
    (cd src && as_user APP_BASE="$base" npm run -s build:node) &&
    as_user cp -a src/.output "$rel" &&
    printf '%s\n' "$sha" | as_user tee "$rel/REVISION" >/dev/null
}

# The page and the signaling route both answer. The first signaling request
# opens the database (several seconds under the deploy's CPU cap), so it gets a
# longer timeout; retries stay quiet until the last one.
health() {
  local url="http://127.0.0.1:$1$base" i
  for ((i = 0; i < 45; i++)); do
    if curl -fs -o /dev/null --max-time 5 "$url" &&
      [[ $(curl -fs --max-time 30 "${url}api/rtc?room=deploycheck&peer=deploycheck") == *'"peers"'* ]]; then
      return 0
    fi
    sleep 1
  done
  curl -fsS -o /dev/null --max-time 5 "$url" || true
  return 1
}

swap() {
  ln -sfn "$1" current.new
  mv -fT current.new current
}

fail() {
  log "${1:0:12}: $2; skipped until state/failed-$1 is removed"
  touch "state/failed-$1"
}

main "$@"
exit
