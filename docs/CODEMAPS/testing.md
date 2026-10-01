<!-- Generated: 2026-10-01 | Files scanned: 24 | Token estimate: ~1050 -->
# Testing and harnesses

Runner: `node --test` with `--experimental-strip-types` (no Vitest/Jest). Node ≥ 22.6 (verified on 24.15).

| Command | Runs | Status at e0e61ec |
|---|---|---|
| `npm run test:game` | `src/game/*.test.ts` | 587 tests: 536 pass, 51 todo, 0 fail (~11 s) |
| `npm test` | `scripts/**/*.test.mjs` **&&** 4 `src/lib` suites + `src/game/*.test.ts` | exits 1: 8 failures in `scripts/grok-pwa-plugin.test.mjs` (platform script, pre-existing), so the `&&` never reaches the game suites |

The second half of `npm test` on its own: 642 tests, 591 pass, 51 todo, 0 fail.

## Game suites (`src/game/`)
| File | Covers |
|---|---|
| `physics-util.test.ts` | `CRASH` constants, crush bands, transfer, `cancelClosing`, sphere separation |
| `crash-physics.test.ts` | both modes (`forModes`), lattice beams |
| `crash-parts.test.ts` | beams, detach / wheel rules, frame-rate independence, glass, car-car crush vs speed |
| `shape-match.test.ts` | polar decomposition, goals, plasticity, normals, local skin, shape solver across hits |
| `barrier.test.ts` | Jersey barrier full speed vs slow-mo, engine-kill speeds, rigid-wall crush vs NCAP/IIHS |
| `compactor.test.ts` | `COMPACTOR` stages, crush to wheel wells / past hubs, masses and cages stay inside the plates, stiffness |
| `piston-rig.test.ts` | ram geometry, standard shot, locality, tap, severity, kill EBS, lattice mode |
| `skin.test.ts` | skin follows particles (3 km/h tap, 40 km/h shot) |
| `skin-lod.test.ts` | deferred skin is owed, never lost |
| `fast-normals.test.ts` | `computeNormalsFast` equals `computeVertexNormals` |
| `zip.test.ts` | captured two-car spawn does not zip at the slow-mo handoff |
| `rest-mesh.test.ts` | rest body is a sedan; writes `artifacts/rest-silhouette.svg` |
| `car-variants.test.ts` | body styles, per-style rig cages |
| `fleet.test.ts` / `derby.test.ts` | layouts, pile-up heading; derby AI, scoring, bowl clip, six-car match |
| `gamepad.test.ts` / `drive-input.test.ts` | pad mapping, steering feel, pedals, `DriverSeat`, drive camera |

## Harnesses
- `src/game/crash-scenarios.test-util.ts`: headless engine frame order. `makeCar(mode, squash, buckle)`, `makeWorld(cars, barrier, slomo)`, `tickWorld(w, wallDt)` (physics part of `tickInner` + phase timing), `runWall(speedKph, overlap, approach, opts): CrashResult`, `runPair(kphA, kphB, "head-on" | "t-bone", opts)`.
- `src/game/test-support.ts`: `DT`, `MODES`, `forModes(title, fn)` (one `describe` per deform mode), `dummyGeom()`, `paint()`, `mass(d, name)`.
- Piston rig: `firePiston(car, id, shot)` / `pistonLocality(shot, tap)` in `src/game/piston-rig.ts`; see `docs/PISTON_RIG.md`.
- `npm run sweep` → `scripts/crush-sweep.mjs`: squash × buckle grid over `crash-scenarios`, scored against `docs/RIG_ANALYSIS.md` targets. Flags `--grid`, `--cells s:b,…`, `--scenarios`, `--after`, `--root`, `--out` (default `.bench/crush-sweep/`, writes `sweep.json` + `sweep.md`). See `docs/CRUSH_CALIBRATION.md`.
- `npm run bench` → `scripts/bench-physics.mjs`: ns/op for the JS kernels (`m3Polar`, `matchCluster`, `applyPlasticity`, `matchSkinLocal`, `crushGate`, …); no flags.
- `scripts/bench-browser.mjs`: Playwright frame bench through `window.__crush` (tick / physics / deform / render). Usage in `README.md`.

## `todo` convention
Behaviour that is documented but not yet met stays in the suite as a todo, so the body still runs and reports, but cannot fail the run:
- `it.todo("name", fn)` (e.g. `crash-parts.test.ts`, `derby.test.ts`);
- `it(name, { todo: TODO[key] }, fn)` with the reason in a `TODO` map (`piston-rig.test.ts`); a key absent from the map runs as a normal test.
`node --test` lists failing todos under "failing tests" with `# TODO`, yet exits 0. When the code meets the target, delete the todo entry so the test becomes a hard gate (`docs/PISTON_RIG.md`).

## Related
[physics.md](physics.md) · `docs/PISTON_RIG.md` · `docs/CRUSH_CALIBRATION.md` · `docs/RIG_ANALYSIS.md`
