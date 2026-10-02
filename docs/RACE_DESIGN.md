# Race mode (as built)

Circuit racing on top of the crash sandbox: 2–16 racers (plus NPC traffic on the city course),
3–5 laps, hidden checkpoint gates, designed shortcuts, respawn or no-reset elimination, AI racers
with an aggression dial, an arcade HUD, controller-driven menus, and a campaign over every course.
Scene picker **Race** or key **X**.

Research leads: `.extraResearch/perplexity/23-race-checkpoints-laps.md` (gates, key checkpoints,
progress ranking, respawn anchors, authoritative state) and `24-racing-ai.md` (pure pursuit,
curvature speed planning, aggression).

## Module map

| Module | Owns | DOM / THREE |
|---|---|---|
| `src/game/ground.ts` | `Ground` (height, normal, grip, surface at x,z), `FLAT_GROUND`, `activeGround()`, `setGround()` | none |
| `src/game/race/catalog.ts` | surfaces (grip, top-speed share, colour), prefab specs (body, collider, size, mass) | none |
| `src/game/race/track-schema.ts` | zod schema of the track JSON, `parseTrack`, `TrackJson` / `TrackFile` | none |
| `src/game/race/track.ts` | `Track`: arc-length samples, gates, start grid, projection, wall clip, `nodeS`; `TrackGround` heightfield | THREE maths only |
| `src/game/race/tracks/*.json`, `tracks/index.ts` | the courses; `TRACKS` (menu order) and `CAMPAIGN` | none |
| `src/game/race/types.ts` | contracts: entrants, options, poses, records, events, snapshot, HUD read model, commands | none |
| `src/game/race/session.ts` | `RaceSession`: the rules | none |
| `src/game/race/campaign.ts` | `Campaign`: points, standings, grids | none |
| `src/game/race/race-ai.ts` | `RaceBrain` (racing driver), `onSurface` (surface → drive input) | none |
| `src/game/race/traffic.ts` | `TrafficBrain` (NPC lane traffic) | none |
| `src/game/race/placements.ts` | `placeProps` (props + `along` + seeded `scatter`), `propColliders` | none |
| `src/game/race/prefabs.ts`, `track-art.ts` | prefab meshes; `TrackArt`: terrain, road / runoff ribbons, markings, kerbs, walls, start gantry lights, instanced props, knocked-prop tumbling | THREE |
| `src/game/race/menu-nav.ts` | spatial focus maths for controller menus | none |
| `src/game/engine-race.ts` | `RaceDirector`: engine glue (slots, contacts with walls / props, rules step, respawns, traffic, menus, campaign, HUD model) | THREE |
| `src/components/race-hud.tsx`, `use-pad-menu.ts` | race readouts, standings, overlays, menus; pad / keyboard menu navigation | DOM |

Rules, campaign, AI, traffic and placements never touch the scene graph or the DOM: a server or a
peer can run them headless. Everything under `race/` except `track-art.ts` / `prefabs.ts` runs in
node tests.

## Race state machine

```
            X / picker        start · campaign · retry · next
 sandbox ───────────► setup ─────────────────────────────► grid ─1.5 s─► countdown ─3 s─► racing
    ▲  quit (Back)      ▲ quit                                                              │
    └───────────────────┤                                    pause ◄─ Esc / Start ─────────┤
                        │                                                                   │ last car in /
                results ◄── 2.5 s after the race closes, or End ─────────────────────────────┘ 30 s after the
                  │ next (single) → next course          (campaign) next → standings → next round   winner / End
```
`time` is the race clock: −4.5 on the grid, −3 when the lights start, 0 at green.
`startLights(time)`: red on [−3, −1), yellow on [−1, 0), green from 0 for 1.5 s, otherwise off. Cars
are held on the brakes until green. Traffic drives from the start.

## Per-car record (`CarRecord`)
`lap` (completed), `next` (next main gate), `armed` (crossed the line once), `route` / `routeNext`
(shortcut being driven), `progress` (m), `place`, `lapStart`, `lapTimes[]`, `bestLap`,
`finishTime`, `split`, `outTime`, `wrongWay`, `respawnAt`, `deaths`, `status`
(`racing | respawning | finished | out | dnf`), plus the last reported `x`, `z`, the wrong-way timer
and a projection hint. All plain JSON.

## Checkpoints, laps, shortcuts
- Main chain: gates `0..N-1` in driving order; gate 0 is the start / finish line at node 0. A gate
  is a segment across the road and runoff (+1.5 m), crossed forward only (move · tangent > 0); the
  crossing time is interpolated inside the step. A move longer than 25 m in one step (a teleport)
  earns nothing.
