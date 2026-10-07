# Crash highlights

When a race ends, its biggest crashes replay behind the results sheet: a far-overhead flight into each clip, then
seeded shots and the crash cam over the hit. Every netplay peer shows the same frames at the same moment. **Watch**
plays one clip alone with no HUD; **Save** keeps it in this browser.

## Modules

| File | Role |
|---|---|
| `match/highlights.ts` | `HighlightLedger`: impacts grouped into clusters, scored, the best `TOP` (5) kept. Numbers only. |
| `engine/engine-record.ts` | `CrashRecorder`, host or offline: the input ring, the keyframe ring, impacts into the ledger, clips cut out of the rings. |
| `engine/engine-replay.ts` | `ClipSim`: one clip re-run through the real sim. |
| `engine/engine-highlights.ts` | `ReelDirector`: the reel's loop, its timeline, its shots, the solo view. |
| `engine/engine-reel.ts` | `EngineReel`, the engine layer: starts and sends the reel, its HUD commands, saved-clip play. |
| `present/highlight-cam.ts` | `overheadPose`: the flight between clips. |
| `present/shot-cam.ts` | `pickShot`, `ShotCam`: which shot comes next and how it is posed (the reel and the Auto cam share it). |
| `present/auto-cam.ts` | `AutoCam`: the spectator "Auto" camera, the reel's shot director run live on the watched car. |
| `present/auto-fx.ts` | `hardwareDesktop`, `AutoFx`: the automatic FX tier the reel runs on (docs/CINEMATIC.md). |
| `present/frame-work.ts` | `FrameWork`: the window both quality governors read (median main-thread ms and GPU ms against the 60 fps budget). |
| `present/gpu-timer.ts` | `GpuTimer`: the draw's GPU time from `EXT_disjoint_timer_query_webgl2` (none where the browser lacks it). |
| `net/reel-codec.ts` | One byte layout for a clip on the wire (`MSG.reel`) and in storage. |
| `engine/highlight-store.ts` | Saved clips in `localStorage`. |

## Recording

