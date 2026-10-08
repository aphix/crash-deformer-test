Safari and iOS Safari first version supporting: WebAssembly SIMD128 (fixed-width SIMD), SharedArrayBuffer with crossOriginIsolated (COOP/COEP), module workers new Worker(url, {type:'module'}), Atomics.wait inside dedicated workers, Atomics.waitAsync, WebAssembly threads (shared memory). Also WebAssembly relaxed SIMD support status in Chrome, Firefox and Safari as of 2026. Cite caniuse, MDN, webkit.org release notes, webstatus.dev.

Safari first supported WebAssembly SIMD128 in Safari 16.4, and iOS Safari first supported it in iOS 16.4.[9][2] SharedArrayBuffer for cross-origin isolated pages is supported in Safari 15.2 and iOS Safari 15.2, with COOP/COEP required to expose it.[6][11] Module workers via `new Worker(url, { type: "module" })` are supported in modern Safari/iOS Safari, but the first-version detail was not surfaced in the retrieved sources.[13]

`Atomics.wait()` works in dedicated workers and is blocked on the main thread; it uses `SharedArrayBuffer`-backed `Int32Array` or `BigInt64Array` views.[7] `Atomics.waitAsync()` is the non-blocking counterpart, usable on the main thread, but the retrieved sources did not expose a first Safari/iOS Safari version.[14] WebAssembly threads/shared memory require `SharedArrayBuffer` plus cross-origin isolation; Safari support for WASM threads is reported around Safari 14.1+ on macOS and 14.5+ on iOS/iPadOS in the retrieved material, though that source is not one of the requested primary references.[12][13]

For relaxed SIMD, Can I Use shows Safari support as not available through Safari 27/TP in the retrieved entry, while WebAssembly SIMD128 itself is supported from Safari 16.4 onward.[1][9] I could not verify a matching first-version support row for relaxed SIMD in Chrome and Firefox from the retrieved primary sources, but the available Can I Use entry indicates Safari remains unsupported as of the current data snapshot.[1]

[1] Relaxed-width SIMD (WebAssembly) | Can I use... Support ... (https://caniuse.com/wf-wasm-simd-relaxed)
[2] instructions: and: `v128` (SIMD) value (https://caniuse.com/mdn-webassembly_instructions_and_v128)
[3] WebAssembly in 2026: SIMD, Threads, Wasm 3.0, and the New ... (https://alldevtoolshub.com/blog/webassembly-browser-tools-2026-simd-threads-wasm-3/)
[4] WebAssembly: Browser Support, Features, Use Cases (https://www.testmuai.com/learning-hub/webassembly-compatible-browsers/)
[5] instructions: ge: `v128` (SIMD) value interpretations (https://caniuse.com/mdn-webassembly_instructions_ge_v128)
[6] SharedArrayBuffer: Browser Support, Isolation, Use Cases (https://www.testmuai.com/learning-hub/sharedarraybuffer-browser-support/)
[7] Atomics.wait() - JavaScript - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait)
[8] www.webassembly-wasm.com › js-wasm-interop-memorySharedArrayBuffer, Atomics & Threading | Wasm Docs (https://www.webassembly-wasm.com/js-wasm-interop-memory-management/sharedarraybuffer-atomics-threading/)
[9] WebAssembly SIMD | Can I use... Support tables for HTML5, CSS3, etc (https://caniuse.com/wasm-simd)
[10] 为什么你的WASM多线程C程序不工作？90%开发者忽略的底层机制解析 (https://blog.csdn.net/ProcePerch/article/details/155853543)
[11] WebAssembly Browser Support 2026: Compatibility Guide (https://reintech.io/blog/webassembly-browser-support-2026-compatibility-guide)
[12] WASM Threads: Browser Support, Atomics, COOP/COEP - TestMu AI (https://www.testmuai.com/learning-hub/wasm-threads-browser-support/)
[13] Using WebAssembly threads from C, C++ and Rust | Articles - web.dev (https://web.dev/articles/webassembly-threads)
[14] Atomics.waitAsync() (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync)
[15] Explainer: Allowing Atomics.wait on the main thread (https://github.com/WebAssembly/shared-everything-threads/blob/main/proposals/shared-everything-threads/WaitOnMainThread.md)
