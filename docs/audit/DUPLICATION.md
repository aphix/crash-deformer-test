# Duplication map (DRY)

Measured on `lane/structure-audit` rebased on main `3f8eb23` (2026-10-02).

## Instruments

`jscpd` is not in the npm cache (`npx --offline --yes jscpd --version` → `ENOTCACHED`) and lanes may not install, so
`scripts/dup-scan.mjs` implements the same method with the TypeScript scanner already in `node_modules`: a clone is a run of
≥ N identical tokens (comments and whitespace ignored) spanning ≥ 5 lines in two places. `--renamed` also matches copies whose
identifiers and literals differ (type-2 clones).

```
node scripts/dup-scan.mjs src/game src/components src/lib/multiplayer src/lib/qr.ts src/lib/utils.ts scripts
  → clones 31, duplicated lines 512 of 43338 (1.2%), files 138, min 50 tokens/5 lines
node scripts/dup-scan.mjs --renamed --min-tokens 80 <same paths>
  → clones 102, duplicated lines 958 of 43338 (2.2%), files 138, min 80 tokens/5 lines, renamed
```

Token clones miss copies that drifted (the engine-loop copies below differ line by line), so the clusters also include
repeated patterns found by reading: declaration greps over `src/game` and `scripts/crush-sweep.mjs`, TypeScript-AST function
spans, and the two read-only scout passes (rows marked "read by scout" were read by a scout and not re-read here).

Exact copy-paste is low (1.2%). The real duplication is **behavioural**: the engine's step, its slow-mo phase machine and
several contact rules exist a second time in test code, and those copies have drifted from the engine.

## Clusters, biggest first

