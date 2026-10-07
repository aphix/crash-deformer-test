In Vite 7/8 (rolldown-vite), does new Worker(new URL('./worker.ts', import.meta.url), {type:'module'}) work in dev and production build, and what is worker.format default (iife vs es)? Can a module worker import a wasm-bindgen --target bundler package (ESM integration .wasm import with top-level await) or use '?init' / '?url' wasm imports inside the worker; does it need worker.format 'es' or vite-plugin-wasm / vite-plugin-top-level-await? How do server.headers and preview.headers set COOP/COEP in Vite? Cite Vite docs and GitHub issues.

Yes: in Vite, `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` is the supported pattern, and the worker-detection logic only works when `new URL(...)` appears directly inside `new Worker(...)`; otherwise it is treated as a static asset URL.[9][10] Vite’s docs also show the module-worker form explicitly with `{ type: 'module' }`.[9][10]

`worker.format` defaults to `iife`, not `es`, and the config type is `'es' | 'iife'`.[1][2][3]

For wasm inside a worker, a module worker can use normal ESM-style imports from a `wasm-bindgen --target bundler` package only if the worker is bundled as ESM; Vite’s wasm docs distinguish between direct ESM import of precompiled `.wasm` and `?init` for explicit instantiation control.[12] Because Vite’s default worker output format is `iife`, using ESM-only worker dependencies or top-level-await-based wasm integration generally requires `worker.format: 'es'` rather than the default `iife`.[1][2][3] If the wasm package relies on Vite’s `?init` or `?url` handling, those imports work in Vite’s normal module graph, but compatibility inside a worker depends on the worker being emitted as ESM; otherwise helper plugins such as `vite-plugin-wasm` and `vite-plugin-top-level-await` are typically used to bridge wasm loading and TLA behavior in worker code.

For headers, both `server.headers` and `preview.headers` set response headers on Vite’s dev server and preview server respectively.[8] That is the place to set `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` for COOP/COEP, for example:
```ts
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
preview: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
```
`preview.headers` is explicitly documented as server response headers, and the dev server uses the same pattern via `server.headers`.[8]

If needed, a compact recommendation is:
- Use `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` in both dev and build.[9][10]
- Set `worker.format: 'es'` when the worker must consume ESM-only wasm bindings or top-level await.[1][2][3]
- Use `server.headers` and `preview.headers` for COOP/COEP.[8]

[1] Worker Options - Vite (https://v4.vite.dev/config/worker-options)
[2] 워커 옵션 (https://ko.vite.dev/config/worker-options)
[3] Worker-Optionen (https://de.vite.dev/config/worker-options)
[4] Worker 选项| Vite 官方中文文档 (https://cn.vite.dev/config/worker-options)
[5] Options pour les travailleurs - Vite (https://vitejs.fr/config/worker-options)
[6] Configuring Vite (https://v2.vitejs.dev/config/)
[7] Возможности | Vite по-русски (https://vite-docs.ru/guide/features.html)
[8] vite.dev › config › preview-optionsvite.dev (https://vite.dev/config/preview-options.md)
[9] vite.dev (https://vite.dev/llms-full.txt)
[10] Features (https://vite.dev/guide/features)
[11] Caractéristiques - Vite (https://vitejs.fr/guide/features)
[12] 简体中文 (https://cn.vite.dev/guide/features)
[13] プレビューのオプション - Vite (https://ja.vite.dev/config/preview-options)
[14] Vorschau-Optionen - Vite (https://de.vite.dev/config/preview-options)
[15] 지원하는 기능들 (https://ko.vite.dev/guide/features)
