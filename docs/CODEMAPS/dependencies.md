<!-- Generated: 2026-10-01 | Files scanned: 6 | Token estimate: ~600 -->
# Dependencies

Versions are those installed from `package-lock.json` (2026-10-01).

## Runtime that the game uses
| Package | Version | Used for |
|---|---|---|
| `three` | 0.186.0 | renderer, scene graph, `BufferGeometry` skinning target, math types (`src/game/**`) |
| `react` / `react-dom` | 19.2 | HUD (`src/components/hud*.tsx`, `crash-lab.tsx`), `useSyncExternalStore` on `hud-store.ts` |
| `@tanstack/react-start` / `react-router` / `router-plugin` | 1.168 / 1.170 | app shell, file routes (`src/routes/`, generated `src/routeTree.gen.ts`), SSR via Nitro |
| `@radix-ui/react-accordion`, `react-popover`, `lucide-react`, `class-variance-authority`, `tailwindcss` 4 | | HUD sections, key list popover, icons, `ui/button.tsx`, styling (`src/styles.css`) |

The template's other dependencies (`better-auth`, `pglite`, `kysely`, `pg`, `zod`, `recharts`, most Radix widgets) serve `src/lib/` (auth / app-data). The game and HUD import only `src/lib/utils.ts` (`cn`) and `src/lib/preview-host-bridge.ts`.

## Dev / tooling
| Package | Version | Used for |
|---|---|---|
| `vite` | 8.2 | dev server (`npm run dev`), `vite build`, `vite preview` (`vite.config.ts`) |
| `nitro` | 3.0 beta | server build; output in `.vercel/output` |
| `typescript` | 5.9 | `npm run typecheck` (`tsc --noEmit`); tests run TS directly via `node --experimental-strip-types` |
| `playwright` | 1.63 | `scripts/bench-browser.mjs` (Chromium / Edge frame bench) |
| `oxlint`, `oxlint-plugin-eslint` | 1.86 | `npm run lint` (`.oxlintrc.json`: ESLint `js` + `typescript-eslint` recommended, React hooks / refresh; `oxlint-plugin-eslint` supplies `no-undef` and `no-restricted-syntax` for `.js`). See [../TOOLCHAIN.md](../TOOLCHAIN.md). |
| `prettier` | 3 | `npm run format` |
| `@types/three`, `@types/node` | | types only |

No test framework dependency: tests use `node:test` and `node:assert/strict`.

## Hand-written JS kernels
`src/game/physics-core.js` and `src/game/shape-match-core.js` are plain JavaScript with `// @ts-nocheck`, typed by sibling `.d.ts` files and re-exported through `physics-util.ts` / `shape-match.ts`. They work on numbers and typed arrays, not THREE objects. Kept as JS because the TypeScript emit was several times slower on these loops; the sim and the tests import the same JS. Measure with `npm run bench`. Side effect: `npm run lint` reports the two `@ts-nocheck` headers as errors (`no-warning-comments`, which stands in for `typescript-eslint`'s `ban-ts-comment` on `.js` files, where oxlint's own `typescript/ban-ts-comment` doesn't run).

## Related
[architecture.md](architecture.md) · [testing.md](testing.md)
