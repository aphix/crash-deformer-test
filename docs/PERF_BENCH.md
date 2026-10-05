# Perf bench: main 4677c4b vs baseline a74c56e

Both builds are the production `.output` already built (main `4677c4b`, base `a74c56e`, 89 files / +8.4k lines of `src` between them). Target: 240 Hz play, so the budget is **4.2 ms per frame** (16.7 ms = a dropped 60 Hz frame). Everything ran under `capped` (4 GB cgroup), one browser and one app server at a time, inside `heavy-slot --exclusive`. Raw per-run JSON: `.bench/out2/` (not committed, `.bench` is gitignored).

## Verdict

- **No config is hitch-free at 240 Hz on either build.** Every config has frames over 4.2 ms and over 16.7 ms on base *and* main. Those worst frames are the browser/GL driver blocking, not game JS (see "Hitch attribution").
- **The sim itself did not regress.** Headless step cost is within 0–13 % (p50) of base at every car count; 32 cars: 1.97 vs 1.91 ms p50.
- **Browser frame cost: two configs looked worse on main**, both render-side: **fleet 32** (median p50 7.25 vs 3.5 ms, but main runs span 4.6–9.6 and base 3.0–4.5, and the GPU was shared) and **derby 24** (p95 13.4 vs 6.1 ms, frames over 16.7 ms 168 vs 44; the two main runs 165–172, the two base runs 15–72). **Derby 24 did not reproduce on re-run (§6: 3 × 3, >16.7 ms frames base 60–189, main 76–105).** fleet 8, race city and race stunt are inside the repeat spread (race stunt/city p95 spread is as wide as the base-vs-main gap).
- Suspects for the render-side cost are listed below; they are inferred from the diff and the profile, **not bisected** (no extra builds, as instructed).

## 1. Headless sim cost (node, no browser, no GPU)

One step = one 1/60 s frame of the engine's sim path: `physicsSlice` loop of `stepWorld` + `settleStep`, then every car's `updateSkin` (the frame's mesh write; the crush's solve, part tears, lamps and glass run per step inside `settleStep`: `stepBreakage`) (what `CrashEngine.tick` does minus render, camera, FX, HUD). Fleet: `layoutFleet` with HUD default speeds 10–32 m/s (cars crash into each other within the first second). Derby: 24 AI cars through `DerbyMatch` as in `engine.fixedStep`, bowl clip on. 60 warm-up steps, then 600 timed steps, 3 repeats, run twice per build (base, main, base, main), so 6 repeats per cell. Cells: median over the 6 repeats (min–max in brackets). A step covers 1/60 s of sim time; a 240 Hz render frame advances a quarter of that.

| cfg | build | p50 ms | p95 ms | p99 ms | max ms (worst of 6) | allocated MB / 600 steps | heap retained after GC (MB) |
|---|---|---|---|---|---|---|---|
| fleet 2 | base | 0.05 (0.04–0.05) | 0.11 (0.07–0.15) | 0.28 | 0.97 | 2.03 | 0.14 (max 0.5) |
| fleet 2 | main | 0.05 (0.04–0.06) | 0.09 (0.06–0.17) | 0.15 | 0.92 | 6.21 | 0.09 (max 0.51) |
| fleet 8 | base | 0.18 (0.17–0.21) | 1.06 (0.68–1.42) | 2.16 | 4.68 | 8.07 | 0 (max 0.05) |
| fleet 8 | main | 0.21 (0.2–0.23) | 1.58 (1.26–2.44) | 2.47 | 3.32 | 4.87 | 0.05 (max 0.06) |
| fleet 16 | base | 0.69 (0.6–0.76) | 5.97 (5.23–6.64) | 7 | 8.65 | 29.82 | 0 (max 0.01) |
| fleet 16 | main | 0.75 (0.65–0.8) | 6.09 (5.61–7.09) | 7.59 | 9.05 | 28.88 | 0.01 (max 0.05) |
| fleet 32 | base | 1.91 (1.71–1.94) | 14.64 (14.33–15.45) | 18.21 | 22.37 | 44.17 | 0.02 (max 0.02) |
| fleet 32 | main | 1.97 (1.81–1.98) | 15.06 (14.39–15.69) | 19.53 | 21.5 | 53.61 | 0.02 (max 0.03) |
| derby 24 | base | 3.44 (3.11–3.5) | 4.73 (4.18–4.93) | 5.12 | 6.64 | 51.67 | 0.08 (max 0.23) |
| derby 24 | main | 3.48 (3.26–3.67) | 4.99 (4.36–5.23) | 5.58 | 6.58 | 59.55 | 0.12 (max 0.28) |

