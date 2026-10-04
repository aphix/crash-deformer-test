<!-- Generated: 2026-10-03 | Files scanned: 9 | Token estimate: ~950 -->
# Dependencies

Versions are those installed from `package-lock.json` (2026-10-02).

## Runtime that the game uses
| Package | Version | Used for |
|---|---|---|
| `three` | 0.186.0 | renderer, scene graph, `BufferGeometry` skinning target, math types (`src/game/**`); `three/addons` `Pass` (post chain) and `BufferGeometryUtils` |
| `@dimforge/rapier3d` | 0.19.3 (pinned) | thrown-driver ragdolls only (`engine-ragdoll.ts`), cosmetic and local; loaded once after boot through `rapier.ts` `loadRapier`: its own chunk plus a separate `.wasm` that Vite 8 handles without a plugin (Apache-2.0). Node tests import `kernel/rapier-node.test-util.ts` first (a resolve hook for the package's extensionless imports) |
| `react` / `react-dom` | 19.2 | HUD (`src/components/hud*.tsx`, `net-panel.tsx`, `crash-lab.tsx`), `useSyncExternalStore` on `hud-store.ts` |
| `@tanstack/react-start` / `react-router` | 1.168 / 1.170 | app shell, file routes (`src/routes/`, generated `src/routeTree.gen.ts`), SSR and the `/api/rtc` server route via Nitro |
| `zod` | 4.5 | validates `/api/rtc` requests (`signaling.server.ts`), the public-room list the client reads (`net/net-play.ts`), the host's race state a client applies (`net/codec.ts` `readRace`) and the race track JSON (`world/track-schema.ts`) |
| `@radix-ui/react-accordion`, `react-popover`, `lucide-react`, `class-variance-authority`, `tailwindcss` 4 | | HUD sections, key-list popover, icons, `ui/button.tsx`, styling (`src/styles.css`) |

The game and HUD import from `src/lib/` only `utils.ts` (`cn`), `boot-loader.ts` (`dismissBootLoader`), `preview-host-bridge.ts`, `qr.ts` (invite QR) and `multiplayer/` (`P2PRoom` WebRTC mesh, `rooms.ts`). The template's other server dependencies (`better-auth`, `kysely` 0.28, `@electric-sql/pglite` 0.5, `pg`, …) serve `src/lib/` auth / app-data and the signaling tables.

## Netplay
- Signaling: `src/lib/multiplayer/signaling.server.ts` on the app database: Neon (`DATABASE_URL`) on Vercel, PGLite on a node server or in preview. Tables come from `migrations/0002_webrtc_signaling.sql` (`npm run db:migrate`, or the PGLite fallback before its first query). Rate limits: `rate-limit.ts` (token buckets per peer and per IP).
- Game data never touches the server: WebRTC data channels, STUN only (no TURN). See `docs/MULTIPLAYER.md`.

## Dev / tooling
| Package | Version | Used for |
|---|---|---|
| `vite` | 8.2 | dev server (`npm run dev`), `vite build`, `vite preview` (`vite.config.ts`) |
| `nitro` | 3.0 beta | server build: Vercel preset by default, `NITRO_PRESET=node-server` for `npm run build:node` (output in `.output/`) |
| `typescript` | 5.9 | `npm run typecheck` (`tsc --noEmit`); tests run TS directly via `node --experimental-strip-types` |
| `playwright` | 1.63 | `scripts/bench-browser.mjs` (Chromium / Edge frame bench) |
| `oxlint` + `oxlint-plugin-eslint` | 1.86 | `npm run lint` (`.oxlintrc.json`). See [../TOOLCHAIN.md](../TOOLCHAIN.md) |
| `prettier` | 3 | `npm run format` |
| `@types/three`, `@types/node` | | types only |

No test framework dependency: tests use `node:test` and `node:assert/strict`.

## Hand-written JS kernels
`src/game/kernel/physics-core.js` and `src/game/kernel/shape-match-core.js` are plain JavaScript with `// @ts-nocheck`, typed by sibling `.d.ts` files and re-exported through `physics-util.ts` / `shape-match.ts`. They work on numbers and typed arrays, not THREE objects, because TypeScript's emit was several times slower on these loops. Measure with `npm run bench`. Side effect: `npm run lint` reports the two `@ts-nocheck` headers as errors (`no-warning-comments`).

## WASM skin kernel
`src/game/deform/skin-kernel.wasm` is the skin and normals loop of `StreamedDeformation.skin`, compiled from the Rust crate `kernels/skin/` (no crates, scalar code, no SIMD or threads; the one non-MVP instruction is `memory.fill`). The binary is committed: `loadSkinKernel` (`deform/skin-kernel.ts`) fetches it during the engine's warm-up (`engine-warm.ts`) and the JS skin stays the reference and the fallback until it resolves or if it fails. Rebuild it with `npm run build:kernel` (`scripts/build-skin-kernel.mjs`, needs `cargo` and the `wasm32-unknown-unknown` target; Cargo runs through `scripts/cargo.mjs`, which uses `mbx` when installed and serialises builds on a lock) whenever `lib.rs` changes; the deploy box has no cargo. Tests load the file through `deform/skin-kernel.test-util.ts`.

## Deploy kit (`deploy/`, `docs/DEPLOY.md`)
No extra npm dependencies. The self-hosted target is `npm run build:node` with `APP_BASE` (e.g. `/crush/`) plus systemd and nginx: `crush.service` runs `server/index.mjs` from the `current` release (the build's `.output/`); `crush-deploy.timer` → `crush-deploy.service` → `crush-deploy.sh` pulls `main`, builds a release, health-checks it and swaps the `current` symlink; `nginx-crush.conf` proxies the base path; `deploy.env.example` lists the runtime variables.

## Related
[architecture.md](architecture.md) · [testing.md](testing.md) · `docs/DEPLOY.md` · `docs/MULTIPLAYER.md`
