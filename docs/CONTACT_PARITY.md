# Contact parity: scene rigs vs car-car

The Doors ram, the press and the pistons are test benches for the same crash a car can deliver.
This file pins what "the same hit" means, measures each scene against the car-car path, lists
where the code paths differed, and records what is shared now (as built) and what is still open.

Probes: `src/game/scenes/contact-parity.test-util.ts` (scenarios, `carState` measure),
`src/game/scenes/contact-parity.test.ts` (matched-pair tests), scratch runners `.bench/parity/probe.ts`
(table), `.bench/parity/micro.ts` (cost), `.bench/parity/shots.mjs` (screenshots).

## Matched pairs and what "equivalent" means

| Pair | Scene rig | Car-car | Equivalence |
| --- | --- | --- | --- |
| Mirror swipe (Doors A) | `fireRam(car, "mirror")`, 858 kg ram, 12 km/h | a 858 kg car, its left side on the lane's inner edge (x = 0.95 m), rear→front at 12 km/h past the parked car's right side | Same lane geometry (inner edge, travel, start and end), speed and striker mass |
| Open door pushed past its stop (Doors B) | `fireRam(car, "overOpen")`, door 55° | same car on the B lane (x = 0.95 m), rear→front | as above |
| Open door driven shut (Doors C) | `fireRam(car, "shut")`, door 55° | same car on the C lane (x = 1.10 m), front→rear | as above |
| Stretched quarter panel pushed back / pulled out (Doors D, E) | `fireRam(car, "panelPush" / "panelPull")`, panel hinge 0.45 | the same striker through `partContact` (`hitPanel`), the panel's mirror image of the door | as above (docs/PANEL_FLAP.md) |
| Ram moves vs car moves (any of A–E) | `fireRam(car, scenario, { carMoves: false })` | `{ carMoves: true }`: the ram stands still and the car is driven into it at the same closing speed | Same outcome: parts off, door angle and latch, mirror fold, hinge load, panel dent. `door-frame.test.ts` tables every scenario × both directions × both sides, and runs `partContact` against a world-fixed box with real car positions |
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

## As built: one striker contact (`src/game/contact/external-contact.ts`)

Every external body is a `ContactBox`: an oriented box (centre, half extents, heading), a world
velocity, a mass (`Infinity` for a kinematic driver) and a `hardness` (share of the crush energy
the struck car takes). The scene props only move their box; the car meets it through:

- **`partContact(car, box, dt)`**: the door slab and mirror colliders (formerly `DoorRig.hitMirror`
  / `hitDoor`), for any striker running along the car (within 15°, `PARALLEL`) with its near edge
  outside the body's width (`CAR_HALF.x`). Folds, breaks and tears go through the hinge model in
  `car.ts` (`setMirrorFold`, `breakMirror`, `loadDoorStop`); the free swing (`swingDoors`) now
  runs in `afterContacts` for every car with an unlatched door. Callers: the Doors ram
  (`DoorRig.hit`), piston heads, and car-car (`partContactPair`, once per slice per close pair
  right after `collideWith` in `engine.ts fixedStep`, `pair-contact.ts stepCarPair` and the
  test copies of `fixedStep`). A car striker is the box `carBox(car)`; what the parts take comes
  off its speed uniformly (all particles alike). The struck car is held, as the ram scene always
  held it: a door or mirror is light against either body. Angled strikers and strikers reaching
  inside the body's width are body hits; the crash rules C1–C3 take the door and mirror then. A
  `fixed` box (a solid standing in the world: a wall piece or solid prop, built by `prop-contact.ts`
  `solidBox`) takes no lane: the door's drawn plan line is tested against the exact shape, and the door
  is shut just far enough to clear it over the slice's `dt` (`shutDoor`: jammed open it is torn off,
  slammed shut past `SLAM_TEAR_J` likewise). Mirrors and panels do not meet fixed solids yet.
