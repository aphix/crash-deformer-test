# Physics/deform offload: audit and plan (main 0b7fc2f)

**Decision.** Move one loop, the per-vertex skin (positions plus normals), to Rust compiled to WASM and run it on the main thread:
- It is bit-identical to the JS skin, measured at 1.6–2.0× faster including the copies, and it is an output-only stage.
- Keep the JS skin as the reference and the fallback.

Do not use workers, a worker pool or SharedArrayBuffer, and do not port polar decomposition or SAT. Each of these measured as a loss or as too small a win (tables below).

The real cost is the car-pair solve: 64 % of a 32-car derby frame. It runs serially in pair order, so neither WASM nor workers can take it. Its lever is algorithmic and belongs to a separate JS lane (§6).

## How this was measured
- Box: the shared WSL dev box, 14 cores, node 24.15. Load average was 27–56 during every run, so treat absolute ms as noisy. Compare rows that ran back to back.
- Headless harness: the engine's frame order (accumulator of fixed steps, `stepWorld`, `settleStep`, then `updateSkin` per car; the table below was measured when it was called `updateDeform`), after the boot `warmCrashPath`.
  - fleet: pile-up at 18–28 m/s, frames 0–360.
  - derby: every car driving at the bowl centre, as in `physics-alloc.test.ts`; 300 warm frames, then 600 measured.
  - race: the oval with the real `RaceDirector`, 900 frames from the green light.
- CPU profiles: node:inspector sampling at 100 µs over the measured frames only.
- Browser: Chromium with ANGLE over WSL d3d12 (RTX 4080 Laptop), the dev build, `scripts/bench-browser.mjs` extended with skin and structure buckets and CDP CPU throttling.
- Scripts are local only (`.bench/offload/`, gitignored, in the `lane/offload-audit` worktree):
  - `prof.ts` and `matrix.sh`: the headless matrix.
  - `top.mjs` and `callers.mjs`: profile tables.
  - `kbench.ts`: per-kernel JS vs WASM.
  - `skin-equal.ts`: the full-loop A/B with per-frame digests.
  - `statecost.ts`: the pool marshalling cost.
  - `share.ts`: per-style table identity.
  - `web/`: the worker, pool and SAB round-trip page.
  - `browser*.sh`: the batched heavy-lock runs.
  - `wasm/` and `wasm-skin/`: the Rust prototypes.

## 1. Profile on main

### Headless ms per frame (two runs each, min/max; every digest identical run to run)
| scenario | cars | frame | p95 | stepWorld | race AI | updateDeform | crashed |
|---|---|---|---|---|---|---|---|
| fleet | 10 | 1.59 / 2.19 | 8.0 / 10.1 | 1.06 / 1.45 | – | 0.50 / 0.68 | 10 |
| fleet | 24 | 4.97 / 5.60 | 20.1 | 3.85 / 4.33 | – | 1.07 / 1.20 | 24 |
| fleet | 32 | 7.76 / 8.88 | 28.7 / 34.3 | 5.87 / 7.05 | – | 1.76 / 1.78 | 32 |
| derby | 10 | 1.46 / 1.65 | 3.7 / 4.2 | 0.97 / 1.09 | – | 0.45 / 0.51 | 10 |
| derby | 24 | 17.7 / 24.3 | 27 / 36 | 15.9 / 21.7 | – | 1.72 / 2.33 | 24 |
| derby | 32 | 35.6 / 41.5 | 59 / 72 | 31.0 / 36.3 | – | 4.34 / 4.92 | 32 |
| race (oval) | 10 | 1.79 / 2.09 | 6.1 / 7.7 | 0.93 / 1.06 | 0.52 / 0.62 | 0.32 / 0.37 | 6 |
| race (oval) | 24 | 8.16 / 10.0 | 19 / 23 | 5.90 / 7.16 | 1.25 / 1.48 | 0.96 / 1.30 | 21 |
| race (oval) | 32 | 8.58 / 10.5 | 17 / 24 | 6.13 / 7.34 | 1.36 / 1.80 | 1.05 / 1.35 | 28 |

