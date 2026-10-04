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
| `net/reel-codec.ts` | One byte layout for a clip on the wire (`MSG.reel`) and in storage. |
| `engine/highlight-store.ts` | Saved clips in `localStorage`. |

## Recording

`CrashRecorder` runs on the host (or offline), never on a client. Per fixed step it writes every car's drive output
(`INPUT_BYTES`, 4 per car) and the step's dt into a typed-array ring of `RING` (5120) steps, at least 17 s at a race's
240–300 steps/s. Every `KEY_EVERY` (1 s) it encodes a keyframe: the netplay snapshot of every car (`writeSnapshot`,
with each wreck's deform and parts), then per car its flight block (`DeformableCar.flight`: `FLIGHT` doubles, the
airborne and hull-contact flags, the whole spin, the takeoff spin, pitch, yaw, roll, velocity and position, the squeeze
clocks, the drift state) and, for a wreck, its solver state (`simState`: every scalar such as the crash clocks, each
sensor's compression, each mass's position, velocity and crush offsets, each beam's set, each shape cluster's plastic
rest and fit state). A cluster's first impact encodes one more. A clip keeps the keyframes from its start to its first
impact (`cutKeys`: fewer when its estimate passes `CLIP_BUDGET`), and stores each wreck's solver state XORed word by word
on that car's state in the clip's previous kept keyframe (`ClipSim` undoes it), so what a wreck keeps between keyframes
turns to zeros that deflate drops. A wreck is 1559 words (6.2 KB) a keyframe, 2.2 KB deflated while it moves (measured on
the stunt clips: the clusters' fit state 1.2 KB of that, the masses 0.6, the arrays and scalars 0.4).

An impact is a car–car contact closing at `PAIR_MIN` (5 m/s) or more, or a wall/prop contact at `WALL_MIN` (5 m/s),
whose pair had been apart for `REHIT_S` (0.35 s), so grinding never re-counts. Impacts join an open cluster that shares
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
since the clip's start. Left out: a car that did not exist at the clip's first keyframe and one placed (`JUMP`) after
the first impact, which the replay cannot place. 80 m covers the replay cameras' sight lines (`DUTCH.range` is 90 m): of
the 46 cars a camera could see on five seeded races, 80 m holds 44 and 60 m holds 39. A clip grows by bystanders only to
`CLIP_SHARE` (`REEL_BUDGET` / `TOP` × 3.3 ≈ 158 KiB estimated: a car's inputs plus its 6.2 KB solver state in each
keyframe it is a wreck in). A bystander too big for what is left is skipped (a cheaper one further out may still fit),
and a pile-up that already fills the share takes none. Measured on city seed 6: an intact bystander costs 9 KiB raw and
2 KiB deflated, a wreck churning through the whole clip 54 and 13. Uncapped, 80 m turned that reel (249 KiB of single
clips, 4 of 5 fit the 240 KiB message) into 879 KiB with 1 fit, and saved clips past 300K chars. With the share, fit
counts equal the no-bystander recorder's on all five measured races, cars within 80 m of a hit that end up in a clip
rise from 144 of 239 to 171 of 241, and the largest saved clip is 267K chars. The recorder's steady-state allocation is 1.2 B a step
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
the reel launches the dummy from the recorded numbers (`ReelHost.eject`); the clip's subject car's driver gets the ride-along
camera (`aimRigs`), over the clip's shots, until every dummy lies still. Two replays of one clip fly the dummy along exactly
the same path (`race-eject-reel.test.ts`); the live dummy and the replay's start from the same point (0 m) but part once
they bounce off replayed cars (a free flight stayed within 0.9 m of the live one over 4 s, one that hit the oncoming car
did not): the launch falls on another frame boundary (up to 1/60 s) and the replayed cars are cm to dm off the live ones.

The replay marks the first hit by the recorder's own rule (`countsAsImpact`: at least `PAIR_MIN` / `WALL_MIN` hard after a
`REHIT_S` quiet spell), so a brush 0.35 s before the recorded impact no longer times it early.

## Replay

`ClipSim` respawns the clip's cars from keyframe 0, wrecks included (dents, lost parts, lamps, glass, solver state).
It then feeds each recorded step's dt and inputs through `applyDrive`, `stepWorld` and `settleStep`. Up to and
including the first impact's step, every keyframe snaps the cars back onto the record (drift correction). After that
the crash plays out on its own. The clip also carries its crumple settings (`squash`, `buckle`, `deformMode`), so
every peer dents the same way.