- The grid sits behind gate 0. The first crossing only arms the car; lap 1 is timed from green.
- Crossing gate `next` advances `next`; crossing gate 0 with `next == 0` completes a lap. Other
  gates are ignored, so cutting across the infield gains nothing and driving back and forth over the
  line never counts.
- Designed shortcut `{from, to, path}` (one gate per path point): a car whose next gate is `from+1`
  starts the route by crossing the mouth gate, or the gate after it (cut in past the mouth). Its
  gates must then be crossed in order; the exit gate sets `next = to`. A car that crossed every gate
  but the exit and then crosses main gate `to` also completes it. Crossing main gate `from+1`
  instead abandons the route. A shortcut must skip ≥ 1 checkpoint and may not skip the line.
- Ranking distance: `progress = lap·L + s'`, `s'` = projected arc length clamped between the last
  passed gate and `next` (between `from` and `to` along the route on a shortcut). Before arming,
  `s' ∈ [−L/2, 0]`.
- `split`: seconds behind the first car through the same gate on the same lap.

## Positions
Finished cars by finish time; then racing / respawning / dnf by `progress`; then out cars, the
latest out first. Ties fall to grid order, so the order is total and deterministic.

## Wrong way
At the car's projection, with speed > 1.5 m/s, `c = v̂ · tangent`. While `c < −0.3` a timer grows;
otherwise it decays at twice the rate. `wrongWay` turns on at 0.7 s, off at 0.

## Death, respawn, elimination
- The director reports a car dead when its drivetrain is dead, it has been upside down for 2.5 s,
  or (AI only) it has sat still for 8 s while racing. The player may ask for a respawn (R / D-pad
  down): 1.5 s.
- Default: `respawning`, `respawnAt = time + 3`. When it fires the session emits
  `respawn {x, z, yaw}` on the main centreline (or the shortcut being driven) at the wreck's clamped
  progress, never past `next` (≥ 3 m short of it), facing the tangent, ≥ 6 m from every other car
  (centre, then ±½ half-width, then 6 m further back, up to 12 tries). The director rebuilds the car
  there (full repair).
- No-reset: a death is final (`out`); respawn requests are refused. The player gets the dead menu.

## Winning and the end
- First car home on its last lap wins (`winBy = laps`); the rest race on until all are in or out, or
  30 s after the winner; anyone still running is `dnf`.
- No-reset: when one car is left running and nobody has finished, it wins at once
  (`winBy = survival`). Off with one entrant.
- `end()` (End race) closes the race now; running cars are `dnf`.
- Results: place, name, status, finish time, gap to the winner, best lap, laps.

## Spectate
The dead menu (no-reset, player out) offers Restart, End race, Spectate. Spectating chases a live
car (LB/RB, Q/E, or click a standings name). Watching is allowed only once the player is out,
finished or spectating, so a racing player can never be moved off their car, and
`DriverSeat.drivable` lets a pedal take the wheel only of this browser's player slot.

## Campaign
`CAMPAIGN = ["oval", "rally", "city"]`. Points 10, 8, 6, 5, 4, 3, 2, 1 for places 1–8 (finished,
out and DNF alike: the classification is the result). Standings: points, then wins, then the better
place in the latest round, then entry order. Round 1's grid is the entry order (AI, player last);
every later grid is the standings, leader on pole. Results → **Standings** (records the round) →
**Next round**. Retry re-runs a round without scoring it.

## Controller slots and multiplayer
Each racer has a slot `player | ai | remote`. Per physics step `RaceDirector.drive` picks its
`DriveInput`: `player` → this browser's `DriverSeat`, `ai` → `RaceBrain.think`, `remote` →
`setRemoteInput(carId, input)` (held until the next packet). Traffic uses `TrafficBrain`. The rules
only see `CarPose`s. `RaceSession.snapshot()` / `restore()` round-trip the full state as plain JSON
(tested), exposed as `RaceDirector.snapshot()` / `applySnapshot()` for a host and its clients. The
HUD reads `RaceHud` and sends `RaceCommand`s through `CrashEngine.raceCommand`. Tracks are pure
JSON, so peers load the same course by id.

## AI (`RaceBrain`)
One brain per course, memory per car id, deterministic and allocation-free:
- **Line:** inside of the next turn (mean curvature 10–34 m ahead) plus a personal offset; lanes
  change at 3.2 m/s.
