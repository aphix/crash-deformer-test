# Crush Stream

A browser car-crash lab: two (or a fleet of) cars, Müller 2005 shape matching, a lattice fallback, jersey barriers, a compactor, and a demolition derby with very basic AI.

## Run it

```bash
git clone https://github.com/aphix/crash-deformer-test.git
cd crash-deformer-test
npm install
npm run dev
```

That starts Vite with HMR on port 8080. Edit anything under `src/` and the preview reloads. Keep the dev server running while you work.

## Tests

```bash
npm test
```

Game physics only (faster):

```bash
npm run test:game
```

## Bench the hot path

```bash
npm run bench
```

Kernels in `src/game/*-core.js` are plain JavaScript on purpose. TypeScript's emit is several times slower on these loops; the sim and the tests both call the JS.

Studio reflections come from `public/env-studio.jpg` (a pre-baked RoomEnvironment). Rebuild with `npm run bake:env` if you change the bake script.

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

- `src/game/derby.ts` / `derby-ai.ts` / `car-drive.ts` / `derby-arena.ts` — derby match, AI, player seat (`DriveInput`)
- `src/game/engine.ts` — sim loop, camera, collisions
- `src/game/piston-rig.ts` / `engine-pistons.ts` — piston rig model and shot measurement (`firePiston`, `pistonLocality`), instanced rams
- `src/game/door-rig.ts` / `engine-doors.ts` — door hinge / mirror knock rig (`fireRam`), instanced ram
- `src/game/engine-fx.ts` / `engine-world.ts` — debris, sparks, smoke, audio, asphalt, barrier
- `src/game/shape-match-core.js` — polar / clusters (hot)
- `src/game/physics-core.js` — crumple bands, impulses (hot)
- `src/game/streamed-deform.ts` — cages, masses, skin
