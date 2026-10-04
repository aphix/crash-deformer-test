# Race mode (as built)

Circuit racing on top of the crash sandbox: 2–16 racers plus NPC traffic, 1–5 laps from the menu,
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
| `src/game/world/ground.ts` | `Ground` (height, normal, grip, surface at x,z on a layer), `STEP_UP`, `FLAT_GROUND`, `activeGround()`, `setGround()` | none |
| `src/game/ai/ai-aggression.ts` | `fieldAggression` (rival roll under the slider), `mood` (fight or keep clear); shared with the derby AI | none |
| `src/game/world/catalog.ts` | surfaces (grip, top-speed share, colour), prefab specs | none |
| `src/game/world/track-schema.ts` | zod schema of the track JSON, `parseTrack`, `TrackJson` / `TrackFile` | none |
| `src/game/world/track.ts` | `Track`: arc-length samples, gates, grid, projection, wall clip, routes, crossing checks; `TrackGround` heightfield + bridge decks | THREE maths only |
| `src/game/world/tracks/*.json`, `tracks/index.ts` | the courses; `TRACKS` (menu order) and `CAMPAIGN` | none |
| `src/game/match/types.ts` | contracts: entrants, options, poses, records, events, snapshot, HUD read model, commands | none |
| `src/game/match/session.ts` | `RaceSession`: the rules | none |
| `src/game/match/campaign.ts` | `Campaign`: points, standings, grids, pegged rival aggression | none |
| `src/game/ai/race-ai.ts` | `RaceBrain` (racing driver), `onSurface` | none |
| `src/game/ai/traffic.ts` | `TrafficBrain` (loop lanes + side streets, observer bubble) | none |
| `src/game/ai/police.ts` | `PoliceBrain` (police chase: stakeouts, pursuits, packs, attacks) | none |
| `src/game/world/placements.ts` | `placeProps`, `propColliders` | none |
| `src/game/present/prefabs.ts`, `track-art.ts` | prefab meshes; `TrackArt`: terrain, ribbons, decks + pillars, tunnels, markings, walls, start gantry, instanced props, knocked props, Cinematic tags | THREE |
| `src/game/hud/menu-nav.ts` | spatial focus maths for controller menus | none |
| `src/game/engine/engine-race.ts` | `RaceDirector`: engine glue (slots, walls / props, rules step, respawns, traffic bubble, AI stall reset, menus, campaign, HUD model) | THREE |
| `src/components/race-hud.tsx`, `use-pad-menu.ts` | readouts, standings, overlays, menus, focus-view toggle; pad / keyboard menu navigation | DOM |
| `src/game/world/race-world.test-util.ts` | the whole race stack headless (director + real cars + the engine's fixed-step order) | THREE maths |

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
(`racing | respawning | finished | out | dnf`), the last reported `x`, `z`, the wrong-way timer, a
projection hint, and `draft` / `drafts` (seconds drafting, bonuses earned; see Drafting). All plain JSON.

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
- Dead for the rules: drivetrain dead, upside down for 2.5 s, or still for 8 s while the race AI drives it (not while a
  human has it: this browser's driver or a netplay peer, who can press R).
- Player reset: R / D-pad ↓, 1.5 s. AI reset: a car the race AI drives (a rival, or the player's car
  while its seat isn't driving) that gains < 25 m of track in 8 s (wedged on a wall, shoving a stopped
  car, two wrecks hooked together) takes the same reset.
- Default: `respawning` for 3 s, then back on the centreline (or the shortcut being driven) at the
  wreck's clamped progress, never past `next` (≥ 3 m short), facing the tangent, ≥ 6 m from every car
  (centre, ±½ half-width, then 6 m further back, up to 12 tries), on the layer it was racing on
  (deck or road below), fully repaired.
- No-reset: a death is final (`out`); resets are refused. The player gets the dead menu.
- **Driver thrown out** (`DeformableCar.driverOut`, set by the sim's `EjectionWatch`, `vehicle/ejection.ts`, once per
  fixed step at the end of `stepWorld`: a disabling or realistic-end-kill hit, head-on or from the side, closing ≥ 6 m/s,
  that began (`beginCrush`, a re-armed `rearmHit`) within the last 0.35 s; a kill with no new hit, a damaged car over the
  stunt course's CRUSH crest or on a bank, or a graze that only touched it, throws nobody, and the engine block only packs
  for 0.35 s after a contact, `PACK_QUIET`):
  the car freewheels (`RaceField.coast`: throttle 0, brake 0, wheel 0 and `DriveInput.neutral`, so no thrust and no lift-off
  engine braking: only rolling resistance and air drag, `DRIVE.roll` / `DRIVE.drag`, ~0.5 m/s² at 130 km/h against the lift-off
  drag's 12.6 on a sedan; tyres, ground and gravity as ever) whoever's it is: the player's seat, a peer, a rival, traffic or police. It is dead for
  the rules (`judge`): the Respawn race's 3 s reset puts the driver back (`resetVisual`), the No-reset race eliminates it
  (`out`). The HUD shows DRIVER OUT (`you.driverOut`). The flag rides netplay snapshots (flags byte, bits 5–6) and
  the thrown dummy rides `MSG.eject`; highlight clips record each ejection (`ClipEjection`), score `EJECT_POINTS` for it
  and relaunch the dummy from the recorded numbers.

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
Q/E, the touch prev / next on the spectate bar, click a standings name). Watching is allowed only once
the player is out, finished or spectating; a racing player can't be moved off their car, and
`DriverSeat.drivable` lets a pedal take the wheel only of this browser's player slot.

**Watch** (setup "You: Drive / Watch", `RaceOptions.spectate`): a spectator-only race. `field()` makes
this browser's car one more AI racer (paint name, rolled aggression), so there is no player entrant:
the grid is the AI field in car order, `start()` follows pole in spectate mode, cycling and the
standings reach every car (our own AI one too), the HUD has no "You" row or finish card,
and nothing can take the wheel. Touch, keys and pad all switch cars through `raceCommand({ type:
"cycle", dir })` (the spectate bar shows while `RaceHud.spectating` is non-null) and `{ type: "watch", id }`.
With the police chase on, cycling runs on past the racers to every police car out on the course
(parked or chasing; `RaceHud.spectating` reads "Police"); a watched police car that is put away hands
the camera to the next car.

## Aggression (`ai-aggression.ts`)
The setup slider is the field's **maximum**. Each rival rolls `fieldAggression(max, seed, id)`,
uniform in [0, max]; a new race rolls again (the director bumps its seed per field). In a campaign the
rolls are made once and stored on `CampaignRow.aggression`, re-applied every round.
`mood(a, self, other) = a ≤ 0 ? −1 : 2a − 1 + 0.8(other − self) − (1 − a)·self` (damage 0 mint … 1 dead):
0 never attacks and gives way; 1 attacks whatever its own state; 0.5 attacks only a car more wrecked
than itself, less willingly the more wrecked it is. The race AI splits it into `fight = clamp(mood, 0,
1)` and `shy = clamp(−mood, 0, 1)`; every contact move scales with `fight`, so a field's contact grows
with its aggression, and `shy` keeps a clean driver off other cars (aggression 0: fight 0, shy 1). The
derby AI uses the same two functions with its own thresholds.

**Contact guard** (`ai/contact-guard.ts` `guardContact`, the last step of `RaceBrain.think` for racers; police share the line
brain but are not guarded). Of the racers and traffic (not police) except the rivals the driver means to hit (`fight > 0`), the
soonest contact within 1.5 s is found by following the guarded car round the arc its steer asks for and every other car in the
line it drives, each wearing a car-shaped zone (2.4 × 6 m half-axes). The other car keeps its heading and sheds speed at the
racing plan's own braking budget (`PLAN_BRAKE` × the class brake: a car ahead brakes for what it sees up the road as the plan
does). The contact is steered clear of (at most 0.35 of full lock) and every contact ahead that sideways room (6 m/s²) cannot
clear is braked for at the deceleration that takes the closing speed down to a nudge (1.5 m/s, under the derby's `hitSpeed` 2) in
the time left, counting on 0.72 of the class brake. A car under a nudge's speed is left to the plan. The guard keeps no state:
it reads the cars' snapshots and the `hit` flags `line()` refreshes on every call, so a replay that restores the brain drives
what the live race drove.

**Aggression 0.5: aggressive only when safe** (`RaceBrain.safeShove`, `line()`). A driver with aggression up to 0.5 (`CAREFUL`) fights a
rival only while the shove is safe, and then takes it: the shove adds `SAFE_SHOVE` (0.25) to its mood (so aggression 0.5 shoves a
safe rival, and one under 0.375 never fights), and an unsafe one is vetoed (`min(mood, 0)`, even a wrecked target). Safe means the
rival is within reach (up to `HUNT` m ahead, 11 m behind, 5 m aside) and: the cars' speeds along the road and the sideways speed they
close at (`2 × SHOVE_LAT`, the rival may be shoving as well) come to under the derby's `hitSpeed` 2 m/s, a shove not a ram; at least
2.5 m of road beyond the rival on the side it is pushed to; and not over a crest (`crestSpeed` under the cars' speed). A careful
shove swings the driver's lane over at no more than `SHOVE_LAT` (0.5 m/s), so the two close at a nudge. Above 0.5 `mood` alone
decides (1.0 rams regardless). Aggression 0 never fights (`mood` −1), so its drivers keep every guard.

Measured with `world/race-contact.test-util.ts`: a **hit** is a racer-racer contact closing at ≥ 2 m/s where exactly one car's own
velocity toward the other (≥ 0.5 m/s, not knocked by another contact in the 0.5 s before) closed it (`initiated`; the other is
`suffered`); both closing is `converging`, neither `none`. `race-contact.test.ts` checks the classifier on seven hand-checked
contacts and that an aggression-0 field has no hit on oval/rally/city/stunt with 4 and 7 rivals. Over 4 courses × 8 seeds × 2 laps
(main → this branch) the racer-racer hits at slider 0 went 16 → 0 (4 rivals) and 80 → 0 (7 rivals), at 0.25 from 31 / 41 to 0 / 0,
at 0.5 from 25 / 47 to 1 / 3. Deliberate contacts (`fight > 0` toward the car hit): at 0.5, 4 / 4 on main (2 / 2 closing at 2 m/s or more,
median 12 / 8 m/s) → 0 / 6 (4 / 7 rivals; 5 of the 6 closing under 2 m/s). The careful drivers do attack: at 0.5 with 4 rivals they hold a
fight 2022 driver-seconds over 32 races (1433 onsets), but a 0.5 m/s sideways lean rarely closes a lane's gap, hence the few contacts;
`SHOVE_LAT` is the knob (0.8 gives 3 / 7 deliberate contacts, none / one at 2 m/s or more, with the along-road budget cut from 1.7 to
1.2 m/s). At 1.0 (rams, unchanged by the gate) 310 / 676 of the contacts are deliberate: 140 / 370 close at 2 m/s or more, 75 / 116 are
near a wall, 2 / 3 on a crest.

Limits (measured, not fixed): the other car is not modelled turning, so two cars cornering side by side can read as a contact
the guard steers away from (it fought a left-hand corner into the outer wall on oval seed 2 before the other car's braking was
modelled), and the guarded car's own arc holds its steer for the whole 1.5 s although a pursuit steer decays as the car aligns.
Both are errors of a few metres at the end of the horizon, so a guard result on one seed is one draw: the city's first corner at
the default slider still wrecks 5 of 24 races within 10 s (main: 17 of 24), and each constant tried (`lead` 8, 10, 12 m/s², the
plan's budget of 11–14) leaves a different single seed of the race-start, contact and police suites red or green.

Cost: the guard works the guarded car's arc out once and skips cars its zone cannot reach in 1.5 s (centres further apart than the
zone plus the two speeds added), with outputs bit-identical to the version that walked every pair (194k drive calls compared).

## Campaign
`CAMPAIGN = ["oval", "rally", "city", "stunt"]`. Points 10, 8, 6, 5, 4, 3, 2, 1 for places 1–8.
Standings: points, wins, the better place in the latest round, entry order. Round 1's grid is the
entry order (player last); later grids are the standings, leader on pole. Results → Standings
(records the round) → Next round. Retry re-runs a round without scoring it.
A Watch campaign is the same campaign with an all-AI field: each round starts in spectate mode on
pole, rounds advance with Next, standings and the champion show as usual. Nothing is saved: a
campaign lives only in the running page (no storage, Menu clears it), spectator or not.

## Controller slots and multiplayer
Slots `player | ai | remote`. `RaceDirector.drive` picks each car's `DriveInput`: player → this
browser's `DriverSeat`, ai → `RaceBrain.think`, remote → `setRemoteInput(carId, input)` (held between
packets); traffic → `TrafficBrain`. The rules see only `CarPose`s. `RaceSession.snapshot()` /
`restore()` round-trip the full state as JSON (`RaceDirector.snapshot()` / `applySnapshot()` for a host
and clients); `Campaign` likewise. The HUD reads `RaceHud` and sends `RaceCommand`s.

## Your name and car
Setup rows **Name** (text, ≤ 16 characters, empty = "You") and **Car** (one button per `DRIVER_CARS`
entry: every vehicle class on its own body, then every other body style on the class it drives as —
Sedan, Muscle, Truck, Monster, Hatchback, Wagon today; a new class or style appears by itself). The
HUD keeps both in localStorage (`useDriver`: `crush.driver.name`, `crush.driver.car`) and `CrashLab`
sends them to `CrashEngine.setDriver` at boot and on every change: the name becomes
`RaceDirector.playerName` (cleaned by `cleanName`), the car rebuilds slot 0 (class and body) and
re-parks the grid. The player's row on the standings, results and campaign table shows the name (the
`you` highlight is still `kind === "player"`). Netplay: a client's hello carries its name, so the host
seats it under that name, and every peer sees every chosen name (docs/MULTIPLAYER.md). A peer's car
type does not travel: its seat keeps the host's fleet car for that slot. Touch: every row is ≥ 44 px
tall, the name field uses 16 px text so phones don't zoom on focus, and the menu's arrow keys leave a
focused text field its caret and space.

## AI (`RaceBrain`)
Deterministic, allocation-free, memory per car id; figures per car class (`setClass(id, classStats(…))`:
top speed, brake, full-lock yaw, lateral grip, boost top).
- Pace: the traffic distances below (scan 18 m, following gap 9 m, hunt 25 m) were tuned at 18 m/s;
  above it they stretch × `pace = v / 18`, so they hold the same time ahead at 200 km/h.
- Line: inside of the next turn plus a personal offset; lanes change at 3.2 m/s, up to twice that in a
  shove or block (× `1 + fight`).
- Rivals, only at racing pace (both cars rolling at ≥ 5 m/s; two hungry cars that met slow once
  brawled on a wall until both were out): ram a slower rival on our line (and boost into it);
  late-block a rival coming through from behind; shove a rival alongside door to door; hunt a rival
  up to 25 m × pace ahead and 5 m sideways, onto its line to push it or, with fight > 0.3, offset 1 m
  for a PIT tap at its rear quarter and a door-to-door shove, boosting to catch it. Clean drivers give
  a car coming through room and shy away from one alongside, both × `shy`.
- Following: behind a car on our line at our own pace (≥ 3 m/s) a driver keeps a gap of
  `9 m × pace × (0.4 + 0.6·shy)` centre to centre, matching its speed at the gap's edge and slower
  inside it; boost used to put a clean driver's nose on a rival's bumper for 20 s at a time, and a
  fixed 9 m gap (0.25 s at 130 km/h) let clean fields rear-end each other.
- Pursuit: a point `Ld = clamp(5 + 0.5 v, 7, 18)` m ahead; `ω = 2 v sin α / Ld`; steer = ω / (class
  full-lock yaw × `0.35 + 0.65·min(1, v/8)` × steer grip) — the same yaw model as `applyDrive`.
- Speed: over braking reach + 12 m, `√(v_corner² + 2·a·d)`, `a` = half the class brake,
  `v_corner = cornerSpeed(class, 0.8 / |κ|, surface grip)` (vehicle-classes.ts: the least of top
  speed, `√(grip·r)` at `HANDLING.realism` and full-lock yaw × steer grip × r — every turn planned
  as if 20 % tighter, so a fifth of both the yaw rate and the lateral grip stays in hand) capped at
  the surface's top speed. At 200 km/h the yaw term alone let cars into every corner faster than
  `applyDrive`'s lateral grip cap carries them. Throttle asks for that speed itself (`applyDrive` runs
  up to throttle × top at the class's gear rate), so a rival reaches the same top speed as a player
  flat out. Over a crest the speed is also capped at `√(g/κ_v)`, κ_v the road's vertical curvature
  over ±6 m (`crestSpeed`): above it the road falls away faster than gravity pulls the car down, and a
  car in the air can neither steer nor brake for the bend after it (stunt's kicker).
- Junctions: a shortcut leaves and rejoins the loop at an angle (26°–106° on the four courses) that
  neither path's curvature shows. Both are planned as corners turning that angle over the pursuit's
  18 m look-ahead (`0.8 · 18 / angle` m radius on the shortcut's surface): the mouth from the run in
  to it while short of it, the end from the shortcut's last heading onto the loop. Unplanned, cars
  reached them at 130 km/h, ran off the shortcut, missed its gates and lost the lap.
- Boost: the player's meter rules per car (`BOOST.full` drain, `BOOST.recharge` refill). A burst starts
  on a half-full meter, on a clear run (no car to follow), pointed down the line, while the plan at the
  boosted top (`boostTop`) still wants 2 m/s more than the car has: boost pulls harder (`boostAccel`),
  so it fires out of corners as well as on the straights.
- A slower car on our line: pass on the side with room; until clear of it sideways close no faster
  than `0.8 m/s per m` beyond 7 m (`PASS_NOSE`, over a car length and a half; 2 m/s at least beyond it
  so a pass never stalls, and inside it the nose drops back), which stopped a clean pass at boost speed
  side-swiping the car it went round. A stopped or crawling car (< 3 m/s) is just driven round. No
  room: follow its speed. A car met head-on is seen at `(v_self − v_other)/18` × the scan and swerved
  round at three times the lane rate (a city street's oncoming traffic).
- Abreast: two rolling racers within 6.5 m lengthwise (`ABREAST`) keep their lanes 3.3 m apart, each on
  the side it is on. The grid's two files (4 m stagger, 3–5 m off the middle) all steered for the racing
  line and met nose to tail there: at the default slider 3–5 of 6 stunt cars were wrecks within 10 s of
  the green light (2–4 of 6 on the other courses), now none (`race-start.test.ts`).
- Shortcuts: a seeded coin per car, lap and shortcut (0.3 + 0.4·aggression); heads for the mouth. A car
  with another racer within 12 m when the coin is tossed stays on the loop (a narrow mouth crosses its
  neighbours' lanes). On a shortcut only the following gap applies (the line is its middle).
- Unstick: throttle without motion → reverse with the nose swinging toward the line.

## Traffic (`TrafficBrain`)
Cars fill the race loop's lanes (`traffic.count`), then each side street (`routes[].count`), lanes
round-robin. Each cruises its lane at `traffic.speed`, slows for curvature, stops 7 m short of
anything in its lane (√(8·gap) profile) and after 2.5 s stopped edges round for 4.5 s: toward the
road centre past a car going its way, or 1.5 m toward its own kerb past a car facing it (edging toward
the centre put an oncoming car back across a racer met head-on, and the two held each other nose to
nose until the racer was DNF). Side streets
cross the race loop at grade, so racers meet cross traffic that does not stop for them (T-bones).
Observer bubble (every racer still on track is an observer; checked every 0.25 s): a traffic car
farther than 120 m from all of them, dead for 6 s, or off the end of an open street is put away
(hidden, parked off the world, no AI, no contacts); a put-away car wakes on its lane 55–100 m from
the nearest observer, 14 m clear of every car, and never inside the local camera's view.

## Police chase (`PoliceBrain`)
Setup "Police: Off / Chase" (`RaceOptions.police`, off by default; a tap toggles it on touch). The
director gives the police their own car slots after the racers and traffic (`policeFrom`, up to
`POLICE_CAP` = 6 and the free slots), built as CarAssets' police cruiser (`"police"` body and class);
they are never entrants, so rules, standings and results never see them, and a race with police
off builds none (police-off race digests equal main's: oval / rally / city / stunt, seeds 1–2).
- Stakeouts: from a third of the leader's first lap, every 6–16 s a pack of 2 parks on the run-off
  90–140 m ahead of a random racer still racing, either side, out of the local camera's view, nosed
  toward the road; the second car faces the oncoming racers.
- Wake: each unit stays parked until a racer's road progress passes its own spot (by under 30 m, so
  a car arriving a patrol beat late still counts; or a knock) and then joins its pack's pursuit (the
  first unit passed sets the target): no unit moves before someone has driven past it.
- Lead-in (2 s): full throttle along the road toward where the target is heading (the centreline
  1 s of its speed ahead of it, at most 1 s of the unit's own speed and at least 20 m ahead of the
  unit), its aim blended in from its own heading over the first second; a unit facing back against
  the traffic turns round at full lock and half throttle. It never steers at the target's side, so
  it falls in behind it instead of T-boning it from the run-off.
- Pursuit: sirens on (`setSirens`, sent to netplay clients in the car frame's flags), the racing line
  at aggression 1 with unlimited boost to catch up. Within 35 m on the same stretch it attacks by
  place in the pack: PIT from the rear quarter, door slams, getting ahead to block and brake-check.
  Ahead of its target a unit pulls out into its path 1.6 s before it arrives; one facing it rams it
  head-on from 3 s off (the main source of takedowns: closing speeds up to 60–70 m/s). Wedged, it
  backs off for another run.
- Pack guard (`ai/pack-guard.ts` `guardMates`, the last step of `PoliceBrain.think` and `HunterBrain.think`, so race police and
  Survival's cops share it): of the pack-mates, the one a car reaches soonest within 3 s (relative motion; a mate at a standstill
  is read as pulling out at 8 m/s along its nose, as the car itself is) is steered away from, to the side it passes on, and
  braked for within 1.5 s when ahead. A stakeout pair parks 12 m apart, one car facing each racer's travel and one against it,
  and both used to wake at full throttle into a head-on. Measured (2-lap races, 4 AI + the AI-driven slot, police on, seeds
  1-12, oval / rally / city / stunt, a lead-in being the 2 s after a wake): lead-ins that touched a pack-mate 181 → 22 of
  398 → 395; two cops touching while both were in their lead-ins 76 → 2 (oval 23 → 0, closing 17-25 m/s); oval lead-ins
  that touched no pack-mate and ended converging on their racer 25 of 72 → 57 of 74. Over seeds 1-5 (the sweep above): cop
  contacts with racers 88595 → 94424 (physics steps in contact), takedowns 1 → 2, police knocked out 21 → 12, winner times
  within 0.6 s per course. What remains is a car pulling out of its stakeout in front of a mate already past 30 m/s.
- Packs build: 5 s sustained within 45 m calls one more car (parked 70 m ahead out of view, else
  coming up from 70 m behind already chasing), up to 5.
- Stand-down: a target that finishes, dies or respawns (left alone 4 s) hands the pack to another
  racer within 45 m, else the pack gives up, as it does after 160 m off for 4 s or 40 s of pursuit.
  Given-up units drive off and are put away out of view (or after 20 s); a knocked-out unit (dead
  drivetrain or upside down) after 6 s; a stakeout nobody came near after 45 s.
- Busted (`BUST`, `RaceSession`): a racing car (player, AI or netplay peer; the host decides) held under
  20 km/h within 20 m of a unit that is chasing (`PoliceBrain.chasers`: in pursuit with a pack; never a
  parked stakeout, a knocked-out wreck or a unit driving off) for more than 4 s in a row is out the way a
  DNF is: `dnf`, or `out` in a no-reset race. `CarRecord.stopped` / `bustedAt` ride the race snapshot to
  peers (no `NET_VERSION` bump); results show "Busted". The busted player gets a BUSTED banner
  (`race-busted.tsx`) for 2.5 s of race time, then the camera follows the leader as after a DNF.
  Measured (the sweep below, police on, seeds 1–5 × oval / rally / city / stunt): 0 busts in 20 races;
  the longest stop beside a chasing unit was 3.9 s (city seed 2).
- Durability: an AI unit's class has durability ×1.3: +16 % kill travel over the sedan at the default
  realism (0.45 → 0.52 m), +14.5 % at the arcade end (`KILL_CEILING`), +30 % at the realistic end. A
  player who picks the Police car (slot 0) keeps the sedan's (`killClass`).

Measured (`police-sweep.mts`: 4 AI + the AI-driven slot, 2 laps, slider 0.35, seeds 1–5; "contacts"
counts physical police↔racer contacts a pair apart ≥ 0.5 s, a takedown is a racer death ≤ 3 s after
one). Every race closed within the finish sweep's bound, at both the 65 km/h drive and the 200 km/h
one (lane/drive-speed). Per course, 5 seeds, 200 km/h:

| course | pursuits | largest pack | contacts | takedowns | police knocked out |
|---|---|---|---|---|---|
| oval | 2 | 4–5 | 22–52 | 6 | 1 |
| rally | 2–4 | 4–5 | 12–46 | 0 | 0 |
| city | 2–4 | 4–5 | 22–41 | 5 | 4 |
| stunt | 3–4 | 4 | 22–36 | 6 | 7 |

At 65 km/h: takedowns oval 6, rally 1, city 8, stunt 3; police knocked out 5 / 0 / 3 / 3.

Waking on the pass and leading in from behind (same sweep, main ab458a2 → this rule, per course over
seeds 1–5): pursuits oval 10 → 15, rally 11 → 12, city 17 → 14, stunt 17 → 17; police contacts
89 → 38, 127 → 86, 163 → 169, 151 → 99; takedowns 4 → 0, 1 → 0, 5 → 1, 5 → 0; police knocked out
1 → 0, 0 → 0, 4 → 2, 3 → 1; largest pack on the oval 4–5 → 2 (elsewhere 3–5). The packs now chase
from behind, so the head-on rams from a stakeout facing the racers, which caused most takedowns,
no longer happen; the attacks after the lead-in (PIT, slams, blocks, rams once ahead) are unchanged.
Every race closed; police-off digests are identical to main.

Browser frame cost, city, Watch, 7 AI + our car, 30 s windows once ≥ 3 police are out (police off:
the same race time), two rounds: CrashEngine tick mean 6.59 / 6.50 ms off, 7.72 / 7.95 ms on (p99
13.9 / 14.3 vs 15.4 / 16.0 ms; 20 cars vs 25–26). The first build with 8 police cost 3.7 ms more per
tick (5.65 vs 9.31 ms) and 66 of 1628 frames over 33 ms against 1, hence the cap of 6.

## Drafting (`DRAFT`, `RaceSession`)
A racing car 2–15 m straight behind another racing car (measured along the leader's travel), within
1.5 m of its line, both doing over 15 m/s (54 km/h) that way, is drafting (`CarRecord.draft`: unbroken
seconds of it). Every 2 s of it unbroken adds 5 % to that car's boost meter (`CarRecord.drafts` counts
the bonuses; the director puts each on the meter once: the seat's for our car, `RaceBrain`'s for an AI,
and a netplay peer's own client does it for its seat from the snapshot). While drafting, the car's top
speed is ×1.02 (`applyDrive`'s `topScale`; the thrust is unchanged). Players and AI share the one rule;
it lives in the race rules, so fleet and derby never see it, and netplay peers get it through the host's
snapshot. The HUD shows a small "Draft" tag beside the boost meter while you draft.

Numbers by feel and measurement: 2 m keeps a bumper-to-bumper shove out, 15 m is about 0.35 s at
top speed; ±1.5 m is a car width; 5 % per 2 s is a full meter after 40 s glued to a bumper, about a
ninth of the meter's own refill (empty to full in 4.5 s), so it tops up rather than replaces it; ×1.02 is 4 km/h at 200 km/h:
a slow close on the car ahead down a straight.

Measured (`laps.mts`: 4 AI + the AI-driven slot, 2 laps, seeds 1–5, main ab458a2 → drafting): bonuses
per race (all 5 cars) oval 10.0 / 10.8 (slider 0.35 / 1), rally 7.6 / 18.8, city 4.0 / 7.0, stunt
6.2 / 17.2. Mean lap s, slider 0.35: oval 18.61 → 18.54, rally 29.10 → 29.12, city 31.66 → 30.47,
stunt 30.94 → 30.70; slider 1: 18.78 → 18.69, 29.24 → 29.13, 30.32 → 29.00, 31.16 → 30.74. Mean winner
time moved under 1 s on every course; every car finished all 40 races both ways.

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
streets) is stamped, nearest centreline winning, except that a side path's blend skirt never replaces the
main loop's road or runoff and eases back to the main loop's field, not the bare terrain, and a side path's
height is the main loop's on its road + runoff and eases back to its own grade over `MEET` (8 m) beyond it
(rally's mouths and ford left 0.25–0.35 m lips in the runoff; `course-intrusion.test.ts` holds every road +
runoff to its bank + 0.05 m per 0.5 m across); deck spans are skipped (their ends are rounded abutments) and answered
analytically from the path at its own height, so a bridge and the road under it coexist. On the main loop's road +
runoff `world/road-crease.ts` interpolates the road's centre height, lateral and edge drop instead of heights and
clamps the lateral at the point, so the crease where a bank meets the flat runoff stays sharp (the bilinear field
rounded it 8 cm above the plane on stunt's 18° bank; `bank-wheels.test.ts` holds it to 1 cm); on a level road it is
the plain bilinear to the bit. The drawn road's sections close up where the bank turns (`sections`: a twisted quad's
diagonal ≤ 2 cm off the road; 6.9 cm on stunt's bank run-out at 4 m).
Who reads it: driven cars (`car.ts` integrate: ride the ground, pitched and rolled onto its normal under the
origin and held there between slices (`ramp.test.ts`: 4 tyres on a 10–30° wedge, every heading); where it falls away faster than
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
One file per course in `src/game/world/tracks/`, registered in `tracks/index.ts`. `parseTrack` (zod)
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
| `shortcuts[]` | `{ id, from, to, width = 7, surface = "dirt", path: [{x, z, y?}] }` | designed route; open the main walls at its mouths. Its end points take the main road's surface height there (banked plane, flat over the runoff); an authored end `y` is ignored |
| `grid` | `{ perRow = 2, spacing = 8, back = 6 }` | staggered slots behind the line |
| `props[]` | `{ prefab, x, z, yaw = 0, scale = 1, size? }` | placed prefabs |
| `along[]` | `{ prefab, every, side = "both", offset = 1.5, fromNode?, toNode?, route?, scale = 1 }` | repeated beside the wall line (or along side street `route`); copies on any road are skipped, and so is any non-knock copy whose drawn footprint a bend turns onto its own road or runoff (the lot inside a corner stays empty). `course-intrusion.test.ts` holds every course to ≤ 0.1 m |
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
Focus view (default): race readouts for the HUD car (`RaceHud.view`: the driven car, or the watched car while
spectating, so spectate shows what that driver sees): P3/8, Lap 2/3, race / lap / last / best, the split,
and the gauge (speed, gear from `gearAt`, the segmented boost meter, lit while burning, with a "Draft" tag
while drafting). The boost meter shows where this browser holds it (our seat, or the AI on a host / offline
race); a peer's car and police have none, and a watched police car shows only the gauge. The gauge sits
under the readouts (top right), or in the bottom-right corner on a wide screen without a touch pad, as in
NFS and Burnout. The HUD republishes at ~8 Hz (`engine.ts` `hudAcc`), never per frame. Standings
(names are spectate buttons), start lights with 3·2·1·GO, WRONG WAY, respawn countdown, finish card,
spectate bar, and one "Full menu" button (H). Full view adds the sandbox title, settings panel, drive
card and dock (first item "Race view"). Modal menus: setup (course cards, Name, Car, You: Drive / Watch, laps
1–5, AI cars 1–15, max aggression with its hint, respawn / no reset, Police Off / Chase, Start race, Campaign, Back), pause (Resume,
Restart, End race, Full menu / Race view, Quit to menu), dead, results (Next course / Standings,
Retry, Menu), campaign standings (Next round / champion, Menu). D-pad / left stick move focus
spatially (350 ms then 120 ms repeat), ←/→ adjust, A confirms, B backs out, Start resumes. Campaign results
and standings have no Back (B / Esc would drop the unrecorded round): Menu leaves, and clears the campaign.

## Tests
`track.test.ts` (every course compiles, gates, grid, walls, ground, bridge layers, crossing rules),
`session.test.ts` (countdown, laps, cuts and the `missed` flag, line farming, shortcuts incl. the
oval infield beside / across the service road, wrong way, positions, respawn placement, no-reset
survival, snapshots, DNF, the chequered flag and finish deadlines, campaign, drafting: one bonus per
2 s held in a leader's trail and none for the leader; none off its line, too far back or too close,
under the speed floor, or on a broken run), `vehicle-classes.test.ts` (also: a draft's `topScale`
lifts flat-out speed by exactly that share only while it is passed), `race-ai.test.ts` (8
clean AI cars finish 3 laps on every course on the road ≥ 95 %, ram / block / follow, boost, the
aggression model), `traffic.test.ts` (lanes, junction crossings, stop and edge round, bubble
wake-up), `placements.test.ts`, `menu-nav.test.ts`, and the real stack headless (director, real cars
and classes, `applyDrive`, the engine's fixed-step contact order, traffic; helpers in
`race-world.test-util.ts`):
- `race-finish.test.ts`, every course: 4 AI rivals plus the AI-driven player slot, 2 laps;
  results within the grid + 2 laps at 3 × the reference lap (course length at 9 m/s) with ≥ 4 of 5
  home on full distance or out. Run k races with field seed k (`RaceDirector.reseed`), so each run
  rolls its own rival aggressions through the start command, as a player's race does; grid, classes
  and body styles are fixed by car index in a single race. 2 seeds at the default slider by default;
  `RACE_FINISH_RUNS=5` runs 5 seeds at the default slider and 5 more with the slider at 1 (a ramming
  field: rivals roll up to 1).
- `race-finish.test.ts` also: a 1-lap oval race closes on laps with every car home on lap 1, placed
  and gapped by finish time; a Watch race (all-AI field, camera on pole, cycling reaches all five
  cars, closes with no You row) and a Watch campaign (all-AI standings).
- `race-finish.test.ts` police chase: a Watch oval race with police on closes; parked police cars
  show no sirens and chasing ones do; cycling reaches a police car ("Police" on the spectate bar);
  at least one pursuit; no police car is in the results. A second oval race checks that no parked
  unit pulls away before a racer is past its spot (unless knocked), that over each lead-in no other
  car knocked (at least 3) the angle between the unit's velocity and its target's (where the target drove that stretch) shrinks,
  that no contact with its target in the lead-in is a T-bone (normal across the target's flank with
  the unit crossways), and that the pursuit after it still makes contact.
- `race-player.test.ts`: the PLAYER slot driven through the real seat (analog wheel and gas) on the
  oval, 2 laps, 3 AI — on the high line, the apron, with a respawn press, on the grass beside the
  service road and straight across the infield (detours driven at up to 15 m/s, braking for them from
  40 m before, as a player would). The player finishes on the AI's lap count, and the
  HUD's lap and place equal a rules snapshot at every sample.
