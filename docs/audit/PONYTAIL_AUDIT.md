# Ponytail audit (repo-wide)

Measured on `lane/structure-audit` rebased on main `3f8eb23` (2026-10-02). Scope: `src/game/**`, `src/components/**`,
`src/routes/**`, the `src/lib` files the game uses (`multiplayer/`, `qr.ts`, `utils.ts`), `scripts/` (game scripts),
`package.json`. Out of scope (platform chrome): `server/`, `public/__grok/`, `scripts/grok-pwa-*`, the other `src/lib` template
helpers. Over-engineering only; correctness and performance findings go to [ARCHITECTURE.md](../ARCHITECTURE.md) (rules C1-C9)
and [REFACTOR_PLAN.md](REFACTOR_PLAN.md).

## How each claim was measured

| tag | instrument | where the raw output lives |
|---|---|---|
| `delete:` (0 callers) | `xd://lsp references` (typescript-language-server) on the declaration: "Found 1 reference(s)" = the declaration only. Where the LSP daemon was down ("Daemon broker request aborted", before the 01:28 VM reboot) the same query ran through the TypeScript `LanguageService.findReferences` over `tsconfig.json` (155 program files). | quoted per row |
| unused export | `node scripts/check-boundaries.mjs --list`, check C5 (111 rows), cross-checked by `findReferences` | C5 section of the script output |
| clone | `node scripts/dup-scan.mjs` (token-window clone finder, jscpd method; jscpd is not in the npm cache: `npx --offline jscpd` → `ENOTCACHED`) | [DUPLICATION.md](DUPLICATION.md) |
| unused dep | import census: every `from "<pkg>"`, `import("<pkg>")`, `@import`/`@plugin "<pkg>"` across `src/`, `scripts/`, `server/`, `public/`, `vite.config.ts`; peer/transitive needs read from `node_modules/<pkg>/package.json` | §Dependencies |
| `shrink:` | both sides read; the shorter form is shown | per row |
| span | TypeScript AST start/end line of the named function | per row |

"NOT deletable" marks a row whose removal changes behaviour (game or tests); it stays on the list so nobody deletes it by grep.

## Findings, biggest cut first

