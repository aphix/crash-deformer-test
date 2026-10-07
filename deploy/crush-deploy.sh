#!/usr/bin/env bash
# Pull-based deploy for the self-hosted node server (docs/DEPLOY.md).
#
# Run by crush-deploy.service (root, resource-capped) on a timer. One pass:
#   fetch CRUSH_BRANCH from CRUSH_REPO -> nothing new? exit quietly
#   -> build it as the unprivileged service user in CRUSH_ROOT/src
#   -> copy .output into a fresh CRUSH_ROOT/releases/<stamp>-<sha>
#   -> check that release on CRUSH_CHECK_PORT (in-memory DB): the page and the
#      signaling route answer, and the page's entry script and every built JS
#      chunk are served as JavaScript (client smoke)
#   -> swap the CRUSH_ROOT/current symlink atomically, restart CRUSH_UNIT
#   -> health-check the live port; on failure swap back, restart and check the
#      rollback too (first deploy: stop the unit instead, there is nothing to
#      go back to)
#   -> prune old releases.
# Every health check stops after CRUSH_HEALTH_TIMEOUT seconds (default 120).
# A build failure can be transient (registry or network blip, a run killed by
# the unit's timeout or memory cap), so a commit is rebuilt after growing waits
# (attempt n waits n * CRUSH_BUILD_BACKOFF_MIN minutes, default 10) and given up
# after CRUSH_BUILD_TRIES attempts (default 3); state/tries-<sha> counts them.
# A release that builds but fails a check is given up at once. A given-up
# commit is recorded in state/failed-<sha> and skipped until that file is
# deleted, so a bad push is not rebuilt every poll.
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
  local tries_max=${CRUSH_BUILD_TRIES:-3} backoff_min=${CRUSH_BUILD_BACKOFF_MIN:-10}
  local health_s=${CRUSH_HEALTH_TIMEOUT:-120}
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
  # An earlier build of this commit failed: wait attempts * backoff after the last one.
  local tries=0 tries_file=state/tries-$want
  if [[ -e $tries_file ]]; then
    tries=$(<"$tries_file")
    (($(date +%s) - $(stat -c %Y "$tries_file") < tries * backoff_min * 60)) && return 0
  fi

  # Load average also counts I/O waiters, but as a reason to wait two minutes
  # it is good enough: the live relays on this box always win.
  local load
  read -r load _ </proc/loadavg
  if ((${load%.*} >= $(nproc))); then
    log "load $load >= $(nproc) cores; deferring ${want:0:12}"
    return 0
  fi

  log "building ${want:0:12} (live: ${live:0:12}; attempt $((tries + 1)) of $tries_max)"
  # Counted before the build, so a run killed mid-build (unit timeout, cgroup
  # OOM kill) still counts and the next poll waits instead of restarting it.
  echo $((tries + 1)) >"$tries_file"
  local rel
  rel="releases/$(date -u +%Y%m%dT%H%M%SZ)-${want:0:12}"
  if ! build "$want" "$rel"; then
    rm -rf -- "$rel"
    if ((tries + 1 >= tries_max)); then
      rm -f -- "$tries_file"
      fail "$want" "build failed $tries_max times"
    else
      log "${want:0:12}: build failed (attempt $((tries + 1)) of $tries_max); next attempt in $(((tries + 1) * backoff_min)) min"
    fi
    return 1
  fi
  rm -f -- "$tries_file"

  local pid
  as_user HOST=127.0.0.1 PORT="$CRUSH_CHECK_PORT" NODE_ENV=production \
    node "$CRUSH_ROOT/$rel/server/index.mjs" >/dev/null 2>&1 &
  pid=$!
  if ! health "$CRUSH_CHECK_PORT" || ! client_smoke "$CRUSH_CHECK_PORT" "$rel"; then
    stop_check "$pid"
    fail "$want" "pre-swap check failed on the check port"
    rm -rf -- "$rel"
    return 1
  fi
  stop_check "$pid"

  local prev=""
  [[ -L current ]] && prev=$(readlink current)
  swap "$rel"
  systemctl restart "$unit" || true
  if ! health "$PORT"; then
    fail "$want" "live health check failed after restart"
    if [[ -n $prev ]]; then
      swap "$prev"
      systemctl restart "$unit" || true
      if health "$PORT"; then
        log "rolled back to $prev; it passes its health check"
      else
        log "rolled back to $prev, but it FAILS its health check too: the app is down"
      fi
    else
      # First deploy: nothing to go back to. Stop the unit and drop `current`
      # (the unit needs current/), so Restart=always cannot crash-loop it.
      systemctl stop "$unit" || true
      rm -f current
      log "first deploy failed: stopped $unit and removed current"
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

