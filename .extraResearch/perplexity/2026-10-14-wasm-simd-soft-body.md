WebAssembly SIMD (`simd128`) is a strong fit for **bulk, regular numeric kernels**—particle integration, constraint projection, shape matching, distance tests, and broad-phase filtering—but measured gains are highly dependent on layout, batch size, browser/JIT, and whether data crosses the JavaScript/Wasm boundary.

## What speedups are realistic?

There is no reliable universal “physics speedup” number. Public benchmark claims commonly show:

- **Wasm SIMD vs scalar Wasm:** roughly **1.3–3×** for well-vectorized arithmetic kernels; **4×** is possible for ideal four-wide `f32` loops with little control flow.
- **Wasm SIMD vs optimized JavaScript TypedArray loops:** commonly **1.5–4×** for large, compute-heavy kernels, but sometimes **near parity** when V8 or SpiderMonkey successfully vectorizes JavaScript or when the Wasm kernel is memory-bound.
- **End-to-end game-frame speedup:** often only **10–80%**, because broad-phase work, allocations, rendering, contact generation, synchronization, and JS↔Wasm calls remain scalar or outside the kernel.

A published illustrative benchmark reports matrix multiplication at 850 ms in JavaScript, 210 ms in scalar Wasm, and 55 ms in SIMD Wasm, but that is not a physics benchmark and should not be treated as representative of particle or contact workloads.[9] Claims of 2–4× SIMD gains are most credible for dense arithmetic such as dot products, matrix operations, and image-style kernels rather than branch-heavy collision code.[5][9]

For a soft-body solver, reasonable planning estimates are:

| Workload | SIMD versus scalar Wasm | SIMD versus optimized JS |
|---|---:|---:|
| Particle position/velocity updates | 1.3–2.5× | 1.2–3× |
| XPBD/PBD constraint arithmetic | 1.2–2× | 1.2–2.5× |
| Shape matching covariance and reduction | 1.5–3× | 1.5–4× |
| Polygon/point distance tests | 1.2–2.5× | 1.2–3× |
| Irregular contact manifold generation | 1.0–1.8× | 1.0–2× |
| Entire physics frame | 1.1–1.8× | 1.2–2.5× |

These ranges assume sufficiently large batches and no per-particle JS calls. Small meshes, many branches, and frequent allocation can erase most of the advantage.

## Particle and shape-matching solvers

### Particle integration

Particle integration is the easiest target:

```text
x[i] += v[i] * dt
v[i] += gravity * dt
```

Four `f32` particles can be processed per SIMD register. With a structure-of-arrays layout:

```text
pos_x[]
pos_y[]
vel_x[]
vel_y[]
inv_mass[]
```

the loop can load contiguous vectors, perform arithmetic, and store contiguous results.

An array-of-structures layout such as:

```text
[x, y, vx, vy, mass, ...]
```

introduces gathers, shuffles, or strided loads. WebAssembly SIMD has no general-purpose gather comparable to some desktop SIMD ISAs, so this layout can reduce the benefit substantially.

### Constraint projection

Distance constraints can vectorize when four constraints use independent particles and the indices are already organized into suitable batches. The difficult case is indexed access:

```text
i = constraint_particle_a[c]
j = constraint_particle_b[c]
```

followed by scattered reads and writes. SIMD arithmetic may still help with rest lengths, inverse masses, and scalar terms, but random particle access often makes the loop memory- and latency-bound.

Useful approaches include:

- Group constraints into batches with no write conflicts.
- Reorder constraints by material, type, or topology.
- Use graph coloring or phase-based solving.
- Keep frequently used fields in separate arrays.
- Vectorize reductions and scalar arithmetic after gathers, rather than forcing the entire constraint loop into SIMD.

### Shape matching

Shape matching benefits more than ordinary constraint projection because it contains dense sums such as:

\[
A_{pq} = \sum_i w_i q_{ip} r_{iq}
\]

where the same particle data is accumulated repeatedly. Four particles can contribute at once, and SoA data makes the covariance accumulation straightforward.

The final polar decomposition or 2D rotation extraction is usually a small scalar operation, so vectorizing the accumulation matters more than vectorizing the final matrix step. For small clusters, however, SIMD setup and horizontal reductions can outweigh the arithmetic savings.

## Polygon and point-versus-surface contact queries

