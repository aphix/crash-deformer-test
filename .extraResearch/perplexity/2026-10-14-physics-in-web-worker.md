For ~30 cars with typed-array state and a deterministic fixed-step simulation, use a **physics worker** and keep rendering on the main thread. Prefer **`SharedArrayBuffer` only when you control deployment headers and need continuous, high-volume shared state**; otherwise use a double- or triple-buffered transferable `ArrayBuffer` protocol.

## Recommended architecture

- Worker owns the authoritative physics state: positions, rotations, velocities, wheel/suspension state, soft-body nodes, contact data, and deterministic RNG.
- Main thread owns rendering, interpolation, input collection, audio, and presentation.
- Run physics at a fixed rate, for example \(60\ \text{Hz}\), independent of render rate.
- Send only compact render snapshots, not the entire solver state.
- Use structure-of-arrays typed buffers, for example:
  - `posX[car]`, `posY[car]`, `posZ[car]`
  - quaternion or yaw arrays
  - wheel transforms
  - soft-body node positions, if they are visible
- Keep broad-phase structures, constraints, manifolds, warm-start impulses, and solver scratch arrays inside the worker.

A typical render loop interpolates between the two latest completed snapshots:

\[
\alpha=\frac{t_{\text{render}}-t_{\text{physics-old}}}{\Delta t}
\]

\[
x_{\text{display}}=(1-\alpha)x_{\text{old}}+\alpha x_{\text{new}}
\]

Use quaternion slerp for orientations and avoid extrapolation unless necessary. Interpolation adds approximately one physics tick of visual latency, usually about \(16.7\) ms at 60 Hz, but removes visible stepping when rendering and physics are unsynchronized.

## SharedArrayBuffer plus Atomics

`SharedArrayBuffer` lets the worker and main thread view the same memory; it is not transferable and does not require copying the underlying bytes.[1][2] Atomics are needed for ownership flags, sequence counters, and synchronization—not for every floating-point read and write.

A robust design is a ring of three or four snapshot slots:

```text
slot 0: being rendered
slot 1: newest completed snapshot
slot 2: worker write target
```

Each slot contains:

```text
Float32Array: transforms and visible simulation state
Int32Array:   sequence number, state, frame index
```

The worker writes a slot, then publishes its sequence number with an atomic store. The main thread reads a completed slot and checks the sequence before and after reading. Do not continuously mutate a snapshot while the renderer is consuming it; use slot ownership or versioning.

For input, use a small shared command structure:

```text
input sequence
steering
throttle
brake
handbrake
buttons
timestamp
```

The main thread writes the newest input and increments a sequence counter. The worker consumes it at the next fixed step. This avoids queue buildup and generally gives lower latency than sending every input as a separate message.

### Advantages

- No per-frame multi-megabyte copy.
- Stable memory usage after initialization.
- Efficient for large soft-body state or many visible bodies.
- Easy to maintain persistent worker-owned solver data.
- Suitable for a shared input/output ring buffer.

### Costs and deployment risks

`SharedArrayBuffer` requires a secure, cross-origin-isolated page, normally using:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

or a compatible `COEP: credentialless` deployment. Cross-origin isolation also affects resource loading: third-party scripts, images, workers, WASM, fonts, iframes, and other assets may need CORS or CORP permission. This can break ad tags, analytics, embedded widgets, external texture/CDN arrangements, and iframe integrations until audited.[3]

WebRTC is not inherently incompatible, but cross-origin isolation can complicate integrations involving third-party iframes, embedded conferencing components, or resources lacking the required headers. Test the complete signaling and media path rather than assuming compatibility.

AudioWorklets run in a separate audio execution context. They can coexist with isolation, and `SharedArrayBuffer` is useful for low-latency audio rings, but the worklet and worker must use carefully designed lock-free protocols. Do not block an AudioWorklet with `Atomics.wait`; blocking the audio thread risks glitches. Audio synchronization should generally use timestamps or a small ring buffer.

## Transferable ArrayBuffers

A transferable `ArrayBuffer` moves ownership rather than cloning the bytes. The sender’s buffer becomes detached, so use a pool of two or three buffers:

1. Main thread renders buffer A.
2. Worker writes buffer B.
3. Worker transfers B and receives a free buffer.
4. Main thread returns the previously rendered buffer.

This avoids allocating and garbage-collecting a new snapshot every frame.

Transferables are often fast enough for compact snapshots—for example, 30 cars with transforms and wheel state—but the protocol must account for ownership and occasional queue delays. Sending a large state buffer is not equivalent to transferring it: ordinary structured cloning copies the data, while transfer changes ownership.

One benchmark reports roughly **0.08 ms for a transferable buffer**, largely independent of size, on a 2023-class desktop Chrome system, while structured cloning was about **1.2 ms per MB**.[4] Another report measured roughly **12–18 ms to clone 10 MB**, compared with sub-millisecond shared-memory publication overhead.[5] These are indicative measurements, not mobile guarantees: Android devices, browser versions, memory pressure, and buffer layout can change the result substantially.

For a few-megabyte snapshot at 60 Hz:

- **Structured clone:** potentially several milliseconds per frame and unacceptable once the payload approaches 10 MB.
- **Transferable buffer:** usually dominated by synchronization, scheduling, cache effects, and deserialization—not byte copying.
- **SharedArrayBuffer:** near-zero publication cost, but the simulation still pays the cost of writing and the renderer pays the cost of reading the data.

Measure on target phones with a real production-sized buffer. Desktop transfer numbers should not be treated as mobile performance guarantees.

## Input latency

The lowest-latency practical arrangement is:

