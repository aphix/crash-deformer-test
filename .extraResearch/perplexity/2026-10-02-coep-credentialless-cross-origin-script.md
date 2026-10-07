With Cross-Origin-Embedder-Policy: require-corp, is a cross-origin classic <script src> (no crossorigin attribute) whose response has no Cross-Origin-Resource-Policy header blocked? With COEP: credentialless is the same no-cors script allowed (requested without credentials)? Which browser versions support COEP credentialless: Chrome, Firefox, Safari (as of 2026)? Cite MDN, web.dev, caniuse, WebKit status.

Yes. Under `Cross-Origin-Embedder-Policy: require-corp`, a cross-origin classic `<script src>` without `crossorigin` is a `no-cors` request, so it is blocked unless the response explicitly allows embedding via `Cross-Origin-Resource-Policy` or the request is otherwise permitted; MDN says `require-corp` only allows same-origin `no-cors` resources or cross-origin resources with an allowing CORP header, and web.dev says cross-origin resources need either CORS or CORP to load.[1][10][13]

With `Cross-Origin-Embedder-Policy: credentialless`, the same cross-origin `no-cors` script is allowed if it is requested without credentials; MDN says `credentialless` permits cross-origin `no-cors` resources without an explicit CORP header and strips cookies, while the loading behavior for other request modes stays the same as `require-corp`.[1][9]

As of 2026, support for COEP `credentialless` is effectively:
- Chrome: supported.[10][11]
- Firefox: not supported in the cited sources; web.dev still describes it as not supported by other browsers, and Can I use should be checked for the exact current Firefox status.[10][11]
- Safari: not supported in the cited sources; web.dev says other browsers do not support it, and WebKit status has not shown general support in the cited material.[10][11]

If a stricter browser-by-browser matrix is needed, the most reliable current sources here are MDN for behavior, web.dev for deployment guidance, Can I use for support tables, and WebKit status for Safari implementation notes.[1][10][11]

[1] Cross-Origin-Embedder-Policy (COEP) header - HTTP | MDN (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)
[2] 跨域嵌入策略- HTTP - MDN 文档 (https://mdn.org.cn/en-US/docs/Web/HTTP/Headers/Cross-Origin-Embedder-Policy)
[3] translated-content-de/files/de/web/http/headers/cross-origin-embedder-policy/index.md at main · mdn/translated-content-de (https://github.com/mdn/translated-content-de/blob/main/files/de/web/http/headers/cross-origin-embedder-policy/index.md)
[4] Cross-Origin Resource Policy (CORP) - HTTP - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cross-Origin_Resource_Policy)
[5] IFrame credentialless - HTTP - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/IFrame_credentialless)
[6] credentiallessness/explainer.md at main · WICG/credentiallessness (https://github.com/WICG/credentiallessness/blob/main/explainer.md)
[7] COEPViolationReport - Web APIs - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/API/COEPViolationReport)
[8] Cross-Origin-Opener-Policy - HTML Spec WHATWG (https://html.spec.whatwg.org/dev/browsers.html)
[9] Cross-Origin-Embedder-Policy-Report-Only (COEP) header - HTTP (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy-Report-Only)
[10] Make your website "cross-origin isolated" using COOP and ... (https://web.dev/articles/coop-coep)
[11] Cross-Origin-Embedder-Policy: credentialless (https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless)
[12] "credentialless" | Can I use... Support tables for HTML5, ... (https://caniuse.com/?search=credentialless)
[13] Why you need "cross-origin isolated" for powerful features - web.dev (https://web.dev/articles/why-coop-coep)
[14] Window API: credentialless (https://caniuse.com/mdn-api_window_credentialless)
[15] COEP: credentialless · Issue #539 · mozilla/standards-positions (https://github.com/mozilla/standards-positions/issues/539)
