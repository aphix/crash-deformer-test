# Deploying

Two targets build from the same tree:

| Target | Build | Base path | Signaling database |
|---|---|---|---|
| Vercel (default) | `npm run build` (Nitro `vercel` preset) | `/` | Neon via `DATABASE_URL` |
| Self-hosted node server | `npm run build:node` (Nitro `node-server` preset), run with `npm run start:node` | `APP_BASE`, e.g. `/crush/` | PGLite in `PGLITE_DATA_DIR` |

## Build knobs

Both are read by `vite.config.ts` at build time; neither reaches the browser (only `VITE_`
variables do).

- `NITRO_PRESET`: the Nitro server target. Unset means `vercel`. `build:node` sets `node-server`
  through `scripts/with-app-env.mjs`, which accepts leading `NAME=value` arguments so the npm script
  also runs on Windows. The node build ships PGLite's whole package (its `.wasm` and `.data` load
  from beside the module), so `.output/` runs on its own with no `node_modules`.
- `APP_BASE`: the sub-path the app is served under, both slashes (`/crush/`); default `/`. It
  becomes Vite's `base`. TanStack Start derives the router basepath from it and Nitro gets it as
  `baseURL`, so pages, `/_serverFn`, `/api/rtc` and public files all live under it. Client code
  builds URLs from `import.meta.env.BASE_URL` (always ends in `/`), never from a
  hard-coded `/`: `${import.meta.env.BASE_URL}api/rtc`, `${import.meta.env.BASE_URL}env-studio.jpg`,
  and for share links `location.origin + import.meta.env.BASE_URL + "?net=join&room=X"`. A
  request outside the base gets a redirect to it.

  The exception is the platform chrome (`server/middleware/grok-pwa.ts`, `scripts/grok-pwa-*`,
  `public/__grok/`), which is not ours to edit and keeps root-relative URLs: the manifest and
  touch-icon links, the iOS install page's assets under `/__grok/`, and the share-card images
  (`og:image` → `/og.jpg`, `x:game:image` → `/x-banner.jpg`). The proxy routes those root paths to
  the app (`deploy/nginx-crush.conf`); the manifest is served by the middleware at the root path,
  the rest from the app's public files under the base. One known limit: the manifest's
  `start_url`/`scope` are `/`, so a home-screen install opens the site root, not the base.

Runtime variables for the node server: `PORT` (default 3000), `HOST`, `PGLITE_DATA_DIR`
(unset = in-memory, wiped on restart), `DATABASE_URL` (set it to use Postgres instead of PGLite).
A PGLite data dir belongs to one process: PGLite has no cross-process locking. It must also be
closed on stop: `db.ts` closes it on SIGTERM/SIGINT. Measured without that: a server that opens a
data dir left unclean (its previous owner was killed or never closed it) crash-recovers it and then
keeps a PGLite timer (`__setitimer_js`) armed forever, so it never exits on SIGTERM. On the box that
was a 90 s stop timeout and a SIGKILL on every deploy, which left the store unclean again for the
next release. With the close, the same scenario exits in about 2 s and leaves the store clean.

Signaling rows live 30-60 s, so a persistent PGLite store matters little: it keeps rooms across a
restart that happens mid-handshake, nothing more.

## Self-hosted: architecture

```mermaid
flowchart LR
  GH[(GitHub, public repo)] -- "git fetch over HTTPS,<br/>no credentials" --> D
  subgraph box[VPS]
    T[crush-deploy.timer<br/>every 2 min] --> D[crush-deploy.service<br/>root, capped]
    D -- "git / npm / node as crush" --> B[src/ build]
    B --> R[releases/stamp-sha]
    D -- "check on a spare port,<br/>then swap symlink" --> C[current -> releases/...]
    D -- "systemctl restart" --> S[crush.service<br/>user crush, 127.0.0.1]
    C --> S
    N[nginx :443] -- "/crush/ (path unchanged)" --> S
  end
  U[browsers] --> N
  U <-. "WebRTC data channels" .-> U
```

One pass of `deploy/crush-deploy.sh`:

1. Take a lock (a pass that is still building makes the next tick exit at once).
2. `git fetch` the branch. Same commit as `current/REVISION`, or a commit marked failed: exit. This
   is the whole cost of an idle poll.