Reading: the p95 of the larger fleets is the crash-pile phase (all pairs in contact); steady state afterwards is the p50. Main is +3 % p50 at 32 cars, +1 % derby, +13 % at fleet 8 (0.03 ms absolute). Heap retained after GC is noise-level everywhere (< 0.5 MB, no leak at 600 steps). Allocation churn is a little higher on main at 32 cars and derby (+21 % / +15 %), a fleet 8 sample is lower; none retained.

## 2. Browser CPU frame cost (`CrashEngine.advance`, render on every frame)

Synthetic fixed dt 1/240 s (fleet, derby; 20 s = 4800 frames) or 1/120 s (race; one lap, capped at 90 s), `render: true`, 1280x800, hardware GPU (ANGLE / D3D12, RTX 4080 Laptop), default vsync-paced Chromium launch. Per frame we time `tickInner` (sim + camera + FX + `renderer.render`) and count draw calls. Each cell is one config per `heavy-slot --exclusive` run: base and main back to back (order flipped on the second repeat), 2 repeats (fleet 32: 4). Scene fade off (harness), FX tier high, seeded scene.

### Summary (median across repeats; min–max in brackets)

| cfg | build | runs | p50 med (range) | p95 med (range) | p99 med | >4.2 ms med | >16.7 ms med (range) | draws p50 med | CPU ms/frame med |
|---|---|---|---|---|---|---|---|---|---|
| derby:24 | base | 2 | 4.15 (3.9–4.4) | 6.05 (5.6–6.5) | 18.05 | 2196.5 | 43.5 (15–72) | 378 | 3.69 |
| derby:24 | main | 2 | 4.6 (4.4–4.8) | 13.4 (11.9–14.9) | 26.85 | 2917.5 | 168.5 (165–172) | 441.5 | 4.06 |
| fleet:32 | base | 4 | 3.5 (3–4.5) | 13.45 (12.9–13.9) | 32.9 | 1928 | 90 (72–118) | 451 | 5.16 |
| fleet:32 | main | 4 | 7.25 (4.6–9.6) | 13.35 (12.9–72.8) | 64.1 | 4102 | 145 (70–1509) | 528 | 7.15 |
| fleet:8 | base | 2 | 1.8 (1.7–1.9) | 4.6 (3.8–5.4) | 10.25 | 278.5 | 10 (10–10) | 196.5 | 1.56 |
| fleet:8 | main | 2 | 1.7 (1.7–1.7) | 6.6 (5.7–7.5) | 12.75 | 472.5 | 28.5 (24–33) | 161 | 1.5 |
| race:city | base | 2 | 1.9 (1.8–2) | 6.85 (3.9–9.8) | 18.55 | 566.5 | 37 (9–65) | 104.5 | 1.97 |
| race:city | main | 2 | 2.4 (2.1–2.7) | 7.9 (3.9–11.9) | 20.3 | 1144 | 51.5 (6–97) | 148.5 | 2.22 |
| race:stunt | base | 2 | 1.35 (1.3–1.4) | 3.2 (2.9–3.5) | 10.2 | 157 | 11.5 (7–16) | 115 | 1.17 |
| race:stunt | main | 2 | 1.4 (1.3–1.5) | 6.05 (4.1–8) | 11.45 | 580.5 | 20 (8–32) | 134 | 1.27 |

Race rows are not like for like: base has no Auto spectate (it follows the leader, `spectating: Titanium` with no `auto` flag); main runs the Auto spectator camera on both tracks (watch id -1; the stunt row is Auto spectating on stunt). So main's race rows include the sight-line search that the `cc12b13` merge budgets to 1.2–1.5 ms worst.

### Every run

