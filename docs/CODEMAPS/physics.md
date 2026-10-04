<!-- Generated: 2026-10-03 | Files scanned: 18 | Token estimate: ~1700 -->
# Physics / deformation stack

```
DeformableCar (car.ts): rigid pose, parts, glass, lamps, doors
  └ deform: StreamedDeformation
      masses ── shape: SHAPE_CLUSTERS → shape-match-core.js | lattice: BEAM_SPECS
      cages (8-corner FFD) ◄ solveCages · sensors ◄ pullSensorsFromMasses
      skin → body.geometry position/normal
```

## Rig tables (`src/game/kernel/rig-spec.ts`)
- `CAGES: CageSpec[]` (`name: BodyPartName, min, max, absorption, maxCrush, maxAngle`)
- `SENSORS: SensorSpec[]` (`rest, radius, part, absorption, maxCompression, neighbors`)
- `MASS_SPECS: MassSpec[]` (`name: MassName, rest, mass, radius`): the named control particles
- `BEAM_SPECS`: `[MassName, MassName, number, number, number][]` lattice springs
- `SHAPE_CLUSTERS: ShapeClusterSpec[]` (`owner, masses`): one Müller cluster per body region
- Per-style overrides: `RigOverrides` (`deform-rig.ts`), set as `CAR_STYLES[id].rig` in `car-variants.ts`.

## `StreamedDeformation` (`streamed-deform.ts`)
One class in layers, each `extends` the one before: `deform-rig.ts` `DeformRig` (fields, constructor, skin tables, `initRunState`; builders in `deform-build.ts`) →
`deform-hit.ts` (reset, mode, shape rest, kinematic bind, crush start, re-arm, impulses) → `deform-state.ts` (mass and
hub queries, drivetrain, crush weights, `update`, live hulls, debug helpers) → `deform-contact.ts` (`collideWith`,
`stepStructure`, `followGroup`, stroke, pushes, `applyImpact`) → `deform-solve.ts` (clamp, beams, shape match, mass
slices, ground, suspension) → `streamed-deform.ts` `StreamedDeformation` (sensors, cages, skin bake, netplay state).
- `constructor(geometry, rig: RigOverrides = {})`; `setMode("shape" | "lattice")` (Y key); `reset()` = `initRunState()`, the constructor's last step: every per-run field and structure (sensors, cages, masses, beams, clusters, shape particles, copied back from their as-built clone) as built, settings kept, so a reset car replays like a fresh one (`deform-reset.test.ts`, `world/race-replay.test.ts`).
- Activation / hits: `armMasses`, `applyImpact(localPoint, localInward, impulse, ebs)`, `rearmHit`, `applyImpulse`, `impulseAt`, `kickNearest`, `kickNearestHub`, `feedOverlap`, `notifyContact`, `notifyPower`.
- Rigid ↔ soft coupling: `bindKinematic`, `followGroup(group, velOut, angOut, dt)` (driven by `DeformableCar.syncPose`), `translateMasses`.
- Contacts: `collideWith(other, dt)` (mass spheres car↔car), `projectOutOfBox`, `separateAlong`, `brakeInbound`.
- `followGroup`: the frame from the masses; `aloft` once the body's middle leaves its ground band (`LIFT_OFF`), then every mass flies (`stepMassSlice`); `live()` is the contact window, after which `DeformableCar.syncPose` hands an aloft wreck whose hull is clear (`hullClear`) to `stepAir`. `armMasses` (a wreck landing or struck in flight) and `unstep(h)` (masses armed after `stepAir` already moved the body this slice step back by it).
- `stepStructure(dt)`: 1–4 sub-slices of `stepMassSlice` (`stepShapeMatch` or `stepBeams`, then `stepSuspension`, damping, settle); `rebaseShapeRest` when the contact window closes; `updateDrivetrain`.
- `update(simDt, geometry)`: while crushing → `pullSensorsFromMasses` → `bakeLocalSkin` (shape) → `solveCages` → `flushSkin` or mark `skinOwed`.
- Readouts: `crumpleTravel`, `crumpleTravelCorner`, `partCompression`, `sensorCompression`, `liveHulls`, `liveCrushHulls`, `snapshot()`.
- Flags: `massActive`, `drivetrainAlive`, `bidirectional` (compactor squeeze), `deepCrush`, `skinDeferred`, `skinOwed`.
- `killTravel`: rearward engine travel that kills the drivetrain, set per car by `CrashEngine.dressCar` from `vehicle-classes.ts` `killTravel(class, HANDLING.realism, "derby" | "default")`: a lerp from the arcade end (`ARCADE_KILL_TRAVEL` 0.55 m for a sedan) to the realistic end (`REAL_KILL_TRAVEL` 0.15 m), both scaled by class `durability` and capped at `KILL_CEILING`, × `DERBY_KILL_SCALE` in derby. `damageStage` / `drivability` turn the damage into a driving penalty (`docs/HANDLING.md`).

