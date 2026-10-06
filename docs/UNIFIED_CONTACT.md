# One contact model: design, measured baseline, migration (lane RampGround-2, main b4c1a97)

Owner (10-05): "cars get 1 collision mesh, and it's what you see, cars/ramps/props/ground/world must all interact with each other in one uniform way"; "the current design is too split-brained and flawed to remain the core method". Acceptance is **equivalence**: the same physical situation built from different kinds of object gives the same result. Nothing below is built; every number is a run on main b4c1a97 unless marked [INFERENCE]. Harness: `.bench/rg/` (git-ignored; commands at the end).

## 0. Verdict

- Route (a), our own uniform contact model, staged. Route (b), Rapier for all rigid contact, is rejected on the owner's own criterion: it detects, it does not respond, so it closes none of the press/piston/door/ramp gaps, and a shape that tracks the drawn body costs 0.79-2.9 ms/slice at 32 cars (section 3) against a whole-step budget of ~1.2-2.1 ms.
- No small root fix exists for the ramp symptoms (section 1.1: three single-rule ablations, each moves the failure to the next special case). Do not patch; build Stage 1.
- First: Stage 0 (the failing-first equivalence tests, no behaviour change), then Stage 1 (per-wheel contact on one query, `airborne` derived from it).

## 1. Baseline on main: how far apart the "same situation" results are

### 1.1 Owner ramp cases (fleet scene, sedan, steer 0, throttle holds speed, approach angle th to the wedge axis, centreline crosses the toe e m inside its -x edge; 32 cells: th 0/15/30/45 x e -0.8..0.6, 1-2 wheels on the wedge, none aimed at a wall)

`.bench/rg/ramp-angles.ts sweep <v>`; failure = any of: lateral shove (position correction beyond velocity x dt, on slices with a ramp contact hit) > 5 cm; body yaw drift > 3 deg; velocity heading change > 3 deg; roll > 25 deg; flagged `airborne` while >= 2 wheels touch (tread gap < 3 cm).

| v m/s | cells failing | shove > 5 cm (max) | aloft with >= 2 wheels touching | yaw > 3 deg (max) | vel heading > 3 deg (max) | roll > 25 deg (max) |
|---|---|---|---|---|---|---|
| 8 | 29/32 | 28 (1.26 m) | 7 | 5 (12.2) | 7 (8.2) | 2 (61.8) |
| 12 | 29/32 | 26 (1.02 m) | 9 | 9 (7.8) | 6 (4.4) | 1 (32.8) |
| 20 | 29/32 | 29 (1.17 m) | 9 | 2 (5.1) | 1 (3.7) | 8 (42.1) |

The owner's own trace (`owner-trace.json.md`, th 1.85 deg, e -0.01, 12 m/s): `x` -1.459 -> -2.376 in 0.072 s (v_x only -0.4 m/s), yaw constant 181.85 deg, speed 11.07 -> 12.13. Reproduced headless (th 1.85, e -0.014): `FleetRamps.contact` shoves the car 0.05-0.15 m per slice for 14 slices, x -1.46 -> -2.38 (0.9 m).

Mechanisms, attributed by counting which probe sets `FleetRamps.pen` over the 32 cells at 12 m/s (`who-tally.ts`; sum of per-hit pen, 67.8 m):

| mechanism | where | share | evidence |
|---|---|---|---|
| M1 hull/underside/bumper points called "wall" because they are > `SKIN` 0.2 under the face while the car's height is the ground's under its origin; the way out is chosen sideways (0.75 m) though upward is 0.21 m | fleet-ramps.ts:178-180,206 (`onFace` kerb 0.2, reach 0) | 54.6 m (81%) | repro of the owner trace: bumper corner local (-0.80, 0.05, 2.00), world y 0.05, face 0.26 there, pen 0.754 |
| M2 tyre plan corners, `MOUNT` kerb | :172-176 | 8.7 m | same tally |
| M3 footprint corners at the floor, `CLIMB` kerb | :171 (`WALL_PROBES`, pair-contact.ts:70) | 4.5 m | same tally |
| M4 support plane is per car/axle, not per wheel; the axle may ride only `AXLE_STEP` 0.1 above its lower tyre, so with one tyre on the wedge the support stops rising while the body carries the climb speed, `pos.y > gy + droop` and the car **takes off with 3 wheels touching**; `stepAir` then has no drive, no steer and tyre grip only across the tread | car-support.ts:220,231-238; car.ts:406; car-drive.ts:193; car-air.ts:316-324 | 9/32 cells go aloft at 12 m/s | trace 12/0/+0.4: t 0.817 `y` 0.118 vs `gy` 0.050 + droop 0.065, surf `R-GG`, then yaw -7.4 deg, roll -12.7 deg, pitch 16 deg with 1-2 wheels on the wedge |
| M5 `settle()`: 39 samples, brute-force triple search for the rest plane, only to repair M4 and M1 | car-support.ts:121-155 | 70.8 us per call on a ramp edge, 0.6 us flat; called twice per slice below 6 m/s | micro.ts |

Ablations (temporary edit in the worktree, reverted; or a prototype patch in the bench), 12 m/s, same 32 cells:

| change | shove > 5 cm | aloft >= 2 wheels | yaw > 3 deg | vel heading > 3 deg | roll > 25 deg |
|---|---|---|---|---|---|
| main | 26 | 9 | 9 | 6 | 1 |
| `AXLE_STEP` 0.1 -> 10 | 23 | 6 | 3 | 6 | 1 (40.3 deg) |
| min-penetration wall rule for hull probes only | 26 | 11 | 10 | 8 | 6 |
| min-penetration wall rule for every probe | 32 | 10 | 7 | 4 | 4 |

