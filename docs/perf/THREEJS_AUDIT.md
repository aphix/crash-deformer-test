# Three.js performance audit (2026-10-02)

The game is audited against five sources: [1] hontran.dev "three-js-performance-optimization", [2] utsubo.com "threejs-best-practices-100-tips", [3] discoverthreejs.com "tips-and-tricks", [4] r3f.docs.pmnd.rs "scaling-performance" (its React items are mapped to vanilla three.js), [5] tympanus.net/codrops 2025-02-11 "building-efficient-three-js-scenes".

## How to read the numbers

- **All numbers are relative.** The box is WSL2. Chromium (Playwright build) draws through ANGLE GL, then Mesa d3d12, then an RTX 4080 Laptop GPU. The box is shared with other lanes: the 1-minute load was 20 to 31 on 14 cores during every run.
- The GPU power state was recorded with `nvidia-smi` for every A/B. It moved between P8 (210 MHz) and P0 (2460 MHz) within single runs.
  - Comparisons in this doc are either interleaved ABAB on one page (`gputime.mjs`), or interleaved fresh browsers with the GPU state logged per run (`ab.mjs`).
  - A single number from a stuck-P8 run is not comparable to one from a P0 run.
- On this box the long frames are bound by the GPU process (ANGLE `MakeCurrent` / `SwapBuffers`), not by the GPU. At P0 the GPU itself needs 0.2 to 0.6 ms per frame (see GPU time below). On native Windows or a phone, the balance differs.
- Probes live in `.bench/perf-audit/`, which is local only (`.bench/` is gitignored, as for `docs/PERF_HITCH.md`'s `.bench/perf-race/`). Each table names its command.
  - `$URL` is a dev server of the build under test.
  - The default is 8 cars, `?fx=minimal` (the shipped default tier), and 1280×800 at device pixel ratio 1.

## Measured state (main c877552 / 38fe41c)

### Per scene (`URL=… node .bench/perf-audit/info.mjs fleet,derby,race_oval,race_rally,race_city,race_stunt 8 6`, one fresh browser per scene, 6 s)

| scene | calls | triangles | programs | geometries | textures | objects | lights | shadow casters | tick ms | physics ms | render CPU ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fleet | 270 | 85 020 | 61 | 256 | 21 | 368 | 13 | 80 | 4.45 | 0.88 | 3.04 |
| derby | 249 | 83 746 | 61 | 256 | 21 | 368 | 13 | 80 | 6.12 | 2.67 | 2.80 |
| race oval | 226 | 114 385 | 79 | 280 | 25 | 387 | 13 | 89 | 3.38 | 0.80 | 2.31 |
| race rally | 234 | 137 485 | 77 | 281 | 25 | 388 | 13 | 89 | 3.43 | 0.49 | 2.69 |
| race city (8 racers + 12 traffic) | 254 | 158 052 | 84 | 350 | 26 | 821 | 13 | 174 | 5.12 | 1.83 | 2.68 |
| race stunt | 229 | 158 754 | 82 | 286 | 25 | 393 | 13 | 94 | 3.13 | 0.76 | 2.05 |

### Draws by pass and owner (`draws.mjs <scene> minimal 8`, one frame)

| scene | main | shadow | car parts (main + shadow) | wheels | course art |
|---|---|---|---|---|---|
| fleet | 191 | 64 | 173 + 56 | 2 + 2 | — (grid, poles) |
| derby | 186 | 60 | 171 + 56 | 2 + 2 | 3 + 2 (arena) |
| race city | 215 | 68 | 192 + 56 | 2 + 2 | 17 + 10 |

- Cars are 90 % of all draws: 24 drawables per car (5 Physical paint panels, 4 Standard glass panes, interior, 2 bumpers, grille, tail trim, 2 door linings, 2 mirrors, 2 door glass, 4 lamp units). 7 of them cast shadows.
- 4 of each car's 7 shadow casters are glass (`carparts.mjs`).

### WebGL calls per frame (`glcalls.mjs race_oval 8 60` and `glcalls.mjs fleet 24 60`)

| scene | GL calls | uniformMatrix4fv | uniform3f | bindVertexArray | drawElements | programs (main / shadow) | program switches | material switches |
|---|---|---|---|---|---|---|---|---|
| race oval, 8 cars | 1659 | 527 | 294 | 257 | 232 | 20 / 3 | 39 + 6 | 120 |
| fleet, 24 cars | 2617 | 937 | 222 | 488 | 480 | 15 / 2 | 63 + 3 | 172 |

### Where the main thread goes (`GALLIUM_DRIVER=d3d12 node scripts/bench-browser.mjs --cars 8,24 --modes race-oval,fleet --seconds 8 --profile /tmp/pa-prof`)

- Self time in WebGL natives is 47 to 68 % of the profile. `uniformMatrix4fv` alone is 31 to 47 %. That is the command buffer blocking on the GPU process, not the work of uploading a matrix.
- three.js JS is 10 to 27 %. Our own sim code is under 1 % per function.

| run | fps | frame ms | p99 | render CPU ms | calls |
|---|---|---|---|---|---|
| race oval 8 | 222 | 4.5 | 50.6 | 3.74 | 218 |
| race oval 24 | 41 | 24.5 | 201.9 | 21.18 | 392 |
| fleet 8 | 80 | 12.5 | 115.9 | 10.18 | 275 |
| fleet 24 | 14 | 72.7 | 202.1 | 58.57 | 658 |

### Draw-call levers measured (`ab.mjs lever-ab.jsonl 15 race_oval,fleet24 2 base@… base@…@small base@…@noshadow`, 2 interleaved rounds, GPU P4 to P8)

| lever | scene | calls | GPU-process CPU ms/frame | GPU-process busy ms/frame | p50 frame ms |
|---|---|---|---|---|---|
| none | fleet 24 | 448 / 441 | 14.8 / 11.9 | 93 / 59 | 92 / 65 |
| all 16 small car parts off | fleet 24 | 337 / 311 | 10.4 / 9.8 | 51 / 45 | 53 / 33 |
| shadows off | fleet 24 | 226 / 315 | 11.1 / 10.2 | 58 / 48 | 48 / 47 |
| none | race oval | 247 / 248 | 8.4 / 9.1 | 31 / 42 | 29 / 34 |
| all 16 small car parts off | race oval | 141 / 141 | 9.1 / 8.4 | 47 / 37 | 45 / 36 |

- At 24 cars, 110 to 135 fewer draws took 2 to 4 ms per frame off the GPU process. That is 20 to 35 µs per draw.
- At 8 cars on the oval the same lever stayed inside the noise.
- Main-thread render CPU is about 10 µs per draw (`info.mjs` with `VARIANT=small`: fleet 264 calls at 4.13 ms, 150 calls at 2.02 ms).

### GPU time (`gputime.mjs <scene> <cars> <rounds> <dsf>`, EXT_disjoint_timer_query around `renderer.render`, variants interleaved on one page, median ms)

| scene | pixels | GPU state | base | 10 pool lights removed | tail points removed | shadows off | pixel ratio 1 |
|---|---|---|---|---|---|---|---|
| race oval, 8 | 1280×800 | P5, ~500 MHz | 3.25 | 1.59 | 1.20 | 2.93 | — |
| race oval, 8 | 1280×800 | P0, 2460 MHz | 0.185 | 0.115 | — | — | — |
| fleet, 24 | 1280×800 | P4 to P0 | 0.408 | 0.280 | — | — | — |
| race city, 8 | 1920×1200 (dsf 1.5) | P0, ~2.2 GHz | 0.429 | 0.233 | — | — | 0.179 (1280×800) |

- The 10 always-present punctual lights cost 31 to 51 % of GPU time: the lamp pool's 4 spots and 4 points, the impact flash and the derby winner's spot. three evaluates every light on every lit fragment, whatever its intensity.
- Pixel ratio 1.5 costs 2.4× the GPU time of 1.0.

### Phone-class CPU (estimate: `THROTTLE=4 node info.mjs race_oval,fleet 8 8`, CDP CPU throttling 4×)

- Race oval: 222 calls cost 12.96 ms of render CPU, about 58 µs per draw. Fleet: 199 calls cost 9.96 ms. Tick: 16.9 and 14.1 ms.
- The 4× runs with the small-parts lever ran while the box load rose: their physics time rose 1.5 to 4.7× as well. They are not used.

## Wins taken

| commit | change | A/B |
|---|---|---|
| 98d647a | Lit shaders skip a point or spot light's BRDF where the light adds nothing (`if ( directLight.visible ) RE_Direct(…)` in three's `lights_fragment_begin`, `engine/engine.ts`). Exact: three already zeroes such a light's colour. | GPU median 0.185 → 0.159 ms on race oval (−14 %), 0.408 → 0.356 ms on fleet 24 (−13 %), 0.565 → 0.565 ms on city at 1920×1200 (0 %). Screenshots: max 1/255 over 6 scenes × day/night × minimal/low. Programs unchanged. |
| 59b707a | `LampBatch` (`vehicle/lamp-lights.ts`): every car's 4 lamp units are drawn as 4 instanced draws in total (head / tail × lit / broken), on the `WheelBatch` pattern. A car keeps a bare `seat` Object3D per lamp. Per-lamp breakage is unchanged: `breakLamp` moves a lamp to the dark batch. | −4 draws per car, +4 total: at 8 cars, 32 lamp draws become 4; at 24 cars, 96 become 4. At ~20–35 µs of GPU-process time per draw (lever table above), that is an estimated 0.6–1 ms per frame at 8 cars and 2–3 ms at 24. The live A/B under box load was inside run-to-run noise, so it is not claimed. Screenshots: crash (2 broken lamps), derby and oval max 1/255; fleet, rally, city and stunt max 34–55/255 on < 0.0005 % of pixels (single lamp-edge pixels from instanced-transform rounding). Programs unchanged. |