## Shape-match kernel (`shape-match-core.js`, façade `shape-match.ts`)
Müller 2005 meshless shape matching on `ShapeCluster`s:
`makeCluster(particles, idx)`, `matchCluster(c, particles, beta)`, `applyPlasticity(c, particles, dt, squash, buckle?)`, `resetCluster`, `rebuildAqqWeighted`, `m3Polar(A, q, R, S)` (warm-started quaternion polar), `matchSkinLocal(c, rest, local, mass, beta)`, `transformSkinPointInto`, `transformNormal`; squash knobs `stiffnessIters`, `goalAlpha`, `deformBeta`.

## Crush bands (`physics-core.js`, re-exported + Vector3 helpers in `physics-util.ts`)
- `CRASH`, `TRANSFER`; `regionSoftness(name)` → `regionCrushBands(name)` = `{ yield, middle, max }`; `forceTransfer(travel, bands, packed)`.
- `crushGate(closing, softness)`, `closingKeScale`, `crushStroke(ebs, squash)`, `cancelClosing`, `leftoverCrumple`, `satPushCap`.
- `physics-util.ts` adds `clampSpeed`, `applyGroundFriction`, `separateSphereFromBounds/FromAabb`.

## Ground (`ground.ts`)
`Ground` = height, up-normal, grip and surface at (x, z) on a layer (`STEP_UP`: a car under a bridge sees the road, a car on it the deck). `activeGround()` is read by `car.ts`, `car-drive.ts` (wheels, grip), `streamed-deform.ts`, `physics-util.ts` and `engine-marks.ts` (mark channel by surface). `RaceDirector` (`engine-race.ts`) calls `setGround` with the course's `TrackGround` and restores `FLAT_GROUND` (y = 0 asphalt, grip 1) on exit.

## Doors and mirrors
- `DeformableCar` (`car.ts`, layers `car-core.ts` `CarCore` → `car-parts.ts` `CarParts` → `DeformableCar`): `DoorHinge` per side (`doorHinge(side)`; latch, check-strap stop, slam overload), `setDoorOpen`, `loadDoorStop`, `swingDoors(dt)`, `partOff("doorL" | "doorR" | "mirrorL" | "mirrorR")`.
- `door-rig.ts`: `DoorRig` (`attach`, `fire(scenario, side)`, `phase` idle / run), `DOOR_SCENARIOS` `mirror` (A) / `overOpen` (B) / `shut` (C), `DOOR_LANES`, `RAM_DEFAULTS`; the headless shot `fireRam` is in `door-rig.test-util.ts`. The ram is a striker box run through `external-contact.ts`; `engine-doors.ts` `DoorRam` only draws it. See `docs/DOOR_RIG.md`.

## Contact
- `sat.ts`: `physicsSlice(dt, vmax)` (anti-tunnelling step), `sliceSpeed(cars)`, `satCarBarrier`, `clipCarToBarrier`, `satTwoHulls`, `satCars`; hulls from `hulls.ts` (`HULLS`, `CRUSH_HULLS`).
- `pair-contact.ts`: `resolveCarPair(carA, carB, feed, dt): PairHit | null`, `impulseCar`, `pushCar`. `world-step.ts`: `stepWorld(world, dt)`, the one fixed step (engine and every harness), and `warmCrashPath`.
- `engine-props.ts`: `JerseyBarrier.resolve/clip/blocksPair`, `resolveRampBalls`, `resolveLampPoles`, `StrongestContact`.
- `external-contact.ts`: the shared striker contact (`ContactBox`, `partContact` door/mirror colliders, `bodyContact`, `strikeEbs`, `partContactPair` car-car hook after `collideWith`); `DeformableCar.noteContactEnd` squeeze rule. `compactor.ts`: `CompactorRig` (plates as kinematic striker boxes on the parked car), `compactorStage`. `piston-rig.ts`: `PistonRig`; the shot harness (`firePiston(car, id, shot)`, `pistonLocality`, `fitRigid`) is in `piston-rig.test-util.ts`. See `docs/CONTACT_PARITY.md`.