Each rule moves the failure to the next special case (hull points 54.6 -> 10.7 m, tyre+footprint 13.2 -> 21.8 m; shove cells unchanged). `AXLE_STEP` is the monster's side-roll fix (its comment: 0.1 gives 0 of 420 rolled runs, 0.3 gives 33), lifting it brings that back. This is the "everyone adding special cases" the owner describes, measured.

### 1.2 Stack: top car cannot drive

`.bench/rg/stack-drive.ts 2 top`, `platform-drive.ts`: two cars, the top one settled on the base car's roof for 8 s, throttle 1.0 for 4 s.

| run | airborne | airContact | speed at 0.5 / 1.0 / 1.5 s | drive throttle read back |
|---|---|---|---|---|
| top car on the roof | true, all 4 s | true | 0.00 / 0.00 / 0.00 | 0.00 |
| same car on a flat `Ground` at the same height 1.175 m, grip 1 | false | - | 7.56 / 14.32 / 18.87 | 1.00 |

Mechanism: a grounded car only ever reads `activeGround()` (car.ts:388-471); another car's top exists as a surface only inside `stepAir` (car-air.ts:245, `CarSurfaces`). The top car is therefore "airborne" for good (landing gate reads the world ground 1.2 m below), `applyDrive` returns `idleDriveState` for `car.airborne` (car-drive.ts:193), and in `stepAir` a tyre on a roof grips both ways but is never driven (car-air.ts:312-324).

### 1.3 Press / piston / door (contact-parity.test.ts; tolerance per particle 15 % or 10 mm, hubs excluded, 16 particles; also parts off, drivetrain, cabin)

`.bench/rg/parity/`. Sandwich = two 858 kg cars into a parked one at kph each; press closed to the same shortening.

| sandwich kph | middle car shorten/nose/tail/cabin mm | press (same shortening) | worst particle ratio | particles outside |
|---|---|---|---|---|
| 10 | 63/46/17/4 | 80/51/29/1 | 2.42 engineL | 10 |
| 20 | 108/81/26/5 | 117/67/50/2 | 3.26 engineL | 5 (engineL/R 23/75, tank 21/37, wingFL/FR 33/49) |
| 30 | 152/123/29/5 | 153/83/70/2 | 3.08 | 5 |
| 40 | 196/165/30/5 | 208/106/102/4 | 3.61 | 8 |
| 60 | 267/255/12/1 | 281/137/144/7 | 12.0 roof | 10 |

Matched on energy instead, the press cannot reach it from 20 km/h: it stops at `COMPACTOR.maxFace` 0.62 with 9.2 kJ of plate work against shares of 10.1-79 kJ; at matched travel the plates do 313-839 J, 1-12 % of the share. A force-matched press needs a plate mode that does not exist (plates are kinematic, 0.55 m/s, kg Infinity, no force target).

| piston vs car (hardness 0.5) | 10 | 20 | 30 | 40 | 60 km/h |
|---|---|---|---|---|---|
| squash 0.4 / 0.32 within tolerance | N / N | N / N | Y / Y | Y / Y | N / N |
| particles outside (0.4) | 5 | 5 | 0 | 0 | 8 |

Hardness 1.0 fails everywhere (parts and cabin differ). Doors: all six cells (3 scenarios x 12, 30 km/h) identical today and must stay so. Mechanisms (code reading, not ablated): press runs `bidirectional` so the crush gate and engine back-pack are off (deform-contact.ts:776,779; deform-solve.ts:76-79); the press has no EBS budget (work is a readout); car-car keeps the fixed-face kill and the sphere-contact path (pair-contact.ts:273-279,305-307); piston EBS is 1/2 mu v^2 x hardness through a slab (piston-rig.ts:274-283); a second hit is refused for 0.3 s (deform-hit.ts:361).

### 1.4 Car-built road, ramp, corkscrew (the owner's "road made of cars" case)

`.bench/rg/CarRoadBaseline/`. Flattest car: `crush[TOP]` 0.45 m (the packed limit) = roof crown 0.894 m. Road = 4 such cars end to end, held static, vs a flat strip of height 0.894.

| run | speed kept | y max | driven car crashed | stops at |
|---|---|---|---|---|
| strip, 8/12/20/28 m/s | 92-98 % (7.85, 11.04, 19.46, 27.22) | 0.894 | never | passes |
| 4 held cars, same speeds | 0-2 % (0.19 m/s) | 0.00-0.08 | after 25-90 frames | z -1.8..-1.3, nose crushed 0.145-0.458 m, parked tail 0.10-0.32 m |
| wedge (real) @8/12 | 7.79 / 11.72 m/s | 1.39 / 1.64 | never | passes, 17-20 air frames, 0.28-0.33 s |
| cars posed into the wedge silhouette | 0.19 / 0.12 m/s | 0.00 | yes | z -8.1 / -8.0 |
| corkscrew (real) @6..27 | flies/rolls 182-581 deg | - | - | - |
| cars shaped to the curve | stops at z -35.6..-36 | 0 | yes | wheels, no air |

Mechanism: a driven car meets a parked flat car through `shareHeight` + SAT crush hulls (sat.ts:75, world-step.ts:136-181) as a head-on crash; the parked car's top is never read. `CarSurfaces` as a ground (the "prof" control) is unstable (cell steps 0.4 m, NaN past the plan, UPRIGHT 0.5 cliff): it is not a surface a wheel can drive on yet. The wedge cannot be built from whole 0.9 m cars at 14.6 deg (best fit 0.21 m error, not buildable): the test needs cars shaped to the profile (masses placed), a rig that does not exist.

### 1.5 The separate colliders a car has today (StackProfile audit, `local://stack-profile-audit.md`)