| # | cluster | locations (lines) | evidence | proposed single owner |
|---|---|---|---|---|
| D1 | Engine fixed step re-implemented for tests | `engine.ts` `fixedStep` 1457-1629 (173, the original); copies: `crash-scenarios.test-util.ts` `fixedStep` 150-228 (79), `race/race-world.test-util.ts` `fixedStep` 75-125 (51), `pair-contact.ts` `stepCarPair` 331-366 (36, production module, test-only callers: findReferences 8, all in `derby.test.ts`/`zip.test.ts`) | AST spans; doc comments say "`CrashEngine.fixedStep` minus poles, balls, derby and compactor" (`crash-scenarios.test-util.ts:149`) and "same order as CrashEngine.fixedStep" (`pair-contact.ts:330`) | `src/game/world-step.ts` (engine layer): `stepWorld(world, dt)` holding the slice loop, pair contact, barrier/props hooks; `CrashEngine.fixedStep` and every harness call it. 339 copied lines → ~30 |
| D2 | Frame tick + slow-mo phase machine | `engine.ts` `tickInner` 1245-1343 (99) and `updatePhase` 1792-1808 (17); copies: `crash-scenarios.test-util.ts` `tickWorld` 231-261 (31), `race/race-world.test-util.ts` `frame` 128-142 (15); `zip.test.ts` has its own phase/slow-mo block (read by scout, 60-95) | both formulas read: test `w.timeScale += (w.targetScale - w.timeScale) * Math.min(1, wallDt * (… ? 1.15 : 3.2))` vs engine `timeScale` update with the same rates; constants copied: `IMPACT_SCALE = 0.032` at `engine.ts:66`, `crash-scenarios.test-util.ts:18`, `zip.test.ts:9`; `SLOMO_HOLD = 6.5` at `crash-scenarios.test-util.ts:19` vs a literal in the engine | `src/game/phase.ts` (match layer): `CrashPhase` type (moved out of `hud-store.ts`, which also fixes the `net → hud` C1 row), `IMPACT_SCALE`, `SLOMO_HOLD`, `stepPhase(state, wallDt)` |
| D3 | Scene/rig contact rules re-coded in tests | `barrier.test.ts` `contact` 124-153 (30) vs `engine-props.ts` `JerseyBarrier.resolve`; `derby.test.ts` `clipDerbyCar` 333-341 (9) vs `engine.ts` `clipDerbyCar` 1631-1641 (11); `zip.test.ts` `bleed` 44-49 (6) vs `physics-util.ts` `bleedAfterSlide` 81-92 (12) | drift measured: `derby.test.ts:336` calls `clipToDerbyBowl(p.x, p.z, v.x, v.z, 2.15)`, `engine.ts:1634` passes `2.15, this.derbyR` (arena now scales with the field); `bleed` drops the ground-friction branch; barrier drift read by scout | export the production functions (`clipDerbyCar` → `derby-arena.ts`, barrier resolve already exported); tests import them; D1's `stepWorld` replaces the loops that call them |
| D4 | Hull wireframe tables | `car.ts` `buildHullHelper` 432-481 / `updateHullHelper` 483-531 | dup-scan exact: 32 lines `car.ts:434-465 == 488-519` | `car.ts`: one `BOX_EDGES` table + `writeHullBox()` (PONYTAIL row 5) |
| D5 | Live hull builders | `streamed-deform.ts` `liveHulls` 1992-2054 (63) / `liveCrushHulls` 2056-2116 (61) | same five-hull literal structure (read by scout); not a token clone at 50 tokens; `liveHulls` voids both parameters (1993-1994) | `streamed-deform.ts`: one builder writing into five preallocated `Hull` objects, crush insets as parameters (also clears 12 of the 35 C6 rows) |
| D6 | Scene toggles in the engine | `engine.ts` 431-510, 546-552, 577-582 (7 toggles, 65 lines) | dup-scan exact `431-435 == 442-446`, renamed `448-463 ≈ 497-513` (17); the predicate `showCompactor \|\| showPistons \|\| showDoors` 5× in `engine.ts`, 1× in `components/hud.tsx` | `engine.ts`: one `scene` field + `setScene()`; `CrashHudState` exposes `scene` so `hud.tsx` stops re-deriving it |
| D7 | Scalar helpers | `clamp` ×5 identical + `physics-core.js:9`; `hash01` ×3 identical (`ai-aggression.ts:7`, `derby-ai.ts:67`, `race/race-ai.ts:49`) + `skin.test.ts:44` copying the private `streamed-deform.ts:124` salted variant; `wrapPi` ×6 in 3 bodies; `smooth`/`smooth01`/`clamp1`/`clamp01` singletons | declaration grep (`function clamp`, `function hash01`, `function wrapPi`, `const wrapPi =`); bodies read | `src/game/scalar.ts` (kernel layer, THREE-free); the salted `hash01` exported from `streamed-deform.ts` for `skin.test.ts`. Bodies that differ at ±π stay separate until A/B'd (PONYTAIL row 7) |
| D8 | Round-prop contact | `engine-props.ts` `resolveRampBalls` 350-431 / `resolveLampPoles` 447-501 | dup-scan exact `365-372 == 460-467` (8) and `357-363 == 452-458` (7); renamed `357-375 ≈ 452-470` (19) | `engine-props.ts`: `resolveRoundProp()` |
| D9 | Barrier-basis projection | `engine-props.ts:228-237` vs `sat.ts:65-74` | dup-scan renamed (10 lines): both project onto `_bRight`/`_bFwd` built from `Math.cos(yaw)`/`Math.sin(yaw)` | `sat.ts` exports `barrierLocal(x, z, out)`; `engine-props.ts` calls it |
| D10 | Rigid plan-view fit of the cabin | `contact-parity.test-util.ts:80-90` vs `piston-rig.ts:660-670` (in `measureShot`) | dup-scan exact `80-87 == 660-667` (8), renamed 11 | `piston-rig.test-util.ts` `fitRigid(masses, filter)` once `measureShot` moves there (REFACTOR_PLAN S5) |
| D11 | Road-segment walk | `race/placements.ts:89-95`, `race/track-art.ts:286-292`, `race/track-art.ts:307-312` | dup-scan exact, 3 copies (7, 6, 6 lines): `const segs = p.closed ? p.count : p.count - 1; … if (p.deck[k]) continue; const b = (k + 1) % p.count;` | `race/track.ts` (world): a segment iterator on the path type |
| D12 | Test fixtures | `race/session.test.ts:12-26 == race/track.test.ts:7-21` (15, `SQUARE` track); `derby-ai.test.ts:15-26 == derby.test.ts:15-26` (12, `car()` factory) | dup-scan exact | `race/track.test-util.ts` and a `derby.test-util.ts` |
| D13 | Car resets | `car.ts:639-648 == 1399-1408` (10, glass panes back to intact); `car.ts:553-561 == 570-578` (9 exact, 14 renamed, spawn pose) | dup-scan exact | `car.ts` private `resetGlass()` / `placeAt(x, z, yaw)` |
| D14 | Wall bounce in race | `engine-race.ts:888-895 == 974-981` (8) and `897-901 == 980-984` (5) | dup-scan exact | `engine-race.ts` local `wallBounce()` |
| D15 | Debug-view layers | `deform-helper.ts:73-85 == 561-573` (13), `250-261 == 322-333` (12), `145-153 == 174-182` (9; renamed `142-157 ≈ 171-186`, `SensorLayer` vs `MassLayer`) | dup-scan | `deform-helper.ts`: one instanced-sphere setup function used by both layers |
| D16 | Mesh grid indices | `car-mesh.ts:726-737 ≈ 779-791` (13), `402-407 == 555-560` (6) | dup-scan | `car-mesh.ts` `pushGridQuads(indices, row, segX, segY, flip)` |
| D17 | HUD range sliders | `components/hud-panels.tsx` `slider` 48-63 / `doorSlider` 121-138; third variant `components/hud-sections.tsx` `SliderField` 97+ (adds a number input) | both hud-panels bodies read: identical markup | `components/hud-controls.tsx` `RangeRow` (with optional number field) |
| D18 | HUD prop forwarding | `components/crash-lab.tsx` 61-117 forwards each engine verb as a `HudProps` callback declared in `components/hud.tsx` 28-69 | read by scout (41 callbacks) | pass the engine handle to the panels; keep callback props only for UI-owned state |
| D19 | AI `think` prologue | `derby-ai.ts:223-231` vs `race/race-ai.ts:170-178` (9, zeroing `out`) | dup-scan exact | `car-drive.ts` `clearDrive(out)` |
| D20 | Wrinkle formula re-derived by a script | `scripts/crush-sweep.mjs` `wrinkle` 166-170 vs `streamed-deform.ts` wrinkle amplitude/skin (read by scout at 1941, 3151-3155) | script comment at 163-165 names the engine source | `streamed-deform.ts` exports `wrinkleFor(crush, buckle)`; the sweep imports it (it already imports the TS harness) |
| D21 | Derby AI internal | `derby-ai.ts:532-538 == 582-588` (7) | dup-scan exact (new in the derby merge) | `derby-ai.ts` local helper |