**Fidelity (`REPLAY_VERSION` 8, `engine/replay-fidelity.test.ts`, `engine/engine-replay.test.ts`).** A replay is held to the sim that recorded it, step by step over the hit window (the step after the first impact to 0.6 s after it). The 2 x 20 m/s head-on on the oval (nose-to-nose cars 8 m apart) went from 817 mm, 8.7 m/s and 2.4 m of crush too little (p95, `REPLAY_VERSION` 6) to 49 mm (7), to 0.010 mm, 0.0000 m/s and 0.025 mm (8). Measured on the final tree, each crash's error over the window (p95 / worst; the first impact's own step; the bound in the test is about twice the worst):

| crash | pose mm | velocity m/s | crush mm | impact step |
|---|---|---|---|---|
| race head-on | 0.009 / 0.010 | 0.0000 / 0.0000 | 0.024 / 0.068 | 0.000 mm |
| race offset | 0.018 / 0.020 | 0.0000 / 0.0000 | 0.067 / 0.074 | 0.000 mm |
| race T-bone | 0.035 / 0.038 | 0.0001 / 0.0001 | 0.059 / 0.075 | 0.197 mm, 0.0004 m/s |
| race pile-up | 0.005 / 0.007 | 0.0000 / 0.0000 | 0.024 / 0.044 | 0.008 mm, 0.0003 m/s |
| derby head-on | 0.008 / 0.009 | 0.0003 / 0.0004 | 0.060 / 0.063 | 0.000 mm |
| derby offset | 0.003 / 0.003 | 0.0000 / 0.0000 | 0.010 / 0.015 | 0.000 mm |
| derby T-bone | 0.026 / 0.031 | 0.0001 / 0.0003 | 0.154 / 0.188 | 0.000 mm |
| derby pile-up | 34.058 / 162.915 | 0.5214 / 7.8908 | 63.896 / 712.230 | 0.000 mm |

The race rows run the crash's own cars: the head-on, offset and T-bone with two (the T-bone's striker is driven by a scripted human until the first contact, as the derby rows script their pedals), the pile-up with four. The race AI steers clear of what it closes on (`ai/contact-guard.ts`), so a spare grid car no longer runs into the crash, and a car the crash does not touch rides the clip as a bystander on 8-bit pedals (only the cars an impact involves keep their pedals' last digits) and replays 0.3 to 0.9 mm off. The test asserts that the clip's first impact is car 0 against car 1.

What the clip lacked, in order of effect (each found by restoring the live state into the replay and seeing what moved it):

- **The hit's own state** (7). `simState` carries the current hit vectors, each end's hit energy (`endEbs2`), the body frame (`bodyC`, `bodyRestC`) and the ground samples and measured pose the next step reads before it measures them (`floorPre`, `floorPost`, `gripPost`, `pose`).
- **The shape clusters' fit state** (8). A cluster's fit blends each new rotation with the last (`Rprev`) and warm-starts from `rotQ`, and reads its rest points (Sp·q0). Restored without them the first fit ran against the identity: 16 of a monster wreck's 20 masses sat 5-200 mm off the live ones one step later, now 0 (`simState` words per wreck 1154 → 1559).
- **Clocks and sensors to the last bit** (8). `elapsed`, `lastContact`, `lastPower` and `contactAt` are compared by differences with holds of whole steps (`CONTACT_HOLD` 2/60 s = 8 steps), and a float32 clock flipped one at a step the live sim did not (12 mm in a second): every scalar is stored as a float32 and the remainder it rounded off. Each sensor's compression (the parts' hinge targets and the glass read it) was only on the netplay wire, at 1e-4 m, and is exact now.
- **The car's pose, whole** (8). The flight block (`FLIGHT` 22 doubles) holds pitch, yaw, roll, velocity and position exactly (the wire rounds them to 1e-4 rad, 1 cm/s and a float32: a first impact 0.5 m/s off, two wedged wrecks 12 mm), the squeeze rule's clocks (`endAgo`, `endReach`, `endSqueeze`: a restored squeeze never ended without them) and the drift state; the wreck's `squash` and `buckle` are stored as doubles in the clip header.
- **The pedals' last digits** (8). A cruising car's speed follows its throttle at once, and 1/127 of throttle moved the cars 20-80 mm in the half second before the impact, so seeds 4 to 8 hit late or not at all. The clip keeps three more bytes per step and car (`fine`: what the 8-bit pedals rounded off) for the cars the impact involves, from the last keyframe before it to `FINE_S` (2 s) after it. Error-diffusion rounding of the 8-bit pedals was tried and measured worse.
- **A float32 step** (8). The engine's fixed step is a float32 (`Math.fround(physicsSlice(...))`), which the recorder stores whole, so the replay runs the very step the live sim ran (a 6e-8 s difference became centimetres a second later). Whole microseconds (7: `u16`) had moved a head-on's wreck 8 mm.
- **A replay's own contact history** (8). A keyframe puts the cars back on the record; the contacts they made on their own before it are not the record's, and `ClipSim` forgets them there. A pair the replay had wedged for a second, which the record never touched, never counted as the recorded first impact (seed 5, clips 2 and 4: no hit found, 0.000 m off).
- **Part tearing in the fixed step** (8). Doors, mirrors and panels tore in `Car.updateDeform`, once per rendered frame, so their timing followed the player's frame cadence and a replay drawn at another rate than the live sim it re-ran diverged (the airborne stunt clips' three 26-33 mm pops in `engine-highlights.test.ts`). `Car.stepBreakage(dt)` runs the crush window and the breakage in the fixed step (`settleStep`); `Car.updateSkin()` is the per-frame mesh write only. `vehicle/render-cadence.test.ts`: the same head-on drawn at 60, 144 or 240 Hz, or never, tears the same parts at the same step (before: 144 Hz differs from 60 Hz at step 27).
- **Sideswipes and race pair hits** (8). A car that only sideswiped through its doors or mirrors (`partContactPair`, `World.partTouch`) was no part of the clip, which left two wrecks 61 cm off at the first impact (seed 2, clip 4); it is counted as a toucher now. A race's car-car hits never reached the recorder in the real engine (`engine.ts` wired `World.pairHit` for the derby only): `RaceDirector.pairHit` is wired.

