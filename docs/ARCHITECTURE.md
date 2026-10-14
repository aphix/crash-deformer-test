# Architecture and structural rules

How `src/` is cut into bounded contexts, which way dependencies may point, how a frame runs, and the rules that keep the
structure honest as the game grows. The game is meant to be *correctly wobbly*: these rules govern structure, layering,
ownership and test correctness. They never pin a physics number, a feel, or an experiment (section 7).

Every rule that can be counted has a check in `scripts/check-boundaries.mjs`. A check prints a count; **a non-zero count is a
defect to fix, never a baseline to allow.** Until a check reaches 0 it is held by a ratchet: `scripts/boundary-caps.json` caps
every count at its value when the cap was set, `npm run check:boundaries` fails when a count rises above its cap, and the commit
that lowers a count lowers its cap. C8 (size) is report-only.

```
node scripts/check-boundaries.mjs            # one count per check, exit 1 if any is non-zero
node scripts/check-boundaries.mjs --list     # every violation as file:line
npm run check:boundaries                     # ratchet: exit 1 only if a count rises above scripts/boundary-caps.json
node scripts/dup-scan.mjs [--renamed]        # clone report on stdout
```

## 1. Bounded contexts and the layer DAG

Each context is one folder, `src/game/<context>/`. A production file may import its own context or a context on a
**strictly lower** layer. Type-only imports count: they couple the same way. `platform` (`src/lib`) is reachable only from
`net` and `ui`.

```mermaid
flowchart BT
  kernel["L0 kernel"] --> world["L1 world"] --> deform["L2 deform"] --> vehicle["L3 vehicle"] --> contact["L4 contact"]
  contact --> scenes["L5 scenes"] --> ai["L6 ai"] --> match["L7 match"]
  match --> present["L8 present"]
  match --> net["L8 net"]
  present --> hud["L9 hud"]
  net --> hud
  hud --> engine["L10 engine"] --> ui["L11 ui"]
  platform["platform (src/lib)"] -.-> net
  platform -.-> ui
```

(Arrows point from the lower layer up to the layers allowed to use it.)

| L | context | owns | main entry points |
|---|---|---|---|
| 0 | **kernel** | number-only hot kernels and rig tables: `physics-core.js`, `shape-match-core.js` (typed by `.d.ts`), `rig-spec.ts`, `rapier.ts` (the one Rapier loader) | `CRASH`, `crushStroke`, `CAGES`, `MASS_SPECS`, `loadRapier` |
| 1 | **world** | ground, surfaces, track data and courses (`world/tracks/*.json`) | `Ground`, `activeGround`, `setGround`, `SURFACES`, `Track`, `placeProps` |
| 2 | **deform** | masses, clusters, cages, skin, load crush, the WASM skin kernel | `StreamedDeformation` (layers `deform-rig` → `deform-hit` → `deform-state` → `deform-contact` → `deform-solve`) |
| 3 | **vehicle** | the car, body styles, classes, parts, glass, lamps, drive and input | `DeformableCar` (layers `car-core` → `car-parts` → `car`), `CLASSES`, `HANDLING`, `applyDrive`, `DriverSeat` |
| 4 | **contact** | car-car, car-wall, car-prop and striker contact | `physicsSlice`, `satCars`, `resolveCarPair`, `partContactPair` |
| 5 | **scenes** | rigs and props that act on cars, one file per rig | `layoutFleet`, `FleetRamps`, `Corkscrew`, `CompactorRig`, `PistonRig`, `DoorRig`, `StackRig`, `RangeRun`, `JerseyBarrier` |
| 6 | **ai** | drivers: derby, race, traffic, police, Survival hunters | `DerbyBrain`, `RaceBrain`, `TrafficBrain`, `PoliceBrain`, `HunterBrain` |
| 7 | **match** | rules, scoring, campaigns, the crash phase machine | `DerbyMatch`, `RaceSession`, `Campaign`, `AutoWatch`, `CrashPhase` |
| 8 | **present** | FX, camera, cinematics, post, marks, world art, ragdolls, audio | `ChaseCamera`, `Cinematics`, `PostFX`, `TrackArt`, `RagdollSystem`, `Witness`, `SceneFade`, `GameAudio` (one AudioContext, the busses, the listener riding the camera) |
| 8 | **net** | replication over WebRTC | `NetPlay`, the codecs, `NetTransport`, `findMatch` |
| 9 | **hud** | the read model the UI renders | `HudStore`, `CrashHudState`, `KNOB_RANGES`, `INITIAL_HUD`, the share URL |
| 10 | **engine** | orchestration and the frame loop | `CrashEngine` (the only public entry), `RaceDirector` |
| 11 | **ui** | React shell and HUD: `src/components/**`, `src/routes/**`, `src/router.tsx` | `crash-lab.tsx` |
| - | **platform** | template server/client helpers: `src/lib/**` | `P2PRoom`, signaling, `qr`, `cn` |

