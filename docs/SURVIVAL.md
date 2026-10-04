# Survival (Driver 2 Havana): the map

Survival is a single-player mode on a Havana course: survive as long as possible while more and more cops try to wreck you.
This file is shared by the two lanes that build it. **The Map part** (this section) is the course; the Rules and Cops parts
(survival rules, the cop AI, the HUD, the scene wiring) are the Survival lane's and are added under their own headings.

## The Map

`world/tracks/havana.json` (id `havana`), exported as `HAVANA` from `world/tracks/havana.ts`. It is in `OFF_MENU`
(`world/tracks/index.ts`), not in `TRACKS`: the race menu, the campaign and the per-course test sweeps do not list it, and
`RaceField.load` resolves it by id. `new Track(HAVANA)` is the loader. Plan, left to right on screen, +z up
(`docs/shots/havana-top.webp`; the owner's reference is the Driver 2 Havana minimap):

- **The island.** A D: flat side north (z 52), round side south (r 55 about (0, -2)). The ring road round it is the Track's
  closed main loop: 12 m of asphalt, 3 m of concrete sidewalk each side, kerbs, 32 nodes, 4 checkpoints, node 0 (the start
  gantry) on the east leg, clear of the boulevard's mouth. The lawn inside it is `environment.paint` (grass over bare concrete
  terrain); the rest of the ground is concrete (sidewalks and blocks).