- **`bodyContact(car, box, dt, crush)`**: the first touch starts the crash with `applyImpact` and
  `strikeEbs` (the struck car's `hardness` share of ½·μ·v², which is pair-contact's
  closing·M/(m+M) for two cars of the same structure; a kinematic striker gives μ = m); the
  particles are held on the face in the striker's frame (`projectOutOfBox`, the barrier's slab)
  and, while particles rest on it, `brakeInbound` spends the hit's stroke (the barrier's `brake`).
  Callers: press plates (`CompactorRig`, which the engine now drives on the parked car; the
  plane projection `enforceWalls`, the box-mesh `CompactorRig` and the fixed 18 m/s
  `beginCrush` are gone), piston heads (`PistonRig.contact`), the Doors ram (dents the body only
  if a lane reaches the skin; the stock lanes do not).
- **`DeformableCar.noteContactEnd(end, reach)`**: the squeeze rule. Both ends struck within
  0.25 s set `bidirectional`; a striker face inboard of the wheel centres (|z| < 1.34 m) during a
  squeeze sets `deepCrush`; both clear as soon as either end stops being struck. The press and
  front/rear pistons report ends; the press no longer sets either flag by fiat.
  `projectOutOfBox` holds planted hubs too once `deepCrush` is on (the plates no longer pass
  through the wheels).

### After (this branch)

| Pair | Car-car | Scene rig | Verdict |
| --- | --- | --- | --- |
| A mirror, 12 / 30 km/h | mirror folds and snaps off, door shut | same | **identical** (test) |
| B open door, 12 / 30 km/h | door past the stop 68°, torn off with its mirror | same | **identical** (test) |
| C open door, 12 km/h | door shut and latched, mirror folded 66.2° by the car body still alongside | car-shaped ram head: shut, latched, mirror 65.6°; stock 0.5 m × 0.45 m head runs under the mirror (0°) | **identical** for the same striker shape (test) |
| C open door, 30 km/h | door slammed shut and torn off with its mirror | same | **identical** |
| Piston vs car, 40 km/h, 858 kg, hardness 0.5 | short 173, nose 128 mm, no parts off | short 173, nose 120 | **within tolerance** (test; it already was before) |
| Piston vs car, 20 km/h | short 76, nose 26 | short 76, nose 26 | parts, drivetrain, cabin same; rails 18/29, roof 6/17, wings 32/47 mm over 10 mm (todo) |
| Sandwich 20 km/h vs press at matched travel (109 / 117 mm) | nose 84, tail 25, no parts off, drivetrain alive, cabin 4 mm | nose 67, tail 50, none, alive, cabin 2 mm | parts, drivetrain, cabin same; engines 34/75, tank 21/38, axleR 34/23, rear bumpers 105/89, wings 35/48 mm off (todo) |
| Sandwich 40 km/h vs press (203 / 208 mm) | nose 176, tail 27 | nose 105, tail 103 | parts, drivetrain, cabin same; front bumpers 185/121, engines 36/82, tank 16/49 off |

Matched energy (b) cannot be used as a pass/fail measure: the plates are displacement-driven, so
plate work Σ J·v (408 J at the 20 km/h sandwich's travel, against the middle car's 9.4 kJ
share) counts only the momentum the slab removes, not the work of pushing the structure.

Cost: `partContactPair` 62 ns per close pair, `afterContacts` additions 238 ns per car (headless
micro-bench): 0.09 ms per frame worst case at 24 cars (276 pairs, 4 slices). The browser bench
could not be measured on the saturated box (2–20 fps for both main and this branch).

### Per-particle todo report (main 937e631, re-measured by lane `crash-realism-11`)

The two `todo` tests (`PENDING` in `contact-parity.test.ts`) match on parts, drivetrain and cabin.
They miss only on per-particle crush: travel in the cell frame, car/rig in mm, with every
particle outside 15 % or 10 mm listed. The rows above are the older reading.

| Todo | Off now (car / rig mm) | Change since the table above |
| --- | --- | --- |
| Sandwich 20 km/h vs press at matched travel | engineL 23/75, engineR 23/75, tank 21/37, wingFL 33/49, wingFR 33/48 | `axleR` and the rear bumpers are now inside tolerance; the engines moved from 34 to 23 in the car |
| Piston vs car 20 km/h, squash 0.4 (the 0.32 run is not reached) | engineL 54/87, engineR 54/87, axleR 53/89, wingFL 34/48, wingFR 34/48 | rails and roof are now inside tolerance; the engine block and the rear axle are now listed |

In both rows the rig crushes the engine block, the wings and the rear running gear more than
car-car does: the rig drives the face through the slab, car-car through sphere contact. This is
the particle-level split under "Open" below.

