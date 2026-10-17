# Perf bench

How to time the game, and what each number means. The budget is a 240 Hz frame (**4.2 ms**); a frame over 16.7 ms is a
dropped 60 Hz frame. Perf numbers need a quiet box: record `/proc/loadavg` and the GPU clock (`nvidia-smi`) with every run,
and compare builds inside one session with alternating runs.

## Benches

| Bench | Run | Measures |
|---|---|---|
| JS kernels | `npm run bench` (`scripts/bench-physics.mjs`) | wall ms of the plain-JS kernels over a fixed loop; "static" rows repeat one input, "animated" rows step a moving deformation |
| Browser frame | `node scripts/bench-browser.mjs [--url …] [--cars 2,10,16,24,32] [--modes fleet,derby,race-oval,race-rally,race-city] [--seconds 8] [--warmup 2] [--out bench.json] [--vsync]` | wraps `tickInner`, `fixedStep`, `updateSkin` and `renderer.render` on the live `window.__crush` and reports their times and the frame interval |
| Program links | `npm run check:programs -- --url <server>` (`scripts/check-programs.mjs`) | fails if any GPU program links after the boot warm-up or during a race (about 3 min; needs a server and a browser) |
| In-app card | open `/crush/?bench=city` or `/crush/?bench=strip` | the real game on the real clock on any device, phones included (below) |

**On WSL** always pass `--vsync` to `bench-browser.mjs`: its default launch is uncapped, and uncapped frame-rate flags drive
the GPU through WSL's d3d12 driver and have crashed the VM. For CPU frame cost, drive the page with
`__crush.advance(seconds, { frameDt, render: true })` at a synthetic `frameDt` (1/240 s for the fleet and derby, 1/80 s in
races): the numbers are then the **CPU cost of the frame the engine does per rendered frame** (sim, camera, FX, render
submit), reproducible and independent of the compositor's pacing; GPU time is not in them.

## The in-app card

