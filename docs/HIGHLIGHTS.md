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
| `engine/engine-reel.ts` | `EngineReel`, the engine layer: starts and sends the reel, its HUD commands, saved-clip play, the FX boost. |
| `present/highlight-cam.ts` | `overheadPose`: the flight between clips. |
| `present/fx-boost.ts` | `hardwareDesktop`, `FrameGuard`: the reel's FX boost and its drop. |
| `net/reel-codec.ts` | One byte layout for a clip on the wire (`MSG.reel`) and in storage. |
| `engine/highlight-store.ts` | Saved clips in `localStorage`. |

## Recording

`CrashRecorder` runs on the host (or offline), never on a client. Per fixed step it writes every car's drive output
(`INPUT_BYTES`, 4 per car) and the step's dt into a typed-array ring of `RING` (5120) steps, at least 17 s at a race's
240–300 steps/s. Every `KEY_EVERY` (0.5 s) it encodes a keyframe: the netplay snapshot of every car (`writeSnapshot`,
with each wreck's deform and parts), then per car its drift state, its flight block (`DeformableCar.flight`: airborne,
hull contact, the whole spin, the takeoff spin) and, for a wreck, its solver state (`simState`: every scalar such as
the crash clocks, each mass's position, velocity and crush offsets, each beam's set, each shape cluster's plastic
rest). A cluster's first impact encodes one more. A clip keeps the keyframes from its start to its first impact, and
stores each wreck's solver state XORed word by word on that car's state in the clip's previous keyframe (`ClipSim`
undoes it), so what a wreck keeps between keyframes turns to zeros that deflate drops. On the city seed-5 race the
largest clips (16 and 12 cars) deflate to 177 and 195 KiB this way, against 301 and 280 KiB stored raw.

An impact is a car–car contact closing at `PAIR_MIN` (5 m/s) or more, or a wall/prop contact at `WALL_MIN` (5 m/s),
whose pair had been apart for `REHIT_S` (0.35 s), so grinding never re-counts. Impacts join an open cluster that shares
a car or lies within 30 m. A cluster closes after `QUIET_GAP` (1.5 s) with no impact, or when it spans `MAX_SPAN` (6 s).
Its score is energy, plus points per extra car, per engine destroyed and for impact density. A cluster below
`MIN_SCORE` (3) is dropped. A clip is `PRE_ROLL` (3 s) before the first impact to `POST_ROLL` (3 s) after the last.

When a cluster's post-roll ends and it ranks, its slice is copied out of the rings. That copy is the recorder's only
allocation, a few times a race. Steady state allocates nothing (`engine-record.test`).

## Replay

`ClipSim` respawns the clip's cars from keyframe 0, wrecks included (dents, lost parts, lamps, glass, solver state).
It then feeds each recorded step's dt and inputs through `applyDrive`, `stepWorld` and `settleStep`. Up to and
including the first impact's step, every keyframe snaps the cars back onto the record (drift correction). After that
the crash plays out on its own. The clip also carries its crumple settings (`squash`, `buckle`, `deformMode`), so
every peer dents the same way.

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
mount) or a high static eye 22 m off the crash. Each shot is framed from the car as it stands at the shot's own clip
time. The crash cam (`beginCinematic(..., crashCam = true)`) takes the hit itself, as it does in a sandbox crash.

The flight between clips (`overheadPose`) eases from the last clip to the next at 80 m, climbing over long flights. Its
eye trails the point it is over, so the view is never straight down.

### FX boost

On a fine-pointer device with a known hardware GPU (`hardwareDesktop`), the reel renders at the "high" post-FX tier.
`FrameGuard` takes the median frame interval before the boost as the refresh rate, and drops back to the user's tier
after a streak of long frames. A drop stays dropped for that reel. Picking a tier in settings overrides the boost. The
boost only switches post passes: on the RTX 4080 laptop run, `renderer.info.programs` stayed at 84 from before the
boost, through it, and after it.

## Netplay

The host runs the reel; clients never record.

1. At "over" the race calls `reelReady`. The engine packs the reel (`packReel`), sends it once on the reliable channel
   (`NetPlay.sendReel`, `MSG.reel`, since `NET_VERSION` 5) and plays the *decoded* bytes itself at
   `now + RESULTS_DELAY`, the moment the results sheet opens.
2. `MSG.reel` is the type, the seed (u32), the start in host-clock seconds (f64), then the clips deflated
   (`deflate-raw`). In rank order, a clip goes in only if the message still fits `REEL_MSG_MAX` (240 KiB, under
   WebRTC's 256 KiB message cap): a clip too big drops alone, the ones below it that fit still go, and the host warns
   in the console how many dropped. On the seed-5 race the 5-clip reel sends 3 (227.6 KiB); the largest clip alone is
   176.5 KiB.
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
