# Race mode

Circuit racing on top of the crash sandbox: 2–16 racers plus NPC traffic, 1–5 laps from the menu, hidden checkpoint gates,
designed shortcuts, respawn or no-reset elimination, AI racers with an aggression dial, an optional police chase, an arcade
HUD with a focus view, controller-driven menus, and a campaign over every course. Scene picker **Race** or key **Z**.

## Module map

| Module | Owns |
|---|---|
| `world/ground.ts` | `Ground` (height, normal, grip, surface at x,z on a layer), `FLAT_GROUND`, `activeGround()`, `setGround()` |
| `world/catalog.ts` | surfaces (grip, top-speed share, colour), prefab specs |
| `world/track-schema.ts` | zod schema of the track JSON, `parseTrack`, `TrackFile` |
| `world/track.ts` | `Track`: arc-length samples, gates, grid, projection, wall clip, routes, crossing checks; `TrackGround` heightfield + bridge decks |
| `world/tracks/*.json`, `tracks/index.ts` | the courses; `TRACKS` (menu order), `CAMPAIGN`, `OFF_MENU` |
| `world/placements.ts` | `placeProps`, `propColliders` |
| `match/types.ts` | contracts: entrants, options, poses, records, events, snapshot, HUD read model, commands |
| `match/session.ts` | `RaceSession`: the rules |
| `match/campaign.ts` | `Campaign`: points, standings, grids, pegged rival aggression |
| `ai/ai-aggression.ts` | `fieldAggression`, `mood`; shared with the derby AI |
| `ai/race-ai.ts`, `ai/contact-guard.ts` | `RaceBrain` (racing driver), `guardContact` |
| `ai/traffic.ts` | `TrafficBrain` (loop lanes + side streets, observer bubble) |
| `ai/police.ts`, `ai/pack-guard.ts` | `PoliceBrain` (stakeouts, pursuits, packs, attacks), `guardMates` |
| `present/prefabs.ts`, `present/track-art.ts` | prefab meshes; `TrackArt`: terrain, ribbons, decks + pillars, tunnels, markings, walls, start gantry, instanced and knocked props |
| `hud/menu-nav.ts` | spatial focus maths for controller menus |
| `engine/engine-race.ts`, `engine/engine-race-field.ts` | `RaceDirector` (rules glue, menus, campaign, netplay, HUD model) over `RaceField` (course, grid, spawns, respawns, traffic bubble, wall / prop contacts) |
| `components/race-*.tsx`, `use-pad-menu.ts` | readouts, standings, overlays, menus; pad / keyboard menu navigation |
| `world/race-world.test-util.ts` | the whole race stack headless (director + real cars + the engine's fixed-step order) |

Rules, campaign, AI, traffic and placements never touch the scene graph or the DOM. The director takes its art from the
host (`buildArt`), so tests and a server run it with no renderer.

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
`time` is the race clock: −4.5 on the grid, −3 when the lights start, 0 at green. `startLights(time)`: red on [−3, −1),
yellow on [−1, 0), green from 0 for 1.5 s, otherwise off. Cars are held on the brakes until green. Traffic drives from the
start.

## Per-car record (`CarRecord`)

`lap` (completed), `next` (next main gate), `armed` (crossed the line once), `route` / `routeNext` (shortcut being driven),
`progress` (m), `place`, `lapStart`, `lapTimes[]`, `bestLap`, `finishTime`, `split`, `outTime`, `wrongWay`, `missed`,
`respawnAt`, `deaths`, `status` (`racing | respawning | finished | out | dnf`), the last reported `x`, `z`, the wrong-way
timer, a projection hint, and `draft` / `drafts`. All plain JSON.

## Checkpoints, laps, shortcuts

- Main chain: gates `0..N-1` in driving order; gate 0 is the start / finish line at node 0. A gate is a segment across road
  and runoff, crossed forward only; the crossing time is interpolated inside the step. A move longer than 25 m in one step
  (a teleport) earns nothing.
- The grid sits behind gate 0. The first crossing arms the car; lap 1 is timed from green.
- Crossing gate `next` advances `next`; crossing gate 0 with `next == 0` completes a lap. Other gates are ignored, so
  cutting across the infield gains nothing and line farming never counts. Crossing a main gate ahead of the owed one sets
  `missed` until the owed gate is crossed; the HUD shows **Missed checkpoint**, so a skipped gate never costs a lap silently.
- Designed shortcut `{from, to, path}` (a gate per path point): a car whose next gate is `from+1` starts it through any of
  its gates but the last; after that any later gate of it counts; the exit gate sets `next = to`; a car that crossed all but
  the exit and then crosses main gate `to` also completes it. Crossing main gate `from+1` instead abandons it. A shortcut
  skips ≥ 1 checkpoint and may not skip the line.
- Gate reach: road + runoff, then 1.5 m (`WALL_REACH`) where a wall stands, 12 m (`OPEN_REACH`) on a side with no wall
  within 12 m, so a car swung 10 m off an open road still crosses it. A shortcut's gate enters it only **off the main road**
  (`Track.onRoad`), a main gate leaves a shortcut only **on** the main road, and where several shortcuts leave one
  checkpoint the car is on the nearest.
- Ranking distance `progress = lap·L + s'`, `s'` clamped between the last passed gate and `next` the same lap.

## Positions

Finished cars by finish time; then racing / respawning / dnf by `progress`; then out cars, latest out first. Ties fall to
grid order.

## Wrong way

With speed > 1.5 m/s on the road (inside its width, runoff and wall: `inCorridor`), `c = v̂ · tangent`; while `c < −1/√2`
(135°) a timer grows, otherwise it decays at twice the rate; `wrongWay` on at 0.7 s, off at 0. Off the road it means
nothing (a shortcut's mouth, weaving, a spin in the field). `checkpoint-sweep.test.ts` drives a scripted car round every
line of every course (main loop and each shortcut, 2 laps, offsets, weaves, knocks, kicks, up to 10 m past an open edge)
and demands no `missed`, no `wrongWay` and the laps done.

## Death, respawn, elimination

- Dead for the rules: drivetrain dead, upside down for 2.5 s, or still for 8 s while the race AI drives it (not while a
  human has it, who can press R).
- Player reset: R / D-pad ↓ / the thumb pad's button. A **tap** (released inside 0.8 s, `RESET_HOLD`) takes 1.5 s and puts
  a repaired car back. A **hold** (0.8 s, a fill shows under the banners; `ResetHold`) puts the car back **at once with its
  damage kept** (the host captures its net state and writes it over the fresh placement, `placeKeeping`), at rest and
  upright. A hold works in a no-reset race too, and is refused in Survival, while spectating, in a menu, and for a car that
  is respawning, out or finished. A netplay client's hold rides the input packet's flags byte to the host. AI reset: a car
  the race AI drives that gains < 25 m of track in 8 s takes the same tap reset.
- Where a reset puts the car (`RaceSession.spot`): on the centreline of the path it is on, at its own spot if that is on the
  road between the last checkpoint it hit and the first it still owes, else at the last such spot (`CarRecord.safe`), else
  at the checkpoint it last hit. Never past the owed checkpoint (3 m short, `GATE_MARGIN`), never behind the last hit,
  clear of every car (≥ 6 m, up to 12 tries), on the layer it was racing on. The missed banner says "Missed checkpoint:
  hold R to go back".
- Default: `respawning` for 3 s, then back on the road, fully repaired.
- No-reset: a death is final (`out`); resets are refused. The player gets the dead menu.
- **Driver thrown out** (`DeformableCar.driverOut`, set by `EjectionWatch`, `vehicle/ejection.ts`, once per fixed step: a
  disabling or realistic-end-kill hit, head-on or from the side, closing ≥ 6 m/s, begun within the last 0.35 s). The car
  freewheels (`RaceField.coast`: no thrust and no lift-off braking, only rolling resistance and air drag) whoever's it is.
  It is dead for the rules: the Respawn race's reset puts the driver back, the No-reset race eliminates it. The HUD shows
  DRIVER OUT. The flag rides netplay snapshots and the dummy rides `MSG.eject`; highlight clips record each ejection
  (`ClipEjection`, `EJECT_POINTS`).

## Winning and the end

First car home wins (`winBy = laps`). Then the chequered flag: every other car finishes the next time it crosses the line,
classified by laps completed, then time (a lapped finisher shows "+1 lap"). A car that hasn't reached the line by its
deadline is `dnf` and keeps its laps: the deadline is the winner + 30 s (`FINISH_GRACE`), or its current lap's start
+ 1.5 × its own slowest lap (`LAP_SLACK`; the winner's average lap when it has none), whichever is later. The race closes
when no car is still running. No-reset: the last car running wins at once. `end()` closes the race now (running cars
`dnf`). Results: place, name, status, time, gap (or laps down, or laps done for DNF / out), best lap, laps.

## Spectate

Dead menu (no-reset, player out): Restart, End race, Spectate. Spectating chases a live car (LB/RB, Q/E, the touch prev /
next on the spectate bar, or a click on a standings name). A racing player can't be moved off their car, and
`DriverSeat.drivable` lets a pedal take the wheel only of this browser's player slot.

**Watch** (setup "You: Drive / Watch", `RaceOptions.spectate`): a spectator-only race. `field()` makes this browser's car one
more AI racer, so there is no player entrant: `start()` follows pole in spectate mode, cycling and the standings reach
every car, the HUD has no "You" row or finish card, and nothing can take the wheel. Touch, keys and pad switch cars
through `raceCommand({ type: "cycle", dir })` and `{ type: "watch", id }`. With the police chase on, cycling runs on past
the racers to every police car on the course.

## Aggression (`ai-aggression.ts`)

The setup slider is the field's **maximum**. Each rival rolls `fieldAggression(max, seed, id)`, uniform in [0, max]; a new
race rolls again. In a campaign the rolls are made once and stored on `CampaignRow.aggression`.
`mood(a, self, other) = a ≤ 0 ? −1 : 2a − 1 + 0.8(other − self) − (1 − a)·self` (damage 0 mint … 1 dead): 0 never attacks
and gives way; 1 attacks whatever its own state; 0.5 attacks only a car more wrecked than itself. The race AI splits it
into `fight = clamp(mood, 0, 1)` and `shy = clamp(−mood, 0, 1)`. The derby AI uses the same two functions.

- **Contact guard** (`ai/contact-guard.ts` `guardContact`, the last step of `RaceBrain.think`): of the racers and traffic
  (not police) except the rivals it means to hit (`fight > 0`), the soonest contact within 1.5 s is found by following the
  guarded car round the arc its steer asks for and every other car on the line it drives, each a car-shaped zone (2.4 × 6 m
  half-axes). The contact is steered clear of (at most 0.35 of full lock) and every contact ahead that sideways room
  cannot clear is braked for, down to a nudge (1.5 m/s) on 0.72 of the class brake. It keeps no state.
- **Aggression 0.5: aggressive only when safe** (`RaceBrain.safeShove`): a driver up to 0.5 (`CAREFUL`) fights a rival
  only while the shove is safe (adds `SAFE_SHOVE` 0.25 to its mood): the rival within reach, the cars' speeds along the road
  and the sideways closing speed under the derby's `hitSpeed` 2 m/s, at least 2.5 m of road beyond the rival, and not over a
  crest. A careful shove swings the lane at no more than `SHOVE_LAT` (0.5 m/s). Above 0.5 `mood` alone decides; aggression
  0 never fights.

## Campaign

`CAMPAIGN` = oval, rally, city, stunt, four-count, dam-spine, razor-shelf, breaker-yard (8 rounds). Points 10, 8, 6, 5, 4,
3, 2, 1 for places 1–8. Standings: points, wins, the better place in the latest round, entry order. Round 1's grid is the
entry order (player last); later grids are the standings, leader on pole. Retry re-runs a round without scoring it. A
Watch campaign runs every round in spectate mode. Nothing is saved: a campaign lives only in the running page.

## Controller slots and multiplayer

Slots `player | ai | remote`. `RaceDirector.drive` picks each car's `DriveInput`: player → this browser's `DriverSeat`,
ai → `RaceBrain.think`, remote → `setRemoteInput(carId, input)`; traffic → `TrafficBrain`. The rules see only `CarPose`s.
`RaceSession.snapshot()` / `restore()` round-trip the full state as JSON (`RaceDirector.snapshot()` / `applySnapshot()` for a
host and clients). The HUD reads `RaceHud` and sends `RaceCommand`s.

## Your name and car

Setup rows **Name** (≤ 16 characters, empty = "You") and **Car** (one button per `DRIVER_CARS` entry). The HUD keeps both in
`localStorage` (`crush.driver.name`, `crush.driver.car`) and `CrashLab` sends them to `CrashEngine.setDriver`: the name
becomes `RaceDirector.playerName`, the car rebuilds slot 0 and re-parks the grid. Netplay: a client's hello carries its name,
so every peer sees every chosen name (`docs/MULTIPLAYER.md`); a peer's car type does not travel.

## AI (`RaceBrain`)

Deterministic, allocation-free, memory per car id; figures per car class (`setClass(id, classStats(...))`). Distances are
tuned at 18 m/s and stretch × `pace = v / 18`.

- Line: inside of the next turn plus a personal offset; lanes change at 3.2 m/s, up to twice that in a shove or block.
- Rivals, only at racing pace (≥ 5 m/s): ram a slower rival on our line; late-block a rival coming through; shove a rival
  alongside; hunt a rival up to 25 m × pace ahead and 5 m sideways (with fight > 0.3, offset 1 m for a PIT tap). Clean
  drivers give room and shy away, both × `shy`.
- Following: behind a car on our line at our own pace a driver keeps a gap of `9 m × pace × (0.4 + 0.6·shy)`.
- Pursuit: a point `Ld = clamp(5 + 0.5 v, 7, 18)` m ahead; `w = 2 v sin α / Ld`; steer = w / (class full-lock yaw ×
  `0.35 + 0.65·min(1, v/8)` × steer grip), the same yaw model as `applyDrive`.
- Speed: over braking reach + 12 m, `√(v_corner² + 2·a·d)`, `a` = half the class brake, `v_corner = cornerSpeed(class,
  0.8 / |κ|, surface grip)`. Over a crest the speed is also capped at `√(g/κ_v)` (`crestSpeed`).
- Junctions: a shortcut's mouth is planned as a corner turning its angle over an 18 m look-ahead.
- Boost: a burst starts on a half-full meter on a clear run, pointed down the line; the plan at the boosted top still wants
  2 m/s more than the car has.
- A slower car on our line: pass on the side with room, closing sideways no faster than 0.8 m/s per m beyond 7 m
  (`PASS_NOSE`). A stopped or crawling car (< 3 m/s) is driven round. A car met head-on is seen sooner.
- Abreast: two rolling racers within 6.5 m lengthwise (`ABREAST`) keep their lanes 3.3 m apart.
- Shortcuts: a seeded coin per car, lap and shortcut (0.3 + 0.4·aggression). A car with another racer within 12 m when the
  coin is tossed stays on the loop.
- Unstick: throttle without motion → reverse with the nose swinging toward the line.

## Traffic (`TrafficBrain`)

Cars fill the race loop's lanes (`traffic.count`), then each side street (`routes[].count`), lanes round-robin. Each
cruises its lane at `traffic.speed`, slows for curvature, stops 7 m short of anything in its lane (`√(8·gap)` profile) and
after 2.5 s stopped edges round for 4.5 s. Side streets cross the race loop at grade, so racers meet cross traffic that does
not stop for them. Observer bubble (every racer still on track, checked every 0.25 s): a traffic car farther than 120 m
from all of them, dead for 6 s, or off the end of an open street is put away (hidden, no AI, no contacts); it wakes on its
lane 55–100 m from the nearest observer, 14 m clear of every car, never inside the local camera's view.

## Police chase (`PoliceBrain`)

Setup "Police: Off / Chase" (`RaceOptions.police`, off by default). The director gives the police their own car slots after
the racers and traffic (up to `POLICE_CAP` = 6 and the free slots), built as the police cruiser (`"police"` body and
class); they are never entrants, so rules, standings and results never see them, and a race with police off builds none.

- **Stakeouts:** from a third of the leader's first lap, every 6–16 s a pack of 2 parks on the run-off 90–140 m ahead of a
  random racer still racing, either side, out of the local camera's view, nosed toward the road.
- **Wake:** each unit stays parked until a racer's road progress passes its own spot, then joins its pack's pursuit (the
  first unit passed sets the target). A racer outside the road's corridor (run-off plus 8 m) passes nothing.
- **Lead-in (2 s):** full throttle along the road toward where the target is heading (1 s of its speed ahead of it, at least
  20 m ahead of the unit), blended in from its own heading; a unit facing the traffic turns round. It falls in behind its
  target instead of T-boning it from the run-off.
- **Pursuit:** sirens on (`setSirens`, sent to netplay clients), the racing line at aggression 1 with unlimited boost.
  Within 35 m on the same stretch it attacks by place in the pack: PIT from the rear quarter, door slams, getting ahead to
  block and brake-check. Ahead of its target a unit pulls out into its path 1.6 s before it arrives; one facing it rams it
  head-on from 3 s off. Wedged, it backs off for another run.
- **Pack guard** (`ai/pack-guard.ts` `guardMates`, the last step of `PoliceBrain.think` and `HunterBrain`, so race police
  and Survival's cops share it): every pack-mate is read as it moves (a unit pulling out is read at 8 m/s along its nose;
  one still parked cannot pull out until a racer wakes it). The mate it would reach soonest within 3 s is steered away from
  and braked for within 1.5 s; the boost is dropped with a predicted hit. A car braking while still rolling forward is read
  like a driven one; a STOPPED mate is not read when the steer on the wheel, held `STEER_HOLD` = 0.5 s, already clears it.
- **Packs build:** 5 s sustained within 45 m calls one more car, up to 5.
- **Stand-down:** a target that finishes, dies or respawns (left alone 4 s) hands the pack to another racer within 45 m,
  else the pack gives up, as it does after 160 m off for 4 s or 40 s of pursuit. Given-up units are put away out of view;
  a knocked-out unit after 6 s; a stakeout nobody came near after 45 s.
- **Busted** (`BUST`, `RaceSession`): a racing car held under 20 km/h within 20 m of a chasing unit for more than 4 s in a
  row is out the way a DNF is: `dnf`, or `out` in a no-reset race. Results show "Busted". The busted player gets a BUSTED
  banner (`race-busted.tsx`) for 2.5 s, then the camera follows the leader.
- **Durability:** an AI unit's class has durability ×1.3; a player who picks the Police car keeps the sedan's.

## Drafting (`DRAFT`, `RaceSession`)

A racing car 2–15 m straight behind another racing car (along the leader's travel), within 1.5 m of its line, both doing
over 15 m/s that way, is drafting (`CarRecord.draft`: unbroken seconds of it). Every 2 s of it unbroken adds 5 % to that
car's boost meter (`CarRecord.drafts` counts the bonuses; the seat's for our car, `RaceBrain`'s for an AI, a netplay peer's
own client from the snapshot). While drafting, the car's top speed is ×1.02 (`applyDrive`'s `topScale`). It lives in the
race rules, so fleet and derby never see it. The HUD shows a small "Draft" tag beside the boost meter.

Numbers by feel: 2 m keeps a bumper-to-bumper shove out, 15 m is about 0.35 s at top speed; ±1.5 m is a car width; 5 % per
2 s is a full meter after 40 s glued to a bumper; ×1.02 is 4 km/h at 200 km/h: a slow close on the car ahead.

## Ground, surfaces, decks

```ts
interface Ground {
  heightAt(x, z, y?): number;            // y: the body's height picks the layer (highest ≤ y + 1.2); omitted = top
  normalAt(x, z, out, y?): out;
  frictionAt(x, z, y?): number;          // grip multiplier (1 = asphalt)
  surfaceAt(x, z, y?): SurfaceId;
}
```
`FLAT_GROUND`: y 0, +Y, 1, asphalt. A race calls `setGround(track.ground())`. `TrackGround` bakes a 1 m heightfield over the
bounds: banked road plane, flat shoulders over the runoff, smoothstep back to the base terrain over 24 m; every path is
stamped, nearest centreline winning, except that a side path's blend never replaces the main loop's road or runoff and
eases over `MEET` (8 m) beyond it. Deck spans are skipped and answered analytically from the path at its own height, so a
bridge and the road under it coexist. On the main loop's road + runoff `world/road-crease.ts` keeps the crease where a bank
meets the flat runoff sharp. Driven cars ride it pitched and rolled onto its normal; where it falls away faster than gravity
follows they fly and land on whatever layer is below. Car pairs more than 2.5 m apart in height never touch.

| Surface | grip | top speed |
|---|---|---|
| asphalt, concrete | 1 | 1 |
| cobble | 0.85 | 0.92 |
| dirt | 0.72 | 0.84 |
| gravel | 0.62 | 0.72 |
| grass | 0.5 | 0.6 |
| sand | 0.45 | 0.5 |

Grip is applied per axle in `applyDrive`; the race glue (`onSurface`) only scales forward throttle by the surface's
top-speed share.

**Ground layers** (`scenes/ground-stack.ts` `GROUND_STACK`) order every flat layer: terrain, bridge top (`deck`), run-off,
concrete, asphalt, cobble, marking, kerb, dirt, gravel, grass, sand, then the scenes' decals and glow; `groundMesh` sets a
mesh's draw order from its level. Only the terrain and a bridge's top write depth. Every layer above is painted in stack
order with no depth write and depth-tested 1 px of its own depth slope nearer (plus 3 cm toward the camera when opaque)
against the terrain and `depthProxy`, the road and run-off ribbons at their true height. `ground-overlap.test.ts` holds
every course to under 2 m² of ambiguous overlap at 250 m; the bench card's depth line shows what a device needs.

## Contacts

Walls: footprint probes against the wall line on each side with a wall flag; push out along the inward normal, reflect
normal speed (e = 0.15), crumple above 5.5 m/s closing, sparks above 1.5 m/s. A wall remembers each car's last step
(`RaceField.wall`): a car penetrates only from the road side, so a car that came through a mouth or from another road is
not pushed back across it; a pose change over 4 m (spawn, respawn, a highlight keyframe) forgets the history. A hard hit on
a fixed solid (race walls, solid props, ramp faces) goes through the range barrier's striker contact. Props: a solid or
knock collider meets the car's whole footprint rectangle (`contact/prop-contact.ts` `footprintOverlap`) and pushes it out
along the least overlap axis, toward the side the car's centre is on; knock props fly off (`TrackArt.knock`). Car-to-car
contact is the sandbox's own.

## Courses

| Id | Name | Length | Character | Shortcuts |
|---|---|---|---|---|
| `oval` | Brickyard Oval | 685 m | flat, 18 m wide, four lefts, grandstands | infield dirt service road (4 → line) |
| `rally` | Ridge Rally | ≈ 860 m | climbs to 6.5 m, banked hairpin (6–8°), gravel / dirt, rocks, woods | ridge grass track (1 → 3); creek ford, sand (4 → 7) |
| `city` | Harbour Streets | ≈ 690 m | street grid: four open junctions crossed by two two-way side streets plus loop-lane cars, 90° corners, cobbled old town, concrete harbour front | back alley through a block (4 → 6) |
| `stunt` | Crossover Canyon | ≈ 1140 m | figure of eight over its own 9 m deck, banked wall-ride bowl (8–18°), kicker jump down the canyon side, tunnel through a ridge, sand terrain | quarry cut across the bowl, gravel (2 → 4) |
| `four-count` | Four-Count | ≈ 4080 m | bowl, city, canyon and woods in one lap: 14–20 m wide, banked 2–12°, asphalt / concrete / dirt, climbs to 5.4 m | skip the blocks, asphalt (0 → 2); cliff shelf beside the valley, gravel (2 → 4) |
| `dam-spine` | Dam Spine | ≈ 4530 m | the dam crest at 4–22 m with a bridge deck, banked to 8°, asphalt / concrete | spillway off the south face, gravel (0 → 3) |
| `razor-shelf` | Razor Shelf | ≈ 2930 m | the cliff road: a shelf at 2–14 m, banked to 8°, gravel / asphalt / dirt | inside cut off the shelf past the mesa, dirt (0 → 3) |
| `breaker-yard` | Breaker Yard | ≈ 2270 m | the plant loop on concrete with a storm-drain culvert (tunnel) as the long way, 17 placed props | upper deck and yard cut, both concrete (1 → 3), both die on the drain gate |

Havana (`havana`, Survival only) is off the menu: `docs/SURVIVAL.md`.

## Track JSON

One file per course in `src/game/world/tracks/`, registered in `tracks/index.ts`. `parseTrack` (zod) fills defaults and
reports every problem as `path: message`; `new Track(json)` also rejects a turn tighter than its own inner corridor, a
self-crossing with neither level a deck, less than 4.5 m between levels, and a checkpoint over the other level.

| Field | Type / default | Meaning |
|---|---|---|
| `id`, `name`, `blurb` | string | `id` is `[a-z0-9-]+` |
| `laps` | int 1–9 = 3 | default lap count |
| `road` | `{ width = 14, surface = "asphalt", runoff = [4, 4], runoffSurface = "grass", wall = [true, true], wallHeight = 1.1 }` | node 0's defaults |
| `nodes[]` | `{ x, z, y?, width?, bank = 0, surface?, runoff?, runoffSurface?, wall?, deck?, tunnel? }`, ≥ 4 | closed centripetal Catmull-Rom in driving order. Omitted fields inherit the previous node (bring `y` back down explicitly); `bank` (degrees, > 0 raises the right edge) does not. Flags hold from a node to the next: `wall` [left, right], `deck` (bridge span), `tunnel` (roofed, art only) |
| `checkpoints[]` | `{ node, t = 0 }`, ≥ 3 | main gates in order; checkpoint 0 = node 0, t 0 |
| `shortcuts[]` | `{ id, from, to, width = 7, surface = "dirt", path: [{x, z, y?}] }` | designed route: open the main walls at its mouths. Its end points take the main road's surface height there; an authored end `y` is ignored |
| `grid` | `{ perRow = 2, spacing = 8, back = 6 }` | staggered slots behind the line |
| `props[]` | `{ prefab, x, z, yaw = 0, scale = 1, size? }` | placed prefabs |
| `along[]` | `{ prefab, every, side = "both", offset = 1.5, fromNode?, toNode?, route?, scale = 1 }` | repeated beside the wall line (or along side street `route`); copies on any road are skipped, and so is any non-knock copy whose drawn footprint a bend turns onto its own road or runoff. `course-intrusion.test.ts` holds every course to ≤ 0.1 m |
| `scatter[]` | `{ prefab, count, near = 6, far = 60, seed = 1, scaleMin = 0.8, scaleMax = 1.25 }` | seeded scenery off every corridor |
| `traffic` | `{ count = 0, speed = 9, lanes = [], routes = [] }?` | `lanes: [{ offset, dir: 1 \| -1 }]` on the race loop; `routes: [{ id, path, loop = false, width = 9, surface = "asphalt", count, lanes }]` side streets (open the race walls where they cross) |
| `environment` | `{ sky = "#12141a", fog = 0.0035, terrain = "grass", hills: [{x, z, radius, height}], plateaus?, paint?, light? }` | look and base terrain (`plateaus` / `paint`: `docs/SURVIVAL.md`) |
| `survival` | `{ start: {x, z, yaw}, formation: [...] }?` | Survival anchors (`docs/SURVIVAL.md`) |

Prefabs: knock `cone, tyre-stack, hay-bale, crate`; solid `barrier-block, rock, tree, building, grandstand, billboard, lamp`;
scenery `gantry`, plus the courses' own (Havana's stucco, palm, monument, wall, dumpster). A prefab's front is its local +X;
`along` copies face the road. The start gantry is built by `TrackArt` at s = 0.

## Engine integration

Race hunks in `CrashEngine`: `toggleRace` / `setRace` (exclusive with the other scenes; hides the studio floor, grid, rings
and lamp poles; restores the sandbox car count on exit), `raceCommand`, `RaceDirector.drive` at the start of `fixedStep`,
`collide` per car per slice, `step` after the slices, `frame` before the camera, the chase camera while a race runs, `race`
in the HUD state, the 2.5 m height gate on car pairs. While a race menu is open the engine still polls the pad but ignores
pad buttons and keys (the HUD owns them). Racing keys: `docs/CONTROLS.md`.

## HUD and controller menus

Focus view (default): race readouts for the HUD car (`RaceHud.view`: the driven car, or the watched car while spectating):
place, lap, the race time beside the **race completion %** (`racer.done`: the rules' own `progress` over laps × lap length;
none in Survival), lap / last / best, the split, and the gauge. On a wide screen without a touch pad the gauge is the
**drive cluster** (`race-gauge.tsx`) in the bottom-right corner: an arc rev dial with a redline, the speed in the centre and
the gear under it (the **revs are faked**, `carRpm`: 0.3 at the foot of the gear's bucket, 1 at its top), a **damage arc**
(the weaker of the engine block's health and wheels on / 4: amber under 0.6, red under 0.25), a **wrench** lit while the
game would accept a reset (`canReset`), and the **nitrous bottle** (the boost meter, "Draft" above it while drafting).
Phones and narrow windows keep the compact speed / gear / segmented boost line. **Status strips** (`race-status.tsx`): the
**pursuit strip** (bottom centre) shows "CHASED BY N COPS" with the bust hold running down under it; the **near-goal
banner** (top centre) counts the last 500 yd / 500 m of the last lap down in 10s. There is no minimap. The HUD republishes
at ~8 Hz (`engine.ts` `hudAcc`), never per frame.

Standings (names are spectate buttons), start lights with 3·2·1·GO, WRONG WAY, respawn countdown, finish card, spectate
bar, and one "Full menu" button (H). Full view adds the sandbox title, settings panel, drive card and dock. Modal menus:
setup (course cards, Name, Car, You: Drive / Watch, laps 1–5, AI cars 1–15, max aggression, respawn / no reset, Police Off
/ Chase, Start race, Campaign, Back), pause (Resume, Restart, End race, Full menu / Race view, Quit to menu), dead, results
(Next course / Standings, Retry, Menu), campaign standings (Next round / champion, Menu). D-pad / left stick move focus
spatially (350 ms then 120 ms repeat), ←/→ adjust, A confirms, B backs out, Start resumes.

## Tests

- `track.test.ts`: every course compiles; gates, grid, walls, ground, bridge layers, crossing rules.
- `session.test.ts`: countdown, laps, cuts and the `missed` flag, line farming, shortcuts, wrong way, positions, respawn
  placement, no-reset survival, snapshots, DNF, the chequered flag and finish deadlines, campaign, drafting.
- `vehicle-classes.test.ts` (a draft's `topScale`), `race-ai.test.ts` (8 clean AI cars finish 3 laps on every course on
  the road ≥ 95 %; ram / block / follow, boost, the aggression model), `traffic.test.ts`, `placements.test.ts`,
  `menu-nav.test.ts`, `checkpoint-sweep.test.ts`.
- `race-finish.test.ts`, every course: 4 AI rivals plus the AI-driven player slot, 2 laps; results within the grid + 2 laps
  at 3 × the reference lap with ≥ 4 of 5 home or out. `RACE_FINISH_RUNS=5` runs 5 seeds at the default slider and 5 more
  at 1. Also a Watch race and campaign, and the police chase (parked units show no sirens, chasing ones do; cycling reaches
  a police car; no police car in the results; the lead-in falls in behind its target).
- `race-player.test.ts`: the PLAYER slot driven through the real seat on the oval, 2 laps, 3 AI, with a respawn press and
  detours; the HUD's lap and place equal a rules snapshot at every sample.
