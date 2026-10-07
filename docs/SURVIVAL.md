# Survival (Driver 2 Havana)

Driver 2's Survival mode on its own course, Havana's Plaza de la Revolución: one car, a pack of cops that grows, and a
stopwatch that is the score. Survive as long as possible while more and more cops try to wreck you.

## The mode

- **Entry:** the scene bar's **Survival** button (desktop dock and phone picker), the **S** key from the whole-field view
  (S is the brake once a car is driven), the **Survival** button in the Race "Pick a course" menu, or `#scene=survival`.
- **Single player.** A netplay room never offers it: the button is hidden while hosting or joined, `setScene` refuses it, a
  link that names a room drops `scene=survival` (`decodeShare`), and a room opened while in Survival sends the player back to
  the fleet (`EngineScenes.stepSceneFade`).
- **A run:** the player starts at `survival.start` of the course file, four to six cops in `survival.formation` behind it.
  The race's grid and red-yellow-green countdown run first (`RaceSession`); the cops are held on the brake until the green.
  The stopwatch counts up from the green. The best time per course is kept in `localStorage` (`crush.survival.best.<course>`,
  `engine/survival-store.ts`); blocked storage keeps nothing and the run still ends with its result.
- **Busted:** the race's rule (`RaceSession.busting`: within 20 m of a chasing cop, under 20 km/h, unbroken) held for
  `SURVIVAL.bustTime` = 12 s (`match/survival.ts`). The pursuit strip (`components/race-status.tsx`, bottom centre,
  "Chased by N cops") shows the hold running out.
- **Wrecked:** the race's `judge` (driver thrown out, engine dead, upside down for 2.5 s). Survival is a no-reset run: either
  ends it.
- **Results:** the BUSTED / WRECKED banner (`race-busted.tsx`) and the race's crash reel come first, then the results card
  (`components/survival-hud.tsx`: time, best with a *New best* mark, cops wrecked, the cause) with Retry and Leave. Retry
  restarts through the race's `start`; Leave and the pause menu's Quit go to the fleet.
- The run is a `RaceDirector` in survival mode (`enter(true)`): `session.noReset`, `session.endless` (no gates, laps or
  finish), no traffic, the hunters instead of the police brain. The crash cinematic, slow-mo and the loop's auto-reset are
  off, as in a race.

## The map

`world/tracks/havana.json` (id `havana`), exported as `HAVANA` from `world/tracks/havana.ts`. It is in `OFF_MENU`
(`world/tracks/index.ts`), not in `TRACKS`: the race menu, the campaign and the per-course sweeps do not list it, and
`RaceField.load` resolves it by id. Plan, +z up (`docs/shots/havana-top.webp`; the owner's reference is the Driver 2
Havana minimap):

- **The island.** A D: flat side north, round side south. The ring road round it is the track's closed main loop: 12 m of
  asphalt, 3 m of concrete sidewalk each side, kerbs, 32 nodes, 4 checkpoints, the start gantry on the east leg. The lawn
  inside it is `environment.paint` (grass over bare concrete terrain); the rest of the ground is concrete.
- **The grid.** Traffic routes with `count: 0` (they put roads in `Track.paths()` and nothing on them): `boulevard`,
  `north-st`, the cross streets, `avenue-east/west` (x ±110), `paseo` (south), `alley`. Pastel stucco blocks in seven tints
  along them; palms along the boulevard, the paseo and the island's east and west edges.
- **The approach.** The boulevard: 20 m wide, 424 m long from (0, 476) to the ring, straight at the hill, palms beyond each
  edge, blocks 11 m beyond that. The monument is in view from the start (`docs/shots/havana-start.webp`). From rest at full
  throttle a sedan reaches about 91 % of its top speed at the foot (`havana-fit.test.ts`).
- **The face and the plaza.** The plateau's near side rises 4 m over a nominal 16 m (14°), 24 m wide, grass
  (`havana-face-side.webp`). The plaza on top is 24 × 36 m of concrete with the monument at (4.5, 0): a star-plan stone
  tower 55 m tall, its collider a 5.8 m circle; 12 m of plaza is clear on its left.
- **The crest and beyond.** The top meets the face in a parabola 6 m either side of the nominal edge, so a car leaves the
  ground over it at about 25 m/s and up (`havana-mid-air.webp`). The far side falls 4 m over 18 m to the ring's south leg;
  past it the landing area is the paseo between two lawns, 150 m long, with no solid prop within 60 m of the line.
- **The escape alley.** A cobbled street 5.5 m wide at x −36.5 along the plaza's left side, a stucco wall along its west
  side, a stub wall across it at z −12 and a dumpster behind the stub (`havana-alley.webp`).
- **The rim.** The city is closed: one row of 184 stucco blocks (12 m, 14 m tall, overlapping) stands round the whole grid,
  inner faces at x ±176, z −221 and 482, 6 m past the end of every street. There is no out-of-bounds rule: a flood fill over
  the solids from the start reaches no edge cell, and 20 launches at 60 m/s (each side's seams, a block centre, the four
  corners) all stop inside the faces (`world/survival-chase.test.ts`).