Deploy (`deploy/`, `server/`, `scripts/` build helpers) sits outside `src/` and is not part of the DAG.

## 2. Boundary rules

- **B1.** Every production file under `src/` belongs to exactly one context (its folder). *Check C0.*
- **B2.** Imports follow the DAG: own context or strictly lower layer; `platform` only from `net`/`ui`; production never imports
  a `*.test.ts`, `*.test-util.ts` or `test-support.ts`. A lateral or upward need means a type or function is in the wrong
  context: move it down, do not add an exception. *Check C1.*
- **B3.** No import cycles between production files (value imports). *Check C2.*
- **B4.** Kernels (`*-core.js`) import nothing and never name `THREE`. They take numbers and typed arrays. *Check C3.*
- **B5.** Rule and data contexts (`kernel`, `world`, `ai`, `match`, `hud`, `net`) never name a scene-graph class (meshes,
  materials, geometries, lights, textures, cameras, groups). THREE maths types (`Vector3`, `Quaternion`, curves) are fine.
  *Check C4.*
- **B6.** An export exists because another production file imports it. Symbols used only in their own file are not exported;
  API only tests use lives in a `*.test-util.ts` beside the suite. *Check C5.*
- **B7.** No `implements` in `src/game` (tests included): it only re-declares a shape and lets each class re-implement the
  same logic. A family of classes extends one base class that holds what they share (`CopBrain`, `NetTransport`,
  `RigLayer`). *Check C11*, capped at the 4 `Ground` implementers.

## 3. Construction and ownership

- **O1.** `CrashEngine` is the single composition root: it constructs the cars, rigs, directors, `NetPlay`, FX systems and
  camera, and hands each one what it needs. No other production module constructs another context's top-level object
  (tests may build any object directly).
- **O2.** No module-level mutable state. World state hangs off an object the engine owns, so a second engine, a replay or a
  test never inherits it. Module-scope `const` scratch vectors are fine (rule H3), and so is a lazily built constant behind
  `scalar.ts` `once`. *Check C10* (module-level `let`/`var`). The one accepted row is `ground.ts`'s active ground, a
  scene-scoped singleton read from every per-mass loop; one world steps per process, and its writers are the scene reset and
  the race director (O3).
- **O3.** One writer per piece of state: the context that owns a value is the only one that assigns it. Other contexts read it
  through the owner's API.
- **O4.** Whoever creates a GPU resource (geometry, material, texture, render target) disposes it, in the same file. Shared
  resources are marked shared at creation and disposed by their creator; `renderer.info.memory` stays flat across resets and
  scene switches.
- **O5.** Copies of production behaviour are not allowed anywhere, tests included: a test that needs the step, a contact rule
  or a formula imports it (see T1). One job, one implementation.

## 4. Hot path

- **H1.** The per-frame entry points and the per-pair/per-slice queries they call (`HOT` in the script: `tickInner`,
  `fixedStep`, `stepWorld`, `syncPose`, `updateSkin`, `stepStructure`, `physicsSlice`, `resolveCarPair`,
  `applyDrive`, the AI `think`s, `DerbyMatch.step`, …) allocate nothing: no `new`, no `.clone()`, no array or object literal,
  no closure, no `.push`. Results go into caller-owned `out` objects. *Check C6.*
- **H2.** Per-particle, per-vertex and per-hull data live in typed arrays or preallocated objects sized at construction;
  growth happens only on a cold path (spawn, rig change).
- **H3.** Scratch objects are module- or instance-scope `const`s named `_x`, used within one call and never returned.
- **H4.** Inside per-step and per-frame functions: indexed `for` loops, no `try`/`catch`, `arguments`, recursion or
  `for…of`, monomorphic shapes. A hot loop moves into a plain-JS `*-core.js` kernel (typed by a sibling `.d.ts`) only when
  `npm run bench` shows the TypeScript build costing time.

## 5. Tests

