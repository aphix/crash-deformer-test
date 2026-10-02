<!-- Generated: 2026-10-02 | Files scanned: 38 | Token estimate: ~1400 -->
# Testing and harnesses

Runner: `node --test` with `--experimental-strip-types` (no Vitest / Jest). Node ≥ 22.6 (verified on 24.15).

| Command | Runs | Status at f9e42be |
|---|---|---|
| `npm run test:app` | `src/game/**/*.test.ts`, `src/lib/multiplayer/**/*.test.ts`, `scripts/with-app-env.test.mjs` | 746 tests: 695 pass, 51 todo, 0 fail. **The gate.** |
| `npm run test:game` | `src/game/**/*.test.ts` only | subset of `test:app` |
| `npm test` | `scripts/**/*.test.mjs` **&&** `src/lib` suites + `src/game/**` | exits 1: 9 of 196 script tests fail (8 in `scripts/grok-pwa-plugin.test.mjs`, platform template; 1 in `scripts/migration-plan.test.mjs`, which predates `migrations/0002_webrtc_signaling.sql`), so the `&&` never reaches the app suites |

## Game suites (`src/game/`)
| File | Covers |
|---|---|
| `physics-util.test.ts` | `CRASH` constants, crush bands, transfer, `cancelClosing`, sphere separation |
| `crash-physics.test.ts` | both modes (`forModes`), lattice beams, frame-rate independence, glass, car-car crush vs speed |
| `crash-parts.test.ts` | beams, detach / wheel rules by where the hit lands |
| `shape-match.test.ts` | polar decomposition, goals, plasticity, normals, local skin, shape solver across hits |
| `barrier.test.ts` | jersey barrier full speed vs slow-mo, engine-kill speeds, rigid-wall crush vs NCAP / IIHS |
| `compactor.test.ts` | `COMPACTOR` stages, crush to wheel wells / past hubs, masses and cages stay inside the plates |
| `piston-rig.test.ts` / `engine-pistons.test.ts` | ram geometry, standard shot, locality, tap, severity, kill EBS, lattice mode / loop hops paced by the orbit |
| `door-rig.test.ts` | the ram knocks off only what the sketch says (A / B / C); hinge stop, latch, slam overload |
| `contact-parity.test.ts` | a car on the Doors ram lane does what the ram does; car sandwich vs the press at matched travel (`docs/CONTACT_PARITY.md`) |
| `skin.test.ts` / `skin-lod.test.ts` | skin follows particles (3 km/h tap, 40 km/h shot); deferred skin is owed, never lost |
| `fast-normals.test.ts` | `computeNormalsFast` equals `computeVertexNormals` |
| `zip.test.ts` | a captured two-car spawn does not zip at the slow-mo handoff |
| `rest-mesh.test.ts` / `car-variants.test.ts` | rest body is a sedan (side profile, panel sizes, closed from the side); body styles, per-style rig cages |
| `lamps.test.ts` | a detached bumper leaves the lamps behind; lamp light pool |
| `vehicle-classes.test.ts` | class stats, realism axis, damage → drivability |
| `knob-defaults.test.ts` | calibrated crash knob defaults |
| `fleet.test.ts` / `derby.test.ts` | layouts, pile-up heading; derby AI, scoring, bowl clip, six-car match |
| `gamepad.test.ts` / `drive-input.test.ts` | pad mapping, steering feel, pedals, `DriverSeat`, drive camera |
| `net/net.test.ts` | netplay codec; a client car reproduces the host's final mesh and collision points |
| `world/track.test.ts` / `placements.test.ts` | gate direction, walls, banking, bridge decks, layout validation; prop placement |
| `match/session.test.ts` / `race-finish.test.ts` | race rules and campaign; a race finishing through the real stack (`world/race-world.test-util.ts`) |
| `ai/race-ai.test.ts` / `traffic.test.ts` / `menu-nav.test.ts` | race AI, NPC traffic, controller menu focus (`navTarget`, `stickDir`) |

Outside `src/game/`: `src/lib/multiplayer/rate-limit.test.ts` (signaling rate limits per peer / IP) and `scripts/with-app-env.test.mjs` (the wrapper that merges `.grok/app-env.json` into the environment of `dev`, `build` and `preview`).

## Harnesses
- `src/game/contact/crash-scenarios.test-util.ts`: headless engine frame order. `makeCar(mode, squash, buckle)`, `makeWorld(cars, barrier, slomo)`, `tickWorld(w, wallDt)` (the physics part of `tickInner` + phase timing), `runWall(speedKph, overlap, approach): CrashResult`, `runPair(kphA, kphB, "head-on" | "t-bone", opts)`.
- `src/game/scenes/contact-parity.test-util.ts`: `parkCar`, `carState`, `ramDoorPass` / `carDoorPass`, `pressUntil`, `carSandwich`, `pistonFront` / `carFront`, `shortening`, `crushMismatch`: the same hit delivered by a striker and by a car.
- `src/game/vehicle/test-support.ts`: `DT`, `MODES`, `forModes(title, fn)` (one `describe` per deform mode), `dummyGeom()`, `paint()`, `mass(d, name)`.
- `npm run sweep` → `scripts/crush-sweep.mjs`: squash × buckle grid over `crash-scenarios`, scored against `docs/RIG_ANALYSIS.md` targets (`docs/CRUSH_CALIBRATION.md`).
- `npm run bench` → `scripts/bench-physics.mjs`: ns/op of the JS kernels. `scripts/bench-browser.mjs`: Playwright frame bench through `window.__crush` (usage in `README.md`).
- `npm run check:programs -- --url <dev or preview url>` → `scripts/check-programs.mjs`: program warm-up guard in headless Chromium (about 3 min). Plays the sandbox (fleet crash with cracked glass, drive, night / wet, every FX tier, every scene, debug views) and a race on every course, and fails if any GPU program links after the boot warm-up or between a race's green light and its end. Needs a running server and a browser, so it is a script, not part of `test:app`. See `docs/PERF_HITCH.md`.

## `todo` convention
Behaviour that is documented but not yet met stays in the suite as a todo, so the body still runs and reports but cannot fail the run:
- `it.todo("name", fn)` (e.g. `crash-parts.test.ts`, `derby.test.ts`);
- `it(name, { todo: REASON }, fn)`: `piston-rig.test.ts` keeps the reasons in a `TODO` map (a key absent from the map runs as a normal test), `contact-parity.test.ts` uses one `PENDING` reason.

`node --test` lists failing todos under "failing tests" with `# TODO`, yet exits 0. When the code meets the target, delete the todo entry so the test becomes a hard gate (`docs/PISTON_RIG.md`).

## Related
[physics.md](physics.md) · `docs/PISTON_RIG.md` · `docs/DOOR_RIG.md` · `docs/CONTACT_PARITY.md` · `docs/CRUSH_CALIBRATION.md` · `docs/RIG_ANALYSIS.md`
