# Toolchain measurements and decisions

Measured on WSL2 (14 cores, 23 GB), with the box shared with another project's cargo builds (load average 25–58 during runs), so wall times are noisy. Every number is the median of 3 runs under `flock /tmp/crash-gate.lock`, measured with `/usr/bin/time -f "wall=%es rss_kb=%M"` (peak RSS of the largest process).

| Tool | Before | After | Wall before → after | Peak RSS before → after | Decision |
|---|---|---|---|---|---|
| Lint | `eslint .` 9.39 | `oxlint` 1.86 | 7.8 s (25.4 s under heavier load) → 1.2 s | 606 MB → 239 MB | **Cut over** |

## oxlint (replaces ESLint)

`npm run lint` runs `oxlint` with `.oxlintrc.json`. Same 137 files, same 3 pre-existing errors.

How the config was made:
1. `npx @oxlint/migrate@1.86.0 --details eslint.config.mjs` produced the rule list (76 root rules + the TS and all-files overrides). Skipped by the tool: `no-undef` (nursery), `no-dupe-args` and `no-octal` (unsupported: strict-mode syntax errors).
2. Fixes to the migrated output:
   - Dropped the 1,059-entry inlined `globals` list for `env: { browser, node, es2022 }`, and dropped the unused `unicorn` plugin.
   - `no-undef` for `.js/.jsx/.mjs/.cjs` comes from `oxlint-plugin-eslint` (`eslint-js/no-undef`). typescript-eslint turned it off for TS files; tsc covers those.
   - oxlint runs `typescript/ban-ts-comment` and `typescript/no-this-alias` on TS files only, while typescript-eslint also ran them on `.js`. For `.js` they are replaced by `no-warning-comments` (`@ts-ignore`, `@ts-nocheck`) and `eslint-js/no-restricted-syntax` (`const x = this`, `x = this`). Without this, the two `@ts-nocheck` kernel errors disappear.
   - `options.reportUnusedDisableDirectives: "warn"` matches ESLint's default.