3. Defer if the 1-minute load average is at or above the core count.
4. As the `crush` user: check out the commit, `npm ci`, `npm run build:node` with `APP_BASE`, copy
   `.output` to `releases/<UTC stamp>-<sha>`.
5. Start that release on `CRUSH_CHECK_PORT` with an in-memory database. The page and
   `api/rtc` must both answer within 45 s.
6. Point `current` at it with `ln -sfn` + `mv -T` (atomic rename), `systemctl restart crush.service`,
   and check the live port the same way.
7. Keep the newest `CRUSH_KEEP` releases (never the live or the previous one).

Failure at 4 or 5 leaves the live release untouched. Failure at 6 swaps `current` back and
restarts again. Either way the commit is recorded as `state/failed-<sha>` and skipped until a newer
commit arrives or someone deletes the marker.

Limits: the deploy unit runs at `Nice=10`, `CPUWeight=20`, `CPUQuota=200%`, idle I/O class,
`MemoryMax=4G`, `OOMScoreAdjust=500`; `crush.service` at `Nice=5`, `CPUWeight=20`,
`MemoryMax=2G`, `OOMScoreAdjust=500`, `ProtectSystem=strict` with only its data dir writable.
(PGLite is the memory cost: ~1.2 GB peak while it opens a database, ~0.4-0.6 GB after.)
On a box shared with other services, those services win any contention and are never the OOM
killer's first pick.

Root does three things in a pass: swap a symlink, run `systemctl`, run `curl`. Everything that
reads repository content (git, npm and its install scripts, the built server) runs as `crush`
through `setpriv` with a clean environment. The deploy script itself is installed by hand from the
repo; the box never runs a fetched copy of it as root.