Keyframes are 1 s apart (`KEY_EVERY`; 0.5 s before: restoring the clusters' fit state cut a restored wreck's drift enough, and it halves a clip's bytes). A clip estimated over a third of a reel message (`CLIP_BUDGET`) first drops its intermediate keyframes, oldest first, down to its first, the last before the impact and the impact's own (`CrashRecorder.cutKeys`): the 15-wreck pile-up of city seed 5 was 262 KB deflated and fitted no reel, and is 170 KB now; the stunt course's three clips are 59, 73 and 99 KB (231 KB together, were 2 clips).

What is left: a keyframe anchors only the first impact and the wrecks it restores; two wrecks wedged together are a chaotic pair (a contact that separates after 40 steps turned 1e-7 m of difference into 7 cm in one step and 1.5 m by the impact 140 steps later, even with the live state of every field injected), so a pile-up's later impacts run on the replay's own state and part by decimetres (derby pile-up above; its wreck flags differ for one car-step).

The pile-up numbers are one sample of a chaotic process, as is any seeded race: the same crash with the engine's step left a double (not rounded to a float32) measured the derby pile-up at p95 77 mm / 3.5 m/s / 253 mm and failed city seeds 1 and 6 (a wedged pair of wrecks 1.557 m off at the impact; a wall hit 0.317 s late), so the step is rounded in the engine and the recording harnesses (`Math.fround`), which also moves every race's sample (`race-finish.test.ts`'s police lead-in count, `engine-highlights.test.ts`'s first clip: seed 5 opens that clip on 12 wrecks and a standing focus car, so its premise tests run seed 2).

**Cost (`REPLAY_VERSION` 8).** `ClipSim` on the race head-on clip (4 cars, 1728 steps): 82.3 us a step over the whole clip (79.5 at 7), 89.7 us inside the hit window (105 at 7, where the crush now runs as live). The live frame (the oval head-on with 3 AI, 360 frames, the crush now in the fixed step): 0.302-0.315 ms against main's 0.310-0.323, noise. Sizes: a saved clip of version 7 is refused as `version`; a wreck's solver state is 1154 → 1559 words, the flight block 14 float32 → 22 doubles per car and keyframe, the pedals 3 more bytes a step for the cars the impact involves; the 4-car head-on clip of the fidelity test is 40.2 KB raw at 7, 58 KB at 8, a 15-wreck pile-up 170 KB deflated after thinning, and the stunt course's top three clips 231 KB.

**Drawing.** The sim only has whole recorded steps (1/240 to 1/114 s of clip time), and the reel plays the hit at about
1/30 of that, so most frames land inside a step. Measured on city seeds 5 and 6 (3 clips each, the camera and the focus
car per rendered frame at 60 and 240 Hz): 87–88% of the slow-mo's frames at 60 Hz and 97% at 240 Hz drew the focus car
where the last frame had it, and a car-mounted camera saw 420–470 m/s² (60 Hz) and 6600–7500 m/s² (240 Hz) of second
difference (p99). `advanceTo` therefore runs the step `until` falls in, and `ClipSim.present(until)` draws every car
between the pose before that step and the one it left. The sim's own state is never the drawn one: `advanceTo` puts the
exact state back first, the quaternion as well as the Euler angles (an airborne or falling car's quaternion is the sim's
own, and quaternion to Euler to quaternion is not exact: stunt clips ended 1.1e-12 off at 60 Hz and 2.6e-13 at 240
before; `engine-highlights.test.ts`: a replay with a drawn frame inside every step ends on the same state as one
without, on the city's ramming clip and on every stunt clip). Two more jerks, one in each window: a keyframe moves a car
by the replay's drift (median 3–25 cm, some 1–2 m, every 1 s before the hit), which `present` draws as an offset
decaying over `POP_TAU` (0.2 s) instead of a pop (not at the impact's keyframe, whose drift the hit shows); and the chase
shot read the wreck's own velocity, which swings 4° and more a frame, so `ClipSim.heading` low-passes it (`foldHeading` in
`shot-cam.ts`, over `HEADING_TAU`, 0.3 s, per step; the Auto cam folds the same heading per frame). Second difference
p99, after:
0 stalled frames; slow-mo 0.1–10 m/s² at 60 Hz and 0.3–5 at 240 Hz; run-in at 60 Hz 310–390 (was 2850–5200) and 21–117
rad/s² of rotation (was 480–490); chase aftermath at 240 Hz 2200–4200 (was 29000–35000).

Why the solver state: the netplay wreck section is display state (clients never simulate). A wreck restored from it
alone had still masses and reset clocks. In `engine-replay.test.ts` (city, seed 5) one wreck caught mid-hit, its
masses moving up to 31 m/s about their mean, shed 5.2 m/s in its first replayed step and reached the impact 2.8 m
off the record. With the solver state the worst car is within the 1.5 m bound.

## The reel

`ReelDirector.play(reel, startAt)` loops [`FLIGHT_S` (3 s) overhead flight → clip] over the reel's clips from
`startAt` (this browser's `performance.now()` seconds). Wall time decides everything: which clip, the clip time, and
the shot. A peer at 45 Hz and one at 60 Hz therefore frame the same camera at the same moment
(`engine-highlights.test.ts`: under 1e-6 m or rad over 200+ moments).

- **Timeline.** `clipTimeline` steps the phase.ts crash clock at a fixed 1/120 s: 1× up to `PRE_IMPACT_LEAD` (0.07 s)
  before the recorded first impact, then the auto slow-mo, then back to 1× to the clip's end. The reel mirrors it into
  the engine's clock, so the letterbox and the HUD behave as in a live crash.
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
3. the aftermath, once the crash cam hands back (`CRASH_CAM_END`).

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

In a reel the crash cam keeps ONE cut for its whole window (`CUTS[0]` to `CUTS[3]`, 1.3 to 6.1 s after the hit), not the
sandbox's bumper, crane and long-lens cuts: `heldCut` picks the crane (else the long lens, else the bumper cam) whose eye
has `CLEAR.radius` m of room and sight of the car (`camUsable`), keeps its eye where its cut begins, turns toward the
car at 4/s, and re-asks every 0.25 s: it moves to another cut only when the held eye has lost room or sight (a wall, a
building or a car in the way), and hands the shot to the reel camera when none is usable. Camera changes from the hit
to 7 s after, in the browser at 60 and 240 Hz: 4 before (bumper, crane, long lens, hand-back), 2 after (take-over,
hand-back). The sandbox crash cam still cuts three times. A hit inside the window never re-picks (the reel calls
`impact` once a pass).

The flight between clips (`overheadPose`) eases from the last clip to the next at 80 m, climbing over long flights. Its
eye trails the point it is over, so the view is never straight down.

### FX tier

The reel has no FX switch of its own. A race starts on `minimal` under the automatic tier and lifts back to the ceiling at green + 3 s if it holds 57 fps (docs/CINEMATIC.md "Auto"); its end,
where the reel starts, returns the tier to the highest one that held this session, so a capable desktop plays the reel
on "high" and steps down if it can't hold 50 fps. A manual pick keeps the user's tier through the reel. Switching tiers
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
