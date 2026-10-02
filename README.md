<p align="center"><img src="docs/images/logo.svg" width="112" alt="Crush Stream logo"></p>

<h1 align="center">Crush Stream</h1>

<p align="center"><b>Play: <a href="https://baconwhiskey.org/crush/">https://baconwhiskey.org/crush/</a></b></p>

Crush Stream is a car-crash sandbox that runs in the browser. Every car is a soft body: named control particles are shape-matched (Müller et al. 2005) inside crush cages, so a head-on folds the bonnet, a T-bone dents the door, and a press flattens the roof. You can watch a fleet of up to 32 cars pile up in slow motion, drive one yourself in a demolition derby, crush a parked car with a press, eight pistons or a door ram, or bring friends into a room over WebRTC. It's built with three.js, plain TypeScript classes and a small React HUD, and needs no install beyond a WebGL2 browser.

![Two sedans meeting head-on in slow motion, bonnets folding up and debris glowing in the bloom](docs/images/hero.webp)

## Features

### Soft-body crush
Each car carries a rig of named masses (`rig-spec.ts`) grouped into shape-match clusters, eight-corner crush cages per body part, and contact sensors. Plastic travel is kept per region, so damage builds up over hits. Doors hinge, latch and tear off, mirrors break away, glass shatters, and wheels come loose. The lattice solver is still there as a toggle (Y). Debug views show the control particles (P: size = mass, colour = plastic travel or contact) and the rig (G: cages, sensors, hulls).

| Control particles (P) | Deformation rig (G) |
|---|---|
| ![Control particles drawn over two crashed cars](docs/images/particles.webp) | ![Crush cages and sensors drawn over two crashed cars](docs/images/rig.webp) |

### Scenes
One scene at a time, from the bottom bar or a key:

- **Fleet** (R): 1–32 cars on collision courses, with an optional jersey barrier (B) and ramp balls (K).
- **Derby** (D): a walled bowl where AI cars hunt each other until one is left running. Take the wheel of any of them.
- **Press** (C): two plates close on a parked car.
- **Pistons** (I): eight rams around a parked car; fire one (1–8) or all (0). See [`docs/PISTON_RIG.md`](docs/PISTON_RIG.md).
- **Doors** (N): one ram runs down a parked car's side, grazing the mirror, driving an open door past its stop or slamming it shut. See [`docs/DOOR_RIG.md`](docs/DOOR_RIG.md).