| cfg | build | run | load1 before→after | frames | p50 | p95 | p99 | max | >4.2 ms | >16.7 ms | draws p50 / max | CPU thread ms/frame | GPU clock start |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| derby:24 | base | r1 | 1.21→2 | 4800 | 4.4 | 6.5 | 22.9 | 1675.8 | 2646 | 72 | 376 / 507 | 3.83 | 2460MHz P0 |
| derby:24 | main | r1 | 1.4→1.72 | 4800 | 4.8 | 11.9 | 28 | 2286.8 | 3147 | 172 | 456 / 536 | 4.21 | 2460MHz P0 |
| derby:24 | base | r2 | 1.01→1.59 | 4800 | 3.9 | 5.6 | 13.2 | 508.3 | 1747 | 15 | 380 / 455 | 3.55 | 2460MHz P0 |
| derby:24 | main | r2 | 1.26→1.6 | 4800 | 4.4 | 14.9 | 25.7 | 1556.8 | 2688 | 165 | 427 / 482 | 3.9 | 225MHz P5 |
| fleet:32 | base | r1 | 1.16→1.73 | 4800 | 3 | 12.9 | 24 | 4170.2 | 1461 | 118 | 351 / 851 | 3.85 | 1110MHz P3 |
| fleet:32 | main | r1 | 1.49→1.52 | 4800 | 9.6 | 72.8 | 100.6 | 9294.8 | 4400 | 1509 | 540 / 762 | 7.39 | 210MHz P4 |
| fleet:32 | base | r2 | 1.46→1.65 | 4800 | 3.7 | 13.1 | 32.6 | 1488.4 | 2033 | 95 | 365 / 856 | 4.89 | 2475MHz P0 |
| fleet:32 | main | r2 | 1.45→1.93 | 4800 | 7.2 | 13.3 | 47.3 | 1756.9 | 3949 | 165 | 516 / 785 | 6.9 | 2475MHz P0 |
| fleet:32 | base | r3 | 1.16→1.48 | 4800 | 3.3 | 13.9 | 36.4 | 2746.5 | 1823 | 85 | 539 / 812 | 5.43 | 2460MHz P0 |
| fleet:32 | main | r3 | 1.19→1.71 | 4800 | 4.6 | 12.9 | 63.5 | 3348.2 | 2866 | 70 | 461 / 875 | 5.36 | 2460MHz P0 |
| fleet:32 | base | r4 | 2.04→2.74 | 4800 | 4.5 | 13.8 | 33.2 | 2104.6 | 2760 | 72 | 537 / 833 | 5.49 | 2460MHz P0 |
| fleet:32 | main | r4 | 1.32→2 | 4800 | 7.3 | 13.4 | 64.7 | 3460.2 | 4255 | 125 | 546 / 743 | 7.8 | 2460MHz P0 |
| fleet:8 | base | r1 | 1.66→1.43 | 4800 | 1.7 | 5.4 | 10.7 | 966.9 | 361 | 10 | 179 / 255 | 1.47 | 375MHz P5 |
| fleet:8 | main | r1 | 1.01→1.3 | 4800 | 1.7 | 5.7 | 12.8 | 193.6 | 340 | 33 | 153 / 260 | 1.52 | 300MHz P5 |
| fleet:8 | base | r2 | 1.19→1.47 | 4800 | 1.9 | 3.8 | 9.8 | 50 | 196 | 10 | 214 / 256 | 1.64 | 690MHz P4 |
| fleet:8 | main | r2 | 0.87→1.19 | 4800 | 1.7 | 7.5 | 12.7 | 705.7 | 605 | 24 | 169 / 262 | 1.48 | 615MHz P5 |
| race:city | base | r1 | 1.17→1.14 | 4920 | 1.8 | 3.9 | 10.4 | 1077 | 169 | 9 | 97 / 267 | 1.88 | 2460MHz P0 |
| race:city | main | r1 | 0.83→1.18 | 5040 | 2.1 | 3.9 | 8.7 | 1118.2 | 191 | 6 | 157 / 267 | 2.18 | 2460MHz P0 |
| race:city | base | r2 | 1.52→2.32 | 5160 | 2 | 9.8 | 26.7 | 1206.2 | 964 | 65 | 112 / 267 | 2.05 | 405MHz P5 |
| race:city | main | r2 | 1.13→1.14 | 5520 | 2.7 | 11.9 | 31.9 | 1209.3 | 2097 | 97 | 140 / 287 | 2.25 | 285MHz P4 |
| race:stunt | base | r1 | 1.72→1.7 | 5280 | 1.3 | 2.9 | 9.3 | 1022.7 | 165 | 16 | 115 / 169 | 1.09 | 1665MHz P0 |
| race:stunt | main | r1 | 1.35→1.48 | 5280 | 1.3 | 8 | 12.4 | 1089.5 | 917 | 32 | 134 / 173 | 1.2 | 210MHz P5 |
| race:stunt | base | r2 | 1.02→1.23 | 5280 | 1.4 | 3.5 | 11.1 | 1006.4 | 149 | 7 | 115 / 169 | 1.24 | 2475MHz P0 |
| race:stunt | main | r2 | 1.47→1.47 | 5280 | 1.5 | 4.1 | 10.5 | 997.9 | 244 | 8 | 134 / 173 | 1.33 | 2475MHz P0 |