- **T1.** Tests drive the production entry points: the engine's own step (`stepWorld`, `engine/world-step.ts`), the phase
  machine (`match/phase.ts`), the real rig, the real contact rule. A harness may assemble a scene but never re-implements
  the loop or a rule.
- **T2.** Fail before you pass: a new behaviour test is seen red once, by breaking the production line it covers.
- **T3.** Assert behaviour the player sees (crush metres, kill speeds, who wins, laps, what a client renders), not wiring,
  forwarding, copies of a constant or source text. Test text reads given / when / then in behaviour terms; cases of the
  same shape are one flat table.
- **T4.** Never deep-compare two computed values (`deepEqual`, `deepStrictEqual`, `notDeep*`): on large float arrays the
  failure diff alone can exhaust memory. Buffers and replays are compared by first mismatch index plus max |diff|
  (`assertSameNumbers`) or by a hash (`assertSameDigest`). *Check C9.*
- **T5.** Deterministic: fixed `dt`, seeded randomness in anything a test measures, no wall-clock reads in the sim. An
  intermittent red is an undiagnosed bug.
- **T6.** Bounded: traces and per-frame captures use ring buffers or fixed caps; every test, probe and sweep runs under a
  memory cap so a runaway dies alone.

Runner: `node --test` semantics with `--experimental-strip-types` (no test framework), through `scripts/run-tests.mjs`, which
starts the slowest files first (`scripts/test-cost.json`; `--learn` refreshes it) and otherwise behaves like the CLI. `npm run test:app` runs the game and
multiplayer suites, `npm run test:game` only `src/game`. Harnesses: `contact/crash-scenarios.test-util.ts` (headless crash
scenarios at the engine's slices), `scenes/contact-parity.test-util.ts` (striker vs car), `world/race-world.test-util.ts`
(the whole race stack headless), `vehicle/test-support.ts` (`forModes`, `DT`).

## 6. Tuning knobs

- **K1.** A knob is a named value: a row in a data table (`rig-spec.ts`, `vehicle-classes.ts` `CLASSES`, `physics-core.js`
  `CRASH`/`TRANSFER`, `world/catalog.ts` `SURFACES`, `hud-store.ts` `KNOB_RANGES`) or a module `const`. Inline magic numbers in
  sim code are promoted when touched.
- **K2.** Every knob carries a comment saying where the number comes from: a source (paper, standard, real-world figure, doc
  section) or a measurement (test, sweep cell, probe, A/B). "Guessed, feels right" is a valid source while the knob is being
  tuned; it says so. *Check C7.*
- **K3.** Knobs the player can move go through `KNOB_RANGES` with defaults in `INITIAL_HUD`; `knob-defaults.test.ts` pins the
  calibrated defaults.

## 7. Wobbly allowances (explicitly allowed)

- **W1. Tuning values change freely.** Moving a knob needs its K2 comment updated and the covering suite re-run.
- **W2. Experiment flags.** A named boolean or enum with a documented default may keep two behaviours side by side while an
  A/B runs. Both paths compile and are exercised; the loser is deleted when the A/B decides.
- **W3. Pooled outcome bars.** Game outcomes and pacing over seeded runs may be pooled ("≥ N of M heats have a winner within
  T"). Physics rules (spin ceilings, zips, sinking, penetration, ramp contact) hold on every run.
- **W4. Visual cheats.** Effects, camera and lighting may ignore physics ([`DESIGN_PILLARS.md`](DESIGN_PILLARS.md) 1). The cheat lives in
  `present`, never in a sim context.
- **W5. Table rows look alike.** Repeated rows in data tables are not duplication.

## 8. Size

- **S1.** Production files ≤ 800 lines, functions ≤ 150 lines. *Check C8*, report-only. Tests are not counted. The six rows it still
  reports are hot-path solvers kept whole on purpose: splitting them would cut a hot loop or a kernel paired with its WASM build, and a
  split is judged on measured inlining, not line count. They are `car-air.ts` `solveRows` and `stepFree`, `cage-mesh.ts` `decimate`,
  `streamed-deform.ts` `skin`, `world/surfaces.ts` (one store for every surface query) and `kernel/shape-match-core.js` (mirrored by the skin kernel).

## 9. Code map

**Engine.** `CrashEngine` is one class in layers, each extending the one before: `engine-core` (state, car roster, shared
queries) → `engine-warm` (shader warm-up, skin kernel) → `engine-hud` (`emitHud`) → `engine-derby` (derby on / off, its netplay
mirror) → `engine-scenes` (scene picker, fade, reset, derby step) → `engine-rigs` (press, pistons, doors) → `engine-input` (keys, pad, HUD commands, `advance`) → `engine-reel`
(crash highlights) → `engine-share` (the `#` URL) → `engine.ts`. `window.__crush` is the live engine (benches and probes).
A race runs through `RaceDirector` (`engine-race.ts`) over `RaceHudLayer` (`engine-race-hud.ts`: HUD read model, next-course flow, setup menu), `RaceWatch` (`engine-race-watch.ts`) and `RaceField` (`engine-race-field.ts`).

**Frame** (`CrashEngine.tickInner`, wall `dt` ≤ 0.1 s):

```
pollInput → stepSceneFade → fxFrame
if playing:  simDt = wallDt × timeScale × cine.timeWarp
             SimPacer.run: whole fixedSteps of physicsSlice(cars) against an 8 ms budget (sim-pace.ts): 1/90 s, one per 90 Hz frame,
                          1/240 s while a crush window is open
               fixedStep: race.drive / applyDrive (seat, derby AI, net peers) → stepWorld (1–8 slices, one when quiet; a step in contact
                          is cut at the 1/240 s floor, 3 slices of 1/270 s at 1/90 s; each: integrate, pair + part contact, SAT passes,
                          stepStructure, clips) → ejections → race.step → cinematic trigger
             stepEdge → scheduleSkins (Witness: off-camera cars defer, small ones stride) → updateSkin
             updatePhase → rigs → FX, ragdolls, smoke, trace → stepDerby → seat.step → cine.update
always:      net.frame → PoseBlend.present (bodies, loose parts and the crush skin drawn at the frame's time between
             the last two sim states) → race.frame → updateCamera → flushVisibleSkins → detail / lamps → audio frame
             (audio on) → cine.render → PoseBlend.restore (the sim's own poses and skin back) → emitHud every 0.05–0.12 s
```

`Witness` (`present/witness.ts`) is the one "could the camera see this?" test behind every cosmetic skip (skins, sparks,
debris, smoke). It never gates the sim, audio or marks.

**Audio** (`present/game-audio.ts`, one `AudioContext`). `GameAudio.frame` is the only per-frame seam; it runs after the lamps, when
the camera (which carries the three `AudioListener`) has its matrix for the frame, and only with audio on. Engine voices are a
fixed pool built at unlock (6 on a desktop, 3 on a phone, `?voices=N` overrides): `VoicePool` seats the priority car (the reel's
focus car, else the followed one) and then the nearest cars within 70 m (a car that holds a voice keeps it out to 77 m), and a held car is displaced only by one at least 30%
closer once its slot has held it 0.75 s, so slots never swap as ranks cross. A slot that changes car fades out, swaps in its
generator for the new tuning, and fades in; it never cuts. Upstream's C++ never frees a waveguide, so each voice builds one
generator per tuning (class x damage tone, 15 at most) once and keeps it (`kernels/motor/motor-processor.js`; `motor-heap.test.ts`
holds the shared 16 MB wasm heap flat over 20 000 re-tunes); never call `updateParameters` on a live generator. The music bus is the slider (at most 0.6) ducked under the player's engine and a
crash. The soundtrack (`present/music.ts`) is one streaming `<audio>` element fed by the music folder's `manifest.json`
(`present/music-manifest.ts`, zod-validated; [`DEPLOY.md`](DEPLOY.md), "Music"); no manifest means silence. Audio reads cars and never writes them.
Gain staging (`audio-mix.ts`, `motor-tone.ts`): a voice is the generator's three channels summed and scaled by
`MOTOR_OUTPUT_GAIN`, never clipped (the sum swings to +-9, so the scale keeps every class, stage and rev under -6 dBFS and a redline near
-12 dBFS; `motor-level.test.ts` renders the real worklet to prove it). The panner is `inverse`, refDistance 6 (the chase camera's
distance, so the player's car is at unity), rolloff 2. The engine bus is the slider x1 (default 0.25) into the master chain: a 2:1 glue
compressor, a peak limiter and a -1 dBFS ceiling (`MASTER_GLUE`, `MASTER_LIMITER`, `ceilingCurve`); the music bus (slider at most 0.6, default 0.15, x0.5 trim) shares the master.
The crash hit (`IMPACT` in `audio-mix.ts`) is a 65 Hz sine thump under a dark noise band (300 Hz, soft 12 ms attack, 0.5 s decay) on an impact bus at 0.42 (-3 dB from
the old 0.6); the bus also feeds a ~1 s stereo noise-impulse convolver (lowpassed at 1.8 kHz, wet 0.45) into the master, so a hit sits in a room beside the engines and music.
The focus car's tyres (`TyreSound`, `present/tyre-sound.ts`; `TYRE` and the pure `squealLevel`, `squealHz`, `thudGain` in `audio-mix.ts`) run through the engine bus, so the Engines slider, the pause fade and the slow-mo lowpass carry them,
and `GameAudio.frame` hands them the priority car (nothing for any other car). Squeal: one 2 s noise buffer, looped, through a bandpass (Q 3, 1 kHz at a standstill to 2.5 kHz at 40 m/s, wobbled +-70 cents at 6 Hz) and a gain
(at most 0.06, time constant 25 ms, so 95% in 75 ms) set every 1/30 s from `drive.slide` (drift or sideways slip: from 0.3, full at 0.9, gated by ground speed 2-8 m/s), `drive.lock` and `drive.spin` (x0.8 each); none with every wheel off the ground.
Measured muted in a browser (handbrake slide, then a hard stop, sedan, Engines at 0.25): the squeal's RMS sits 5 dB under the engine's in a slide and 10 dB under it braking hard. Thud: a 60 to 35 Hz sine over 0.25 s plus a short 400 Hz lowpassed burst of the same noise, at 0.015 per m/s of
fall (at most 0.2), on each landing. A landing is `LandingWatch` (`present/landing.ts`), which the chase camera's wobble reads too, so the two cannot disagree: four wheels down within 0.3 s of a flight of at least 0.3 s whose fastest fall passed `LANDING.fall` (5 m/s, the camera's "Fall" knob);
the reported fall is that fastest speed, because the touchdown has eaten most of the last frame's (a nose-first landing takes the wheels down over a few frames). Audio imports `landing.ts`, never the camera.
The race menus (setup, pause) carry the Sound, Music and Engines rows, since their modal covers the settings panel.
Engine loudness (`engine-law.ts`): a voice's level follows how a real car's audible level moves with load and revs (BMW M5 Active Sound
Design: load is the dominant control). `engineLawDb(rpmFrac, load)` is the target in dB under a redline at full load (which keeps the
voice's -12 dBFS peak at `MOTOR_OUTPUT_GAIN`): 3.3 dB per doubling of rpm, plus the M5's load curve (flat under 0.15, 8 of 22 dB at half
load, the rest at 1) scaled to an 8 dB coast-to-wide-open span, so idle coast sits 18 dB under redline wide open (real cars span ~30 dB; at the default slider that left idle inaudible). The worklet's own
level wanders +-4 dB with rpm and ignores its throttle parameter, so `NATURAL_DB` holds each class's measured RMS on a 9-point rev grid
(`motor-level.test-util.ts` renders it) and `engineLawGain` is law minus natural: the combined output follows the law, and a redline at
full load gets gain 1. `MotorSound.driveVoice` aims each voice's fade gain at `MOTOR_OUTPUT_GAIN x engineLawGain` every tick, with the load
eased by `easeLoad` (0.1 s attack, 0.3 s release time constants); a misfire dip is a share of that level and holds the per-tick level off while it lasts.

**Scenes** (`scenes/scene-id.ts` `SCENE_IDS`, one at a time via `setScene`): fleet (default, with the barrier, ramp balls
and jump ramps as props), press, pistons, doors, corkscrew, stack, derby, race, range, survival. A pick fades through the
cel look and black (`SceneFade`); `__crush.fadeScenes = false` skips it for probes. Keys: [`CONTROLS.md`](CONTROLS.md).

**HUD.** `CrashEngine.emitHud` → `HudStore.publish(snapshot)` → `useSyncExternalStore` in `crash-lab.tsx` → `components/hud*.tsx`.
The HUD calls engine setters and `raceCommand(cmd)`; it never touches sim state.

**Kernels.** `kernel/physics-core.js` and `kernel/shape-match-core.js` are plain JS with `.d.ts` types (TypeScript's emit
was several times slower on these loops). `deform/skin-kernel.wasm` is the skin and normals loop, built from
`kernels/skin/` by `npm run build:kernel` and committed; the JS skin stays the reference and the fallback.

## 10. Changing these rules

A rule changes by editing this file and `scripts/check-boundaries.mjs` in the same commit, with the reason in the commit
body. Adding a file to a context, a name to `HOT`, or a context to the DAG is a normal change; adding an exception list is not.
