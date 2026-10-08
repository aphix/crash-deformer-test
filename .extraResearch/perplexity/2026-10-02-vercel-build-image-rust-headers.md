Does the Vercel build image (Amazon Linux 2023, Node.js builds) include Rust, cargo or rustup by default, and can a build command install rustup and the wasm32-unknown-unknown target (time/limits)? Also how to set custom response headers (Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy) for a Nitro v3 / TanStack Start app deployed on Vercel: vercel.json headers vs Nitro routeRules headers vs Build Output API config. Cite Vercel docs and Nitro docs.

Vercel’s build image for Node.js builds runs on Amazon Linux 2023, but the docs you provided do not say that Rust, cargo, or rustup are included by default[3]. A build step can install Rust tooling itself, and Vercel’s own examples for WASM builds explicitly run `rustup target add wasm32-unknown-unknown`, which indicates that adding the target during build is a normal pattern[1]. If your build depends on downloading and installing Rust during the build, the main practical constraint is build time and any platform build-time limits; the documentation here does not state a specific Rust-install time allowance[3].

For COOP/COEP on a Nitro v3 / TanStack Start app on Vercel, the cleanest place is Nitro `routeRules.headers`, because Nitro supports custom headers directly in route rules and the Vercel preset turns route rules with `headers` into Vercel routing/header config at build time[2][4][9]. `vercel.json` headers can also set response headers on Vercel generally, but when using Nitro on Vercel, Nitro already generates the Vercel config, and its docs say you can merge extra Vercel config through `nitro.config` using `vercel.config` if needed[4]. Build Output API config is the lowest-level option and is what Nitro ultimately targets for the Vercel preset; for a Nitro app, using Nitro config is usually preferred over hand-authoring Build Output API files[4][6].

## Practical recommendation

- Use `routeRules` for app-wide response headers such as:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`  
  Nitro supports `headers` in `routeRules`, and the Vercel preset emits the needed Vercel config from them[2][4][9].

- Use `vercel.config` only if you need to add or override Vercel build output details that Nitro does not generate for you[4].

- Use `vercel.json` only if you are not relying on Nitro’s generated Vercel config, or if you are managing a non-Nitro Vercel project directly[3][4].

## Example Nitro config

```ts
export default defineNitroConfig({
  routeRules: {
    '/**': {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  },
})
```

If the app needs these headers only on certain routes, scope the `routeRules` pattern more narrowly, since Nitro applies route rules per route pattern[2][9].

[1] Ratzilla Starter - Vercel (https://vercel.com/templates/other/ratzilla)
[2] Config - Nitro (https://nitro.build/config/)
[3] Build image overview - Vercel (https://vercel.com/docs/builds/build-image)
[4] Vercel - Nitro builds (https://nitro.build/deploy/providers/vercel)
[5] Build Toolchain and Scripts | vercel-labs/lat.md | DeepWiki (https://deepwiki.com/vercel-labs/lat.md/7.2-build-toolchain-and-scripts)
[6] Nitro on Vercel (https://vercel.com/docs/frameworks/backend/nitro)
[7] synedrion 0.3.0 (https://docs.rs/crate/synedrion/latest/source/Makefile)
[8] Vite + Nitro on Vercel (https://vercel.com/docs/frameworks/full-stack/vite-with-nitro)
[9] Routing - Nitro builds (https://nitro.build/docs/routing)
[10] Client-Side Rendered Deployment | leptos-rs/book | DeepWiki (https://deepwiki.com/leptos-rs/book/8.2-client-side-rendered-deployment)
[11] Vercel Preset | nitrojs/nitro | DeepWiki (https://deepwiki.com/nitrojs/nitro/6.3-vercel-preset)
[12] How to ship a Nitro app on Vercel (https://vercel.com/kb/guide/ship-a-nitro-app-on-vercel)
[13] vercel build (https://vercel.com/docs/cli/build)
[14] Deploying CSR Apps - Leptos Book (https://book.leptos.dev/deployment/csr.html)
[15] rust/README.md at main · vercel-community/rust (https://github.com/vercel-community/rust/blob/main/README.md)