## Skinning pipeline
```
buildSkinWeights (ctor: each vertex → ≤ RES_SLOTS nearest masses, IDW)
  → bakeLocalSkin (matchSkinLocal per cluster, SKIN_STRAIN) → refreshClusterXf
  → solveCagesFromShape / lattice cage solve → capCageCorners
  → skin(geometry): positions + wrinkle → computeNormalsFast (fast-normals.ts)
     with `skinKernel()` loaded (`skin-kernel.ts`; the Rust in `kernels/skin/`, prebuilt as `skin-kernel.wasm`): the same loop and normals in WASM on the main thread,
     bit-identical (`skin-kernel.test.ts`); cars of one style share one set of tables in its memory (`skinKey`); the JS loop stays as the reference and the fallback
flushSkin(geometry, force) writes only when owed; DeformableCar.updateSkin / flushDeferredSkin (the sim's side, `stepBreakage` -> `stepCrush`, runs per fixed step in `settleStep`);
LoD: CrashEngine.scheduleSkins / skinStride / flushVisibleSkins (cars outside `Witness`'s camera cone skip skin, tiny ones skin every 2nd/4th frame; never lose it)
```
Panels (`skinPanel`), interior, glass and detachable parts follow in `car.ts` / `car-parts.ts` (`skinPanels`, `syncAttachedParts`, `evaluateBreakage`, `detachPart`).

## Quarter panels, arches and dents
- `car-panels.ts`: `panelRegions(style, body)` cuts six `PANEL_NAMES` (`quarterL` / `quarterR`, `archFL` … `archRR`) out of the body loft's own skin, per body style. Attached, a panel is just body (no mesh, no draw, no per-frame work). At its first hinge value or tear, `openPanel` (`car-parts.ts`) builds its shell (`makeShell`: the same skinned vertices, 4 mm proud of the body, in the body's frame so the class lift and the suspension pose carry it) and turns the body's patch under it to primer (`setPrimer`: the body paint's `primer` vertex attribute, no extra draw). `poseShell` bends it away (a quarter peels about its hinge line, an arch flare flaps out and drops) and `shellPose` re-poses it only when its hinge value or the skin changes. Torn, `detachPart` hands the shell to the world (`recentre` about its middle, `layFlat` on the ground); at most `LIVE_SHELLS` (2) torn shells per car are drawn, the oldest hides and stops stepping. `closePanel` puts the panel back (hinge value back to 0, or reset).
- `loose-dent.ts`: every bounce of a torn part that changes its velocity by ≥ `DENT_MIN_DV` (1.8 m/s) is recorded in the part's frame (`recordDent`: contact normal and depth, at most `DENT_MAX` = 4 per part), a pure function of the part's motion, so a replay dents identically. `applyDents` carves the recorded dents into the mesh each step and `clearDents` resets them. Output-only: nothing in the sim reads it.

## Debug views
- G `DeformRigHelper` (`deform-helper.ts`: cages, sensors, masses) + hull lines (`car-core.ts` hull overlay, `car.ts` `setRigVisible`); P `DeformParticleHelper` (size = mass, colour = plastic travel / contact, shape-match pull); Y shape ↔ lattice. Both views also draw the thrown-driver dummies (`present/ragdoll-debug.ts` `RagdollDebug`: limb boxes and joint lines for Rig, a mass-sized dot per limb for Particles; `engine-ragdoll.ts` builds it, `resetDefaults` / the toggles feed it through `ragdolls.debug.set`).

## Load crush
- `deform/load-crush.ts`: the five faces' strength laws (`faceStrength(face, d)` in car weights, `faceMax`, `faceFollow`); `DeformRig.crush` (m per face, typed array: not in `simState`), `bakeLoadCrush` (masses + one re-skin, `loadDirty`), `offsetByCrush`.
- `vehicle/car-surfaces.ts`: `CarSurfaces`, the `Ground` `stepAir` stands on (world ground + other cars' tops, a flattened roof plate on a 0.1 m grid) and the per-slice face budgets (`take`, `note`, `commit`, `press`); `stepWorld` owns one (`World.surfaces`, `car.surfaces`, `car.restsOn`).
- `vehicle/car-air.ts` `stepAir`: body points and belly points meet it; a face's contact impulse is capped (`take`), its penetration becomes depth (`commit`); `nearContact` / `CONTACT_HZ` make `stepWorld` solve such a step at 480 Hz. `contact/sat.ts` `shareHeight`: `restsOn` and `STACK_CLEAR` keep a stacked pair out of the plan SAT. See `docs/LOAD_CRUSH.md`; debug: `window.__crush.dropStack(n)`.

## Related
`docs/RIG_ANALYSIS.md` (rig vs real structure), `docs/CRUSH_CALIBRATION.md` (squash/buckle), `docs/PISTON_RIG.md`, `docs/PARTICLE_LOD_SPEC.md` (fine-patch LoD: gate failed, not built), `.extraResearch/SYNTHESIS.md`, [architecture.md](architecture.md), [testing.md](testing.md)