3. Removed `eslint.config.mjs` and the devDependencies that only it used: `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `eslint-plugin-prettier` (it was not wired into the config), `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`. That removes 116 packages from the lockfile and adds 21 (oxlint, its per-platform bindings, oxlint-plugin-eslint). No other package version changed.

No rule in the old config was type-aware (it used `tseslint.configs.recommended`, not `recommendedTypeChecked`), so `oxlint-tsgolint` is not needed.

### Parity: positive controls

There was one throwaway probe file per enforced rule (91 files under `src/__probe/`, deleted afterwards), each with a single violation. Each was linted by both ESLint (old config) and oxlint (new config). All 88 reachable rules fire in both, at the same severity. Apart from the rows below, the full diagnostic sets per probe were identical.

| Ext | Rule | ESLint | oxlint |
|---|---|---|---|
| `.cjs` | no-delete-var | no-delete-var (error) | eslint(no-delete-var) (error) |
| `.cjs` | no-dupe-args | no-dupe-args (error) | — |
| `.cjs` | no-nonoctal-decimal-escape | parse error | eslint(no-nonoctal-decimal-escape) (error) |
| `.cjs` | no-octal | parse error | — |
| `.cjs` | no-with | no-with (error) | eslint(no-with) (error) |
| `.js` | ban-ts-comment | @typescript-eslint/ban-ts-comment (error) | eslint(no-warning-comments) (error) |
| `.js` | constructor-super | constructor-super (error) | eslint(constructor-super) (error) |
| `.js` | getter-return | getter-return (error) | eslint(getter-return) (error) |
| `.js` | no-class-assign | no-class-assign (error) | eslint(no-class-assign) (error) |
| `.js` | no-const-assign | no-const-assign (error) | eslint(no-const-assign) (error) |
| `.js` | no-dupe-class-members | no-dupe-class-members (error) | eslint(no-dupe-class-members) (error) |
| `.js` | no-dupe-keys | no-dupe-keys (error) | eslint(no-dupe-keys) (error) |
| `.js` | no-func-assign | no-func-assign (error) | eslint(no-func-assign) (error) |
| `.js` | no-global-assign | no-global-assign (error) | eslint(no-global-assign) (error) |
| `.js` | no-import-assign | no-import-assign (error) | eslint(no-import-assign) (error) |
| `.js` | no-new-native-nonconstructor | no-new-native-nonconstructor (error) | eslint(no-new-native-nonconstructor) (error) |
| `.js` | no-obj-calls | no-obj-calls (error) | eslint(no-obj-calls) (error) |
| `.js` | no-redeclare | no-redeclare (error) | eslint(no-redeclare) (error) |
| `.js` | no-require-imports | @typescript-eslint/no-require-imports (error) | typescript(no-require-imports) (error) |
| `.js` | no-setter-return | no-setter-return (error) | eslint(no-setter-return) (error) |
| `.js` | no-this-alias | @typescript-eslint/no-this-alias (error) | eslint-js(no-restricted-syntax) (error) |
| `.js` | no-this-before-super | no-this-before-super (error) | eslint(no-this-before-super) (error) |
| `.js` | no-undef | no-undef (error) | eslint-js(no-undef) (error) |
| `.js` | no-unreachable | no-unreachable (error) | eslint(no-unreachable) (error) |
| `.js` | no-unsafe-negation | no-unsafe-negation (error) | eslint(no-unsafe-negation) (error) |
| `.js` | no-unused-expressions | @typescript-eslint/no-unused-expressions (error) | eslint(no-unused-expressions) (error) |
| `.js` | no-unused-vars | @typescript-eslint/no-unused-vars (warn) | eslint(no-unused-vars) (warning) |
| `.ts` | ban-ts-comment | @typescript-eslint/ban-ts-comment (error) | typescript(ban-ts-comment) (error) |
| `.ts` | for-direction | for-direction (error) | eslint(for-direction) (error) |
| `.ts` | no-array-constructor | @typescript-eslint/no-array-constructor (error) | eslint(no-array-constructor) (error) |
| `.ts` | no-async-promise-executor | no-async-promise-executor (error) | eslint(no-async-promise-executor) (error) |
| `.ts` | no-case-declarations | no-case-declarations (error) | eslint(no-case-declarations) (error) |
| `.ts` | no-compare-neg-zero | no-compare-neg-zero (error) | eslint(no-compare-neg-zero) (error) |
| `.ts` | no-cond-assign | no-cond-assign (error) | eslint(no-cond-assign) (error) |
| `.ts` | no-constant-binary-expression | no-constant-binary-expression (error) | eslint(no-constant-binary-expression) (error) |
| `.ts` | no-constant-condition | no-constant-condition (error) | eslint(no-constant-condition) (error) |
| `.ts` | no-control-regex | no-control-regex (error) | eslint(no-control-regex) (error) |
| `.ts` | no-debugger | no-debugger (error) | eslint(no-debugger) (error) |
| `.ts` | no-dupe-else-if | no-dupe-else-if (error) | eslint(no-dupe-else-if) (error) |
| `.ts` | no-duplicate-case | no-duplicate-case (error) | eslint(no-duplicate-case) (error) |
| `.ts` | no-duplicate-enum-values | @typescript-eslint/no-duplicate-enum-values (error) | typescript(no-duplicate-enum-values) (error) |
| `.ts` | no-empty-character-class | no-empty-character-class (error) | eslint(no-empty-character-class) (error) |
| `.ts` | no-empty-object-type | @typescript-eslint/no-empty-object-type (error) | typescript(no-empty-object-type) (error) |
| `.ts` | no-empty-pattern | no-empty-pattern (error) | eslint(no-empty-pattern) (error) |
| `.ts` | no-empty-static-block | no-empty-static-block (error) | eslint(no-empty-static-block) (error) |
| `.ts` | no-empty | no-empty (error) | eslint(no-empty) (error) |
| `.ts` | no-ex-assign | no-ex-assign (error) | eslint(no-ex-assign) (error) |
| `.ts` | no-extra-boolean-cast | no-extra-boolean-cast (error) | eslint(no-extra-boolean-cast) (error) |
| `.ts` | no-extra-non-null-assertion | @typescript-eslint/no-extra-non-null-assertion (error) | typescript(no-extra-non-null-assertion) (error) |
| `.ts` | no-fallthrough | no-fallthrough (error) | eslint(no-fallthrough) (error) |
| `.ts` | no-global-assign | no-global-assign (error) | eslint(no-global-assign) (error) |
| `.ts` | no-invalid-regexp | no-invalid-regexp (error) | eslint(no-invalid-regexp) (error) |
| `.ts` | no-irregular-whitespace | no-irregular-whitespace (error) | eslint(no-irregular-whitespace) (error) |
| `.ts` | no-loss-of-precision | no-loss-of-precision (error) | eslint(no-loss-of-precision) (error) |
| `.ts` | no-misleading-character-class | no-misleading-character-class (error) | eslint(no-misleading-character-class) (error) |
| `.ts` | no-misused-new | @typescript-eslint/no-misused-new (error) | typescript(no-misused-new) (error) |
| `.ts` | no-namespace | @typescript-eslint/no-namespace (error) | typescript(no-namespace) (error) |
| `.ts` | no-non-null-asserted-optional-chain | @typescript-eslint/no-non-null-asserted-optional-chain (error) | typescript(no-non-null-asserted-optional-chain) (error) |
| `.ts` | no-prototype-builtins | no-prototype-builtins (error) | eslint(no-prototype-builtins) (error) |
| `.ts` | no-regex-spaces | no-regex-spaces (error) | eslint(no-regex-spaces) (error) |
| `.ts` | no-require-imports | @typescript-eslint/no-require-imports (error) | typescript(no-require-imports) (error) |
| `.ts` | no-self-assign | no-self-assign (error) | eslint(no-self-assign) (error) |
| `.ts` | no-shadow-restricted-names | no-shadow-restricted-names (error) | eslint(no-shadow-restricted-names) (error) |
| `.ts` | no-sparse-arrays | no-sparse-arrays (error) | eslint(no-sparse-arrays) (error) |
| `.ts` | no-this-alias | @typescript-eslint/no-this-alias (error) | typescript(no-this-alias) (error) |
| `.ts` | no-unnecessary-type-constraint | @typescript-eslint/no-unnecessary-type-constraint (error) | typescript(no-unnecessary-type-constraint) (error) |
| `.ts` | no-unsafe-declaration-merging | @typescript-eslint/no-unsafe-declaration-merging (error) | typescript(no-unsafe-declaration-merging) (error) |
| `.ts` | no-unsafe-finally | no-unsafe-finally (error) | eslint(no-unsafe-finally) (error) |
| `.ts` | no-unsafe-function-type | @typescript-eslint/no-unsafe-function-type (error) | typescript(no-unsafe-function-type) (error) |
| `.ts` | no-unsafe-optional-chaining | no-unsafe-optional-chaining (error) | eslint(no-unsafe-optional-chaining) (error) |
| `.ts` | no-unused-expressions | @typescript-eslint/no-unused-expressions (error) | eslint(no-unused-expressions) (error) |
| `.ts` | no-unused-labels | no-unused-labels (error) | eslint(no-unused-labels) (error) |
| `.ts` | no-unused-private-class-members | no-unused-private-class-members (error) | eslint(no-unused-private-class-members) (error) |
| `.ts` | no-unused-vars | @typescript-eslint/no-unused-vars (warn) | eslint(no-unused-vars) (warning) |
| `.ts` | no-useless-backreference | no-useless-backreference (error) | eslint(no-useless-backreference) (error) |
| `.ts` | no-useless-catch | no-useless-catch (error) | eslint(no-useless-catch) (error) |
| `.ts` | no-useless-escape | no-useless-escape (error) | eslint(no-useless-escape) (error) |
| `.ts` | no-var | no-var (error) | eslint(no-var) (error) |
| `.ts` | no-wrapper-object-types | @typescript-eslint/no-wrapper-object-types (error) | typescript(no-wrapper-object-types) (error) |
| `.ts` | prefer-as-const | @typescript-eslint/prefer-as-const (error) | typescript(prefer-as-const) (error) |
| `.ts` | prefer-const | prefer-const (error) | eslint(prefer-const) (error) |
| `.ts` | prefer-namespace-keyword | @typescript-eslint/prefer-namespace-keyword (error) | typescript(prefer-namespace-keyword) (error) |
| `.ts` | prefer-rest-params | prefer-rest-params (error) | eslint(prefer-rest-params) (error) |
| `.ts` | prefer-spread | prefer-spread (error) | eslint(prefer-spread) (error) |
| `.ts` | require-yield | require-yield (error) | eslint(require-yield) (error) |
| `.ts` | triple-slash-reference | @typescript-eslint/triple-slash-reference (error) | typescript(triple-slash-reference) (error) |
| `.ts` | use-isnan | use-isnan (error) | eslint(use-isnan) (error) |
| `.ts` | valid-typeof | valid-typeof (error) | eslint(valid-typeof) (error) |
| `.tsx` | exhaustive-deps | react-hooks/exhaustive-deps (warn) | react-hooks(exhaustive-deps) (warning) |
| `.tsx` | only-export-components | react-refresh/only-export-components (warn) | react(only-export-components) (warning) |
| `.tsx` | rules-of-hooks | react-hooks/rules-of-hooks (error) | react-hooks(rules-of-hooks) (error) |

### Differences (rules lost or changed)

- `no-dupe-args`: not in oxlint. It can only occur in sloppy-mode `.cjs` (a syntax error everywhere else), and `no-redeclare` still flags the same code as an error. The repo has no `.cjs` files.
- `no-octal`: not in oxlint. ESLint never reached it either: the typescript-eslint parser rejects legacy octal literals as a parse error. In a `.cjs` file, ESLint reported a parse error where oxlint now reports nothing. There are no `.cjs` files.
- `no-nonoctal-decimal-escape`: the reverse case. ESLint gave a parse error on `"\8"` in `.cjs`; oxlint reports the rule.
- `ban-ts-comment` on `.js` no longer flags `@ts-expect-error` without a description (only `@ts-ignore` / `@ts-nocheck`). On TS files the full rule still runs.
- `react/only-export-components` (warn): one new warning on `src/routes/index.tsx` (a local `Home` component next to `export const Route`). eslint-plugin-react-refresh treated any PascalCase export as a possible component, so `Route` silenced it there. No oxlint option reproduces that heuristic (`allowExportNames: ["Route"]` doesn't help). It is a warning only.
- `prefer-namespace-keyword` probe: ESLint also raised a `no-unused-vars` warning on `declare module Foo`; oxlint doesn't.

### Whole-repo result

| | ESLint | oxlint |
|---|---|---|
| Files | 137 | 137 |
| Errors | 3 (`ban-ts-comment` ×2, `no-empty`) | 3 (`no-warning-comments` ×2, `no-empty`), same lines |
| Warnings | 1 (unused disable directive, `use-current-user.ts:59`) | 2 (the same, plus `only-export-components` above) |

## Speed audit (2026-10-07)

Aim: shorter test, typecheck, build and deploy waits, and a faster game; bundle size for its own sake is not a goal. Numbers are
wall seconds on this 14-core WSL box under normal lane load (load average 5-14, logged with `LOADLOG` on every run), paired
and interleaved where the effect is small; "n" is the number of pairs.

### Adopted

| Item | Before | After | Measured | Side effects |
|---|---|---|---|---|
| Test file order (`scripts/run-tests.mjs`, `scripts/test-cost.json`) | `node --test` sorts files by path; the 204 s `world/survival-chase` starts last | the files in `test-cost.json` start first, longest first | 12 gate logs: 421-527 s (median 470 s), 637 s on a red run. Simulated from the same per-test costs: 479 s in path order (matches the gates), 331 s longest first, which is the floor (1325 CPU-s / 4) | none to the tests: same files, same one-process-per-file isolation, same spec output, summary lines and exit code (checked on a passing, a failing and a missing file). A stale table only costs speed; `--learn` rewrites it |
| tsc `incremental` (`.cache/tsc.tsbuildinfo`, ignored by git) | 6.4-9.3 s | cold 6.1 s, warm 1.8-1.9 s, after editing the hub file `vehicle/car.ts` 5.0 s | warm -75% | a cached error is reported again on the next run (checked with a seeded error: exit non-zero until fixed; the exit code is 1 on a warm run, 2 on the run that wrote the file) |
| Deploy: skip `npm ci` when `package.json`, the lockfile and `node -v` are unchanged (`state/deps-key`) | `npm ci` on every deploy | skipped | `npm ci` 8.9-9.6 s here with a warm npm cache vs 2.8-3.4 s for the whole `build:node`: 72% of the build phase. The VPS number is Main's | the key is removed before an install starts and written after it finishes, so a killed install is never trusted (10 stubbed cases in `.bench`, incl. failed and killed installs). The deploy log now prints the seconds of each phase |
| Rapier SIMD build (`@dimforge/rapier3d-simd` 0.19.3, same API) for the ragdoll world | plain wasm build | SIMD wasm build | Node A/B at the ragdoll's settings (4 dummies, 1/480 s steps), 10 interleaved process pairs: p50 0.159 -> 0.163 ms (unresolved), p90 0.623 -> 0.519 (SE 0.010), p99 0.747 -> 0.636 (SE 0.007), mean 0.311 -> 0.274 ms (-11.7%, SE 0.006); 221 of 221 tests in the 17 Rapier-touching files pass. V8 profile of the production build in Chromium, 3 s of sim at 1/120 s with render, 2 dummies tumbling, 2 interleaved pairs (n too small to resolve): Rapier wasm self time 33.0 -> 19.7 ms and 24.0 -> 13.1 ms, against 691 and 563 ms of three.js self time in the same profiles (4.8% -> 4.1% and 4.3% -> 3.7% of it); in this light scene Rapier is under 2.5% of the frame's CPU, so the gain there is about 0.04 ms a frame | the bits differ from the plain build, so reels with dummies or knocked props change (REPLAY bump); ragdolls are cosmetic (nothing reaches the sim or netplay). WebAssembly SIMD needs Chrome 91, Firefox 89, Safari 16.4: inside Vite's default target. The wasm is 52 KB larger |

### Measured, not adopted

| Item | Result | Verdict |
|---|---|---|
| Cache headers on `assets/**` | Nitro's Vite integration already sends `Cache-Control: public, max-age=31536000, immutable` on every file under `assets/` (the unmodified baseline build, 25 requests in a production browser run: all 25 carry it; the second visit takes 20 of 23 requests from the cache) | nothing to add |
| tsgo (`@typescript/native-preview` 7.0.0-dev.20260707.2) and `oxlint-tsgolint` | tsgo 1.0-1.1 s wall, 4.2 s CPU vs tsc 6.4-9.3 s, 11-14 s CPU (n = 5 pairs, load 14); same 4 diagnostics on 4 seeded errors; needed `baseUrl` out of tsconfig (TS 7 removed it). `oxlint --type-aware` finds nothing new (no type-aware rule is enabled); `--type-check` adds 2 false positives | both are Go (microsoft/typescript-go): the repo allows no Go. Incremental `tsc` is the fast check |
| Node compile cache for the test children | user CPU of the 174 files' imports 184.8 -> 142.9 s warm (-23%); a cache filled from one worktree hits from another (209.9 -> 148.3 s); 15 MB | `capped` exports `NODE_COMPILE_CACHE` now, so nothing to add |
| Startup of a test file | 0.7-1.4 s CPU per file, 145-196 CPU-s per suite (11-13% of all test CPU). In a profile: amaro's type strip 21-24%, V8 module compile 10-12%, `new Track(...)` at module level 15-25% in track-heavy files | a strip cache would save about 35 CPU-s (9 s wall): not worth a loader hook |
| Why the slow files are slow | CPU profiles of `race-eject-false` and `reel-view`: `world/track.ts` ground queries are 30% / 16% of self time (`heightAt` 9.4%, `stampPath` 7%, `projectPath` 6%, `deckAt` 3%), `ai/race-ai.ts` `plan` 9%, Rapier-in-wasm 15% in reel-view; GC 1-1.5% | the cost is the sim itself, which is also the game's per-step cost: a sim-perf item, not a toolchain flag. GC is so small that `--max-semi-space-size` cannot help |
| Splitting the 209 s `it` in `survival-chase` | with longest-first the wall is already at the 4-slot floor | no |
| Test concurrency above 4 | one test process peaks at 430-630 MB, so 4 fit the 4 GB cap with room; 6 would sit at the cap | no |
| `oxlint --type-aware` | runs (0.6 s), finds nothing new: no type-aware rule is enabled | enabling rules is a policy change |
| `oxlint --type-check` as the typecheck | adds 2 false positives (`vite.config.ts` TS2578 x2) that tsc does not report | no |
| Minifier on the same unminified chunks (12 files, 2.26 MB min) | oxc (Vite's) 2,263,822 B, 0.28 s; terser (2 passes) +0.9%, 13.4 s; esbuild +1.3%, 0.56 s. Brotli: oxc 570,909, terser 565,891, esbuild 586,717 | keep oxc. Its `mangle.toplevel` and `compress.target` change nothing (ES module mode, nothing to lower) |
| Vite `build.target` | the default `baseline-widely-available` is Chrome 111, Edge 111, Firefox 114, Safari 16.4: all above ES2022, which is what the source is written in | nothing is lowered, nothing to gain |
| `define` dead-code removal of debug paths | `import.meta.env.DEV` is not used; `window.__crush` is unconditional and the probes need it in the built game | nothing to remove |
| Source maps in production | off by default; `.map` files are not served or compressed by Nitro | keep off |
| Brotli + gzip copies of public files (Nitro `compressPublicAssets`) | wire size: Rapier wasm 573 -> 420 KB, three 150 -> 122 KB, engine 185 -> 155 KB; build 3.4-3.6 -> 7.3-7.6 s wall (+4 s, +6.7 s CPU, 4 pairs) | size only: left off |
| Chunk split | the first-load set is `index` (React, router: 740 KB rendered), `preload-helper` (zod, 154 KB: the game's codec and matchmaking schemas need it too), `routes`, then `engine`/`three`/`rapier`/`lab` on game start. `lab` is code shared by `routes` and `engine`, not a lazy scene | no rarely used scene to split off |
| Skin kernel (`kernels/skin`) | the release profile already has opt-level 3, LTO, codegen-units 1, panic abort, strip. 10 interleaved process pairs x 5 reps x 240 frames of the 10-car pile-up, all variants bit-identical (one digest over all 300 runs): wasm vs JS skin -23.3% (-17.3 ms per 240 frames, SE 1.7); `wasm-opt -O3` -1.2% (SE 1.1), `-O4` +2.4% (SE 1.3), `+simd128` +1.5% (SE 1.6), both +0.1% (SE 1.4): not resolved. `wasm-opt -O3` makes the file 153 B smaller (2768 -> 2615), `+simd128` 91 B larger | no change: the loop is branchy gathers over short inner loops, nothing for SIMD to vectorize |
| `vite-plus` 1.1.0 (VoidZero) | a `vp` CLI and package that bundles Vite (as an alias of their fork `@voidzero-dev/vite-plus-core`), Vitest 5, Oxlint 1.87, Oxfmt 0.72, tsgolint, Rolldown, tsdown and a cached task runner (`vp run`) behind one `vite.config.ts` | swaps `vite` for a fork and the test runner for Vitest across ~12 open lanes; no runtime effect. No |

### Open

- A test-result cache keyed by the import closure would skip unchanged files outright; tests would have to be proven hermetic first.