# npm ci deletes node_modules and fetches everything again, whatever changed. node_modules survives the `git clean`, so
# an install is skipped when package.json, the lockfile and the node version hash to state/deps-key, which is written
# only after an install finished and removed before the next one starts (a killed install is never trusted).
deps() {
  local key
  key=$(cd src && as_user sh -c 'cat package.json package-lock.json && node -v' | sha256sum)
  if [[ -d src/node_modules && -e state/deps-key && $(<state/deps-key) == "$key" ]]; then
    log "dependencies unchanged: npm ci skipped"
    return 0
  fi
  rm -f state/deps-key
  (cd src && as_user npm ci --no-audit --no-fund --loglevel=error) && printf '%s\n' "$key" >state/deps-key
}

build() {
  local sha=$1 rel=$2 t=$SECONDS
  as_user git -C src checkout -q --force --detach "$sha" &&
    as_user git -C src clean -q -ffdx -e node_modules &&
    deps &&
    log "deps: $((SECONDS - t)) s" &&
    (cd src && as_user APP_BASE="$base" npm run -s build:node) &&
    log "build: $((SECONDS - t)) s since checkout" &&
    as_user cp -a src/.output "$rel" &&
    printf '%s\n' "$sha" | as_user tee "$rel/REVISION" >/dev/null
}

# The page and the signaling route both answer, within health_s seconds in all.
# The first signaling request opens the database (several seconds under the
# deploy's CPU cap), so it may take up to 30 s of that; retries stay quiet.
# Every probe joins as a fresh peer in a fresh room: the relay answers 403 to a
# peer id seated in the last 30 s (it is someone else's until then), and a room
# seats only 8.
health() {
  local url="http://127.0.0.1:$1$base" end=$((SECONDS + health_s)) why="nothing answered" id
  while ((SECONDS < end)); do
    id="deploycheck-$EPOCHSECONDS-$RANDOM$RANDOM"
    if ! curl -fs -o /dev/null --max-time "$(left 5 "$end")" "$url"; then
      why="the page did not answer"
    elif [[ $(curl -fs --max-time "$(left 30 "$end")" "${url}api/rtc?room=$id&peer=$id") != *'"peers"'* ]]; then
      why="signaling did not answer"
    else
      return 0
    fi
    sleep 1
  done
  log "port $1: $why within ${health_s}s"
  return 1
}

# left <cap> <end>: seconds one request may take, at most <cap> and not past <end>.
left() {
  local l=$(($2 - SECONDS))
  echo $((l < 1 ? 1 : l < $1 ? l : $1))
}

# The client can load: the page's entry script and every JS chunk the build made
# (entry, routes, engine, three.js) come back 200 with a JavaScript MIME type. A
# wrong base path or a missing chunk shows up as a 404, or as HTML served for a
# .js URL; the server checks above cannot see either. Never runs tests here.
client_smoke() {
  local origin="http://127.0.0.1:$1" rel=$2 html path got
  # The page legitimately carries NUL bytes (the router's dehydrated route ids),
  # so strip them before bash sees the text and let grep read it as text.
  html=$(curl -fs --max-time 10 "$origin$base" | tr -d '\0') || {
    log "client smoke: the page did not load"
    return 1
  }
  local paths=()
  mapfile -t paths < <(grep -aoE "(src|href)=\"${base}[^\"]*\\.js\"" <<<"$html" | sed -E 's/^(src|href)="//; s/"$//')
  if ((${#paths[@]} == 0)); then
    log "client smoke: the page names no script under $base"
    return 1
  fi
  for path in "$rel"/public/assets/*.js; do
    paths+=("${base}assets/${path##*/}")
  done
  for path in $(printf '%s\n' "${paths[@]}" | sort -u); do
    got=$(curl -s -o /dev/null --max-time 10 -w '%{http_code} %{content_type}' "$origin$path")
    if [[ ! $got =~ ^200\ (text|application)/javascript ]]; then
      log "client smoke: $path -> ${got:-no answer}"
      return 1
    fi
  done
}

# stop_check <pid>: stop the check-port server. <pid> is the background
# subshell running as_user; the server is its child, so signal that (killing
# only the subshell orphans the server, which then holds the check port and
# its memory until the unit ends). SIGKILL after 10 s.
stop_check() {
  local i
  pkill -TERM -P "$1" 2>/dev/null || true
  for ((i = 0; i < 20; i++)); do
    kill -0 "$1" 2>/dev/null || break
    sleep 0.5
  done
  pkill -KILL -P "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
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
