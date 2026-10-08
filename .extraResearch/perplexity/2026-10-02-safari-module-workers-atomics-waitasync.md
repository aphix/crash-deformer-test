First Safari / iOS Safari version supporting: module workers (new Worker(url, {type:'module'})), Atomics.waitAsync, and Atomics.wait in workers. First Firefox version supporting module workers and Atomics.waitAsync. Is WebAssembly relaxed SIMD shipped in Firefox (which version)? Cite MDN browser compat data, caniuse, webkit.org release notes, Firefox release notes.

Safari first supported **module workers** in Safari 15.0, and iOS Safari first supported them in iOS 15.0[3]. Firefox first supported module workers in Firefox 114[3].  

For **Atomics.waitAsync**, Safari first supported it in Safari 16.4 and iOS Safari 16.4[1][2]. Firefox first supported `Atomics.waitAsync` in Firefox 145[1][2][9].  

For **Atomics.wait in workers**, the relevant support is effectively Safari 14.1+ and Firefox 79+ for WebAssembly threads/atomics support, with `Atomics.wait` being blocked on the main thread but available in workers where `SharedArrayBuffer`/threads are supported[8][12].  

**WebAssembly relaxed SIMD** is shipped in Firefox 153[10].

[1] Atomics.waitAsync() | Can I use... Support tables for HTML5 ... (https://caniuse.com/wf-atomics-wait-async)
[2] JavaScript built-in: Atomics: waitAsync (https://caniuse.com/mdn-javascript_builtins_atomics_waitasync)
[3] JavaScript modules in workers | Can I use... Support tables for ... (https://caniuse.com/wf-js-modules-workers)
[4] Web Workers — Stop Blocking the Only Thread That Paints ... (https://allahabadi.dev/blogs/frontend/web-worker-move-work-off-main-thread/)
[5] Worker API - Support for ECMAScript modules - CanIUse (https://caniuse.com/mdn-api_worker_worker_ecmascript_modules)
[6] Atomics.waitAsync() browser support at 90.1% - BaseWatch (https://basewatch.dev/feature/wf-atomics-wait-async)
[7] Web Workers | Can I use... Support tables for HTML5, CSS3, etc (https://caniuse.com/webworkers)
[8] Atomics.wait() - JavaScript - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait)
[9] Firefox Nightly Release Notes (https://www.firefox.com/en-US/firefox/145.0a1/releasenotes/)
[10] Firefox 153 release notes for developers - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153)
[11] IO in a webworker without asyncio? · Issue #1219 · pyodide ... - GitHub (https://github.com/pyodide/pyodide/issues/1219)
[12] WebAssembly Threads and Atomics | Can I use... Support ... (https://caniuse.com/wasm-threads)
[13] www.firefox.com · en-US · firefoxFirefox 155.0, See All New Features, Updates and Fixes (https://www.firefox.com/en-US/firefox/155.0/releasenotes/)
[14] 1467846 - Implement the Atomics.waitAsync proposal (https://bugzilla.mozilla.org/show_bug.cgi?id=1467846)
[15] Shared Web Workers | Can I use... Support tables for HTML5 ... (https://caniuse.com/sharedworkers)
