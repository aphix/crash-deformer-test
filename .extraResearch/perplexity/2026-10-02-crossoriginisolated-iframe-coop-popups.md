How does crossOriginIsolated work for a page embedded in a cross-origin iframe: is COOP ignored in iframes, must the parent be cross-origin isolated and set allow="cross-origin-isolated" permission policy, and must the iframe response send COEP? Also: does Cross-Origin-Opener-Policy: same-origin break a popup sign-in flow that uses window.opener.postMessage and popup.closed; what does same-origin-allow-popups change? Cite MDN, web.dev, HTML spec.

A cross-origin iframe can become `crossOriginIsolated`, but the embedding chain still matters: the iframe document needs its own COOP/COEP setup, the parent chain must also be cross-origin isolated, and the iframe must be allowed by `allow="cross-origin-isolated"` on the `<iframe>` plus the `Permissions-Policy` for `cross-origin-isolated`.[1][3][4] MDN and web.dev both say the embedded document can be isolated only when the iframe is explicitly allowed and the entire chain of documents is isolated.[1][4]

On the COOP side, `Cross-Origin-Opener-Policy: same-origin` does break the opener relationship for cross-origin popup flows, which means patterns that rely on `window.opener` for `postMessage` coordination can stop working as expected.[2][6][10] The HTML spec says `same-origin-allow-popups` is the weaker mode that keeps popups workable by allowing auxiliary browsing contexts to retain an opener relationship when the documents are same-origin and share the policy, while still providing more isolation than `unsafe-none`.[2] MDN also notes that `same-origin-allow-popups` permits same-BCG popup handling for documents with `unsafe-none`, which is the key difference from strict `same-origin` in popup sign-in flows.[6]

In practical terms:
- For a cross-origin iframe to use `crossOriginIsolated`, the iframe must be permitted by `allow="cross-origin-isolated"` and the isolation requirements must hold for the whole document chain.[1][4]
- `COOP: same-origin` is usually incompatible with popup auth flows that depend on `window.opener.postMessage` and `popup.closed` state.[2][6][10]
- `same-origin-allow-popups` is the compromise mode when you want stronger isolation but still need popup-based sign-in to keep an opener connection.[2][6]

If helpful, a minimal working header/iframe setup can be sketched next.

[1] Make your website "cross-origin isolated" using COOP and ... (https://web.dev/articles/coop-coep)
[2] Cross-Origin-Opener-Policy - HTML Spec WHATWG (https://html.spec.whatwg.org/dev/browsers.html)
[3] Window: crossOriginIsolated property - Web APIs - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
[4] A guide to enable cross-origin isolation | Articles (https://web.dev/articles/cross-origin-isolation-guide)
[5] HTML (https://html.spec.whatwg.org/multipage/browsers.html)
[6] Cross-Origin-Opener-Policy (COOP) header (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)
[7] Isolated Web Apps - ChromeOS.dev (https://chromeos.dev/en/web/isolated-web-apps)
[8] Secure popup interactions with restrict-properties | Blog | Chrome for Developers (https://developer.chrome.com/blog/coop-restrict-properties/)
[9] developer.chrome.com · docs · privacy-securityControl browser features with Permissions Policy | Privacy ... (https://developer.chrome.com/docs/privacy-security/permissions-policy)
[10] Post-Spectre Web Development - W3C (https://www.w3.org/TR/post-spectre-webdev/)
[11] IFrame credentialless - HTTP - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/IFrame_credentialless)
[12] Permissions-Policy: cross-origin-isolated directive - HTTP | MDN (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/cross-origin-isolated)
[13] www.w3.org › TR › permissions-policyPermissions Policy - World Wide Web Consortium (W3C) (https://www.w3.org/TR/permissions-policy/)
[14] Permissions Policy (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Permissions_Policy)
[15] web.dev/src/site/content/ja/blog/coop-coep/index.md at main · GoogleChrome/web.dev (https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/ja/blog/coop-coep/index.md)
