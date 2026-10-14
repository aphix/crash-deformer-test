# Measurements

All node figures from this WSL box (loads noted where they mattered: other sessions' rustc/e2e runs push load to 3–6 and skew absolute ms; interleaved ratios hold up better). Browser figures from the owner's desktop (RTX 4080, 165 Hz) and phone (Mali-G715) unless noted.

## 1. Regression by plan stage (node, city bench config: city track, 16 racers + police, aggression 1, seed 7; ms of sim per sim-second)

| Commit | Stage | ms/sim-s |
|---|---|---|
| 1c21fbd1 | pre-plan | 227 |
| d232d0a7 | Stage 1 (surface store) | 278 |
| 2160cddf | Stage 2 | 279 |
| fc1118e2 | Stage 3 | 360 |
| eb72060a | Stage 4 item 5 (car-car through the kernel) | 352 |
| c12d2d31 | Stage 5 | 424 |
| 10550ba0 | Stage 4 item 6 (wreck split: every crashed car runs the rigid step, ~220 cage points per 1/240 s) | 671 |
| 7cf2c6f9 | 10-12 morning | 601 |
| ecbc560e | + tops gate (near-tops lists) | ~550 (0.91–0.93 of 7cf2c6f9) |

Harness: `scratch-CostProfile3/drive.mjs` (headless race, arms alternate 1-sim-s chunks in one process).

## 2. Live benches (bench cards, build 7cf2c6f, `fx=minimal`)

| Device | City fps | City sim ms/sim-s | Notes |
|---|---|---|---|
| Phone Chrome | 33.5 | 1265 | pacer coarse (1/120 s) |
| Phone Firefox | 24.2 | 1683 | card shows fine 1779 vs coarse 1395 |
| Desktop Firefox | 63.4 | 624 | |
| Desktop Chrome | 159.8 (vsync 165) | 370 | main thread 78 % busy; dam-spine 156 fps |

Desktop Chrome fleet 32 (seed 4242): impact 135 fps, slow-mo 46 fps, aftermath 10 fps (p50 103 ms). Owner's own fleet tab (c9dc4f9): 57 fps, pacer coarse, 16 sim-s dropped.

Desktop Firefox, 2560×1600, bench strip loop (fps / sim ms per sim-s). Both sets ran with this box's own work on the same PC, so neither is clean: 2ece5e8 (03:34–03:41Z) under lanes and probes; c5e5cba loop 1 (13:34–13:41Z) before a lane's headless survival runs started (13:42Z), loops 2–3 under them (city falls 109.5 → 93.5 → 79.1 fps across the three).

| Build | bench (28 cars) | city (32) | dam-spine (22) |
|---|---|---|---|
| 2ece5e8 (Phase 1 + 5) | 66.2 / 834 | 68.4 / 692 | 74.0 / 724 |
| c5e5cba (Phase 2 + 4), loop 1 | 117.1 / 370 | 109.5 / 526 | 206.8 / 412 |
| c5e5cba, loops 2–3 | 117.0, 114.5 / 386, 386 | 93.5, 79.1 / 544, 594 | 114.7, 115.6 / 437, 431 |

## 3. Desktop Chrome profile, fleet 32-car aftermath (1 s window 12–13 s, frames 78–103 ms; build 7cf2c6f9 = tree cost-w4, line numbers are that tree's)

Top self time:

| % of s | Function | File |
|---|---|---|
| 10.1 | offer | surfaces.ts:1040 |
| 8.1 | rasterise | car-cage.ts:682 |
| 6.4 | seek | surfaces.ts:1356 |
| 5.8 | gridAt | surfaces.ts:946 |
| 5.3 | transformGrid | car-cage.ts:813 |
| 4.8 | deepestIn | sat.ts:97 |
| 4.5 | holds | ragdoll-proxy.ts:139 |
| 2.6 | Rapier wasm fn 334 | |
| 2.5 | measure | ragdoll-proxy.ts:165 |
| 2.4 | sample | ragdoll-proxy.ts:235 |
| 2.0 | cut | ragdoll-proxy.ts:245 |
| 2.0 | solveCagesFromShape | streamed-deform.ts:240 |
| 1.8 | counts | ragdoll-proxy.ts:149 |
| 1.6 | bil | surfaces.ts:855 |
| 1.6 | normalOf | surfaces.ts:1200 |
| 1.4 | refresh | cage-outline.ts:37 |
| 1.3 | update (three geometry) | three.module.js:4192 |
| 1.3 / 1.2 | Rapier wasm fn 37 / 3 | |
| 1.1 | pullSensorsFromMasses | streamed-deform.ts:156 |

Inclusive: tickInner 98 %; fixed-step sim 60 % (integrate 31 %, stepFree 29 %, seek 24.5 %, wheelContact 14.3 %, readPoints 15.6 %, pointContact 11 %, resolveCarPair 12.9 %, satCars 11 %); ragdoll update 23 % (fitProxy 14 %, Rapier step 8 %); three render ~15 %.

`offer` inclusive 189 ms by caller chain: 48 % tread ← wheelContact ← wheelsAt ← stepFree (tyre footprints, 125 points per wheel when a car top is near); 31 % pointContact ← readPoints ← stepFree (cage points); 7.6 % loose parts (loose-step.ts:150); rest belly/edge.

City bench (desktop Chrome): bench-loop 33 %, three 29 %, prefabs 14 %; fixedStep 50 %, render 29 %, integrateWreck 20 %. three self: updateMatrixWorld 3.2 %, WebGLGeometries.update 2.8 %, projectObject 1.8 %, setProgram 1.6 %.

Load trace (Chrome): cage build ≥ 1.87 s at page load (`cost` car-cage.ts:350 1326 ms, `decimate` 286 ms, `buildStyle` 175 ms); shader warm 365 ms (223 ms deliberate JIT warm crash + 142 ms three link checks).

Firefox desktop fleet slow-mo (13.4 fps): surface queries 28 ms/frame, cage refit 12.3, three 7.8, mass solver 5.3, Rapier 4.2.

## 4. Node call counts, fleet 32 (seed 4242, 1500 frames, tree cost-x10 unless noted)

| Counter | Count | Note |
|---|---|---|
| seek (point queries) | 45.1 M | |
| tread points | 31.4 M | 688 k wheelContact calls, 233 k with the full 125-point footprint |
| pointContact / Near / Held | 3.7 M / 9.0 M / 1.7 M | cage + belly points |
| offer solids (x9, before the always index) | 541 M | 12 RigSolids patches, 6 enabled lamp poles of 0.2 m, scanned by every query; 280 box passes, 0 accepts |
| offer solids (x10, always index) | 10.2 M | |
| offer tops | 166 M | 51 M pass the box; then 22.9 M owner-rejected, 23.9 M off the roof grid (NaN), 2.4 M out of reach, 1.5 M accepted |
| offer statics | 0 | the disc ground takes the plain path (48.5 M plainOffer) |


Node fleet profiles (900 frames, same seed; self ms over the run): `offer` 1859 → 701 (x9 → x10), `seek` 955 → < 293; x10 matches the no-solids upper bound (x9ns `offer` 497). ≈ −2.3 ms per frame of ~16.
Skipping `find(live.solids)` entirely (not exact in general, exact for this run: 0 accepts): fleet mean 16.25 → 13.94 ms and 16.21 → 14.58 (−10…−14 %).

Earlier (count-c9dc): offer 1.079 B per 1500 frames; gridAt 91.8 M; wreck readPoints 17.3 M points almost all ungated.

Node city32 (aggression 1): 801 ms/sim-s; 27 wrecks; readPoints 17 µs inclusive per call; `measure` (cage-measure) 177 k calls/s; loadPoints ~27 ms/sim-s; rasterise ~25 ms/sim-s; stepLoose ~86 ms/sim-s; AI drive/think ~87 ms/sim-s.

## 5. A/B rows of each cut (ratio = new/old ms per sim-second; `same` = pose digest equal)

| Cut | city16 | a0c16 (clean oval) | a1c32 | fleet 32 mean ms | Exact |
|---|---|---|---|---|---|
| ecbc560e tops gate + near-tops lists | 0.914–0.93 | 0.91–0.99 | 0.967 | 2–4 % (pre-deterministic harness; unreliable) | yes (0 rows lost; disagreement counter) |
| x9 plainChecks (fleet disc on the plain path) | 0.962–0.974 | 1.00 (order noise ±3 %) | 0.958–0.999 | — | yes |
| x10 always index (solids) | 0.977/0.997 | order noise | 0.948/0.975 | 18.46→18.23, 19.86→17.44 (load 5) | yes (digests equal; disabled/far patches only) |
| x11 STEPS 12→6 tread arcs (probe) | — | — | — | 16.23→16.11, 18.96→14.36 (noisy) | NO (digest 1822279811) |
| x8 (plainOffer always testing box+disc) | 0.976–1.009 | 1.02–1.04 | ~1.0 | — | yes, but slower on clean rows → replaced by x9 |
| fixedTop (solids in every gate) | — | 1.04–1.08 | — | — | dropped |
| decimate memo (bf40d8d3) | load-time only: node cold build of 6 styles 1.9–2.2 s → 0.12–0.16 s | — | — | — | yes (bit-identical cages) |
| ragdoll fitter (1b2e9746) | — | — | — | fit 0.561× (1571 fits, 0 disagreements) | yes |
| pair contact (c0f161e3) | — | — | — | `deepestIn` 2435/2470 → 1657/1576 ms per run; mean 14.7/14.9 → 14.1/14.0 | yes (0 wrong rejects / 124 k) |
| loose double-step (c75bca24) | 0.93 / 1.00 by arm order (lane's rows) | — | — | — | NO: debris only (REPLAY 67); car digests same |
| read chain (c98aed7d, 7edb9359) | 0.917–0.979 | 0.911–0.961 | 0.920–0.990 | noise | yes (0 bad hits / 142 k; 0 bad rows / 43 k) |
| **Batch: main 7edb9359 vs ecbc560e** (provisional: interleaved, load 1.9–2.9, one arm order with ecbc560e first) | **0.871–0.880** (452 → ~395 ms/sim-s) | 0.90–0.95 | **0.868–0.870** | **17.4/17.2 → 13.9/14.4 (0.80–0.84); aftermath 27.7/26.7 → 21.7/22.5** | car digests equal on all rows and the fleet |
| **Phase 1 (REPLAY 68): main bbf470cc vs 0c8dd5c6** (worker box, load 1.0–1.2, both arm orders, 3 runs each) | 1.012–1.045 (base 612–630 ms/sim-s on the worker) | 1.020–1.122 | 0.999–1.060 | RAG=0: 19.70/19.96 → 19.40/19.54 (0.98); aftermath 30.51/30.85 → 30.21/30.38 | city16 and a0c16 digests equal (the gained solid rows meet nothing there); a1c32 and fleet differ by design. The a0c16 cost (up to +12 %) is the per-point `solidTop` asks of 1.3: 1.23 % more points read on city16 and 1.46 % on a1c32, 0 lost. |
| 2.2a wreck sleep (resting pile: 32 cars, 30 s real time, wreckage kept, last two thirds) | — | — | — | 16.24/16.15 → 12.85/12.50 ms at the chunk; 16.1 → 5.0 ms (0.31) with the moving-top rule, 32 of 32 asleep | sim (REPLAY 69) |
| 2.2b wreck points (stride 2), reverted | 0.905–0.919 / 0.965–0.971 by arm order (bar 0.95) | — | — | aftermath 30.8 → 29.1 (0.944, bar 0.92) | sim |
| 2.6 AI difficulty | hard: `same true`, 0.97–1.03; easy: 0.85–0.90 | — | — | — | hard exact |
| 2.1 tread arcs (STEPS 9; 6 and 8 broke engine-lab's house of cards), reverted | — | — | 0.834–0.882 | mean 19.31/19.04 → 18.25/18.09 (0.945, bar 0.92); aftermath 0.915 | sim |
| 2.3 coarse default | — | — | — | `PIN=auto` vs `PIN=fine` 1.00 (bar 0.90; lands per Assumptions) | sim (REPLAY 69) |
| 2.8 EDT ring box | 0.96–1.03 `same true` | `same true` | `same true` | aftermath 25.6/25.8 → 25.5 (0.99), digest equal | yes |
| 2.8 `REFIT_EPSILON` 2.5 cm, reverted (engine-lab 30 m/s throw) | — | — | — | aftermath 25.6 → 23.1 (0.90) | sim |
| 2.4 proxy refit throttle, reverted | — | — | — | RAG=1 aftermath 0.98/0.99 (bar 0.95) | car digests equal |
| 2.5 still tops for parts, reverted | 0.967–1.033 (bar 0.97) | — | — | resting pile 4.83 → 3.57 ms (0.74); probe: 3898 kept-asleep steps would have read a top row (bar 0) | car digests equal |
| 2.9 WASM raster + plan field, dropped (leads A8) | — | — | — | aftermath 0.979/0.986 (bar 0.95) | yes (bit-identical) |
| **Landing: Phase 2 (2.2a, 2.6, 2.3, 2.8 EDT) + Phase 4 minus 4.6 vs main da075e56** (worker, load 1.0–1.4, both arm orders) | 0.986–1.056 | 0.941–1.025 (`same true`) | 0.978–1.066 (`same true`) | RAG=0 0.99; RAG=1 aftermath 27.3 → 24.0 (0.88); resting pile 16.1 → 5.0 ms (0.31), 32 of 32 asleep | sim (REPLAY 69) |
| jit-tidy 259dec3c scene hooks: four stable engine functions, not a closure per scene | no timing (box busy: same-build wall swings 2.5×) | — | — | fleet 32, seed 4242, 1200 fr: digest 955787178 both | yes (engine-drive dam-spine digest 290651693 both; replay-fidelity, engine-replay-hold green) |
| jit-tidy 6d07b6c6 indexed loops (settleStep, pairMomentum, restoreMomentum, momentumAlong) | no timing | — | — | same digests | yes |
| jit-tidy 5479c7ea `skinKey` hashed once per rig, not per car (node, 32 sedans, first skin of each): total 50.8 / 36.9 ms → 24.2 / 19.4 ms; later cars 1.36 / 0.91 → 0.42 / 0.33 ms each | — | — | — | same digests | yes (key is a function of the rig object and its rest skin, both compared) |
| jit-tidy Firefox 155 headless, dam-spine 22 cars, one profile per arm (content process): Bailout 5345 → 5359, Invalidate 576 → 584, DiscardJit 2 → 2, GCMajor 2 → 2 | — | — | — | — | the three cuts do not change SpiderMonkey's bailout or discard counts: 2868/2881 are FirstExecution and ~2150 TranspiledCacheIR in prefabs, three, bench-loop and engine bundles; `engine` bundle 271 → 277 |
| **Query mask: aa902ea3 (owner / higher-origin rule applied in the asker's top lists) and `noneInReach` (a roof that answers none of a tyre's footprint left out of `wheelContact`'s list)**, counts only (box busy: no timing, Main times it idle) | — | — | — | tops `offer` calls from the held / near / tread lists, fleet 32 × 1500 frames: 100.8 M against the full lists → 53.3 M with (a) → 33.9 M with (a)+(b); every list incl. `seekAll`'s: 133.5 M → 66.2 M. Disagreement probe (answer over the cut list against the full list, per query, every field `report` reads): 0 of 39.3 M fleet, 0 of 9.3 M city16, 0 of 9.3 M dam-spine22 | yes: pose digests equal to cfd9b773 on fleet (704141413), city16 (-300601433), dam-spine22 (-1924107701); replay-fidelity, engine-replay-hold pass |

Owner's Firefox desktop bench of the jit-tidy and query-mask cuts (J27, 2026-10-14, same sim both arms, 9283bb58 without them → 7d8c2549 with them; sim ms per sim-s, cpu ms per frame; Firefox frame times sit on a 4.17 ms grid, so fps and p50 are not compared). City 32 (Ultra): 626 → 512 (−18 %), cpu 9.58 → 8.14 (−15 %). Dam-spine 22 (Ultra): 409 → 414, cpu 5.44 → 5.32 (flat). Bench 28 (High), from a first B run that had the A tab still open: 349 → 342 (flat); that run's dam-spine read 468, which the isolated rerun did not repeat. Single runs per arm. Owner: same or better, keep.

Phase 1 fleet settle (1.1; 32 cars, seed 4242, 12000 frames = 2.84 sim-s, RAG=0, worker): 0c8dd5c6 last hit at 1.67 s, a wreck still gliding at 3.81 m/s at 2.83 s; bbf470cc last hit at 1.62 s, every wreck under 0.5 m/s from 1.75 s (0.13 s after it), the fastest at 0.13 m/s at the end. Bar (< 0.5 m/s within 3 s of the last hit) holds.

Against the morning build 7cf2c6f9 (601 ms/sim-s on city16) main is therefore ≈ 0.80 in node (provisional): 601 → ~395 ms/sim-s. Still 1.74× the pre-plan 227.

Whole-suite disagreement probe for the surface index (old full scan beside the index on every `offerAll`, 3555 tests): 0 of 5 665 837 353 queries.

`fleet5-wasm.mjs` (file: fetch shim, wasm skin): same digest as the JS skin at equal frame counts (−194727954 at 600 frames both ways), so the skins agree and the shim only changes cost. The earlier "32 wrecks vs 13" was a frame-count mismatch (`wrecks` counts cars whose mass solver is active at the last frame).

Pacer: node race rows run with no pacer (fixed 1/240 s floor slices); live phones run coarse 1/120 s. The bench cards compare fine vs coarse.

## 6. Harnesses

- `scratch-CostProfile3/drive.mjs` (+ `rows.sh`, `row1.sh`): headless race, two trees alternating chunks; env ROOTS, CARS, POLICE, AGG, SECS, WARM, TRACK, SEED, MODE=count|alloc, PROF.
- `fleet-bench/fleet5.mjs`: real CrashEngine headless, fake clock 1/60 s per frame, pacer pinned fine (`PIN=coarse` for 1/120); deterministic (digest 795525135 at x7–x10). **Does not run the ragdoll system** (Rapier never finishes loading: no yields); a variant that preloads Rapier trips a `RuntimeError: unreachable` in `glassTouch` → `torso.contactCollider(pane)` (reverse query does not trap; cause unknown; browser `tick` catches it, `advance` does not).
- `fleet-bench/fleet5-wasm.mjs` (Phase 1 on): preloads the ragdoll unless `RAG=0` and counts tick errors (0 at cost-p1: the pane-first `glassTouch` query no longer traps); `PIN=auto` leaves the slice to the pacer (pin null, adaptive off); settle fields in engine sim seconds (`lastHitSim`: a wreck's quietTime fell; `lastFastSim`: a wreck ≥ 0.5 m/s). cost-p1 RAG=1: mean 26.6 ms, digest 1987993139, against RAG=0's 1869913629: the dummies feed the sim (the fleet clock's slow-mo also covers 1.14 sim-s against 0.28), a lead for `hitGlass`/`smashGlass`.
- `city-prof/inject*.mjs`: call-counter injection into scratch copies.
- Profiles: `owner-traces/chrome/cpuprof-map.cjs` (self/inclusive per function), `callers.cjs` (caller chains).
- All timing/counting on this box goes through `flock ~/crash-wt/ab.lock`.