A tried-and-dropped change: making the tyre-mark stamp single-pass (`forceSinglePass`) was a no-op. `ShaderMaterial` defaults to `forceSinglePass = true`. Measured with `marks.mjs`: 1.0 draws per flush and 0 program re-resolves on both builds.

## Tip audit

Verdicts: **take** = done in this lane; **done** = already in the code; **weigh** = worth doing, with a cost or a visual trade-off needing a decision; **skip** = not worth it here, with the reason. The Rapier column (owner directive, `local://lane-updates.md`) marks where Rapier could replace our code; RapierEval holds the candidate list.

| # | tip | src | our state (measured) | est. gain | cost | risk | verdict | Rapier |
|---|---|---|---|---|---|---|---|---|
| T1 | Measure `renderer.info` | 1,2 | `info.mjs`, `draws.mjs`, `glcalls.mjs`, `bench-browser.mjs` | — | — | — | done | — |
| T2 | Draw budget 100 to 150 on mobile | 1–4 | 226–270 calls at 8 cars; 392 to 658 at 24 cars | — | — | — | weigh (cars: see T3/T5) | — |
| T3 | InstancedMesh for repeats | 1–5 | wheels (1 + 1 draws for all cars), props per prefab part, FX, pistons; lamps now | lamps −28 draws at 8 cars, −92 at 24 | done | low | take (lamps) | no |
| T4 | BatchedMesh for varied geometry, one material | 1,2 | not used | course art 17 + 10 draws → ~3 + 3 on city | medium | low | weigh: ≤ 8 % of draws | no |
| T5 | Merge static geometry | 1,2 | interior, mirrors, trims are already merged multi-tone parts (`partsMaterial`) | grille / trim / mirror / lining / interior batched across cars like the lamps: −7 draws per car, +7 total | medium | medium (detach paths) | weigh, next lever | no |
| T5b | Bumper + grille / tail trim in one mesh | — | bumper uses `makeTrimMaterial` (envMapIntensity 0.65); grille and trim use `partsMaterial` (1.0) | −2 draws per car | low | **visual change**: the env intensity can't vary per vertex | skip as specified; batch across cars instead (T5) | no |
| T6 | Share materials and geometry | 1–4 | `partsMaterial`, `forDraw` copies per draw kind; 120 to 172 material switches per frame (paint is per car) | small | — | — | done | — |
| T7 | Texture atlas / array | 2,5 | `toneGrid` lookup for multi-tone parts; lamp mask texel | — | — | — | done where it pays | — |
| T8 | Instance shared sub-parts | 5 | wheels, lamps | see T3 | — | — | take | no |
| T9 | Frustum culling with correct bounds | 2 | on; FX, wheels and lamps unculled on purpose (instances span the pad) | knock props: their instance spheres cover the course anyway | — | — | done | — |
| T10 | visible / layers over add / remove | 2,3 | distance detail toggles layer 0; lamp seats likewise | — | — | — | done | — |
| T11 | Render on demand | 1–4 | renders every frame, paused or menu included | battery / thermals on mobile while paused | medium | hitch-free resume needs care | weigh | — |
| T13 | Stop when hidden | 5 | rAF stops in hidden tabs; netplay handles `visibilitychange` | — | — | — | done | — |
| T14 | `setAnimationLoop` | 2 | yes | — | — | — | done | — |
| T16 | Cap pixel ratio | 1,2,3,5 | `min(dpr, 1.5)`; MSAA only at dpr ≤ 1 | 1.5 → 1.0 = −58 % GPU at 1920×1200 | 1 line | blur on hi-dpi | weigh (mobile default 1.25?) | — |
| T17 | Re-apply DPR on change | 5 | set once at boot | correctness when zooming or moving the window | 1 line | low | weigh | — |
| T18/T19/T20 | Adaptive quality, flip-flop limit, regress while moving | 1,4,5 | fixed tiers (`off < minimal < low < high`), manual | phones: large (fill-bound) | medium | resize allocates (pillar: no hitching) | weigh | — |
| T22/T23 | No per-frame allocation | 2–5 | 24–30 MB/s in races, ~20 MB/s of it physics (`docs/PERF_HITCH.md`) | GC pauses 30–64 ms once a minute | — | — | done in render; physics with CrashRealism / WheelGround | yes: physics allocation |
| T24 | Pool spawned objects | 2 | debris, sparks, smoke, glass dots, lamp lights pooled | — | — | — | done | debris: cosmetic, exempt |
| T25 | `matrixAutoUpdate=false` on static | 3 | not used; `updateMatrixWorld` is 0.06 ms per frame (387 objects) | < 0.06 ms | low | low | skip: too small to measure | — |
| T26 | Update far objects less often | 3 | skinning stride 1/2/4 by projected size; distance detail | — | — | — | done | — |
| T28 | Workers | 2 | physics on the main thread, 0.5–2.7 ms at 8 cars | frame time at 24+ cars | high | determinism | weigh | yes: Rapier is wasm, still the main thread |
| T29 | BVH raycasts | 2 | `projectPath` (track.ts) 0.10 ms per frame at 24 cars | ~0.1 ms | medium | low | skip (sent to RapierEval) | maybe (spatial query) |
| T31 | Primitive colliders | 5 | SAT hulls: `satTwoHulls` 0.74 ms per frame at fleet 24 | ~0.5 ms | medium | determinism | weigh | **yes**: sent to RapierEval |
| T32 | Lower physics rate | 5 | fixed 60 Hz, up to 8 substeps | — | — | changes handling | skip | — |
| T33/T101 | GPU particles / physics | 2,3 | FX on the CPU: 0.01–0.015 ms per frame | none | high | — | skip | no |
| T34 | LOD | 2–5 | distance detail (35 m) and skin LoD | — | — | — | done | — |
| T35/T37 | Low poly, lean attributes | 2,5 | 110–160k triangles per frame | — | — | — | done | — |
| T40 | Tight frustum | 3 | near 0.1, far 180, fog | — | — | — | done | — |
| T41–T47 | Draco / Meshopt / KTX2 / glTF | 1,2,3,5 | everything is procedural, apart from one 37 kB env JPEG | none | — | — | skip: no models or textures to compress | — |
| T48/T49 | Right-size textures | 1–3,5 | canvases 64² to 1024×512; 21–26 textures | — | — | — | done | — |
| T54 | Dispose | 1–3 | engine, track art and FX dispose; geometries and textures stable across scenes | — | — | — | done | — |
| T55 | Precompile shaders | 2,4 | `warmPrograms` plus the `check:programs` guard | — | — | — | done | — |
| T56 | No runtime light add / remove | 3 | fixed lamp pool at intensity 0 | — | — | — | done | — |
| T57 | Few direct lights | 1–3,5 | 12 punctual (2 directional + 5 spot + 5 point) in every lit shader | dark-light skip −13 % GPU (taken); pool 8 → 4 lights est. −20 % | low | fewer headlamp pools | take (skip) + weigh (pool size) | — |
| T58/T59 | IBL; baked lighting | 2,5 | PMREM studio env, hemi light; nothing baked (deforming cars) | — | — | — | done / skip | — |
| T60–T63 | One shadow light, small map, tight box, casters only | 1–3 | one sun, 1024² PCF, 48 m box around the followed car; 56 car-part casters in the pack | shadows off −10 % GPU, −60 draws | — | — | done | — |
| T64 | Static shadow `autoUpdate=false` | 2,3 | cars move every frame; PerfRace A/B'd it at noise | ~0 | — | stale car shadows | skip | — |
| T65 | Fake blob shadows | 2 | — | −56 shadow draws | medium | visual change | weigh (mobile tier) | — |
| T66 | CSM | 2 | — | — | — | — | skip | — |
| T67 | Cheapest material | 1,3 | Physical (clearcoat) on 5 paint panels per car; Standard elsewhere | Standard for far cars: unmeasured | medium | visual change | weigh | — |
| T68 | Few transparents | 2,3 | glass `forceSinglePass`; FX additive | — | — | — | done | — |
| T70 | mediump on mobile | 2 | highp | unmeasured | low | deform / world-space precision | skip | — |
| T75/T76 | Reuse programs; change uniforms only when needed | 2,3 | 0 program reselection per frame (`flips.mjs`) | — | — | — | done | — |
| T77/T95 | Find the bottleneck | 3,2 | GPU timer queries plus the CDP trace (GPU-process bound) | — | — | — | done | — |
| T78/T79 | Context flags | 3,5 | high-performance, `alpha:false`, stencil off (r186 default) | — | — | — | done | — |
| T80/T81 | MSAA vs post AA | 2,3,5 | MSAA at dpr ≤ 1; the post target matches it | — | — | — | done | — |
| T82–T85 | Merged post passes; tiers | 1–5 | one composite per tier; `minimal` (no post) is the default | — | — | — | done | — |
| T86/T87 | Lazy-load; code-split | 1,2 | engine dynamic import; three vendor chunk | — | — | — | done | — |
| T91 | Compressed assets | 2 | nginx compresses JS, CSS, JSON, wasm and SVG (d96a6e7) | — | — | — | done | — |
| T97 | Benchmark with vsync off | 3 | `bench-browser.mjs` default | — | — | — | done | — |
| T99 | Context lost / restored | 2 | not handled | robustness, not perf | low | — | weigh | — |
| T100 | Occlusion culling | 2 | none (open courses; city blocks) | unmeasured | high | — | skip | — |
| T102 | WebGPU-only items | 2 | WebGL2 renderer | — | — | — | skip | — |

