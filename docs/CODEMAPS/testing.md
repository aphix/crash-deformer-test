<!-- Generated: 2026-10-03 | Files scanned: 38 | Token estimate: ~1400 -->
# Testing and harnesses

Runner: `node --test` with `--experimental-strip-types` (no Vitest / Jest). Node ≥ 22.6 (verified on 24.15).

| Command | Runs | Status at 5c50fc1 |
|---|---|---|
| `npm run test:app` | `src/game/**/*.test.ts`, `src/lib/multiplayer/**/*.test.ts`, `scripts/with-app-env.test.mjs` | 1197 tests: 1146 pass, 51 todo, 0 fail. **The gate.** |
| `npm run test:game` | `src/game/**/*.test.ts` only | subset of `test:app` |
| `npm test` | `scripts/**/*.test.mjs` **&&** the `src/lib` suites + `src/game/**` | exits 1: 8 of 196 script tests fail, all in `scripts/grok-pwa-plugin.test.mjs` (platform template), so the `&&` never reaches the app suites |
| `npm run check:boundaries` | `scripts/check-boundaries.mjs --ratchet` (structure rules, `docs/ARCHITECTURE.md`) | total 23, at the caps in `scripts/boundary-caps.json`; exit 0 |

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
| `rest-mesh.test.ts` / `car-variants.test.ts` | rest body is a sedan (side profile, panel sizes, closed from the side); the wheel (crown = `TYRE_R`, x-symmetric, tread normals out, only the tread samples the tread map); body styles, per-style rig cages; police livery, light bar on the roof (every foot sole within 1.2 cm of it) that bends with it at 56 km/h and tears off at 64 km/h |
| `lamps.test.ts` | every body (and the lifted monster) seats each lamp whole on its own end panel, clear of every part, facing out, lit from where it is drawn; a detached bumper leaves the lamps behind; lamp light pool; police sirens flash red then blue through a pooled point light |
| `vehicle-classes.test.ts` | class stats, realism axis, damage → drivability |
| `knob-defaults.test.ts` | calibrated crash knob defaults |
| `fleet.test.ts` / `derby.test.ts` | layouts, pile-up heading; derby AI, scoring, bowl clip, six-car match |
| `gamepad.test.ts` / `drive-input.test.ts` | pad mapping, steering feel, pedals, `DriverSeat`, drive camera |
| `net/net.test.ts` | netplay codec; a client car reproduces the host's final mesh and collision points |
| `world/track.test.ts` / `placements.test.ts` | gate direction, walls, banking, bridge decks, layout validation; prop placement |
| `match/session.test.ts` / `race-finish.test.ts` | race rules and campaign; a race finishing through the real stack (`world/race-world.test-util.ts`) |
| `ai/race-ai.test.ts` / `traffic.test.ts` / `menu-nav.test.ts` | race AI, NPC traffic, controller menu focus (`navTarget`, `stickDir`) |
| `ai/derby-ai.test.ts` | derby tactics (a handbrake swing at a nose beside the rear wheel, never on the driver's door), the shared aggression model, ten-car bowl |
| `match/derby-parity.test.ts` | the derby AI follows the player's rules: a flipped running car is righted after the self-right delay on the player's own slice (a dead drivetrain, an upright or a sliding car is not), and its boost meter drains, refills and takes the takedown bonus at the seat's rates, boosting only on a nose-first charge 8–25 m ahead that is not head-on |
| `present/witness.test.ts` | the camera cone behind every cosmetic skip: in view and at the frustum edge, margin, far behind / past the far plane is not, before the first `aim` or switched off everything is; `sees` counts refusals; over random cameras a box with a corner in the viewport is never missed |
| `present/scene-fade.test.ts` | `SceneFade`: idle without a request, cel ramps to 1 before black, one switch at black, 0.6–0.9 s end to end, retargets, reduced motion (black only), black held through the warm-up (up to `waitMax`) with the new scene's sim held |
| `present/spectate-cam.test.ts` | trackside cam: every pick clear of every solid and in sight of the car, holds until just after the car passes; a search cut into 40-sample budgets lands on the same spot as a whole one; wheel-well dutch cam; `clearSpot`, `camUsable` (a building or a lamp post blocks), `SightLines` sliced one line at a time answers as the whole check, `aheadPoints` along the course; the Auto spectator cam (clear cuts, a cut onto another car poses the chase first, a low-passed heading at 60 and 240 Hz) |
| `present/engine-camera.test.ts` | a drag orbits the ride-along and holds its cuts for `RIDE_PAUSE`; the orbit stays 3 m from every lamp post; the chase eye's pull-in (`EyePull`) is smooth at 60 and 240 Hz |
| `present/engine-cine.test.ts` | crash cam on every course: eyes with room that all see the car; one held cut through a clip's hits |
| `match/auto-watch.test.ts` | `AutoWatch`: leaving an idle car (the 4 s floor), validity, rotation, an imminent big crash, determinism |
| `present/engine-ragdoll.test.ts` / `ragdoll-trigger.test.ts` / `engine-ragdoll-motion.test.ts` | a disabling head-on / side hit throws the driver through the glass at his pre-hit speed and nothing else does; thrown drivers are cosmetic (cars move the same); the throw's slow-mo waits until he is out; the ride opens on the windshield; the 1/120 s step lands the range throw within 1 m at 30–360 Hz and it settles |
| `present/ragdoll-env.test.ts` | a thrown dummy stops on the face of every prop a car meets (building, grandstand, billboard, lamp, tree, rock, barrier block, hay, tyres, crate, cone), inside a tunnel's walls and roof, under and on a bridge deck, on the fleet ramps and against their sides, in the corkscrew and at a sandbox lamp post; a reset leaves no stale colliders |
| `present/auto-fx.test.ts` | the auto FX tier: hardware desktop vs software, load checks, step down, `canHost` |
| `vehicle/car-load.test.ts` | `LoadTransfer`: the drawn body squats, dives and leans per class within its limits; never pitches against the road's own slope |
| `vehicle/panels.test.ts` / `panel-frame.test.ts` | all six panels per body style cut from the body's skin; hinge, then tear; torn panels lie flat and dent deterministically; a hinged shell rides the body it was cut from and is rebuilt when it changes, not every frame |
| `deform/skin-kernel.test.ts` | the WASM skin and normals leave the JS skin's bits, frame by frame (`deform/skin-kernel.test-util.ts` loads the committed `.wasm`) |
| `vehicle/wheel-rest.test.ts` / `wheel-spin.test.ts` / `bank-wheels.test.ts` / `ramp.test.ts` / `edge-fall.test.ts` / `deform-reset.test.ts` | a car missing wheels rests on its empty corners; signed drawn wheel spin; wheels on banked road; a braked car lands flat on a wedge; the fleet disc's edge (fake, vaporize, respawn); a reset car has every deform field as built |
| `scenes/fleet-ramps.test.ts` / `corkscrew.test.ts` / `contact/slope.test.ts` / `physics-alloc.test.ts` | jump ramps (landing, no tyre sinks); corkscrew launch speed decides air and roll; crashes on a side slope; per-frame allocation bound for a 24-car pile-up |
| `net/matchmaking.test.ts` | Play online: which listed rooms are open and their order, searchers who click together end in one room, the live-rooms poll cadence |
| `net/net-session.test.ts` / `race-net.test.ts` / `reel-codec.test.ts` | a guest's seat survives the network, stale input and hidden tabs, public matches; race seats and the replicated rules state; the highlight codec round trip |
| `engine/engine-highlights.test.ts` / `engine-record.test.ts` / `engine-record-bystander.test.ts` / `engine-replay.test.ts` / `engine-trace.test.ts` / `match/highlights.test.ts` | the highlight reel timeline, recorder, bystanders, headless replay, trace camera fields, clip scoring |
| `hud/reset-prompt.test.ts` / `share-url.test.ts` / `speed-units.test.ts` | the reset prompt's input and caption rules; the shareable URL's encode / decode (malformed values fall back, round trip, the room field, boot precedence); speed unit by locale |
| `world/course-intrusion.test.ts` / `race-player.test.ts` / `race-replay.test.ts` | no prop or building on the road, no step in the ground across a course; the player scored like the AI; races in a row play out as on fresh cars |

Outside `src/game/`: `src/lib/multiplayer/rate-limit.test.ts` (signaling rate limits per peer / IP), `signaling.test.ts` (inbox access, host per room, seats) and `scripts/with-app-env.test.mjs` (the wrapper that merges `.grok/app-env.json` into the environment of `dev`, `build` and `preview`).

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