- Sample input on the main thread immediately before or during the render frame.
- Write the newest input into shared memory, or send a tiny input message.
- Let the worker consume it at the next fixed-step boundary.
- Timestamp the input and simulation step.
- Render the resulting state with interpolation.

With a 60 Hz simulation, the average wait until the next physics step is about \(8.3\) ms, with a worst case near one tick. Interpolating snapshots adds visual delay, so a common compromise is to interpolate ordinary vehicles while rendering the locally controlled vehicle with limited extrapolation or a shorter presentation delay.

Do not send a separate message for every wheel or soft-body node. Batch input and state publication per simulation tick.

## Browser support and mobile behavior

Modern Chrome for Android and Firefox for Android support Web Workers, typed arrays, transferable `ArrayBuffer`s, and `SharedArrayBuffer` when the page satisfies cross-origin-isolation requirements. The main practical differences are:

- Mobile Chrome generally has strong worker and WASM performance, but background throttling, thermal limits, and memory pressure can reduce sustained rates.
- Firefox Android supports the same core APIs, but performance characteristics of WASM, Atomics, garbage collection, and worker scheduling can differ enough to require separate profiling.
- `SharedArrayBuffer` availability must be checked at runtime with `crossOriginIsolated`; do not infer it from browser version.
- Some mobile browsers suspend or heavily throttle background tabs, so a worker cannot be treated as a real-time server.
- Large shared allocations can fail or trigger memory pressure even when the nominal JavaScript heap appears sufficient.

A useful fallback is:

```js
const canUseSharedState =
  typeof SharedArrayBuffer !== "undefined" &&
  globalThis.crossOriginIsolated === true;
```

If false, use transferable snapshot buffers. Keep the simulation protocol identical so the transport mechanism is replaceable.

## Worker startup

Worker startup is usually a one-time cost, but it matters during loading and on low-end phones. Startup includes worker creation, script/WASM compilation, initialization, and allocation—not merely `new Worker()`. A small worker can start in a few milliseconds, while a WASM physics engine can take tens to hundreds of milliseconds depending on compilation, cache state, device, and module size. Treat startup as a loading-stage operation:

- Create the worker while the game shell loads.
- Compile or instantiate WASM before gameplay begins.
- Preallocate all physics and snapshot buffers.
- Avoid lazy allocation during the first race.
- Consider `WebAssembly.instantiateStreaming` where server MIME types and deployment permit it.
- Measure cold start and cached start separately.

No universal “worker startup” number is reliable across Firefox Android and mobile Chrome; benchmark the exact engine build and phone class.

## Real-world engines and examples

- **PlayCanvas** uses Ammo.js, a WebAssembly port of Bullet, as its physics backend.[6]
- **Babylon.js Havok integration** supports WebAssembly Havok and worker-oriented execution patterns, making it a relevant reference for moving physics off the main thread.
- **Ammo.js worker demos** commonly place the Bullet/Ammo simulation in a worker and exchange transforms with the main thread.
- **Rapier** has JavaScript/WASM builds that can run in a worker; applications typically define their own message or shared-buffer protocol around the simulation.
- These engines demonstrate that worker physics is practical, but their default integration does not automatically solve snapshot ownership, interpolation, input prediction, or soft-body bandwidth.

## Practical choice

| Situation | Preferred transport |
|---|---|
| Cross-origin isolation is easy and state is large or continuous | `SharedArrayBuffer` ring buffers |
| Third-party assets, iframes, ads, or WebRTC integrations make COOP/COEP risky | Transferable `ArrayBuffer` pool |
| Snapshot is small, such as transforms for 30 cars | Transferables are often simplest |
| Large soft-body render state every frame | Shared memory, or reduce/quantize visible state |
| Need maximum portability | Transferables with a shared protocol abstraction |
| Deterministic simulation | Worker-owned fixed-step state; transport only inputs and presentation snapshots |

For this game, the strongest default is a **worker-owned deterministic solver plus triple-buffered transferable snapshots**, unless the soft-body visualization produces several megabytes per frame or the page already requires cross-origin isolation. If isolation is acceptable, use a **shared input block and shared snapshot ring**, with Atomics only for sequence and ownership control. Keep a transferable fallback for Firefox Android, mobile Chrome configurations, embedded deployments, and environments where COOP/COEP cannot be guaranteed.

[1] SharedArrayBuffer and Atomics: Real Shared Memory in the Browser (https://news.tapiwa.me/sharedarraybuffer-atomics-js/)
[2] javascriptbit.com · sharedarraybuffer-atomicsSharedArrayBuffer and Atomics in JavaScript | JavaScriptBit (https://javascriptbit.com/sharedarraybuffer-atomics-javascript/)
[3] Cross-Origin Embedder Policy (https://www.frontend.beauty/learn/browser/cross-origin-embedder-policy)
[4] SharedArrayBuffer (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
[5] Getting Started | PlayCanvas Developer Site (https://developer.playcanvas.com/user-manual/physics/physics-basics/)
[6] SharedArrayBuffer: Browser Support, Isolation, Use Cases (https://www.testmuai.com/learning-hub/sharedarraybuffer-browser-support/)
[7] Physics | PlayCanvas Developer Site (https://developer.playcanvas.com/user-manual/physics/)
[8] Documentation — Peito Denoise (https://peito.ru/en/docs/)
[9] How to Pass Large Arrays Without Blocking the UI (https://www.javascript-web-workers.com/web-workers-architecture-communication/transferable-objects-zero-copy/how-to-pass-large-arrays-without-blocking-ui/)
[10] www.javascript-web-workers.com · web-workersSharedArrayBuffer & Atomics · JS Web Workers (https://www.javascript-web-workers.com/web-workers-architecture-communication/sharedarraybuffer-atomics/)
