# Crush Stream

A browser car-crash lab: two (or a fleet of) cars, Müller 2005 shape matching, a lattice fallback, jersey barriers, a compactor, and a demolition derby with very basic AI.

## Requirements

Node 22.6 or newer (tests run TypeScript through `node --experimental-strip-types`; checked on Node 24.15 / npm 11.12) on Linux, WSL2 or macOS. The browser needs WebGL2.

## Run it

```bash
git clone https://github.com/aphix/crash-deformer-test.git
cd crash-deformer-test
npm install
npm run dev          # Vite + HMR on http://localhost:8080 (binds 0.0.0.0)
npm run dev_alt      # same app on port 5555, e.g. a second checkout next to the first
```

Edit anything under `src/` and the page reloads. On WSL2, open `http://localhost:8080/` in the Windows browser.

## Check it

| Command | What it does | Time | State on `main` |
|---|---|---|---|
| `npm run typecheck` | `tsc --noEmit` | ~30 s | clean |
| `npm run test:game` | every `src/game/*.test.ts` (`node --test`) | ~11 s | 587 tests: 536 pass, 51 todo, 0 fail. This is the gate for game changes. |
| `npm test` | `scripts/**/*.test.mjs`, then `src/lib` + `src/game` suites | ~2 s | **fails**: 8 pre-existing failures in `scripts/grok-pwa-plugin.test.mjs` (platform template), and the `&&` stops it before the game suites. Run the second half alone with `node --experimental-strip-types --test src/lib/app-data/app-data.test.ts src/lib/app-data/readiness-schedule.test.ts src/lib/auth/gate-identity.test.ts src/lib/auth/sign-in-gate.test.ts 'src/game/*.test.ts'` (642 tests: 591 pass, 51 todo). |
| `npm run lint` | `oxlint` (`.oxlintrc.json`, same rules as the old ESLint config; see `docs/TOOLCHAIN.md`) | ~1 s | **fails**: 3 errors, all pre-existing (`@ts-nocheck` in the two `*-core.js` kernels, an empty block in `src/lib/app-data/client.server.ts`) |

`todo` tests are documented targets the sim does not meet yet; they run and report, but do not fail the suite (see `docs/CODEMAPS/testing.md`).

## Build

```bash
npm run build                         # vite build (Nitro, output in .vercel/output), then db:migrate
npm run preview -- --port 4173        # serve that build
```

The build takes about 50 s. `db:migrate` skips itself when `DATABASE_URL` is unset (the PGLite fallback migrates itself).

## Benchmark

```bash
npm run bench    # ns/op of the JS kernels (m3Polar, matchCluster, matchSkinLocal, crushGate…), < 1 s
npm run sweep    # squash × buckle grid over the headless crash harness, ~35 s
```

`sweep` prints a score table and writes `.bench/crush-sweep/sweep.json` and `sweep.md`. Flags: `--grid 0,0.5,1`, `--cells 0.4:0.45,0.25:0.45`, `--scenarios wall56,side50`, `--after <sim s>`, `--root <other checkout>`, `--out <dir>`. See `docs/CRUSH_CALIBRATION.md`.

Kernels in `src/game/*-core.js` are plain JavaScript on purpose. TypeScript's emit is several times slower on these loops; the sim and the tests both call the JS.

### Frame benchmark in a real browser

With a dev server running:

```bash
node scripts/bench-browser.mjs --url http://127.0.0.1:8080/ --cars 2 --modes fleet --seconds 2 --warmup 1
```

Defaults: `--cars 2,10,16,24,32 --modes fleet,derby --seconds 8 --warmup 2`. Other flags: `--out bench.json`, `--headed`, `--vsync` (default is uncapped, so fps shows headroom), `--rig`, `--particles`, `--profile <file>`. Each row prints fps, frame-time p95/p99/max and per-frame ms for `tick`, `phys`, `deform`, `render`, plus draw calls and triangles. The first line names the GPU; `llvmpipe` or SwiftShader there means software rendering and the numbers are meaningless.

- Linux / macOS: uses Playwright's Chromium (`npx playwright install chromium` once), or `CHROME_PATH`.
- WSL2, Linux Chromium: prefix `GALLIUM_DRIVER=d3d12` so WebGL reaches the host GPU through D3D12 instead of llvmpipe.
- WSL2, Windows browser (most representative): run the same script with Windows node from a checkout on the Windows drive (e.g. `/mnt/c/...`), `"/mnt/c/Program Files/nodejs/node.exe" scripts/bench-browser.mjs`; it drives the installed Edge (then Chrome) on native D3D11.

Studio reflections come from `public/env-studio.jpg` (a pre-baked RoomEnvironment). Rebuild with `npm run bake:env` if you change the bake script.

Code maps for newcomers: `docs/CODEMAPS/` (architecture, physics, frontend, testing, dependencies).

## Controls