### Open

- **Car-car squeeze.** Car-car does not report struck ends, so a car sandwiched by two others
  crushes its first-struck end and barely the other (nose 176 / tail 27 mm at 40 km/h). Turning
  the squeeze rule on for car-car was measured: with `followGroup`'s origin pin
  (`streamed-deform.ts:1429`, a `bidirectional` car is held at the world origin) derby wrecks
  teleport 10 m in one slice; without the pin a 16-car pile-up keeps turning (0.51 rad in 2 s) and
  the middle car crushes a fifth of the strikers. The `bidirectional` deform rules (origin pin,
  no planting, re-arm refused) assume the press; they need to work for a free car before car-car
  can share the rule (CrashRealism5's `followGroup` / plant code).
- **Particle-level contact.** Car-car particles meet through sphere contact
  (`collideWith`) plus `feedOverlap`; rigs meet through the slab (`projectOutOfBox`). Feeding the
  face overlap through `feedOverlap` in `bodyContact` was tried and moved the piston further from
  car-car (rails 29→32, wings 47→49 mm) and broke the piston wing grading, so it was dropped. The
  remaining per-particle gaps above (engine block, tank, rear axle, bumpers) come from this split.

## Hooked pairs: the car-car contact axis (`satTwoHulls`)

A pair's SAT axis is signed by the **cars' centres** (b → a), not by the centres of the hull pair that overlaps. A corner
hull (half length 0.24 m) pushed past its partner's midplane read "out" the way that drives the whole cars deeper in, and
the next SAT pass of the same slice picked another hull pair with the opposite sign and undid the push: a car's rear corner
stayed inside the follower's nose for seconds (the owner's "hooked cops"; any class pair). Measured on b74c840:

- Fresh sedans, 5616 grid poses (A ahead of B 1.6–4.6 m, ±1.9 m across, ±0.8 rad): 330 hull and 816 crush-hull axes pushed
  the centres together; 0 after.
- A's rear corner 1 m inside B's nose (0.6 m off axis), both flat out at 22 m/s: in contact 3.00 s of 3 s in 17 of 25 class
  pairs (centres 3.2–3.4 m apart); 0.32–0.37 s in all 25 after (`contact/pair-hook.test.ts`).
- Headless hook detector (contact run ≥ 1 s, tight hulls overlapping ≥ 0.25 m in ≥ 50 % of it, moving ≥ 3 m/s), 8 seeds:
  police races on oval/rally/city/stunt 0.09 → 0.04 hooks per car-minute (mean 3.27 → 2.23 s, longest 33.8 → 6.4 s);
  9-car derby 0.47 → 0.26; Survival HUNT cops 2 → 0. 85 % of the base race hooks had inverted solver passes
  (the 33.8 s one flipped every other pass).
- Left over, not a sign problem: pairs with both cars driving into each other at low speed (a pin), and derby/city piles
  where `takePush`'s per-slice budget goes to whichever pair comes first (the deep pair gets `took 0.000` for hundreds of
  slices). A deep-overlap budget bypass was tried (pair-contact.ts): derby 28 → 21 hooks but race 27 → 35, so it was not
  kept; the budget rule belongs with the pair-solve lane.

A clip saved before this rule replays its pairs' pushes the other way round: `REPLAY_VERSION` 13.

## Fixed solids: race walls, props and ramp flanks meet the car as the jersey slab does