`CrashRecorder` runs on the host (or offline), never on a client. Per fixed step it writes every car's drive output
(`INPUT_BYTES`, 4 per car), the step's dt and the schedule the world ran it on (`World.shape`: slice count and SAT passes)
into a typed-array ring of `RING` (5120) steps, at least 17 s at a race's
240–300 steps/s. Every `KEY_EVERY` (1 s) it encodes a keyframe: the netplay snapshot of every car (`writeSnapshot`,
with each wreck's deform and parts), the course's knocked props (a bit each), then per car its flight block
(`DeformableCar.flight`: `FLIGHT` doubles, the airborne and hull-contact flags, the whole spin, the takeoff spin, pitch,
yaw, roll, velocity and position, the squeeze clocks, the drift state), the course's memory of it (`MEMORY` doubles: where
the wall contact last stood, how far past the line, the road segment the projection hint is on) and, for a wreck, its
solver state (`simState`: every scalar such as the crash clocks, each sensor's compression, each mass's position, velocity
and crush offsets, each beam's set, each shape cluster's plastic rest and fit state) with its parts' state (`partState`:
`PART_STATE` doubles, the door swings' angle, rate and load, the hinge values, wind wear and the door-motion sample). A
step in which a car is put on a spot (a respawn, a police wake or put-away, a start: `DeformableCar.placements` moved)
takes one more at once, because the replay cannot drive a car there. A clip keeps **the keyframe it starts at, with every
car of the clip, and one more per later step that put some of its cars on a spot, with those cars alone** (`cutKey`).
Nothing else is kept: the replay is the sim that recorded it (docs below), so a keyframe in between would correct nothing
and cost a wreck's 6.2 KB solver state each. A wreck is 1559 words (6.2 KB) in the first keyframe, 2.2 KB deflated while
it moves (measured on the stunt clips: the clusters' fit state 1.2 KB of that, the masses 0.6, the arrays and scalars 0.4),
and a car put on a spot is some 400 bytes.

An impact is any contact (car–car, wall or prop) closing at `IMPACT_MIN` (12.5 m/s, 45 km/h) or more, whose pair had been
apart for `REHIT_S` (0.35 s), so grinding never re-counts. 12.5 m/s is the speed at which a lone sedan head-on reaches `MIN_SCORE`: a slower bump could only join a cluster and lift its car count and score (owner 10-05: "multi car pileups are just slow bumps"). Measured on 192 races (city, oval with police, breaker-yard, dam-spine, seeds 1-48): the old 5 m/s floor kept 81 of 150 oval-police clips as 3+-car pile-ups, 34 of them (and 8 of 9 on the city) only through bumps under 12 m/s; 49 of 56 city "pile-up" titles had two cars hit (the title counted the bystanders in the shot). The title now counts the cars hit (`HighlightClip.hit`, ≥ 3 for "N-car pile-up"). Impacts join an open cluster that shares
a car or lies within 30 m. A cluster closes after `QUIET_GAP` (1.5 s) with no impact, or when it spans `MAX_SPAN` (6 s).
Its score is energy, plus points per extra car, per engine destroyed and for impact density, each impact weighed by its
force: `impactWeight(closing)` = closing speed over 50 km/h (×1 at 50, ×2 at 100, ×0.4 at 20), so hard hits count for
more and taps for less (a 100 km/h head-on scores 15.4, a 50 km/h one 3.65, a 20 km/h bump 1.0). A cluster below
`MIN_SCORE` (3) is dropped. A clip is `PRE_ROLL` (3 s) before the first impact to `POST_ROLL` (3 s) after the last.

A moment needs a racer. Traffic and police score only against one (`CrashRecorder.begin`'s `racers`): cop–cop,
traffic–traffic, cop–traffic and a lone cop or traffic wall hit make no impact, and a traffic or police car's death
counts only inside a cluster a racer's hit opened. A racer hitting (or hit by) a cop or a traffic car scores as before,
with that car in the shot, and the clip's focus is the racer. On the city seeds 5 and 6 (8 AI, traffic, police) 2 of 5
and 1 of 5 kept clips had no racer in their first impact (a cop's wall hit, traffic on a cop); after it, 0 of 5 and 0 of
5, with the racer-on-traffic and racer-on-cop hits kept (`engine-record.test.ts`).

When a cluster's post-roll ends and it ranks, its slice is copied out of the rings. That copy is the recorder's only
allocation, a few times a race. Steady state allocates nothing (`engine-record.test`).

A clip also takes **bystanders**: every car within `BYSTANDER_R` (80 m) of its hit (the first impact, the cluster's mean
point or one of its cars) at any keyframe of the clip or at its end, nearest first, each with the cars that touched it
since the clip's start (a touch is a SAT contact, a door, mirror or panel meeting, or masses overlapping). Left out: a car
that did not exist at the clip's first keyframe. A car put on a spot after the first impact is taken like any other (its
keyframe puts it there again). 80 m covers the replay cameras' sight lines (`DUTCH.range` is 90 m): of
the 46 cars a camera could see on five seeded races, 80 m holds 44 and 60 m holds 39. A clip grows by bystanders only to
`CLIP_SHARE` (`REEL_BUDGET` / `TOP` × 3.3 ≈ 158 KiB estimated: a car's inputs plus its 6.2 KB solver state if it is a
wreck in the clip's first keyframe). A bystander too big for what is left is skipped (a cheaper one further out may still
fit), and a pile-up that already fills the share takes none. The recorder's steady-state allocation is 1.2 B a step
against a 16 B bound (`engine-record.test.ts`): `simState` reads a wreck's scalar fields as plain properties (`simScalarsOut`,
`simScalarsIn`; read by name, V8 boxed every double: 1050 B a wreck a keyframe, 46.0 B a step at 11 wrecks, now 48 B a wreck a keyframe).

## Ejections

A driver thrown out of his car (`EjectionWatch`, `vehicle/ejection.ts`: a sim decision, once per fixed step; [RACE_DESIGN.md](RACE_DESIGN.md))
is the biggest moment a crash can hold: `EJECT_POINTS` (24) per driver on top of the impacts' energy (a 100 km/h sedan head-on
scores 15.4, a 4-car pile-up at 100 km/h 24; the softest ejection, a 55 km/h wall hit, 32.5), so a cluster with one ranks and tops the clips without; the first ejected car is
the cluster's subject (`focus`), and the title reads "Driver thrown out". `CrashRecorder.eject` also keeps the event
(`Ejection`: car, pane, torso position in the world and the car's frame, direction, orientation, velocity relative to the
car and the car's own, spin; f32-exact) with the step it happened in (up to 64 a race). A clip carries those of its steps
and cars as `ejections` (`ClipEjection`, `REPLAY_VERSION` 6, with the clip's driver-look seed `look` from 5: `ejects` u8 in the header, then count, and per ejection the step
u32 and `writeEjection`'s bytes). Traffic and police ejections count only inside a cluster a racer's hit opened, like a kill.
A thrown-out driver's car freewheels (`DriveInput.neutral`, flag 8 of the step's input byte), so the replay's recorded drive
output needs nothing else; keyframes carry `driverOut` in the snapshot flags.

`ClipSim` fires each ejection after its step ran (`take()` hands them out with `car` the engine slot), sets `driverOut`, and
the reel launches the dummy from the recorded numbers (`ReelHost.eject`); every driver thrown in the clip's own crash (`ownThrow`: from its first impact on, within 30 m of it) gets the ride-along
camera (`ReelDirector.aim`), over the clip's shots, until every dummy lies still. The ride frames only those drivers (`launch`'s `rides`): another crash's driver thrown faster elsewhere in the clip (a cop wrecking 120 m off) never pulls it away. Two replays of one clip fly the dummy along exactly
the same path (`race-eject-reel.test.ts`); the live dummy and the replay's start from the same point (0 m) but part once
they bounce off replayed cars (a free flight stayed within 0.9 m of the live one over 4 s, one that hit the oncoming car
did not): the launch falls on another frame boundary (up to 1/60 s) and the replayed cars are cm to dm off the live ones.