### Where the time goes (inclusive ms per frame and share of sampled time, 32 cars)
| stage (loop) | fleet-32 | derby-32 | race-32 |
|---|---|---|---|
| total sampled | 6.19 | 43.76 | 10.87 |
| **car-pair solve** `resolveCarPair` | 3.06 (49.5 %) | **27.87 (63.7 %)** | 1.97 (18.1 %) |
| · SAT `satCars` (inside the pair solve) | 0.99 (16.0 %) | 7.40 (16.9 %) | 0.81 (7.4 %) |
| · `pushPair` → `followGroup` → `clampLocal` | 0.89 (14.4 %) | 9.40 (21.5 %) | 0.28 (2.6 %) |
| · `frontTransfer` (→ `nodePacked`) | 0.55 (8.9 %) | 5.63 (12.9 %) | 0.30 (2.8 %) |
| · `tyreStop` | 0.63 (10.1 %) | 5.31 (12.1 %) | 0.39 (3.6 %) |
| mass integration `syncPose` (→ `followGroup`) | 0.75 (12.1 %) | 2.64 (6.0 %) | 2.77 (25.5 %) |
| structure `stepStructure` | 0.53 (8.6 %) | 4.52 (10.3 %) | 1.60 (14.7 %) |
| · shape matching `stepShapeMatch` | 0.38 (6.2 %) | 4.16 (9.5 %) | 1.08 (9.9 %) |
| · · polar decomposition `m3Polar` | 0.10 (1.7 %) | 1.17 (2.7 %) | 0.28 (2.6 %) |
| `updateDeform` | 1.16 (18.8 %) | 5.20 (11.9 %) | 1.24 (11.4 %) |
| · **skin write-back** `skin` (incl. normals) | 0.48 (7.8 %) | 2.73 (6.2 %) | 0.38 (3.5 %) |
| · · normals `computeNormalsFast` | 0.19 (3.1 %) | 1.04 (2.4 %) | 0.14 (1.3 %) |
| · cages `solveCages` | 0.08 (1.4 %) | 0.49 (1.1 %) | 0.09 (0.8 %) |
| mass contact `collideWith` | 0.12 (1.9 %) | 1.71 (3.9 %) | 0.13 (1.2 %) |
| race AI (`drive` + `think`) | – | – | 1.13 + 0.64 |

### Calls per frame (32 cars): the pair solve repeats its work
| | followGroup | frontTransfer | nodePacked | stepStructure | syncPose | skin |
|---|---|---|---|---|---|---|
| derby-32 | 1939 | 2246 | 13128 | 75 | 374 | 19 |
| fleet-32 | 531 | 395 | 2181 | 64 | 231 | 5 |
| race-32 | 395 | 112 | 610 | 70 | 351 | 3 |

`followGroup` re-poses a whole car (a full mass pass plus `clampLocal`) on every push. In derby-32 it runs about 26 times per car per frame, against 2.3 structure steps per car.

### Browser, in-app ms per frame (dev build, 5 s windows; skin = skin calls per frame)
| | phys 1× | deform 1× | skin 1× | render 1× | phys 4× | deform 4× | skin 4× |
|---|---|---|---|---|---|---|---|
| fleet 10 / 24 / 32 | 4.15 / 9.60 / 10.15 | 2.10 / 3.69 / 4.36 | 0.94 / 2.07 / 2.36 (2.9 / 11.8 / 14.5 per frame) | 17.9 / 22.5 / 17.1 | 9.33 / 15.8 / 29.0 | 5.32 / 6.51 / 7.24 | 2.54 / 3.43 / 3.37 |
| derby 10 / 24 / 32 | 3.82 / 4.79 / 5.55 | 1.63 / 2.00 / 1.73 | 0.98 / 1.00 / 0.81 | 34 / 34 / 32 | 6.49 / 8.30 / 9.55 | 2.61 / 2.96 / 4.23 | 1.61 / 1.23 / 2.01 |
| race-oval 10 / 24 / 32 | 0.50 / 1.60 / 1.92 | 0.14 / 0.16 / 0.06 | ≈ 0 (LoD) | 2.8 / 38.8 / 48.4 | 2.35 / 4.16 / 4.30 | ≈ 0 | 0 |

