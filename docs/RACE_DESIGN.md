# Race mode (as built)

Circuit racing on top of the crash sandbox: 2–16 racers plus NPC traffic, 3–5 laps from the menu,
hidden checkpoint gates, designed shortcuts, respawn or no-reset elimination, AI racers with an
aggression dial, an arcade HUD with a focus view, controller-driven menus, and a campaign over every
course. Scene picker **Race** or key **Z**.

Research: `.extraResearch/perplexity/23-race-checkpoints-laps.md` (gates, key checkpoints, progress
ranking, respawn anchors, authoritative state), `24-racing-ai.md` (pure pursuit, curvature speed
planning, aggression), `25-stunt-track-design.md` (crossovers, jumps, readability, cheap rendering),
`26-race-traffic.md` (spawn bubbles, junction cross traffic).

## Module map

| Module | Owns | DOM / THREE |
|---|---|---|
| `src/game/ground.ts` | `Ground` (height, normal, grip, surface at x,z on a layer), `STEP_UP`, `FLAT_GROUND`, `activeGround()`, `setGround()` | none |
| `src/game/ai-aggression.ts` | `fieldAggression` (rival roll under the slider), `mood` (fight or keep clear); shared with the derby AI | none |
| `src/game/race/catalog.ts` | surfaces (grip, top-speed share, colour), prefab specs | none |
| `src/game/race/track-schema.ts` | zod schema of the track JSON, `parseTrack`, `TrackJson` / `TrackFile` | none |
| `src/game/race/track.ts` | `Track`: arc-length samples, gates, grid, projection, wall clip, routes, crossing checks; `TrackGround` heightfield + bridge decks | THREE maths only |
| `src/game/race/tracks/*.json`, `tracks/index.ts` | the courses; `TRACKS` (menu order) and `CAMPAIGN` | none |
| `src/game/race/types.ts` | contracts: entrants, options, poses, records, events, snapshot, HUD read model, commands | none |
| `src/game/race/session.ts` | `RaceSession`: the rules | none |
| `src/game/race/campaign.ts` | `Campaign`: points, standings, grids, pegged rival aggression | none |
| `src/game/race/race-ai.ts` | `RaceBrain` (racing driver), `onSurface` | none |
| `src/game/race/traffic.ts` | `TrafficBrain` (loop lanes + side streets, observer bubble) | none |
| `src/game/race/placements.ts` | `placeProps`, `propColliders` | none |
| `src/game/race/prefabs.ts`, `track-art.ts` | prefab meshes; `TrackArt`: terrain, ribbons, decks + pillars, tunnels, markings, walls, start gantry, instanced props, knocked props, Cinematic tags | THREE |
| `src/game/race/menu-nav.ts` | spatial focus maths for controller menus | none |
| `src/game/engine-race.ts` | `RaceDirector`: engine glue (slots, walls / props, rules step, respawns, traffic bubble, AI stall reset, menus, campaign, HUD model) | THREE |
| `src/components/race-hud.tsx`, `use-pad-menu.ts` | readouts, standings, overlays, menus, focus-view toggle; pad / keyboard menu navigation | DOM |
| `src/game/race/race-world.test-util.ts` | the whole race stack headless (director + real cars + the engine's fixed-step order) | THREE maths |

Rules, campaign, AI, traffic and placements never touch the scene graph or the DOM. The director
takes its art from the host (`buildArt`), so tests and a server run it with no renderer.

## Race state machine

```
            Z / picker        start · campaign · retry · next
 sandbox ───────────► setup ─────────────────────────────► grid ─1.5 s─► countdown ─3 s─► racing
    ▲  quit (Back)      ▲ quit                                                              │
    └───────────────────┤                                    pause ◄─ Esc / Start ─────────┤
                        │                                                                   │ every car home,
                results ◄── 2.5 s after the race closes, or End ─────────────────────────────┘ out or past its
                  │ next (single) → next course          (campaign) next → standings → next round   deadline / End
```
`time` is the race clock: −4.5 on the grid, −3 when the lights start, 0 at green.
`startLights(time)`: red on [−3, −1), yellow on [−1, 0), green from 0 for 1.5 s, otherwise off. Cars
are held on the brakes until green. Traffic drives from the start.

## Per-car record (`CarRecord`)
`lap` (completed), `next` (next main gate), `armed` (crossed the line once), `route` / `routeNext`
(shortcut being driven), `progress` (m), `place`, `lapStart`, `lapTimes[]`, `bestLap`, `finishTime`,
`split`, `outTime`, `wrongWay`, `missed`, `respawnAt`, `deaths`, `status`
(`racing | respawning | finished | out | dnf`), the last reported `x`, `z`, the wrong-way timer and a
projection hint. All plain JSON.

## Checkpoints, laps, shortcuts
- Main chain: gates `0..N-1` in driving order; gate 0 is the start / finish line at node 0. A gate is
  a segment across road and runoff (+1.5 m), crossed forward only; the crossing time is interpolated
  inside the step. A move longer than 25 m in one step (a teleport) earns nothing.
- The grid sits behind gate 0. The first crossing arms the car; lap 1 is timed from green.
- Crossing gate `next` advances `next`; crossing gate 0 with `next == 0` completes a lap. Other gates
  are ignored, so cutting across the infield gains nothing and line farming never counts. Crossing a
  main gate ahead of the owed one (not the one just passed) sets `missed` until the owed gate is
  crossed; the HUD shows **Missed checkpoint**, so a skipped gate never costs a lap silently.
- Designed shortcut `{from, to, path}` (a gate per path point, reaching 8 m beyond its road edge,
  `SHORTCUT_REACH`): a car whose next gate is `from+1` starts it through any of its gates but the
  last; after that any later gate of it counts (a car on its own line across the shortcut's ground
  skips some); the exit gate sets `next = to`; a car that crossed all but the exit and then crosses
  main gate `to` also completes it. Crossing main gate `from+1` instead abandons it. A shortcut skips
  ≥ 1 checkpoint and may not skip the line. (The oval's service road runs through the open infield:
  before this rule a car on the grass beside it, or straight across, lost the whole lap.)
- Ranking distance `progress = lap·L + s'`, `s'` clamped between the last passed gate and `next`
  (along the route on a shortcut). `split`: seconds behind the first car through the same gate on
  the same lap.

## Positions
Finished cars by finish time; then racing / respawning / dnf by `progress`; then out cars, latest
out first. Ties fall to grid order.

## Wrong way
With speed > 1.5 m/s, `c = v̂ · tangent`; while `c < −0.3` a timer grows, otherwise it decays at twice
the rate; `wrongWay` on at 0.7 s, off at 0.

## Death, respawn, elimination
- Dead for the rules: drivetrain dead, upside down for 2.5 s, or (AI) still for 8 s.
- Player reset: R / D-pad ↓, 1.5 s. AI reset: an AI racer that gains < 25 m of track in 8 s (wedged
  on a wall, shoving a stopped car, two wrecks hooked together) takes the same reset.
- Default: `respawning` for 3 s, then back on the centreline (or the shortcut being driven) at the
  wreck's clamped progress, never past `next` (≥ 3 m short), facing the tangent, ≥ 6 m from every car
  (centre, ±½ half-width, then 6 m further back, up to 12 tries), on the layer it was racing on
  (deck or road below), fully repaired.
- No-reset: a death is final (`out`); resets are refused. The player gets the dead menu.

## Winning and the end
First car home wins (`winBy = laps`). Then the chequered flag: every other car finishes the next time
it crosses the line, classified by laps completed, then time (a lapped finisher shows "+1 lap", no time
gap). A car that hasn't reached the line by its deadline is `dnf` and keeps its laps: the deadline is
the winner + 30 s (`FINISH_GRACE`), or its current lap's start + 1.5 × its own best lap (`LAP_SLACK`;
the winner's average lap when it has none), whichever is later. So every running car gets to finish
the lap it is on at its own pace, and a stopped car can't hold the race open past that. The race
closes when no car is still running. No-reset: the last car running wins at once (`survival`).
`end()` closes the race now (running cars `dnf`). Results: place, name, status, time, gap (or laps
down, or laps done for DNF / out), best lap, laps.

## Spectate
Dead menu (no-reset, player out): Restart, End race, Spectate. Spectating chases a live car (LB/RB,
Q/E, click a standings name). Watching is allowed only once the player is out, finished or
spectating; a racing player can't be moved off their car, and `DriverSeat.drivable` lets a pedal take
the wheel only of this browser's player slot.

## Aggression (`ai-aggression.ts`)
The setup slider is the field's **maximum**. Each rival rolls `fieldAggression(max, seed, id)`,
uniform in [0, max]; a new race rolls again (the director bumps its seed per field). In a campaign the
rolls are made once and stored on `CampaignRow.aggression`, re-applied every round.
`mood(a, self, other) = a ≤ 0 ? −1 : 2a − 1 + 0.8(other − self) − (1 − a)·self` (damage 0 mint … 1 dead):
0 never attacks and gives way; 1 attacks whatever its own state; 0.5 attacks only a car more wrecked
than itself, less willingly the more wrecked it is. The race AI rams a slower rival ahead when
mood > 0, closes the door on one coming through at > 0.15, leans on one alongside at > 0.3, and
yields / shies away below −0.4. The derby AI uses the same two functions with its own thresholds.

## Campaign
`CAMPAIGN = ["oval", "rally", "city", "stunt"]`. Points 10, 8, 6, 5, 4, 3, 2, 1 for places 1–8.
Standings: points, wins, the better place in the latest round, entry order. Round 1's grid is the
entry order (player last); later grids are the standings, leader on pole. Results → Standings
(records the round) → Next round. Retry re-runs a round without scoring it.

## Controller slots and multiplayer
Slots `player | ai | remote`. `RaceDirector.drive` picks each car's `DriveInput`: player → this
browser's `DriverSeat`, ai → `RaceBrain.think`, remote → `setRemoteInput(carId, input)` (held between
packets); traffic → `TrafficBrain`. The rules see only `CarPose`s. `RaceSession.snapshot()` /
`restore()` round-trip the full state as JSON (`RaceDirector.snapshot()` / `applySnapshot()` for a host
and clients); `Campaign` likewise. The HUD reads `RaceHud` and sends `RaceCommand`s.