The replay marks the first hit by the recorder's own rule (`countsAsImpact`: at least `IMPACT_MIN` hard after a
`REHIT_S` quiet spell), so a brush 0.35 s before the recorded impact no longer times it early.

## Replay

`ClipSim` respawns the clip's cars from keyframe 0, wrecks included (dents, lost parts, lamps, glass, then the solver state
and the parts' state). It then feeds each recorded step's dt and drive outputs through `applyDrive`, `stepWorld` and
`settleStep`. A step in which some of the clip's cars were put on a spot (a respawn, a police wake or put-away) puts them
there again from its keyframe; nothing else corrects the replay. It is the sim that recorded it, for every car of the clip
and every step of it. The clip also carries its crumple settings (`squash`, `buckle`, `deformMode`), so every peer dents
the same way.

**Fidelity (`REPLAY_VERSION` 26; `engine/replay-fidelity.test.ts`, `engine/engine-replay.test.ts`, `engine/engine-replay-police.test.ts`).**
A replay is held to the sim that recorded it, step by step over the whole clip and every car in it: position, velocity and
crush errors are all exactly 0, and no car is a wreck in one run and not in the other. The rows are the race and derby
crashes (head-on, offset, T-bone, pile-up and four spawn shifts of the pile-ups, 1e-9 to 1e-3 m), 8 seeded city races of 12
(1-8; `SEEDS=...` runs any others) and the oval race with police, where a cop is woken (parked at a stakeout: it was a
stored car 5.7 km away) and two racers are put head-on beside it (seeds 1-3). The owner's rule: a replay matches the live
crash it recorded. What it takes, each found by the replay straying from the live sim where it was missing:

- **The pedals are what the clip stores** (26). `applyDrive` puts throttle and steer on 1/127 steps and the brake on
  1/255 (`THROTTLE_STEPS`, `BRAKE_STEPS`) before the sim reads them, and the clip's input bytes hold exactly those. Before,
  the sim ran the pedals as doubles and a clip kept them as 8 bits for most cars (and as doubles for the involved cars
  alone, for 2 s after the hit, `fine`): a start-of-race pack drifted 7-17 m in the 3 s before the first keyframe
  corrected it, and a car one pile-up away 20-100 m after the hit. The `fine` block, the drift keyframes, the impact
  keyframe and the smoothing that drew their corrections (`POP_TAU`) are gone with it.
