Firefox’s current optimizing pipeline is **Warp front-end + Ion back-end**—“Ion” has not disappeared as the optimizing compiler, but Warp replaced the older IonBuilder/type-inference front end. Warp consumes Baseline CacheIR feedback and can be faster and lighter than the old Ion pipeline, though performance remains workload-dependent.[2][3]

## Practical conclusions

For hot numeric loops over `Float32Array` or `Float64Array`, Firefox can reach excellent native-code performance, but it is generally less forgiving than V8 when feedback becomes polymorphic or when the loop contains allocation, calls, or hard-to-analyze control flow. Treat the following as engineering rules rather than universal Firefox-vs-Chrome laws: exact results vary by Firefox/V8 version, CPU, array size, warm-up, and benchmark methodology.

### 1. Keep typed-array access monomorphic

Prefer one stable typed-array kind and one stable backing representation:

```js
function integrate(x, y, vx, vy, dt, n) {
  for (let i = 0; i < n; i++) {
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
}
```

Avoid repeatedly passing different combinations of:

- `Float32Array` and `Float64Array`
- typed arrays and ordinary arrays
- arrays from different abstraction layers
- views with changing element types or unusual offsets

A call site that sees one stable typed-array class can use specialized CacheIR and optimized code. A megamorphic site must retain more checks and may fall back toward generic paths. Warp’s optimization data comes from Baseline feedback and CacheIR, so stable feedback is particularly valuable.[2][3]

**Measure:** benchmark separate functions for `Float32Array`, `Float64Array`, and ordinary arrays rather than one generic function accepting all three. A useful regression signal is a sudden increase in time after introducing a second array type at the same access site.

### 2. Hoist invariants and make bounds obvious

Use a local length and simple counted loops:

```js
function step(a, b, scale) {
  const n = a.length;
  for (let i = 0; i < n; i++) {
    a[i] = a[i] + b[i] * scale;
  }
}
```

Do not manually add a bounds check unless profiling shows a real problem. Typed-array accesses must preserve JavaScript’s out-of-bounds semantics, but optimizing JITs can often eliminate or simplify checks when loop limits, lengths, and views are stable. Dynamic indices, changing lengths, multiple aliases, resizable/shared-buffer complications, or opaque calls inside the loop make that harder.

Do not assume typed arrays are automatically faster than ordinary arrays. Typed arrays provide predictable packed numeric storage, but their access still involves view/backing-store semantics and bounds correctness. Benchmark the actual workload, especially when the loop is small or call overhead dominates.

### 3. Avoid polymorphic hot call sites

This is often worse:

```js
for (let i = 0; i < n; i++) {
  update(objects[i]); // several unrelated object shapes
}
```

Prefer data-oriented code:

```js
for (let i = 0; i < n; i++) {
  px[i] += vx[i] * dt;
  py[i] += vy[i] * dt;
}
```

If objects are necessary, keep property initialization order and property types consistent. Avoid adding or deleting fields after objects become hot. A property load such as `body.x` is cheap when its inline cache remains monomorphic or narrowly polymorphic; it becomes more expensive when many unrelated shapes appear.

### 4. Keep call targets stable

A hot call site should usually call one function identity:

```js
const integrate = (x, v, dt) => {
  for (let i = 0; i < x.length; i++) x[i] += v[i] * dt;
};

for (let k = 0; k < frames; k++) {
  integrate(x, v, dt);
}
```

Avoid alternating closures, bound functions, methods from unrelated prototypes, or dynamically replaced callbacks at the same site. Inlining is a major source of speed, and unstable call targets reduce or prevent it.

### 5. Do not create closures or objects per element

Avoid:

```js
for (let i = 0; i < n; i++) {
  particles[i].map(v => v * scale);
}
```

Even if escape analysis or scalar replacement removes some allocations, relying on it is fragile. Per-iteration closures, temporary arrays, object literals, boxed values, and callback dispatch can increase both execution time and garbage-collection pressure.

Use one outer allocation and mutate preallocated storage:

```js
for (let i = 0; i < n; i++) {
  out[i] = input[i] * scale;
}
```

Nursery collections are usually inexpensive, but frequent allocation can still cause pauses, promotion, barriers, and loss of frame-time predictability. For games, measure worst-frame and percentile latency, not only average throughput.

### 6. Be cautious with `Math.hypot`

`Math.hypot(dx, dy)` is clear and numerically robust, but it can be slower than the direct two-dimensional expression in a hot loop:

```js
const distance = Math.sqrt(dx * dx + dy * dy);
```

Use the direct form only when its numerical behavior is acceptable. If only comparisons are needed, avoid the square root entirely:

```js
const within = dx * dx + dy * dy <= radius * radius;
```

Do not assume a call is always expensive: a sufficiently hot, stable call may be inlined or specially optimized in some engine versions. Benchmark both forms in the target Firefox release.

### 7. Keep numeric representations stable

JavaScript numbers are conceptually IEEE-754 doubles, but engines use specialized representations and optimized machine types internally. Problems arise when a variable or array position changes between integer-like and fractional values, or between numbers and non-numbers.

Prefer:

```js
let count = 0;
count++;

let energy = 0.0;
energy += force * dt;
```

Do not mix strings, `undefined`, objects, and numbers in the same hot variable. Be careful with bitwise coercions: they force signed 32-bit behavior, wrap large values, and can introduce conversions that are worse than keeping a value as a number.