- **Light.** `environment.light`: a warm sun, a cool sky hemisphere and a warm fill; sky and fog `#a8cfe3`, fog 0.0012.

**Anchors.** `Track.survival: SurvivalSpec | null` (`world/track-schema.ts`): `start {x, z, yaw}` and `formation`, 4–6 cop
slots behind it. Havana: start (0, 426) yaw π (facing −z, at the hill); five slots at z 437–459, ±2.6 m, staggered 4–7 m.

**Terrain** (`world/terrain.ts`): Gaussian hills cannot make a crest, so the heightfield takes `environment.plateaus`
after the roads are stamped: a flat top at `height`, each side a plane down over its `run`, corners as cones, crest and foot
rounded over `round` m (a parabola). A bare crest would hang two of a car's four tyres at once; `round` must be 3 or more
(the drop matrix fails at 0). `checkPlateaus` rejects a plateau whose footprint touches a road. Havana's: half-size 12 × 18,
height 4, run [10, 10, 18, 16], round 6.

## The cops (`ai/hunter.ts`)

`HunterBrain` (extends `CopBrain`, shared with the race police) drives cars `first … first + HUNT.units − 1` over open
ground: up the embankment and across the plaza, not along a road. It shares the police code: `attackTarget` (PIT, slam,
block, head-on within `ATTACK` = 35 m), `pursuitSteer`, `Backoff` (back off when wedged) and `CATCH_UP` (boost when more
than 20 m behind).

- **Pack guard.** Every hunter's drive ends with `guardMates` (`ai/pack-guard.ts`, as `PoliceBrain.think` does): it steers
  away from, and brakes for, the pack-mate it would reach soonest within 3 s (`docs/RACE_DESIGN.md`, "Pack guard").
- **Queueing.** A target faster than `PIT_MAX` = 20 m/s is queued behind (a lane `TAIL_LANE` = 2.6 m either side, a row every
  `ROW` = 8 m), and a unit closing faster than it can brake goes straight on.
- **Beyond `ATTACK`** it aims at where the player will be, bent round solid props on a 16 m grid.
- **Escalation:** `copsWanted(time, formation)` = the formation plus one every `HUNT.every` = 12 s, up to `HUNT.cap` = 12
  hunting at once. `HUNT.units` = 16 cars are built; the rest are wrecks waiting to be put away. One drop-in per `HUNT.gap`
  = 1.5 s.
- **Drop-in:** a cop wrecked (`judge`) or lost (more than `HUNT.far` = 140 m from the player and hidden for `HUNT.farTime` =
  5 s) is put away, and a new one is dropped onto a road 70–120 m from the player, ahead of its travel first, 12 m clear of
  every car, where the camera cannot see it (outside the view frustum by 8 m, or behind a solid). The spot must stay
  `HUNT.dropMin` = 70 m from the player's straight-on path over the next `HUNT.lag` = 0.07 s. A wreck is put away only after
  `HUNT.wreckStore` = 6 s and only while hidden.
- Cops are as tough as the race's police (`police` class, durability 1.3).

## Tests

| Rule | Test |
|---|---|
| bust at 12 s held, not a step before; 20 m, 20 km/h; the hold restarts; no laps | `match/survival.test.ts` |
| the schedule, drop-ins only where hidden, wreck / lost put away only unseen and replaced, drop spot on a road in the band, steering round a wall, attack geometry, wedge back-off | `ai/hunter.test.ts` |
| start, countdown, bust through the real stack, wrecked ends the run, best-time store (new / worse / blocked), Retry, Quit, schedule on the HUD | `world/survival.test.ts` |
| 5 minutes of scripted play with a chase camera: no drop-in in the camera's view | `world/survival.test.ts` |
| `scene=survival` round trip, never with a room | `hud/share-url.test.ts` |
| the map is closed: no gap in the solids, no seam of the rim lets a car at 60 m/s through | `world/survival-chase.test.ts` |
| a fleeing player's run ends (straight, flee, ring, held: busted or wrecked within 300 s). In the closed arena, with the formation held to a race second spread evenly from 8.1 to 12.1 s over seeds 1–24, the pack ends at least 22 of 24 fleeing runs within 120 s with a cop touching; hunters that never steer miss the bar; a player cornered at 3 m/s is busted in at least 14 of 24 runs and by cops that never move in none | `world/survival-chase.test.ts` |
| the opening set piece on the real course: the cops reach the foot behind the player and leave the ground at the crest | `world/survival-setpiece.test.ts` |
| wheels on the grass and the crest: drop matrix and drive matrix over the face, plaza, crest and alley | `vehicle/havana-fit.test.ts` |

Harnesses: `world/survival-run.test-util.ts` (the director in survival mode, a scripted player, the chase camera),
`world/survival-players.test-util.ts` (the scripted fleeing players and `chase(...)`), `world/survival-arena.test-util.ts`
(the closed arena for the pursuit measurement, not a shipped course).
