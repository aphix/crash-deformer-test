# Race mode

Circuit racing on top of the crash sandbox: 2–16 racers plus NPC traffic, 1–5 laps from the menu, hidden checkpoint gates,
designed shortcuts, respawn or no-reset elimination, AI racers with an aggression dial, an optional police chase, an arcade
HUD with a focus view, controller-driven menus, and a campaign over every course. Scene picker **Race** or key **Z**.

## Module map

| Module | Owns |
|---|---|
| `world/ground.ts` | `Ground` (height, normal, grip, surface at x,z on a layer), `FLAT_GROUND`, `activeGround()`, `setGround()` |
| `world/catalog.ts` | surfaces (grip, rolling resistance, colour), prefab specs |
| `world/track-schema.ts` | zod schema of the track JSON, `parseTrack`, `TrackFile` |
| `world/track.ts` | `Track`: arc-length samples, gates, grid, projection, wall clip, routes, crossing checks; `TrackGround` heightfield + bridge decks |
| `world/tracks/*.json`, `tracks/index.ts` | the courses; `TRACKS` (menu order), `CAMPAIGN`, `OFF_MENU` |
| `world/placements.ts`, `world/junctions.ts` | `placeProps`, `propColliders`; `junctionsOf` (where each shortcut leaves and rejoins the loop, and its turn there) |
| `match/types.ts` | contracts: entrants, options, poses, records, events, snapshot, HUD read model, commands |
| `match/session.ts` | `RaceSession`: the rules |
| `match/campaign.ts` | `Campaign`: points, standings, grids, pegged rival aggression |
| `ai/ai-aggression.ts` | `fieldAggression`, `mood`; shared with the derby AI |
| `ai/race-ai.ts`, `ai/contact-guard.ts` | `RaceBrain` (racing driver), `guardContact` |
| `ai/traffic.ts` | `TrafficBrain` (loop lanes + side streets, observer bubble) |
| `ai/police.ts`, `ai/pack-guard.ts` | `PoliceBrain` (stakeouts, pursuits, packs, attacks), `guardMates` |
| `present/prefabs.ts`, `present/prefabs-mall.ts`, `present/prefab-pieces.ts`, `present/track-art.ts` | prefab meshes (the National Mall's landmarks in their own file, the shared pieces, boxes and materials in another); `TrackArt`: terrain, ribbons, decks + pillars, tunnels, markings, walls, start gantry, instanced and knocked props |
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
- Chevron signs (`chevron` prefab, scenery: no collider, one instanced mesh for every board of a course). A shortcut end whose turn
  from the way drivers come in to the way they must go (`junctionsOf`, `world/junctions.ts`, also read by the race AI) is more
  than `CHEVRON_TURN` (30°) gets a run of `CHEVRON_RUN` (4) boards `CHEVRON_GAP` (6 m) apart, from `placeProps` after every other
  placement: at a mouth, on the outside edge of the turn from the loop onto the shortcut, leading up to the mouth; at a rejoin,
  on the outside edge of the turn from the shortcut back onto the loop, leading on from it. Each stands `CHEVRON_STANDOFF` (1 m)
  past the run-off, square to the drivers it is for, its arrow a quarter turn toward the turn (the +X face reads `>`, the −X face
  `<`; both point along local −Z). A slot on a cross street, a bridge or in a tunnel stays empty and the run takes the next
  (`CHEVRON_SLOTS`). `chevrons.test.ts` pins each junction's run, facing, arrow side and place; `course-intrusion.test.ts` holds
  the boards beyond the run-off like every other prop.

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
  upright; the parts and wheels already off it stay where they lie (`resetVisual(keepTorn)`), not thrown again. A hold works in a no-reset race too, and is refused in Survival, while spectating, in a menu, and for a car that
  is respawning, out or finished. A netplay client's hold rides the input packet's flags byte to the host. AI reset: a car
  the race AI drives that gains < 25 m of track in the 8 s since it last gained 25 m takes the same tap reset (a pin is met 8 s
  after it starts, not up to 16 s as a fixed grid of 8 s windows met it).
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
  cannot clear is braked for, down to a nudge (1.5 m/s) on 0.72 of the class brake (`BRAKE_SHARE`, the share the race plan brakes at too); a car
  ahead is taken to shed the whole class brake, the most it can, so the closing speed is never under-counted. It keeps no state.
- **Aggression 0.5: aggressive only when safe** (`RaceBrain.safeShove`): a driver up to 0.5 (`CAREFUL`) fights a rival
  only while the shove is safe (adds `SAFE_SHOVE` 0.25 to its mood): the rival within reach, the cars' speeds along the road
  and the sideways closing speed under the derby's `hitSpeed` 2 m/s, at least 2.5 m of road beyond the rival, and not over a
  crest. A careful shove swings the lane at no more than `SHOVE_LAT` (0.5 m/s). Above 0.5 `mood` alone decides; aggression
  0 never fights.

## Time of day (`present/sky-dome.ts`, `WorldStage.setTime`)

The setup's **Time of day** (`RaceOptions.timeOfDay`: `daytime`, `sunset`, `nighttime`; share link `tod`) picks the race's sky
and light. It is drawn only: the simulation, the replays and the wire never see it, so a netplay client keeps its own pick. The
setup menu shows a change at once on the course behind it.

- **Sky.** A 360° panorama strip (`public/sky/<time>.webp`, 4096 × 780, one column a 1/4096 turn; `<time>-half.webp` is the same at
  2048 × 390) on a sphere round the camera, drawn at infinity after everything opaque so the depth test skips every pixel a
  surface covers (it writes no depth, takes no fog and no tone mapping, as the flat sky colour it replaces).
  Under its `hazeTop` it fades into the scene's fog colour, so the fogged course meets it with no seam: by day that is each course's
  own haze (a wide 0.2 rad band, the picture's horizon differing from it), at sunset and night the strip's own horizon colour, which
  is then the fog's too. Past the strip's top it fades to its zenith colour. The picture is sampled without anisotropic filtering:
  at any setting above 1 the wrap column draws as a dashed line of coarse-mip pixels. `SKY_LOOKS` holds what was read off each
  strip: horizon row, disc (sun or moon) position, and the horizon, middle and zenith colours. The day strip is five gpt-image-1
  generations seam-matched row by row and cross-faded; sunset (the day strip regraded to golden hour) and night (procedural stars,
  Milky Way and moon) were made locally when the image API ran out of credit, and are due to be replaced by generated ones.
- **Sky setting** (`Sky` in the settings, `sky=auto|on|full|off` in the `#` and as a `?sky=0|1|auto|on|full|off` page query for the bench).
  How much sky is drawn is a function of the setting and the FX tier (`skyDetailFor`): `off` draws none (the flat sky colour,
  no dome, no texture fetched or decoded); `auto` (the default) draws the full strip on high and ultra, the half strip on low and
  nothing on minimal and off; `on` is `auto` plus a plain horizon / middle / zenith gradient (no texture) on minimal and off;
  `full` draws the full strip on every tier (a textured sky against `off` at one tier: the bench's sky A/B).
  Only the picture in use is held: a change of detail or of time of day frees the old strip and fetches the new one.
- **Light.** The sun keeps the day's bearing and its 22 m height over the shadow box at every time; its elevation follows the
  time: the day's 58.6° (unchanged), sunset's disc but no lower than 12° (the shadow texels stretch 1 / sin of it), night's moon
  between 20° and 60°. The disc in the picture is turned onto that bearing (`uAtNorth`), and the shadow camera reaches 34 m past
  the sun. Daytime is each course's own `environment.light`; sunset has its own palette (an orange sun, a rose-violet sky light, a
  cool fill, the lamps lit early, dimmer reflections); nighttime is the sandbox's night lighting (`nightDepth`), lamps and pools on.
  The settings' night toggle during a race switches between nighttime and daytime; leaving the race restores the sandbox's own
  night setting.
- **Once, never per frame.** A time of day (or the night toggle) is applied when it is chosen: `WorldStage.setTime` / `apply` write the sky and fog colours, the lights, the dome's haze and the sun's shadow-camera axes (`sunRight`, `sunUp`) then, and a race's frames write none of them (`engine-time-of-day.test.ts` counts the writes over 120 frames on the Mall and the city at each time). The frame only moves the sun's shadow box onto the followed car (`RaceDirector.followSun`). A see-through double-sided material takes three's two-pass draw, which bumps its version twice a frame and re-resolves its program: such materials set `forceSinglePass` (the same test scans the scene).
- **Leaving a race.** The sandbox's background and fog are kept whole while a race runs (the race installs its own before its art relights the scene) and given back as they were, so a fleet, corkscrew or derby after a race at any time of day, or with Night toggled in the settings, has the sky of a fresh load (`engine-scene-sky.test.ts`).
- A course's own `backdrop` (the National Mall's secret mushroom cloud, once out) stands in front of every time's sky. A secret one is not built with the course: its 1024 × 640 canvas is painted and its mesh added at the flash's peak (`TrackArt.reveal`, under the white-out) and freed again when a run restarts (`resetSecret`); a course whose backdrop is no secret builds it at load (`track-art-backdrop.test.ts`).

## AI difficulty (`ai/constants.ts`, `RaceBrain.due`)

The setup's **AI difficulty** (`RaceOptions.aiDifficulty`: easy, medium, hard; share link `diff`) sets how often a rival re-decides
and how well it drives. Each rival rolls its think rate, its skill factors, its sway and its slip chance once per race in the
tier's band (`hash01(id, salt)`: `THINK_SALT` 11, `SKILL_SALT` 40–48; `AI_SKILL`, `THINK_HZ` in `ai/constants.ts`). Between thinks
the car holds its last input (`engine-race-field.ts` `held`); `think`'s `dt` is the time since its last think. Police, traffic
and the cool-down lap think every slice. Only the host thinks and a replay stores inputs, so neither the wire nor replays change.
**Hard** is the AI as it was before the dial (the default, the bench's setting): every factor is exactly 1 and every chance 0, so
its output is bit for bit unchanged (`race-ai.test.ts` pins checkpoints of it). The lower tiers err, they do not just drive slower:

| Tier | Think (Hz) | Corner speed | Braking | Steer gain | Look-ahead | Apex share | Sway (m) | Slip chance per corner | Slip: speed / braking | Shaken (× top) |
|---|---|---|---|---|---|---|---|---|---|---|
| easy | 8–20 | ×0.76–0.84 | ×0.6–0.9 | ×0.85–0.95 | ×0.75–0.95 | ×0.5–0.9 | 0.4–0.9 | 0.30–0.50 | ×1.3 / ×1.75 | 0.65 |
| medium | 96–192 | ×0.97–1 | ×0.95–1 | ×0.97–1 | ×0.95–1 | ×0.9–1 | 0.05–0.2 | 0.05–0.10 | ×1.1 / ×1.5 | 0.93 |
| hard | 192–240 (every slice) | ×1 | ×1 | ×1 | ×1 | ×1 | 0 | 0 | ×1 / ×1 | 1 |

Corner speed and braking scale what the planner assumes (`RaceBrain.plan`); steer gain and look-ahead scale the pursuit; the apex share
scales how far the line leans toward the inside of a bend, and the sway (`WOBBLE_K`) is a slow seeded sideways drift about it. A
**slip** (`slipCheck`, `mistakes` counts them) is rolled when a corner first comes into the plan, at most once per `SLIP_COOL`
(8 s): for `SLIP_WINDOW` (1.5 s) it plans corners and braking past the grip reserve (the car arrives too fast and runs wide or
late), then for `SLIP_RECOVER` (4 s) it is shaken and holds back. Every tier's corner factor is at most 1: the lower tiers are
slower because they err, never because they corner faster. In traffic (a car it follows, swerves for or is nudged by, and for medium any
car within `calm` = 40 m) a rival drives as hard does: medium errs only on an open road, so a gentle medium field never touches (at 20 m a
city pack still met at 18 m/s once the draft cone bunched it), while easy errs in packs too and may bump. On short busy courses medium
therefore drives almost as hard does (0–1 mistakes a race on oval and city). The finish bounds in `race-ai.test-util.ts` scale by tier
(`BOUND_SCALE`: easy 1.2, medium 1.1).

## Campaign

`CAMPAIGN` = oval, rally, city, stunt, four-count, dam-spine, razor-shelf, breaker-yard, national-mall (9 rounds). Points 10, 8, 6, 5, 4,
3, 2, 1 for places 1–8. Standings: points, wins, the better place in the latest round, entry order. Round 1's grid is the
entry order (player last); later grids are the standings, leader on pole. Retry re-runs a round without scoring it. A
Watch campaign runs every round in spectate mode. Nothing is saved: a campaign lives only in the running page.

The courses are the player's pick (`RaceOptions.campaign`, share key `camp`), defaulting to all nine in `CAMPAIGN` order. The
setup menu's **Mode** row (`RaceOptions.mode`, share key `mode`: `single` or `campaign`, an unknown value is ignored; it is an option like the rest, so it survives the menu unmounting for a solo replay view or a scene change and rides in a link) switches the course cards to Campaign: a tap ticks a card at the end of the order (a number shows its
round) or unticks it, **Select all** / **Unselect all** is one toggle, and tap order is play order (after Unselect all, the order
tapped is the campaign). **Start campaign** is disabled with nothing ticked, and the `campaign` command ignores an empty list.
The `options` command drops unknown and repeated ids and keeps the rest in order. The pick survives a campaign and other option
changes; picking a single-race course (`trackId`) never touches it, and the reverse.
Every setup control sends only the keys it owns (a course card `{ trackId }`, or `{ campaign }` in Campaign; `src/game/hud/setup-patch.ts`),
never the HUD snapshot's whole options: the snapshot can be a publish old, and a full copy would write an older value back over a change just made.

## Controller slots and multiplayer

Slots `player | ai | remote`. `RaceDirector.drive` picks each car's `DriveInput`: player → this browser's `DriverSeat`,
ai → `RaceBrain.think`, remote → `setRemoteInput(carId, input)`; traffic → `TrafficBrain`. The rules see only `CarPose`s.
`RaceSession.snapshot()` / `restore()` round-trip the full state as JSON (`RaceDirector.snapshot()` / `applySnapshot()` for a
host and clients). The HUD reads `RaceHud` and sends `RaceCommand`s.

## Your name and car

Setup rows **Name** (≤ 16 characters, empty = "You") and **Car** (one button per `DRIVER_CARS` entry). The HUD keeps both in
`localStorage` (`crush.driver.name`, `crush.driver.car`) and `CrashLab` sends them to `CrashEngine.setDriver`: the name
becomes `RaceDirector.playerName`, the car rebuilds slot 0 and re-parks the grid. Netplay: a client's hello carries its name,
so every peer sees every chosen name ([`MULTIPLAYER.md`](MULTIPLAYER.md)); a peer's car type does not travel.

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
- Speed: over braking reach + 12 m, `√(v_corner² + 2·a·d)`, `a` = 0.72 of the class brake (`BRAKE_SHARE`, the contact guard's share: the plan counted on half of it while the cars really brake at 26–28 m/s², so every stop began twice too early and undershot; × the tier's braking factor), `v_corner = cornerSpeed(class,
  0.8 / |κ|, surface grip)`. Over a crest the speed is also capped at `√(g/κ_v)` (`crestSpeed`).
- Junctions: a shortcut's mouth is planned as a corner turning its angle over an 18 m look-ahead.
- Boost: a burst starts on a half-full meter on a clear run, pointed down the line; the plan at the boosted top still wants
  2 m/s more than the car has.
- A slower car on our line: pass on the side with room, closing sideways no faster than 0.8 m/s per m beyond 7 m
  (`PASS_NOSE`). A stopped or crawling car (< 3 m/s) or one met head-on (an oncoming traffic car brakes to a stop as the
  racer closes, so its speed along the road is 0 by the end) is driven round on the side with more road beside the passing line, not the
  side nearest the planned lane (which carries a 2 m yield nudge for a faster car behind, and put a racer on the narrow side of an
  oncoming car, where it stopped and crept into it); only a car moving with us is passed on the side nearest the planned lane. A car met head-on is seen sooner.
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

- **Stakeouts:** from a third of the leader's first lap, every 6–16 s a pack of 2 parks on the run-off 230–290 m ahead of a
  random racer still racing, either side, out of every racer's sight, nosed toward the road.
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
  else the pack gives up, as it does after 160 m off for 4 s or 40 s of pursuit. Given-up units drive on and are put away
  once out of sight (below); a knocked-out unit after 6 s and out of sight; a stakeout nobody came near after 45 s and out
  of sight; a stakeout whose pack gives up stays parked until out of sight.
- **Out of sight** (`RacerSight`, `ai/cop-sight.ts`; no camera is read, so the rule is the same live, in a replay and in a
  reel): a cop is put on the road, and put away, only where no racer (every racer car, not only the player's) sees it: 100 m
  or more from each by straight line, and, for a racer on the road, 200 m or more ahead of it along the road or 40 m or more
  behind it (a racer off the road sees 200 m all round), each with 20 m to spare for the metres a racer drives between the
  beat that read its place and the frame the cop shows. On a course shorter than 2000 m (the Brickyard Oval and Harbour
  Streets are about 690 m: a few racers would otherwise cover the whole lap and nothing could ever be hidden) the three
  ranges are cut in proportion to its length, the 20 m margin kept. So on a long course a stakeout parks 230–290 m ahead,
  a reinforcement 230 m ahead of its target (parked) or coming up from 140 m behind (already chasing, its sirens on from its first frame), and no cop is ever put away moving within 100 m
  of a racer. A cop put on the road stays 12 s (`MIN_LIFE`) unless it is knocked out or 300 m from every racer; one on the
  road 75 s (`STALE_LIFE`) that is still seen goes as soon as no racer is within its near range plus the margin; a given-up
  cop that old brakes to a stop (a cop crawling on at the pack's pace had the racers queue behind it for ever, and one at
  their pace never gets clear of them, so cops piled up and no new stakeout could form), the racers go round it and the stall
  rule puts it away. A stakeout whose spots are all in sight tries again after 1 s. The stall rule (a cop
  out driving that gains under 25 m in 8 s, untouched, is put away) puts a cop that has stopped away where it stands, but a
  stuck cop still moving (shoving a car or wall) only once out of sight, and never within the near range of a racer; it is
  asked again after each further 8 s.
- **Busted** (`BUST`, `RaceSession`): a racing car held under 20 km/h within 20 m of a chasing unit for more than 4 s in a
  row is out the way a DNF is: `dnf`, or `out` in a no-reset race. Results show "Busted". The busted player gets a BUSTED
  banner (`race-busted.tsx`) for 2.5 s, then the camera follows the leader.
- **Durability:** an AI unit's class has durability ×1.3; a player who picks the Police car keeps the sedan's.

## Drafting (`DRAFT`, `RaceSession`)

A racing car in the wake of another racing car is drafting (`CarRecord.draft`: unbroken seconds of it). The wake is a cone
behind the leader's rear bumper (the stock hull, `CAR_HALF`: 4.44 m long, 1.76 m wide), measured in the leader's velocity
frame: `x` m behind the bumper, the follower is in when 0 ≤ `x` ≤ 3 car lengths (13.3 m) and its offset from the leader's
line is at most the leader's half width + `x`·tan 18° (0.88 m at the bumper, 4.1 m at 10 m, 5.2 m at the far end: a 36°
spread). Both cars must do over 15 m/s, and the follower's velocity must lie within 45° of the leader's, so a car crossing
behind does not draft. Every 2 s of it unbroken adds 5 % to that
car's boost meter (`CarRecord.drafts` counts the bonuses; the seat's for our car, `RaceBrain`'s for an AI, a netplay peer's
own client from the snapshot). While drafting, the car's top speed is ×1.02 (`applyDrive`'s `topScale`). It lives in the
race rules, so fleet and derby never see it. The HUD shows a small "Draft" tag beside the boost meter.

