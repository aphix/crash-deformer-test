# Query: Speeding up a slow node:test suite dominated by deterministic sim lead-up (snapshots, startup snapshots, compile cache, LPT sharding, fixture caching)

1|The biggest win is usually to stop replaying the whole deterministic lead-up for every test: snapshot the sim at the moment of interest, restore that state per test, and keep the “drive-up” phase in one setup step instead of 2,400 times. If that state is plain data, `structuredClone`, `v8.serialize`, or custom binary serializers for typed arrays/classes can make restores fast enough to change the suite from minutes to seconds in the hot path.
2|
3|## 1) Snapshot the simulation state at the moment of interest
4|
5|For a deterministic physics sim, the best pattern is:
6|
7|- Run a single authoritative setup that advances from a fresh start to the exact “interesting” state.
8|- Freeze that state into a compact snapshot.
9|- Restore that snapshot at the start of each test.
10|- Only vary the final action/assertion under test.
11|
12|### Good state shape
13|
14|Snapshot only the minimum state required to resume deterministically:
15|
16|- world time / tick index
17|- RNG state
18|- entity positions, velocities, orientations
19|- controller inputs already applied
20|- collision caches if they affect future evolution
21|- any game-specific hidden state
22|
23|Avoid storing transient derived values if they can be recomputed quickly.
24|
25|### Plain-state approach
26|
27|If most state is JSON-ish plain objects and typed arrays:
28|
29|```js
30|import { serialize, deserialize } from 'node:v8';
31|
32|function saveSimSnapshot(sim) {
33|  return serialize({
34|    tick: sim.tick,
35|    rngState: sim.rngState,
36|    bodies: sim.bodies,
37|    cars: sim.cars,
38|    track: sim.track,
39|    // typed arrays are supported by v8 serialize
40|    broadphase: sim.broadphase,
41|  });
42|}
43|
44|function restoreSimSnapshot(buf) {
45|  return deserialize(buf);
46|}
47|```
48|
49|If you need object identity preservation and class instances, `v8.serialize` is usually better than `structuredClone` because it handles more Node/V8 types and can preserve graphs. For very large numeric arrays, custom packing is often faster and smaller.
50|
51|### Custom serializers for class instances
52|
53|If you have classes like `Vehicle`, `Vec3`, `PhysicsWorld`, define explicit encode/decode methods:
54|
55|```js
56|class Vehicle {
57|  constructor() {
58|    this.pos = new Float64Array(3);
59|    this.vel = new Float64Array(3);
60|    this.yaw = 0;
61|    this.wheelAngles = new Float64Array(4);
62|  }
63|
64|  toSnapshot() {
65|    return {
66|      pos: new Float64Array(this.pos),
67|      vel: new Float64Array(this.vel),
68|      yaw: this.yaw,
69|      wheelAngles: new Float64Array(this.wheelAngles),
70|    };
71|  }
72|
73|  static fromSnapshot(s) {
74|    const v = new Vehicle();
75|    v.pos.set(s.pos);
76|    v.vel.set(s.vel);
77|    v.yaw = s.yaw;
78|    v.wheelAngles.set(s.wheelAngles);
79|    return v;
80|  }
81|}
82|```
83|
84|For very large typed arrays, use raw buffer copies:
85|
86|```js
87|function copyF64(src) {
88|  return new Float64Array(src); // copies data
89|}
90|
91|function restoreF64(dst, src) {
92|  dst.set(src);
93|}
94|```
95|
96|Or snapshot an `ArrayBuffer` directly if layout is stable.
97|
98|### Expected gain
99|
100|If the “lead-up” is most of each test’s runtime, this can reduce each test from “drive 200 seconds of sim time” to “clone a snapshot and run one step”. In practice that can be an order-of-magnitude win for suites where setup dominates.
101|
102|### Pitfalls for determinism
103|
104|- Do not omit hidden state that affects future physics.
105|- Make sure RNG is seeded and serialized.
106|- Avoid `Math.random()` anywhere in the sim.
107|- Avoid reliance on object iteration order if maps/sets are mutated nondeterministically.
108|- If floating-point results depend on instruction order, keep the exact same code path after restore.
109|- If collision resolution uses caches, those caches must be included or intentionally recomputed.
110|
111|## 2) Node startup snapshots
112|
113|Node startup snapshots can help when each test process spends noticeable time loading modules and building fixture data before tests even begin. Node’s `v8.startupSnapshot` supports serialization/deserialization hooks for custom startup snapshots, and the CLI supports building and consuming snapshot blobs[2][4]. The startup snapshot model is also used for single-executable apps, where the main script runs at snapshot-build time and a deserialize entry function runs later[5].
114|
115|### What this is good for
116|
117|- expensive module initialization
118|- precomputed fixture tables
119|- static game data
120|- prebuilt sim metadata that does not depend on per-test inputs
121|
122|### What this is not good for
123|
124|- per-test mutable state
125|- data that must differ across workers or test cases
126|- anything needing dynamic filesystem state at runtime
127|- workflows tightly coupled to ESM/transpilation behavior
128|
129|### Practical limitation with ESM and `--experimental-strip-types`
130|
131|Startup snapshots are most straightforward when the snapshot-building entrypoint can run the same module graph you will later deserialize. In practice, that is easier with CommonJS than with ESM-heavy trees, and type-stripping adds another layer of build-time/runtime mismatch risk because snapshot creation happens before the final test run. A common pattern is:
132|
133|- keep snapshot-building code in plain JavaScript
134|- precompute static fixture data there
135|- avoid snapshotting live test code directly
136|- load stripped TypeScript test files at runtime outside the snapshot
137|
138|### Sketch
139|
140|Build-time:
141|
142|```js
143|// snapshot-build.js
144|import v8 from 'node:v8';
145|import { buildFixtureIndex } from './fixtures.js';
146|
147|const cache = buildFixtureIndex();
148|
149|v8.startupSnapshot.setDeserializeMainFunction(() => {
150|  globalThis.__fixtureIndex = cache;
151|});
152|```
153|
154|Build blob:
155|
156|```bash
157|node --build-snapshot --snapshot-blob snapshot.blob snapshot-build.js
158|```
159|
160|Run with snapshot:
161|
162|```bash
163|node --snapshot-blob snapshot.blob
164|```
165|
166|### Expected gain
167|
168|Startup snapshots usually save seconds, not minutes, unless module initialization is very heavy. They are most valuable if every worker/process repeats the same expensive bootstrap.
169|
170|### Pitfalls
171|
172|- snapshot size can grow quickly
173|- closures and environment capture can be surprising
174|- native resources, file handles, sockets, and timers should not be snapshotted
175|- you still need runtime logic for anything not fully static
176|
177|## 3) Compile cache
178|
179|Node now exposes compile-cache support via `module.enableCompileCache()` and the `NODE_COMPILE_CACHE` environment variable[6]. This caches parsed/compiled module output on disk so later runs can skip some JavaScript compilation work[6].
180|
181|### How to use it
182|
183|Early in startup, before loading most modules:
184|
185|```js
186|import module from 'node:module';
187|
188|module.enableCompileCache();
189|```
190|
191|Or:
192|
193|```bash
194|NODE_COMPILE_CACHE=/tmp/node-compile-cache node --test
195|```
196|
197|### Best use case
198|
199|- lots of test files
200|- repeated CI runs on the same branch
201|- expensive transpilation/strip-types parsing overhead
202|- many short-lived worker processes
203|
204|### Expected gain
205|
206|Usually modest per run, but noticeable over many repeated invocations. It helps more with cold-start CPU overhead than with the physics loop itself.
207|
208|### Pitfalls
209|
210|- if source changes, cache invalidates appropriately, but cache churn can happen on active branches
211|- call it early
212|- worker threads may need separate enablement depending on how they are created[8]
213|
214|## 4) Worker-thread sharding with longest-processing-time-first scheduling
215|
216|Because some tests take 200 seconds while others are cheap, equal-sized file sharding wastes time. Longest-processing-time-first scheduling reduces tail latency: assign the longest remaining test to the currently least-loaded worker.
217|
218|### Simple approach
219|
220|1. Measure per-test or per-file duration from previous runs.
221|2. Sort descending by duration.
222|3. Greedily assign each test to the worker with the smallest accumulated load.
223|
224|Pseudo-code:
225|
226|```js
227|function shardLPT(items, workerCount) {
228|  const workers = Array.from({ length: workerCount }, () => ({
229|    load: 0,
230|    items: [],
231|  }));
232|
233|  items.sort((a, b) => b.ms - a.ms);
234|
235|  for (const item of items) {
236|    workers.sort((a, b) => a.load - b.load);
237|    workers[0].items.push(item);
238|    workers[0].load += item.ms;
239|  }
240|
241|  return workers;
242|}
243|```
244|
245|### In practice
246|
247|- shard by test file if individual tests are not independently enumerable
248|- shard by test case if you can pre-discover them
249|- keep a duration file in CI artifacts
250|- update durations after each run
251|
252|### Expected gain
253|
254|This often improves wall-clock time substantially when there is a heavy long-tail distribution. If you currently have 3 slots and a few huge tests, LPT can cut idle time at the end of the run.
255|
256|### Pitfalls
257|
258|- shared mutable external resources can cause interference
259|- worker startup overhead can erase gains for tiny shards
260|- order-dependent tests become more visible
261|- use isolated temp dirs and per-worker ports
262|
263|## 5) Cache computed fixtures to disk keyed by source hash
264|
265|If a fixture derivation is deterministic and expensive, cache it to disk.
266|
267|### Pattern
268|
269|- hash the fixture source and relevant config
270|- compute once
271|- write binary cache file
272|- reload on future runs if hash matches
273|
274|Example:
275|
276|```js
277|import { createHash } from 'node:crypto';
278|import { readFile, writeFile } from 'node:fs/promises';
279|import { existsSync } from 'node:fs';
280|
281|function keyFor(source, config) {
282|  return createHash('sha256')
283|    .update(source)
284|    .update('\0')
285|    .update(JSON.stringify(config))
286|    .digest('hex');
287|}
288|
289|async function getCachedFixture(pathBase, source, config, buildFn) {
290|  const key = keyFor(source, config);
291|  const file = `${pathBase}/${key}.bin`;
292|
293|  if (existsSync(file)) {
294|    const buf = await readFile(file);
295|    return deserialize(buf);
296|  }
297|
298|  const value = await buildFn();
299|  await writeFile(file, serialize(value));
300|  return value;

[Showing lines 1-300 of 394. Use :301 to continue]