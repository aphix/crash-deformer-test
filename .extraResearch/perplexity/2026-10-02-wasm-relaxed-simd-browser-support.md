WebAssembly relaxed SIMD proposal browser support as of 2026: Chrome version shipped (114?), Firefox status (shipped or behind flag), Safari/WebKit status. And WebAssembly fixed-width SIMD128 support in Safari 16.4 and iOS. Cite webassembly.org/features, caniuse, webstatus.dev.

WebAssembly relaxed SIMD is shipped in Chrome 114+ and remains supported in later Chrome versions; Safari is still listed as not supported in Can I Use’s relaxed-SIMD table, and the same source does not show Firefox as shipped there in the captured results[1]. WebAssembly fixed-width SIMD128 is supported in Safari 16.4 and in Safari on iOS 16.4+, which matches WebKit’s Safari 16.4 feature notes[2][3].

## Quick status
- Chrome: relaxed SIMD shipped starting at 114+[1]
- Firefox: the gathered sources did not show a shipped Firefox entry for relaxed SIMD, so Firefox support is not confirmed from these results[1]
- Safari/WebKit: relaxed SIMD is not shown as supported in the captured Can I Use data, while fixed-width SIMD128 is supported from Safari 16.4[1][2][3]
- iOS Safari: fixed-width SIMD128 is supported from iOS 16.4[2]

## Notes
- The Web Features Explorer entry for fixed-width SIMD lists Safari 16.4 and Safari on iOS 16.4 as the release points for support[2]
- WebKit’s Safari 16.4 release notes state that WebAssembly added support for 128-bit SIMD[3]

[1] Relaxed-width SIMD (WebAssembly) | Can I use... Support ... (https://caniuse.com/wf-wasm-simd-relaxed)
[2] WebAssembly SIMD | Can I use... Support tables for HTML5, CSS3, etc (https://caniuse.com/wasm-simd)
[3] instructions: and: `v128` (SIMD) value (https://caniuse.com/mdn-webassembly_instructions_and_v128)
[4] instructions: ne: `v128` (SIMD) value interpretations (https://caniuse.com/mdn-webassembly_instructions_ne_v128)
[5] instructions: ge: `v128` (SIMD) value interpretations (https://caniuse.com/mdn-webassembly_instructions_ge_v128)
[6] instructions: le: `v128` (SIMD) value interpretations (https://caniuse.com/mdn-webassembly_instructions_le_v128)
[7] instructions: lt_u: `v128` (SIMD) value interpretations (https://caniuse.com/mdn-webassembly_instructions_lt_u_v128)
[8] instructions: neg: `v128` (SIMD) value interpretations (https://caniuse.com/mdn-webassembly_instructions_neg_v128)
[9] Web features explorer - Fixed-width SIMD (WebAssembly) (https://web-platform-dx.github.io/web-features-explorer/features/wasm-simd/)
[10] instructions: eq: `v128` (SIMD) value interpretations (https://caniuse.com/mdn-webassembly_instructions_eq_v128)
[11] WASM SIMD: Browser Support, Features, Limitations (https://www.testmuai.com/learning-hub/wasm-simd-browser-support/)
[12] "simd" | Can I use... Support tables for HTML5, CSS3, etc (https://caniuse.com/?search=simd)
[13] WebKit Features in Safari 16.4 (https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
[14] WebAssembly SIMDでブラウザ音声処理の演算効率を向上 ... (https://zenn.dev/fitness_densuke/articles/2026-01-23-wasm-simd-optimization)
[15] "webassembly" | Can I use... Support tables for HTML5, ... (https://caniuse.com/?search=webassembly)