12 with no common source, none reads the drawn mesh: plain SAT hulls (rest constants while not `massActive`, 0.60 m short of nose/tail), crush hulls (follow masses only while `massActive`; a bumper detach retracts the nose 0.30 m inside the drawn nose), CAR_HALF box + wall footprint (0.95 x 2.3; head-on phantom +0.45/+0.55 m), ragdoll cabin box (monster 0.50 m under the drawn roof), mass spheres (protrude 0.42 m, monster 0.80 m), tyre rectangles, `HULL`/`BELLY` points (45, stock corners), `CarSurfaces` plate (follows only `crush[TOP]`, sinks 2-3x more than the skin; pickup bed solid at 0.92 vs drawn 0.52), `support`/`axleGround`/`settle` (39 samples), door/mirror `ContactBox` cylinders, rig `ContactBox` slabs, the world `Ground`. Class lift (monster 0.48) moves only belly and plate.

## 2. Route (a): the model

One query, one response, for every object.

1. **`Solid`**: anything a body can touch answers `contact(p, probeVelocity, out)`: signed depth, unit normal, friction, surface velocity, owner. Terrain, a ramp, a prop, a wall, a press plate, a piston head, a door and a car are all `Solid`s. Statics are analytic (the fleet wedge is a plane + two vertical faces; props are boxes; terrain is the existing `heightAt`). The normal comes from the geometry (nearest way out, taken from the surface normal and the point's approach velocity), never from "height above the car's origin".
2. **A car is a `Solid` made of what you see**: a cage of ~100 vertices skinned from the 20 masses with the drawn mesh's own weights (so it follows crush, detached bumpers and lift, with no `massActive` switch), ~150-330 triangles, rasterised to a top and a bottom height field plus a plan distance field on a 10 cm grid **in the car's own frame**. A pristine car's fields are cached per style; a car is re-rasterised only on slices where its masses moved. Solid between bottom and top, so a bed, a roof and a wheel arch are what the skin says. Overhang inside the body (cabin cavity) is filled: acceptable, nothing drives in it.
3. **Wheels are contacts like any other**: per wheel, 7 tread samples (existing `TREAD`) ask the one query. A wheel gets load from its own contact (spring `SUPPORT` budget as in `stepAir`), traction from `mu_surface x load`, steer and drive from `applyDrive` split per wheel (the arcade model is already per axle: `gripUnder` x2, `wheelsOnMask`; this makes it per wheel). A roof, a ramp and the road differ only in the answer `contact` gives.
4. **`airborne` is derived**: zero wheels and zero hull points in contact. `takeOff`, `land`, `landPose`, `LIFT_OFF`, `UPRIGHT`, the landing gate and `airContact` disappear as state; replay/net keep a `flight` bit that is now computed, not stored (REPLAY/NET bump).
5. **One integrator**: the rigid-contact solve `stepAir` already is (2.0 us per car-slice measured, section 6), run for every non-wreck car. With >= 3 wheels touching on a smooth surface it reduces to the current pose-following plane (the exact no-creep behaviour `WheelGround` needed), with 1-2 wheels the free DOFs integrate under the same wheel contacts, with 0 it is flight. No mode switch: the constraint set is what changes.
6. **One response**: `bodyContact(car, solid)` for everything. Rigs (press, piston, door ram) become kinematic `Solid`s with a mass/hardness/force profile, and car-car takes the same path (a car is a `Solid` with a mass and the crush hardness of its face). The sphere-contact path (`collideWith`/`feedOverlap`), the SAT crush hulls, `ContactBox` variants and `bidirectional` are deleted at Stage 4, not before.

## 3. Route (b): one Rapier world (0.19.3) for rigid contact: what it costs

Rapier detects; our response, crush and drive stay. Dynamic bodies need convex shapes, so a crushed car is a refit set of convex pieces. `.bench/rg/rapier/hull-cost.ts`: 45 real points per car (20 `mass.local` + 25 drawn vertices), synthetic 0.12-0.15 m sinusoidal crush, 300x300 m ground, 4 wedges, 20 props, 200 walls, 6 variants interleaved in one process, 600 slices after 200 warm-up, box load average 5.3-8.1 (ratios are the robust figure).

| variant | N=10 ms/slice (med/p95) | N=32 ms/slice (med/p95) | ratio to 1 cuboid | garbage KB/slice (free / pile) | what it is |
|---|---|---|---|---|---|
| A 1 cuboid | 0.040/0.060 | 0.081/0.130 | 1x | 3.6 / 27 | what the old eval measured |
| B 5 cuboids refit (our crush hulls) | 0.109/0.169 | 0.267/0.465 | 3.3x | 54 / 153 | the same shape split-brain as today |
| C convex hull rebuilt (create+remove collider) | 0.404/0.594 | 1.157/1.840 | 14x | 60 / 79 | |
| D `setShape` on a convex hull | 0.269/0.412 | 0.791/1.284 | 9.8x | 11 / 31 | single convex: bed and nose cavity lost |
| E5 5 convex pieces | 0.679/0.912 | 2.106/3.317 | 26x | 59 / 191 | |
| E8 8 convex pieces | 0.910/1.327 | 2.856/4.590 | 35x | 90 / 110 | |
| quickhull of 45 points alone (JS) | 0.107 | 0.369 | - | - | 0.0115 ms per car |

32 cars in a tight 10x10 m pile: A 0.317, B 1.017, C 2.189, D 1.721, E5 5.359, E8 8.678 ms/slice (p95 13.1 for E8). At the 240 Hz contact slicing multiply by 4 per frame; phone (x4 CPU) numbers are [INFERENCE] = ms x 4. Earlier eval (0.21.0, `RAPIER_EVAL.md:22-27,117,133-165`): wheel/ground rays 0.926/6.328 ms vs ours 0.060/0.201 per frame at 10/32 cars (castRay 1.1-1.4 us vs 0.24-0.27 us), walls+props 0.519/1.505 vs 0.059/0.286, `castShape` tyre stop 1.81/5.78 ms vs 0.034/0.116, heightfield build 66-150 ms, 0.19.3 download 618 kB over the wire; production use is the cosmetic ragdoll only, loader rule: one module, one version, no snapshots (`lane-updates.md`).

Determinism (same machine, `determinism.mjs` + `hull-cost.ts det`): every variant gave identical digests run to run and across two processes; `takeSnapshot`/`restoreSnapshot` diverge on 0.19.3 (not used); cross-machine (x64 vs ARM) **not measured**. Netplay is host-authoritative so only the host needs it, but the digest rule in `lane-updates.md` (anything feeding the sim must be bit-identical and validated against replays) would have to be proven for a wasm world that is not in any replay keyframe.

## 4. (a) against (b)

| criterion | (a) own model | (b) Rapier |
|---|---|---|
| E1 owner ramp cases, E2 stack drive | wheel contact on `Solid` answers; closes both | wheels would still need our rays (4.5-15x slower measured) or Rapier's raycast vehicle (the old eval: creeps 2.4-13 cm in 3 s, 6-30 cm in 10 s) |
| E3 press, E4 piston, E5 door (response) | closes: one `bodyContact` path | closes none: detection is not where they differ (`CONTACT_PARITY.md`: EBS, `bidirectional`, sphere vs slab) |
| E6/E7 car as road, ramp, corkscrew | the cage is the body; fields follow crush | boxes (B) = today's shapes; faithful shape needs D/E at 0.79-2.9 ms/slice @32 |
| shape you see | cage skinned from the drawn mesh | convex fit of it, concavities lost (D) or 5-8 pieces (E) |
| cost @ derby-32, one slice | section 6: ~0.1 ms steady, ~0.2-0.3 ms while 8 cars deform [INFERENCE from micro] | B 0.27, D 0.79, E5 2.1 ms plus contact reads 23-153 KB/slice garbage |
| allocation | none (typed arrays, as `stepAir`, pinned by `physics-alloc.test.ts`) | 11-90 KB/slice refit, 23-153 KB pair reads |
| determinism | same code and doubles as now; REPLAY/NET bump per stage | same-machine proven, cross-machine unknown |
| code deleted | `support`, `axleGround`, `settle` (brute force), `landPose`, `hullClear`, `fromSide`, `takeOff/land/LIFT_OFF`, FleetRamps/props/walls probes, plate, SAT hulls, spheres, ContactBox variants | none: our ground, response, crush stay, a second world is added |
| risk | big: replaces the ground integrator and the pair path; calibration, ejection matrix, solid parity, replay all move | smaller change, but it does not remove the split brain |

## 5. Staged migration (each stage: one lane, own REPLAY/NET bump, calibration re-run)

Gates re-run per stage: crash calibration (`npm run sweep`, `CRUSH_CALIBRATION.md:466-473`), `vehicle/ejection-matrix`, `ejection-slope`, `world/solid-parity`, `engine/replay-fidelity`, `world/race-replay`, `contact/physics-alloc`, `slice-budget`, `pair-hook`, the ground-fit drop matrix, fleet-ramps D1/D2, wreck-slope, stack tests, net tests, `engine-bench` headless 10/24/32.

| stage | change | deletes | equivalences closed (tolerance) | notes |
|---|---|---|---|---|
| 0 | the failing-first tests of section 7 in `contact-parity.test.ts` / `fleet-ramps.test.ts` / stack tests, plus the rigs they need: `shapeCar(profile)` (masses placed to a profile), `holdStatic`, a force-profile plate mode, a rear/side `pistonFront` twin; the two `todo: PENDING` cases lose their `todo` | - | none yet: each test is red only until the stage's own commit makes it green in the same lane, never parked as `todo` or counted in an allowlist (owner rule) | no behaviour change |
| 1 | per-wheel contact on the one query (world ground + other cars' tops through `CarSurfaces`); wheels give load and traction, `applyDrive` per wheel; `airborne` derived; `takeOff/land` and the support/settle machinery replaced by the single contact solve; `FleetRamps.contact` probes by contact normal | `support` per-car scalar, `axleGround` + `AXLE_STEP`, `settle` (39 samples, 70.8 us on features), `landPose`, `hullClear`, `fromSide`, `LIFT_OFF`/`UPRIGHT` as car state, M1-M3 probe rules in fleet-ramps | **E1**: unsteered yaw <= 1.0 deg, velocity heading <= 1.0 deg, shove <= 1 cm, per-slice dv <= 0.3 m/s (slope gives 0.04), pitch/roll within 1.5 deg of the touching wheels' plane, `airborne` only when all four tread gaps > 3 cm; 0/32 failing at 8, 12, 20 m/s. **E2**: speed within 5 % of the flat-platform run at 0.5/1.0/1.5 s (7.56/14.32/18.87 m/s). D1 stuck cars (15 alive, 0 m in 3 s). ground-fit KNOWN_RAMPS 14 cells | closes the owner's immediate symptoms; REPLAY bump (flight keyframes change meaning) |
| 2 | statics as `Solid`: ramps, props, walls, terrain on one `contact`; wheel/hull/footprint rules replaced by normals | `FleetRamps.contact`, `WALL_PROBES`, prop-contact footprints, `onFace` kerbs (`CLIMB`/`MOUNT`/`SKIN`) | solid parity (existing bars: slab 8 and 55 m/s, 2nd hit, health within 0.2); E1 cells that do meet a wall behave as the slab | touches WallRegress2's prop/wall contact: coordinate |
| 3 | car = cage + 2.5D fields (section 2.2); wheels and hull ride other cars through the same query; cars' tops replace the plate | plate/`bodyTopY`, plain SAT hulls, CAR_HALF boxes, wall footprint, ragdoll proxy boxes (fed from the cage), `shareHeight` crown test (StackProfile's `standsOn` depth rule carries over) | **E6** car-road: end speed within 5 % of the strip (strip 7.85/11.04/19.46/27.22), y max within 0.05 m of 0.894, yaw <= 1 deg, driven car never `crashed`; **E7** wedge and corkscrew: gain within 0.1 m of 1.2 m, airtime within 0.1 s of 0.28-0.33 s, landing within 0.5 m, wheel-surface sequence equal | needs `shapeCar` from stage 0; StackProfile owns the top plate until here |
| 4 | one response: rigs become kinematic `Solid`s with mass/hardness/force; car-car through `bodyContact` | sphere contact (`collideWith`/`feedOverlap`), `ContactBox` variants, rig slabs `projectOutOfBox`, `bidirectional` and the fixed-face kill, crush hulls | **E3** sandwich 10-60 km/h and **E4** piston h0.5 10-60 km/h at squash 0.4/0.32: every particle within 15 % or 10 mm, parts off and drivetrain equal; **E5** doors still identical | the largest calibration risk (CrashRealism territory); can run in parallel with 1-3 as its own lane since its gaps (M1-M5 of 1.3) do not touch wheels |
| 5 | delete leftovers, re-calibrate | `CRUSH_HULLS`, `hulls.ts`, `HULL`/`BELLY` stock points | all of the above stay green | |

## 6. Per-step cost

Measured (node, this box, load 5-8; `micro.ts`, `raster-micro.mjs`): `heightAt` on the ramps 0.022 us, `support()` 0.14 us, `settle()` 0.6 us flat / **70.8 us on a ramp edge** (twice per slice below 6 m/s), `stepAir` 2.0 us per car-slice (45 points, 4 passes, no allocation). Cage: refit 96 vertices from masses 1.0-1.2 us; raster of 154 triangles into top+bottom 10 cm fields 26 us (73.6 us at 5 cm; 35 us for 330 triangles); 45 probe points against a field 0.9 us. Whole-step context (PERF_BENCH.md headless): fleet-32 1.97 ms p50 (p95 15.06), derby-24 3.48 ms p50; pair SAT loops at derby-32 2.607 ms/frame (`RAPIER_EVAL.md:136-137`).

| stage | added / removed per car-slice | derby-32 per 60 Hz frame (1 slice; x4 at contact slicing) | phone (x4) [INFERENCE] |
|---|---|---|---|
| 1 | + one contact pass (~2 us measured); - `settle` (0.6-141 us), - `support`/axle samples | + 0.06 ms (+0.26 at 4 slices); minus the settle spikes on any car on a feature | + 0.26 ms (+1.0) |
| 2 | probes for statics ~1 us per car (as the fleet ramps' 31 points now) | ~0 | ~0 |
| 3 | cache hit for pristine cars; re-raster 26 us only for cars whose masses moved (about 8 of 32 in a pile); 0.9 us x2 per overlapping pair; - SAT hull pairs (2.6 ms/frame at derby-32) | + 0.21 ms per slice with 8 deforming, - up to 2.6 ms of SAT: net negative [INFERENCE until built] | + 0.8 ms, - 10 ms |
| 4 | deletes the sphere path (`collideWith`) and `pushPair`/`followGroup`, the largest items of the pair step in `OFFLOAD_PLAN.md`'s profile | negative [INFERENCE] | negative |

Rule check: all typed-array loops, no `.push`, `forEach`, `arguments`, allocation in the step; hot code plain JS; measured per stage with `engine-bench` headless 10/24/32 and the browser `?bench=city` at 4x throttle through the heavy slot before a stage merges.

## 7. Acceptance tests (failing first; given/when/then text; no `todo`, no allowlists)

1. **Ramp, any angle**: given a sedan at 8, 12 and 20 m/s, steer 0, at 0/15/30/45 deg and offsets putting 1, 2, 3 wheels on the wedge, when it crosses the wedge's toe, then yaw changes <= 1.0 deg, velocity heading <= 1.0 deg, no frame moves the car sideways by more than 1 cm beyond its velocity, no frame changes speed by more than 0.3 m/s, pitch and roll stay within 1.5 deg of the plane through its touching wheels, and `airborne` is true only while all four tread gaps exceed 3 cm. (Cell list: `.bench/rg/ramp-angles.ts`.)
2. **Stack**: given a car resting with its wheels on another car's roof, when it drives at throttle 1, then its speed at 0.5/1.0/1.5 s is within 5 % of the same car on a flat ground of equal height and grip.
3. **Press = two cars**: sandwich vs press at 10, 20, 30, 40, 60 km/h, tolerance of `contact-parity.test.ts` (`sameParts`, `sameCrush`), the `todo` removed. Needs the press to take a force profile (stage 0 rig).
4. **Piston = car**: h 0.5, 10-60 km/h, squash 0.4 and 0.32, tolerance as above; includes the `piston-rig` `front:kill-ebs` case (EBS in (56, 64] km/h).
5. **Door = car**: the six cells stay identical.
6. **Car road = road**: four held crushed cars (crush[TOP] 0.45, crown 0.894) vs a strip of height 0.894, 8/12/20/28 m/s: speed kept within 5 %, y within 0.05 m, yaw <= 1 deg, wheel-surface sequence equal, driven car never crashed.
7. **Car ramp = wedge and corkscrew**: cars shaped to the wedge profile (`shapeCar`) and to the corkscrew curve vs the real ones: gain within 0.1 m, airtime within 0.1 s, landing within 0.5 m, heading and wheel contacts equal.
8. **Any other pair**: ground, prop, wall, car delivering the same surface and force give the same contact and response (the generic `Solid` conformance table).

## 8. Not measured, and what is missing

- Cross-machine determinism of any Rapier route; 4x phone throttle of anything here (x4 is an inference); 0.19.3 numbers for the 32-car hull replay (the old harness measured 0.21.0 and the new micro-bench is synthetic crush, not a real crash trace).
- The cage's fidelity against the drawn skin (tolerance target: <= `SKIN` 0.2 m, ideally 5 cm as in StackProfile's audit) and its cost on a real crash are built-and-measured in Stage 3; the 26 us raster figure is a representative micro-bench, not production code.
- Stage 1 feasibility is design, not measurement: the free-DOF solve with 1-2 wheels touching (no creep at rest, the bank 21/21 `WheelGround` bar, arcade handling feel, since `applyDrive` is velocity-based) must reproduce what the pose-following branch gives exactly. Its first judge is the ground-fit drop matrix, `ramp.test.ts`, `bank-wheels.test.ts` and `edge-fall.test.ts` going green with the old branch deleted, not a prototype beside it.
- The wedge from cars needs a `shapeCar` rig (whole 0.9 m cars cannot make a 1.2 m wedge at 14.6 deg: best non-buildable fit 0.21 m).
- Sandwich force profile: no per-slice plate force or car-car impulse is read out by the existing rigs.
- Process note: while doing the `AXLE_STEP` ablation one edit went to `/mnt/c/proj/crash-deformer-test/src/game/vehicle/car-support.ts` (relative path, main checkout) for about 3 minutes, was reverted from the same tool, and `git status` there is clean.

## 9. Reproduce

All under `the RampGround scratch directory`, one process at a time: `flock .bench/rg.lock env CAP=4G capped node --experimental-strip-types <file>`.
`.bench/rg/ramp-angles.ts sweep 8|12|20` (sweep-*.tsv), `ramp-angles.ts trace <v> <th> <e>`, `who-tally.ts x 12 [minpen]`, `ablate.ts x base|minpen <v> [all]`, `stack-drive.ts 2 top|bottom`, `platform-drive.ts 1.175`, `micro.ts`, `raster-micro.mjs` (env V, T, CELL), `parity/run.ts sand|piston|door`, `CarRoadBaseline/{flat,road,ramp,cork}.ts`, `rapier/hull-cost.ts time|garbage|det|quickhull`.

## 10. Stage 1 census: every "what is under this wheel / is it in the air" answer, and the one surface store (lane UC1Wheels, main 5ad7839)

Read by `git grep` over `src/` (non-test) for `airborne|aloft|airContact|restsOn|nearContact|stepAir|hullClear|landPose|axleGround|AXLE_STEP|fromSide|takeOff|support(|settle(|heightAt|normalAt|frictionAt|surfaceAt|activeGround|floorUnder|gripUnder|wheelsOnMask|HUB_FLOOR|LIFT_OFF|STEP_UP|NO_FLOOR|FLAT_GROUND|DISC_GROUND|grounded|flying`, plus `pos.y = 0`-style clamps: 382 + 180 + 45 hits in 58 files, each family below. "Fakes" = an answer that is not the surface's own (an invisible plane, a clamp, a kerb that depends on who asks, "pretend landed"). Fate: **Q** = becomes a caller of the one query, **D** = deleted.

### 10.1 Decision: they do not share "ground", they share a solid surface

Track, ramps, corkscrew, props, a car's roof and a crushed body all answer the same thing: *at this point, where is the surface, which way does it face, how grippy is it, and whose is it.* "Ground" is the name of one scene's static set of them (what `setGround` loads); a roof is not ground, and today it pretends to be (`CarSurfaces implements Ground`, whose `heightAt` writes `owner/follow` for the `normalAt` that must follow it). So:

- **`Surface`** (`world/surfaces.ts`): the base class every surface extends. It holds no query. A subclass supplies *plain data* (a height patch: a frame, a node grid in typed arrays, optional crease/lateral arrays and a surface-id array) and registers it; nothing else.
- **One store**, two parts. *Static*: patches registered once per scene (track terrain + bridge decks, ramp faces, the slab's top, the corkscrew floor, the flat pad and the fleet disc), one uniform spatial index built at registration, never touched in the step. *Dynamic*: preallocated per-car slots (frame matrix, node heights) rewritten in place each slice by the car (`CarTop extends Surface`), no reallocation, no re-index (a slot is a fixed entry; its world box is rewritten with it).
- **One pure function** `wheelContact(x, z, y, out)` over typed arrays (no `this`, no virtual call, no allocation): the highest surface at most `STEP_UP` above the asking point, its height, unit normal, grip, surface id and owner (-1 world, else car index). `heightAt`/`normalAt`/`frictionAt`/`surfaceAt` stay as the thin point-query names the 50 callers use, each one call of that function. `bodyContact` (Stages 2-3) is a second pure function over the same store.

### 10.2 Every surface, with the evidence

| surface | data today | fakes | fate |
|---|---|---|---|
| `FLAT_GROUND` (ground.ts:40) | literal `{heightAt: () => 0}` | the y=0 plane under everything; `car.ts:390-395` clamps `pos.y = 0` when the active ground *is* this object (identity test) | one infinite patch; clamp **D** |
| `DISC_GROUND` (ground.ts:58) | literal; `onDisc` radius 48, `y >= -STEP_UP` | same identity clamp; `ragdoll-ground.ts:49,56` tests `=== FLAT_GROUND/DISC_GROUND` to rebuild a Rapier floor | one round patch; both identity tests **D** |
| `TrackGround` (track.ts:554) | baked `heights`/`surf` Float32/Uint8 grid + `RoadCrease` (centre, lat, drop) + analytic `deckAt` per path segment from a `Map` of cell lists | none in the field; the deck is a height rule recomputed per call (`segmentAt`), and `normalAt` differences `heightAt` four times | terrain grid + crease arrays = one patch; each deck segment = one 1-cell patch in the same crease form (centre linear along it, lateral clamped to the road half-width: it is the crease formula) **Q** |
| `FleetRamps` (fleet-ramps.ts:62) | analytic wedge `onFace` + slab top over `DISC_GROUND` | **yes**: `heightAt` answers 0 (the floor) under a wedge when `h - y > kerb + reach*min(a, side)`, and `kerb` is `CLIMB` 0.35 / `MOUNT` / `SKIN` 0.2 per *asker class*: the same point is floor or face by who asks (M1-M3 of 1.1) | face patches (2 wedges, slab top) as plain data; the per-asker kerbs **D**; `contact()` keeps the walls until Stage 2 but picks its way out by the face normal and the point's approach, not by height over the origin **Q** |
| `Corkscrew` (corkscrew.ts:148) | analytic floor frame (`_c`, `_su`, `_n`) from a twist rate | `heightAt` answers 0 under the floor when it is more than `STEP_UP` above the asker (pad as invisible plane) | floor baked once as a patch grid, pad = flat patch **Q** |
| `CarSurfaces` (car-surfaces.ts:86) | per style top plate (`GRIDS`), `crush[TOP]` and class lift, `matrixWorld` per car | **yes**: `heightAt` is stateful (`owner`, `follow`) for the next `normalAt`; a roof is seen only by the car being stepped (`begin(car)`) and only inside `stepAir` (`restsOn`); `SKIN` 0.25 decides side or top | `CarTop` dynamic slots in the store (frame + plate heights rewritten when the car's masses move); every wheel and hull point reads roofs through the one function **Q** |
| props (`engine-props.ts:10-11,131-135`, `placements.ts:35`) | boxes + footprint SAT (`prop-contact.ts`) | **yes**: `clears(car)` = `car.y > BARRIER_TOP - CLEAR_DROP`, "a car above it has no contact": an air check by car origin height | tops register as flat patches (wheels stand on them); footprint contact stays to Stage 2 (WallRegress2's); `clears` **D** with it |
| literal test grounds (6: slope, frame-motion, wreck-slope, car-load, ramp, wreck-yaw) | object literals typed `Ground` | n/a | become `Surface` subclasses registering a patch (same heights) |

### 10.3 Every consumer, by what it reads

| where | reads | fakes? | fate |
|---|---|---|---|
| `car.ts integrate` 388-460, `support/axleGround/AXLE_STEP/settle/landPose/tilt` (car-support.ts), `takeOff/land` (271-292) | ground under the *origin*, an axle chord and 39 hull samples | **yes**: the origin's ground is the car's ground; `AXLE_STEP` 0.1 and `settle` repair the wrong answer; `pos.y > gy + droop` is "took off" with 3 wheels touching (M4) | **D**; the pose is derived from per-wheel contacts |
| `car-air.ts stepAir`, `hullClear`, `fromSide`, `nearContact`, `UPRIGHT`, `airContact` | every hull point vs `heightAt` + `CarSurfaces` | **yes**: `fromSide` decides a point is "the side of a wall" by depth (`pen > stop + fall`); `hullClear` is a second "is it clear" for wrecks; `UPRIGHT` 0.9 is a "pretend landed" gate | `stepAir` becomes the one rigid solve over the contact set; `fromSide`, `hullClear`, `UPRIGHT` **D**; `airContact` and `airborne` are computed from the contacts |
| `car-drive.ts` 77-80, 191-225 | `floorUnder` (origin), `gripUnder` (two axle points), `car.airborne` | the car has one floor and two grips; "airborne" idles the drive wholesale | per-wheel load, grip and normal **Q** |
| `car-suspension.ts seatWheels` 247-270, `bottomOut` 313-335 | `heightAt` at 7 tread points per wheel and at the underside | a second, drawn-only wheel contact | `seat` reads the wheel contact; `bottomOut` reads the hull contact **Q** |
| `car.ts seatBody` 716-725, `bleedAfterSlide`, `car-parts.ts` 216/564, `loose-step.ts` 29 | `heightAt` under the class lift group, a panel, a door, a popped wheel | `car-parts.ts:216` clamps a panel's `y` to 0.04 over the floor | **Q**; the clamp is the point query's answer |
| `deform-state.ts` HUB_FLOOR 0.28 (42, 187-217), `deform-solve.ts` 652-733, `deform-contact.ts` 51-55, 270-290, 374-394, `tyre-yaw.ts` 37-44 | wreck masses vs `heightAt`; `aloft` from a "band" and `LIFT_OFF` 0.1 | **yes**: a planted hub stands 0.28 over the floor while the tyre's radius is 0.32 (the arming sag, G1); `aloft`/`LIFT_OFF` is a second "in the air" for wrecks | one hub-seat rule shared with the driven wheel (TYRE_R); `aloft` computed from the same contacts; `LIFT_OFF` **D** |
| `physics-util.ts floorUnder/gripUnder` | `activeGround().heightAt/frictionAt` | thin | **D** (callers use the point query) |
| `world-step.ts` 109, `sat.ts shareHeight` 76, `car-surfaces.ts` 207-214, `engine-rigs.ts` 119-128, `auto-watch.ts` 251, `engine-race.ts` 298 | `airborne`, `restsOn`, `airContact`, `yielding` | `shareHeight` = "airborne and resting on the other: skip"; derived flags replace stored ones | **Q** (derived `airborne`, `restsOn` from contacts) |
| `reel-codec.ts` 17, 50, 62; `engine-replay.ts` 315; `car.ts flight()` 237-267; `deform-rig.ts` 727, 779 | the stored `airborne`/`airContact` bits in keyframes | stored state that a derived value should replace | the bit is dropped from the flight block (REPLAY/NET bump) |
| `engine-marks.ts` 231, 265, 278 | `y - heightAt < WHEEL_R + 0.14` | **yes**: its own "grounded" check for skid marks | reads the wheel contact **Q** |
| `ragdoll-ground.ts` 45-94, `ragdoll-purse/solids`, `engine-ragdoll.ts` 477 | `heightAt` on a grid; `instanceof Corkscrew/FleetRamps` branches to rebuild a Rapier floor | **yes**: a copy of the ground per scene type | builds from the store's static patches **Q**, the `instanceof` chain **D** |
| `engine-scenes.ts` 83, 296, 705, 760, `engine-race-field.ts` 438-599, `engine-fx.ts`, `engine-cine.ts`, `engine-reel.ts/engine.ts` fall-watch, `placements.ts`, `track-*.ts`, `track-art.ts` props, `ride-cam.ts`, `spectate-cam.ts` | `heightAt` at points (camera clearance, dust floor, spawn height, props' rest, mesh build) | `track-art.ts` props keep a clamp `floor = heightAt - reach` for their own tumble | point-query callers **Q**; no change of behaviour |
| HUD "Flying" (`hud-panels.tsx:249`), police bust (`session.ts` 236-249), `race-ai.ts` `surfaceAt(path,k)`, `derby-ai` | the ejected driver's range readout; the car's held-slow seconds; the road path's surface | none read a ground or a car's air flag | unrelated (the AI's `surfaceAt` is the path's, not a ground's); unchanged |

### 10.4 What Stage 1 deletes and what it leaves

Deleted in this lane: `car-support.ts` whole (`support`, `axleGround`, `AXLE_STEP`, `settle`, `landPose`, `tilt`'s chord branch), `car.ts takeOff/land` and the grounded pose branch, `stepAir`'s `fromSide`, `hullClear`, `UPRIGHT`, `FLAT_GROUND`/`DISC_GROUND` identity tests, `physics-util floorUnder/gripUnder`, `FleetRamps` per-asker kerbs (`CLIMB`/`MOUNT`/`SKIN` as heights; the walls' push stays until Stage 2, by normal), `Corkscrew` invisible pad, `CarSurfaces` statefulness, `LIFT_OFF`, the stored `airborne`/`airContact` bits. Left (named, Stage 2+): `WALL_PROBES`, prop footprint SAT, `JerseyBarrier.clears`, `wallBounce`, SAT crush hulls.

### 10.5 The query, with the tyre's footprint (Main's check, UC1Wheels)

`pointContact(x, z, y, out)` is the one-point probe (the `heightAt`/`normalAt`/`frictionAt`/`surfaceAt` names are one-line wrappers of it). The wheel does not use it alone. Signature, in `world/surfaces.ts`, plain function over the store's typed arrays (no `this`, no allocation; `out` a preallocated `Float64Array(WHEEL_HIT)`):

`wheelContact(hub: Float64Array /*x,y,z*/, axes: Float64Array /*body rotation, 9*/, scale: number /*wheel scale*/, out: Float64Array): void`

It sweeps the tyre's footprint: the 7 `TREAD` points (crown arc ±0.5 rad, both shoulders) plus the ±45° arc points, each a `pointContact` asked at its own height (a face a kerb above a point is a wall, not floor, as every other query), and answers `out = [rise, nx, ny, nz, grip, surface, owner, argmax]`: `rise` = the greatest height any footprint point must lift to clear the surface under it (the tread gap is `-rise`), the normal, grip, surface id and owner (-1 the world, else a car's index) at the point that sets it. A wheel riding up a lip therefore rises continuously as its arc meets the edge, not when its hub crosses it (ParkedTodos G5's 14 cells: one ground point per tyre at an edge or corner). Hull points (underside, bumper, roof corners) ask `pointContact` the same way, each at its own height.

**Derived `airborne`** = no tyre within `droop + TOUCH` of a surface AND no hull point in contact. A body resting on its belly with free wheels (a car on another's roof) is not airborne: it has contact friction and no drive (its wheels are free: no belly traction).

**The constraint set** replaces the modes: tyres within reach give pose constraints (three or more fix height, pitch and roll to the rest plane through their contact points: the pose-following that keeps no-creep and the bank bar); fewer leave the free degrees of freedom to the rigid solve (`stepAir`'s impulse code, kept) driven by the same wheel and hull contacts; none is flight.

### 10.6 Measured in this lane (main 5ad7839)

- E1 as written (`scenes/ramp-crossing.test.ts`, 32 cells x 8/12/20 m/s): 60 of 64 cells at 12 and 20 m/s red, e.g. th 15, e 0.4, 12 m/s: yaw 3.27 deg, shove 19.7 cm, dv 0.511, plane 4.97 deg, 58 slices flagged airborne with a tyre within 3 cm.
- E2 as the doc wrote it cannot hold. A settled aligned sedan stack leaves the top car's tread bottoms 0.327-0.364 (car 1), 0.344-0.385 (car 2), 0.364-0.410 m (car 3) over the plate of the car below (belly on the roof crown 1.306 = tread plane 1.175 + 0.131; hood 0.737, trunk 0.788). Sequential drops to 18 cars (the stack scene's own build): packed spacing 0.763 m, top car 0.409/0.364 m over the car below. A pre-crushed lower roof (crush[TOP] 0.40, 0.45): tyres 0.23-0.25 m over the plate. Wheels are never within reach of a car below, with the plate or without.
- Drawn against physics (owner's stuck-stack shot): with the lower roof crushed 0.40 the drawn top car's tyres sit 7.5 / 13.6 cm INSIDE the drawn lower car's mesh top (hood 0.795, trunk 0.734) while the physics plate there is 0.556 / 0.540: `CarSurfaces` lowers hood and trunk by `crush[TOP] x faceFollow` (~0.48 x 0.40) and the drawn skin does not move them. The owner's trace (18 cars, muscle) has the top car 0.722 m above the car below with that car's roof mass sunk 0.40 m. That is a drawn-vs-physics mismatch for Stage 3 (cage from the drawn skin): with the drawn hood and trunk as the surface the tyres would touch.
- E2 as built: a monster on a sedan (belly lift 0.48 puts the tyres on the hood and trunk) and a belly-resting sedan that is not airborne and not driven.