| Derby | Press |
|---|---|
| ![Six cars locked together in the derby bowl, tyre smoke and marks behind them](docs/images/derby.webp) | ![A sedan between the two press plates, sparks at the front](docs/images/press.webp) |
| **Pistons** | **Doors** |
| ![A piston ram hitting a sedan's front corner in a shower of sparks](docs/images/pistons.webp) | ![The door ram has torn an open door off a sedan; the door lies on the ground](docs/images/doors.webp) |

### Vehicle classes and handling
Four classes, **Sedan**, **Muscle**, **Truck** and **Monster**, each with its own mass, grip, power and damage tolerance. One **Realism** slider runs from arcade (assists, forgiving grip, cars survive more) to realistic. Damage changes how a car drives: a limping engine loses power, and a dead one stops. Boost (Shift) recharges, and a derby takedown fills it. Details are in [`docs/HANDLING.md`](docs/HANDLING.md).

### Cinematic FX
Three tiers, **off / low / high** (F key, HUD, or `?fx=off|low|high` in the URL). The `low` and `high` tiers add an HDR post chain with bloom, an ACES grade and film grain, an impact punch with a short hit-stop, a crash cam that cuts to three angles during the slow-mo, tyre marks on the GPU, tyre smoke, and spark streaks. Night (H) lights the lot with lamp-pole pools and the cars' own lamps, and Wet (X) makes the asphalt glossy. See [`docs/CINEMATIC.md`](docs/CINEMATIC.md).

![Night: a teal sedan under the lamp-pole light pools, tyre smoke trailing behind](docs/images/night.webp)

<details><summary>Slow-mo crash cam (animated, 270 kB)</summary>

![Animated: the head-on in slow motion from the low bumper cam](docs/images/crash-slowmo.webp)

</details>

### Multiplayer
Press **Net** (top centre) to host or join a room by code, or hit **Public race** to join the first open public room (or open one if there is none). A private room gives you a **Copy invite link** button and a QR code for phones. Rooms hold up to 8 players. One machine (the host) simulates and everyone else draws its snapshots, so the crushed meshes and contact points match on every screen. Peers talk over WebRTC data channels, and the server (`/api/rtc`) only relays the handshake. A "This browser (tabs)" link is there for local testing. See [`docs/MULTIPLAYER.md`](docs/MULTIPLAYER.md).

### Race mode (coming)
Tracks, surfaces and race AI are in progress. Only the groundwork is on `main`: the surface and prefab tables (`src/game/race/catalog.ts`) and the swappable ground (`ground.ts`).

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
| F | cinematic FX tier: off → low → high |
| H | night |
| X | wet asphalt |
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

HUD: the bottom bar holds play/pause, reset, the scene (Fleet / Derby / Press / Pistons / Doors), the wall and ramp balls (fleet only) and a **?** key list. **Net** at the top opens multiplayer. Readouts sit in the top-right card. Four collapsible sections below it hold the rest and remember whether they are open:
- **Playback**: loop, slow-mo, orbit, audio, night, wet, FX tier, and a typed time scale (clear it to return to auto).
- **Driving**: your car's class and the realism slider.
- **Cars & crash**: car count 1–32, spawn speed min/max, stroke, wrinkle, FX density, shape ↔ lattice, and **Defaults**, which resets them all.
- **Debug views**: rig, particles, JSON capture and copy.

The piston and door panels and the derby board appear only in their scenes.

## Quick start

Node 22.6 or newer (tests run TypeScript through `node --experimental-strip-types`; checked on Node 24.15 / npm 11.12) on Linux, WSL2 or macOS. The browser needs WebGL2.

```bash
git clone https://github.com/aphix/crash-deformer-test.git
cd crash-deformer-test
npm install
npm run dev          # Vite + HMR on http://localhost:8080 (binds 0.0.0.0)
npm run dev_alt      # same app on port 5555, e.g. a second checkout next to the first
```

Edit anything under `src/` and the page reloads. On WSL2, open `http://localhost:8080/` in the Windows browser.

### Checks

| Command | What it does | State on `main` |
|---|---|---|
| `npm run test:app` | `src/game/**` suites, `src/lib/multiplayer` suites and `scripts/with-app-env.test.mjs` (`node --test`, ~60 s) | 685 tests: 634 pass, 51 todo, 0 fail. **This is the gate.** |
| `npm run test:game` | the `src/game/**` suites only | subset of the above |
| `npm run typecheck` | `tsc --noEmit` | clean |
| `npm run lint` | `oxlint` (`.oxlintrc.json`; see [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md)) | **fails**: 3 known errors (`@ts-nocheck` in the two `*-core.js` kernels, an empty block in `src/lib/app-data/client.server.ts`) and 2 warnings |
| `npm test` | `scripts/**/*.test.mjs`, then `src/lib` + `src/game` suites | **fails** in its first half: 9 of 196 script tests (8 in the platform template's `scripts/grok-pwa-plugin.test.mjs`, 1 in `scripts/migration-plan.test.mjs`, which predates `migrations/0002_webrtc_signaling.sql`), and the `&&` stops it before the app suites. Use `test:app`. |

`todo` tests are documented targets the sim does not meet yet. They run and report, but don't fail the suite (see [`docs/CODEMAPS/testing.md`](docs/CODEMAPS/testing.md)).

### Build

```bash
npm run build                         # vite build (Nitro, Vercel preset), then db:migrate
npm run preview -- --port 4173        # serve that build
npm run build:node && npm run start:node   # self-contained node server in .output/
```

`db:migrate` skips itself when `DATABASE_URL` is unset (the PGLite fallback migrates itself).

### Benchmarks

```bash
npm run bench    # ns/op of the JS kernels (m3Polar, matchCluster, matchSkinLocal, crushGate…)
npm run sweep    # squash × buckle grid over the headless crash harness
node scripts/bench-browser.mjs --url http://127.0.0.1:8080/ --cars 2 --modes fleet --seconds 2 --warmup 1
```

`sweep` prints a score table and writes `.bench/crush-sweep/sweep.json` and `sweep.md`. Flags: `--grid 0,0.5,1`, `--cells 0.4:0.45,0.25:0.45`, `--scenarios wall56,side50`, `--after <sim s>`, `--root <other checkout>`, `--out <dir>`. See [`docs/CRUSH_CALIBRATION.md`](docs/CRUSH_CALIBRATION.md).

`bench-browser` needs a dev server running. Its defaults are `--cars 2,10,16,24,32 --modes fleet,derby --seconds 8 --warmup 2`. Other flags: `--out bench.json`, `--headed`, `--vsync` (by default the frame rate is uncapped, so fps shows headroom), `--rig`, `--particles` and `--profile <file>`. Each row prints fps, frame-time p95/p99/max and per-frame ms for `tick`, `phys`, `deform` and `render`, plus draw calls and triangles. The first line names the GPU. If it says `llvmpipe` or SwiftShader, rendering is in software and the numbers are meaningless.
- Linux / macOS: it uses Playwright's Chromium (`npx playwright install chromium` once), or `CHROME_PATH`.
- WSL2 with Linux Chromium: prefix `GALLIUM_DRIVER=d3d12` so WebGL reaches the host GPU through D3D12 instead of llvmpipe.
- WSL2 with a Windows browser (most representative): run the script with Windows node from a checkout on the Windows drive (`"/mnt/c/Program Files/nodejs/node.exe" scripts/bench-browser.mjs`). It drives the installed Edge (or else Chrome) on native D3D11.

Kernels in `src/game/*-core.js` are plain JavaScript on purpose: TypeScript's emit is several times slower on these loops. Studio reflections come from `public/env-studio.jpg` (a pre-baked RoomEnvironment); rebuild it with `npm run bake:env` if you change the bake script.

## Self-hosting

The live build is a Nitro `node-server` build served under a base path (`APP_BASE=/crush/`) behind nginx. It deploys by pull: a systemd timer fetches `main`, builds into a fresh release, health-checks it on a spare port and swaps a symlink, with rollback. [`docs/DEPLOY.md`](docs/DEPLOY.md) covers the build knobs, runtime variables, the units and scripts in [`deploy/`](deploy/), and rolling back. Vercel (`npm run build`) works too.

## How it works

- [`docs/CODEMAPS/`](docs/CODEMAPS/): architecture, physics, frontend, testing, dependencies. Start here.
- [`docs/RIG_ANALYSIS.md`](docs/RIG_ANALYSIS.md): the rig against a real car's structure, crash targets, and attribution notes.
- [`docs/CONTACT_PARITY.md`](docs/CONTACT_PARITY.md): one striker contact model for rams, press plates, pistons and other cars.
- [`docs/CRUSH_CALIBRATION.md`](docs/CRUSH_CALIBRATION.md): squash/buckle calibration and the sweep.
- [`docs/HANDLING.md`](docs/HANDLING.md): classes, the realism axis, and damage that changes driving.
- [`docs/CINEMATIC.md`](docs/CINEMATIC.md): FX tiers, post chain, crash cam, tyre marks and their cost.
- [`docs/MULTIPLAYER.md`](docs/MULTIPLAYER.md): transport choice, host-authoritative snapshots and the codec.
- [`.extraResearch/`](.extraResearch/): the papers behind the solver (shape matching, PBD/XPBD, oriented particles…), each with an analysis note, plus [`SYNTHESIS.md`](.extraResearch/SYNTHESIS.md).

## Project layout

All game code is in `src/game/`, and the `*.test.ts` files sit next to the module they test. Details are in [`docs/CODEMAPS/`](docs/CODEMAPS/).

- `engine.ts`: `CrashEngine`, with the frame loop (`tickInner` → `fixedStep`), scenes and HUD publish. Split out of it:
  - `engine-camera.ts`: camera springs, chase / hood cam.
  - `engine-fx.ts`: debris, sparks, glass, smoke, audio.
  - `engine-world.ts`: asphalt, barrier mesh, lamps, night / wet stage.
  - `engine-props.ts`: jersey barrier, ramp balls, lamp poles, compactor press.
  - `engine-pistons.ts`: instanced rams.
  - `engine-doors.ts`: the door ram mesh.
  - `engine-trace.ts`: JSON capture.
  - `engine-cine.ts`: cinematic director (tiers, crash cam, hit-stop, tyre smoke).
  - `engine-post.ts`: HDR post chain and bloom.
  - `engine-marks.ts`: GPU tyre-mark map.
- `car.ts`: `DeformableCar`, with rigid pose, parts, glass, lamps and doors (hinge, latch, check-strap stop, breakaway mirrors).
  - `car-mesh.ts`: body geometry and hulls.
  - `car-variants.ts`: body styles (sedan, hatchback, wagon, coupe, pickup) with rig overrides.
  - `lamp-lights.ts`: the pooled lamp lights.
- `vehicle-classes.ts`: classes, `HANDLING.realism`, damage stages and kill travel. `car-drive.ts`: `DriverSeat`, `applyDrive`. `drive-input.ts`: keyboard / pad → intent. `gamepad.ts`.
- `streamed-deform.ts`: `StreamedDeformation`, with masses, shape-match clusters / lattice beams, cages, sensors and skin. `rig-spec.ts`: the rig tables. `deform-helper.ts`: rig and particle debug views. `fast-normals.ts`.
- `shape-match-core.js` / `shape-match.ts`: the Müller shape-matching kernel and its typed façade (hot path).
- `physics-core.js` / `physics-util.ts`: crush bands, force transfer and impulses (hot path), plus Vector3 helpers.
- `sat.ts`: hull SAT and slice length. `pair-contact.ts`: car-car contact. `external-contact.ts`: the shared striker contact (door / mirror colliders, body crush).
- `ground.ts`: the active ground (height, normal, grip, surface).
- `fleet.ts`: fleet layout. `derby.ts` / `derby-ai.ts` / `derby-arena.ts`: derby match, AI and bowl.
- `compactor.ts`: the compactor rig. `piston-rig.ts`: piston rig and shot measurement. `door-rig.ts`: the door / mirror knock rig (`fireRam`).
- `net/`: netplay.
  - `net-play.ts`: host / client roles.
  - `codec.ts`: binary snapshots.
  - `transport.ts`, `rtc-transport.ts`: BroadcastChannel and WebRTC transports.
- `race/catalog.ts`: race surface / prefab tables (race mode is coming).
- `hud-store.ts`: HUD state. `crash-scenarios.test-util.ts`, `test-support.ts`: the headless harness and test helpers.

Outside `src/game/`:
- `src/components/`: `crash-lab.tsx` (canvas + engine), `hud.tsx`, `hud-panels.tsx`, `hud-sections.tsx`, `net-panel.tsx`.
- `src/lib/multiplayer/`: the WebRTC mesh (`p2p.ts`), the signaling relay (`signaling.server.ts`, mounted at `src/routes/api/rtc.ts`), room rules and rate limits.
- `deploy/`: systemd units, deploy script, nginx snippet. `migrations/`: SQL migrations.
- `scripts/bench-physics.mjs`, `scripts/crush-sweep.mjs`, `scripts/bench-browser.mjs`: benchmarks.