- **Pursuit:** a point `Ld = clamp(5 + 0.5 v, 7, 18)` m ahead; `ω = 2 v sin α / Ld`, steer =
  ω / (full-lock yaw rate × steer grip).
- **Speed:** for every point within braking reach (plus 12 m), `√(v_corner² + 2·a·d)` with
  `v_corner = 0.8 · turn · steerGrip / |κ|` capped at the surface's top speed, `a` = half
  `DRIVE.brake`.
- **Traffic ahead on our line:** pass on the side with room, else follow its speed.
- **Aggression (0–1):** above 0.55 rams a slower rival instead of passing; above 0.35 closes the
  door on a rival coming through; above 0.6 leans on a rival alongside. Clean racers (0) do none.
- **Shortcuts:** a seeded coin per car, lap and shortcut (0.3 + 0.4·aggression); heads for the mouth
  gate first, drives to the exit gate.
- **Unstick:** throttle without motion for the personality's patience → reverse with the nose
  swinging toward the line.
Field aggression comes from the setup slider ±0.15 per car.

## Traffic (`TrafficBrain`)
Cars cruise the course's `traffic.lanes` (lateral offset, + = left of the race direction; `dir` −1
drives against the race) at `traffic.speed`, slowing for curvature, braking to stop 7 m short of
anything in their lane (a √(8·gap) profile), and after 2.5 s stopped they edge round toward the
centreline for 4.5 s. They start spread round the loop clear of the grid; a dead traffic car is
respawned after 6 s at least 60 m from every car. They are real `DeformableCar`s: they crash and crumple.

## Surfaces and ground
```ts
interface Ground {
  heightAt(x, z): number;
  normalAt(x, z, out): out;      // unit up-normal
  frictionAt(x, z): number;      // grip multiplier (1 = asphalt)
  surfaceAt(x, z): SurfaceId;    // asphalt concrete cobble dirt gravel grass sand
}
```
`FLAT_GROUND` returns y = 0, +Y, 1, asphalt: identical to the sandbox. A race calls
`setGround(track.ground())` and restores it on exit. `TrackGround` bakes a 1 m heightfield over the
track bounds: the banked road plane, flat shoulders over the runoff, a smoothstep back to the base
terrain (gaussian `hills`) over 24 m; surfaces from the nearest corridor or the terrain.

| Surface | grip | top speed |
|---|---|---|
| asphalt, concrete | 1 | 1 |
| cobble | 0.85 | 0.92 |
| dirt | 0.72 | 0.84 |
| gravel | 0.62 | 0.72 |
| grass | 0.5 | 0.6 |
| sand | 0.45 | 0.5 |

Applied in the race glue (`onSurface`): steer × (0.45 + 0.55·grip), forward throttle × top-speed
share. Driven (uncrashed) cars hug the ground's height and tilt to its normal (`car.ts` integrate,
only when a course ground is active). **Not yet wired:** crashed cars (masses in
`streamed-deform.ts`, `followGroup`'s height clamp, `bleedAfterSlide`'s μ) still assume y = 0 and
μ = 1; that wiring lands after lane/crash-realism-5 merges (agreed with that lane). Until then a
wreck on the rally's hills settles at y ≈ 0.

## Contacts
Walls: six footprint probes (corners and side midpoints) against the wall line on each side where
the wall flag is set; the car is pushed out along the inward normal, its normal velocity reflected
(e = 0.15); above 5.5 m/s closing the car crumples at the contact (`applyImpact`, or a mass kick on a
wreck); sparks above 1.5 m/s. Props: solid colliders (circle / yawed box) push out the same way;
knock props (cones, tyre stacks, bales, crates) fly off (`TrackArt.knock`) and take speed in
proportion to their mass. Car-to-car contact is the sandbox's own.

## Courses
| Id | Name | Length | Character | Shortcuts |
|---|---|---|---|---|
| `oval` | Brickyard Oval | 685 m | flat, 18 m wide, four lefts, concrete runoff, grandstands | infield dirt service road (checkpoint 4 → line, skips 3) |
| `rally` | Ridge Rally | ≈ 1 km | climbs to 6.5 m, banked hairpin (6–8°), gravel / dirt sections, hay bales, rocks, woods | ridge grass track over the crest (1 → 3); creek ford through sand (4 → 7) |
| `city` | Harbour Streets | ≈ 700 m | four blocks, 90° corners, cobbled old town, concrete harbour bridge, buildings, 8 two-way traffic cars | old-town alley through the block (3 → 6) |

## Track JSON
One file per course in `src/game/race/tracks/`, registered in `tracks/index.ts`. `parseTrack` (zod)
fills the defaults below and reports every problem as `path: message`; `new Track(json)` also
rejects a turn tighter than its own inner corridor.