SIMD is useful for testing many points against the same polygon or many polygon edges against points:

- Load four point coordinates.
- Subtract edge endpoints.
- Compute cross products or signed distances.
- Compare against tolerances.
- Produce a four-lane mask.

It is less effective when every lane follows a different path through a polygon or generates a different number of contact points. Typical bottlenecks include:

- Variable polygon vertex counts.
- Early exits.
- Edge adjacency and topology lookups.
- Contact manifold construction.
- Scattered writes.
- Branch-dependent clipping.

A practical design is to split the query into phases:

1. **Broad numeric phase:** SIMD distance, AABB, signed-area, or plane tests.
2. **Compaction phase:** write surviving IDs to a compact list.
3. **Scalar or lightly vectorized phase:** generate manifolds and resolve topology-dependent cases.

This often gives better results than trying to SIMD-vectorize one large branch-heavy collision routine.

## Android browser support

Fixed-width WebAssembly SIMD is broadly available in modern Android browsers:

- Chrome for Android supports WebAssembly SIMD from approximately **Chrome 91** onward.
- Firefox for Android supports it from approximately **Firefox 89** onward.[1]

Support tables also list Firefox versions beginning at 89 for SIMD and document Chrome Android support, although browser-version tables can change as compatibility databases are updated.[6] Feature detection remains preferable to user-agent checks:

```js
const simdSupported = WebAssembly.validate(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 123,
    3, 2, 1, 0,
    10, 7, 1, 5, 0, 253, 15, 11
  ])
);
```

In production, ship both scalar and SIMD modules and select the SIMD module only after validation. Device performance still varies considerably because Android phones use different ARM cores, thermal policies, and browser JIT strategies.

## Rust: `core::arch::wasm32::v128` versus `std::simd`

`core::arch::wasm32` exposes WebAssembly-specific intrinsics and the `v128` type; Rust’s documentation describes `v128` as the 128-bit SIMD register type introduced by the WebAssembly SIMD proposal.[2] Typical code uses operations such as `v128_load`, `f32x4_add`, `f32x4_mul`, and lane extraction.

Advantages:

- Direct control over WebAssembly SIMD instructions.
- Predictable mapping to `v128` operations.
- Available for targeted Wasm code.
- Useful when exact loads, stores, shuffles, and lane operations matter.

Disadvantages:

- Architecture-specific code.
- More verbose and less portable.
- Easier to write code that compiles but does not materially vectorize the hot loop.
- Requires careful handling of alignment, tails, and feature-enabled compilation.

`std::simd` is the portable Rust SIMD abstraction. It is cleaner for generic vector code, but support and stabilization status may vary with the Rust toolchain and target. It may also produce different lowering than hand-written Wasm intrinsics. For a Wasm-only physics core where predictable code generation is important, `core::arch::wasm32` is usually the safer production choice; for a cross-platform Rust library, use an abstraction layer and inspect generated Wasm.

Compile the SIMD variant with the appropriate target feature, commonly:

```text
-RUSTFLAGS=-Ctarget-feature=+simd128
```

Then inspect the generated Wasm or disassembly. Enabling the feature does not guarantee that every loop is vectorized; one investigation found SIMD instructions in the aggregate module but none in the measured Welford loop, illustrating that compiler output must be verified rather than assumed.[10]

## Data-layout requirements

The most important optimization is usually **SoA plus batching**, not the intrinsic itself.

Prefer:

```text
x:        [f32; n]
y:        [f32; n]
vx:       [f32; n]
vy:       [f32; n]
inv_mass: [f32; n]
```

over:

```text
particles: [{ x, y, vx, vy, inv_mass }; n]
```

Important details:

- Process four `f32` values per vector.
- Pad or handle the final 1–3 elements separately.
- Keep hot fields contiguous.
- Avoid interleaving rarely used fields.
- Align large arrays where practical, while remembering that Wasm SIMD loads do not require native alignment for correctness.
- Use stable linear-memory addresses during a frame.
- Avoid reallocating or growing memory inside the solver.
- Prefer indices and offsets over object references.
- Batch particles or constraints by operation type.
- Avoid horizontal reductions inside the inner loop; accumulate lane-wise and reduce once.

For indexed contact or constraint work, SoA alone is insufficient if every lane performs unrelated random accesses. Reordering, coloring, batching, and temporary packed working sets can be more valuable than additional SIMD instructions.

