<p align="center"><img src="docs/images/logo.svg" width="112" alt="Crush Stream logo"></p>

<h1 align="center">Crush Stream</h1>

<p align="center"><b>Play: <a href="https://baconwhiskey.org/crush/">https://baconwhiskey.org/crush/</a></b></p>

Crush Stream is a car-crash sandbox that runs in the browser. Every car is a soft body: named control particles are
shape-matched (Müller et al. 2005) inside crush cages, so a head-on folds the bonnet, a T-bone dents the door and a press
flattens the roof. Watch up to 32 cars pile up in slow motion, drive one in a demolition derby, a circuit race or a police
chase, crush a parked car in a rig, or bring friends into a room over WebRTC. Built with three.js, plain TypeScript and a
small React HUD; it needs a WebGL2 browser and nothing else.

![Two sedans meeting head-on in slow motion, bonnets folding up and debris glowing in the bloom](docs/images/hero.webp)

## Features

- **Soft-body crush.** Shape-match clusters, eight-corner crush cages per body part and contact sensors; plastic travel
  builds up over hits. Doors hinge, latch and tear off, mirrors break away, glass cracks and bursts, panels peel, wheels
  come loose, drivers get thrown. Debug views show the particles (P) and the rig (G).
- **Scenes:** the fleet (with a jersey barrier, ramp balls and jump ramps), demolition derby, race, Survival, the press,
  eight pistons, a door ram, a corkscrew launch, a stack of dropped cars and the ejection range.
- **Five classes** (sedan, muscle, truck, monster, police) and one Realism slider from arcade to realistic; damage changes
  how a car drives ([`docs/HANDLING.md`](docs/HANDLING.md)).
- **Race mode:** eight courses, 2–16 racers, NPC traffic, designed shortcuts, respawn or no-reset, AI aggression, an optional
  police chase and a campaign ([`docs/RACE_DESIGN.md`](docs/RACE_DESIGN.md)).
- **Survival:** Driver 2's mode on Havana's Plaza de la Revolución: a growing pack of cops, the stopwatch is the score
  ([`docs/SURVIVAL.md`](docs/SURVIVAL.md)).
- **Crash highlights:** a race's five biggest crashes replay in slow motion behind the results; Watch or Save any clip
  ([`docs/HIGHLIGHTS.md`](docs/HIGHLIGHTS.md)).
- **Cinematic FX:** off / minimal / low / high plus Auto: HDR bloom, a crash cam, hit-stop, tyre marks and smoke, night and
  wet ([`docs/CINEMATIC.md`](docs/CINEMATIC.md)).
- **Multiplayer:** host or join a room by code, or one-tap public race / derby; up to 8 players, host-authoritative, WebRTC
  data channels ([`docs/MULTIPLAYER.md`](docs/MULTIPLAYER.md)).
- **Phones:** a thumb pad, captioned buttons, fullscreen and controller-driven menus.

| Control particles (P) | Deformation rig (G) |
|---|---|
| ![Control particles drawn over two crashed cars](docs/images/particles.webp) | ![Crush cages and sensors drawn over two crashed cars](docs/images/rig.webp) |
| **Derby** | **Press** |
| ![Cars locked together in the derby bowl, tyre smoke and marks behind them](docs/images/derby.webp) | ![A sedan between the two press plates, sparks at the front](docs/images/press.webp) |
| **Pistons** ([`docs/PISTON_RIG.md`](docs/PISTON_RIG.md)) | **Doors** ([`docs/DOOR_RIG.md`](docs/DOOR_RIG.md)) |
| ![A piston ram hitting a sedan's front corner in a shower of sparks](docs/images/pistons.webp) | ![The door ram driving an open door past its stop](docs/images/doors.webp) |
| **Crossover Canyon, with the race HUD** | **Harbour Streets, at the start** |
| ![Racing under a concrete crossover in a sandy canyon, with standings, lap, time and speed on the HUD](docs/images/race.webp) | ![A white sedan on the city grid between office blocks, the field ahead under the start lights](docs/images/race-city.webp) |

![Night: a sedan under the lamp-pole light pools, tyre smoke trailing behind](docs/images/night.webp)

<details><summary>Slow-mo crash cam (animated)</summary>

![Animated: the head-on in slow motion from the low bumper cam](docs/images/crash-slowmo.webp)

</details>

## Controls

Every key, controller button and touch control is in [`docs/CONTROLS.md`](docs/CONTROLS.md). The basics:

| Action | Keyboard | Controller |
|---|---|---|
| Gas / brake, then reverse | W / S | RT / LT |
| Steer | A / D | left stick |
| Handbrake / boost | Space / Shift | A / X (Cross / Square) |
| Recover, respawn in a race | R | D-pad ↓ |
| Camera view | V | Y / Triangle |
| Pause / full menu | Esc / H | Start |

Scenes from the bottom bar or a key (whole-field view): derby D, Survival S, race Z, press C, pistons I, doors N,
corkscrew `,`, stack `/`; the same key again goes back to the fleet.

## Quick start

Node 22.6 or newer on Linux, WSL2 or macOS; the browser needs WebGL2.

```bash
git clone https://github.com/aphix/crash-deformer-test.git
cd crash-deformer-test
npm install
npm run dev          # Vite + HMR on http://localhost:8080 (binds 0.0.0.0)
```

On WSL2, open `http://localhost:8080/` in the Windows browser.

## Checks

| Command | What it does |
|---|---|
| `npm run test:app` | the `src/game` and `src/lib/multiplayer` suites (`node --test`); **the gate** |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:boundaries` | the structural rules of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), ratcheted against `scripts/boundary-caps.json` |
| `npm run lint` | `oxlint` ([`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md)) |
| `npm run bench`, `npm run sweep` | JS kernel timings; the squash × buckle crash sweep ([`docs/CRUSH_CALIBRATION.md`](docs/CRUSH_CALIBRATION.md)) |
| `node scripts/bench-browser.mjs` | real-browser frame bench ([`docs/PERF_BENCH.md`](docs/PERF_BENCH.md)) |

## Build and deploy

`npm run build` builds for Vercel; `npm run build:node && npm run start:node` builds and runs a self-contained node server
in `.output/`. The live site is a node build under `APP_BASE=/crush/`, deployed by pull with a systemd timer:
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## How it works

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): bounded contexts, the frame loop, the structural rules. Start here.
- [`docs/DESIGN_PILLARS.md`](docs/DESIGN_PILLARS.md): arcade fun first, performance is crucial, no hitching.
- [`docs/CONTACT_PARITY.md`](docs/CONTACT_PARITY.md), [`docs/LOAD_CRUSH.md`](docs/LOAD_CRUSH.md),
  [`docs/CRUSH_CALIBRATION.md`](docs/CRUSH_CALIBRATION.md): the crash model and its bars.
- [`docs/DERBY_AI.md`](docs/DERBY_AI.md), [`docs/PANEL_FLAP.md`](docs/PANEL_FLAP.md), [`docs/PERF_HITCH.md`](docs/PERF_HITCH.md),
  [`docs/DEPLOY.md`](docs/DEPLOY.md), [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).
- [`.extraResearch/`](.extraResearch/): the papers behind the solver, each with an analysis note.