Load 1 = 1-minute `/proc/loadavg` read by the harness at start and end of the config; every run started with load <= 2.2 (gate: refuse above 4; no run was refused). The GPU was **not idle**: `nvidia-smi` shows 30–55 % utilisation at P0 (2460 MHz) from other tenants during most runs, and a few runs began at P4/P5 clocks (see column). That is the main confounder.

### Per-second series (fleet 32, repeats 3 and 4)

Median tick ms and draw calls per sim second, copied from `perSec` in the JSON:

| run | tick ms p50 per second (20 s) | draws per second |
|---|---|---|
| base r3 | 2.7 2.6 2.7 2.8 2.8 2.8 3.9 3.5 6.8 9 8.3 9.4 12.5 14.1 8.6 3.3 3.2 3.1 3 3 | 557 595 624 638 657 662 662 391 393 536 533 472 803 796 768 248 244 243 250 250 |
| main r3 | 4.2 4.2 4.6 4.5 5.1 4.8 3.3 3.1 3 4.6 5.7 12 13.6 4.4 3.9 3.6 4.3 7.9 7.1 6.9 | 634 627 642 642 642 627 364 312 306 460 565 530 469 316 314 311 428 741 458 460 |
| base r4 | 2.9 3 3 4.2 4.5 4.4 4.3 3.6 4.5 7.8 9.8 13.8 12.3 5.3 5.1 4.8 4.8 4 3.7 3.5 | 581 608 621 625 617 609 577 409 405 530 746 821 805 510 531 503 537 331 299 289 |
| main r4 | 6.4 7.2 7.4 7.2 7 5.6 6.4 12.3 9.5 3.6 3.3 5.1 5.8 6.3 7.3 8 8.7 10.8 12.8 12 | 614 562 535 495 479 299 403 723 724 302 299 460 435 542 564 583 541 713 704 697 |

Cost follows draw calls (the idle orbit camera frames 300–800 draws as it swings; the camera path differs between builds, so draws per second are not aligned). At comparable draws main's per-draw cost is higher in r2/r4 and the same in r3 (main r3 median 4.6 ms vs base r4 4.5), which is why the fleet-32 verdict stays "likely, not certain".

## 3. Hitch attribution (CDP Profiler, no Tracing)

Short windows (12 s sim, `--profile`, sampling every 200 µs; one run per row). Every frame over 16.7 ms is attributed by sample self time:

| run | frames > 16.7 ms | GL call ms | JS ms | GC ms | top self functions in those frames (ms / frames hit / worst single frame) |
|---|---|---|---|---|---|
| main fleet 32 | 26 | 672 | 203 | 0.3 | `uniformMatrix4fv` 412.9 / 25 / 41.0; `uniformMatrix3fv` 86.5 / 10 / 43.6; `uniform3f` 53.9 / 9 / 26.4; `bindVertexArray` 38.0 / 13 / 25.4; `drawElements` 37.6 / 12 / 10.0; `bufferSubData` 17.2 / 14 / 5.5 |
| base fleet 32 (for contrast) | 64 | 2032 | 900 | 2.1 | `uniformMatrix4fv` 1344.4 / 50 / 88.4; `uniformMatrix3fv` 287.0 / 25 / 48.4; `drawElements` 243.9 / 18 / 48.0; `bindVertexArray` 65.5 / 35 / 46.9; skin-kernel wasm 55.5+38.3; `updateWorldMatrix` 45.9; `clampMass` 37.2 |
| main derby 24 | 54 | 2272 | 318 | 1.1 | `bindVertexArray` 1297.9 / 27 / **1283.2**; `uniformMatrix4fv` 684.0 / 51 / 96.6; `drawElements` 122.1 / 19 / 16.0; `uniformMatrix3fv` 72.6 / 11 / 21.2; `uniform3f` 33.9; `useProgram` 21.4 / 2 / 21.2; `bufferSubData` 11.5 |

