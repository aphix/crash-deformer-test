Is postMessage with a transfer list of ArrayBuffer (transferable objects) zero-copy in Safari/WebKit, Chrome and Firefox between main thread and a dedicated Web Worker? What is the per-message overhead / latency of postMessage between main thread and worker at 60 Hz with ~100 KB Float32Array payloads? Cite sources and benchmarks.

Yes. `postMessage` with a transfer list for an `ArrayBuffer` is implemented as a zero-copy ownership transfer in Chrome, Firefox, Safari/WebKit, and MDN describes the buffer as detached on the sender side and moved to the receiver side[1][3][4][6][12]. Chrome’s transferable-objects note explicitly says the operation is zero-copy and lists support in Chrome, Firefox, Safari, and IE10+[1].

For a dedicated worker hop at 60 Hz with ~100 KB `Float32Array` payloads, the relevant detail is that `Float32Array` itself is not transferable; the transferable item is its `.buffer`[15]. In practice, the transfer cost is treated as constant and typically well under 1 ms even for much larger buffers, while clone-based `postMessage` scales with payload size and can be several milliseconds for ~100 KB payloads[14][15]. A benchmark-oriented writeup from JS Web Workers summarizes pooled-worker dispatch as roughly 0.05–0.15 ms for a small structured-clone payload, and another benchmark-oriented article says ~100 KB cloned payloads are around ~10 ms versus transfer under ~1 ms[14][15].

So for your use case, transfer-list `postMessage` is the right choice and should comfortably fit a 60 Hz budget; the main latency risk is using cloning instead of transfer, not the worker hop itself[1][12][14][15]. If you need exact per-browser numbers, those vary by engine version and hardware, and the sources above provide the best broadly applicable benchmark ranges rather than a fixed guarantee[14][15].

[1] Transferable objects - Lightning fast | Blog (https://developer.chrome.com/blog/transferable-objects-lightning-fast)
[2] Transferable Objects & Zero-Copy · JS Web Workers (https://www.javascript-web-workers.com/web-workers-architecture-communication/transferable-objects-zero-copy/)
[3] Embedded workers (https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
[4] ArrayBuffer (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer)
[5] Worklets (https://esmodules.com/workers/)
[6] Worker: postMessage() method - Web APIs | MDN (https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage)
[7] MessagePort: postMessage() method - Web APIs | MDN (https://developer.mozilla.org/en-US/docs/Web/API/MessagePort/postMessage)
[8] how to pass large data to web workers (https://stackoverflow.com/questions/19152772/how-to-pass-large-data-to-web-workers)
[9] SharedArrayBuffer (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
[10] Window: postMessage() method (https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
[11] Transferable Objects in JavaScript: Zero-Copy postMessage (https://javascriptbit.com/javascript-transferable-objects-postmessage/)
[12] Transferable objects - Web APIs | MDN (https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
[13] Moving ArrayBuffers Instead of Copying in postMessage (https://www.mironsoft.de/en/blog/javascript-transferable-objects-and-arraybuffer-transfer-with-postmessage)
[14] Worker Pool Management · JS Web Workers (https://www.javascript-web-workers.com/web-workers-architecture-communication/worker-pool-management/)
[15] Web Workers and Worklets for Off-Main-Thread Work (https://sujeet.pro/articles/web-workers-and-worklets)