For `Float32Array`, remember that values are stored as 32-bit floats, while intermediate JavaScript arithmetic may use wider precision. If the algorithm benefits from 32-bit precision, explicitly measure whether repeated stores, conversions, or accumulated error matter. `Float64Array` can be faster or slower depending on the CPU and access pattern; element width alone does not determine performance.

### 8. Split very large functions

A large “god function” can fail to reach the highest tier, compile slowly, or exceed size limits. Current SpiderMonkey source defaults include an Ion script-size limit of roughly 100,000 bytecode units, a much smaller main-thread limit when off-thread compilation is unavailable, and a small-function threshold around 140 bytecode units.[6]

These limits are implementation details and can change, but the practical advice is stable:

- Split rendering, collision, integration, and bookkeeping into separate functions.
- Keep the numeric kernel small and straight-line.
- Move debugging, logging, rare branches, and object-heavy code outside the kernel.
- Avoid enormous switch statements or generated functions in the hottest path.
- Do not split so aggressively that every element incurs a function call; split at per-frame or per-system boundaries.

A small kernel also gives Warp more opportunity to specialize and inline surrounding helpers.

### 9. Warm-up matters

SpiderMonkey normally tiers hot code up to Ion at a warm-up count around 1500 calls in current documentation.[1] A benchmark that runs only a few hundred iterations may mostly measure interpreter/Baseline behavior, compilation, or tier transitions rather than steady-state performance.

For credible measurements:

1. Run a warm-up phase.
2. Exclude compilation and startup from the timed region.
3. Run enough iterations to reach steady state.
4. Repeat after changing one property of the code.
5. Record median and tail latency.
6. Test both a fresh page and a long-running game session.

Tiering can also be affected by deoptimization, invalidation, background compilation, memory pressure, and changing feedback.

## Profiling Firefox

### Firefox Profiler

Use the Firefox Profiler and inspect:

- JavaScript stack frames and self time
- JIT tier labels, such as interpreter, Baseline, and Ion/Warp-generated execution
- deoptimization or invalidation activity
- garbage-collection slices and nursery collections
- samples inside `Math.hypot`, typed-array access, property ICs, or native calls
- whether the hot function remains in optimized code over time

Profile a representative play session, not merely a synthetic startup benchmark. The key question is whether time is spent in the numeric kernel, calls around it, GC, rendering, synchronization, or tiering.

### SpiderMonkey JIT options

For shell or engine-development work, `IONFLAGS` can print Ion/Warp compilation diagnostics. Exact flags vary by Firefox build and release, so inspect the available options for the executable being tested. Useful categories include:

- compilation and abort messages
- MIR and LIR dumps
- bailout and invalidation information
- inlining decisions
- register-allocation/code-generation diagnostics

Use these selectively: MIR/LIR dumps can be enormous and can perturb timing. A practical workflow is to first use the profiler, then enable compilation/abort diagnostics, and only then inspect MIR/LIR for one small kernel.

The source’s JIT options are authoritative for the build under test; for example, the documented size-related defaults include `ionMaxScriptSize`, `ionMaxScriptSizeMainThread`, and `ionMaxLocalsAndArgs`.[6]

## Firefox versus V8

V8 often appears more forgiving in game-loop benchmarks because its feedback and optimization pipeline may handle particular polymorphic patterns, calls, or typed-array kernels more effectively. That does not establish a permanent engine-wide advantage. Firefox may win after the code becomes monomorphic and fully warm, while V8 may win on a different combination of array type, call structure, CPU, and browser version.

The most reliable cross-engine optimization target is therefore:

- one typed-array type per kernel
- stable array identities and lengths
- simple counted loops
- no per-element allocations
- stable function targets
- invariant hoisting
- no unnecessary library calls in the innermost loop
- separate hot numeric kernels from cold control and diagnostic code

Warp is designed to use Baseline’s CacheIR feedback for optimized compilation, and Mozilla reported broad improvements over the pre-Warp Ion pipeline, including a 10–12% Speedometer improvement in its published comparison; Mozilla also noted that Warp could still lose on some synthetic benchmarks.[2] That is a reminder to rely on measurements from the exact browser versions and workload that matter.

[1] How SpiderMonkey Optimizes - Firefox Source Docs (https://firefox-source-docs.mozilla.org/js/how-we-optimize.html)
[2] Trial Inlining: Type... (https://hacks.mozilla.org/2020/11/warp-improved-js-performance-in-firefox-83/)
[3] SpiderMonkey (https://firefox-source-docs.mozilla.org/js/index.html)
[4] SpiderMonkey Newsletter 9 (Firefox 86-87) (https://spidermonkey.dev/blog/2021/02/26/newsletter-9.html)
[5] www.xjavascript.com › blog › javascript-typedarrayWhy Are JavaScript TypedArrays Not As Fast As Regular Arrays ... (https://www.xjavascript.com/blog/javascript-typedarray-performance/)
[6] JitOptions.cpp - mozsearch (https://searchfox.org/firefox-main/source/js/src/jit/JitOptions.cpp)
[7] JIT Compilation System | dds921/spidermonkey | DeepWiki (https://deepwiki.com/dds921/spidermonkey/2.3-jit-compilation-system)
[8] SpiderMonkey Newsletter 10 (Firefox 88-89) (https://spidermonkey.dev/blog/2021/04/22/newsletter-10.html)
[9] mgaudet/SpiderMonkeyBibliography: The Unofficial ... (https://github.com/mgaudet/SpiderMonkeyBibliography)
[10] IonStack Part I: Unsound IonBanana Peel in Ion Compiler ... (https://nebusec.ai/research/ionstack-part-1-cve-2026-10702/)
