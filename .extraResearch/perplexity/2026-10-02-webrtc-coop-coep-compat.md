Does enabling Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp or credentialless (crossOriginIsolated) break WebRTC RTCPeerConnection, RTCDataChannel, STUN/TURN ICE, or same-origin fetch signaling in Chrome, Firefox, Safari? Any known issues? Cite sources.

No broad breakage is indicated: enabling `COOP: same-origin` plus `COEP: require-corp` or `credentialless` is the standard way to reach `crossOriginIsolated`, and the documented effect is mainly that cross-origin subresources and cross-origin window relationships are restricted, not that WebRTC itself is disabled[2][12]. WebRTC `RTCPeerConnection` is explicitly shipped in Chrome, Firefox, and Safari[5][6], and the available interoperability materials do not show COOP/COEP-specific failures for `RTCPeerConnection`, `RTCDataChannel`, or ICE/STUN/TURN; they instead show ordinary WebRTC interop gaps unrelated to cross-origin isolation[1][4].

## Practical answer
- `RTCPeerConnection`: should keep working under `crossOriginIsolated` in Chrome, Firefox, and Safari[5][6].
- `RTCDataChannel`: no source found indicating COOP/COEP breaks it; `crossOriginIsolated` is commonly used specifically to unlock stronger platform capabilities rather than disable WebRTC[2][10][12].
- STUN/TURN/ICE: no evidence here that COOP/COEP blocks ICE gathering or relay use; the browsing-context restrictions of COOP/COEP do not target network-level ICE negotiation[2][12].
- Same-origin fetch signaling: same-origin fetches are still same-origin, so COEP does not inherently block them; the main requirement is that any cross-origin subresources be CORS/CORP-compatible[2].

## Known issues / caveats
- The main compatibility risk is not WebRTC itself but loading non-CORS/CORP-compliant cross-origin resources after turning on COEP[2].
- Safari has some WebRTC interop issues in general, but the results found here are about unrelated `RTCPeerConnection` test failures and ICE edge cases, not a documented COOP/COEP-specific WebRTC breakage[1][9][11].
- Firefox and Chrome both document special handling for COOP+COEP pages as “cross-origin isolated” content processes, which supports that the feature combination is expected and supported rather than inherently incompatible with WebRTC[10][13].

## Bottom line
For modern Chrome, Firefox, and Safari, `COOP: same-origin` plus `COEP: require-corp`/`credentialless` should not break core WebRTC signaling or media/data channel APIs by itself; the real breakages to watch for are blocked cross-origin resources and unrelated browser-specific WebRTC bugs[1][2][10][12].

[1] webrtc-pc interop (https://w3c.github.io/webrtc-interop-reports/webrtc-pc-report.html)
[2] web.dev/src/site/content/en/blog/coop-coep/index.md at main · GoogleChrome/web.dev (https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/en/blog/coop-coep/index.md)
[3] RTCPeerConnection: RTCPeerConnection() constructor (https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)
[4] Amended WebRTC Interoperability Tests Results (https://www.w3.org/2024/10/webrtc-amendments-interop.html)
[5] Chrome | WebRTC (https://webrtc.github.io/webrtc-org/web-apis/chrome/)
[6] RTCPeerConnection - Web APIs - MDN Web Docs (https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
[7] Finalize webrtc-pc WPT Interop 2026 #3100 (https://github.com/w3c/webrtc-pc/issues/3100)
[8] WebRTC Safari: Complete Developer Guide for 2026 (https://www.videosdk.live/developer-hub/webrtc/webrtc-safari)
[9] Safari Updates by Apple - September 2026 - Releasebot (https://releasebot.io/updates/apple/safari)
[10] firefox-source-docs.mozilla.org › dom › ipcProcess Model — Firefox Source Docs documentation - Mozilla (https://firefox-source-docs.mozilla.org/dom/ipc/process_model.html)
[11] ICE connection state changed to: failed (Safari 15) · Issue #714 · webrtc/apprtc (https://github.com/webrtc/apprtc/issues/714)
[12] Cross-Origin-Opener-Policy (COOP) header (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)
[13] explainers/cross-origin-isolation-deployment.md at main · camillelamy/explainers (https://github.com/camillelamy/explainers/blob/main/cross-origin-isolation-deployment.md)
[14] Guide to WebRTC with Safari in the Wild (Chad Phillips) - webrtcHacks (https://webrtchacks.com/guide-to-safari-webrtc/)
[15] GitHub - videsk/safari-webrtc-bug: Bug on Webkit with the SDP transceivers (https://github.com/videsk/safari-webrtc-bug)