Numbers: the range and spread are the owner's sketch (about 3 car lengths, 35-45° total) and the research's (2.5-3 lengths,
12-18° half angle, a 45° heading check: `.extraResearch/perplexity/2026-10-13-arcade-draft-zone-values.md`, `2026-10-13-slipstream-zone-around-corners.md`).
The old straight box (2-15 m, ±1.5 m) lost the follower on any real bend (10 m back needed a 33 m radius); the cone keeps it
on a 25 m radius bend at a 10 m gap. Clips store the draft bit per step, so the geometry is not in a replay and a change needs no `REPLAY` bump.
5 % per 2 s is a full meter after 40 s glued to a bumper; ×1.02 is 4 km/h at 200 km/h: a slow close on the car ahead.

A clean drift also tops up the player's meter (`BOOST.drift`, `DriverSeat.input`): 12 % per second of slide, counted up to 2.5 s,
paid when the slide ends, and only if no contact fell within `driftClean` = 0.5 s of it. The AI's meters get no such reward.
The payout is shown, not silent: `DriverSeat.drift` (`DriftView`: seconds slid, clean now, payouts so far) rides the HUD read model (`CrashHudState.drift`, `RaceView.drift`; `NO_DRIFT` for a car the seat does not drive). While a slide charges, the boost bar and the nitrous bottle draw the share it would pay (`driftPay`) on top of the meter, green while it would be paid and amber while a contact is fresh, with "Drift +N%" beside it; the payout lands as a green flash over the meter (`components/drift-charge.tsx`).

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
eases over `MEET` (8 m) beyond it. Each segment measures only the cells of each row within its reach (`capsuleRow`), and an open side street's straight run of like samples is stamped as one segment (`sameRun`), so a cell is measured once per street rather than once per metre's sample near it; a painted polygon tests only the cells over its bounds. The National Mall's 4 M cells bake in about 0.37 s (6.2 s before). Deck spans are skipped and answered analytically from the path at its own height, so a
bridge and the road under it coexist. On the main loop's road + runoff `world/road-crease.ts` keeps the crease where a bank
meets the flat runoff sharp. Driven cars ride it pitched and rolled onto its normal; where it falls away faster than gravity
follows they fly and land on whatever layer is below. Car pairs more than 2.5 m apart in height never touch.