| Field | Type / default | Meaning |
|---|---|---|
| `id`, `name`, `blurb` | string | `id` is `[a-z0-9-]+` |
| `laps` | int 1–9 = 3 | default lap count |
| `road` | `{ width = 14, surface = "asphalt", runoff = [4, 4], runoffSurface = "grass", wall = [true, true], wallHeight = 1.1 }` | node 0's defaults |
| `nodes[]` | `{ x, z, y?, width?, bank = 0, surface?, runoff?, runoffSurface?, wall? }`, ≥ 4 | closed centripetal Catmull-Rom in driving order. Omitted fields inherit the previous node; `bank` (degrees, > 0 raises the right edge) does not. Flags (`wall`, surfaces) hold from a node to the next |
| `checkpoints[]` | `{ node, t = 0 }`, ≥ 3 | main gates in driving order; checkpoint 0 must be node 0, t 0 |
| `shortcuts[]` | `{ id, from, to, width = 7, surface = "dirt", path: [{x, z, y?}] }` | designed route from checkpoint `from` to `to`; open the main walls at its mouths (`wall: [false, …]` on the side it leaves from) and give its end points the main road's height there |
| `grid` | `{ perRow = 2, spacing = 8, back = 6 }` | staggered slots behind the line |
| `props[]` | `{ prefab, x, z, yaw = 0, scale = 1, size? }` | placed prefabs |
| `along[]` | `{ prefab, every, side = "both", offset = 1.5, fromNode?, toNode?, scale = 1 }` | repeated at ±(half + runoff + offset); copies on a shortcut road are skipped |
| `scatter[]` | `{ prefab, count, near = 6, far = 60, seed = 1, scaleMin = 0.8, scaleMax = 1.25 }` | seeded scenery in the band [near, far] beyond the wall line, ≥ 3 m off every corridor and ≥ 25 m from the line |
| `traffic` | `{ count, speed = 9, lanes: [{ offset, dir: 1 \| -1 }] }`? | NPC cars |
| `environment` | `{ sky = "#12141a", fog = 0.0035, terrain = "grass", hills: [{x, z, radius, height}] }` | sky / fog colour, base terrain |

Prefabs: knock `cone, tyre-stack, hay-bale, crate`; solid `barrier-block, rock, tree, building,
grandstand, billboard, lamp`; scenery `gantry`. A prefab's front is its local +X; `along` copies face
the road. The start gantry with its lights is built by `TrackArt` at s = 0.

## Engine integration
`CrashEngine` keeps race hunks small: `toggleRace` / `setRace` (exclusive with the other scenes;
hides the studio floor, grid, rings and lamp poles; restores the sandbox car count on exit),
`raceCommand`, `RaceDirector.drive` at the start of `fixedStep` (replacing the seat / derby input),
`collide` per car per slice, `step` after the slices, `frame` before the camera, the chase camera
while a race runs, `race` in the HUD state. While a race menu is open the engine still polls the pad
(fresh edges) but ignores pad buttons and keys: the HUD owns them. Racing keys: Esc / Start / Back
pause, R / D-pad ↓ respawn, Q/E LB/RB spectate, V/Y view, X leaves; other sandbox keys are swallowed.
The sun's shadow box follows the camera's car; the course sets sky, fog and a 900 m far plane.

## HUD and controller menus
Readouts (P3/8, Lap 2/3, race / lap / last / best time, speed, split), standings (names are buttons
for spectating), start-light card with 3·2·1·GO, WRONG WAY banner, respawn countdown, finish card
with gaps to the cars ahead and behind, spectate bar, and modal menus: setup (course, laps 3–5, AI
cars 1–15, aggression, respawn / no reset, Start race, Campaign, Back), pause, dead, results (Next
course / Standings, Retry, Menu), campaign standings (Next round / champion, Menu). D-pad / left
stick move focus spatially (350 ms then 120 ms repeat), ←/→ adjust a focused option, A confirms,
B backs out, Start resumes.

## Tests
`track.test.ts` (every course compiles, gates forward, grid on the road, walls, ground),
`session.test.ts` (countdown, laps, cuts, line farming, shortcuts and their tolerances, wrong way,
positions, respawn placement, no-reset survival, snapshots, DNF, campaign), `race-ai.test.ts`
(8 clean AI cars finish 3 laps on every course on the road ≥ 95 %, ram / block / follow),
`traffic.test.ts`, `placements.test.ts`, `menu-nav.test.ts`.
