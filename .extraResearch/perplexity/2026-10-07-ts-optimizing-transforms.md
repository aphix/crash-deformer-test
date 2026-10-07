# Query: build-time TS/JS transforms that make game loops faster (ts-patch, macros, typia, inlining, unrolling, SoA, scalar replacement)

For this use case, the strongest practical options are **macro/transformer-based code generation tools** that erase validation and generate specialized serialization or IR, while **general bundlers/transpilers rarely produce game-loop speedups by themselves**. The main wins come when the tool can turn higher-level annotations into straight-line JS, scalar locals, or specialized data layouts before V8 ever runs the code.[1][4][5][10]

## What each tool actually does

- **typia**: a TypeScript transformer library that generates runtime validators, JSON serializers, and related helpers from type information; it is aimed at eliminating generic reflection-style checks and producing specialized code.[1][5]
- **unplugin-macros / macros-style build-time macros**: functions run at bundle time whose returned values are inlined into the bundle, so they are good for constant folding of app-defined values and small compile-time computations.[4]
- **Oxc transformer / isolated declarations**: a fast Rust-based transformer and declaration emitter; the published benchmarks are about transform throughput and `.d.ts` generation, not game-loop-specific semantic rewrites like vector inlining or SoA conversion.[10][11]
- **SWC/Babel/esbuild/Vite plugin ecosystems**: these are general-purpose transpilation and bundling layers; they can host custom transforms, but out of the box they do not specialize math code or data layouts for physics loops.[7][8][10][11]
- **ts-patch / tsc custom transformers / ts-transformer-* packages**: these are the classic route for TypeScript AST rewrites, and they are the most plausible fit for inlining small helpers, unrolling fixed loops, and rewriting object shapes, but their maturity and ecosystem quality vary widely and they generally depend on TypeScript’s compiler internals rather than a stable public optimization API.
- **Closure-Compiler-style optimizers**: conceptually closest to the requested “whole-program” rewrites, but in modern TS/ESM toolchains they are much less common than targeted AST transforms and macro systems.

## Maturity and fit for your specific optimizations

- **Inlining small vector math functions at call sites**: feasible with custom TS transformers or macros, but not a standard feature of Vite/SWC/esbuild/Oxc/Babel plugins; in practice, V8 often already inlines small monomorphic functions when warm, so compile-time inlining only helps if you need to reduce cold-start cost or force specialization across module boundaries.
- **Compile-time loop unrolling for small fixed counts**: feasible with custom AST transforms or macros; useful for tiny fixed loops, but V8 can optimize simple loops well once hot, so gains are usually modest unless the loop body is tiny and the call frequency is huge.
- **Converting `{x,y,z}` objects to scalar locals or flat typed arrays**: this is a meaningful optimization, but it requires a domain-specific transform or code generator; a generic bundler plugin will not infer it. This can beat V8’s normal object optimization when it removes allocations and improves memory locality.
- **Constant folding named constants**: easy for macros and many transformers, but again V8 and bundlers already do some folding/minification; the incremental benefit is usually small unless the constant depends on build-time environment or configuration.
- **Struct-of-arrays generation from annotated classes**: this is the kind of thing typia-like or custom transformer pipelines can support, but it is not a mainstream feature of the major bundlers. This is one of the few transformations that can deliver real physics-loop gains because it changes memory layout, not just syntax.
- **Removing runtime type checks**: typia is the strongest documented example here; its whole proposition is generating specialized validators/serializers so runtime checks are replaced by direct code paths.[1][5]

## Vite 8 / rolldown / Node --experimental-strip-types compatibility

- **Vite**: `unplugin-macros` explicitly advertises Vite integration, and typia explicitly advertises `@ttsc/unplugin` for Vite.[4][1][5]
- **Rolldown**: there is no strong evidence in the gathered material that these specific optimization transformers are first-class rolldown integrations yet; tools implemented through the unplugin abstraction are the most likely to port cleanly, but that is still an integration detail rather than a guaranteed native support claim.[4]
- **Node `--experimental-strip-types`**: this flag strips TypeScript syntax only; it does not run type-aware transforms or macros, so it does **not** replace transformer plugins. Any optimization that depends on type information or AST rewriting still needs a build step before execution.

