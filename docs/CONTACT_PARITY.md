# Contact parity: scene rigs vs car-car

The Doors ram, the press and the pistons are test benches for the same crash a car can deliver.
This file pins what "the same hit" means, measures each scene against the car-car path, and lists
where the code paths differ.

Probes: `src/game/contact-parity.test-util.ts` (scenarios, `carState` measure),
`src/game/contact-parity.test.ts` (matched-pair tests), scratch table runner
`.bench/parity/probe.ts`.

## Matched pairs and what "equivalent" means

| Pair | Scene rig | Car-car | Equivalence |
| --- | --- | --- | --- |
| Mirror swipe (Doors A) | `fireRam(car, "mirror")`, 858 kg ram, 12 km/h | a 858 kg car, its left side on the lane's inner edge (x = 0.95 m), rear→front at 12 km/h past the parked car's right side | Same lane geometry (inner edge, travel, start and end), speed and striker mass |
| Open door pushed past its stop (Doors B) | `fireRam(car, "overOpen")`, door 55° | same car on the B lane (x = 0.95 m), rear→front | as above |
| Open door driven shut (Doors C) | `fireRam(car, "shut")`, door 55° | same car on the C lane (x = 1.10 m), front→rear | as above |
| Sandwich vs press | engine `stepCompactor` on a parked car (`CarPress`) | two 858 kg cars square into the nose and the tail at the same speed | The press is displacement-controlled (kinematic plates, unbounded force), so compare (a) at matched travel: the press closes until the middle car's bumper-to-bumper shortening equals the sandwich's; (b) at matched absorbed energy: plate work Σ J·v against the middle car's share of the sandwich's kinetic-energy loss, split by shortening (same structure ⇒ same crush force per metre) |
| Piston vs car | `firePiston(car, "front")`, 858 kg at v | an 858 kg car square into the parked car's nose at v | Same mass, speed and spot. The car's nose is crushable: car-car gives the struck car an EBS of closing·m_B/(m_A+m_B) (`pair-contact.ts:76`), i.e. half the reduced-mass energy for equal masses, which is the piston's `hardness` 0.5. Hardness 1 (rigid steel face) is listed for reference |

Measure (`carState`): parts off, right door angle/latch, right mirror fold, per-particle travel in
the passenger-cell frame (plan-view rigid fit of cell, doors and roof, so a shove reads zero),
crush band per particle (`-` under yield, `y`, `m`, `P` packed, `regionCrushBands`), drivetrain
state, cabin intrusion (largest change of any cabin-particle pair distance), shortening and
nose/tail crush.

Tolerances (tests): same parts off; door angle and mirror fold within 3°; same latch; same
drivetrain state; per-particle travel within 15 % or 10 mm, whichever is larger (hubs excluded);
cabin intrusion within the same band.

## Before (main 26c0187 / b9c5647)

### Doors

| Scenario, 12 km/h | Car-car (858 kg) | Ram (858 kg) |
| --- | --- | --- |
| A mirror | nothing touched: mirror on, fold 0°, door shut | mirror folds to 75° and snaps off |
| B open door, rear→front | door stays 55°, nothing touched | door past the stop, torn off (door + mirror) |
| C open door, front→rear | door stays 55° | door driven shut and latched |
| A / B / C at 30 km/h | as at 12 km/h | mirror off / door torn off / slammed shut hard enough to tear off |

Body Δ is 0 mm on both paths in all six runs (the ram never meets body particles; the car-car
pass never reaches the hulls: lane x 0.95 vs hull 0.86).

### Sandwich vs press (middle car)

| | Sandwich 20 km/h | Press at matched travel (face 2.037) | Press at matched energy (face 1.496) |
| --- | --- | --- | --- |
| Shortening / nose / tail (mm) | 109 / 84 / 25 | 113 / 63 / 50 | 1194 / 516 / 678 |
| Plate work vs middle-car share (J) | 9 410 | 250 | 85 670 |
| Parts off | none | none | bumperF, bumperR |
| Drivetrain | alive | alive | alive |
| Cabin intrusion (mm) | 4 | 5 | 18 |
| Particles over tolerance | — | engineL/R 34/80, tank 21/33, axleR 34/21, bumperRL/RR 105/79 | every one |

