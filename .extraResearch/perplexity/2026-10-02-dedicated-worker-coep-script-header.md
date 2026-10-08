When a cross-origin isolated page (COOP same-origin + COEP require-corp) creates a same-origin dedicated Web Worker with new Worker(url, {type:'module'}), must the worker script response itself carry the Cross-Origin-Embedder-Policy header, or is the worker blocked / not crossOriginIsolated (no SharedArrayBuffer) otherwise? Differences between Chrome, Firefox, Safari. Cite HTML spec 'check a global object's embedder policy', MDN, web.dev.

A same-origin dedicated worker created from a cross-origin isolated page does **not** need its own `Cross-Origin-Embedder-Policy` response header for the worker to remain cross-origin isolated; the key requirement is that the worker script load is allowed under the page’s COEP rules, and the worker’s `crossOriginIsolated` state is determined by the embedder-policy check in HTML. The HTML Standard’s “check a global object’s embedder policy” algorithm explicitly covers dedicated workers and compares the worker’s embedder policy with the owner’s policy container[4]. MDN likewise says `crossOriginIsolated` is set by the top-level document’s COOP/COEP response headers and can be checked in both `Window` and `WorkerGlobalScope` contexts[1][2][5].

In practice:
- **Chrome**: dedicated workers created from a COOP+COEP page are cross-origin isolated when the worker script is same-origin and permitted by the page’s embedder policy; no separate COEP response header on the worker script is required for the worker itself to be isolated[4][7][8].
- **Firefox**: follows the same model; `WorkerGlobalScope.crossOriginIsolated` is supported and reflects whether the worker is in a cross-origin isolated context[1][2][5].
- **Safari**: web platform support has historically lagged here, and shared memory / worker isolation behavior has been less complete than Chrome and Firefox; MDN documents the feature generally, but Safari-specific support has been inconsistent compared with the other two browsers[12][13].

The practical rule is: if the page is cross-origin isolated and the worker script is same-origin and loadable under COEP, the worker should also be isolated; a missing COEP header on the worker script response does **not** by itself mean “blocked” or “no SharedArrayBuffer,” though browser support differences, especially in Safari, can still affect availability[1][2][4][12].

[1] WorkerGlobalScope: crossOriginIsolated property - Web APIs | MDN (https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/crossOriginIsolated)
[2] Cross-Origin-Embedder-Policy (COEP) header - HTTP | MDN (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)
[3] HTML Standard 日本語訳 (https://momdo.github.io/html/browsers.html)
[4] 7 Loading web pages - HTML Standard (https://html.spec.whatwg.org/multipage/browsers.html?ref=mlog.me)
[5] Window: crossOriginIsolated property - Web APIs - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
[6] WorkerGlobalScope: crossOriginIsolated 属性 - Web API | MDN (https://mdn.org.cn/en-US/docs/Web/API/WorkerGlobalScope/crossOriginIsolated)
[7] Chromium Docs - Process Model and Site Isolation (https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)
[8] Chromium Docs - Cross Origin Isolation (https://chromium.googlesource.com/chromium/src/+/main/docs/security/cross_origin_isolation.md)
[9] Permissions-Policy: cross-origin-isolated directive - HTTP | MDN (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/cross-origin-isolated)
[10] 跨域嵌入策略- HTTP - MDN 文档 (https://mdn.org.cn/en-US/docs/Web/HTTP/Headers/Cross-Origin-Embedder-Policy)
[11] Process Model and Site Isolation (https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/docs/process_model_and_site_isolation.md)
[12] New COOP and COEP Cross-Origin Policies for Increased ... (https://www.infoq.com/news/2020/09/coop-coep-cross-origin-isolation/)
[13] content/files/en-us/web/javascript/reference/global_objects/ ... (https://github.com/mdn/content/blob/main/files/en-us/web/javascript/reference/global_objects/sharedarraybuffer/index.md?plain=1)
[14] Cross-Origin Embedder Policy (https://wicg.github.io/cross-origin-embedder-policy/)
[15] HTML Standard — Supporting concepts（日本語訳） (https://triple-underscore.github.io/HTML-origin-ja.html)