## Whether V8 already does the same

- **Yes, sometimes**: V8 already performs function inlining, constant folding, escape analysis, hidden-class optimization, and other JIT optimizations, so simple hand- or build-time rewrites often overlap with what the engine can do.
- **Where build-time still wins**: if the optimization removes allocations, changes data layout, specializes code per schema, or erases validation entirely, that is outside what V8 can safely infer from generic JS source.
- **Rule of thumb**: syntax-only transforms usually give small wins; layout- and specialization-changing transforms can give real wins in physics/game loops.

## Measured gains reported

- **typia** reports runtime validators up to **20,000× faster** than `class-validator` and JSON serialization up to **200× faster** than `class-transformer`, but those numbers are about validation/serialization benchmarks, not vector math or loop unrolling.[1][5]
- **Oxc transformer** reports roughly **3×–5× faster** transform throughput than SWC and **20×–50× faster** than Babel, plus `.d.ts` generation that is much faster than `tsc`; these are build-time speed gains, not runtime game-loop gains.[10][11]
- **SWC** publishes transform benchmarks and notes its parallel transformation benchmarks are meant to reflect build-tool workloads, but the cited material does not give game-loop runtime speedups.[7]
- **unplugin-macros** is documented as a bundle-time inlining mechanism, but no strong runtime benchmark numbers for physics-style code were surfaced in the gathered results.[4]

## Practical ranking for a real-time game/physics loop

- **Best bet**: a **custom TS transformer or macro system** that rewrites annotated data structures into SoA/flat arrays and removes validation checks.
- **Good for targeted wins**: **typia** when your hot path is parsing/validating/serializing data rather than numeric simulation.[1][5]
- **Useful mostly for build speed and portability**: **Oxc/SWC/esbuild/Babel/Vite plugins** unless they host your own domain-specific transform.[7][10][11]
- **Least likely to matter in runtime**: generic constant folding or simple inlining alone, because V8 already covers much of that work after warmup.

If useful, a follow-up can turn this into a **tool-by-tool matrix** with columns for “can emit SoA,” “can unroll loops,” “Vite support,” “rolldown readiness,” and “expected runtime payoff.”

[1] Guide Documents > Introduction (https://typia.io/docs/)
[2] Unplugin (https://github.com/unplugin)
[3] unplugin/unplugin-macros — 健康指数 90/100，优秀 — inspect.software (https://inspect.software/zh/software/unplugin/unplugin-macros)
[4] GitHub - unplugin/unplugin-macros: Macros plugin for bundlers. (https://github.com/unplugin/unplugin-macros)
[5] samchon/typia: Super-fast/easy runtime validators and ... (https://github.com/samchon/typia)
[6] samchon/typia — GitHub Star History & Stats (https://gittrend.io/repo/samchon/typia)
[7] Benchmarks (https://swc.rs/docs/benchmarks)
[8] esbuild — open-source software health — inspect.software (https://inspect.software/tags/esbuild)
[9] samchon/typia - GitHub - 探客时代 (https://www.tkcnn.com/github/samchon/typia.html)
[10] Oxc Transformer Alpha | The JavaScript Oxidation Compiler (https://oxc.rs/blog/2024-09-29-transformer-alpha)
[11] All Benchmarks (https://oxc.rs/docs/guide/benchmarks.html)
[12] Альфа трансформера Oxc (https://www.oxcjs.com/ru/blog/2024-09-29-transformer-alpha.html)
[13] unplugin/unplugin-macros - StackBlitz (https://stackblitz.com/~/github.com/unplugin/unplugin-macros/pull/155)
[14] Vite and the Future of JavaScript Tooling by Evan You (https://gitnation.com/contents/vite-and-the-future-of-javascript-tooling)
[15] unplugin - JSR (https://jsr.io/@unplugin)