- 69–88 % of the time in the over-16.7 ms frames is a **WebGL call blocked in the driver** (the first uniform or VAO call after a pending GPU operation). The worst frame of main derby (1292 ms) is one `bindVertexArray` of 1283 ms; main fleet 32's worst (60 ms) is one `uniformMatrix3fv` of 43.6 ms.
- Game JS (sim, skin wasm, camera) is 12–31 % and shows up as sub-2 ms pieces. GC is under 3 ms total in all three windows; no GC hitch.
- In this window main fleet 32 was **not** slower than base (p50 3.7 vs 3.4 ms, 26 vs 64 frames > 16.7 ms), so the fleet-32 gap above is not reproducible in every run; the driver stall looks load- and GPU-state-dependent (shared GPU).
- The multi-hundred-ms first frames (max column, 0.5–9 s) are first-use costs after `reset()` with the harness scene fade turned off (shader link, VAO/buffer creation). Main has the scene fade, which holds the new scene black through the first-use warm-up (up to 3 s), so these should not be visible in real play on main; base has no hold.

## 4. Suspect merges (`git log --merges --first-parent --format='%h %s' a74c56e..4677c4b`, 27 merges)

Regression candidates with evidence, ordered by how well the evidence fits. None bisected.

1. **c299a0c panel-hole** and **e2e590b panel-detach**. They add a per-vertex `primer` attribute to the car paint material (`car-materials.ts withPrimer`, `car-panels.ts`, `car-parts.ts`) and a per-frame panel/skin update. That is more vertex data to upload per car per frame: the main profile shows `bufferSubData` and `bindVertexArray` in the hitch frames, `uniformMatrix*` dominates in both builds. Headless mesh count per car is **identical** (20 meshes, same triangles) on both trees, so the extra draw calls (derby 378 -> 442 median) do not come from the car group itself.
2. **d4501c1 spectate-auto** / **cc12b13 cam-polish** / **5c50fc1 cam-fix**: change the camera path and its draws (main shows more draws in derby 24 and race city/stunt). They explain a different draw count per second, not a per-draw price.
3. **f1a3bc4 scene-fade** (+ **4e7eb5e**, **f4fefb7**): adds a cel branch in the composite shader (`uCel`, a uniform-gated branch; off in this harness because the harness sets `fadeScenes = false`), so it should be free here. It does change what the warm-up costs in real play (see above).
4. Ruled out by the headless numbers: the sim/contact merges (**b03a874 sim-fix**, **d4470ff wheel-loss**, **d2411b8 launch-weight**, **4c445c3 fx-witness**). Headless sim at 32 cars is 1.97 vs 1.91 ms p50; skin kernel wasm is under 20 ms in main's hitch frames per 12 s window (base: 94 ms).

To settle fleet 32 and derby 24, the cheapest next step is a pair of builds at **c299a0c^** and **c299a0c** run with the same harness on a quiet GPU, plus `--profile` with Tracing for GPU-process time. Not done here.

## 5. Method and limits

- **Vsync-paced, synthetic dt.** The browser runs use the default vsync-paced Chromium launch, no uncapped flags, and call `advance(1, { frameDt })` with a fixed 1/240 s (1/120 s in races) and `render: true`, not requestAnimationFrame. The numbers are the **CPU cost of the frame the engine does per rendered frame** (sim, camera, FX, `renderer.render` submit), reproducible and independent of the compositor's pacing. They are not a measurement of delivered frame rate or of display pacing at 240 Hz.
- **GPU time is not measured.** Chromium tracing with GPU-process categories and an uncapped frame rate (the previous attempt) crashed the VM twice, so neither a GPU-load page, an uncapped frame rate nor tracing was used. The `tick` still contains GL driver blocking, so GPU contention appears in it (see attribution), and the box's GPU was shared with other tenants (30–55 % utilisation at P0 during runs). A GPU-bound frame is therefore under-reported by the part the driver doesn't block on.
- **Repeat spread is large.** 2 repeats per config (4 for fleet 32), base and main alternating; the GPU clock state at start differed between runs. Treat differences smaller than the min–max in the tables as noise. Window: one scene run from `reset()`, so the first-use frames after reset are in every max column.
- **Race rows differ in workload** (Auto spectate only on main) and race length differs (base 33–36 s, main 34–38 s of sim).
- **Headless step excludes** render, camera, FX, HUD, race director, and the derby director; derby 24 uses the derby AI and match scoring only.
- Harness: `.bench/harness/headless.mjs`, `adv.mjs` (tracing and uncapped flags removed), `run-one.sh`, `matrix.sh`, `prof.sh`; not committed.