`?bench=city` sets up the city, 15 AI racers plus the player's car (the follow camera, the AI drives it), traffic and up
to 6 police, seed 1, aggression 1. The engine's own rAF loop is stopped and each rAF feeds `advance(measured wall dt,
render: true)`, so the pacer's real 8 ms deadline applies. It waits out the grid and 20 s of race clock, measures 30 s of
the game as it runs, then runs four A/B stretches (pacer, detail, FX tier, sky) on the same race and ends on the replay of its own crash (below). The race plays on under the card afterwards.

`?bench=strip` runs the same card on a controlled course (`world/bench-strip.ts`): a straight race lane up +z, a U-turn of
radius 130 m and a return leg, so the rules see an ordinary one-lap course. Static props stand in a row on the lane's left
outside the wall, an NPC traffic road on its right. The race is the bench's own (aggression 0.5, no police); the page
writes neither the address bar nor storage.

| Parameter | Values | Default |
|---|---|---|
| `props` | `building:20,tree:40,rock:20` (any prefab id, at most 400 each), or `off` | `building:20,tree:40,rock:20` |
| `traffic` | `2x12` (lanes 1 or 2, cars 1–16), or `off` | `2x12` |
| `cars` | racers 2–16, the player's car included | `16` |
| `same` | `sedan`, `hatchback`, `wagon`, `coupe`, `pickup`: every car wears that body; `off`: the fleet's mix | `sedan` |
| `len` | the straight in metres, 1500–12000 | `6000` |

A value that does not parse falls back to its default. Splits: `?bench=strip` (baseline), `&props=off`, `&traffic=off`,
`&props=off&traffic=off` (the bare lane). Any bench (`city`, `strip`, `lab`) also takes `&ultra=1`: the card fetches the Ultra look before its first block and adds an `ultra` arm to the FX A/B (below), or fails if it does not load.

### The Lab: `/crush/?bench=lab`

The same card and run in the Lab (`engine-bench-plan.ts` `LAB_BENCH`): no race, a fixed throw sequence instead, with time held at 1x (the slow-mo would stretch each hit over a different share of each block). Every 4 s of sim the next set loads (the HUD's set picker, or Reset for the set already up) and, 0.5 s later, its thrower is let go at a stored launch velocity (`flickLab`, the player's flick): at the house of cards' top car, then at the wall of props, about 30 m/s each, in turn through the window. Each A/B block starts the sequence over, every arm of a round on the same throw (round 1 the cards, round 2 the wall), so the arms see the same hit. The sequence runs on the sim seconds the pacer stepped, so every device steps the same throws per sim-second. The card's second line names the throws and how many the window saw. Every bench's sim speed and ms per sim-second now read the sim seconds the pacer stepped, which is the race clock while a race runs.

### The replay: the run's own crash, played back

Every race bench (`strip`, `city`, `dam-spine`, `national-mall`; not the Lab) ends on the highlight reel, so a card carries replay-playback perf data. After the A/Bs the race starts over (`retry`, seed 1; its recorder with it) and, once it is green, the first two cars of the grid are put head-on on the start line (`RaceField.crashAtStart`: 12 m apart, 25 m/s each, closing 180 km/h; a driver is thrown, the same on every device). The recorder files the crash as a highlight (waits at most 20 s). That clip is recorded by this run on this build and replay version, never a fixture, and is played back through the results reel's own path (`packReel`/`unpackReel`, `ReelDirector.play`: overhead flight, then the crash cam, slow-mo and the thrown drivers) at each FX tier in turn (`minimal`, `low`, `high`, and `ultra` when the page loaded it with `&ultra=1`, set by `setFxTier`): a restart per tier, 0.5 s unscored (the replay's world is built on its first frames), then 12 s scored (`engine-bench-replay.ts`). Each tier reports fps, 1 % low, frame, cpu, sim, draw and GPU ms, and the ragdoll world's step cost. `sim` is the reel's own clip steps (`ReelDirector.takeStepMs`; the engine's pacer does not run while a reel plays). If a run produced no clip (no grid of two cars, the race did not go green in 20 s, the crash was not filed in 20 s, an error) the result has `replay: null` and `replayWhy` says why, and the loop goes on. The page's phase log (`pageEvents`) has a `replay` phase.

The ultra arm is each step's own: the loop runs the same four steps with `&ultra=1` on each when Ultra is on (`loopultra`/`cycleultra`, [`DEPLOY.md`](DEPLOY.md)), not a second `+ultra` pass of every map. A cycle is strip, city, dam-spine, then the National Mall (`?bench=city&course=national-mall`: 2753 props, about 500k triangles a frame, the loop's heaviest draw): each step is its own page load of about 4 minutes on a quiet device (20 s of race clock, the 30 s window, 18 s + 24 s + 18 s (+ 6 s with Ultra) + 12 s of A/Bs, the replay at each FX tier), so a cycle is about 16 minutes. Card size (JSON, HUD included): 16.4 kB (5.8 kB gzipped) for a strip run with the replay at four tiers and the ragdoll fields (measured at head, headless Chrome); the cap is 48 kB.

### Where the sim's time goes: phases, work counters, device state

The card's `simMsPerSimS` is one number; `result.phases` says where it went, so a card from a phone can be read against a desktop's phase by phase. It is measured over the 30 s window only (the clock reads are switched on at its start and off at its end: `World.phases.on`, `watchWork` in `bench-measure.ts`; the A/B blocks and every other run read no clock). `phases.msPerSimS` is main-thread sim ms per sim-second in each phase of a step, `phases.unattributedMsPerSimS` is `simMsPerSimS` less their sum (the pacer's own loop and the pose blend between steps, a few ms), so the table sums to the headline. The phases tile `SimPacer.run`'s step (`CrashEngine.slice`), each boundary one `performance.now()` read (`sim-phases.ts` `lap`):

| Phase | From … to … | What runs in it |
|---|---|---|
| `drive` | the slice's start to `stepWorld` (`engine.ts` `slice`, `fixedStep`) | pose blend begin, every car's input: the race AI, police and traffic `think`s, the seat, netplay's drive, a wreck's coast, rig sync |
| `plan` | `stepWorld`'s start to its first slice (`world-step.ts`) | roof surfaces, near pairs (`collectNear`, `markApproaches`, `carsInReach`), the slice count, the cars' surface sync |
| `integrate` | per car, per slice: `beginSlice` to its pose refresh | a car on its drive's law: `integrate`, `syncPose` / `refreshBasis` (also the slice a rig steps itself) |
| `wreck` | the same window, for a car whose rigid body steps (`deform.massActive`) | `integrateWreck`: the rigid step of crashed cars |
| `pairs` | after the integrates to `armCrushRows` | roof sync, part contact (`partContactPair`), the barrier, every near pair through `resolveCarPair`, the wrecks' pose sync |
| `structure` | the structure loop | `stepStructure` (the crush solve), `syncPose`, the barrier's clip, `afterContacts`, `afterCar` |
| `course` | the `collide` hook | `RaceDirector.collide` → `courseHit`: the road projection and the prism contacts (`propContact`) of walls and props |
| `bake` | `endSlice`, `bakeBetweenSlices` | the slice's bake of each car's body |
| `rules` | `stepWorld`'s end (`ejection.step`) to the end of `fixedStep` | ejections and the thrown drivers' launch, `RaceDirector.step` (police, recorder, race rules), the crash cinematic's start |
| `settle` | `settleStep` | the dead drivetrain's drive, the wreck's slide, `stepBreakage` (hinges, tears, lamps, glass) |

Skinning (`updateSkin`, the WASM kernel) and the ragdoll hand-off run in the frame outside `SimPacer.run`, so they are not in `simMsPerSimS`; their work is in the counters below.

`phases.workPerSimS` counts the work per sim-second, which no timer noise touches, so a rise in the amount of work reads apart from a rise in its cost per unit. The counters are plain adds, kept always; the window reads the differences. `steps` the pacer's steps, `slices` the slices they were cut to; `liveCarSlices`, `wreckCarSlices`, `asleepCarSlices` car-slices stepped for a car on its drive's law, a wreck whose rigid body runs, and a sleeping wreck; `pairTests` near pairs that went through `resolveCarPair`, `pairContacts` those that hit, `partContacts` door, mirror or panel contacts; `prismQueries`, `prismsVisited`, `prismTouches` a car's footprint queries of the course's prisms (`Surface.prismsNear` by `propContact`), the prisms they returned, and the ones the footprint touched; `skins`, `skinVerts` cars skinned by the WASM kernel and their vertices (0 where the kernel did not load); `ragdollMessages`, `ragdollBytes` what the sim posted to the ragdoll worker (messages, and the bytes of the typed arrays handed over: a frame's cars, a car's cage; 0 until a driver is thrown or a prop knocked). The fine-slice cuts per sim-second (`fineCutsPerSimS`) and the ragdoll world's steps (`ragdoll.steps`) are the card's existing counters.

**The clock.** Firefox rounds `performance.now()` to 1 ms (`timerStepMs`). Each phase is a sum of differences of that clock over thousands of laps, and a lap's start is uncorrelated with the tick, so the rounding errors cancel: the sums are unbiased, a per-lap maximum would not be, so the card keeps sums only. A clock of 16.7 ms (resistFingerprinting) blinds the pacer (`SimPacer`) as well and the phases there are noise.

**Cost.** One clock read per boundary, about 10 000 a sim-second in the city bench (a lap per car-slice in `integrate` / `wreck`, a few per step); off it is one branch each. Measured in node on the bench race (`BENCH_RACE`, seed 1, 15 AI and police, the pacer pinned to 1/240 s, 20 s of sim after 10 s of warm-up, six interleaved process pairs of the same sim): 10 507 ms mean with the clock off, 10 494 ms on (-0.1 %, pairs from -1.8 % to +2.0 %, the machine's own noise); `performance.now()` costs 30 ns there, 10 000 reads a sim-second is 0.3 ms of the 520. The sim is bit-identical either way (the digest of every car's pose and velocity and the pacer's steps, the same with the clock on and off: `engine-bench-headless.test-util.ts` `simDigest`; the window's `simMsPerSimS` includes the reads). A browser's clock reads may cost more than node's; a card whose `phases.unattributedMsPerSimS` is a large share of `simMsPerSimS` is where to look.

**Device state.** `device.battery` (`start` and `end`: `charging`, `level` 0-1; null where `navigator.getBattery` is missing: Chrome has it, Firefox and Safari do not), `longTasks` (`count`, `totalMs`, `maxMs` of the main-thread tasks of 50 ms or more over the window, `PerformanceObserver` "longtask"; null outside Chrome). Already on the card: the page's visibility and focus changes (`pageEvents`), `device.dpr` and `device.canvas` (the canvas actually rendered), `settings.deviceRatio`, `settings.pixelRatio`, the FX tier share (`tierPct`).

**Reading the cards.** `node scripts/fetch-submissions.mjs <app url> --kind bench --phases` prints each bench card's phase table (phases, work counts, long tasks, battery) under its line, for the cards already saved too; a card from before the phase table says so. The submissions endpoint stores a bench card's result as sent (`payload` is any JSON object under the 48 kB cap; the new fields add under 1.5 kB), so nothing server-side filters them.

### Card lines (`describeBench`, top first)

| Line | Meaning |
|---|---|
| `CRUSH BENCH  <course>  <cars> cars  <s> s  <frames> frames  (<browser>)  build <sha>` | what ran; `build` is the commit the page was built from (`__BUILD_SHA__`, `dev` without git) |
| `strip …` / `lead racer …` (strip only) | the strip's settings, and how far up it the leader got; `REACHED THE TURN` means the late blocks include the U-turn |
| `FPS   1% low   by thirds` | mean fps over the 30 s window, the 1 % low, and the mean of each third |
| `fps each second` / `sim ms each second` | per wall second: frames, and the ms `SimPacer.run` (physics, AI, breakage) took, scaled to 1000 ms |
| `SIM SPEED … %` | race-clock seconds per wall second; `pacer cut` frames and `gave up` sim-s (`SimPacer.lost` / `cut`); the share of frames at the 1/80 s step; wrecks (mean, end) |
| `PAGE LEFT during the window: …` (only when it happened) | the page lost focus or was hidden mid-window (`pageEvents`, window phase): each change with its time into the window. Read max and p99 with it in mind: the one 1.1 s sim frame in 192 cards (2278f1c dam-spine on a phone, `sim ms each second` 2355 and 2180 around the blur at 18.5 s and hide at 19.0 s, 750 elsewhere) sat there, and the other 17 cards with a page change stayed under 131 ms of sim. Likely the phone holding the page it was leaving, not proven |
| `frame`, `CPU`, `  sim`, `  draw` | p50 / p95 / p99 / max ms of the frame interval, the main-thread tick, its sim part (plus steps per frame, ms per step, **ms per sim-second** and fine-slice cuts per sim-second) and its render submit. Compare ms per sim-second across browsers, not ms per step, which grows with the step |
| `  sim phases, ms per sim-second: …` | one line: the ten phases (above), `unattributed` and the sum against `simMsPerSimS`, then the work counts per sim-second |
| `GPU` | timer-query ms (absent on Firefox and some phones). It spans the draw, so a wait inside it counts: when p95 is one frame long the card says so, and p50 is the work |
| `draw … calls … tris   cops` | draw calls and triangles per frame; police stakeouts, pursuits, largest pack |
| `fx tier` | the share of the window at each FX tier (a race starts on `minimal`; `AutoFx` lifts a capable desktop to `high` 3 s after green if minimal holds 57 fps, and steps down under 50 fps) and the post chain at the top tier |
| `detail` | the share of the window on each distance-detail rung (`DetailGovernor`, `present/car-detail.ts`) |
| `shadows … pixel ratio … canvas … MSAA … fx density, cel` | render settings in force |
| `night, wet, realism, squash, buckle, deform, sky` | sim and look settings in force. `sky` is the Sky setting (`auto`, `on`, `full`, `off`; `?sky=` pins it for the page) and what it drew at the top tier (`SkyDetail`: `off`, `gradient`, `half` or `full`; `skyDetailFor`). The FX A/B arms run with that setting, so on `auto` their `minimal` arm draws no sky and their `high` arm the whole strip; read the sky's own cost off `A/B sky pinned` |
| `depth` | depth-buffer bits, subpixel bits, fragment highp range, camera near / far, log depth |
| `A/B pacer pinned` | 3 × 3 s per arm: `SimPacer.pin` holds the 1/240 s and the 1/80 s floor in turn. Each arm prints fps, sim speed, ms per sim-second, CPU / draw / GPU ms |
| `A/B fx pinned` | 2 × 3 s per arm at `minimal`, `low` and `high` (`high`: HDR target, 5-mip bloom, radial blur, tone map, grade, vignette, grain; `low`: 3-mip bloom; `minimal`: none), then `ultra` with `&ultra=1`. Each arm prints fps, sim speed, ms per sim-second, CPU / draw / GPU ms and draw calls per frame |
| `A/B detail pinned` | 2 × 3 s per arm, run before the FX arms at stretch 1's tier with `AutoFx` and the governor off: no cuts, then body alone beyond 75, 50 and 30 m |
| `A/B sky pinned` | 2 × 3 s per arm (race benches; the Lab has no sky), after the FX arms, at the tier the window mostly ran: the Sky setting `full` (the textured 4096 strip; the arm waits, unscored, for the strip to decode and upload) against `off` (no dome, no texture). Same arm line as the others, so the sky's cost is the difference of the two (`result.abSky.full` / `.off`; `null` on the Lab). The player's Sky setting goes back after |
| `ragdoll world` | the cosmetic Rapier world (the thrown drivers' and knocked props': `present/engine-ragdoll.ts`), over the 30 s window: `world.step()` calls, their mean and p95 ms, and the colliders and bodies the world holds (the course's statics are colliders too). Its step ms is **not** in `CPU`'s tick split: read it here. `0 steps` is a world with nothing to move (no dummy thrown, no prop knocked) |
| `replay of this run's crash` | the clip (cars it carries, drivers thrown, size on the wire) and a row per FX tier (below): fps, 1 % low, frame / cpu / sim / draw mean/p95 ms, GPU ms and the ragdoll step mean/p95 ms with its step count; or `replay: none (<why>)` |
| GPU string and `load:`, then cores, memory, screen, canvas, timer step, `long tasks`, `battery` | the device, on two lines. `load` is the ms the race's options and start took. A GPU string the browser masks is labelled; timer step is what `performance.now()` resolves (0.1 ms Chrome, 1 ms Firefox / Safari, 16.7 ms with resistFingerprinting); long tasks over the window and the battery at the start and end of the run (above) |

Each A/B alternates its arms (ABAB…) after 10 unscored frames per switch, so read an arm against its neighbours, not
against another A/B or against stretch 1. **Copy details (JSON)** puts every metric, the HUD's whole state and the
per-second strip on the clipboard; the result is also `window.__benchResult`. Run it for about 4 minutes on a quiet device.
