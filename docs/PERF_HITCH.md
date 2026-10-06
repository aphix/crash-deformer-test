# Race hitching: measurements, causes, fixes

Owner's report: significant hitching during races. Asked for: drop complex visuals unless they are close to the camera, and a new default `minimal` FX tier below `low` with no post-processing at all.

Everything below was measured on the shared dev box (RTX 4080 Laptop through WSL d3d12, Chromium via ANGLE/GL, 1280×800, DPR 1) with the probes in `.bench/perf-race/` (`race.mjs`, `after.mjs`, `control.mjs`, `draws.mjs`, `visual.mjs`, `progdiff.mjs`). Each race run: a fresh browser, 8 cars (7 AI + the player car, which rides the AI racing line), 60 s from the start command (so the countdown is in it), a CDP trace for every frame over 50 ms. Anything not listed here was not measured.

## How long frames are attributed
Per frame, in-page: `fixedStep` (physics), race director (`drive` / `collide` / `step` / `frame`), `emitHud`, FX updates, `Cinematics.update`, lamp pool, skinning, camera, `renderer.render`, and time inside WebGL program / texture / sync / framebuffer / buffer calls. From the trace: GC, other main-thread tasks, layout, and the GPU process main thread (`CrGpuMain`) busy time with its longest events. A frame whose own tick is short while the GPU process is busy the whole interval is "GPU process".

## Before (main 3f8eb23, first session, GPU clocked normally)
| course | tier | load | frames | p50 | p95 | p99 | max | >33 ms | >50 ms | programs linked mid-race | draw calls | causes of >50 ms frames |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| oval | low | 60–62 | 2690 | 16.9 | 45.2 | 64.4 | 130.3 | 346 | 87 | 3 | 224 | GPU process 86, shader link 1 |
| oval | off | 63–42 | 2811 | 16.8 | 40.2 | 61.5 | 151.5 | 263 | 70 | 1 | 221 | GPU process 69, render CPU 1 |
| rally | low | 42–54 | 2748 | 17.5 | 41.8 | 60.3 | 112.5 | 303 | 68 | 1 | 217 | GPU process 66, render CPU 2 |
| rally | off | 52–70 | 2831 | 16.8 | 44.6 | 66.6 | 172.3 | 277 | 95 | 0 | 192 | GPU process 94, tick 1 |
| city | low | 70–55 | 2424 | 20.1 | 45.2 | 63.3 | 285.3 | 379 | 78 | 3 | 282 | GPU process 74, shader link 3, other task 1 |
| city | off | 55–76 | 2218 | 19.3 | 57.7 | 76.8 | 262.8 | 498 | 181 | 2 | 265 | GPU process 177, shader link 2, GC 1, other task 1 |
| stunt | low | 76–60 | 2618 | 17.8 | 39.4 | 54.6 | 109.1 | 295 | 45 | 3 | 211 | GPU process 41, shader link 2, render CPU 2 |
| stunt | off | 60–38 | 3181 | 16.7 | 30.5 | 44.7 | 127.1 | 128 | 13 | 3 | 208 | GPU process 11, shader link 1, other task 1 |

Main-thread cost per frame (oval, means): physics 1.4–2.5 ms, race AI 0.2–0.5 ms, render 2.9–4.6 ms, HUD emit 0.02 ms, FX updates 0.01 ms, tyre marks + smoke + slip FX 0.03 ms, lamp pool 0.02 ms, skinning 0.14 ms, camera 0.02 ms. The main thread is not what's slow.

### Causes, in order of frames
1. **GPU process (≈95 % of >50 ms frames).** Our tick took 2–12 ms, then the GPU process main thread stayed busy for the rest of the 50–400 ms interval, mostly in `GLContextEGL::MakeCurrent`, `GpuChannel::ExecuteDeferredRequest` and `SwapBuffers` (the WSL d3d12 path). It scales with box load, and it is not the draw-call count:
   - A/B at FX off, oval, 2 rounds: halving the draw calls (all cars except the followed one body-only: 250 → 130 calls) or dropping the shadow pass (−60 calls) left the GPU process's CPU time per frame at 5.5–8.5 ms and its busy time in the load noise.
   - Later in the session `nvidia-smi` showed the GPU held at P8, 210–255 MHz (max 3105 MHz), 16–40 % utilisation during every run. From then on both builds run at 60–90 ms a frame, while a blank 1280×800 WebGL page in the same browser setup holds 16.7 ms (p99 16.8, one >50 ms frame a minute). In that state half resolution, no lamp lights, no shadows or fewer draws each moved the frame time by at most ~10 %.