| | Sandwich 40 km/h | Press at matched travel (face 1.991) | Press at matched energy (face 1.432) |
| --- | --- | --- | --- |
| Shortening / nose / tail (mm) | 203 / 176 / 27 | 204 / 104 / 100 | 1322 / 583 / 739 |
| Plate work vs share (J) | 37 573 | 456 | 222 322 |
| Parts off | none | none | bumperF, bumperR |
| Drivetrain | alive | alive | **dead** |
| Particles over tolerance | — | bumperFL/FR 185/112, engineL/R 36/94, tank 16/47 | every one |

The sandwich crushes the first-struck end and barely the other (nose 176 / tail 27 mm at
40 km/h); the press crushes both ends evenly and moves the engine block at a tenth of the travel.
Plate work is 40–80× too small at matched travel and the press needs ~6× the travel at matched
energy: the plates move masses without paying the crush force car-car pays.

### Piston vs car (front, 858 kg)

| | Car 20 km/h | Piston h 0.5 | Piston h 1 | Car 40 km/h | Piston h 0.5 | Piston h 1 |
| --- | --- | --- | --- | --- | --- | --- |
| Shortening / nose (mm) | 76 / 26 | 76 / 26 | 116 / 49 | 173 / 128 | 173 / 121 | 254 / 183 |
| Parts off | none | none | none | none | none | none |
| Over tolerance | — | rails 18/29, roof 6/17, wings 32/47 | bumpers, engines, tank, axle | — | none | bumpers, engines, tank, axle |

The piston's energy bookkeeping already matches car-car at the car-equivalent hardness; the
residual at 20 km/h is the mass-level contact (box projection vs sphere contact).

## Where the paths differ (before)

- Doors and mirrors: `door-rig.ts:213` `hitMirror` and `:255` `hitDoor` are the only door/mirror
  colliders and only the Doors ram calls them; car-car never touches a door or a mirror. The
  free swing `car.ts:1012` `swingDoors` only runs in the Doors scene. Car-car drives doors and
  mirrors only through the crash rule `hingeT` from crush sensors (`car.ts:888`
  `syncAttachedParts`, C1–C3), so a car brushing a mirror or an open door with no body crush does
  nothing.
- Door/mirror breakage: `car.ts:1083` `partOnHit` puts every part "on the hit" when the deform
  is `bidirectional` (only the press sets it), and `car.ts:1092` `evaluateBreakage` tears doors
  for `bidirectional || ebs ≥ DOOR_TEAR_MPS`.
- Press: `compactor.ts:39` `enforceWalls` projects masses onto the plates and kills their outbound
  speed (no crush force, no stroke); `engine.ts:1593` `stepCompactor` starts the crash with a
  fixed 18 m/s EBS and sets `bidirectional = true` and `deepCrush = face < midFace` by fiat
  (`engine.ts:1610–1611`). `CompactorRig` (`compactor.ts:69`) runs on a box mesh, not a car.
- Car-car never sets `bidirectional`, so the far end of a car already hit takes no crush
  (`streamed-deform.ts:1267` `impactWeight`, `:2637` sensors) and `rearmHit`
  (`streamed-deform.ts:951`) refuses a second hit for 0.3 s: the sandwich's second car only dents
  the tail through sphere contact. `followGroup` pins a `bidirectional` car to the world origin
  (`streamed-deform.ts:1429`), so the flag cannot be used away from the press as it stands.
- Pistons: `piston-rig.ts:433` `contact` is the barrier's mass-level slab (`projectOutOfBox`) plus
  `brakeInbound`; EBS from ½μv²·hardness (`piston-rig.ts:405` `firstTouch`). No `feedOverlap`, no
  door/mirror collider.
- Car-car: `pair-contact.ts:76` EBS = closing·m_other/(m_a+m_b), `:89` `feedOverlap`, sphere
  contact `streamed-deform.ts:1310` `collideWith`. Barrier: `engine-props.ts:143` `resolve`
  (SAT → `applyImpact` → `feedOverlap` → `projectOutOfBox` → `brakeInbound`).