On this box the browser main thread is GPU-process bound:
- `uniformMatrix4fv` self time is 14–50 % of the main thread (docs/PERF_HITCH.md).
- `stepWorld` is 23 % of the main thread in fleet-32 and 1.5 % in race-32.
- The in-app derby had not piled up within its 5 s window at about 20 fps. The headless derby rows are the pile-up cost.

## 2. Candidates, measured on the real data (a crashed sedan: 1431 vertices, 2278 triangles, 20 masses, 16 clusters, 18 cages)

### (a) Rust→WASM kernels: raw `extern "C"`, no wasm-bindgen, ported 1:1 (same operation order, f64 math, f32 stores)
| kernel | JS µs/call | WASM incl. marshal + copy-out | speed-up incl. copies | kernel only | output vs JS |
|---|---|---|---|---|---|
| skin + normals (one car) | 76–154 | 42–87 | **1.66–1.95×** | 1.54–2.07× | 0 / 4293 floats differ |
| m3Polar × 16 clusters (one car's iteration) | 0.68–1.65 | 1.56–4.81 | **0.31–0.52× (slower)** | 1.19–1.72× | 0 / 288 differ |
| satCars, crush hulls (an overlapping pair) | 1.20–1.93 | 1.00–1.62 | 1.16–1.25× | – | same depth |

- A JS→WASM call costs 4–8 ns.
- SIMD128 vs scalar build: no consistent gain. The loops are gather-bound and the compiler did not vectorise them: in the browser, scalar ran 1.70 ms vs SIMD 2.25 ms for 32 skins.
- **Full-loop A/B of the skin.** This is the real frame loop with `StreamedDeformation.skin` swapped, the same side effects, and per-frame digests of every car's positions and normals. Digests were **identical JS vs WASM in all 6 configurations**. Skin ms per frame:

| | fleet-10 | fleet-24 | fleet-32 | derby-10 | derby-24 | derby-32 |
|---|---|---|---|---|---|---|
| JS | 0.377 | 0.759 | 0.545–0.791 | 0.202 | 1.80–2.02 | 3.03–3.63 |
| WASM | 0.197 | 0.425 | 0.387–0.496 | 0.125 | 1.11–1.33 | 1.52–2.19 |
| saved | 0.18 | 0.33 | 0.16–0.30 | 0.08 | 0.69–0.69 | 1.4–1.5 |

- The variant that imports `Math.sin` and `Math.exp` from JS gives the same digests at the same speed (derby-32: 1.64 vs 1.52 ms). That makes the wrinkle bit-identical by construction, with no libm ulp drift.
- Browser, main-thread WASM, all 32 cars skinned (copy-in, kernel, copy into 32 attribute arrays): 1.70 ms (scalar) to 2.25 ms (SIMD) median, i.e. 53–70 µs per skin. The in-app JS skin ran at 163–184 µs per skin. These two numbers come from different pages, so they are not an A/B (see §7 for the queued in-app A/B).
- At 4× throttle: 11.9 ms for 32 skins. CDP throttling distorts sub-ms calls, so this is not a reliable mobile number.

### (b) A single Web Worker (browser, 32 cars, 1.07 MB of positions and normals per frame)
| mode | round trip median / p95 | main-thread busy median / p95 | worker compute |
|---|---|---|---|
| transfer, payload only (no compute) | 0.095 / 0.33 ms | 0.09 / 0.28 ms | – |
| transfer, 32 skins | 2.17 / 7.36 ms | **0.135 / 1.61 ms** | 1.61 ms |
| structured clone, 32 skins | 4.65 / 9.41 ms | 0.72 / 4.19 ms | 2.12 ms |
| SharedArrayBuffer + `Atomics.waitAsync`, 32 skins (isolated test page) | 2.42 / 5.69 ms | 0.225 / 0.475 ms | – |
| 4×: transfer / SAB | 9.93 / 6.29 ms | 1.23 / 0.93 ms | – |

All modes were bit-identical. Transport is cheap, and transfer beats SAB on main-thread time with no isolation needed.

The catch is latency:
- The skin result lands 2.2 ms after dispatch.
- Main must either pipeline it, which shows dents one frame late, or render from the message callback.
- Only skinning is coarse enough to ship. The remaining saving over main-thread WASM is about 1–2 ms at 32 cars.

**The whole sim in one worker** is not a hot-loop offload; it is a re-architecture:
- The sim reads and writes three.js objects (`group.position`, matrices, `MassNode` vectors) that the camera, FX, HUD, AI, netplay host, highlight recorder and replay read synchronously.
- Moving it means a second world mirrored per frame (effectively the netplay client path) and one more frame of input latency.
- Not recommended.

**Isolation (SharedArrayBuffer) is blocked for this app:**
- `COEP: require-corp` blocks the required Grok script. `https://grok.com/grok-app-builder/extensions.js` sends no CORP and no ACAO header, so the pill vanishes, which breaks AGENTS.md rule 2.
- `credentialless` keeps the pill but is unsupported in Safari (Chrome 96+, desktop Firefox 119+).
- The Grok live preview is a cross-origin iframe of a non-isolated parent, so it is never isolated.
- `COOP: same-origin` breaks the live-preview popup sign-in.
- WebRTC is unaffected.
- Sources: `.extraResearch/perplexitty/2026-10-02-coep-*`, `-crossoriginisolated-iframe-coop-popups`, `-webrtc-coop-coep-compat`, `-safari-*`.

### (c) Configurable worker pool (browser, one job per car, transfer)
| workers | 1 | 2 | 4 | 6 |
|---|---|---|---|---|
| frame wall, 32 skins (SIMD kernel) | 5.31 ms | 3.62 | 3.35 | 3.55 |
| main busy | 0.47 | 0.43 | 0.44 | 0.53 |
| 4×: frame wall / main busy | 8.88 / 1.92 | 8.42 / 2.46 | 11.65 / 7.87 | 14.3 / 10.5 |

- In wall time the pool is **slower than main-thread WASM** (2.25 ms), and at 4× its main-thread cost grows with the worker count.
- A finer job (one car's structure step) is too small to ship:
  - `stepStructure(1/240)` on a crashed car takes a median 4.5 µs (p90 15.8 µs).
  - Shipping its state (`simState`, 1139 numbers, 4.5 KB) costs 5.7 µs to read plus 7.0 µs to write per car per direction.
  - The empty postMessage round trip alone is 95 µs.
- Structure steps also run between the pair passes of every slice (2–4 per frame), so a pool would need 2–4 fork-joins per frame.
- **Not worth doing.**

## 3. Correctness
- **Determinism.** The skin is output-only. Its sole readers are lamp seating (cosmetic) and the rig scenes' measurements (`piston-rig.ts` / `door-rig.ts` metrics). No sim state, contact or digest-feeding path reads it. The WASM output is bit-identical anyway (per-frame digests above), so sim digests, netplay host authority and the highlight replay (`engine-replay.ts` re-sims solver state, not vertices) are unaffected. Switching from JS to WASM mid-run, once the kernel loads, cannot change anything.
- **Netplay client.** `writeNetState` → `flushSkin` → `skin()` takes the same path and gets the same bits.
- **Mobile.** The scalar build needs WASM MVP only (Safari 11+); no SIMD, threads or isolation. Safari WASM SIMD is 16.4+, SAB 15.2+ (isolated only), module workers 15+.
- **Boot.**
  - The skin-only module is 11,063 B (5,033 B gzip).
  - Compile takes 0.03–0.28 ms and instantiate 0.05–0.09 ms in node V8.
  - Tables are 488,766 B per car (`infUvw` alone is 183 KB). Placing all 32 cars costs 5 ms and 15.6 MB.
  - Tables are identical for every car of a style: 6 styles × 3 cars (police included) gave 0 mismatches. Content-keyed sharing bounds them to about 8 placements, about 3.9 MB.
- **Toolchain.**
  - This box has cargo 1.95 with `wasm32-unknown-unknown`.
  - The deploy box has no cargo or rustup. It runs `npm ci` plus `build:node` only.
  - Vercel's image has no Rust by default.
  - So: **commit the prebuilt `.wasm`**, built by a local npm script.
  - Vite 8.2.2 bundles `new URL("./x.wasm", import.meta.url)` under `APP_BASE`. Rapier's `.wasm` already ships this way under `/crush/assets` with `application/wasm`.

## 4. Recommendation
1. **Land: Rust→WASM skin + normals on the main thread**, scalar build, with `Math.sin` and `Math.exp` imported from JS.
   - Expected saving: 0.1–0.3 ms per frame (fleet), 0.7 (derby-24) and 1.4–1.5 (derby-32) headless.
   - In the browser it should be about 1.3 ms at fleet-32 (2.36 ms of JS skin at 1.8×). The coder confirms this with the in-app A/B.
   - No context switch, no isolation, no extra frame of latency, and no sim risk.
2. **Do not do:**
   - Polar or whole shape matching in WASM: a loss per call; the whole-port best case is about 0.4 ms. The owner also rules the shape-matching code stays ours.
   - SAT in WASM: 1.2×, at most about 1.2 ms at derby-32, and inside Airborne's files.
   - The worker pool: slower than (1).
   - SharedArrayBuffer: blocked by the Grok script, Safari and the iframe.
   - The whole-sim worker: a re-architecture plus one frame of latency.
3. **Optional later, gated:** move the WASM skin into one transfer-based worker, pipelined by one frame. Only if a mobile profile after (1) still shows skin above 2 ms per frame. It would buy about 1–2 ms more of main-thread time at 32 cars.
4. **The real lever is outside this lane (§6).**

## 5. Coder-lane plan (WasmSkin)

Files. None are in Airborne's territory (`car.ts`, `car-air.ts`, `car-suspension.ts`, `pair-contact.ts`, `sat.ts`, `ground.ts`), so this lane can run now, in parallel.
- Create `kernels/skin/Cargo.toml` and `kernels/skin/src/lib.rs`.
  - Start from the prototype `.bench/offload/wasm-skin/lib.rs` (its `[profile.release]`: opt-level 3, LTO, codegen-units 1, panic abort).
  - Exports: `memory`, `alloc_bytes(n) -> ptr`, `skin_shape(nverts, rest, rC, sN, sXf, sW, rJ, rW, X, pos, iN, iCo, iUvw, co, skinHub, hubs, wrinkleSeed, params, out)`, `normals(pos, idx, triIndexCount, nor, nfloats)`.
  - Imports: `m.sin` and `m.exp`.
  - `params` is f64[9]: `[wrinkleOn, ampK, extraCap, cap, roofClamp, ix, iy, iz, shapeMode]`.
  - `hubs` is f64 per mass: `[popped, local.x − rest.x, local.z − rest.z]`.
- Create `scripts/build-skin-kernel.mjs` and the `package.json` script `"build:kernel"`. It runs `cargo build --release --target wasm32-unknown-unknown` with `RUSTFLAGS="-C target-feature=-simd128"` and copies the output to `src/game/deform/skin-kernel.wasm`. Commit that file (about 11 KB). Add `kernels/skin/target/` to `.gitignore`.
- Create `src/game/deform/skin-kernel.ts`: the module-level kernel, nullable until loaded.
  - `loadSkinKernel(src: BufferSource | Response | PromiseLike<Response>): Promise<void>`: instantiates with `{ m: { sin: Math.sin, exp: Math.exp } }`, using `instantiateStreaming` with an `arrayBuffer` fallback.
  - `skinKernel(): SkinKernel | null`.
  - `SkinKernel.tables(key, build)`: places a style's static tables once. Key them by content: `vertexCount` plus an FNV hash of `restPos` and the index array, computed once per car.
  - `SkinKernel.run(...)`: copies the dynamic inputs (cluster maps 16×9, cage coefficients 18×24, `massPos` 20×3, hubs, params), runs `skin_shape` and `normals`, and copies the outputs into the position and normal attribute arrays.
  - Re-wrap the typed-array views whenever `memory.buffer` changes; `memory.grow` detaches them.
  - `ponytail:` tables are never freed. That is bounded by style count, about 8 × 0.49 MB; add a free path only if styles become per-car.
- Modify `src/game/deform/streamed-deform.ts` `skin()` only:
  - If `skinKernel()` is set, gather the same inputs the JS loop reads, in the same order: `refreshClusterXf` (shape mode), `cageCoeffs` into `cageCo`, then the kernel. Set `attr.needsUpdate`, the normal attribute's `needsUpdate`, `dirty` and `skinnedThisFrame`, then return.
  - Otherwise run the existing JS loop unchanged. It stays the reference and the fallback; do not delete it.
- Modify `src/game/engine/engine-warm.ts` `warmPrograms`:
  - Start `loadSkinKernel(fetch(new URL("../deform/skin-kernel.wasm", import.meta.url)))` next to `warmCrashPath`.
  - Await it together with the scene warm-up, so table placement never lands on a crash frame.
  - On failure, `console.warn` once and keep JS.
  - Expose `skinKernelReady` on `window.__crush` for the probes.
- Create `src/game/deform/skin-kernel.test-util.ts`: node loads `readFileSync(new URL("./skin-kernel.wasm", import.meta.url))` synchronously.
- Create `src/game/deform/skin-kernel.test.ts`, the digest equality test. The same seeded scenario runs twice, once with the kernel unset (JS) and once set (WASM), hashing every car's position and normal bits each frame; compare with `assertSameNumbers` on the per-frame hash arrays. Cover, at minimum:
  - a 10-car fleet pile-up, 240 frames;
  - a 10-car derby, 300 frames;
  - one car in lattice mode;
  - a compactor or deep-crush car (`deepCrush`, `bidirectional`);
  - a hub-popped car;
  - one frame with the wrinkle on.
  The test must fail if a param is dropped: check it by mutating `params[8]` once while writing it.
- Docs: `docs/CODEMAPS/physics.md` (skinning pipeline), `docs/DEPLOY.md` (the committed `.wasm` and `npm run build:kernel`), `docs/ARCHITECTURE.md` (the deform context gains `skin-kernel`).

Acceptance (numbers on the exact HEAD reported):
- The equality test passes. The full `npm run test:app` has 0 fail, with no drop in counts against the main it is rebased on. `npx tsc --noEmit` exits 0. `check:boundaries` does not rise. `oxlint` on the touched files is clean.
- Headless (`skin-equal.ts` pattern): WASM skin ms per frame at most 65 % of JS at derby-32 and fleet-32, with identical per-frame digests.
- In-app browser A/B: JS vs WASM skin at fleet and derby 10/24/32, 1× and 4×, one heavy-lock hold. The script is `.bench/offload/browser-ab.sh` with `bench-browser.mjs --swap`, or the landed kernel against a JS toggle.
  - Skin ms per frame at least 35 % lower at 1×.
  - In-page check 0 differing floats.
  - No new console errors.
  - The first-crash frame no slower than on main.
- `APP_BASE=/crush/ npm run build:node`: the `.wasm` is emitted under `/crush/assets/`. The served page reports `__crush.skinKernelReady === true`. A forced fetch failure falls back to JS and the game still plays.
- A 32-car field places at most 8 table sets.

## 6. The real lever (not offloadable): the pair solve repeats work
At derby-32:
- `resolveCarPair` is 27.9 of 43.8 ms.
- Inside it, `followGroup` (a whole-car re-pose per push) runs 1939 times per frame, inclusive 10.2 ms.
- `frontTransfer` runs 2246 times and `nodePacked` 13128 times, inclusive 5.6 ms.
- The solve runs serially in pair order (Gauss–Seidel). A pool cannot split it without changing results, and a WASM port means porting the deform state, which the owner rules out.

Candidate JS fixes: re-pose each car once per SAT pass instead of once per push (lever A), and cache `frontTransfer` per car per pass (lever B). Both change results unless done exactly. The upper bound was about 15 ms of the 44 ms derby-32 frame.

### Outcome (lane PairSolve, headless node, `.bench/pair`)
Box: shared WSL, 14 cores, load 7–28 during every run, so absolute ms are noisy and only runs interleaved in one hold compare.

**Landed: exact speed-ups (lever B, done without a cache).** Every digest equals main's (derby-32 `e3b57665`, fleet-32 `763b65dd`, derby-10 `c9ede8ed`), derby-10 seeds 1–48 give byte-identical results on every metric, and eight 16/24-car pile-ups give identical digests. REPLAY_VERSION is not bumped: the live sim is bit-identical.
- `nodePacked` walks only the beams that end on its mass (`massBeams`, 4.6 of 46 beams), and `cornerWeight` is a per-hit table (`massCornerW`; it ran `exp` per mass per call, in `clampMass` too).
- `tyreStop` skips tyre pairs clear of each other by more than their travel along some axis.
- `satCars` skips hull pairs whose circumscribed circles are apart.
- `collideWith` returns when the two cars' mass bounds are apart. `separateAlong` of nothing returns.

| derby-32, wall ms/frame (mean / p50 / p95), load 7–11 | main | + nodePacked, cornerWeight | + tyreStop | + satCars | + collideWith, separateAlong |
|---|---|---|---|---|---|
| ms | 20.77 / 18.55 / 31.34 | 19.33 / 17.31 / 30.83 | 16.12 / 14.82 / 24.59 | 13.09 / 12.42 / 17.47 | 12.27 / 11.64 / 15.84 |
| alloc KB/frame | 1997 | 1683 | 1677 | 1675 | 1639 |

Same code, other holds: derby-32 `B` over main is 0.78 / 0.70 of the frame in the wall-time holds (load 13–28) and 0.80 in the CPU-time hold; fleet-32 0.87 (p50 3.11 → 2.58); derby-10 0.80 (p50 3.96 → 3.18).

**Measured, not landed: lever A (re-pose once per SAT pass).** `pushBody` shifts the frame and refits the locals under the moved masses; `refit()` runs the full `followGroup` once per pass. `followGroup` calls per frame: derby-32 1732 → 569, fleet-32 511 → 333, derby-10 375 → 180; alloc 2001 → 1166 KB/frame at derby-32. It changes results (derby-32 digest `ac36174f`). Against main's spread, derby-10 seeds 1–48 (finish 40/48 vs 42/48, first death 31.4 vs 29.6 s, contacts per car-minute 8.46 vs 9.09, peak contact turn rate mean 4.73 vs 4.83 and max 6.49 vs 6.45 rad/s, zips 4 vs 6, hooked pairs per car-minute 0.36 vs 0.44) and the 16/24-car pile-ups (max push per slice 0.052 m, same cap) stay inside the spread. It is red on the race pile-up in `replay-fidelity.test.ts`: max velocity error 4.8e-4 to 8.4e-4 m/s against the bound 1e-4 in 12 of 12 shifted spawns (main: 2e-5, 12 of 12 pass). So it is not landed.
- 87 % of `takePush` calls return 0 (the slice's budget is spent), and each still re-poses. That re-pose is not a no-op: 19 % change the car's velocity by 1e-3 m/s or more and 1 % move a mass 1 mm or more, so skipping them is not exact either.
- The derby pile-up bound in `replay-fidelity.test.ts` passes 3 of 12 times on main itself when the four spawns shift by k·1e-9 m (`.bench/pair/fragility.ts`): any trajectory change has about a one in four chance of staying inside it.

| derby-32 (wall ms/frame mean / p50 / p95, one interleaved hold, load 13–17) | main | B (landed) | A | A + B |
|---|---|---|---|---|
| ms | 22.80 / 20.65 / 33.50 | 17.87 / 15.63 / 27.36 | 20.36 / 18.18 / 30.62 | 15.81 / 14.50 / 24.79 |
| alloc KB/frame | 2001 | 1639 | 1166 | 1009 |
| `resolveCarPair` inclusive ms (profile) | 13.02 | 7.18 | 7.22 | 4.44 |
| `followGroup` | 5.04 | 4.01 | 1.50 | 1.67 |
| `satCars` | 3.56 | 1.93 | 2.83 | 2.03 |
| `tyreStop` | 2.58 | 1.25 | 1.50 | 0.68 |
| `frontTransfer` / `nodePacked` | 2.58 / 1.84 | 0.91 / 0.62 | 1.90 / 1.31 | 0.89 / 0.58 |

## 7. How this relates to Rapier
- **Separate modules and instances.** The skin kernel is its own 11 KB module with its own memory, and runs on the main thread:
  - It must not share Rapier's instance. Rapier is wasm-bindgen output (1.57 MB, 0.59 MB gzip) with its own allocator, and linking our kernel into it means rebuilding Rapier.
  - Neither needs to sit beside the other: the skin reads only deform tables, and the ragdoll world never reads car skins.
- **Shared loading pattern, not shared code.** Both are `.wasm` assets that Vite emits under `APP_BASE`, served as `application/wasm` and instantiated via `instantiateStreaming`.
  - Rapier: `kernel/rapier.ts` `loadRapier()`, a lazy dynamic import after `ready`, because it is cosmetic.
  - Skin kernel: `loadSkinKernel()` in `warmPrograms`, awaited with the scene warm-up. It costs 5 KB gzip and under 0.3 ms compile.
  - No shared loader abstraction for two callers.
- **Ragdoll world placement.** Keep it on the main thread. It is cosmetic (exempt from determinism), and Rapier in a worker would need its own copy of the module plus per-frame pose transfer, about 0.1 ms per MB per round trip measured here. That is not worth it for a few dummies.
- **Determinism harness for any WASM swap.** `.bench/offload/skin-equal.ts` runs the real frame loop with the implementation swapped on the prototype. It hashes every car's output bits each frame and compares JS vs WASM per frame. Same input twice gives identical digests (all headless rows above).
- **Toolchain** (applies to any Rust/WASM choice): cargo 1.95 and `wasm32-unknown-unknown` are here; there is no `wasm-pack`. The deploy box has no Rust, so any home-built `.wasm` is committed prebuilt. Rapier comes from npm and needs none of this.

## 8. Not measured
- Browser runs use the slow path (full-speed play) because FastForward's `window.__crush.advance(seconds)` had not landed. Once it lands, the coder's A/B should use it.
- The in-app JS vs WASM browser A/B. It was queued, then cancelled during box contention before it took the lock. The coder's acceptance run covers it.
- Real mobile hardware and Safari.
- A worker's main-thread benefit with real pipelining inside the engine.
- WASM compile time in Safari.
