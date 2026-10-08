Query: Firefox WEBGL_multi_draw extension support (web_search, not Perplexity)

- Firefox does not ship WEBGL_multi_draw (Bugzilla 1536673; declined in 2024, Mozilla prefers optimising the per-call path). MDN: "Limited availability".
- Chromium (desktop, Android) exposes it through ANGLE; web3dsurvey ~92.75 % overall, Android ~96 %.
- three.js BatchedMesh falls back to one drawElements per visible range (setting `_gl_DrawID` as a uniform) when the extension is missing; renderer.info counts each as a call.
Sources: https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_multi_draw , https://bugzilla.mozilla.org/show_bug.cgi?id=1536673 , https://web3dsurvey.com/webgl/extensions/WEBGL_multi_draw
