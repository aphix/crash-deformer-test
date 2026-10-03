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

- Prop contact is height-blind (`RaceField.props` ignores `y`): a car flying over a wall or a palm collides with it. The monument is
  55 m, so that is right for it; an airborne car over the alley wall (3.2 m) is stopped.
- The race's throttle cap on grass (`onSurface`, 60 % of top speed) slows a car on the face; the drive matrix applies it.
- A car that lands rolled can stay `airborne` while it slides on its side (`car.speed` is stale then; use the velocity).
- `Track.paths()` lists the grid; spawn points and respawns can use `routes` (count 0: no civilian traffic).

Shots (each looked at): `docs/shots/havana-start.webp`, `havana-face-side.webp`, `havana-top.webp`, `havana-mid-air.webp`, `havana-alley.webp`.

# The Mode

Driver 2's Survival mode, on its own course (Havana's Plaza de la Revolución): one car, a pack of cops that grows, a stopwatch that is the score. Pick **Survival** in the scene bar (beside Range), or open `#scene=survival`. The map (embankment, monument, streets) is the course file's, `world/tracks/havana.json`; this page is the mode.

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

- Beyond `ATTACK` it aims at where the player will be, bent round solid props (`PropCollider`s of `body: "solid"`, on a 16 m grid): the straight heading if it is clear for the next stretch, else the nearest clear one to either side, else the longest clear run. An attacking unit does the same when a solid is nearer than the player. A player slower than 6 m/s is rammed, not blocked from ahead.
- **Escalation**: `copsWanted(time, formation)` = the formation, plus one every `HUNT.every` = 12 s, up to `HUNT.cap` = 12 hunting at once; `HUNT.units` = 16 cars are built, the rest are wrecks waiting to be put away. One drop-in per `HUNT.gap` = 1.5 s.
- **Drop-in**: a cop wrecked (`judge`) or lost (more than `HUNT.far` = 140 m from the player and hidden for `HUNT.farTime` = 5 s) is put away, and a new one is dropped onto a road 70-120 m from the player, ahead of its travel first, 12 m clear of every car, **where `world.hidden` says the camera cannot see it**: outside the view frustum by 8 m, or behind a solid from the eye to both the belly and the roof of a car (`spectate-cam.sightLine` against the course's solids). A wreck is put away only after `HUNT.wreckStore` = 6 s and only while hidden. The formation at the start is placed by the course and is in view by design.
- Cops are as tough as the race's police (`police` class, durability 1.3). Measured fun does not call for more yet (no browser play was run, see below).

## Tests

| Rule | Test |
|---|---|
| bust at 12 s held, not a step before; same code path as the race (4 s); 20 m, 20 km/h; the hold restarts; no laps | `match/survival.test.ts` |
| the schedule, drop-ins only where hidden, wreck / lost put away only unseen and replaced, drop spot on a road in the band, steering round a wall, attack geometry, wedge back-off | `ai/hunter.test.ts` (stub world, deterministic) |
| start, countdown, bust through the real stack, wrecked ends the run, best-time store (new / worse / blocked), Retry, Quit, schedule on the HUD | `world/survival.test.ts` |
| 5 minutes of scripted play with a chase camera: no drop-in in the camera's view (an independent visibility test; the test checks it can see a car ahead of the camera) | `world/survival.test.ts` |
| `scene=survival` round trip, never with a room | `hud/share-url.test.ts` |

`world/survival-run.test-util.ts` is the harness: the director in survival mode, a scripted player (waypoints, hold, wedge recovery), the chase camera, and the numbers (`play`: drop-ins and their visibility, the nearest cop each second, stuck cops, ends).

## Numbers (headless, havana at 5603c4a, scripted players)

- Drop-ins in view: 0 of 39 and 0 of 18 (5 min of ring tour on two map versions).
- Stuck cops (a live cop under 1 m/s for over 3 s, more than 12 m from the player): 1 event in three 300 s runs (ring tour at 22 m/s, an over-the-hill shuttle, a slow ring at 12 m/s); it was 5.3 s long with no prop within 14 m and is not explained. Earlier causes found and fixed: a unit braking in front of a stopped player for ever, a unit pressed against a wall with no heading away from it tried, steering that fades to nothing when the aim is dead astern, a back-off that never triggered under the dodge's throttle cap. Target 0 is **not met** by one event.
- Catch-up: flat out down the boulevard without boost, the nearest cop is 11 m behind at the green, 3 m by 4 s and stays within 2-6 m for 30 s. The cops boost whenever 20 m or more behind.
- Opening set piece, from the first havana tip: of the five formation cops, three reach the embankment's foot (z = 44) within 0.09 s of each other and a fourth 1 s earlier; a fifth is knocked sideways by a cop-to-cop contact. The launch at the crest and the overshoot when the player brakes are **not measured**: on that tip the cars followed the far slope instead of leaving the ground. Re-measure on the merged map.

## Not done

Browser proof (60 s of play, the HUD, banners and results card as shots), the frame cost at the cap of 12 cops, and the full gate at the merge sha are not in this page's numbers: see the lane report.