| Surface | grip | rolling resistance (Crr) |
|---|---|---|
| asphalt, concrete | 1 | 0.015 |
| cobble | 0.85 | 0.03 |
| dirt | 0.72 | 0.05 |
| gravel | 0.62 | 0.06 |
| grass | 0.5 | 0.35 |
| sand | 0.45 | 0.4 |

There is no speed cap per surface: grip is applied per axle in `applyDrive` (steering, the driven axles' traction, the sideways
hold), and the surface's rolling resistance over asphalt's drags a driven car to where its power meets it
(`terminalSpeed`; [`HANDLING.md`](HANDLING.md) § Acceleration). The AI caps its planned speeds at the same terminal and asks for a
target as its share of the class top: a target the drag will not let it reach is simply not reached.

**Ground layers** (`scenes/ground-stack.ts` `GROUND_STACK`) order every flat layer: terrain, bridge top (`deck`), run-off,
concrete, asphalt, cobble, marking, kerb, dirt, gravel, grass, sand, then the scenes' decals and glow; `groundMesh` sets a
mesh's draw order from its level. Only the terrain and a bridge's top write depth. Every layer above is painted in stack
order with no depth write and depth-tested 1 px of its own depth slope nearer (plus 3 cm toward the camera when opaque)
against the terrain and `depthProxy`, the road and run-off ribbons at their true height. `ground-overlap.test.ts` holds
every course to under 2 m² of ambiguous overlap at 250 m; the bench card's depth line shows what a device needs.

