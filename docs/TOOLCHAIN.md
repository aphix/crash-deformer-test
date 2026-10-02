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