## Weighed, not taken (owner decisions)

1. **Lamp-pool size on mobile** (T57): the 10 pooled lights cost 31 to 51 % of GPU time. On mobile, a 2-spot / 2-point pool picked at boot from a coarse pointer, with no runtime relink, would cut an estimated 20 to 25 %. The cost is fewer headlamp pools.
2. **Pixel ratio on phones** (T16): 1.5 → 1.25 cuts the pixels to 0.69×. The estimate is −25 to −30 % GPU on a fill-bound phone.
3. **Car-part batches beyond the lamps** (T5): grille, tail trim, 2 mirrors, 2 linings and the interior, batched across cars. That is −7 draws per car, +7 total: about −56 draws at 8 cars and −168 at 24. It is the next biggest draw lever. The detach paths (mirror, bumper) keep their Object3D seats, as the lamps do.
4. **Blob shadows / no car glass casters on a mobile tier** (T63/T65): −32 to −56 shadow draws, a visible change.
5. **Adaptive quality** (T18–T20): needs a resize without hitching.

## Mobile angle (estimates, not measured)

- **CPU:** at 4× throttling a draw costs ~58 µs of render CPU. 226 calls on the oval is ~13 ms of a 16.7 ms budget before physics (2.8 ms at 4×). Every draw removed matters 5× more than on this desktop. The lamp batch saves ~28 draws (~1.6 ms) at 8 cars.
- **GPU:** a phone GPU is ~25–40× slower than this one at P0. The race city frame is 0.43 ms here at 1920×1200, which scales to an estimated 4–6 ms for a 0.8 Mpx phone canvas at dpr 1.5.
  - The lamp-pool lights are ~45 % of that and shadows ~10 %. The dark-light skip saves 0–14 % here; the phone benefit of branching is unmeasured.
- **Shadows:** one 1024² depth pass with 60–68 draws in a pack. On a tile-based GPU that is an extra render pass per frame.

## Baseline (task 2)

`.bench/perf-audit/baseline.sh 3`: three interleaved rounds per side, with the GPU state in `gpu.log`. It runs `GALLIUM_DRIVER=d3d12 node scripts/bench-browser.mjs --cars 2,10,16,24,32 --modes fleet,derby` and race oval / city hitching (`ab.mjs`, 30 s).

**Not run.** The lane ran out of request budget. The box was also loaded (1-minute load 20–31, other lanes' browser runs queued on the heavy lock), and single runs varied 3× (race oval p50 33 to 133 ms in back-to-back runs). The 2–32 car and hitching tables need a quiet box: run the script there before quoting a frame-time change.