- **A car put on a spot has a keyframe of its own** (26). A cop woken in the clip sat at its stored spot 5.7 km away
  until a later keyframe put it on the road: the clip's budget dropped the intermediate keyframes, the placement's among them
  (the oval race with police and 11 AI, 5 clips: the top clip's cop 15, `CLIP_BUDGET`). A respawn after the first impact had
  no keyframe at all (the replay corrected drift only up to the hit), so the racer stayed a wreck: 18-100 m off. Every later
  keyframe is a placement now, kept whole, with the cars it placed alone.
- **The parts' state as doubles** (26). The netplay part state is float32 on the wire with no rates: a door that a sideswipe
  had left swinging came back at rest, a panel's hinge value rounded, the door-motion sample re-read. A door slows the next
  striker by what it holds (`partContactPair`), so two wrecks one second after a pile-up hit differently (1e-11 m at the
  first contact of a four-car pile-up, 11 m two seconds later). `CarParts.partState` carries them.
- **The car's pose, whole** (8). The flight block (`FLIGHT` 22 doubles) holds pitch, yaw, roll, velocity and position exactly
  (the wire rounds them to 1e-4 rad, 1 cm/s and a float32), the squeeze rule's clocks (`endAgo`, `endReach`, `endSqueeze`) and
  the drift state; the wreck's `squash` and `buckle` are stored as doubles in the clip header.
- **The solver state as doubles** (9). `simState` writes each scalar, and every mass, beam, sensor and cluster number, as a
  double: a restored wreck is bit for bit the live one. It includes the hit vectors (`impactLocal`, `impactInward`), the body
  frame, the ground samples, the shape clusters' fit state (`Rprev`, `rotQ`, warm start) and the clocks (`elapsed`,
  `lastContact`, `lastPower`, `contactAt`, compared by holds of whole steps). A car with a part torn off carries it whether or
  not it crashed: its netplay wreck section alone leaves the hit frame zeroed (`impactInward` (0, 0, 0) for the intact car's (0, 0, -1)).
- **The course's memory** (9, 23). Each keyframe carries per car its wall contact history and road projection hint, and the
  race's knocked props (`RaceField.remember`, `knockTo`): a replay starts from the course the live race had.
- **Props knocked by cars the clip leaves out**. A knocked prop is gone for every car, so a clip car that reaches its place
  finds nothing there in the record. `CrashRecorder.knock` keeps each knock with its step and car; a clip lists those of its
  steps by cars it does not carry (`HighlightClip.knocks`: step u32, prop u16, after the ejections) and the replay knocks the
  prop before that step runs (the clip's own cars knock theirs themselves). Seeds 18, 31 and 64 of the city sweep replayed a wreck 0.1 mm to 0.7 m off without it.
- **The world's step schedule** (23). A step runs 1 to 3 slices of 1 to 3 SAT passes, decided by every car in the world
  (`World.shape`), and a replay of a few cars cannot work them out: the clip carries it (`World.plan`).
- **Masses touching** (23). A car that only pressed its masses or a door on a clip car is in the clip (`touch`, `collideWith`).
- **The engine's step is a float32** (`Math.fround`), which the recorder stores whole, in the engine and the recording harnesses
  alike. Part tearing runs in the fixed step (`Car.stepBreakage`), never per rendered frame, so a replay drawn at another
  rate than the live sim ran does not diverge (`vehicle/render-cadence.test.ts`).

What is left: a car whose parts were disturbed but which is not a wreck (a door a sideswipe left ajar) starts the clip with
closed doors (its net state rides no wreck section); and the engine-to-engine caveat of netplay, below.

**Cost.** `ClipSim` on the race head-on clip (4 cars, 1728 steps): 82.3 us a step. A clip is smaller than before, as it
holds one full keyframe and not three to fifteen: a start-of-race pile-up of 16 cars was 851 KB (1 wreck-filled keyframe per
second) and is 304 KB; the city sweep's clips are 160-230 KB (9-23 cars) where 250-600 KB were cut to fit. A saved clip
of an older version is refused as `version`.

**Drawing.** The sim only has whole recorded steps (1/240 to 1/114 s of clip time), and the reel plays the hit at about
1/30 of that, so most frames land inside a step. Measured on city seeds 5 and 6 (3 clips each, the camera and the focus
car per rendered frame at 60 and 240 Hz): 87–88% of the slow-mo's frames at 60 Hz and 97% at 240 Hz drew the focus car
where the last frame had it, and a car-mounted camera saw 420–470 m/s² (60 Hz) and 6600–7500 m/s² (240 Hz) of second
difference (p99). `advanceTo` therefore runs the step `until` falls in, and `ClipSim.present(until)` draws every car
between the pose before that step and the one it left (a car the step put on a spot, more than `TELEPORT` away, stays
where it landed). The sim's own state is never the drawn one: `advanceTo` puts the
exact state back first, the quaternion as well as the Euler angles (an airborne or falling car's quaternion is the sim's
own, and quaternion to Euler to quaternion is not exact: stunt clips ended 1.1e-12 off at 60 Hz and 2.6e-13 at 240
before; `engine-highlights.test.ts`: a replay with a drawn frame inside every step ends on the same state as one
without, on the city's ramming clip and on every stunt clip). The chase shot read the wreck's own velocity, which swings 4°
and more a frame, so `ClipSim.heading` low-passes it (`foldHeading` in `shot-cam.ts`, over `HEADING_TAU`, 0.3 s, per step;
the Auto cam folds the same heading per frame). Second difference p99:
0 stalled frames; slow-mo 0.1–10 m/s² at 60 Hz and 0.3–5 at 240 Hz; run-in at 60 Hz 310–390 (was 2850–5200) and 21–117
rad/s² of rotation (was 480–490); chase aftermath at 240 Hz 2200–4200 (was 29000–35000).


## The reel

`ReelDirector.play(reel, startAt)` loops [`FLIGHT_S` (3 s) overhead flight → clip] over the reel's clips from
`startAt` (this browser's `performance.now()` seconds). Wall time decides everything: which clip, the clip time, and
the shot. A peer at 45 Hz and one at 60 Hz therefore frame the same camera at the same moment
(`engine-highlights.test.ts`: under 1e-6 m or rad over 200+ moments).

- **Timeline.** `clipTimeline` steps the phase.ts crash clock at a fixed 1/120 s: 1× up to `PRE_IMPACT_LEAD` (0.07 s)
  before the recorded first impact, then the auto slow-mo, held `CONTACT_HOLD` (6.3 wall s) past the cars meeting and
  `THROW_HOLD` (7.3 wall s) past each of the crash's own throws that comes while it runs (owner 2026-10-07: +40 % and 2×
  of the 4.50 s and 3.65 s timed on main), then back to 1× to the clip's end. The reel mirrors it into the engine's
  clock, the clip's hold too (`PhaseClock.hold`), so the letterbox, the HUD and the crash cam behave as in a live crash.
  A race that ends as a driver is thrown (Survival's run-ending throw) would leave his clip no hold, so at "over" the
  recorder runs on (`CrashRecorder.over`) until `THROW_HOLD_SIM` (7.3 × 0.032 = 0.23 s of race) past the last throw,
  then files: every hold plays whole on recorded motion.
- **Stepping.** The replay runs up to 6 ms per frame (`stepBudgetMs`). A frame that falls behind catches up over the
  next ones.
- **Late join.** A peer that reaches a clip more than `JOIN_LATE` (0.25 s) in (a late join, back from the solo view, a
  stalled tab) hovers over it until the next flight instead of replaying seconds in one frame.
- **Cars.** While the reel plays, the engine's own sim is paused. Every car but the clip's is hidden, and all of them
  are restored when the reel stops.

### Cameras

Each clip's shots come from `mulberry32(seed ^ clip)`, so the same seed gives the same shots:

1. an opener at clip time 0;
2. a run-in about a second before the hit;
3. the aftermath, once the crash cam hands back (`crashCamEnd` of the clip's hold).

A shot is one of: chase (behind the car along its travel), trackside cinematic (`CineCam.pick`, searched in full when
the shot starts, so the pick depends only on the poses and the seed), wheel-well dutch (`DutchCam.place` on a seeded
mount) or a high static eye 22 m off the crash (the seeded angle, else the first eighth-turn from it whose eye is clear
and sees the car). The shot picking and posing is `present/shot-cam.ts` (`pickShot`, `ShotCam`), shared with the Auto
spectator cam (`present/auto-cam.ts`: the same kinds and pool order run live on the watched car). Every searched spot
(trackside, high, each crash-cam eye) must pass `camUsable` (`present/spectate-cam.ts`): 2 m of room round it
(`clearSpot`: 12 flat samples, one up, one down) and a clear sight line to the car now and over the next seconds. Each
shot is framed from the car as it stands at the shot's own clip time. The crash cam
(`beginCinematic(..., crashCam = true)`) takes the hit itself, as it does in a sandbox crash. On a course, and in the
sandbox (lamp posts, barrier, balls: `sceneSight`), it stands on the ground at the hit and turns its axis (`crashAxis`: as
hit, reversed, the quarter turns) to the one whose three cut eyes see the hit from furthest out, pulling an eye in toward
the hit (no closer than 3 m) when a wall is in the way. A cut with no usable eye is left to the chase / reel camera.
An eye counts as usable only if it passes `camUsable` at 9 times from its cut's start to its end (`CUT_SAMPLES`): the eye
pans (long lens), creeps (bumper) and turns (crane) through its cut, and a pick made at the middle alone let eyes drift
into a wall or behind a corner at either end (tested at 17 times: 36 of 549 eyes on rally, 75 of 432 city, 61 of 761 stunt,
0 on oval; now 0, 0, 0 and 1 of 730). `solid` no longer projects each point onto the road from the last query's segment: where
stunt's course crosses itself that left the walls of the wrong road in charge (1 of 544 eyes read differently by what was asked
before). `Sight.grid` (`roadGrid`,
8 m cells over the course) names, per cell, a path sample on each stretch of road near it (up to 3), and `solid` projects from those
windows: a trackside pick costs what it did (0.40 / 0.59 / 0.48 / 0.41 ms mean on oval / rally / city / stunt; 0.44 / 0.62 / 0.50
/ 0.41 before), and the grid builds in about the time `raceSight` already took.
The crash cam's pick is `CrashPick`, a search that runs over the lead-in before the first cut (`CUTS[0]`, 1.3 s): `Cinematics.direct`
spends `PICK_RATE` (1000) `camUsable` calls a wall second on it, so at 240 Hz about 5 a frame, and finishes what is left 0.05 s
before the cut. Whole, the pick costs 0.6-1.1 ms median and 1.3-4.3 ms at worst (stunt); a frame of it costs 0.05-0.06 ms median, 0.13-0.19 ms
at p95 and 0.38-0.85 ms at worst, and it needs at most 34 five-call runs. Its answer does not depend on the slicing
(`engine-cine.test.ts`). Measured in Chromium on stunt (a seeded 12-lap, 15-car race, its reel at 240 Hz pacing, the tick
without the draw): over 150 frames after each crash-cam impact, 13 impacts / 1661 frames here against 11 / 1359 on main:
median 0.10 ms (main 0.20), p95 0.30 (0.30), max 1.40 (2.10), none over 4.2 ms on either.
Before that check, a wall hit filmed the back of the wall: 86–178 of each course's wall spots
(`engine-cine.test.ts`) put an eye behind it; after it, every cut has an eye on oval and city, and 14 of 186 (rally) and
55 of 272 (stunt, tight walls) wall spots have a cut left to the chase.

In a reel the crash cam keeps ONE cut for its whole window (`CUTS[0]` to `crashCamEnd(hold)`: 1.3 s after the hit to as
long before the clip's slow-mo hands back as the sandbox's 6.1 s is before its 6.5 s hold, its cut times stretched evenly
over it), not the
sandbox's bumper, crane and long-lens cuts: `heldCut` picks the crane (else the long lens, else the bumper cam) whose eye
has `CLEAR.radius` m of room and sight of the car (`camUsable`), keeps its eye where its cut begins, aims at the hit until
0.3 s past it, then turns toward the car at 4/s, and re-asks every 0.25 s: it moves to another cut only when the held eye has lost room or sight (a wall,
building or a car in the way), and hands the shot to the reel camera when none is usable (until 0.3 s past the hit, a cut whose eye sees the hit holds). Camera changes from the hit
to 7 s after, in the browser at 60 and 240 Hz: 4 before (bumper, crane, long lens, hand-back), 2 after (take-over,
hand-back). The sandbox crash cam still cuts three times. A hit inside the window never re-picks (the reel calls
`impact` once a pass).

The flight between clips (`overheadPose`) eases from the last clip to the next at 80 m, climbing over long flights. Its
eye trails the point it is over, so the view is never straight down.

The results sheet (a right-hand panel on a desktop or a phone in landscape, a bottom sheet in portrait) and the standings
list (top left) stay open over the reel. Each sends its box on the page as `reelCover` (`useReelCover`); while the reel
plays, `coverLens` takes the strip of the canvas clear of every open panel with the most room for a subject kept 10 % of
the view from every edge, and frames that room as a bare canvas's inner 80 % (the rest of the canvas shows what lies past
it), so every rig's centred subject plays in the free part, clear of the panels as of the canvas's edges.

### FX tier

The reel has no FX switch of its own. A race starts on `minimal` under the automatic tier and lifts back to the ceiling at green + 3 s if its frame work has room (docs/CINEMATIC.md "Auto"); its end,
where the reel starts, returns the tier to the highest one that held this session, so a capable desktop plays the reel
on "high" and steps down if its frame work (main thread or GPU) exceeds the 60 fps budget. A manual pick keeps the user's tier through the reel. Switching tiers
only switches post passes: on the RTX 4080 laptop run, `renderer.info.programs` stayed at 84 before, through and after
a switch to "high".

## Netplay

The host runs the reel; clients never record.

1. At "over" the race calls `reelReady`. The engine packs the reel (`packReel`), sends it once on the reliable channel as
   `MSG.reelPart` frames (`NetPlay.sendReliable`, `reelParts`) and plays the *decoded* bytes itself at
   `now + RESULTS_DELAY`, the moment the results sheet opens.
2. The reel message is the type (`MSG.reel`), the seed (u32), the start in host-clock seconds (f64), then every clip deflated
   (`deflate-raw`). It is cut into frames of 32 KiB (`net/reel-wire.ts`: `MSG.reelPart`, a flags byte `FIRST` / `LAST`, up to
   `REEL_PART` bytes), so a reel of any size passes the relay's 240 KiB message cap and WebRTC's 256 KiB one: before
   (`NET_VERSION` 5-9) a reel over `REEL_BUDGET` (240 KiB) dropped whole clips (the seed-5 race sent 3 of 5). The reliable
   channel is ordered, so a client's `ReelParts` gathers a reel from its `FIRST` frame to its `LAST` (a new `FIRST` drops a
   half-gathered one, and more than 4 MiB, `REEL_WIRE_MAX`, drops it). Measured in two Chromium pages over WebRTC (city, 10
   cars, pedal bytes noise-filled to be incompressible): 280,795 bytes in 9 frames and 385,042 bytes in 12 frames, both with
   every clip on the guest, which played the same shot as the host. `NET_VERSION` is 10.
3. A client decodes it (`unpackReel`) and plays it at `startAt + offset`, its estimate of the host clock. While the
   reel plays it draws no host snapshots, because the reel owns the cars. The reel stops when race mode ends or the
   next race sets up (no session, grid or countdown). It does not stop on "racing": the host's race state reaches a
   client 5 times a second, unreliably, so the reliable reel can arrive first (measured: stopped 106 ms after it
   landed, when the rule was "stop unless finished").

Every peer, the host included, replays the same decoded numbers. Same-engine peers match. Different browser engines
may round `Math` functions differently, and the replays can then drift apart.

## Watch and Save

- **Watch** (`reelView`) plays one reel clip alone, full screen, looping with a 1.5 s hold. The HUD is only a
  full-screen transparent exit (tap, Esc or B). Leaving rejoins the reel at its next flight.
- **Save** (`reelSave`, `saveClip`) stores the clip as base64 text: a magic number, `REPLAY_VERSION`, `NET_VERSION`
  and the sim fingerprint, then the deflated clip. One clip may take up to `CLIP_MAX_CHARS` (300 K), and all clips
  together up to `TOTAL_MAX_CHARS` (2 M). Nothing is evicted, because a saved clip is the player's. A save past either
  cap, or past the browser's quota, is refused, and the clip's row says why ("too big", "full", or the browser refused).
  On the seed-5 race the 5 clips encode to 20–266 K characters, all under the per-clip cap.
- **Saved clips** are listed in the race setup menu with Play and Delete. Play restyles the clip's slot cars with the
  recorded paint and class, plays the clip solo, and restores the field when it ends. A clip saved by another clip or
  keyframe layout, or by another sim build (fingerprint), is refused as "version" rather than replayed wrong.

## Limits

- The crash cam needs an FX tier other than "off". A peer at "off" sees the run-in shot over the hit.
- An oval ramming race files only about 2 clips in 70 s; the city files more.
- The recorder's frame cost is 0.02 ms at 10 cars and 0.09–0.16 ms at 32. Its ON−OFF frame-time A/B is within
  run-to-run noise on city and oval at 10 and 32 cars.