Logs: put the app's access log outside any 4xx-probe jail's logpath. Internet-facing boxes often
run a fail2ban jail that bans an address for days, on all ports, after a couple of 4xx lines in
the site's access log. Players produce those honestly: a stale asset after a deploy, a 405 from
a misrouted signaling call, a 409 "room full". So every location in `deploy/nginx-crush.conf`
logs to its own file (`@ACCESS_LOG@`), named so that no jail's logpath or glob matches it
(Debian's default `nginx_access_log` is a `*access.log` glob). The error log stays shared, and the
jails themselves are left alone. Choosing the file: deploy/README.md step 4.

Install steps: [deploy/README.md](../deploy/README.md).

## Platform-kit changes to re-apply after template updates

The app came from a template whose files a template update may overwrite. These template-owned
files carry changes the self-hosted deploy depends on. After any template update, diff them and
re-apply what was lost. The platform chrome (`server/`, `public/__grok/`, `scripts/grok-pwa-*`) is
deliberately *not* changed; the nginx snippet maps its root paths instead (see Build knobs).

| File | Change | Why the VPS needs it | If it is reverted |
|---|---|---|---|
| `vite.config.ts` | `base: APP_BASE`; Nitro `preset: NITRO_PRESET \|\| "vercel"`, `baseURL: base`; for `node-server`, `traceDeps: ["@electric-sql/pglite*"]` | serves everything under the sub-path; builds the node target; ships PGLite's `.wasm`/`.data`, which load from beside its module | app answers at `/` only, or `.output/` lacks PGLite's files and signaling cannot open its database |
| `scripts/with-app-env.mjs` | leading `NAME=value` arguments become env vars | `build:node` sets `NITRO_PRESET=node-server` through it, on Windows too | `build:node` tries to run `NITRO_PRESET=node-server` as a command and fails |
| `package.json` | `build:node`, `start:node` scripts | `crush-deploy.sh` runs `npm run build:node` | every commit fails to build and is skipped (the old release keeps serving) |
| `src/lib/db.ts` | `new PGlite({ dataDir: process.env.PGLITE_DATA_DIR })`; with a data dir, `pg.close()` on SIGTERM/SIGINT | `crush.service` keeps the signaling store in the release-independent `shared/` dir, and a restart must not hang | without the data dir: still works, in memory, rooms mid-handshake are lost on each restart. Without the close: every restart hangs until `TimeoutStopSec` (site down meanwhile) and ends in a SIGKILL |
| `src/lib/multiplayer/p2p.ts` | `RTC_URL = ${import.meta.env.BASE_URL}api/rtc`, used by the poll, signal and leave fetches | signaling lives under the base (`/crush/api/rtc`) | browsers call `/api/rtc` at the site root, which 404s: no peer ever connects, and those 404s go to the site's main access log, where a 4xx-probe jail can ban the players |
| `src/lib/multiplayer/p2p.ts` | `sendBinary()`, `onBinary`, `binaryType = "arraybuffer"` on both data channels (netplay) | host snapshots and client inputs are binary frames (`RtcTransport`) | WebRTC netplay carries no snapshots: the client never gets a car |
| `src/lib/multiplayer/signaling.server.ts`, `rate-limit.ts`, `migrations/0002_webrtc_signaling.sql` | in-process token buckets per peer (client IP + peer id), per IP and per room; room cap (`ROOM_MAX`, `rooms.ts`); `GET ?list=public`; tables from migration 0002 (netplay) | in-process limits are exact on one long-lived node server; the IP is the `X-Forwarded-For` first hop, which the nginx snippet overwrites with the real client address; PGLite applies 0002 before its first query | relay is unlimited, public room listing 400s, or signaling has no tables |

The deploy's health check does **not** catch a reverted `RTC_URL`: it calls the server route
directly, which still works. Check the built client instead, e.g. after `APP_BASE=/crush/ npm run
build:node`: `grep -rl '/crush/api/rtc' .output/public/assets` must find the engine chunk. A
two-browser smoke against the public URL is the end-to-end proof.

## Why pull, not a GitHub Actions runner on the box

This repository is public. A self-hosted runner registered to a public repo runs whatever workflow
a pull request brings: a fork can add `.github/workflows/x.yml` with `runs-on: self-hosted` and get
a shell on the box, as the runner user, next to the other services. GitHub's own docs say to use
self-hosted runners only with private repositories for that reason.

The pull model has no inbound path at all:

- Nothing on GitHub can make the box run anything. The box decides when to look and only ever
  builds the head of one named branch, which only people with push access can move.
- No credentials exist: the fetch is anonymous HTTPS, there is no runner token, no deploy key, no
  secret in Actions.
- Code from the repo runs as an unprivileged user with no sudo, inside a capped cgroup.

What it costs: up to two minutes plus build time between a push and the deploy, and no "deploy"
status on the commit in GitHub. The journal (`journalctl -u crush-deploy.service`) is the record.

What it still trusts: anyone who can push to `main` can run code as `crush` on the box. Branch
protection on `main` is the control for that, the same as with any CD system.

## Rolling back

Automatic: a release that fails its checks never goes live, or is swapped back (step 6).

By hand, on the box, from the deploy root:

```bash
touch "state/failed-$(cat current/REVISION)"     # stop the next poll from redeploying it
ls releases
ln -sfn releases/<older> current.new && mv -fT current.new current && systemctl restart crush.service
```

Or revert the commit on `main`; the next poll deploys the revert like any other commit.

## If the owner insists on a self-hosted runner

Not recommended for this public repo. If it is done anyway:

- Register it to this repo only, under its own unprivileged user with no sudo, in a systemd unit
  with the same limits as `crush-deploy.service` (`Nice`, `CPUWeight=20`, `MemoryMax`,
  `OOMScoreAdjust=500`).
- Settings > Actions > General: "Require approval for all outside collaborators" (fork pull requests
  wait for a maintainer before any workflow runs).
- The deploy workflow triggers on `push` to `main` only, plus `workflow_dispatch`. No
  `pull_request`, `pull_request_target` or `issue_comment` triggers anywhere in the repo, since
  a workflow file in a PR can target any label.
- Give the job `permissions: contents: read` and no secrets; it needs none.
- Give the runner a label nothing else uses and keep it out of every other workflow.
- The job does exactly what one pull pass does (build as the runner user, health-check, swap,
  restart). Restarting `crush.service` from the runner needs a narrow sudoers rule or polkit rule
  for that one unit, which is privilege the pull model never grants.

Risks that remain: the approval policy is a click away from being relaxed; a maintainer can approve
a malicious fork PR by mistake; any workflow added later with a PR trigger reopens the hole; and
the runner's stored credentials, if stolen from the box, let another machine pose as it and take
this repo's jobs. Hosted runners plus a pull-based box avoid all of these.
