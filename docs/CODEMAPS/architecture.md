<!-- Generated: 2026-10-01 | Files scanned: 24 | Token estimate: ~1100 -->
# Architecture

Browser crash lab: TanStack Start shell → one React page → `CrashEngine` (three.js, plain classes). All physics is in `src/game/`; React only renders the HUD.

```
src/routes/index.tsx  Home ─► src/components/crash-lab.tsx  CrashLab
                                   │ dynamic import("@/game/engine")
                                   ▼
src/game/engine.ts  CrashEngine(canvas)  ── window.__crush (bench / devtools handle)
  ├─ cars: DeformableCar[]        car.ts ─► StreamedDeformation (streamed-deform.ts)
  ├─ contacts                     sat.ts, pair-contact.ts, engine-props.ts
  ├─ scenes                       fleet.ts, derby*.ts, compactor.ts, piston-rig.ts, engine-pistons.ts
  ├─ input/camera                 car-drive.ts, drive-input.ts, gamepad.ts, engine-camera.ts
  ├─ FX / world                   engine-fx.ts, engine-world.ts
  ├─ trace                        engine-trace.ts (J key, JSON button)
  └─ emitHud() ─► hud-store.ts publishHud ─► useSyncExternalStore in CrashLab ─► components/hud*.tsx
```

## Module boundaries
- `*-core.js` (`physics-core.js`, `shape-match-core.js`): number-only hot kernels, no THREE; typed by `*.d.ts`, re-exported by `physics-util.ts` / `shape-match.ts`.
- `rig-spec.ts`: data tables only. `car-mesh.ts` / `car-variants.ts`: geometry + per-style rig overrides.
- `streamed-deform.ts`: owns masses, clusters, cages, skin. Never touches the scene graph beyond its debug helpers.
- `engine*.ts`: orchestration; `CrashEngine` is the only owner of the frame loop.

## Per-frame flow (`engine.ts`)
```
tickInner(now)                               wallDt ≤ 0.1 s
 ├ pollInput()                               keys + pad → DriverSeat
 ├ simDt = wallDt × timeScale (slow-mo ramp); acc ≤ 0.05
 ├ while acc: h = physicsSlice(acc, sliceSpeed(cars))   ≤ 8 steps, 8 ms budget
 │   fixedStep(h)  → 1–3 slices:
 │     applyDrive (player seat, derby AI via DerbyBrain.think)
 │     integrate / syncPose
 │     collideWith (mass spheres, car pairs ≤ ~5.3 m)
 │     contact loop ×1..3: barrier.resolve · resolveCarPair · resolveRampBalls · resolveLampPoles
 │     deform.stepStructure(h) → syncPose → barrier.clip → afterContacts → clipDerbyCar
 │     (compactor / pistons scenes: stepCompactor / stepPistons instead)
 │   cutDrive, bleedAfterSlide
 ├ scheduleSkins(cars)                       LoD stride / frustum → skinDeferred
 ├ car.updateDeform(simDt)                   deform.update → cages → skin (flushSkin)
 ├ updatePhase · FX (debris, sparks, glass, smoke) · trace · stepDerby · seat.step
 ├ updateCamera(wallDt)
 ├ flushVisibleSkins()                       owed skins on screen get written
 ├ renderer.render(scene, camera)
 └ emitHud(false)  every 0.05–0.12 s
```
`phase`: `approach → impact → slowmo → aftermath` (`CrashPhase` in `hud-store.ts`); `beginCinematic` fires on the first strong contact.

## Scenes (one at a time; toggles in `engine.ts`)
| Scene | Key | Entry | Code |
|---|---|---|---|
| Fleet (default) | R | `spawnFleet` | `fleet.ts` `layoutFleet`, `fleetStyle` |
| Barrier | B | `toggleBarrier` | `engine-props.ts` `JerseyBarrier`, `sat.ts` |
| Ramp balls | K | `toggleBalls` | `engine-props.ts` `buildRampBalls`, `resolveRampBalls` |
| Compactor | C | `toggleCompactor` | `compactor.ts` `CompactorRig`, `engine-props.ts` `CompactorPress` |
| Pistons | I, 0–8 | `togglePistons`, `firePiston` | `piston-rig.ts`, `engine-pistons.ts` `PistonBank` |
| Derby | D | `toggleDerby` | `derby.ts` `DerbyMatch`, `derby-ai.ts` `DerbyBrain`, `derby-arena.ts` |

Lamp poles (`engine-props.ts` `resolveLampPoles`) are hit in the fleet / barrier / balls contact loop and hidden in derby. Doors are car parts (`car.ts` `doorL/doorR`), not a scene.

## Related
[physics.md](physics.md) · [frontend.md](frontend.md) · [testing.md](testing.md) · [dependencies.md](dependencies.md) · `docs/RIG_ANALYSIS.md` · `.extraResearch/SYNTHESIS.md`