## AI (`RaceBrain`)
Deterministic, allocation-free, memory per car id; figures per car class (`setClass`: turn, top
speed, brake, boost top from `classStats`).
- Line: inside of the next turn plus a personal offset; lanes change at 3.2 m/s; mood-driven
  contact choices (above).
- Pursuit: a point `Ld = clamp(5 + 0.5 v, 7, 18)` m ahead; `ω = 2 v sin α / Ld`; steer = ω / (class
  full-lock yaw × `0.35 + 0.65·min(1, v/8)` × steer grip) — the same yaw model as `applyDrive`.
- Speed: over braking reach + 12 m, `√(v_corner² + 2·a·d)`, `v_corner = 0.8 · turn · steerGrip / |κ|`
  capped at the surface's top speed, `a` = half the class brake. Throttle asks for that speed itself
  (`applyDrive` runs up to throttle × top at the class's full rate), so a rival reaches the same top
  speed as a player flat out.
- Boost: the player's meter rules per car (`BOOST.full` drain, `BOOST.recharge` refill). A burst starts
  on a half-full meter, on a clear run (no car to follow), above 0.7 × top, pointed down the line, and
  only while the plan at the boosted top still clears every turn in its braking reach.
- Traffic ahead on our line: pass on the side with room, else follow its speed.
- Shortcuts: a seeded coin per car, lap and shortcut (0.3 + 0.4·aggression); heads for the mouth.
- Unstick: throttle without motion → reverse with the nose swinging toward the line.

## Traffic (`TrafficBrain`)
Cars fill the race loop's lanes (`traffic.count`), then each side street (`routes[].count`), lanes
round-robin. Each cruises its lane at `traffic.speed`, slows for curvature, stops 7 m short of
anything in its lane (√(8·gap) profile) and after 2.5 s stopped edges round for 4.5 s. Side streets
cross the race loop at grade, so racers meet cross traffic that does not stop for them (T-bones).
Observer bubble (every racer still on track is an observer; checked every 0.25 s): a traffic car
farther than 120 m from all of them, dead for 6 s, or off the end of an open street is put away
(hidden, parked off the world, no AI, no contacts); a put-away car wakes on its lane 55–100 m from
the nearest observer, 14 m clear of every car, and never inside the local camera's view.

## Ground, surfaces, decks
```ts
interface Ground {
  heightAt(x, z, y?): number;            // y: the body's height picks the layer (highest ≤ y + 1.2); omitted = top
  normalAt(x, z, out, y?): out;
  frictionAt(x, z, y?): number;          // grip multiplier (1 = asphalt)
  surfaceAt(x, z, y?): SurfaceId;
}
```
`FLAT_GROUND`: y 0, +Y, 1, asphalt — the sandbox is bit-identical. A race calls `setGround(track.ground())`.
`TrackGround` bakes a 1 m heightfield over the bounds: banked road plane, flat shoulders over the
runoff, smoothstep back to the base terrain (gaussian `hills`) over 24 m; every path (main, shortcuts,
streets) is stamped; deck spans are skipped (their ends are rounded abutments) and answered
analytically from the path at its own height, so a bridge and the road under it coexist.
Who reads it: driven cars (`car.ts` integrate: ride the ground; where it falls away faster than
gravity follows — a ramp lip, a crest at speed — fly, and land on whatever layer is below), per-axle
grip in `applyDrive`, crashed cars' masses (hub / body floor and ceiling, grip), `followGroup`'s
height clamp, `dragGround`, `bleedAfterSlide`. Car pairs more than 2.5 m apart in height never touch.

| Surface | grip | top speed |
|---|---|---|
| asphalt, concrete | 1 | 1 |
| cobble | 0.85 | 0.92 |
| dirt | 0.72 | 0.84 |
| gravel | 0.62 | 0.72 |
| grass | 0.5 | 0.6 |
| sand | 0.45 | 0.5 |

Grip is applied per axle in `applyDrive`; the race glue (`onSurface`) only scales forward throttle by
the surface's top-speed share.

## Contacts
Walls: six footprint probes against the wall line on each side with a wall flag; push out along the
inward normal, reflect normal speed (e = 0.15), crumple above 5.5 m/s closing, sparks above 1.5 m/s.
Props: solid colliders push out the same way; knock props fly off (`TrackArt.knock`) and take speed in
proportion to their mass. Car-to-car contact is the sandbox's own.

## Courses
| Id | Name | Length | Character | Shortcuts |
|---|---|---|---|---|
| `oval` | Brickyard Oval | 685 m | flat, 18 m wide, four lefts, grandstands | infield dirt service road (4 → line) |
| `rally` | Ridge Rally | ≈ 860 m | climbs to 6.5 m, banked hairpin (6–8°), gravel / dirt, rocks, woods | ridge grass track (1 → 3); creek ford, sand (4 → 7) |
| `city` | Harbour Streets | ≈ 690 m | street grid: four open junctions crossed by two two-way side streets (8 cars) plus 4 loop-lane cars, 90° corners, cobbled old town, concrete harbour front | back alley through a block (4 → 6) |
| `stunt` | Crossover Canyon | ≈ 1140 m | figure of eight over its own 9 m deck, banked wall-ride bowl (8–18°), kicker jump down the canyon side, tunnel through a ridge, sand terrain | quarry cut across the bowl, gravel (2 → 4) |

## Track JSON
One file per course in `src/game/race/tracks/`, registered in `tracks/index.ts`. `parseTrack` (zod)
fills defaults and reports every problem as `path: message`; `new Track(json)` also rejects a turn
tighter than its own inner corridor, a self-crossing with neither level a deck, less than 4.5 m
between levels, and a checkpoint over the other level.

| Field | Type / default | Meaning |
|---|---|---|
| `id`, `name`, `blurb` | string | `id` is `[a-z0-9-]+` |
| `laps` | int 1–9 = 3 | default lap count |
| `road` | `{ width = 14, surface = "asphalt", runoff = [4, 4], runoffSurface = "grass", wall = [true, true], wallHeight = 1.1 }` | node 0's defaults |
| `nodes[]` | `{ x, z, y?, width?, bank = 0, surface?, runoff?, runoffSurface?, wall?, deck?, tunnel? }`, ≥ 4 | closed centripetal Catmull-Rom in driving order. Omitted fields inherit the previous node (bring `y` back down explicitly); `bank` (degrees, > 0 raises the right edge) does not. Flags hold from a node to the next: `wall` [left, right], `deck` (bridge span), `tunnel` (roofed, art only) |
| `checkpoints[]` | `{ node, t = 0 }`, ≥ 3 | main gates in order; checkpoint 0 = node 0, t 0 |
| `shortcuts[]` | `{ id, from, to, width = 7, surface = "dirt", path: [{x, z, y?}] }` | designed route; open the main walls at its mouths and give its ends the main road's height there |
| `grid` | `{ perRow = 2, spacing = 8, back = 6 }` | staggered slots behind the line |
| `props[]` | `{ prefab, x, z, yaw = 0, scale = 1, size? }` | placed prefabs |
| `along[]` | `{ prefab, every, side = "both", offset = 1.5, fromNode?, toNode?, route?, scale = 1 }` | repeated beside the wall line (or along side street `route`); copies on any road are skipped |
| `scatter[]` | `{ prefab, count, near = 6, far = 60, seed = 1, scaleMin = 0.8, scaleMax = 1.25 }` | seeded scenery off every corridor |
| `traffic` | `{ count = 0, speed = 9, lanes = [], routes = [] }`? | `lanes: [{ offset, dir: 1 \| -1 }]` on the race loop; `routes: [{ id, path, loop = false, width = 9, surface = "asphalt", count, lanes }]` side streets (open the race walls where they cross) |
| `environment` | `{ sky = "#12141a", fog = 0.0035, terrain = "grass", hills: [{x, z, radius, height}] }` | look and base terrain |

Prefabs: knock `cone, tyre-stack, hay-bale, crate`; solid `barrier-block, rock, tree, building,
grandstand, billboard, lamp`; scenery `gantry`. A prefab's front is its local +X; `along` copies face
the road. The start gantry is built by `TrackArt` at s = 0.

## Engine integration
Race hunks in `CrashEngine`: `toggleRace` / `setRace` (exclusive with the other scenes; hides the
studio floor, grid, rings and lamp poles; restores the sandbox car count on exit), `raceCommand`,
`RaceDirector.drive` at the start of `fixedStep`, `collide` per car per slice, `step` after the
slices, `frame` before the camera, the chase camera while a race runs, `race` in the HUD state, the
2.5 m height gate on car pairs. While a race menu is open the engine still polls the pad but ignores
pad buttons and keys (the HUD owns them). Racing keys: Esc / Start / Back pause, R / D-pad ↓ respawn,
Q/E LB/RB spectate, V view, H focus ↔ full view (the sandbox's night toggle on H waits until you
leave the race). In the focus view every sandbox hotkey (scenes, Z, play, rig, wet, night…) is
swallowed; in the full view they work as in the sandbox, except the fleet props B / K (the HUD locks them too).

## HUD and controller menus
Focus view (default): race readouts (P3/8, Lap 2/3, race / lap / last / best, speed, split, the boost
meter while driving), standings
(names are spectate buttons), start lights with 3·2·1·GO, WRONG WAY, respawn countdown, finish card,
spectate bar, and one "Full menu" button (H). Full view adds the sandbox title, settings panel, drive
card and dock (first item "Race view"). Modal menus: setup (course cards, laps 3–5, AI cars 1–15,
max aggression with its hint, respawn / no reset, Start race, Campaign, Back), pause (Resume,
Restart, End race, Full menu / Race view, Quit to menu), dead, results (Next course / Standings,
Retry, Menu), campaign standings (Next round / champion, Menu). D-pad / left stick move focus
spatially (350 ms then 120 ms repeat), ←/→ adjust, A confirms, B backs out, Start resumes. Campaign results
and standings have no Back (B / Esc would drop the unrecorded round): Menu leaves, and clears the campaign.

## Tests
`track.test.ts` (every course compiles, gates, grid, walls, ground, bridge layers, crossing rules),
`session.test.ts` (countdown, laps, cuts and the `missed` flag, line farming, shortcuts incl. the
oval infield beside / across the service road, wrong way, positions, respawn placement, no-reset
survival, snapshots, DNF, the chequered flag and finish deadlines, campaign), `race-ai.test.ts` (8
clean AI cars finish 3 laps on every course on the road ≥ 95 %, ram / block / follow, boost, the
aggression model), `traffic.test.ts` (lanes, junction crossings, stop and edge round, bubble
wake-up), `placements.test.ts`, `menu-nav.test.ts`, and the real stack headless (director, real cars
and classes, `applyDrive`, the engine's fixed-step contact order, traffic; helpers in
`race-world.test-util.ts`):
- `race-finish.test.ts`, every course: 5 AI cars, 2 laps;
  results within the grid + 2 laps at 3 × the reference lap (course length at 9 m/s) with ≥ 4 of 5
  home on full distance or out. `RACE_FINISH_RUNS=5` runs the full sweep: back-to-back races on one
  world (the race AI has no seed, so runs differ only by what the previous race leaves behind).
- `race-player.test.ts`: the PLAYER slot driven through the real seat (analog wheel and gas) on the
  oval, 3 laps, 3 AI — on the high line, the apron, with a respawn press, on the grass beside the
  service road and straight across the infield. The player finishes on the AI's lap count, and the
  HUD's lap and place equal a rules snapshot at every sample.
