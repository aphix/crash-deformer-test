<!-- Generated: 2026-10-02 | Files scanned: 18 | Token estimate: ~1700 -->
# Physics / deformation stack

```
DeformableCar (car.ts): rigid pose, parts, glass, lamps, doors
  └ deform: StreamedDeformation
      masses ── shape: SHAPE_CLUSTERS → shape-match-core.js | lattice: BEAM_SPECS
      cages (8-corner FFD) ◄ solveCages · sensors ◄ pullSensorsFromMasses
      skin → body.geometry position/normal
```

## Rig tables (`src/game/rig-spec.ts`)
- `CAGES: CageSpec[]` (`name: BodyPartName, min, max, absorption, maxCrush, maxAngle`)
- `SENSORS: SensorSpec[]` (`rest, radius, part, absorption, maxCompression, neighbors`)
- `MASS_SPECS: MassSpec[]` (`name: MassName, rest, mass, radius`): the named control particles
- `BEAM_SPECS`: `[MassName, MassName, number, number, number][]` lattice springs
- `SHAPE_CLUSTERS: ShapeClusterSpec[]` (`owner, masses`): one Müller cluster per body region
- Per-style overrides: `RigOverrides` (`streamed-deform.ts`), set as `CAR_STYLES[id].rig` in `car-variants.ts`.

## `StreamedDeformation` (`streamed-deform.ts`)
- `constructor(geometry, rig: RigOverrides = {})`; `setMode("shape" | "lattice")` (Y key); `reset()`.
- Activation / hits: `armMasses`, `applyImpact(localPoint, localInward, impulse, ebs)`, `rearmHit`, `applyImpulse`, `impulseAt`, `kickNearest`, `kickNearestHub`, `feedOverlap`, `notifyContact`, `notifyPower`.
- Rigid ↔ soft coupling: `bindKinematic`, `followGroup(group, velOut, angOut, dt)` (driven by `DeformableCar.syncPose`), `translateMasses`.
- Contacts: `collideWith(other, dt)` (mass spheres car↔car), `projectOutOfBox`, `separateAlong`, `brakeInbound`.
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
- `DeformableCar` (`car.ts`): `DoorHinge` per side (`doorHinge(side)`; latch, check-strap stop, slam overload), `setDoorOpen`, `loadDoorStop`, `swingDoors(dt)`, `partOff("doorL" | "doorR" | "mirrorL" | "mirrorR")`.
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
flushSkin(geometry, force) writes only when owed; DeformableCar.updateDeform / flushDeferredSkin;
LoD: CrashEngine.scheduleSkins / skinStride / flushVisibleSkins (off-screen or tiny cars skip skin, never lose it)
```
Panels (`skinPanel`), interior, glass and detachable parts follow in `car.ts` (`skinPanels`, `syncAttachedParts`, `evaluateBreakage`, `detachPart`).

## Debug views
- G `DeformRigHelper` (`deform-helper.ts`: cages, sensors, masses) + hull lines (`car.ts` `setRigVisible`); P `DeformParticleHelper` (size = mass, colour = plastic travel / contact, shape-match pull); Y shape ↔ lattice.

## Related
`docs/RIG_ANALYSIS.md` (rig vs real structure), `docs/CRUSH_CALIBRATION.md` (squash/buckle), `docs/PISTON_RIG.md`, `docs/PARTICLE_LOD_SPEC.md` (fine-patch LoD: gate failed, not built), `.extraResearch/SYNTHESIS.md`, [architecture.md](architecture.md), [testing.md](testing.md)