2. **Program links mid-race, 75–330 ms each, 1–3 per run on main.** Two kinds:
   - programs never linked before the race (race-course art, traffic): main links them on first sight;
   - programs that were compiled but never drawn to the real output: their first draw checks the link and fetches every uniform location, all synchronous round trips to the busy GPU process (110–340 ms frames 8–58 s into a race in the first lane build, which only compiled the course). The first tyre-mark stamp is one of these.
3. **GC**, 30–64 ms pauses, about one a minute in both builds (allocation sites not measured).
4. **Physics spikes**, single frames where `fixedStep` alone took 26–48 ms, about one per course-minute (sent to CrashRealism8 with frames and times).

Not causes in races (measured above): HUD React (0.02 ms), FX emitters, tyre marks, lamp lights, skinning, texture uploads (no texture-upload frame over 50 ms).

## Fixes
- **Program warm-up.** `CrashEngine.ready` resolves after boot links every program play can reach: `PostFX.warm` compiles the scene for both outputs (canvas, HDR target) plus every post pass and composite. A hidden cracked-glass stand-in and the debug views are added. Then the scene is drawn with every mesh shown and unculled into the canvas and the HDR target, through a zero-area scissor so nothing lands, and the mark map's stamp and fade are drawn the same way. That links shadow-depth variants, fetches every uniform location and uploads every texture. The loop simulates and draws only after `ready`; from `start()` until then it reads input only (see "Input during the warm-up").
  - New scene content warms where it appears: a race course's art (`buildArt`) and new cars (`buildCar`) queue the same warm-up after the synchronous change, so it runs in the setup menu or the countdown. If the compile brought no new program (the city's traffic cars), the draws are skipped: they cost the GPU process 0.8–1.0 s at the city start.
  - Post render targets and the mark map are allocated once and resized with the canvas, so a tier switch allocates nothing.
  - Guard: `npm run check:programs -- --url <server>` (`scripts/check-programs.mjs`). Main: 45 programs after boot, 72 after the sandbox play. Lane: 61 = 61 after sandbox play (2 panes cracked); races: oval 79, rally 79, city 84, stunt 83 programs at the green light, 0 linked while racing. It needs a server and a browser (about 3 min), so it is a script, not a `test:app` test.
