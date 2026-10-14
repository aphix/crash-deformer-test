# Crash Deformer Test: agent instructions

A browser car-crash game: soft-body hulls, a contact solver, a race and derby layer, WebRTC netplay. Read the docs
named below before touching the area they cover.

## Standards

`docs/CODING_STANDARDS.md` is binding: read it before writing code. The structural rules (which layer may import which)
are in `docs/ARCHITECTURE.md` and enforced by `npm run check:boundaries`.

## Environment

- Node 22.6 or newer, Linux, WSL2 or macOS. Packages come from pnpm through corepack: `corepack pnpm install
  --frozen-lockfile`. `docs/DEPLOY.md` states the build and deploy commands.
- Start every Vite command through the npm scripts (`npm run dev`, `npm run build`, `npm run preview`), not `vite`
  directly: the scripts run it through `scripts/with-app-env.mjs`, the `NAME=value` env-arg runner.
- The dev server listens on `0.0.0.0:8080` (`strictPort`; change neither host nor port). `npm run preview:restart`
  serves the built output on `127.0.0.1:8081` and frees that port first; `npm run preview:stop` stops it.
- Never create a `.env` file; only `VITE_`-prefixed variables reach the browser. Server variables
  (`PORT`, `HOST`, `PGLITE_DATA_DIR`) are listed in `docs/DEPLOY.md`.
- Playwright drives the repo's own browser scripts (`scripts/bench-browser.mjs`, `scripts/bake-env.mjs`,
  `scripts/check-programs.mjs`, `scripts/readme-shots.mjs`, which remakes the README's pictures at the Ultra tier from a
  served build). QA screenshots go under `screenshots/` (git-ignored).

## Checks

| Command | What it does |
|---|---|
| `npm run test:app` | the `src/game`, `src/lib/multiplayer`, `src/lib/submissions` and `src/lib/deploy` suites; the gate |
| `npm run t -- <files or globs> [--concurrency=2]` | the same runner on just the files named (one process per file); `--concurrency=` also works after `test:app` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:boundaries` | the structural rules, ratcheted against `scripts/boundary-caps.json` |
| `npm run lint` | `oxlint` (`docs/TOOLCHAIN.md`) |
| `npm run build:node` | the self-hosted server build into `.output/` |
| `node scripts/check-links.mjs` | every relative link in `README.md` and `docs/*.md` resolves; run it after moving or renaming a doc |

## Layout

- `src/game/`: the simulation and presentation (`world`, `contact`, `vehicle`, `deform` are sim; `present` is drawing).
- `src/lib/`: multiplayer relay and transport, submissions, deploy-time update check, database access (`db.ts`).
- `src/routes/`: TanStack Start routes (`index`, `bench`, `api/rtc`, `api/submissions`); `src/components/`: the HUD.
- `migrations/`: SQL applied in name order, once, by `src/lib/db.ts`.
- `docs/`: design, performance and deploy notes. `.extraResearch/`: the papers behind the solver, each with an analysis
  note and an index in its `README.md`.

## Rules

- New behavior gets a test that fails without the change. Never delete a test; re-pin only what a bug fix pinned.
- Permanent changes update the docs they affect; throwaway scripts and scaffolds do not stay.
- Replay-affecting simulation changes bump `REPLAY_VERSION` (`src/game/net/reel-codec.ts`) with a history entry.