## Contacts

Walls: a course wall is a row of solid boxes (`world/track-sections.ts` `wallColliders`), one per drawn wall piece: the chord
between two sections' road-face points, 0.6 m deep behind it, from the profile's foot to the wall's top. The art draws the
same pieces (`wallRuns`, `wallLateral`, `WALL_PROFILE`: vertical faces, flat top, the box itself) and a dummy's Rapier walls are the same boxes (`courseSolids`). A car meets them,
with the props, through `courseContact` (one 8 m cell of `solidGrid` per query) from either side: a piece meets the car's whole
footprint rectangle, the push is along the least overlap toward the side the car's centre is on, normal speed is reflected
(e = 0.15), the hit crumples above 5.5 m/s closing and sparks above 1.5 m/s. A run's two ends are faces; every other end is
the joint to the next piece, so a piece is met there only across it, by the part of the footprint over its own length
(`jointOverlap`). A car under a deck (`PropCollider.base`) misses that deck's walls and props. A hard hit on a fixed solid
(race walls, solid props, ramp faces) goes through the range barrier's striker contact. Props: a solid or knock collider meets
the car's whole footprint rectangle (`contact/prop-contact.ts` `footprintOverlap`) and pushes it out along the least overlap
axis, toward the side the car's centre is on; knock props fly off (`TrackArt.knock`). A prefab's collider is the union of its drawn
pieces (`PREFABS[..].collider`: a tree's trunk and its two crown cones, a billboard's posts and panel, a grandstand's terraces), each a
box or circle with its own height range, all sharing the placement's index; `PrefabSpec.foot` is the separate clearance a
placement keeps from roads. `world/collider-drawn.test.ts` holds the walls and every prefab piece to the drawn geometry, each kind to
its own stated tolerance (`KIND_TOL`). A door a crash left hanging open stands out past the tyres, where the footprint test never
looks: every solid in reach (wall piece or solid prop) is also asked about the door's plan line over the door's own heights
(`partContact` on the fixed `ContactBox` `solidBox` builds from the collider). A door it meets is shut just far enough to clear it, at the
closing rate that took (`shutDoor`); a door the crash jammed open past that cannot shut and is torn off, and so is one slammed shut
past `SLAM_TEAR_J`. Knock props do not meet doors. Car-to-car contact is the sandbox's own.

## Courses

| Id | Name | Length | Character | Shortcuts |
|---|---|---|---|---|
| `oval` | Brickyard Oval | 685 m | flat, 18 m wide, four lefts, grandstands | infield dirt service road (4 → line) |
| `rally` | Ridge Rally | ≈ 860 m | climbs to 6.5 m, banked hairpin (6–8°), gravel / dirt, rocks, woods | ridge grass track (1 → 3); creek ford, sand (4 → 7) |
| `city` | Harbour Streets | ≈ 690 m | street grid: four open junctions crossed by two two-way side streets plus loop-lane cars, 90° corners, cobbled old town, concrete harbour front | back alley through a block (4 → 6) |
| `stunt` | Crossover Canyon | ≈ 1140 m | figure of eight over its own 9 m deck, banked wall-ride bowl (8–18°), kicker jump down the canyon side, tunnel through a ridge, sand terrain | quarry cut across the bowl, gravel (2 → 4) |
| `four-count` | Four-Count | ≈ 4080 m | bowl, city, canyon and woods in one lap: 14–20 m wide, banked 2–12°, asphalt / concrete / dirt, climbs to 5.4 m | skip the blocks, asphalt (0 → 2); cliff shelf beside the valley, gravel (2 → 4) |
| `dam-spine` | Dam Spine | ≈ 4530 m | the dam crest at 4–22 m with a bridge deck, banked to 8°, asphalt / concrete | spillway off the south face, gravel (0 → 3) |
| `razor-shelf` | Razor Shelf | ≈ 2930 m | the cliff road: a shelf at 2–14 m, banked to 8°, gravel / asphalt / dirt | inside cut off the shelf past the mesa, dirt (1 → 4): a deliberate high-risk line (≈ 38 s against the road's 65 s, its 12 m mouth admits one car at a time, so who makes it is close to a lottery; owner 10-07). Its first 48 m, into the mouth, are cobble (grip 0.85 against dirt's 0.72), a row of tall cones runs along the shelf's inside edge for the 110 m before the mouth and two rows line the cobble, and a CRUSH billboard stands just past the rejoin |
| `breaker-yard` | Breaker Yard | ≈ 2270 m | the plant loop on concrete with a storm-drain culvert (tunnel) as the long way, 17 placed props | upper deck and yard cut, both concrete (1 → 3), both die on the drain gate |
| `national-mall` | Washington DC | ≈ 2760 m | the 2026 Freedom 250 IndyCar street circuit round the National Mall, rebuilt from the street grid (the published sources give the streets, not a turn map): 3rd St start, the Pennsylvania Ave frontstretch (16 m wide, 0.4 mi), 9th St, Constitution Ave and 7th St round the National Archives, Independence Ave with 0.3 m bumps every 40 m into turn six, a roofed 3rd St underpass; concrete walls with 1 m runoff; Madison Drive cross traffic over 7th St (2 cars; it stops short of 3rd St, whose crossing 65 m past the line had the bunched field hitting it); grass only on the Mall's lawn between Madison and Jefferson Drives (two elm rows each side, a gravel walk), the museums on paved ground either side of it; 7th and 3rd Streets run open across the lawn (no walls from Madison Drive's crossing to Jefferson Drive, a line of 4 kg cones each side every 4 m) and the lawn is no shortcut: a car cutting across it skips the Independence Ave checkpoint and earns no lap; the Capitol on a 12 m plateau (its central block, wings and east portico under three pediments, colonnades on every front, two floors of windows, roof balustrades, the west front's stair toward the Mall, and the dome on its colonnaded drum with 36 ribs, the lantern in its ring of columns and the Statue of Freedom: `world/landmarks.ts`), and below it Union Square: the Capitol Reflecting Pool's wedge (its long west end convex, its short east end concave, about the published 6 acres) on its plaza, the Grant Memorial at its east end facing down the Mall (Grant mounted on his pedestal, the Cavalry group north and the Artillery group south on a 77 m platform), and 1st Street with the Peace Monument in Peace Circle and the Garfield Monument in Garfield Circle at the plaza's corners. Madison and Jefferson Drives run down the Mall to 3rd Street's edge, where the course's barrier closes them. West of 9th St the course is the map (the owner's Google Maps view: a map pixel a metre, about 3/4 of real, its Constitution Ave on the course's and its 15th St just west of 9th St's buildings, the blocks between them left out): 15th and 17th Sts, Constitution Ave out to the Lincoln Memorial, E and H Sts, the Pennsylvania Ave plaza, 18th to 23rd Sts and C to G Sts, with office blocks of 18-36 m and the State Department, the Federal Reserve, the OAS, Constitution Hall and the Interior's; the White House as it stands (North Portico to Lafayette Square and its trees, the Treasury east, the Eisenhower Executive Office Building west, fenced lawns with their fountains), the Ellipse and its road, the Washington Monument (169 m) on its grounds between 15th and 17th as the owner's map of them has them (a 3.5 m knoll under a paved circle ringed by 50 flags, the two gravel path circles crossing at its foot inside the oval walk, the walks curving out to Constitution Ave and 15th St and running straight west to 17th St, the Jefferson Pier stone, the Sylvan Theater, groves north-west, south and down 15th St round open lawn), the WWII Memorial (a 55 m basin, two fountains, 56 pillars and two arches on a granite plaza), Constitution Gardens' lake, the Lincoln Memorial Reflecting Pool (500 × 50 m between rows of elms) and the Lincoln Memorial facing east down it inside its circle road (on its granite terrace, the 20-step grand stair down to the pool between cheek blocks with braziers, the great steps and the flight through them, 36 tapered Doric columns with capitals, the frieze's 36 state panels, the attic's 48 festoons, and the open east front on the chamber, its Ionic rows and the seated Lincoln). The city is filled round the circuit (no ground within 150 m of the course, off its streets and lawns, is more than 40 m from a building, tree or monument): downtown north of Pennsylvania Ave (D to H Sts, 9th to 3rd Sts north; the Portrait Gallery, Capital One Arena, the Building Museum, the FBI building, Judiciary Square), the Federal Trade Commission and the Canadian Embassy between Constitution Ave and the grandstands, the National Gallery's lawn, plaza and Sculpture Garden, the Smithsonian gardens, the Arts and Industries Building, Jefferson Drive, the federal blocks south of Independence Ave to C St SW, the House office buildings west to east (Rayburn, Longworth, Cannon) about South Capitol St on the Capitol's axis, the Botanic Garden, Bartholdi Park, the Grant Memorial, the Capitol grounds' trees, the Senate Park with the Taft Carillon and the Russell building, the Sylvan Theater and groves on the Monument grounds, the Vietnam Veterans Memorial's wall and the Korean War Veterans Memorial, and the Tidal Basin's north shore under its cherry trees. The far plane is 2300 m and the fog 0.0007. A mushroom cloud waits on the sky (`backdrop`, `secret`): typing the Konami code (up up down down left right left right B A B A, `engine/konami.ts`) in a race on it brings a slow white-gold flash (`present/people.ts`, `nukeFlash`) and, at its height, the cloud, over the frontstretch's vanishing point toward the White House. The White House's fenced North and South Lawns are guarded (`guards`, `scenes/lawn-guard.ts`): a car on them raises the alarm, 2.5 s later the eight guards (half in the uniformed division's navy, half in black suits, `present/people.ts`, `GuardSquad`) are out of the North and South Porticos firing on it, a shot every 0.12 s, half of them hitting, and its 13th to 19th hit kills its engine (`DeformableCar.disable`: keyed for the highlight replay, `REPLAY_VERSION` 84), so the race counts it a wreck and resets it. Once the Konami code is in, the guards stand down and a blond VIP in a dark suit (`present/people.ts`, `VipEscort`) walks out of the nearest door to the player's car instead; when it waits for him at the passenger door he gets in and rides in the passenger seat until the driver is thrown out, and is thrown with him (`RagdollSystem.throwPassenger`). The code lasts one run: a restart (Retry, R, the next round) puts it all back (`RaceDirector.stowSecret`: the guards on duty, the VIP inside, the flash stopped and the cloud off the sky), and a netplay client does the same when the host's run starts afresh. The guards fire on a netplay host's sim only, and the VIP is each browser's own: a client sees neither the guards nor a peer's VIP. Survival is played on it too (its `survival` anchors: the player on the race's pole slot facing the Washington Monument, the cops behind; a rim of 154 `building` blocks, 12 m thick and 20 m tall, closes the city 80 to 100 m outside its last street, [`SURVIVAL.md`](SURVIVAL.md)) | none |

The White House guards are run down (`scenes/figure-strike.ts`, `scenes/lawn-guard.ts`): any car (the player's, a rival's, a cop's) moving at 4 m/s or more
(`STRIKE_SPEED`, the `HIT_DV` a dummy's part must change velocity by to count as hit; slower, a bumper only leans on a man who steps aside) whose
cage's plan box (as crushed) grown by 0.3 m meets a guard, standing, running out or running back in, throws him as a dummy from where he stood, standing,
hands at his sides, in the dress he wore, at the car's velocity with a lift, a kick off its centre line (the car goes on at speed whatever it hit, so he is thrown
clear of its path) and a tumble: the thrown drivers' own launch (`RagdollSystem.throwFigure`: the worker's world on a course, ragdoll-worker.ts, or this thread's). The
squad's guards are SIM state (`LawnGuard.step`: where each is, the strike, once per guard per race), so a netplay host decides it on its fixed step and a highlight clip
that carries the striking car throws him again at that step (`ClipStrike`, `REPLAY_VERSION` 89), and carries the whole squad (`ClipSquad`, `REPLAY_VERSION` 91: its state at the clip's start and its decisions, docs/HIGHLIGHTS.md) so the replay draws the guards standing, running out and firing as the race had them. A guard run down is out of the squad until the next race (a restart or
the Konami reset: `LawnGuard.reset`, standing again at his post once the alarm calls him), never the shooter, and the squad's rate falls with the guns left
(a shot every 0.12 s at full strength, 0.12 s × guards ÷ guards standing). The car feels nothing from him (an 80 kg man against a car of a tonne or more would take under 8 % of
its speed, under what a player can tell from the throttle); like every dummy he reaches the sim only through a torso striking another car's pane. A netplay client never steps the squad, so in the race it
sees neither the standing guards nor the thrown ones, as before (its results reel draws them from the clips); the VIP is each browser's own, so a car that runs him down on his walk (the player's, or
any on that browser's field) throws him on that browser alone (`VipEscort`). A shot that hits throws the grind's spark shower (`CrashEngine.sparkShower`, one poof a hit, no throttle: `RaceHost.shotFx`) off the car's body, where the shot's tracer ends: the ray from the muzzle to the aim point enters the car's box (its cage's plan box between keel and crown)
and walks down the cage's height field to the first point inside the body (`present/people.ts` `onBody`), so the tracer and the sparks start on the car's surface facing the guard, not inside it. A miss draws its tracer wide of the car and no sparks.

Havana (`havana`, Survival only) is off the menu: [`SURVIVAL.md`](SURVIVAL.md). A course with `survival` anchors is a Survival course (Havana, the National Mall): `RaceField.survivalCourses`. Race's menu lists race courses and nothing of Survival; Survival's own setup menu (the bottom bar's Survival) lists the Survival courses.

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
| `shortcuts[]` | `{ id, from, to, width = 7, surface = "dirt", path: [{x, z, y?, surface?}] }` | designed route: open the main walls at its mouths. Its end points take the main road's surface height there; an authored end `y` is ignored. A point's `surface` paves the run from it to the next point (omitted: the shortcut's own) |
| `grid` | `{ perRow = 2, spacing = 8, back = 6 }` | staggered slots behind the line |
| `props[]` | `{ prefab, x, z, yaw = 0, scale = 1, size? }` | placed prefabs |
| `along[]` | `{ prefab, every, side = "both", offset = 1.5, fromNode?, toNode?, route?, scale = 1 }` | repeated beside the wall line (or along side street `route`); copies on any road are skipped, and so is any non-knock copy whose drawn footprint a bend turns onto its own road or runoff. `course-intrusion.test.ts` holds every course to ≤ 0.1 m |
| `scatter[]` | `{ prefab, count, near = 6, far = 60, seed = 1, scaleMin = 0.8, scaleMax = 1.25 }` | seeded scenery off every corridor |
| `traffic` | `{ count = 0, speed = 9, lanes = [], routes = [] }?` | `lanes: [{ offset, dir: 1 \| -1 }]` on the race loop; `routes: [{ id, path, loop = false, width = 9, surface = "asphalt", count, lanes }]` side streets (open the race walls where they cross) |
| `environment` | `{ sky = "#12141a", fog = 0.0035, terrain = "grass", hills: [{x, z, radius, height}], plateaus?, paint?, light?, far = 900, backdrop? }` | look and base terrain (`plateaus` / `paint`: [`SURVIVAL.md`](SURVIVAL.md)); `far` is the race camera's far plane (m); `backdrop: {kind: "mushroom-cloud", bearing, secret = false}` paints a picture on the sky round `bearing` (degrees from −z toward +x), drawn at infinity behind the whole course with no fog (`present/sky-backdrop.ts`); a `secret` one is not there until the Konami code is typed in a race on the course (`TrackArt.reveal`) |
| `survival` | `{ start: {x, z, yaw}, formation: [...] }?` | Survival anchors ([`SURVIVAL.md`](SURVIVAL.md)) |
| `guards` | `{ lawn: [[x, z], ...], doors: [{x, z, yaw}], count }?` | guarded grounds (`scenes/lawn-guard.ts`): a car on the `lawn` polygon raises the alarm and `count` guards come out of the `doors` (facing out of the house) to fire on it; once the course's secret is out they stand down and its VIP comes out instead (`present/people.ts`, `VipEscort`) |

Prefabs: knock `cone, tyre-stack, hay-bale, crate`; solid `barrier-block, rock, tree, building, grandstand, billboard, lamp`;
scenery `gantry` and `chevron` (placed by `placeProps` at shortcut junctions, not by the JSON), plus the courses' own (Havana's stucco, palm, monument, wall, dumpster; the National Mall's obelisk, capitol,
marble (a plain block a placement's `size` stretches to a whole museum without stretching any windows), white-house, fountain, fence, reflecting-pool and basin (the pools, their water on its own glossy material; a stone kerb round a floor 10 cm under the water, never stone filled up to the rim, whose top would lie a centimetre under the water's and flicker overhead: `poolStone`), lincoln, capitol-pool (the Capitol Reflecting Pool's wedge: a rim of turned bricks round a flat water sheet), and grant-memorial, peace-monument and garfield-monument (marble and bronze bricks, drawn and bounded alike: `world/landmarks.ts`), and flagpole (a pole flying the Stars and Stripes)). A prefab's front is its local +X;
`along` copies face the road. The start gantry is built by `TrackArt` at s = 0.

## Engine integration

Race hunks in `CrashEngine`: `toggleRace` / `setRace` (exclusive with the other scenes; hides the studio floor, grid, rings
and lamp poles; restores the sandbox car count on exit), `raceCommand`, `RaceDirector.drive` at the start of `fixedStep`,
`collide` per car per slice, `step` after the slices, `frame` before the camera, the chase camera while a race runs, `race`
in the HUD state, the 2.5 m height gate on car pairs. While a race menu is open the engine still polls the pad but ignores
pad buttons and keys (the HUD owns them). Racing keys: [`CONTROLS.md`](CONTROLS.md).

## HUD and controller menus

Focus view (default): race readouts for the HUD car (`RaceHud.view`: the driven car, or the watched car while spectating):
place, lap, the race time beside the **race completion %** (`racer.done`: the rules' own `progress` over laps × lap length;
none in Survival), lap / last / best, the split, and the gauge. On a wide screen without a touch pad the gauge is the
**drive cluster** (`race-gauge.tsx`) in the bottom-right corner: an arc rev dial with a redline, the speed in the centre and
the gear under it (the **revs are faked**, `carRpm`: 0.3 at the foot of the gear's bucket, 1 at its top), a **damage arc**
(the weaker of the engine block's health and wheels on / 4: amber under 0.6, red under 0.25), a **wrench** lit while the
game would accept a reset (`canReset`), and the **nitrous bottle** (the boost meter, "Draft" above it while drafting).
Cues are graded, not switched (masterclass 23:34, "fade them in or out over some parameter"): the speed digits tint toward amber
by `RaceView.brakeCue` (0..1: `brakeCueAt` is 0 at the AI plan's speed for the next corner and rises linearly to 1 at 30 % over it,
the worst corner in braking reach; `brakeTint`, a `color-mix` with a 150 ms transition between the HUD's ticks); the boost bottle
and bar glow by a continuous level (`nitroGlowLevel`: the fill up to 0.6, a burn 1; `transition-shadow` / `transition-[filter]`);
a standings row slides to its new place on a pass (a FLIP offset the CSS transform transition takes home) and fades in or out
when it arrives or leaves (`standings-motion.ts` `STANDING_LI`, `withLeavers`, 300 ms).
Phones and narrow windows keep the compact speed / gear / segmented boost line. **Status strips** (`race-status.tsx`): the
**pursuit strip** (bottom centre) shows "CHASED BY N COPS" with the bust hold running down under it; the **near-goal
banner** (top centre) counts the last 500 yd / 500 m of the last lap down in 10s. There is no minimap. The HUD republishes
at ~8 Hz (`engine.ts` `hudAcc`), never per frame.

Standings (names are spectate buttons), start lights with 3·2·1·GO, WRONG WAY, respawn countdown, finish card, spectate
bar, and one "Full menu" button (H). Full view adds the sandbox title, settings panel, drive card and dock. Modal menus:
setup (Mode: Single race / Campaign, with Select all / Unselect all under Campaign, course cards, Name, Car, You: Drive / Watch,
laps 1–5, AI cars 1–15, max aggression, respawn / no reset, Police Off / Chase, Start race or Start campaign, Back), pause (Resume, Restart, End race, Full menu / Race view, Quit to menu), dead, results
(Next course / Standings, Retry, Menu), campaign standings (Next round / champion, Menu). D-pad / left stick move focus
spatially (350 ms then 120 ms repeat), ←/→ adjust, A confirms, B backs out, Start resumes. When the focused item unmounts (a
deleted saved replay, a stepper that disables at its bound) focus moves to the item now nearest where it was (`nearestNav`),
without scrolling, so a long menu keeps its scroll offset; it never falls back to the first item (the Name field at the top).

## Tests

- `track.test.ts`: every course compiles; gates, grid, walls, ground, bridge layers, crossing rules.
- `session.test.ts`: countdown, laps, cuts and the `missed` flag, line farming, shortcuts, wrong way, positions, respawn
  placement, no-reset survival, snapshots, DNF, the chequered flag and finish deadlines, campaign, drafting.
- `race-menu-options.test.ts`: a course pick through the `options` command changes only `trackId` (from watch / police / no reset /
  laps / AI count / aggression / difficulty, before a race and after one); the campaign pick (default order, tap order, unknown and
  repeated ids dropped, empty never starts, a two-round Watch campaign plays only those courses in that order).
- `vehicle-classes.test.ts` (a draft's `topScale`), `race-ai.test.ts` (8 clean AI cars finish 3 laps of the oval on
  the road ≥ 95 % at every tier; easy is slower than hard by ≥ 8 %, makes mistakes where hard makes none,
  two easy runs agree to the bit, hard's `think` output is pinned bit for bit; a stale medium driver's guard brakes for a car ahead; ram / block / follow, boost, the aggression model),
  `race-ai.ai-long-run.ts` (the full-sanity sweep: the same 3-lap field on every course at every tier, easy slower than hard on every course, medium's mistakes), `race-contact.test.ts` (the contact classifier on eight real contacts), `race-contact.ai-long-run.ts` (aggression-0 fields of 4 and 7 rivals on every course at medium and hard start no contact), `traffic.test.ts`, `placements.test.ts`,
  `menu-nav.test.ts`, `checkpoint-sweep.test.ts`.
- `race-finish.ai-long-run.ts` (`npm run test:ai-long-run`), every course: 4 AI rivals plus the AI-driven player slot, 2 laps; results within the grid + 2 laps
  at 3 × the reference lap with ≥ 4 of 5 home or out. `RACE_FINISH_RUNS=5` runs 5 seeds at the default slider and 5 more
  at 1. Also the city seed-1 race that once held the player car nose to nose with oncoming traffic, and the police lead-in pools
  (heading converging over many seeds, no cop pair meeting, Dam Spine and Four-Count). `race-finish.test.ts`: a 1-lap oval race,
  Watch races and campaign, the police chase on a 1-lap oval (parked units show no sirens, chasing ones do; cycling reaches
  no police car; no police car in the results), one stakeout's lead-in falling in behind its target; `ai/traffic.test.ts` (a
  traffic car facing a racer edges to its own kerb) and `ai/police-lead-in.test.ts` (a nose-to-nose stakeout pair's lead-ins do not touch).
  `race-police-sight.ai-long-run.ts`, `race-start.ai-long-run.ts` and `spectate-cam.ai-long-run.ts` are the whole-race sweeps of
  the police put-on / put-away rules, the first seconds of every grid and the Auto camera on every course; their rules are pinned in
  `ai/cop-sight.test.ts`, `ai/police.test.ts`, `race-start.test.ts` and `present/spectate-cam.test.ts`.
- `race-player.test.ts`: the PLAYER slot driven through the real seat on the oval, 2 laps, 3 AI, with a respawn press and
  detours; the HUD's lap and place equal a rules snapshot at every sample.