Owner, 2026-10-04: a fixed, very hard object does what the range's jersey slab does, on every map. Race walls
(then `RaceField.wall`'s line probes; now solid pieces of `wallColliders`), solid props (`props`) and the fleet ramps' flanks (`FleetRamps.contact`) were met through `wallBounce`,
which cancelled the whole closing speed and bounced the car in one step (`v += n·closing·(1 + 0.15)`), then crushed it from
`applyImpact` at a footprint corner (or `kickNearest(closing·8)` on a wreck). Oval sedan, 55 m/s head-on: block travel 0.04 m
from the hit itself (the slab at the same speed: 0.454 m, dead), later reaching 0.25 m only because the throttle squeezed the
crushed nose into the wall. `wallBounce` has been that since the race scene began (d06d122: the same `WALL_CRUSH` branch inline).

Now `wallBounce(car, face, nx, nz, pen, dt)` meets a hard hit (more than `WALL_CRUSH` 5.5 m/s into the face) or a wreck through
`bodyContact` on `solidFace(...)`, a fixed striker box (`ContactBox.fixed`): the first touch starts the crash from the hull's
own overlap with the face, a fresh hard one re-arms a wreck's hit, the masses are held on the face (no way round the box's ends:
a wall's end is the joint to the next panel) and the crush force spends the hit's stroke. A light touch of a whole car pushes
out and bounces by 0.15 as before. A rigid car whose footprint is `WALL_HOLD` (0.4 m) in with its hull not on the face yet, and a
wreck whose footprint is `WALL_REACH` (1.2 m) in (rammed by another car), are put back by the push. The prop's face is its own
(`PropFace`): a long thin one (a wall panel) on its wide side, a circle's tangent; a course wall is a 6 m slab at the line.

A wreck's crush hulls are wider than the masses held on the face (the cabin hull spans the least crushed door on both sides, a nose
hull is 0.34 m either side of 0.85 of its bumper), so a wreck a cop rams against a 0.6 m panel sat 0.2-0.3 m in it, or reached past
its far face. The wall pushes the whole wreck (every mass and the group, one rigid shove: `separateAlong` leaves the crumple zone
behind and stretches the nose) out until the hulls are on the face: to the slab's `0.4 · leftover crumple` while the car drives
into it hard (`into` over `WALL_CRUSH`), to a 1.5 cm skin once it has stopped (`into` under `WALL_TOUCH`), between them the allowance
ramps with `into` (a step from 0.25 m to 1.5 cm shoved a wreck sliding along a wall 0.23 m in one step, past the course-wall test's
bound). Uncapped but by the contact's own push (`max(pen, satPushCap)`,
the ramps' `pen` is `PUSH_CAP`): a capped shove lost to a cop's three SAT passes (tail first at 12 m/s ended 0.15 m past the far face).
The ramps' faces hold the masses within `CLIMB` of them: deeper a mass rides the wedge's slope, and a 2 m thick face threw a wreck
that was climbing the ramp out through its high end (2.1 m in one slice, a 0.44 m jump in `D1`).

Hulls on the face are a contact (the slab's own rule, `BarrierSlab.resolve`): a palm is narrower than the car, so its face meets
the crush hulls before any mass, and the rigid shove holds the wreck off it. `bodyContact` then notifies the contact, feeds the
hull's overlap (`feedOverlap`) and spends the hit's stroke (`brakeInbound`) while no mass is on the face. Measured on the per-step
ledger (palm, sedan): the shove is exact (every mass and the group move by the same vector, mass-minus-group delta 1.8e-15; the
group follows the cell within 1 mm and the block's car-frame z does not change across it), so the extra travel was not a frame or
anchor read. Two real defects: (1) the hulls on the face did not count as contact, the quiet clock ran out, and the 8 m/s tap
re-armed its hit at 0.3 s (`hitStroke` 0.276 -> 0.376, `rearmed`), which the block read takes from the stroke, not from the
block's movement (0.016 m, slab 0); (2) the shove removes the wreck's position but no speed, and nothing braked or crushed the
held-off front: a sedan at 55 m/s stood on the shove's treadmill at the palm for 12 steps (v 54.8 -> 47.8, block dragged back 0.05 m
a step), then drove round the trunk at 40 m/s and rolled 50 m (0.589 m of travel against the slab's 0.454; with the shove off
0.336 and 27 m/s). Now a centred hit stops dead (0 m/s, 0.15 m of the trunk's plane the deepest mass, none past it) with 0.485 m
(truck 0.537; slab 0.454, 0.534); an offset one deflects (trunk 0.6 m off the axis: 26 m/s after, 0.8 m: 40 m/s, the corner of
the nose slides past the 0.6 m trunk). The oval/stucco/wall rows' +0.02 m is not the shove (the same to the mm with it off; the
slab's cabin clip off changes nothing either).

`src/game/world/solid-parity.test.ts` holds every solid to the slab for the same armed car at 8 and 55 m/s and on a second
hit: the driver thrown alike, health within 0.2, no more speed left after the hit than the slab's (+1 m/s), `alive` alike unless
both are within 0.2 of the kill line (the slab kills a default sedan by 0.004 m of block travel). REPLAY_VERSION 20.