- **The grid.** Traffic routes with `count: 0` (they put roads in `Track.paths()` and nothing on them): `boulevard`, `north-st`
  (the ring's north leg run on east and west), `cross-130/220/310/400`, `avenue-east/west` (x ±110), `paseo` (south), `alley`.
  Pastel stucco blocks (`stucco`, the `building`'s shape and windows, seven tints) stand along them as `along` rows; palms
  (`palm`) along the boulevard, the paseo and the island's east and west edges.
- **The approach.** The boulevard: 20 m wide, 424 m long from (0, 476) to the ring, straight at the hill. Palms 3 m beyond each
  edge, blocks 11 m beyond that; the centre 20 m is clear. The monument is in view from the start (`havana-start.webp`).
  The start anchor is (0, 426), 390 m from the foot: from rest at full throttle the sedan is at 91 % of its top speed at the foot
  (muscle 96, monster 93, truck 90; measured, `havana-fit.test.ts`).
- **The foot road.** The ring's north leg, 12 m wide, across the boulevard's end.
- **The face.** The plateau's near side: 4 m up over a nominal 16 m (14°), 24 m wide, the whole width one plane; grass.
- **The plaza.** A raised platform, 24 × 36 m nominal, 4 m up, concrete on its flat (12 × 24 m), grass on its shoulders. The
  `monument` stands on it at (4.5, 0): a solid star-plan stone tower, 55 m, nine steps and a spire, collider a circle r 5.8
  m. 12 m of plaza is clear on its left (x -12 .. -1.3).
- **The crest.** The top meets the face in a parabola, 6 m either side of the nominal edge (the plateau's `round`); a
  car leaves the ground over it at about 25 m/s and up.
- **Beyond.** The far side falls 4 m over 18 m to the ring's south leg; past it the **landing area**: the paseo (24 m asphalt,
  the lower road) between two lawns, 150 m long, no solid prop within 60 m of the line (`havana.test.ts` checks it).
- **The escape alley.** A cobbled street 5.5 m wide at x -36.5 along the plaza's left side, from the foot road to the ring's
  south-west, a stucco `wall` (solid, 10 m panels, tinted per panel) along its west side, a stub wall across it at z -12
  and a `dumpster` (solid) in the corner behind the stub.
- **The rim.** The city is closed: one row of 184 `stucco` blocks (explicit `props` of the course file, 12 m blocks 11.7-11.8 m apart so
  they overlap, 14 m tall) stands round the whole grid, centred at x ±182 and z -227 / 488, so its inner faces are at x ±176, z -221
  and 482: 6 m of concrete past the end of every street (the paseo, the boulevard, the cross streets, the avenues). A car at 60 m/s
  in any street stops at it. Blocks, not a rule: a wall needs no code, and the hunters' obstacle grid, the ragdoll's `courseSolids`
  and the camera's sight lines all see the course's props. There is no out-of-bounds end: a flood fill over the solids on a 1 m grid
  (a 1.1 m disc) from the start reaches 0 edge cells, and 20 launches at 60 m/s (every side's first, middle and last seam and one
  block centre, four corners) all stop inside the faces (`world/survival-chase.test.ts`).
- **Light.** `environment.light`: a warm sun (#ffd49a, 2.9), a cool sky hemisphere and a warm fill; sky and fog #a8cfe3,
  fog 0.0012 (a 55 m tower reads at 430 m). `TrackArt` gives them to `WorldStage.look` while the art stands and takes them
  back at dispose.

### Anchors (the contract)

`Track.survival: SurvivalSpec | null` (`world/track-schema.ts`): `start {x, z, yaw}` and `formation`, 4-6 cop slots behind it. Havana:
start (0, 426) yaw π (forward = (sin yaw, cos yaw), so −z, at the hill); five slots at z 437-459, ±2.6 m, staggered 4-7 m, all yaw π.
They stand on asphalt clear of every prop (`havana.test.ts`).

### Terrain: the plateau and paint (`world/terrain.ts`)

Gaussian hills cannot make a crest, so the heightfield takes `environment.plateaus` after the roads are stamped (a plateau is
added on top, so the footprint plus `round` must be clear of every road: `checkPlateaus`, thrown at load): a flat top at `height`,
each side a plane to the ground over its `run` (-x, +x, -z, +z), each corner a cone, the crest and the foot rounded over `round` m
(a parabola). It is continuous with the ground (no step above a kerb: `terrain.test.ts` bounds the grade along lines through
every part). `environment.paint` lays a surface over bare terrain inside a polygon (a road keeps its own). Havana's plateau:
`halfX 12, halfZ 18, height 4, run [10, 10, 18, 16], round 6`.
Why `round`: a bare crest hangs two of a car's four tyres at once. The drop matrix at the crest failed with `round 0` and passes at 3
and up; the 30° diagonal landings roll less the softer the crest.

### Wheels on the grass and the crest: measured

`vehicle/havana-fit.test.ts` (judge shared with `ground-fit.test.ts` in `ground-judge.test-util.ts`; runs in `ground-run.test-util.ts`).

- **Drop matrix:** a car dropped 0.5 m, braked, at 8 headings, all 5 classes: approach (road, edge, kerb), foot road, foot lawn,
  face foot / low / mid / high, crest, plaza top, plaza edge, left slope, left foot, plaza corner, far crest / slope / foot, alley kerb,
  alley, alley south, landing lawn ×2, paseo kerb, ring south: **0 of 1080 cells fail**, no known list.
- **Drive matrix** (the throttle scaled by the surface as the race does; hull and tyre as the judge counts them, less a face's crush
  and a tilted tyre's shoulder): each class straight up the face at 10 / 20 / 30 m/s, from the start at full throttle, and 30°
  across the face (30 m/s, full throttle): the car takes off at z 15-21; 10 and 20 m/s stay on the ground; from 30 m/s 1.1-1.5
  s in the air, landing on the plaza top (z -16 to -19; across the face, on its left shoulder); from the start at full throttle
  2.4-2.9 s, 5.2-8.1 m up over the crest (apex 8.4-11.3 m over the ground), landing on the paseo at z -87 to -127; across the face at
  full throttle 1.7-2.0 s, on the left shoulder or the alley's cobble. Over all 30 runs: **hull in the ground 0.0-1.9 cm** (the muscle
  at 30 m/s is the 1.9; the rest 0.2 or less), **tyre in the grass 0.0-0.6 cm**, **0 drivers thrown out, 0 engine kills, 0 teleports**.
- **Set piece:** a police car at the player's foot speed (50.4 m/s): 2.5 s in the air, 8.8 m over the ground (5.9 m over the
  crest), lands at (0, -92) on the paseo at 43 m/s and keeps going to z -215 at 48 m/s.
- **Perf** (browser, heavy-slot, vsync'd Chromium, 6 cars, 3 interleaved runs): draw calls 59 (havana) against 134-136 (city), triangles
  135,658 against 178,086-190,660. Frame ms was not measured reliably (box contention: per-frame CPU 1.2-11.8 ms havana, 6.5-22 ms city
  across runs). The props are one `InstancedMesh` per prefab part, as on every course.

### For the Survival lane

- Prop contact is height-aware (`PropCollider.top`, `lowestY(car)`): a car flying over a wall or a palm clears it. A rim block is
  14 m, higher than any car in Survival flies (the crest's apex is 8-11 m over the ground, 200 m from the rim).
- `RaceField.props` skipped a box prop until the car's centre was within `max(hx, hz) + 2.6` m of the box's centre. A box's corner is
  `hypot(hx, hz)` away, so a car centred on a seam between two touching blocks was not tested until its nose was about 2 m inside, and
  the push-out then went sideways: at 60 m/s the first seam of the west rim let a car through (69 m past it). The reach is now
  `PropCollider.r` (the bounding radius of both kinds) + 2.6 m. It is the race's rule too: of the 20 race-police races (4 courses x 5
  seeds, 2 laps) 16 are identical, 4 city races change (see the table in Numbers).
- The race's throttle cap on grass (`onSurface`, 60 % of top speed) slows a car on the face; the drive matrix applies it.
- A car that lands rolled can stay `airborne` while it slides on its side (`car.speed` is stale then; use the velocity).
- `Track.paths()` lists the grid; spawn points and respawns can use `routes` (count 0: no civilian traffic).

Shots (each looked at): `docs/shots/havana-start.webp`, `havana-face-side.webp`, `havana-top.webp`, `havana-mid-air.webp`, `havana-alley.webp`.

# The Mode

Driver 2's Survival mode, on its own course (Havana's Plaza de la Revolución): one car, a pack of cops that grows, a stopwatch that is the score. Enter it from the scene bar's **Survival** button (desktop dock and phone picker), the **S** key from the whole-field view (like D for the derby; S is the brake once a car is driven), the **Survival** button in the Race "Pick a course" menu, or `#scene=survival`. The map (embankment, monument, streets) is the course file's, `world/tracks/havana.json`; this page is the mode.

Single player. A netplay room never offers it: the button is hidden while hosting or joined, `setScene` refuses it, a link that names a room drops `scene=survival` (`decodeShare`), and a room opened while in Survival sends the player back to the fleet (`EngineScenes.stepSceneFade`).

## A run

- The player starts at `survival.start` of the course file, four to six cops in `survival.formation` behind it. The race's grid and red-yellow-green countdown run first (`RaceSession`); the cops are held on the brake until the green.
- The stopwatch counts up from the green: that is the score. The best time per course is kept in `localStorage` (`crush.survival.best.<course>`, `engine/survival-store.ts`; blocked storage keeps nothing and the run still ends with its result). The HUD shows it during the run (the best before this run) and on the results card, with a *New best* mark.
- **Busted**: the race's rule (`RaceSession.busting`: within 20 m of a chasing cop, under 20 km/h, unbroken) held for `SURVIVAL.bustTime` = 12 s (the owner's "10-15 seconds"; the race holds it for `BUST.time` = 4 s). One constant, passed to the session as `survival: { bustTime }`. The HUD's meter counts the seconds down while the car is held.
- **Wrecked**: the race's `judge` (driver thrown out, engine dead, upside down for 2.5 s). Survival is a no-reset run: either ends it.
- The results card (`components/survival-hud.tsx`) shows the time, the best, cops wrecked and the cause, with Retry and Leave; the BUSTED / Wrecked banner (`race-busted.tsx`) and the race's crash reel (`recorder.reelReady`) come first, as in a race. Retry restarts through the race's `start`, which empties the scene (`clear`).
- The run is a `RaceDirector` in survival mode (`enter(true)`): `session.noReset`, `session.endless` (no gates, laps or finish), no traffic, the hunters instead of the police brain. The crash cinematic, slow-mo and the loop's auto-reset are off, as in a race (`race.active`).

## The cops (`ai/hunter.ts`)

`HunterBrain` drives cars `first … first + HUNT.units − 1` over open ground: up the embankment and across the plaza, not along a road. It reuses the police's code, not a copy: `attackTarget` (the PIT / slam / block / head-on geometry within `ATTACK` = 35 m), `pursuitSteer` (the one steering rule), `Backoff` (back off when wedged) and `CATCH_UP` (boost when more than 20 m behind; police have no meter), all exported from `ai/police.ts`, which `PoliceBrain` uses too.

Every hunter's drive ends with `guardMates` (`ai/pack-guard.ts`, the same last step as `PoliceBrain.think`): it steers away from, and brakes for, the pack-mate it would reach soonest within 3 s (design: `docs/RACE_DESIGN.md`, "Pack guard"). Opening set piece with it, `world/survival-setpiece.test.ts` seeds 1-3: 5 / 5 / 5 cops within 0.5 s at the foot (4 on seed 3 before), 5 / 5 / 5 left the ground (3 on seed 3 before), brake-left: 5 passed the player and 5 took off on every seed.

- Beyond `ATTACK` it aims at where the player will be, bent round solid props (`PropCollider`s of `body: "solid"`, on a 16 m grid): the straight heading if it is clear for the next stretch, else the nearest clear one to either side, else the longest clear run. An attacking unit does the same when a solid is nearer than the player. A player slower than 6 m/s is rammed, not blocked from ahead.
- **Escalation**: `copsWanted(time, formation)` = the formation, plus one every `HUNT.every` = 12 s, up to `HUNT.cap` = 12 hunting at once; `HUNT.units` = 16 cars are built, the rest are wrecks waiting to be put away. One drop-in per `HUNT.gap` = 1.5 s.
- **Drop-in**: a cop wrecked (`judge`) or lost (more than `HUNT.far` = 140 m from the player and hidden for `HUNT.farTime` = 5 s) is put away, and a new one is dropped onto a road 70-120 m from the player, ahead of its travel first, 12 m clear of every car, **where `world.hidden` says the camera cannot see it**: outside the view frustum by 8 m, or behind a solid from the eye to both the belly and the roof of a car (`spectate-cam.sightLine` against the course's solids). A wreck is put away only after `HUNT.wreckStore` = 6 s and only while hidden. The formation at the start is placed by the course and is in view by design.
- Cops are as tough as the race's police (`police` class, durability 1.3). **No chase rule changed** for the closed map: on the closed map every scripted fleeing player's run ends under the unchanged cops (Numbers, "A fleeing player"), so the only fix that was needed was the missing edge. The cops ahead (drop-ins at 70-120 m facing the player, `HEAD_ON` / `RAM_TIME`) and the pack behind it (queued behind a target over `PIT_MAX` = 20 m/s, a rear hit when the target brakes) end the run; `police.ts` is untouched, so the race police need no re-measure beyond the `props()` reach row below.

## Tests

| Rule | Test |
|---|---|
| bust at 12 s held, not a step before; same code path as the race (4 s); 20 m, 20 km/h; the hold restarts; no laps | `match/survival.test.ts` |
| the schedule, drop-ins only where hidden, wreck / lost put away only unseen and replaced, drop spot on a road in the band, steering round a wall, attack geometry, wedge back-off | `ai/hunter.test.ts` (stub world, deterministic) |
| start, countdown, bust through the real stack, wrecked ends the run, best-time store (new / worse / blocked), Retry, Quit, schedule on the HUD | `world/survival.test.ts` |
| 5 minutes of scripted play with a chase camera: no drop-in in the camera's view (an independent visibility test; the test checks it can see a car ahead of the camera) | `world/survival.test.ts` |
| `scene=survival` round trip, never with a room | `hud/share-url.test.ts` |
| the map is closed: no gap in the solids (flood fill), no seam of the rim lets a car at 60 m/s through, a W-holder stays inside the rim | `world/survival-chase.test.ts` |
| a fleeing player's run ends (straight, flee, ring, held, shuttle, orbit: busted or wrecked within 300 s; the three that avoid the walls end with a cop in contact) | `world/survival-chase.test.ts` |

`world/survival-run.test-util.ts` is the harness: the director in survival mode, a scripted player (waypoints, hold, wedge recovery), the chase camera, and the numbers (`play`: drop-ins and their visibility, the nearest cop each second, stuck cops, ends).

`world/survival-players.test-util.ts` is the scripted fleeing players, and `chase(fleer, seed, seconds)` is one run with its numbers (end, cause, cop contacts, the rectangle driven over).

## Numbers (headless, scripted players; not a human's play)

- Drop-ins in view: 0 of 39 and 0 of 18 in 5 minutes of ring tour (the test's 5-minute run on the contract map and on the first havana tip). Not re-run on the final map.
- Stuck cops (a live cop under 1 m/s for over 3 s, more than 12 m from the player), three 300 s scripted runs (ring tour at 22 m/s, an over-the-hill shuttle, a slow ring at 12 m/s): 3 events before, **0** after. The cause: `Backoff` judged a wedge by speed under 1 m/s, and a cop pushing a building corner reads 1–3 m/s from its velocity (the contact takes the step back), so it sat there for 10 s at (29, 240). It now counts no progress under throttle (under 1.5 m in 1.2 s), for the race police too. Causes found earlier: a unit braking in front of a stopped player for ever, a unit against a wall with no heading away from it tried, steering that fades to nothing when the aim is dead astern, a back-off that never counted under the dodge's throttle cap, a ram that restarted the bust hold.
- Catch-up: flat out down the boulevard without boost, the nearest cop is 11 m behind at the green, 3 m by 4 s and stays within 2-6 m for 30 s (first tip). The cops boost whenever 20 m or more behind.
- Opening set piece, final map, a player who holds the boulevard line at full throttle (x = −6 ± 1.5 m, looking 25–40 m ahead, steering back when shoved; `world/survival-setpiece.test.ts`, 3 seeds): before the queue rule 2 / 0 / 2 cops within 0.5 s at the foot, 0 cops left the ground at the crest, the player shoved 17 / 34 / 5 m off his line. After: 5 / 5 / 4 within 0.5 s (foot at 15.55–16.13 s), 5 / 5 / 5 left the ground at the crest, the player never touched. A player who brakes hard near the crest's left (veering to x = −9 from z 85): 5 / 5 / 5 cops overshoot him and 5 / 5 / 5 fly off the crest. Cause: a car that has touched anything is crashed for good and never launches (a clean car takes off at 34 m/s and up); the pack's PIT and slam lines touched the player at about 26 m/s and shoved him into the palms. The fix is the shared rule in `police.attackTarget`: a target faster than `PIT_MAX` = 20 m/s is queued behind (a lane `TAIL_LANE` = 2.6 m either side, a row every `ROW` = 8 m), and a unit closing faster than it can brake goes straight on (`OVERRUN`).

- Held still beside the cops (handbrake, 80 m down the boulevard behind a test wall), final map: the cops wreck the car at 28.6 s with 3 cops wrecked, after an 11.1 s hold: 0.9 s short of the bust. Ramming against the 12 s hold is an open tuning question; the cops already ease to a creep within 12 m of a stopped player. The exact 12 s is tested at the session (`match/survival.test.ts`); the full-stack test accepts a bust or a wreck and rejects an early bust.

- CPU cost of a frame (physics, contacts, rules, hunters; no render), node, ring tour at 14 m/s with the pack forced up quickly: 5 hunting 1.05 ms p50 / 1.76 p95; 8: 2.12 / 3.26; 12: 3.05 / 3.82 (max 7.3); 15: 4.11 / 5.98 (max 8.1). About 0.27 ms per cop.

### The browser frame at 4 / 8 / 12 / 16 cops (`HUNT.cap`)

Havana, Chromium, 1280×720, vsync (60 Hz), real rAF frames, `heavy-slot --exclusive`, the ring tour at 14 m/s driven through the touch stick, the pack forced with `HUNT.cap` / `every` / `gap` (and the formation cut to 4) from the page, a 2 s settle then a 12 s window (720 frames = no dropped frame). "CPU" is the engine's whole tick (physics, rules, hunters, render submission) timed in the page; "dropped" is a frame over 25 ms (the next vsync is missed). A run the pack ended inside the window is discarded and repeated.

| Cops | Draw calls | CPU p50 / p95 ms (median of runs) | Batch A (quiet box), 3 runs: frames, dropped | Batch B, 3 runs | Batches C and D (box contended: 4 cops lose frames too) |
|---|---|---|---|---|---|
| 4 | 73-132 | 3.7 / 6.3 (max 16) | 720 / 0, 720 / 0, 720 / 0 | not run | 688 / 33, 642 / 76, 531 / 176 |
| 8 | 143-235 | 5.7 / 9.3 (max 19) | 720 / 0 ×3 | not run | 608 / 111, 518 / 195, 453 / 246 |
| 12 | 152-316 | 7.3 / 11.3 (max 21) | 720 / 0 ×3 | 712 / 9, 702 / 15, 703 / 17 | 354 / 329, 335 / 319, 308 / 303 (C); 540 / 173, 429 / 279, 323 / 308 (D) |
| 16 | 264-363 | 8.1 / 12.0 (max 85) | 720 / 0, 678 / 38, 242 / 240 | 561 / 156, 373 / 259, 274 / 271 | 405 / 232, 297 / 291, 318 / 303 (C); 363 / 331, 286 / 278, 364 / 314 (D) |

Reading it: the engine tick costs about 0.4 ms (p95) per cop and stays under the 16.7 ms budget at 16 (p95 12 ms), so CPU alone would allow 16. The frame does not: on a quiet box 4, 8 and 12 cops hold 720 / 720 frames with no frame over 16.8 ms; 16 does not (one run clean, one with 38 dropped frames and an 85 ms tick, one at 20 fps). Later batches on the same page and box (C, D) lost frames at every count, 4 included, with the same CPU per tick: the GPU path (a shared paravirtual device) got slower, so an absolute 60 fps claim holds only while the box is quiet, and the counts are compared inside a batch (D alternates the counts: frames per window fell 4 > 8 > 12 > 16 in every block). **`HUNT.cap` stays 12**: the largest count that held 60 fps with no hitch on a quiet box. 120 / 240 Hz displays are out of reach at any count: the tick alone is 3.7 ms p50 with 4 cops (the 240 Hz budget is 4.2 ms), mostly the course and the cars, not the cops. Scripts (git-ignored): `.bench/perf.mjs`, results `.bench/perf-run1.json`, `perf2.json` … `perf4.json`.

### Race police under `PIT_MAX` (the shared rule; main 519a3ba against its parent 4504fa1)

Headless races, police on, 4 AI + the AI-driven slot, 2 laps, seeds 1-5, the four menu courses, the same field and dice (three runs of main and two of the parent gave identical rows). Contacts are police-racer contact episodes (a gap over 0.25 s ends one); takedowns are racers busted; knocked out are police cars disabled; deaths are racer respawns; the last two columns are the winner's finish time and the time the race closed (mean, s). Script `.bench/police-ab.test.ts`.

| Course | Tree | Pursuits | Contacts | Takedowns | Police knocked out | Racer deaths | Winner | Closed |
|---|---|---|---|---|---|---|---|---|
| oval | main | 13 | 24 | 0 | 2 | 0 | 35.9 | 39.9 |
| oval | parent | 13 | 37 | 0 | 2 | 0 | 35.9 | 40.0 |
| rally | main | 12 | 92 | 0 | 1 | 0 | 56.0 | 65.5 |
| rally | parent | 12 | 114 | 0 | 5 | 1 | 58.6 | 69.8 |
| stunt | main | 14 | 57 | 0 | 5 | 2 | 61.6 | 68.8 |
| stunt | parent | 15 | 134 | 0 | 9 | 3 | 62.1 | 74.1 |
| city | main | 16 | 206 | 2 | 19 | 14 | 53.1 | 75.4 |
| city | parent | 15 | 218 | 0 | 17 | 13 | 56.0 | 81.2 |
| all 20 races | main | 55 | 379 | 2 | 27 | 16 | 51.6 | 62.4 |
| all 20 races | parent | 55 | 503 | 0 | 33 | 17 | 53.2 | 66.3 |

Pursuits are the same (55 / 55). The rule trades contact for queueing: police-racer contacts fall 25 % (379 against 503; stunt −57 %, oval −35 %), police knocked out 18 % (27 against 33), the races close 4 s sooner. Takedowns do not collapse: they were already 0 of 20 races before the rule (AI racers do not sit still for the 4 s hold); main has 2, both in one city race. The rule is unchanged; the director decides whether fewer contacts at race speed is wanted.

### A fleeing player (the map edge and the chase; this lane on main 2359116, scripted players, 5 seeds each, 300 s cap)

The defect: holding W straight, the player drove 6 km out of town with the pack queued behind for ever. Measured on the open map with the same code (untouched main 9e1250e plus the scripted players): flee, held and shuttle were all still running at 295 s, 15.6 km out (z -15 646 … -15 697), 55.6 m/s, **0 cops in contact**; only the ring (22 m/s) and the orbit (14 m/s), which stay inside the streets, ended (15.8 s and 16.0 s).

Closed (the rim), cops unchanged: **30 of 30 runs end**, 26 of 30 with a cop in contact in the last 2 s (the four others are the player's own wall wreck).

| Scripted player | Ends (s, sorted) | Median | Cause |
|---|---|---|---|
| straight: over the hill on the boulevard line, then pedal down and wheel dead ahead | 16.9 16.9 17.1 19.8 28.8 | 17.1 | 4 wrecked, 1 busted |
| flee: holds W and its heading, steers only to keep clear of solids | 16.9 x5 | 16.9 | 5 wrecked |
| ring: boulevard, then laps the D ring at 22 m/s | 15.8 15.8 27.0 38.4 93.2 | 27.0 | 5 wrecked |
| held: the set piece's driver, flat out over the hill, then flees | 16.9 17.3 32.5 41.5 59.6 | 32.5 | 4 wrecked, 1 busted |
| shuttle: lifts for a wall, turns back, so it keeps running | 63.3 x4, 63.6 | 63.3 | 5 wrecked |
| orbit: circles the lawn round the hill at 14 m/s | 16.0 16.0 22.5 34.9 61.6 | 22.5 | 4 wrecked, 1 busted |

Median of all 30: 21 s. **The owner's target of a median of 1-4 minutes is not met by these players**, and a rule change would not meet it for the W-holders: the map is 710 m long, so a car at 40-50 m/s is at the far wall in 17 s, and a head-on hit at that speed totals the car (straight and flee end at the south rim). Only the shuttle, the best evader the harness has, lasts a minute. A human's play is not measured.

Seeds pin the field's dice, which only the drop-ins use (the first one at 12 s); every run that ends before it is the same run (flee, shuttle).

### Race police under the `props()` reach fix (main 2359116 against this lane; same script and table as above)

Headless races, police on, 4 AI + the AI-driven slot, 2 laps, 4 courses x 5 seeds. 16 of 20 rows are identical (all oval, rally and stunt rows, and city seed 2). City seeds 1, 3, 4, 5 change: contacts 33 -> 37, 73 -> 51, 43 -> 39, 48 -> 37; police knocked out 1 -> 2, 0 -> 2, 6 -> 5; racer deaths 4 -> 5, 5 -> 2, 5 -> 4, 3 -> 4; the winner's time 74.9 -> 63.2 s in seed 3 (the rest within 0.2 s); pursuits 4 -> 3 in seed 5. All 20 races: pursuits 57 -> 56, contacts 429 -> 396, takedowns 1 -> 1, police knocked out 19 -> 21, racer deaths 27 -> 25, mean winner 53.7 -> 53.1 s, races closed in 64.7 s both. Takedowns do not collapse (1 and 1) and no racer is wrecked more at the start. The cause: a racer's corner hit on a building (`building`, `stucco` are 12 m boxes) is now found at the bounding radius rather than `max(hx, hz)`.

Opening set piece (`world/survival-setpiece.test.ts`, 3 seeds, tests unchanged and green; the rows are identical on untouched main 2359116 and on this lane): 5 / 5 / 4 cops within 0.5 s at the foot (15.53-16.10 s); 5 / 5 / 3 left the ground at the crest; a player who brakes at the crest's left: 5 / 5 / 5 overshoot, 5 / 5 / 3 fly off the crest. (Seed 3's take-offs are 3 on untouched main as well; they were 5 at 519a3ba.)

## Browser proof (vite dev in a heavy slot, `__crush.advance` to skip ahead, real frames for every shot, `fadeScenes` off, no uncapped flags)

Havana, 1280×720 and a 390×844 touch phone. Console errors in every session: **0**. Shots are git-ignored (`.bench/shots3`; the script is `.bench/proof3.mjs`), each one looked at.

- **Entry**: the scene bar's Survival button (the scene, the lit chip, the countdown grid); the **S** key from the whole-field view; the Race menu's 'Pick a course' **Survival** button; Full menu (H) with the Survival chip lit; the keys popover lists `S · Survival (whole-field view)`; on the phone the scene picker's Survival chip and the Race menu's Survival button (both tapped, both enter the scene; the thumb pad and the busted meter fit at 390 px).
- **Leave**: Quit or Leave in Survival used to land on the Race 'Pick a course' menu (`RaceHost.leave` was `toggleRace()`, which from the survival scene is a switch to Race); it is now `setScene("fleet")`. After the fix: the Leave button on the results card, and the `quit` command (the pause menu's Quit; run on the phone), go to the fleet; Race menu Back still goes to the fleet.
- **Busted**: held on the handbrake after 16 s of driving: the centre **BUSTED** banner ("The cops boxed you in: the run is over") on the frame the run ended (the sim paused for the shot; the card replaces it after `RESULTS_DELAY` = 2.5 s), then the card (time, *New best*, 0 cops wrecked, a "5-car pile-up" highlight with Watch / Save, the reel behind it), then Retry (best shown, formation back, countdown).
- **Wrecked**: the centre **WRECKED** banner ("Your car is totaled: the run is over") and the card (*Wrecked*, 0:10.221, the best, a "6-car pile-up" highlight). The wreck was made by killing the player's drivetrain (as the tests do), because the pack boxes in and busts a driver first: a driven wreck was never reached in 4 tries (straight into a block, a ring tour at 14 m/s, the monument): each ended Busted after 37-107 s. (On the open map. With the rim, a driven wreck is the usual end: the next three bullets.)
- **Opening set piece**: a player holding the boulevard line at 45 m/s, the chase camera held back with the look-back key (`` ` ``): the cops are behind the player, so they are behind the chase camera and only a rear shot sees them. Three shots mid-air (t = 11.8 / 12.0 / 12.2 s, the player at 6.5 / 7.7 / 8.8 m): 2, 3 and 4 cops off the ground, 1.4-4.4 m over it, over the plaza top beside the monument.
- **Scene entry with the real fade** (not the proof's `fadeScenes` off): the veil lifts at about 2.7 s (the first-use warm-up) and the first frames showed the chase camera still swooping in from the fleet's orbit, 426 m away, level with the ground and in a wall. `ChaseCamera.update` blended in from the current shot whatever its distance; it now cuts when the shot is farther than `CHASE.blendRange` = 40 m (a race start, at 29 m, still blends in: before / after shots match). `present/engine-camera.test.ts` covers both.
- **The map edge, from the chase camera** (`fadeScenes` off; an in-page driver reads the touch stick every frame; this lane on main 2359116; shots git-ignored in `.bench/shots`): the boulevard to the foot (103 mph); over the hill; the paseo with the rim across the whole end of the street as a row of pastel blocks (90 mph, 95 m from its face, palms in front of it); 100 mph with the rim filling the frame and the speed blur on; the stop at the wall (z -217.9, 0.2 m/s) with cops piled on both sides and the bust meter at 11.7 s; the pile 2 s later (1 cop wrecked, a dummy on the road, meter 10.0 s); and the run ending **Busted** at 1:23 with the car pushed to the east rim (x 173.6, z -48.5), then the card (*Busted*, *New best*, 6 cops wrecked, four highlights). Console errors: 0.
- **A cop hits a fleeing player at speed**: the player brakes for the ring's corner from 41 m/s to 14 m/s at z 110 and the formation, 2-3 m behind, comes through: three shots at t = 10.8 / 11.2 / 11.5 s show cops #2 and #4 beside and behind the car at 31 mph, sparks. The run ends **Wrecked** at 29.0 s: the centre **DRIVER OUT** banner over a cop car in the air above the player's, then the card.
- **A player who holds W**: three runs from the green, over the hill on the boulevard line then wheel dead ahead for good: **Wrecked** at 20.7, 19.7 and 16.9 s, all at the south rim (z -217.3, -218.3, -218.7), the **WRECKED** banner over the row of blocks and the cops' pile. Headless the same player ends at 16.9-28.8 s over 5 seeds. One W-holder of the map-edge run above survived the impact at 44 m/s and lasted 83 s, so the end of a W-holder is not always the wall.

## Found, not fixed

- **Esc closes the keys popover and also pauses the race** (the same keydown reaches the engine). Not Survival's.

## Not done

A human's play (the 1-4 minute target is measured only on scripted players, above) and a bust-or-wreck balance for a player who stops.
