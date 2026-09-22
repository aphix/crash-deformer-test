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

| | |
|---|---|
| Space | pause |
| R | reset / reshuffle |
| B | jersey barrier |
| C | compactor |
| D | demolition derby (not while driving) |
| G | deform rig |
| K | ramp balls |
| V | deform rig |
| M | shape ↔ lattice |
| J | JSON trace capture (off by default) |
| JSON button | copy this run's spawn (counter = 1; no extra ticks unless capture is on) |
| drag / scroll | orbit camera |
| click a car | follow it |
| WASD | drive the followed car |
| Shift | boost (drains, recharges, fills on a derby takedown) |
| Space | brake while driving, otherwise pause |
| T | first / third person while driving |
| Esc | drive → follow → whole field |

HUD sliders: squash, buckle, FX, car count (1–32), speed min/max, time scale (clear the field to return to 1×). **Defaults** resets the lot.

## Layout

- `src/game/derby.ts` / `derby-ai.ts` / `car-drive.ts` / `derby-arena.ts` — derby match, AI, player seat (`DriveInput`)
- `src/game/engine.ts` — sim loop, camera, collisions
- `src/game/engine-fx.ts` / `engine-world.ts` — debris, sparks, smoke, audio, asphalt, barrier
- `src/game/shape-match-core.js` — polar / clusters (hot)
- `src/game/physics-core.js` — crumple bands, impulses (hot)
- `src/game/streamed-deform.ts` — cages, masses, skin