| Scene | |
|---|---|
| Space | pause / play (handbrake while driving) |
| R | reset / reshuffle (recover the car while driving) |
| L | loop the crash |
| B | jersey barrier |
| C | compactor (camera view while driving) |
| I | piston rig: eight rams around a parked car (docs/PISTON_RIG.md); speed, mass, face hardness and hold-car in its panel |
| 1–8 / 0 | piston rig: fire one ram (clockwise from front-left) / all eight |
| N | doors scene: one ram down a parked car's side (docs/DOOR_RIG.md); speed, mass, side and door open/shut in its panel |
| 1–3 / 4 / 5 | doors scene: fire A (mirror graze, shut door) / B (open door from behind, past the stop) / C (open door from the front, toward shut); 4 opens or shuts the door; 5 swaps side |
| D | demolition derby (from the whole-field view) |
| K | ramp balls |
| G | deform rig |
| P | control particles: size = mass, lime → red = plastic travel, magenta = contact, yellow line = shape-match pull (short pulls drawn up to 4×), blue line = rest → now; the bar above each car marks its worst travel |
| Y | shape ↔ lattice |
| M | auto slow-mo |
| O | auto-orbit camera |
| U | audio |
| J | JSON trace capture (off by default) |
| JSON button | copy this run's spawn (counter = 1; no extra ticks unless capture is on) |
| drag / scroll | orbit camera |

| Driving: keyboard + mouse | |
|---|---|
| click a car, Q / E | follow it, previous / next car |
| W / ↑ | gas (brakes first while rolling backward) |
| S / ↓ | brake; once stopped, reverse |
| A / ←, D / → | steer left / right, relative to the car. Reversing steers like a real car: A backs the tail to the left. No turning on the spot |
| Space | handbrake (sharper turn, slows the car) |
| Shift | boost (drains while used under gas, recharges, fills on a derby takedown) |
| drag | look round the car; eases back behind it 0.8 s after release |
| V / C / T | camera: chase → far chase → hood cam |
| R | recover: back on its wheels where it stands, at rest and repaired (derby: only when flipped and still running) |
| Esc | drive → follow → whole field |

While following, any drive key (W/A/S/D, arrows) takes the wheel.

| Driving: controller (Xbox / PlayStation) | |
|---|---|
| RT / R2 | gas |
| LT / L2 | brake, then reverse (analog) |
| left stick | steer (deadzone, soft centre) |
| A / Cross | handbrake |
| X / Square | boost |
| right stick | look round, snaps back on release; orbits while watching |
| Y / Triangle | camera view |
| LB / RB (L1 / R1) | previous / next car (starts following from the whole field) |
| D-pad ↓ | recover |
| Start / Options | pause |
| Back / View / Create | same as Esc |

Keyboard and controller work together; per control the stronger input wins. Browsers only expose a pad after its first button press; the HUD then shows "Xbox controller connected" (or PlayStation / Controller).

HUD: the bottom bar holds play/pause, reset, the scene (Fleet / Derby / Press / Pistons / Doors; one at a time), the wall and ramp balls (fleet only) and a **?** key list. Every readout sits in the top-right card. Three collapsible sections hold the rest and remember whether they are open: **Playback** (loop, slow-mo, orbit, audio, typed time scale; clear the field to return to auto), **Cars & crash** (car count 1–32, spawn speed min/max, squash, buckle, FX, shape ↔ lattice, **Defaults** resets the lot) and **Debug views** (rig, particles, JSON capture and copy). The piston and door panels and the derby board appear only in their scenes; the drive hint shows above the bar while following or driving.

## Layout

All game code is in `src/game/`; `*.test.ts` sit next to the module they test. Details: `docs/CODEMAPS/`.

- `engine.ts` — `CrashEngine`: frame loop (`tickInner` → `fixedStep`), scenes, HUD publish; `engine-camera.ts` camera springs, chase / hood cam; `engine-fx.ts` debris, sparks, glass, smoke, audio; `engine-world.ts` asphalt, barrier mesh, lamps; `engine-props.ts` Jersey barrier, ramp balls, lamp poles, compactor press; `engine-pistons.ts` instanced rams; `engine-doors.ts` instanced door ram; `engine-trace.ts` JSON capture
- `car.ts` — `DeformableCar`: rigid pose, parts, glass, lamps, doors (hinge, latch, check-strap stop, breakaway mirrors); `car-mesh.ts` body geometry and hulls; `car-variants.ts` body styles (sedan, hatchback, wagon, coupe, pickup) with rig overrides; `lamp-lights.ts` body-mounted lamp light pool
- `streamed-deform.ts` — `StreamedDeformation`: masses, shape-match clusters / lattice beams, cages, sensors, skin; `rig-spec.ts` the rig tables; `deform-helper.ts` rig and particle debug views; `fast-normals.ts`
- `shape-match-core.js` / `shape-match.ts` — Müller shape matching kernel and typed façade (hot)
- `physics-core.js` / `physics-util.ts` — crush bands, force transfer, impulses (hot) and Vector3 helpers
- `sat.ts` hull SAT and slice length; `pair-contact.ts` car-car contact
- `fleet.ts` fleet layout; `derby.ts` / `derby-ai.ts` / `derby-arena.ts` derby match, AI, bowl; `compactor.ts` compactor rig; `piston-rig.ts` piston rig model and shot measurement (`firePiston`, `pistonLocality`); `door-rig.ts` door hinge / mirror knock rig (`fireRam`)
- `car-drive.ts` `DriverSeat`, `applyDrive`; `drive-input.ts` keyboard / pad → intent; `gamepad.ts`; `hud-store.ts` HUD state
- `crash-scenarios.test-util.ts`, `test-support.ts` — headless harness and test helpers
- `src/components/` — `crash-lab.tsx` (canvas + engine), `hud.tsx`, `hud-panels.tsx`, `hud-sections.tsx`
- `scripts/bench-physics.mjs`, `scripts/crush-sweep.mjs`, `scripts/bench-browser.mjs` — benchmarks