## 6. Re-run (derby 24, 3×3)

Same prebuilt outputs (a74c56e, ad535e3), same safe `adv.mjs` settings, alternating order b/m, m/b, b/m, one `heavy-slot --exclusive` hold per run. Columns: p50 / p95 / max ms, frames over 16.7 ms, draws p50, CPU ms/frame, GPU clock and utilisation at start→end, 1-minute load start→end. Every run: 63 programs, 0 linked after frame 0.

| build | run | p50 | p95 | max | >16.7 ms | draws | CPU | GPU start→end | load |
|---|---|---|---|---|---|---|---|---|---|
| base | r1 | 4.0 | 15.7 | 1417 | 189 | 384 | 3.47 | 555 MHz P5 23 % → 2475 P0 48 % | 3.08→3.09 |
| main | r1 | 4.8 | 7.0 | 481 | 103 | 441 | 4.28 | 2460 P0 52 % → 2460 P0 59 % | 2.77→2.72 |
| main | r2 | 4.6 | 9.9 | 1620 | 105 | 420 | 4.07 | 2460 P0 51 % → 2460 P0 56 % | 2.51→2.89 |
| base | r2 | 5.0 | 7.4 | 1012 | 60 | 400 | 4.45 | 2460 P0 57 % → 2460 P0 50 % | 2.99→4.04 |
| base | r3 | 4.8 | 7.8 | 721 | 62 | 394 | 4.21 | 2460 P0 51 % → 2460 P0 63 % | 3.22→3.47 |
| main | r3 | 4.8 | 8.0 | 1744 | 76 | 442 | 4.23 | 2460 P0 51 % → 2460 P0 55 % | 2.90→3.43 |

- **Not reproducible.** Frames over 16.7 ms: base 60–189, main 76–105; p50 (4.0–5.0 vs 4.6–4.8) and p95 (7.4–15.7 vs 7.0–9.9) overlap too. No bisect was run.
- **Pooled with §2's derby 24 runs** (base 15, 60, 62, 72, 189; main 76, 103, 105, 165, 172): exact one-sided Mann-Whitney p = 0.075 (U = 20 of 25). Leans main-worse, but it mixes two sessions with different box load; detecting a small effect would need about 8+ repeats per build in a quiet window.
- **Hitches are ~1 s bursts of 20–77 consecutive frames over 16.7 ms on both builds** (base r2 sim-second 7: 45 frames; main r2 second 8: 77), and the 189-frame base run began on a cold GPU clock. Browser-thread CPU per frame is equal (medians 4.21 base, 4.23 main), so the stalls are GPU/driver waits, not JS.
- **Draws are the one reproducible difference:** p50 420–442 on main vs 384–400 on base (about +47), no overlap. Sim-seconds 0–4 (before the first crash, frame ~1279) are identical on both builds (285/287/287/286/287); after damage main runs 20–100 draws above base. Probably post-damage panel shells and glass joining the scene (`openPanel` adds the shell mesh); **not enumerated**.

## 7. In-app bench: `/crush/?bench=city`

For a device the harness can't reach (the phone). Open `…/crush/?bench=city`; nothing else changes without the flag (the module `engine/engine-bench.ts` is its own chunk, fetched only then). It sets up city, 15 AI racers plus the player's car (follow camera, the AI drives it), traffic and up to 6 police (32 cars), seed 1, aggression 1; the engine's own rAF loop is stopped and each rAF feeds `advance(measured wall dt, render: true)`, the same `tickInner` the loop runs, so the pacer's real 8 ms deadline applies. It waits out the grid and 20 s of race clock (police park from a third of a lap on), samples 30 wall seconds, and prints one card over the game: fps (mean, 1 % low, by thirds so a throttling device shows), **sim speed** (race-clock seconds per wall second, from `SimPacer.lost`/`cut`), frame / CPU / sim / draw ms (p50 p95 p99 max), steps per frame and ms per step, GPU ms (timer query, absent on some devices), calls and triangles, load times, GPU string, cores, screen, dpr, canvas size and ratio, FX tier. The result is also `window.__benchResult` and a `CRUSH BENCH {json}` console line; the race plays on under the card. A phone's fx tier is its own (`AutoFx`); add `&fx=minimal` to force one.