1. `delete:` 32 npm dependencies with zero imports anywhere in the repo: `@hookform/resolvers`, 19 `@radix-ui/*` (alert-dialog, avatar, checkbox, collapsible, dialog, dropdown-menu, label, progress, radio-group, scroll-area, select, separator, slider, slot, switch, tabs, toggle, toggle-group, tooltip), `@tanstack/react-query`, `@tanstack/react-table`, `cmdk`, `date-fns`, `react-day-picker`, `react-hook-form`, `react-resizable-panels`, `recharts`, `sonner`, `tw-animate-css` (not `@import`ed by `src/styles.css`), `vaul`, `zustand`. Replacement: nothing; re-add when a component needs one. Needs a lockfile regeneration, which lanes may not run. [package.json]
   - NOT deletable despite 0 imports: `react-dom` (peer dependency of `@tanstack/react-start` and `@tanstack/react-router`), `@tanstack/router-plugin` and `lightningcss` (dependencies of `@tanstack/start-plugin-core` / `vite`; removal is resolution-neutral only if `npm ci && npm run build:node` stays green, not measured), `@types/*` (consumed by `tsc` without imports), `oxlint`, `oxlint-plugin-eslint`, `prettier`, `typescript` (npm-script CLIs).
   - Kept, used: `three`, `react`, `zod`, `@tanstack/react-router`/`react-start`, `@radix-ui/react-accordion` + `react-popover`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss`, `@tailwindcss/vite`; template-only but live through the signaling server's database (`src/lib/db.ts`): `pg`, `@electric-sql/pglite`, `kysely`, `better-auth`, `jose`.
2. `shrink:` the engine's fixed step is re-implemented four times outside `CrashEngine`: `crash-scenarios.test-util.ts` `fixedStep` 150-228 (79) + `tickWorld` 231-261 (31), `race/race-world.test-util.ts` `fixedStep` 75-125 (51) + `frame` 128-142 (15), `pair-contact.ts` `stepCarPair` 331-366 (36), `zip.test.ts` `bleed` 44-49 (6, a reduced copy of `physics-util.ts` `bleedAfterSlide` 81-92 that drops the ground-friction branch). Replacement: one headless `stepWorld(world, dt)` extracted from `engine.ts` `fixedStep` 1457-1629 (173) that both the engine and the harnesses call. About -200 test lines, +30 production. NOT behaviour-neutral for the tests: the copies have drifted (e.g. `derby.test.ts:336` clips with `clipToDerbyBowl(…, 2.15)` while `engine.ts:1634` passes `2.15, this.derbyR` since the arena-scaling merge), so suite numbers may move; the game is unchanged. [crash-scenarios.test-util.ts, race/race-world.test-util.ts, pair-contact.ts, zip.test.ts, derby.test.ts]
3. `delete:` `src/game/shape-match.ts` (85 lines), a façade over `shape-match-core.js`. Its types (lines 7-58) equal `shape-match-core.d.ts` lines 1-51 once comments are stripped (`diff` printed nothing), and 5 of its 24 re-exports have no importer (`m3Copy`: LSP "Found 1 reference(s)", the re-export line; `m3Finite`, `m3Orthonormalize`, `m3ClampRotation`, `stabilizeR`: findReferences 0 outside the `.d.ts`). Replacement: the 4 importers (`deform-helper.ts`, `streamed-deform.ts`, `shape-match.test.ts`, `skin.test.ts`) import `./shape-match-core.js` directly; move the one extra doc comment (`rotQ`) into the `.d.ts`. [src/game/shape-match.ts]
4. `yagni:` ~250 lines of headless test harness live in production modules and are imported only by tests: `piston-rig.ts` `pistonLocality` 556-592 (37), `firePiston` 600-623 (24), `measureShot` 625-763 (139); `door-rig.ts` `fireRam` 242-259 (18); `pair-contact.ts` `stepCarPair` (row 2). findReferences: `firePiston` 8 refs, all in `piston-rig.test.ts`/`skin.test.ts`/`contact-parity.test-util.ts`; `fireRam` 4, all tests; `pistonLocality` 5, all tests. Replacement: move to `piston-rig.test-util.ts` / `door-rig.test-util.ts`. 0 net lines, -250 production lines. NOT deletable (the piston and door suites run through them). [piston-rig.ts, door-rig.ts]
5. `shrink:` `car.ts` `buildHullHelper` 432-481 (50) and `updateHullHelper` 483-531 (49) each spell out the same 8-corner and 12-edge tables (dup-scan: 32-line exact clone 434-465 == 488-519). Shorter form, debug view only:
   ```ts
   const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
   function writeHullBox(h: Hull, arr: Float32Array, o: number): number {
     for (const k of BOX_EDGES) {
       arr[o++] = k & 1 ^ (k >> 1 & 1) ? h.cx + h.hx : h.cx - h.hx; // x0/x1 per corner bit pattern 0..3
       arr[o++] = k < 4 ? 0.18 : 0.72;
       arr[o++] = (k & 3) >= 2 ? h.cz + h.hz : h.cz - h.hz;
     }
     return o;
   }
   ```
   `buildHullHelper` allocates `new Float32Array(HULLS.length * 72)` and calls `updateHullHelper`. About -60 lines. [src/game/car.ts]
6. `delete:` `crushedHulls` `car-mesh.ts` 34-71 (38 lines, plus its doc comment line 33). LSP: "Found 1 reference(s)", the declaration. Replacement: nothing; `StreamedDeformation.liveCrushHulls` is the live implementation. [src/game/car-mesh.ts]
7. `stdlib:` / `shrink:` scalar helpers copied per file. `clamp` 5 byte-identical copies (`engine-race.ts:94`, `race/race-ai.ts:45`, `race/session.ts:47`, `race/track-art.ts:181`, `race/traffic.ts:38`) plus the kernel's own `physics-core.js:9` (exported and typed in `.d.ts`, 0 TS importers); `hash01` 3 byte-identical copies (`ai-aggression.ts:7`, `derby-ai.ts:67`, `race/race-ai.ts:49`); `wrapPi` 6 copies in 3 bodies (atan2: `engine-camera.ts:21`, `engine-pistons.ts:8`; floor: `race/race-ai.ts:41`, `race/track.ts:94`, `race/traffic.ts:34`; while-loop: `derby-ai.ts:85`); `smooth01` `car-mesh.ts:94` = `THREE.MathUtils.smoothstep(t, 0, 1)` (same branches and formula). Replacement: one THREE-free `src/game/scalar.ts` (kernel layer) holding `clamp`, `clamp01`, `wrapPi`, `hash01`, `smoothstep`; `THREE.MathUtils.smoothstep` in `car-mesh.ts`. About -35 lines.
   - NOT provably identical, keep separate until an A/B says otherwise: the three `wrapPi` bodies disagree at exactly ±π (atan2 → (-π, π], floor → [-π, π)); `car-mesh.ts:90` `lerp` (`a + (b - a) * t`) vs `THREE.MathUtils.lerp` (`(1 - t) * a + t * b`) round differently, so the rest mesh would move in the last bit.
8. `shrink:` `engine.ts` scene toggles: `toggleBarrier` 431-440, `toggleBalls` 442-450, `toggleCompactor` 452-461, `togglePistons` 463-475, `toggleDoors` 501-510, `toggleDerby` 546-552, `toggleRace` 577-582 each re-run the same "leave derby, leave race, clear the other rig flags, unlock audio, reset, emit" prologue (dup-scan: 431-435 == 442-446 exact; 448-463 ≈ 497-513 renamed), and the predicate `this.showCompactor || this.showPistons || this.showDoors` appears 5× in `engine.ts` plus 1× in `components/hud.tsx`. Shorter form: one `scene: "fleet" | "press" | "pistons" | "doors" | "derby" | "race"` field with `setScene(next)`; barrier and balls stay independent props. About -30 lines. [src/game/engine.ts]
9. `shrink:` `physics-util.ts` 4-36 imports 14 names from `physics-core.js` and then lists the same 14 in a second `export { … }`; `CrushBands` (line 38) re-declares `physics-core.d.ts:18` verbatim. Shorter form:
   ```ts
   export { CRASH, TRANSFER, regionSoftness, crushGate, dtImpulseScale, closingKeScale, regionCrushBands, forceTransfer, leftoverPass, leftoverCrumple, crushStroke, cancelClosing, satPushCap, round4, type CrushBands } from "./physics-core.js";
   import { CRASH, leftoverCrumple, /* only the names this file uses */ } from "./physics-core.js";
   ```
   About -16 lines. [src/game/physics-util.ts]
10. `delete:` `raceMaterials` `race/track-art.ts` 22-30 plus the `RaceMaterial` type (line 20, used only by it) and the header sentence advertising it (lines 14-15). LSP: "Found 1 reference(s)", the declaration. -12 lines. [src/game/race/track-art.ts]
11. `shrink:` `components/hud-panels.tsx` `slider` (closure, 48-63) and `doorSlider` (121-138) render identical markup (read both: same `<label>`, `<input type="range">`, value `<span>`). Replacement: one `RangeRow` component. -17 lines. [src/components/hud-panels.tsx]
12. `shrink:` test fixtures copied between suites: `race/session.test.ts:12-26` == `race/track.test.ts:7-21` (15-line exact clone, the `SQUARE` track file); `derby-ai.test.ts:15-26` == `derby.test.ts:15-26` (12 lines, the `car()` AI-car factory). Replacement: export each once from the suite's test util. -27 lines.
13. `shrink:` ramp-ball vs lamp-pole contact in `engine-props.ts`: `resolveRampBalls` 350-431 and `resolveLampPoles` 447-501 share a 19-line body (dup-scan renamed clone 357-375 ≈ 452-470; exact 365-372 == 460-467). Replacement: one `resolveRoundProp(car, x, z, r, mass, …)`. About -15 lines. Needs a replay diff (no suite pins pole contact numbers). [src/game/engine-props.ts]
14. `delete:` dead private state in `engine.ts`: the `carB` getter 111-113 (LSP "Found 1 reference(s)", the declaration) and the type re-export on line 46 `export type { CrashHudState, CrashPhase } from "./hud-store"` (LSP: 1 reference, itself; every consumer imports `hud-store.ts`). -4 lines.
15. `delete:` the unused `force` parameter of `CrashEngine.emitHud` (`engine.ts:1966-1967`, first statement `void force;`), passed `true`/`false` at 54 call sites. Replacement: `emitHud()`. -1 line, 54 simpler calls. [src/game/engine.ts]
16. `shrink:` `car.ts` `hulls()` 533-538 computes `frontOff`/`rearOff` with two `parts.some(…)` closures per call and hands them to `StreamedDeformation.liveHulls`, whose first statements are `void frontDetached; void rearDetached;` (`streamed-deform.ts:1993-1994`). Shorter form: `hulls() { return this.deform.massActive ? this.deform.liveHulls() : HULLS; }` with the two parameters dropped. -4 lines, -2 closures per pair per slice (rule C6). `crushHulls()` does use them (`liveCrushHulls`) and stays. [src/game/car.ts, src/game/streamed-deform.ts]
17. `delete:` 80 `export` keywords on symbols only their own file uses (check C5 "used in own file"), e.g. `car.ts:46` `WorldBounce`, `vehicle-classes.ts:156` `REAL_KILL_TRAVEL`, `physics-core.js:110` `clamp`. 0 lines; the module surfaces shrink to what other files use.

## Kept on purpose (looked at, not cuts)

- Module-scope scratch vectors (`const _a = new THREE.Vector3()` runs) repeat across `car.ts:1473-1482`, `engine-props.ts:26-37`, `lamp-lights.ts:261-272`, `streamed-deform.ts:100-112` (dup-scan renamed clones). They are the allocation-free pattern; sharing one pool would couple unrelated hot paths.
- Data rows: `vehicle-classes.ts:49-124`, `car-variants.ts:79-224`, `rig-spec.ts:119-157` show up as renamed clones because tuning tables are rows of the same shape. Tables are the intended home of knobs (ARCHITECTURE.md rule K1).
- `shape-match-core.js` internal unrolled 3×3 maths (renamed clones 26-35 ≈ 513-534): a hand-written hot kernel, kept plain by design (`docs/CODEMAPS/dependencies.md`).
- `net/codec.ts` `writeWreck`/`readWreck` mirror each other (renamed clones 213-220 ≈ 252-259): a symmetric codec reads best as two straight functions.
- `net/transport.ts` (`NetTransport`) has two implementations (`BroadcastTransport`, `RtcTransport`); not a single-implementation interface.
- `ai-aggression.ts` (27 lines) has two production importers (`engine-race.ts`, `race/race-ai.ts`); only its `hash01` copy is a finding (row 7).
- `it.todo` (4) and `{ todo: … }` cases (12 call sites, driven by the `TODO` map in `piston-rig.test.ts` and `PENDING` in `contact-parity.test.ts`; 53 todo results in the gate) are documented physics targets that still run. They are the "wobbly" allowance (ARCHITECTURE.md rule W3), not scaffolds.
- Stale-marker scan: `grep -rn "TODO\|FIXME\|XXX\|HACK"` over `src/game` and `src/components` hits only the declaration of that piston `TODO` map (`piston-rig.test.ts:69`): 0 stale markers.

net: -547 lines, -32 deps possible (-515 code lines across rows 2-16, -32 `package.json` lines; row 4 moves another ~250 lines out of production without deleting them).
