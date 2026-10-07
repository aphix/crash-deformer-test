Exact browser support for Cross-Origin-Embedder-Policy: credentialless: which Chrome version shipped it (96 desktop? 110 Android?), did Firefox ship it in version 119, and does Safari / WebKit support COEP credentialless as of 2026? Also which Safari version first supported COEP require-corp and crossOriginIsolated SharedArrayBuffer. Cite caniuse, MDN browser-compat-data, Firefox release notes, WebKit.

Chrome shipped `Cross-Origin-Embedder-Policy: credentialless` in desktop Chrome 96; the Chrome documentation snippet here says “Chrome since 96,” and caniuse likewise marks Chrome 96+ as supported[2][3]. Firefox added `credentialless` in Firefox 119 on desktop and on mobile platforms other than Android, while Android is explicitly excluded from that support note[1][12].

Safari / WebKit support for COEP `credentialless` is not shown in the gathered sources as shipped as of 2026, and the MDN header docs still present `credentialless` as a valid COEP value without indicating Safari support status[6][11]. The WebKit/Safari source gathered here shows Safari 15.2 adding COOP and COEP support, but specifically describes `require-corp` as the path to restoring `SharedArrayBuffer` and Wasm threading, not `credentialless`[5].

For the `require-corp` path and `crossOriginIsolated`-gated `SharedArrayBuffer`, Safari first supported this in Safari 15.2, when WebKit said sites serving `Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp` could use `SharedArrayBuffer` and Wasm threading again[5]. MDN also states that access to `SharedArrayBuffer` and unthrottled timers requires a cross-origin isolated document using COEP `require-corp` or `credentialless` together with COOP `same-origin`[6][11].

[1] Firefox 119 release notes for developers - Mozilla - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/119)
[2] Load cross-origin resources without CORP headers using COEP (https://developer.chrome.com/blog/coep-credentialless-origin-trial)
[3] Cross-Origin-Embedder-Policy: credentialless (https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless)
[4] www.systemshardening.com · articles · wasmWASM Security in WebKit/Safari and Mobile Browser Contexts (https://www.systemshardening.com/articles/wasm/wasm-webkit-mobile-security/)
[5] Wide Gamut Support For... (https://webkit.org/blog/12140/new-webkit-features-in-safari-15-2/)
[6] Cross-Origin-Embedder-Policy (COEP) header - HTTP | MDN (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)
[7] Cross-Origin-Embedder-Policy (https://centralcsp.com/en/docs/web-security/policies/cross-origin-embedder-policy)
[8] Iframe credentialless: Easily embed iframes in COEP environments (https://developer.chrome.com/blog/iframe-credentialless)
[9] SharedArrayBuffer and the transitional story of cross-origin isolation (https://blog.agektmr.com/en/2021/11/cross-origin-isolation.html)
[10] WASM Threads: Browser Support, Atomics, COOP/COEP - TestMu AI (https://www.testmuai.com/learning-hub/wasm-threads-browser-support/)
[11] Cross-Origin-Opener-Policy (COOP) header (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)
[12] Firefox 119.0, See All New Features, Updates and Fixes (https://www.firefox.com/en-US/firefox/119.0/releasenotes/)
[13] What is Cross-Origin-Opener-Policy (COOP) and Cross ... - InspectWP (https://inspectwp.com/en/knowledge-base/cross-origin-opener-policy-coop-embedder-policy-coep)
[14] Firefox Release Notes (https://www.firefox.com/en-US/releases/)
[15] Description (https://www.cs.unb.ca/~bremner/teaching/cs2613/books/mdn/Reference/Global_Objects/SharedArrayBuffer/)