- **`minimal` tier, the new default** (`INITIAL_HUD.fxTier`, the `?fx=` default, Defaults). Order `off < minimal < low < high`. `minimal` renders straight to the canvas: no HDR target, bloom, grade, vignette, grain or blur. It keeps every effect that needs no post (tyre marks at 1024², tyre smoke, slip sparks, shake, FOV kick, hit-stop, crash-cam cuts) and draws sparks and glass plain (no streaks, no HDR glow). `off` stays because it differs: it also drops marks, smoke, hit-stop and crash cam. `minimal`'s programs are the canvas-output ones the warm-up already links.
- **Distance detail** (now `present/car-detail.ts`: a mid cut at 35 m and a far cut, the body alone, at 75 m, on a ladder the `DetailGovernor` walks; see docs/CINEMATIC.md; the text below is the original 35 m cut). A car further than that from the camera, never the followed one, takes its small parts that cast no shadow (lamp housings, trims, grille, mirrors, door linings: 16 of its 24 draws) off the camera's layer; `visible` stays the car's own. The interior stays: it shows through the 72 % glass. This was chosen from the draw breakdown: cars are 184 of 214 main-pass draws on the oval (23 per car); course art is 30, the shadow pass 17–22, FX points 3. The radius sits past the chase camera's view of the cars around the player.
  - Not cut, from the same measurements: FX spawns (0.01 ms a frame), tyre-mark stamping (0.03 ms), lamp-pool lights (0.02 ms on the CPU; an intensity-0 light costs the shader the same, and changing the light count relinks every lit program), skinning (0.14 ms; it already strides by projected size), shadows (the sun's shadow box is already 48 m around the followed car), course props (instanced: one draw per prefab part for the whole course, 30 draws and 40k triangles in total).
- **FX floor** follows `activeGround()`: debris, sparks and glass rest on the course surface (and keep falling past the fleet disc's rim) instead of clamping to y = 0.
- **Build:** three.js is its own vendor chunk via Rolldown `output.codeSplitting` (checked in the output: `three-*.js` 596 kB, imported by the engine and routes chunks). Engine 760 → 404 kB, routes 430 → 188 kB, total client JS unchanged at 1.59 MB. `chunkSizeWarningLimit` is 700 for the three chunk; the warning is gone.
  - Nothing new is lazy-loaded: the engine was already a dynamic import, and three is needed as soon as the route renders (the HUD imports `FX_TIERS` from `engine-post.ts`). Lazy-loading the Net panel and race menus would touch other lanes' HUD files for no first-play gain, so it was not done. Time to `__crush` ready was not measured.

## Visual identity (fixed seed, rAF frozen, `visual.mjs` / `viscmp.mjs`)
Near camera (every car within 35 m), lane vs main, day and night: `minimal` vs main's `off`, `low` vs `low` and `high` vs `high` all have a max channel difference of 0. With the camera 70 m out (`far`), the lane drops the small parts on every car: max channel difference 174 inside a 182×74 px box, 0.035 % of pixels.

## After (interleaved main 3f8eb23 vs lane, same session, GPU at P8)
One blank-WebGL control per course. The lane rows were measured before two follow-ups landed: the skip of the warm-up draws for traffic (the city's 787–997 ms start frames) and the uniform-fetch warm-up into the real outputs. See "Verification" for those.

| course | build | tier | load | GPU clock (mid-run) | frames | p50 | p99 | max | >33 | >50 | >50 after green | programs linked mid-race | draw calls | long-frame causes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (control) | blank WebGL | – | 23–19 | – | 1191 | 16.7 | 16.8 | 183.4 | 1 | 1 | – | – | – | – |
| oval | main | low | 19–14 | 255 MHz  P8 | 811 | 67.8 | 139.2 | 176.6 | 798 | 779 | 725 | 2 | 261 | GPU process 777, shader 2 |
| oval | lane | minimal | 14–13 | 210 MHz  P8 | 926 | 60.9 | 118.5 | 203.2 | 904 | 801 | 752 | 0 | 242 | GPU process 801 |
| oval | main | off | 13–13 | 210 MHz  P8 | 819 | 65.4 | 152 | 203.6 | 792 | 767 | 711 | 1 | 265 | GPU process 766, shader 1 |
| oval | lane | low | 14–14 | 210 MHz  P8 | 780 | 68.6 | 158.8 | 222.8 | 760 | 735 | 682 | 0 | 247 | GPU process 735 |
| (control) | blank WebGL | – | 14–13 | – | 1192 | 16.7 | 16.8 | 183.3 | 1 | 1 | – | – | – | – |
| rally | main | low | 13–13 | 240 MHz  P8 | 816 | 67.8 | 133.8 | 179.2 | 800 | 778 | 723 | 1 | 266 | GPU process 776, shader 1, otherTask 1 |
| rally | lane | minimal | 13–14 | 210 MHz  P8 | 824 | 67 | 153.3 | 229.8 | 809 | 773 | 727 | 0 | 257 | GPU process 772, otherTask 1 |
| rally | main | off | 14–42 | 210 MHz  P8 | 774 | 72.1 | 139.4 | 204.3 | 738 | 721 | 672 | 1 | 269 | GPU process 719, shader 1, otherTask 1 |
| rally | lane | low | 42–36 | 210 MHz  P8 | 682 | 79.9 | 180 | 350.5 | 645 | 632 | 585 | 0 | 260 | GPU process 632 |
| (control) | blank WebGL | – | 36–36 | – | 1202 | 16.7 | 16.8 | 216.6 | 1 | 1 | – | – | – | – |
| city | main | low | 36–61 | 210 MHz  P8 | 626 | 85.6 | 178.5 | 348.5 | 604 | 597 | 556 | 3 | 325 | GPU process 593, shader 3, otherTask 1 |
| city | lane | minimal | 61–74 | 210 MHz  P8 | 681 | 83.1 | 164.5 | 996.6 | 651 | 642 | 604 | 0 | 294 | GPU process 639, otherTask 2, physics 1 |
| city | main | off | 74–54 | 210 MHz  P8 | 641 | 83.2 | 194.1 | 373.6 | 620 | 610 | 568 | 2 | 326 | GPU process 608, shader 2 |
| city | lane | low | 54–52 | 210 MHz  P8 | 682 | 81.3 | 163.4 | 786.1 | 656 | 620 | 587 | 0 | 299 | GPU process 620 |
| (control) | blank WebGL | – | 52–42 | – | 1191 | 16.7 | 16.8 | 200 | 1 | 1 | – | – | – | – |
| stunt | main | low | 42–39 | 240 MHz  P8 | 810 | 70.4 | 138.2 | 194.8 | 775 | 747 | 691 | 1 | 273 | GPU process 745, shader 1, otherTask 1 |
| stunt | lane | minimal | 39–50 | 210 MHz  P8 | 915 | 63.5 | 126.8 | 166.8 | 869 | 830 | 773 | 0 | 251 | GPU process 828, tickOther 1, otherTask 1 |
| stunt | main | off | 50–64 | 210 MHz  P8 | 842 | 67.1 | 140.3 | 183.5 | 799 | 767 | 726 | 0 | 269 | GPU process 766, otherTask 1 |
| stunt | lane | low | 64–53 | 210 MHz  P8 | 759 | 73.5 | 141.1 | 581.7 | 722 | 695 | 651 | 0 | 258 | GPU process 693, otherTask 1, renderCpu 1 |

### Remaining long frames, by cause
- **GPU process (all but a handful, in both builds and every tier).** With the GPU at P8 the game is GPU-process-bound at 60–90 ms a frame, so nearly every frame is over 50 ms. The blank-WebGL control in the same setup holds 16.7 ms. This is the host's GPU power state, and it is not something the game can remove. In that state `minimal` was faster than main's `low` on every course (p50 60.9 vs 67.8 oval, 67.0 vs 67.8 rally, 83.1 vs 85.6 city, 63.5 vs 70.4 stunt), with 9–32 fewer draw calls.
- **Program links: 0 in the lane** (main: 1–3 per course run, 75–330 ms).
- **GC:** 1–2 pauses a minute, 30–64 ms, both builds.
- **Physics:** single frames with `fixedStep` at 26–50 ms, both builds. Attributed headless (RIG_ANALYSIS §6.10): the crush path's first run is unoptimised. On the 8-car oval the first pile-up frames (t = 6.7 s) took 12–29 ms against a 0.7 ms median. `warmCrashPath` now runs two throwaway crashes during the boot warm-up, which brings those frames to 7–9 ms (6 interleaved rounds). Not re-measured in the browser.

## Verification after the follow-ups (lane, minimal, 20 s, load 54–62, GPU at P8)
| course | p50 | p95 | p99 | max | programs linked | largest frames |
|---|---|---|---|---|---|---|
| city | 75.6 | 119.5 | 181.9 | 214.2 | 0 | 214, 188, 182 (start), 146, 143 ms: all GPU process |
| oval | 66.1 | 109.3 | 127.8 | 199.3 | 0 | 199 (start), 196, 128, 128, 127 ms: all GPU process |

The city start frame is down from 787–997 ms to 182 ms, and no frame has a program cause. `check:programs` passes on this tip: 61 = 61, and every course has 0 programs linked while racing.

## Fleet and derby (main low vs lane minimal, 10 cars, 30 s, 2 runs each, GPU at P8, load 19–46)
| scene | build | p50 | p95 | p99 | max | >50 ms | programs linked mid-play |
|---|---|---|---|---|---|---|---|
| fleet | main | 68.9 / 56.7 | 95.9 / 84.9 | 135.2 / 109.5 | 189 / 211 | 368 / 325 | 2 / 2 (shader frames) |
| fleet | lane | 59.4 / 72.0 | 90.4 / 107.7 | 108.7 / 139.0 | 219 / 197 | 324 / 380 | 0 / 0 |
| derby | main | 74.2 / 76.2 | 118.3 / 115.2 | 167.7 / 165.5 | 257 / 266 | 346 / 342 | 1 / 1 (240–251 ms frames at 20–22 s) |
| derby | lane | 72.8 / 74.0 | 107.3 / 109.8 | 149.3 / 147.9 | 153 / 709 | 377 / 342 | 0 / 0 |

Not worse, within the run-to-run spread, and the program-link frames are gone. One lane derby run had a 709 ms frame at 27 s: a 486 ms main-thread task outside the frame loop, with no program link and no texture change. Not attributed further.

## Input during the warm-up (follow-up)
The first version started the loop only once `ready` resolved, and input is read in the loop (`pollInput`: keys and pad into the seat, follow → drive). A press during the 2.3–4.0 s warm-up was lost. `.bench/board-click.mjs` presses W 0.2–0.4 s after `__crush` appears, so on main 937e631 the seat stayed in follow. Its Space hold then paused the game (`playing: false`) instead of braking. That was 2 of 2 runs; with the probe waiting on `ready`, main gave drive and `playing: true`.

Now the loop runs from `start()`. Until `ready` it only reads input, then it simulates and draws. The unchanged probe gives drive, then `playing: true`, in 3 of 3 runs, with W pressed 0.17–0.22 s after `__crush` and `ready` at 2.3–4.0 s.

## GC during races (follow-up)
Measured with the sampling heap profiler, including objects already collected (`.bench/perf-race/alloc.mjs`): 8 cars, minimal tier, 30 s of steady state from 14 s after the green light, dev server.
- Allocation runs at 24–30 MB/s. That gives a scavenge about every second (max 2–7 ms) and 1–2 major GCs per 30 s (9–38 ms).
- About 20 MB/s of it is physics: `sat.ts` `satTwoHulls`, `streamed-deform.ts` (`clampLocal`, `followGroup`, `skin`, `stepMassSlice`, `yawMomentum`, `stepShapeMatch`, `liveHulls`, `liveCrushHulls`), `pair-contact.ts` `tyreStop`, and `applyDrive`. Sent to CrashRealism11 with per-site KB/s.
- About 2.5 MB/s is React's dev-build JSX runtime (production not measured). About 2 MB/s is the race HUD components (`race-hud.tsx` standings rows and readouts, owned by the HUD lane).
- About 3 MB/s is inside three's render. Part of that was program reselection: when one material draws plain and instanced meshes (or instanced meshes with and without instance colours), three runs `getProgram` → `getParameters` again at every switch. That happened 12–13 times a frame: the car parts material shared with the wheel batch, the course's plain prop material shared by the gantry and instanced props, and three's shadow depth material shared by every caster.
- Fix: the wheel batch gets its own copy of the parts material, and it and debris get their own shadow depth material. Track art gives each draw kind its own copy of a material (`TrackArt.forDraw`) and gives instanced casters their own depth material. Program switches per frame went from 12 (oval) and 13 (city) to 0 on both. No new programs link (the guard still passes, with 0 links while racing). Near-camera captures differ by at most 1/255.
- The allocation rate did not measurably change: interleaved lane vs main gave 24.6 vs 24.1 MB/s on oval and 25.6 vs 25.3 MB/s on city, with major GCs at 2 vs 1 and 2 vs 2 per 30 s. The race GC pauses are driven by physics allocation.

## Re-measure
On a quiet box with the GPU clocked up (check with `nvidia-smi`), run `node .bench/perf-race/after.mjs` under `withserver.mjs` for main and the lane. Expect p50 16.7 again, as in the before table.