## Main pitfalls

### Bounds checks

Rust slice indexing, debug assertions, and bounds checks can remain in hot loops. Use iterators or carefully structured chunked loops, and verify optimized output. `chunks_exact(4)` can make the vector width explicit while leaving a remainder loop for the tail.

### Memory growth

Growing `WebAssembly.Memory` can invalidate JavaScript views. Allocate enough capacity up front, retain typed-array views only when safe, and do not allow a frame’s hot loop to trigger growth.

### Calling overhead

Calling Wasm once per particle or constraint destroys the benefit. Export frame- or batch-level functions:

```text
step_particles(count, dt)
solve_constraints(start, count)
query_points(point_start, point_count, shape_id)
```

One call processing thousands of elements is generally preferable to thousands of calls crossing the JS/Wasm boundary.

### Copying data each frame

Copying JavaScript arrays into Wasm memory and copying results back can dominate the computation. The best architecture keeps simulation state in linear memory and exposes only small results—render transforms, contact events, or summary values—to JavaScript.

If rendering requires JavaScript-visible data, use views into Wasm memory where possible. If a renderer requires a separate buffer, copy only the render-facing subset rather than the entire solver state.

### Aliasing and write conflicts

SIMD is easiest when lanes are independent. Constraint solvers often update shared particles, making vectorization unsafe without coloring, atomics, or staged accumulation. Do not SIMD-vectorize a loop merely because its arithmetic looks parallel.

### Benchmarking errors

Measure separately:

- Kernel time.
- JS↔Wasm call time.
- Input/output copies.
- Allocation and memory growth.
- Broad phase.
- Narrow phase.
- Solver iterations.
- Rendering synchronization.
- Warmed-up steady-state time on representative Android devices.

A benchmark that reports only a tight SIMD kernel can overstate the game-level result by several times. Conversely, benchmarking only a tiny mesh can understate SIMD’s usefulness because fixed overhead dominates.

## Recommended architecture

For a browser soft-body engine:

1. Keep all particle, constraint, and shape data in Wasm linear memory.
2. Use SoA for particle fields and hot constraint parameters.
3. Export one function per simulation phase, not per object.
4. Batch independent constraints and contact tests.
5. Use SIMD for dense arithmetic and broad numeric filtering.
6. Leave irregular manifold construction scalar unless profiling proves otherwise.
7. Provide scalar and SIMD Wasm builds.
8. Feature-detect SIMD at startup.
9. Benchmark complete frames on representative Android hardware.
10. Inspect generated Wasm to confirm actual `v128` loads, arithmetic, and stores.

The likely outcome is a substantial improvement in the numeric core—often around 1.5–3×—but a smaller whole-game gain unless the simulation dominates the frame and data remains in linear memory.

[1] WebAssembly SIMD support - Nutrient (https://www.nutrient.io/guides/web/troubleshooting/webassembly-simd-support/)
[2] core::arch::wasm32 - Rust (https://doc.rust-lang.org/core/arch/wasm32/index.html)
[3] stdarch/crates/core_arch/src/wasm32/simd128.rs at main · rust-lang/stdarch (https://github.com/rust-lang/stdarch/blob/main/crates/core_arch/src/wasm32/simd128.rs)
[4] core::arch::wasm32 - Rust (https://doc.rust-lang.org/beta/core/arch/wasm32/index.html)
[5] WebAssembly: Browser Support, Features, Use Cases - TestMu AI (https://www.testmuai.com/learning-hub/webassembly-compatible-browsers/)
[6] WebAssembly SIMD | Can I use... Support tables for HTML5, CSS3, etc (https://caniuse.com/wasm-simd)
[7] Relaxed-width SIMD (WebAssembly) | Can I use... Support ... (https://caniuse.com/wf-wasm-simd-relaxed)
[8] The State of WebAssembly – 2021 and 2022 - Uno Platform (https://platform.uno/blog/the-state-of-webassembly-2021-and-2022/)
[9] labhub.hopto.org › blog › aiWebAssembly & Edge Computing: Browser AI Inference ... (https://labhub.hopto.org/blog/ai/2026-03-17-webassembly-edge-computing-guide?lang=en)
[10] What Rust's +simd128 Actually Changed in My ... (https://www.debugdiary.dev/log/rust-simd128-what-changed-in-webassembly)