## Repeats that stay

| pattern | where | why it stays |
|---|---|---|
| module-scope scratch vectors | `car.ts:1473-1482`, `engine-props.ts:26-37`, `lamp-lights.ts:261-272`, `streamed-deform.ts:100-112` (renamed clones) | the allocation-free pattern; a shared pool would couple unrelated hot paths |
| tuning-table rows | `vehicle-classes.ts:49-124` (38-line renamed clone), `car-variants.ts:79-224`, `rig-spec.ts:119-157`, `scripts/crush-sweep.mjs:50-96` | data rows of one shape: tables are where knobs belong |
| kernel unrolling | `shape-match-core.js` 26-35 ≈ 513-534, 638-646 == 740-748, 695-700 == 721-726 | hand-unrolled 3×3 maths in the hot JS kernel |
| symmetric codec | `net/codec.ts` 213-220 ≈ 252-259, 232-238 ≈ 243-249, 271-277 ≈ 282-288 | write/read mirrors read best side by side |
| constant blocks | `engine-race.ts:55-82` ≈ `race/track-art.ts:62-80` | renamed-mode false positive: runs of unrelated `const NAME = number` |
| platform tests | `scripts/brand-check.test.mjs` internal clones | platform chrome, out of scope |

## Total

D1-D21 cover ~1,000 duplicated or drifted lines (D1 + D2 alone: 339 + 46 lines of copied loop). The slices in
[REFACTOR_PLAN.md](REFACTOR_PLAN.md) remove them in dependency order; D1/D2 first unblock most test-side cleanup.
