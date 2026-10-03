# Crash rig vs. real passenger-car structure

Status: analysis at base `70fc3e9`, no source changes. Every code reference is
`file:symbol` and was read in this tree. Every measured number comes from the
throwaway harness described in the Appendix (commands and raw output are pasted
there). Real-world numbers are cited to `.extraResearch/perplexity/` files
(`04`, `09`–`12`) and through them to primary sources.

## 0. Headline findings

1. **Rigid walls do not crumple the nose. The nose ends up longer, not shorter.**
   A 56 km/h square wall hit stops the car's centre 0.17 m after contact, in
   about 14 ms (≈110 g average). The front control particles then carry on
   *through* the slab face: the deepest is 0.48 m past it. Measured against
   the cell mass, the nose ends 0.04 m shorter on the left and 0.05 m
   **longer** on the right. The engine pair ends up 0.19 m forward relative to
   the cell.
   The real target is 0.35–0.55 m of dynamic crush, 0.25–0.45 m of permanent
   crush and a 90–140 ms pulse [09]. Across 20–80 km/h the stopping distance
   stays at 0.09–0.21 m whatever the speed. The cause is
   `sat.ts:clipCarToBarrier` (`bumperKeep`), which stops the group. Nothing
   stops the masses at the wall.
2. **Car-car crush is too soft and does not scale with speed.** Head-ons at
   2×28 and 2×56 km/h both crush the hit corner by 1.13–1.14 m. That is the
   `clampLocal` cap. Both full-overlap hits get snapped to one corner
   (`impactLocal.x = ∓0.49`), so the crush is lopsided (1.14 m vs 0.48 m)
   and the cars slide 1.5–5.6 m past each other.
3. **Side hits fold the ends instead of the door.** Every node's sideways
   travel is capped at 0.11 m (`clampLocal` `latCap`). In a 50 km/h side slide
   into the wall the door dents 0.11 m, but the nose shortens 0.56–0.61 m and
   the tail 0.36–0.55 m. The struck car in a T-bone loses 0.33–0.55 m of nose.
4. **Parts detach too readily, and mirrors never move.** The front bumper comes
   off at every wall speed, 20 km/h included. The left door comes off in
   frontal wall hits at 35, 48 and 64 km/h, against FMVSS 206 door retention
   [12]. Both front wheels come off in a 2×28 km/h head-on. The mirrors stayed
   at `hingeT = 0` in all 30 runs (38 car results): `car.ts:syncAttachedParts` tests them in
   door-local space, so they are never "on hit".
5. **Cluster stiffness reads the wrong cage.** `clusterBeta(ci)` uses
   `cages[ci].spec.absorption`, but there are 22 clusters and 18 cages, and
   they are not aligned. The front-corner clusters get glass absorption (0.48
   and 0.50). One engine/rail/wing triplet is matched 3× per iteration on
   each side.
6. **The cabin is fine. Leave it alone.** In every frontal and rear wall case
   the door and roof control particles move ≤ 0.06 m relative to the cell
   (≤ 0.07 m in lattice mode, ≤ 0.10 m in car-car). That matches the
   "near-zero cell intrusion" target
   [04][09].

---

## 1. Inventory (as built)

### 1.1 Control particles — `streamed-deform.ts:MASS_SPECS`

Car-local coordinates: +z is forward, +x is the car's "right" (`doorR` side),
+y is up. Total 858 kg (real sedan: 1400–1600 kg). The spec gives a COM at
z = +0.226, y = 0.476, which puts **58.4 %** of the load on the front axle
(arithmetic in Appendix A3). By region: front of z = +0.4 → 342 kg; cabin →
336 kg; rear of z = −0.4 → 180 kg.

| node | rest (x, y, z) | kg | r | real member it stands for |
|---|---|---|---|---|
| bumperFL / FR | (∓0.52, 0.38, 2.06) | 9 / 9 | 0.28 | bumper beam ends + crash boxes + cover |
| wingFL / FR | (∓0.68, 0.40, 1.28) | 18 / 18 | 0.26 | fender, strut tower, upper load path (shotgun) |
| hubFL / FR | (∓0.74, 0.32, 1.34) | 26 / 26 | 0.28 | front wheel, knuckle, lower arm |
| engineL / R | (∓0.30, 0.44, 1.22) | 88 / 88 | 0.36 | engine + transaxle block, as two halves |
| railL / R | (∓0.52, 0.38, 0.68) | 30 / 30 | 0.26 | rear end of the front rails, dash crossmember, toe-board |
| cell | (0, 0.55, 0.06) | 260 | 0.50 | floor pan, tunnel, seats, safety cell |
| doorL / R | (∓0.78, 0.56, 0.08) | 22 / 22 | 0.30 | door, intrusion beam, B-pillar, sill (lumped) |
| roof | (0, 1.18, 0.02) | 32 | 0.36 | roof panel, rails, bows |
| tank | (0, 0.40, −0.88) | 48 | 0.32 | fuel tank, rear seat pan |
| axleR | (0, 0.36, −1.40) | 64 | 0.32 | rear axle / subframe |
| hubRL / RR | (∓0.74, 0.32, −1.34) | 26 / 26 | 0.28 | rear wheel |
| bumperRL / RR | (∓0.52, 0.36, −2.06) | 8 / 8 | 0.26 | rear bumper beam + crash cans |

### 1.2 Node graph

Top view, front at the top. `===` marks the stiff beams (compression `yieldK`
≥ 28 kN/m in lattice mode). Beams are listed in full in §1.3.

```
 z
+2.06   bFL ------------(700/1400)------------ bFR          bumper beam
         | \                                   / |
        2000\                                 /2000          bumper→wing
+1.34  hFL==wFL                             wFR==hFR        hub–wing 9000/20000, hFL===hFR 16000/36000 (under engine)
         \    \ 3800                   3800 /    /
+1.22     \   eL ============42000=========== eR  /          engine pair (maxShorten 0.14)
           \  |  \7000                 7000/  |  /           hub→engine 7000, hub→rail 5000
+0.68       rL ===========25000============== rR             "rails" (really dash/toe-board)
           / |  \ 14000              14000 /  | \
          /  |   \______  cell(260) _____/    |  \           rail→cell 14000/28000 (0.38)
+0.08   dL ==|=====7000== [roof 32] ==7000====|== dR         cell–door, dL–dR 8000/40000 (0.12)
          \  |          ||  42000/98000       |  /           cell===roof
-0.88      \ |        tank(48) ===28000/70000=| /            door→tank 4500/9000
-1.34  hRL===+=======axleR(64)================+===hRR        hub–axle 8000/18000, hRL===hRR 16000/36000
         |  1800                                1800|        hRL→dL / hRR→dR 9000/20000 (sill line)
-2.06   bRL ------------(700/1400)------------ bRR
       x=-0.74  -0.52   -0.30   0   +0.30   +0.52  +0.74
```

Side view (y up, front at the right):

```
 y
1.18                     roof(32)
                     /     ||      \           roof–engine 8000/18000 (A-pillar path), door–roof 6000/12000
0.56          dL/dR(22) == cell(260)
0.44                                         eL/eR(88)          wFL/wFR(18) 0.40
0.40   tank(48)                                                  bFL/bFR(9) 0.38
0.38                          rL/rR(30)
0.36 bRL/bRR(8)  axleR(64)
0.32     hRL/hRR(26)                                   hFL/hFR(26)
     z: -2.06  -1.40 -0.88    0.06  0.68           1.22  1.34   2.06
```

What is missing compared with a body-in-white:

- No node at the rail tip or crash box. The bumper reaches the "rails" only by
  going through the wings and the engine.
- No subframe node.
- No A- or C-pillar nodes. `doorL/R` lumps the door, the B-pillar and the sill.
- No sill node (`skirtLeft/Right` are cages with sensors but no mass).
- No firewall node. `railL/R` at z = 0.68 sit where the firewall/toe-board is.

### 1.3 Beams — `streamed-deform.ts:BEAM_SPECS`

Each entry is `[a, b, kTen, yieldK, maxShorten]`. In the constructor,
`minLen = max(0.1, rest·(1 − maxShorten))` and `damp = √(8·yieldK)`.

In `stepBeams`, `kTen` acts in tension and `yieldK·pass` in compression. Any
compression that happens while the beam is closing becomes plastic (`plastic`
creeps toward the current length at `dt·8.5`, or `dt·14` under `deepCrush`).
There is **no yield-force threshold**. A beam breaks at length > 2.2·rest.

**Beams only run in `lattice` mode.** `stepMassSlice` runs `stepShapeMatch`
in `shape` mode (the default, `hud-store.ts:INITIAL_HUD.deformMode`). In shape
mode the beams still feed `nodePacked` through `minLen`/`plastic`.

| group | beams (kTen / yieldK N/m, maxShorten) |
|---|---|
| bumper beam | bFL–bFR 700/1400 0.75; bRL–bRR 700/1400 0.75 |
| front crumple chain | bF–wF 2000/4200 0.92; wF–eng 3800/8000 0.78; eng–rail 7000/14000 0.78; wF–rail 4000/9000 0.55 |
| block | eL–eR 42000/90000 0.14; eng–cell 3500/8000 0.78; roof–eng 8000/18000 0.16 |
| front suspension | hubF–wing 9000/20000 0.22; hubF–eng 7000/16000 0.26; hubF–rail 5000/12000 0.22; hFL–hFR 16000/36000 0.10 |
| cell ring | rail–cell 14000/28000 0.38; rL–rR 25000/56000 0.18; cell–door 7000/14000 0.5; rail–door 5000/11000 0.48; cell–roof 42000/98000 0.14; door–roof 6000/12000 0.32; dL–dR 8000/40000 0.12 |
| rear | cell–tank 28000/70000 0.22; tank–axleR 9000/18000 0.5; door–tank 4500/9000 0.4; bR–hubR 1800/4000 0.9; hubR–axleR 8000/18000 0.24; hubR–tank 5000/12000 0.26; hRL–hRR 16000/36000 0.10; hubR–door 9000/20000 0.2 |

Compression stiffness, crumple vs. cell: 1.4–8 kN/m against 28–98 kN/m, a
ratio of 1 : 4 to 1 : 70. Real cars aim for "an order of magnitude or more"
[04], so the ratios are fine. In shape mode, though, what governs stiffness is
the per-cluster β and the clamps (§1.7, §1.8).

### 1.4 Cages — `streamed-deform.ts:CAGES` (16 FFD cages + 2 glass)

| cage | z span | absorption | maxCrush | maxAngle |
|---|---|---|---|---|
| bumperFront | 1.88…2.16 | 0.10 | 0.95 | 1.20 |
| bumperRear | −2.14…−1.86 | 0.12 | 0.90 | 1.10 |
| bonnet | 0.72…1.88 | 0.16 | 0.88 | 1.05 |
| boot | −1.86…−0.70 | 0.18 | 0.78 | 0.95 |
| wingFL/FR | 0.72…1.86 | 0.14 | 0.78 | 0.95 |
| wingRL/RR | −1.86…−0.54 | 0.16 | 0.72 | 0.85 |
| doorLeft/Right | −0.58…0.70 | 0.22 | 0.70 | 1.15 |
| skirtLeft/Right | −1.32…1.32 | 0.22 | 0.42 | 0.50 |
| chassisFront | 0.42…1.76 | 0.28 | 0.55 | 0.55 |
| chassisCell | −0.48…0.64 | 0.72 | 0.16 | 0.16 |
| chassisRear | −1.76…−0.32 | 0.30 | 0.50 | 0.48 |
| roof | −0.70…0.56 | 0.52 | 0.28 | 0.32 |
| glassFront / glassRear | — | 0.48 / 0.50 | 0.32 / 0.28 | 0.35 / 0.32 |

The constructor's influence loop skips the door and glass cages when skinning
the body.

### 1.5 Sensors — `streamed-deform.ts:SENSORS` (20)

| index | part | index | part |
|---|---|---|---|
| 0 | bumperFront C | 10 / 11 | wingRL / wingRR |
| 1 / 2 | bumperFront L / R | 12 | roof (maxCompression 0.65) |
| 3 | bonnet | 13 | bumperRear C |
| 4 / 5 | wingFL / FR | 14 / 15 | skirtL / skirtR (0.9) |
| 6 / 7 | doorL / doorR front | 16 / 17 | bumperRear L / R |
| 8 / 9 | doorL / doorR rear (0.95) | 18 | boot (0.95) |
| | | 19 | chassisCell (0.45) |

`pullSensorsFromMasses` sets a sensor's compression from the nearby masses'
displacement: `(along·1.6 + mag·0.7)/0.2`, with falloff and an opposite-side
damping factor of 0.15. Compression can rise by at most `max(0.022, dt·24)`
per frame.

### 1.6 Crush bands, gates, transfer — `physics-core.js`

- `CRASH`: `pulseSec 0.12`, `crushMeters 0.65`, `muPeak 0.9`, `muSlide 0.75`,
  `muScuff 0.4`, `grazeMps 1.8`, `maxMassMps 55`.
- `regionCrushBands(name)`: `max = 0.12 + 0.72·soft`, `yield = 0.16·max`,
  `middle = 0.48·max`.
- `forceTransfer`: transfer to the cell is 0.1 below `middle`, 0.5 up to
  `max`, 0.62 above `max`, and 1.0 when packed (`TRANSFER`).
- `crushGate(closing, soft)`: no crush below `1.8 + 9·(1−soft)` m/s, full crush
  at `7 + 26·(1−soft)` m/s.

Values from `regionSoftness`, computed in Appendix A3:

| region (`regionSoftness`) | soft | band max m | gate min / fatal m/s |
|---|---|---|---|
| bumper* | 1.00 | 0.840 | 1.80 / 7.00 |
| wing* | 0.78 | 0.682 | 3.78 / 12.72 |
| rail* | 0.30 | 0.336 | 8.10 / 25.20 |
| tank, axleR | 0.34 | 0.365 | 7.74 / 24.16 |
| door* | 0.22 | 0.278 | 8.82 / 27.28 |
| engineL/R | 0.16 | 0.235 | 9.36 / 28.84 |
| roof, cell | 0.08 | 0.178 | 10.08 / 30.92 |
| hub* | 0.06 | 0.163 | 10.26 / 31.44 |

- `feedOverlap`: per-slice crush is `min(overlap·(0.4+0.35·squash)·ke,
  0.06+0.2·ke)`, with `ke = closingKeScale = clamp(v²/14², 0, 2.4)`. It
  pushes masses along `inward` by `crush·fall·gate·soft·engineGate·pass` and
  kills their inbound speed. It never projects masses out of the collider.
- `kickCore` removes inbound speed from cabin masses only (weight
  `1 − crumpleWeight`).

### 1.7 Clamps, pins and drivetrain — `streamed-deform.ts`

- `clampLocal` (every `followGroup`), for non-bidirectional hits:
  - Crush cap per node: `maxCrush·(0.38 + 0.72·cornerWeight)` with
    `maxCrush = 0.5 + 1.15·squash` (1.06 m at squash 0.4). Cell and roof are
    capped at **0.12 m** (0.72 under `deepCrush`). Hubs are capped at 0.38 m.
  - Lateral cap `latCap = 0.04 + 0.07·cornerWeight` (**≤ 0.11 m**); 0.55 when
    bidirectional.
  - Vertical caps `maxDy`: roof 0.07 (0.28 deep), cell 0.06 (0.22 deep), hubs
    0.07, others 0.11.
  - Engine sink is capped at `ENGINE_LIGHT_CAP = 0.27` when `hitSpeed < 15.5`.
  - Hubs stay pinned (`dx = dz = 0`) until their planar travel exceeds
    `radius·0.5 = 0.14 m`. Then `popped` is set and the wheel comes loose.
- `updateDrivetrain`: the drivetrain dies when
  `max(|engineL − rest|, |engineR − rest|) > ENGINE_KILL_TRAVEL = 0.3`.
  This distance is **unsigned**.
- `stepSuspension`: hub↔engine and hub↔axleR springs, k = 11000, c = 260.
- `stepMassSlice`: only hubs get gravity. Other masses have their downward
  velocity damped by `0.12^dt`.
- `followGroup`: pitch is clamped to −0.2…0.22 rad and roll to ±0.5 rad. The
  group is planted on the hubs once `quietTime > 0.2`.
- `snapImpactToNearestMass`: a hit stays centred only if
  `|impactLocal.x| < 0.2`. Otherwise it snaps to the nearest non-cell,
  non-roof mass.

### 1.8 Shape matching and plasticity — `shape-match-core.js`

The squash and buckle defaults are 0.4 and 0.45 (`hud-store.ts:INITIAL_HUD`).
Evaluated values are in Appendix A3.

- `applyPlasticity`:
  - Yield: plasticity starts when `‖S−I‖ > yieldC = 0.035 + 0.08(1−squash) +
    0.04(1−buckle)` = **0.105**.
  - Creep: `min(0.85, (0.35+1.25·squash+0.55·buckle)·max(dt,1/120)·10)`, which
    is **0.0915** per 1/240 s slice.
  - Cap: `‖Sp−I‖ ≤ maxE = 0.18+0.55·squash+0.4·buckle` = **0.58**.
  - Volume restore is 8 %. Diagonal stretch is capped at 1.06.
  - Rotational plasticity runs only while contacting and when the rotation
    angle is > 0.08 rad.
- `stiffnessIters` gives **4** iterations, `goalAlpha` **0.592** and
  `deformBeta` **0.36**. While contacting, `clusterBeta` uses
  `lerp(0.18+0.22·squash, 0.03, absorption)`.
- Clusters are built in `StreamedDeformation` constructor:
  - one cluster per cage via `cageClusterIndices`, skipped if it has fewer
    than 3 masses;
  - cages centred on x split into L and R clusters;
  - 6 `extra` clusters.

  That gives **22 clusters for 18 cages**. `clusterBeta(ci)` reads
  `cages[ci].spec.absorption` (0.1 if `ci ≥ 18`), so most clusters use another
  cage's absorption. The probe output (Appendix A2) shows the mapping:

| ci | masses | absorption actually used (cage[ci]) |
|---|---|---|
| 0 | bFL, bFR, eL, eR | bumperFront 0.10 (the bumper cluster also holds the engine block) |
| 2, 6, 10 | eL, rL, wFL (**the same set 3×**) | bonnet 0.16, doorRight 0.22, wingRR 0.16 |
| 3, 7, 11 | eR, rR, wFR (**the same set 3×**) | boot 0.18, wingFL 0.14, chassisFront 0.28 |
| 4 / 5 | rail, door, cell, roof (L / R) | roof 0.52 / doorLeft 0.22 |
| 12 | rL, rR, cell, dL, dR, roof | chassisCell 0.72 (correct by coincidence) |
| 16 / 17 | bF*, wF*, e*, r* (front-corner extras) | **glassFront 0.48 / glassRear 0.50** |
| 18–21 | rear corner / cabin extras | 0.10 (fallback) |

### 1.9 Detachable parts, hinges, glass, lamps, wheels — `car.ts`

`registerParts` lists the attached parts. Each part's hinge value `hingeT`
moves toward a target computed in `syncAttachedParts`, rising by at most
`max(dt·3.2, 0.012)` per frame. `evaluateBreakage` detaches the part when
`hingeT` passes a threshold.

| part | hinge | sensors | target in `syncAttachedParts` | detaches (`evaluateBreakage`) |
|---|---|---|---|---|
| bumperF / bumperR | two-point | 1, 2 / 16, 17 | `(crush−0.04)/0.55` | hingeT > 0.7 |
| hood | cowl | 3 | `(crush−0.1)/0.6` | hingeT > 0.78 |
| trunk | tail | 18 | `(crush−0.1)/0.6` | hingeT > 0.78 |
| doorL / doorR | door | 6 / 7 | `(max(local,crush)−0.08)/0.5` | hingeT > 0.58 |
| mirrorL / mirrorR | two-point (parented to the door) | 6, 4 / 7, 5 | as two-point | hingeT > 0.5 |

- **Door "on hit" rule:** `|restPos.x·ix| > 0.18 || crush > 0.16`, plus
  `local > 0.12` in `syncAttachedParts`. So a frontal hit opens a door through
  compression alone.
- **Mirror "on hit" rule:** `along = −(restPos·inward) > 0.12`. But `restPos`
  is door-local (`mirrorL.position = (−0.06, 0.32, 0)` in the constructor), so
  `along` is at most 0.06 and the mirror is never on the hit.
- **Glass** (`evaluateBreakage`, owner rule 2026-10-02: some impact cracks a
  pane, a frame clearly moved or compressed past rest shatters it). A pane
  reads its frame's strain, `cageStrain`: the largest change of any
  corner-to-corner distance of a cage from rest, so rigid motion reads 0. The
  windscreen and rear glass read their own cage (`glassFront`, `glassRear`);
  door and quarter glass read their door's (`doorLeft`, `doorRight`). Strain
  > 0.05 m cracks. Tempered glass (rear, doors, quarters) shatters at
  > 0.11 m; the laminated windscreen only at > 0.25 m, once its frame has
  collapsed. Pane order (from `addGlass`): 0 windscreen, 1 rear glass, 2/3
  door glass L/R, 4/5 rear quarter L/R. Lane ragdoll's probe over the
  standard crashes (peak strain in m; i intact, c cracked, s shattered; the
  old part-compression rule left every pane intact except the T-bone's and
  the 50 km/h side hit's cracks):

  | crash (crash-scenarios) | windscreen | rear | door L | door R | quarter L/R |
  |---|---|---|---|---|---|
  | head-on 56+56 (dead) | s 0.297 | s 0.165 | s 0.161 | s 0.161 | s / s |
  | head-on 28+28 | c 0.067 | i 0.027 | i 0.042 | i 0.042 | i / i |
  | T-bone 0/50, struck (right) | c 0.224 | s 0.149 | i 0.048 | s 0.115 | i / s |
  | T-bone 0/50, bullet | c 0.117 | c 0.104 | s 0.139 | s 0.139 | s / s |
  | wall 56 (dead) | s 0.255 | s 0.144 | c 0.105 | c 0.105 | c / c |
  | wall 35 | c 0.104 | i 0.040 | i 0.035 | i 0.035 | i / i |
  | offset 40 % 64 (dead) | s 0.374 | s 0.185 | s 0.404 | s 0.201 | s / s |
  | side wall 50 (left) | c 0.226 | s 0.215 | s 0.174 | i 0.049 | s / i |
  | side wall 30 (left) | c 0.118 | c 0.104 | c 0.091 | c 0.051 | c / c |
  | rear wall 50 | c 0.095 | s 0.115 | c 0.082 | c 0.082 | c / c |
- **Lamps** break at sensor or part compression > 0.18 after 0.02 s. Each lamp
  checks its own sensors and parts: head L = sensors 1, 4 and wingFL; head R =
  2, 5 and wingFR; tail L = 16, 10 and wingRL; tail R = 17, 11 and wingRR.
- **Wheels** (`nudgeWheels`): a pinned hub keeps its rest x/z and only moves
  in y. A popped hub frees the wheel.

### 1.10 Contact paths

- **Wall** — `engine.ts:resolveBarrier` → `sat.ts:satCarBarrier` (crush hulls
  and cabin hulls, both split L/R in `car-mesh.ts:CRUSH_HULLS` / `HULLS`) →
  `feedOverlap` → `cancelClosing` impulse
  (`j ≤ 18 + 40·pass` N·s per slice) → `sat.ts:clipCarToBarrier`. The clip
  holds the **group** at
  `minLx = lerp(hx + 1.08, hx + 0.22 + 2.05·0.85, leftover)` from the slab
  centre. For a square hit at `leftover = 1` that is 0.38 + 0.22 + 1.7425 =
  2.34 m, i.e. the centre may come only 0.26 m closer after nose contact
  (CAR_HALF.z + hx = 2.6 m).
  Then `kickCore` and `car.velocity` lose all inbound speed. No mass is ever
  projected out of the slab.
- **Car–car** — `pair-contact.ts:resolveCarPair`: SAT on the split hulls,
  `feedOverlap` on both cars, a minimum centre gap of
  `2.15 + 0.28·(leftoverA + leftoverB)`, and a per-slice closing impulse of at most `closingCap`: `18 + 36·pass`,
  raised to the impulse that stops the closing before the centres come within 2 m (`STOP_GAP`).
  `engine.ts:fixedStep` also runs `collideWith` sphere contact between the two
  cars' masses.
- **Lamp pole** — `engine.ts:resolvePoles`: one kick per car,
  `j = clamp(40·closing, 80, 400)` N·s, then `kickNearest`. The pole **breaks**
  at closing > 3.5 m/s. Afterwards the car is only position-pushed
  (`pushCar ≤ 0.04` per slice).

---

## 2. Real body-in-white vs. the rig

Sources: real stiffness and tolerance values are from [04], [09], [11] and
[12]. Rig values are from §1. The "measured" column refers to §3.

| real member | real stiffness / tolerance | rig node / beam / cage | rig value | verdict |
|---|---|---|---|---|
| Bumper beam | Starts the hit and spreads load; little absorption [04] | bFL–bFR beam, `bumperFront` cage, sensors 0–2 | 700/1400 N/m; band max 0.84 m; gate 1.8→7 m/s | OK as a load spreader. Detaches too early (measured: off at 20 km/h) |
| Crash boxes | 33–70 kN plateau over a short stroke (~0.1–0.2 m) [04] | **MISSING** (lumped into bumper*) | — | Missing. There is no staged trigger → plateau |
| Front longitudinal rails | 40–70 kN per rail, progressive fold; carry most frontal energy [04] | `railL/R` at z = 0.68 (rear end only) + bF→wF→eng→rail chain | rail band 0.336 m; rail–cell 14 k/28 k | **Mis-placed.** No rail runs from the crash box to the dash; the load goes through the fender and the engine |
| Subframe | Lower load path, carries the engine and the arms | **MISSING**; hFL–hFR 16 k/36 k + hub–engine stand in | — | Partial |
| Engine / powertrain | Non-crushing, redirects load into the rails [04] | `engineL/R` 2×88 kg, pair beam 42 k/90 k (lattice only) | soft 0.16, band 0.235 m; kill at 0.3 m (unsigned) | **Wrong.** Two independent particles in shape mode; part of the bumper cluster. Measured: block moved +0.37 m *forward* in wall56, and that killed the drivetrain |
| Strut towers / upper load path | Stiff tower plus shotgun rail | `wingFL/FR` + hub–wing 9 k/20 k | wing band 0.68 m | Acceptable; wing doubles as tower |
| Firewall / dash / toe-board | ≈ 0–20 mm intrusion at 56 km/h [09]; IIHS Good < 5 cm [09] | `railL/R` + rL–rR 25 k/56 k + cell cap 0.12 | rail–cell shorten ≤ 0.38 | OK (measured rail shortening vs cell ≤ 0.01 m in walls, ≤ 0.66 m in head-ons) |
| A-pillars | Near-zero intrusion [04]; IIHS hinge pillar Good < 5 cm [09] | No node; roof–engine beams + door cluster | — | Missing node. Skin in the cabin span moves 0.10–0.35 m (measured) |
| B-pillar / door ring | Side MDB 50 km/h: IIHS Good ≥ 12.5 cm left to seat centre line [10] | `doorL/R` (22 kg) | latCap 0.11 m; door band 0.278 m | Cap is plausible but a global cap. The energy goes into the ends (measured) |
| C-pillar | Stiff ring | **MISSING** | — | Missing (only roof/door clusters) |
| Sills / rockers | Very stiff; IIHS rocker lateral 1–3 cm [09] | `skirtL/R` cages + sensors 14/15, no mass | cage absorption 0.22 | Missing node. Sill line is hubR–door + rail–door beams |
| Roof rails / bows | FMVSS 216a ≥ 3× weight within 127 mm; IIHS Good ≥ 4× [11] | `roof` 32 kg, cell–roof 42 k/98 k | maxDy 0.07 m hard clamp | Over-strong but harmless. Measured: 4× weight → 0.030 m; any load → ≤ 0.068 m |
| Floor / tunnel | Safety cell, an order of magnitude stiffer than the crumple zone [04] | `cell` 260 kg | cap 0.12 m, maxDy 0.06 | OK |
| Door intrusion beams | Part of the door | `doorL/R` + dL–dR 8 k/40 k (cross-car) | — | OK |
| Hinges / latches | FMVSS 206: 11 kN longitudinal, 8.9 kN transverse; doors must stay closed [12] | `car.ts` door hinge | swings open with `hingeT·1.45` rad; detaches at hingeT > 0.58 | **Too weak.** Door detaches in frontal hits ≥ 35 km/h (measured) |
| Hood latch / hinge | Hood buckles and stays mostly latched [04] | `cowl` hinge | detaches at > 0.78 | OK (max measured 0.67 in offset64; no run detached the hood) |
| Mirrors | Fold or break away under side contact [04] | two-point on the door | never "on hit" | **Broken** (hingeT 0 in all runs) |
| Lamps | Break in nose/tail contact | sensor/part > 0.18 | — | OK (break from 20 km/h) |
| Wheels / suspension | Displaced or separated mainly in small overlap [04] | hubs pinned until 0.14 m, k 11000 c 260 | — | Wrong place. Never pop in wall or offset hits; both front hubs pop in a 2×28 km/h head-on |
| Rear rails / crash cans | Softer than the front, shorter stroke [04] | bR*, tank, axleR; `chassisRear` 0.30/0.5 | bumper band 0.84; tank/axle 0.365 | Too stiff, and inverted: rear50 shortens the **nose** 0.14 m |
| Fuel tank | Protected by the rear structure (FMVSS 301, 80 km/h MDB) [11] | `tank` 48 kg, cell–tank 28 k/70 k | — | OK |
| Mass / weight split | 1400–1600 kg; FWD ~60/40 | 858 kg; 58.4 % front | — | OK. Forces are tuned to this mass |

---

## 3. Measured crashes

### 3.1 Harness

Script: `.bench/rig-crash.ts`, deleted after the run. It is a line-by-line copy
of the frame and contact order in `engine.ts`:

- `engine.ts:tickInner` — the `physicsSlice` loop, then `cutDrive`, then
  `bleedAfterSlide` after 0.2 s of wall time.
- `engine.ts:fixedStep` — 3 slices near the wall, `collideWith`, 3 SAT passes
  when busy, `resolveBarrier` twice, `resolveCarPair`, `resolvePoles`, then
  `stepStructure → syncPose → clipCarToBarrier → afterContacts`.
- `engine.ts:resolveBarrier` and `engine.ts:resolvePoles`, as written.

The cars are real `DeformableCar`s in `shape` mode (the game default), with
squash 0.4 and buckle 0.45. The frame rate is 60 fps.

- `slomo=1` copies `beginCinematic`: `IMPACT_SCALE = 0.032` from contact, then
  back to 1× after 6.5 s of wall time (the `updatePhase` hold).
- `slomo=0` is `autoSlomo` off.
- Each run lasts 1.5 s of sim time after contact.

Differences from the game: the jersey slab is fixed (no `barrierVel`, no
`indentBarrier`), and there is no `maybePreSlowmo`.

Metrics (all relative to the **cell** mass, in metres):

- `nose` = `2.00 − (bumperF*.z − cell.z)` (positive = shorter). `tail` uses
  the rear bumpers, rest gap 2.12.
- `engine` = `1.16 − (engine.z − cell.z)` (positive = pushed back).
- `door` = lateral door inward motion. `roof` = roof drop.
- `COM travel` = how far the group moved along its approach axis after first
  contact.
- `pulse` = time to reach 95 % of the COM Δv; `avg g` = 0.95·Δv / pulse.
- `past wall` = how far a mass half-sphere penetrates the slab face.
- `skin cabin` = the largest inward motion of any chassis-skin vertex inside
  the `chassisCell` span (z −0.48…0.64, y > 0.2).

Scenarios:

- `wall*`: square, full-width rigid wall at that speed.
- `offset64`: 64 km/h with 40 % overlap on the left; the car runs off the slab
  end (rigid edge, not a deformable barrier).
- `tbone50`: a moving car's nose into a stationary car's right door at 90°.
  Car 1 is the bullet, 858 kg. The real test uses a 1500–1900 kg MDB.
- `side50wall`: the car slides sideways (−x) into the slab at 50 km/h.
- `rear50`: reversing into the slab at 50 km/h.
- `headon28` / `headon56`: two cars, full overlap.
- `pole32`: lateral slide into the engine's lamp pole, which breaks.
  `pole50rigid`: the same pole made unbreakable.

### 3.2 Results (shape mode; full speed unless marked `slomo`; `*` = subject car)

| scenario | COM travel m | pulse ms / avg g | nose max L/R | nose end L/R | tail end | engine max | door max L/R | roof max | skin cabin | past wall | drivetrain | detached | lamps out |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wall20 | 0.21 | 41 / 13 | 0.08 / 0.12 | 0.06 / 0.08 | −0.01 | 0.01 | 0.00 / 0.00 | 0.02 | 0.02 | 0.35 | alive | bumperF | headL |
| wall35 | 0.16 | 17 / 55 | 0.18 / 0.17 | 0.16 / 0.13 | −0.01 | 0.01 | 0.00 / 0.00 | 0.04 | 0.09 | 0.37 | alive | bumperF, **doorL** | headL |
| wall48 | 0.16 | 17 / 76 | 0.13 / 0.09 | 0.07 / 0.00 | −0.02 | 0.02 | 0.01 / 0.02 | 0.03 | 0.10 | 0.45 | alive | bumperF, **doorL** | headL |
| **wall56** | 0.17 | 14 / 110 | 0.14 / 0.04 | **0.04 / −0.05** | 0.00 | 0.02 (min **−0.37**) | 0.01 / 0.04 | 0.04 | 0.13 | **0.48** | DEAD | bumperF | headL |
| wall56 slomo | 0.17 | 12 / 126 | 0.08 / 0.26 | −0.07 / 0.05 | 0.13 | 0.02 | 0.00 / 0.02 | 0.02 | 0.10 | 0.25 | alive | bumperF | headL |
| wall64 | 0.15 | 13 / 135 | 0.16 / 0.04 | −0.01 / −0.07 | 0.05 | 0.03 | 0.00 / 0.03 | 0.05 | 0.16 | 0.49 | DEAD | bumperF, **doorL** | headL |
| wall80 | 0.09 | 8 / 252 | 0.23 / 0.02 | 0.08 / −0.21 | 0.06 | 0.04 | 0.03 / 0.06 | 0.05 | 0.35 | 0.57 | DEAD | bumperF | headL |
| **offset64** | 0.15 | 13 / 135 | 0.18 / 0.05 | 0.02 / −0.06 | 0.05 | 0.03 | 0.00 / 0.02 | 0.05 | 0.13 | 0.46 | DEAD | bumperF, **doorL** | headL |
| offset64 slomo | 0.15 | 8 / 200 | 0.12 / 0.10 | −0.20 / −0.21 | 0.03 | 0.02 | 0.00 / 0.00 | 0.01 | 0.07 | 0.34 | DEAD | bumperF, doorL | headL |
| **tbone50** struck* | 8.33 (pushed) | — | 0.01 / **0.33** | −0.13 / 0.06 | **0.32** | 0.01 | 0.02 / **0.11** | 0.01 | 0.31 | — | alive | — | headR, tailR |
| tbone50 bullet | 9.97 | — | 0.71 / 0.74 | 0.35 / 0.62 | 0.10 | 0.26 | 0.03 / 0.11 | 0.01 | 0.41 | — | alive | bumperF; hubFL popped | headL |
| tbone50 slomo struck* | 5.63 | — | 0.01 / 0.55 | −0.08 / 0.39 | 0.33 | 0.06 | 0.04 / 0.16 | 0.01 | 0.24 | — | alive | **doorR**; hubFR popped | headR, tailR |
| **side50wall** | 0.42 | 1055 / 1 | **0.61 / 0.35** | 0.57 / 0.35 | **0.55** | 0.25 | **0.11** / 0.00 | 0.01 | 0.31 | 0.56 | alive | doorL | headL, tailL |
| side50wall slomo | 0.42 | 761 / 2 | 0.56 / 0.28 | 0.43 / 0.28 | 0.27 | 0.18 | 0.11 / 0.02 | 0.01 | 0.28 | 0.56 | alive | doorL | headL, tailL |
| pole32 (breakable) | 4.84 | 859 / 1 | 0.02 / 0.01 | −0.01 / 0.00 | −0.01 | 0.01 | 0.01 / 0.05 | 0.00 | 0.27 | — | alive | — | headR, tailR |
| pole50rigid | 0.07 (pinned, v still 12.4 m/s) | — | 0.01 / 0.01 | 0.01 / 0.01 | −0.02 | 0.01 | 0.00 / 0.01 | 0.00 | 0.22 | — | alive | — | headR, tailR |
| **rear50** | 0.10 | 12 / 114 | **0.14 / 0.14** (nose!) | 0.14 / 0.14 | −0.00 (max 0.07) | 0.12 | 0.00 / 0.01 | 0.02 | 0.07 | 0.53 | alive | bumperR, trunk | tailL |
| rear50 slomo | 0.10 | 8 / 162 | 0.11 / 0.11 | −0.01 / −0.01 | 0.15 | 0.01 | 0.00 / 0.00 | 0.01 | 0.12 | 0.47 | alive | bumperR | tailL |
| **headon28** car0* | 2.71 | 1333 / 1 (peak 6.3) | **1.14** / 0.48 | 1.14 / 0.47 | −0.04 | 0.61 | 0.00 / 0.00 | 0.09 | **0.83** | — | DEAD | bumperF; hubFL+FR popped | headL |
| headon28 car1 | 1.50 | 1317 / 1 | 0.48 / 0.69 | 0.48 / 0.68 | −0.03 | 0.39 | 0.02 / 0.03 | 0.02 | 0.42 | — | DEAD | bumperF, doorR; hubFL+FR | headR |
| headon28 slomo car0* | 0.78 | 926 / 1 | 1.14 / 0.48 | 1.00 / 0.34 | 0.01 | 0.49 | 0.09 / 0.04 | 0.04 | 0.73 | — | DEAD | bumperF, doorL; hubs F | headL |
| headon56 car0* | 5.56 | 1242 / 1 (peak 20) | 1.14 / 0.47 | 1.04 / 0.38 | 0.02 | 0.62 | 0.08 / 0.09 | 0.07 | 0.82 | — | DEAD | bumperF, doorL; hubs F | headL |
| headon56 slomo car0* | 0.75 | 470 / 3 | 1.13 / 0.46 | 1.00 / 0.35 | 0.01 | 0.61 | 0.02 / 0.10 | 0.03 | 0.85 | — | DEAD | bumperF, doorL; hubs F | headL |

Lattice mode, full speed (Appendix A1):

- wall56: COM travel 0.18 m, pulse 14 ms, nose max 0.32 / 0.01, nose end
  0.21 / −0.06, past wall 0.59 m, drivetrain DEAD.
- side50wall: nose 0.79 m.
- headon28: 1.13 m corner crush, both drivetrains DEAD.

Lattice behaves the same way as shape mode in these cases.

Glass: the windscreen (pane 0) cracks at 56–80 km/h wall and offset hits. The
door and quarter glass on the hit side cracks or shatters in side and head-on
cases. Mirrors stayed at `hingeT = 0` in every run.

Static roof press (Appendix A2): a downward kick on the roof mass for 1 s at
1×, 4×, 10× and 40× vehicle weight (8.4–337 kN).

- Shape mode: the roof drops 0.015, 0.030, 0.061 and 0.068 m relative to the
  cell.
- Lattice mode: 0.068 m at every load.

0.068 m is the `clampLocal` roof `maxDy` (0.07) less the cell's 0.06.

### 3.3 Rig vs. real targets

| metric | real target | rig (measured) | ratio |
|---|---|---|---|
| 56 km/h wall dynamic crush (COM travel after contact) | 0.35–0.55 m [09] (0.4–0.6 m [04]) | 0.17 m | ×0.3–0.5 |
| 56 km/h permanent crush | 0.25–0.45 m [09] | 0.04 / −0.05 m (L/R nose vs cell) | ≈ 0 (nose lengthened on R) |
| Crush vs speed, 20→80 km/h | ∝ v (linear-spring model) | 0.21 → 0.09 m (flat or falling) | wrong trend |
| 56 km/h pulse / average / peak | 90–140 ms / 18–25 g / 30–45 g [09] | 14 ms / 110 g / 126 g (10 ms window) | ×7–10 too hard |
| Rebound | 1–4 m/s [09] | cell mass reads −3.3…−5 m/s for 0.5 s while pinned, then the group jumps 0.14 m back (trace A4) | inconsistent |
| Footwell / A-pillar intrusion | 0–20 mm (56 km/h); IIHS Good < 5 cm [09] | rig rail/door/roof vs cell ≤ 0.06 m (wall80); **skin** 0.13 m at 56 km/h | rig OK; skin not |
| 64 km/h offset, struck-side residual | 0.30–0.60 m [09] | 0.02 m (L nose vs cell) | ≈ 0 |
| Side 50 km/h: B-pillar / door | IIHS Good: ≥ 12.5 cm left to seat centre line (≈ 0.15–0.25 m intrusion allowed) [10] | door 0.11 m (cap); nose 0.33–0.61 m, tail 0.32–0.55 m | door OK, ends wrong |
| Rear crush | shorter stroke than the front, softer [04] | tail 0.07–0.15 m, **nose 0.14 m** | inverted |
| Roof | ≥ 3× (FMVSS 216a), ≥ 4× Good within 127 mm (IIHS) [11] | 4× → 0.030 m; hard limit 0.07 m | passes (no rollover path exists) |
| Car-car 2×28 km/h (≈ 28 km/h barrier-equivalent) | ≈ 0.25–0.3 m (scaling 0.55 m @ 56) | 1.14 m hit corner, 0.48 m other | ×4 too soft |
| Car-car 2×56 km/h | ≈ 0.55 m each | 1.13 m (the same: capped) | no speed scaling |
| Doors | stay latched (FMVSS 206: 11 / 8.9 kN) [12] | doorL detaches in frontal hits at 35/48/64 km/h and in head-ons | wrong |
| Wheels | separate mostly in small overlap [04] | pop in 2×28 head-ons; never in offset64 | wrong place |
| Drivetrain | — (design target `barrier.test.ts`: alive at 35, dead at 62 km/h) | alive ≤ 48, dead ≥ 56 km/h; but caused by **forward** block motion; slomo wall56 alive | right threshold, wrong mechanism |

---

## 4. Gaps, ranked by visible impact

1. **G1 — Wall hits do not crumple, and the nose clips through the slab.** This
   is visible in every barrier run.
   - The masses penetrate the slab face by 0.35–0.57 m.
   - The permanent nose crush is about 0.
   - The nose stretches forward relative to the cell, and that stretch also
     kills the drivetrain.

   Cause: `sat.ts:clipCarToBarrier` stops the group at a fixed 0.26 m approach
   (`bumperKeep`), and `kickCore` stops the cell. Nothing collides the masses
   with the slab. The `leftover` that should open the clip toward `cabinKeep`
   comes from `crumpleTravelCorner`, and that never drops because the nose
   never shortens.
2. **G2 — Car-car crush is ×4 too soft, ignores speed, and one-sided.**
   - The `clampLocal` cap (1.06 m) is reached at 2×28 km/h.
   - `feedOverlap` crush does not depend on the share each car takes.
   - The L/R split SAT hulls put the contact at x = ∓0.49, which defeats
     `snapImpactToNearestMass`'s centre rule (`|x| < 0.2`). Full-overlap hits
     become corner hits and sideswipes (cars travel 1.5–5.6 m past contact).
3. **G3 — Side impacts fold the ends.** `clampLocal` `latCap ≤ 0.11 m` limits
   every node's x travel. The residual motion goes along z: nose 0.33–0.61 m,
   tail 0.32–0.55 m.
4. **G4 — Doors detach in frontal hits** at ≥ 35 km/h. In `car.ts`, the
   door's on-hit test lets compression alone (`crush > 0.16`) open it, with no
   side check. Real doors stay latched (FMVSS 206) [12].
5. **G5 — Skin cabin intrusion.** `buildSkinWeights` blends up to 4 nearest
   clusters by centre-of-mass distance (< 1.45 m), so A-pillar and footwell
   skin follows the front clusters. This produces 0.13 m of skin intrusion at
   56 km/h, 0.35 m at 80 km/h and 0.83 m in a 2×28 head-on, while the cell
   particles move ≤ 0.04 m.
6. **G6 — `clusterBeta` index mismatch and duplicate clusters** (§1.8).
   - The front corners are stiffened with glass absorption (0.48/0.50).
   - The right cabin cluster gets door absorption (0.22) while the left gets
     roof absorption (0.52), so the cabin's stiffness is asymmetric L/R.
   - The engine/rail/wing triplets are solved 3× each side.
7. **G7 — Rear hits shorten the nose** (0.14 m) and barely the tail (0.07 m).
   This is the mirror image of G1.
8. **G8 — Bumper, headlamp and wheel detachment rules ignore speed.**
   - The bumper detaches at 20 km/h.
   - Both front hubs pop in a 2×28 head-on.
   - No hub pops in a 64 km/h offset hit, where real cars lose wheels.
9. **G9 — Mirrors never fold or break.** The `syncAttachedParts` and
   `evaluateBreakage` on-hit tests measure the mirror's `restPos` in door
   space.
10. **G10 — The pulse is too hard and differs between full speed and slomo.**
    The pulse is 8–41 ms where 90–140 ms is real. At 56 km/h the drivetrain
    dies at full speed (engine travel 0.32 m) but stays alive in slomo
    (0.17 m). Offset64 in slomo leaves the nose 0.20 m *longer* than rest.
11. **G11 — Engine block is not rigid.** In shape mode there is no
    engineL–engineR constraint. The bumper cluster (ci 0) contains both engine
    halves, so a bumper fold drags the block.
12. **G12 — Lamp poles never dent doors.** `resolvePoles` gives a single
    ≤ 400 N·s kick and breaks the pole at 3.5 m/s. A rigid pole pins the group
    while `car.velocity` stays at 12.4 m/s. This only matters if poles become
    a side-impact prop.

---

## 5. Implementation spec (for a later lane)

The numbers below are starting values, chosen to land inside the cited
ranges. Every new behaviour gets a test in the existing suites. The scenarios
should use the `engine.ts:fixedStep` order (as in §3.1). `barrier.test.ts`
`spawnAtBarrier` + `runFor` is close enough for wall cases. For pairs,
`pair-contact.ts:stepCarPair` is already the same order.

Put a reusable `runWall(speedKph, overlap)` / `runPair(...)` helper in a new
`src/game/contact/crash-scenarios.test-util.ts`. It returns
`{ noseShortL, noseShortR, tailShort, comTravel, pulseMs, maxPastFace }`
using the §3.1 definitions. Do not copy the harness into each test.

### A. Rigidity and stiffness ratios

**A1 — Mass-level slab contact (fixes G1, G7, G10).**

- *Where*:
  - new `StreamedDeformation.projectOutOfBox(cx, cz, hx, hz, yaw, dt): number`
    in `streamed-deform.ts`;
  - called from `engine.ts:resolveBarrier` right after `feedOverlap`;
  - call it the same way in `barrier.test.ts:stepBarrier`.
- *Change*:
  - For every dynamic, non-pinned-hub mass whose sphere (use `0.5·radius`)
    crosses the slab's near face, set `world` back onto the face and remove
    the inbound normal component of `vel`.
  - Return the summed removed momentum (Σ m·Δv) so the caller can add it to
    the `cancelClosing` budget, which keeps momentum.
  - Reuse module temporaries; no allocation. It is the same pattern as
    `compactor.ts:enforceWalls`.
- *Then* in `sat.ts:clipCarToBarrier`:
  - Change `bumperKeep` to `hx + 0.22 + alongFwd·0.85·leftover`, so the clip
    opens as the nose actually shortens.
  - Compute `leftover` from the projected masses. With A1, `crumpleTravelCorner`
    becomes truthful.
  - Keep `cabinKeep = hx + 1.08` as the tunnelling floor.
- *Acceptance* (`barrier.test.ts`, new `describe("rigid wall crush matches a sedan")`):
  - `good`: 56 km/h square wall, `runFor(car, 1.3, 1/60)`. Permanent nose
    shortening vs the cell is in [0.25, 0.50] on both corners. No mass centre
    goes more than 0.05 m past the face. COM travel after contact is in
    [0.35, 0.60].
  - `good`: the pulse to 95 % Δv is in [60, 150] ms at 56 km/h.
  - `close-but-wrong`: COM travel grows with speed:
    `travel(35) < travel(56) < travel(80)`.
  - `bad`: a 50 km/h reverse into the wall shortens the tail ≥ 0.15 m and the
    nose ≤ 0.03 m.
- *Risk*:
  - `barrier.test.ts` `engine disable speeds`: the engine will now travel
    *backward*, so retune `ENGINE_KILL_TRAVEL` (see A2).
  - `jersey barrier full-speed vs slomo` (no tunnelling) has to stay green;
    `cabinKeep` is unchanged.
  - `crash-physics.test.ts` uses `stepWall` (feedOverlap only) and is not
    affected.
  - Perf: 20 sphere-vs-plane checks per slice per car. Negligible.

**A2 — Signed engine travel (fixes the G1/G10 drivetrain mechanism).**

- *Where*: `streamed-deform.ts:updateDrivetrain`.
- *Change*:
  - Travel = `max over engineL/R of ((m.rest − m.local) − (cell.rest − cell.local))·(−impactInward)`.
    That is the rearward motion toward the cell along the hit, ignoring
    forward stretch.
  - Keep `ENGINE_KILL_TRAVEL` and retune after A1 so that `barrier.test.ts`
    still holds: 35 km/h alive, 62 km/h dead, rear 40 km/h alive.
  - The ESV 98S3P12 comment band (0.23 m at 35, 0.40 m at 62 km/h) becomes
    rearward travel. Starting value: 0.30.
- *Acceptance* (`crash-physics.test.ts`, `forModes("drivetrain")`): `bad`: an
  engine displaced 0.35 m *forward* of rest (cell at rest) leaves
  `drivetrainAlive` true after `stepStructure(1/60)`. Plus the three existing
  `barrier.test.ts` speed cases.
- *Risk*: `just under ENGINE_KILL_TRAVEL is alive; just over is toast`
  (crash-physics) sets `eng.local` directly. Re-pin it along −inward.

**A3 — Rigid engine block, decoupled from the bumper (fixes G11).**

- *Where*:
  - `streamed-deform.ts:stepMassSlice` (both modes);
  - the `cageClusterIndices` fallback;
  - the constructor's `extra` list.
- *Change*:
  - After `stepShapeMatch`/`stepBeams`, project `engineL–engineR` back to its
    rest distance (0.60 m ± 2 %), mass-weighted.
  - In `cageClusterIndices`, skip `engine*` when the cage is `bumperFront`, so
    cluster 0 becomes `{bFL, bFR}` plus the new crash-box nodes from A4.
- *Acceptance* (`crash-physics.test.ts`): `good`: after a 56 km/h corner
  wall (A1 harness), `|engineL − engineR|` is within 0.012 m of 0.60.
- *Risk*: `shape-match.test.ts` cluster-count assumptions, if any. Check
  `snapshot().clusters` consumers.

**A4 — Crash-box / rail-tip nodes (fixes the missing staged load path).**

- *Where*:
  - `streamed-deform.ts`: `MassName`, `MASS_SPECS`, `BEAM_SPECS`, the `extra`
    clusters;
  - `physics-core.js:regionSoftness`;
  - `physics-core.d.ts` if typed.
- *Change*:
  - Add `crashBoxL/R` at (∓0.52, 0.38, 1.80), 6 kg each. Take 6 kg from each
    `engine*` (88 → 82) so the total stays 858 kg and the 58 % front share
    holds.
  - `regionSoftness`: return 0.6 for `crashBox*`, placed before the `rail`
    check. Band max is 0.55 m.
  - Beams:
    - `bF*–crashBox*` [2500, 5000, 0.6]
    - `crashBox*–rail*` [6000, 12000, 0.55]
    - `crashBox*–wingF*` [3000, 6000, 0.6]
    - `crashBox*–engine*` [2500, 5000, 0.7]
    - `crashBoxL–crashBoxR` [1500, 3000, 0.4]
  - Replace the extra clusters `[bF*, wF*, eng*, rail*]` with
    `[bF*, crashBox*, wF*, rail*]`.
- *Acceptance*:
  - (`crash-physics.test.ts`) `good`: the stiffness order on a 14 m/s frontal
    `stepWall` pulse is bumper > crashBox > rail travel.
  - (`crash-parts.test.ts`) the banana-lattice cases still pass.
  - `every mass is connected to the cell` (crash-physics) still passes.
- *Risk*:
  - HUD and trace consumers that index masses (search for `masses[` and
    `mass index`).
  - `crash-physics.test.ts` `totalMass ... 600–1200` is still fine.
  - About 10 % more particle work in `stepShapeMatch` and `collideWith`.
    Re-run `npm run bench`.

**A5 — Per-cluster absorption and de-duplicated clusters (fixes G6).**

- *Where*: `streamed-deform.ts` constructor and `clusterBeta`.
- *Change*:
  - Build `private clusterAbsorb: Float64Array` alongside `this.clusters`.
    Each cage cluster (both L/R halves) gets its own cage's absorption.
    Extras get explicit values: front corner 0.14, rear corner 0.16, cabin
    sides 0.72.
  - `clusterBeta(ci)` reads `clusterAbsorb[ci]`.
  - Before pushing a cage cluster, skip it if its sorted index set equals one
    already pushed. This drops clusters 6, 7, 10 and 11.
- *Acceptance* (`shape-match.test.ts` or `crash-physics.test.ts`):
  - `bad`: no two clusters share the same mass set (`snapshot().clusters`
    names, sorted).
  - `good`: a right-front 14 m/s corner hit gives the FR corner a larger
    plastic trace deviation than the cabin cluster.
- *Risk*: stiffness shifts. Re-check `crash-parts.test.ts` "squash=0.7
  crushes the hit corner more" and the `fleet` and `derby` durability tests.

### B. Crumple / bend tolerances and fold behaviour

**B1 — Energy-share crush scaling for car-car hits (fixes G2).**

- *Where*:
  - `car.ts:applyImpact`, add a required parameter
    `ebs: number` (equivalent barrier speed);
  - `StreamedDeformation.beginCrush` stores it as `hitSpeed`;
  - update every caller: `engine.ts:resolveBarrier`, `resolvePoles`,
    `resolveBalls`, `pair-contact.ts:resolveCarPair`, and the tests that call
    `applyImpact`.
- *Change*:
  - Wall/prop: `ebs = closing`.
  - Pair: `ebs = closing · m_other / (m_self + m_other)` (= closing/2 for equal
    cars).
  - In `clampLocal`, scale the non-bidirectional crush cap to
    `min(maxCrush·(0.38+0.72·cw), 0.035·ebs + 0.02)`. That gives 0.57 m at
    15.6 m/s and 0.29 m at 7.8 m/s, matching 0.55 m @ 56 km/h [09].
- *Acceptance* (`crash-parts.test.ts`, new
  `forModes("car-car crush scales with speed")` using `stepCarPair` for 1.5 s):
  - 2×28 km/h: each car's max nose shortening vs the cell is in [0.15, 0.40].
  - 2×56 km/h: in [0.35, 0.70].
  - `close-but-wrong`: 2×56 > 1.4 × 2×28.
- *Risk*:
  - `fleet.test.ts` and `derby.test.ts` durability (derby cars are tuned
    "durable" in commit 721a2fe). Derby already caps damage elsewhere;
    re-run them.
  - `ENGINE_LIGHT_CAP` gate `hitSpeed < 15.5`: 2×28 km/h is 15.56 m/s closing,
    just above it, so the gate is effectively an off-by-0.06 today. With
    `ebs`, compare against 15.5 using the per-car share.

**B2 — Square hits stay centred (fixes the asymmetric half of G2 and G1).**

- *Where*: `sat.ts:satCarBarrier` and `sat.ts:satCars`, the contact-point
  choice.
- *Change*: when both front split crush hulls (`CRUSH_HULLS[0]` and `[1]`) are
  in contact, or both rear ones, and their penetrations are within 30 % of
  each other, return the midpoint of the two contact points. Then the existing
  `snapImpactToNearestMass` centre rule (`|x| < 0.2`) applies.
- *Acceptance* (`barrier.test.ts`): `good`: a 56 km/h square wall shortens FL
  and FR to within 25 % of each other. Today it is 0.14 vs 0.04.
  `crash-parts.test.ts`: `good`: a 2×28 head-on gives `|impactLocal.x| < 0.2`
  on both cars.
- *Risk*:
  - `barrier.test.ts` "offset +Z hit crushes the corner on the slab" must still
    pick a corner (one hull only, so unaffected).
  - `crash-physics.test.ts` impact-snap cases call `spawn(x)` directly and are
    unaffected.

**B3 — Lateral crush in the hit frame (fixes G3).**

- *Where*: `streamed-deform.ts:clampLocal`.
- *Change*:
  - Split each node's planar displacement into `along` (·impactInward) and
    `perp`.
  - Apply the crush `cap` to `along`. Apply `latCap` (0.04 + 0.07·cw) to
    `perp`.
  - For door, skirt and cell-side nodes on side hits
    (`|impactInward.x| > |impactInward.z|`), cap `along` at
    `bands.max = 0.278 m` (doors). That gives about 0.12 m left to a 0.4 m
    seat centre line, which is IIHS Acceptable/Good [10].
- *Acceptance* (`barrier.test.ts`, new side case: the car slides −x into the
  slab at 50 km/h, yaw 0):
  - doorL inward vs the cell is in [0.12, 0.28];
  - nose and tail shortening are each < 0.10;
  - cell travel < 0.12.
- *Risk*:
  - `crash-physics.test.ts` "a right-side inward crushes doorR/wingFR more
    than the left" must still pass.
  - `crash-parts.test.ts` "right-side hit opens the right door" depends on
    door compression, which goes up.

**B4 — Rear softer than front, with a shorter stroke.**

- *Where*: `physics-core.js:regionSoftness`, plus `CAGES` `bumperRear` and
  `chassisRear`.
- *Change*:
  - Split `bumper*`: `bumperR*` → 1.0 (as now); `bumperF*` stays at 1.0.
  - `tank`/`axleR` → 0.4 (band max 0.41 m).
  - `chassisRear.maxCrush` 0.5 → 0.45, so the rear zone yields earlier but
    over less length.
  - Only after A1, when the rear can actually be measured.
- *Acceptance* (`barrier.test.ts`, A1 harness): at 50 km/h, rear tail
  shortening is in [0.6, 1.0] × the front nose shortening at 50 km/h, and the
  cell moves < 0.06 m.
- *Risk*: `barrier.test.ts` "backing into the wall well under 80 km/h does not
  kill the block" stays true after A2, which makes the travel signed.

**B5 — Pulse shape.** After A1 and B1 the pulse is set by crush length:
≈ 2·D/v = 70 ms at 56 km/h. This needs no separate change; it is checked by
A1's pulse test. Do not change `CRASH.pulseSec`, which drives FX timing.

### C. Detachable parts

**C1 — Doors stay latched unless struck from the side (fixes G4).**

- *Where*: `car.ts:syncAttachedParts` and `car.ts:evaluateBreakage`.
- *Change*: a door is "on hit" only when the hit is on its side:
  `sign(impactInward.x) === −sign(restPos.x)` and
  `|impactInward.x| > |impactInward.z|`.
  - On frontal or rear hits, cap the door's `hingeT` target at 0.2. That leaves
    it jammed ajar, the "partially open" case in [04].
  - On side hits, detach only when `hingeT > 0.58` **and**
    `deform.impulseValue ≥ 12.5` m/s (45 km/h).
- *Acceptance* (`barrier.test.ts`): `bad`: 35, 48 and 64 km/h frontal walls
  and offset64 detach no door. Today doorL detaches at all four.
  `crash-parts.test.ts` "right-side hit opens the right door, not the left"
  still holds.
- *Risk*: the HUD/FX door-pop moments in head-ons go away. That is intended.

**C2 — Bumper detaches by speed (fixes G8 for bumpers).**

- *Where*: `car.ts:evaluateBreakage`.
- *Change*: the `bumperF`/`bumperR` detach rule becomes
  `hingeT > 0.7 && hitSpeed ≥ 8.3` m/s (30 km/h). Below that the bumper folds
  (scaled as now) and stays attached. IIHS low-speed protocols treat cover
  tears ≤ 1 cm as normal damage at bumper-test speeds [12].
  Expose `hitSpeed` through a getter beside `impulseValue`.
- *Acceptance* (`barrier.test.ts`):
  - `good`: a 20 km/h wall leaves `bumperF` attached with `hingeT > 0.1`.
  - `good`: a 56 km/h wall may detach it.
  - `crash-parts.test.ts` "front bumper folds then can detach on a hard nose
    hit" (impulse 40) still passes.
- *Risk*: none known.

**C3 — Mirrors fold and break on side contact (fixes G9).**

- *Where*: `car.ts:syncAttachedParts` and `car.ts:evaluateBreakage`.
- *Change*: for `mirror*`, compute the on-hit test from the car-space position
  `doorX.position + restPos`, not `restPos`. Equivalently, treat a mirror as
  on hit when its door is on hit (C1 side rule).
  - Fold target is `(max(sensor 6/7, sensor 4/5) − 0.04)/0.3`.
  - Detach at `hingeT > 0.5` (unchanged).
- *Acceptance* (`crash-parts.test.ts`): `good`: the existing "right-side hit"
  scenario (`applyImpact` at `right·0.9`, 45 frames) leaves `mirrorR.hingeT
  > 0.3` and `mirrorL.hingeT === 0`.
- *Risk*: none.

**C4 — Wheel separation where real cars lose wheels (fixes G8 for hubs).**

- *Where*: `streamed-deform.ts:clampLocal`, in the hub pop rule.
- *Change*:
  - A hub pops only when its planar travel is > 0.14 m **and**
    `cornerWeight(hub) > 0.6` **and** `hitSpeed ≥ 15` m/s (54 km/h, using
    B1's `ebs`).
  - Otherwise let the hub travel up to 0.10 m rearward and stay attached
    (wheel pushed back).
  - Small-overlap hits (`|impactLocal.x| > 0.5`) at ≥ 15 m/s may pop the
    hit-side front hub.
- *Acceptance*:
  - (`crash-parts.test.ts`) `bad`: a 2×28 km/h head-on (`stepCarPair`, 1.5 s)
    pops no hub. Today both front hubs pop.
  - `good`: a 64 km/h 25 %-overlap wall pops the struck-side front hub.
- *Risk*: `crash-physics.test.ts` "hubs stay planted until they pop": the
  "0.2 m xz shove on one hub pops it" case needs `hitSpeed ≥ 15` set in its
  spawn, or it should be reframed as a high-speed shove.

**C5 — Keep:** the hood `cowl` and trunk `tail` rules (hood measured ≤ 0.67,
never detached at 56–64 km/h; real hoods buckle and stay latched [04]), the
lamp break rule, and the glass crack/shatter rule.

### D. Cabin integrity

**D1 — Cabin skin follows the cell (fixes G5).**

- *Where*: `streamed-deform.ts:buildSkinWeights`.
- *Change*: for vertices whose rest position is inside the `chassisCell` cage
  span (x ±0.66, y 0.2…1.06, z −0.48…0.64), only consider clusters that
  contain `cell`. That is ci 4, 5, 12, 13, 14, 20 and 21 at base; re-derive
  them after A5.
  - Blend in at most 25 % from the nearest non-cell cluster within 0.3 m of
    the span's front or rear face, so the A-pillar foot still creases.
- *Acceptance* (`rest-mesh.test.ts` or `crash-physics.test.ts` with the real
  chassis geometry from `car-mesh.ts:makeChassisGeometry`): `good`: after a
  56 km/h wall (A1), no chassis vertex in the span moves more than 0.06 m
  inward relative to the cell (today 0.13 m, 0.35 m at 80 km/h).
- *Risk*: a visible seam at the span faces. Check the side silhouette
  screenshot in `rest-mesh.test.ts`. Skin cost is unchanged.
- *Done* (lane shape-core-2): the span is the cage's z span above its floor at
  any x, because the cage box itself holds only 3 of the 1431 body-skin vertices
  (the skin sits outboard of x ±0.66); the section holds 415. Cell clusters are
  the ones whose mass set contains `cell`. Skin inward/downward motion relative
  to the cell (`CrashResult.skinCabin`): 0.072 → 0.037 m at 56 km/h, 0.121 →
  0.051 m at 80 km/h, 0.038 → 0.032 m in a 2×28 head-on. Rearward skin travel
  at the A-pillar foot (≈ 0.11 m at 56) follows the cell clusters' own fit and
  is unchanged.

**D2 — Keep the cell caps** (`clampLocal` cell/roof cap 0.12 m, `maxDy`
0.06/0.07, `deepCrush` exceptions). Measured: door/roof control particles move
≤ 0.06 m relative to the cell in shape-mode wall and rear cases (≤ 0.07 m lattice), ≤ 0.10 m in
head-ons. That meets the "minimal intrusion" target [04][09].

### E. Do NOT change

- **Mass totals and distribution** (`MASS_SPECS`: 858 kg, 58.4 % front).
  Every force constant is tuned to this mass.
- **Cabin rigidity**: `cell`/`roof` caps, `cell–roof` 42 k/98 k, the
  `chassisCell` absorption of 0.72, and `kickCore`'s cabin-only weighting. They
  already meet the targets.
- **Roof** `maxDy` 0.07. It meets IIHS Good (4× weight → 0.030 m; the limit is
  0.127 m) [11], and there is no rollover path to tune against.
- **Hub planting** in `followGroup`/`clampLocal` (`quietTime > 0.2`). It stops
  the post-crash ratchet. C4 changes only the pop rule.
- **`barrier.test.ts` drivetrain speeds** (35 alive, 62 dead, rear 40 alive).
  These are design targets. A2 changes the mechanism, not the targets.
- **Shape-match kernel parameters** (`applyPlasticity` `yieldC` 0.105, creep
  0.0915/slice, `maxE` 0.58; `stiffnessIters` 4; `goalAlpha` 0.592). The
  measured defects come from contact and clamps, not from the kernel.
- **Hot-path rules**: A1, A3 and B3 add no per-frame allocation. They reuse
  module-level `_a…_n` temporaries.

### Suggested order

A1 + A2 together, then B2, then B1, B3, C1, C2, C3, C4, D1, then A3, A4, A5.
Each step should land with its tests green. A1 shifts most of the measured
numbers, so re-measure after it before tuning B1 and B4.

---

## 6. Status after implementation

Lane `crash-realism` landed A1, A2, B1, B2, B3, B4 and the A9 ω×r sign fix
(commits `bc5f81b`, `9b03336` on top of main `53ea0f5`). Lane `crash-realism-2`
then landed C1–C4, A3, A10, A15, the rest of A9, cumulative derby damage and the
wreck-spin fix (§6.1). A4, A5 and D1 belong to the shape-kernel lane.

What changed, in mechanism terms:

- **A1** — `StreamedDeformation.projectOutOfBox` puts every mass whose
  half-radius sphere crosses the slab back on the face and kills its inbound
  speed (local positions follow, so `crumpleTravelCorner` is truthful). The
  slab (`JerseyBarrier.resolve`) then applies a constant crush force
  `m·ebs²/(2·hitStroke)` through `brakeInbound` while a mass rests on the face,
  so the cabin decelerates over the stroke instead of in one clip.
  `clipCarToBarrier` opens `bumperKeep` by `leftover`. `crumpleTravelCorner`
  now reads the struck end only (it took the max over both ends, so it always
  read the untouched end).
- **A2** — `updateDrivetrain` uses rearward engine travel along the hit in the
  cell frame; side hits do not count. The engine moves only once this hit's
  stroke packs the nose against it (`ENGINE_PACK_GAP` 0.54 m, slack 0.04 m);
  `ENGINE_KILL_TRAVEL` is 0.15 m. This replaces `ENGINE_LIGHT_CAP`.
- **B1** — `applyImpact(point, inward, impulse, ebs)`; pairs use
  `ebs = closing·m_other/(m_self+m_other)`. `crushStroke(ebs, squash) =
  (0.035·ebs + 0.02)·(0.6 + squash)` caps each node's crush along the hit
  (0.55 m at 56 km/h, squash 0.4). Crushed nodes keep a permanent set (only
  the last 0.08 m springs back). In car-car, once both strokes are spent the
  packed structures stop the relative closing.
- **B2** — `satCarBarrier` / `satCars` return the midpoint of the two split
  corner contacts when both are hit within 30 % of each other.
- **B3** — `clampLocal` splits travel into `along` (stroke cap) and `perp`
  (`latCap`); side hits cap at the door band (0.278 m).
- **B4** — rear stroke × `chassisRear/chassisFront` maxCrush (0.45/0.55).

Measured with `src/game/contact/crash-scenarios.test-util.ts` (the §3.1 frame order,
full speed, shape mode). Base = main `53ea0f5` with the same harness.

| scenario | COM travel m (base → now) | pulse ms (base → now) | nose end L/R (base → now) | tail end | engine max | past wall, centre | drivetrain | detached (now) |
|---|---|---|---|---|---|---|---|---|
| wall20 | 0.26 → 0.20 | 133 → 100 | 0.09/0.09 → 0.10/0.10 | −0.04 → 0.01 | 0.01 → 0.02 | 0.21 → 0.00 | alive → alive | — |
| wall35 | 0.27 → 0.31 | 100 → 83 | 0.15/0.13 → 0.17/0.15 | −0.03 → 0.02 | 0.01 → 0.03 | 0.23 → 0.00 | alive → alive | — |
| wall48 | 0.30 → 0.45 | 17 → 83 | 0.09/0.00 → 0.24/0.24 | −0.01 → 0.05 | 0.02 → 0.07 | 0.24 → 0.00 | alive → alive | — |
| **wall56** | 0.28 → **0.48** | 33 → **83** | 0.05/−0.04 → **0.28/0.28** | 0.01 → 0.07 | 0.01 → 0.11 | 0.31 → **0.00** | DEAD → alive | bumperF |
| wall64 | 0.30 → 0.55 | 17 → 67 | −0.02/−0.03 → 0.30/0.30 | 0.07 → 0.08 | 0.00 → 0.15 | 0.35 → 0.00 | DEAD → DEAD | bumperF |
| wall80 | 0.34 → 0.68 | 200 → 83 | 0.11/−0.29 → 0.40/0.40 | 0.05 → 0.08 | 0.03 → 0.23 | 0.41 → 0.00 | DEAD → DEAD | bumperF |
| wall56 slomo | 0.28 → 0.39 | 19 → 69 | −0.08/0.04 → 0.27/0.21 | 0.10 → 0.02 | 0.04 → 0.10 | 0.11 → 0.00 | alive → alive | bumperF |
| offset64 40 % | 0.30 → 1.17 | 17 → 133 | −0.01/−0.04 → 0.53/0.33 | 0.07 → 0.00 | 0.00 → 0.34 | 0.27 → 0.24 | DEAD → DEAD | bumperF |
| side50wall | 0.52 → 0.26 | 1133 → 100 | 0.58/0.31 → 0.01/−0.04; door 0.11 → 0.28 | 0.74 → 0.04 | 0.24 → 0.04 | 0.37 → 0.11 | alive → alive | doorL |
| rear50 | 0.24 → 0.24 | 33 → 50 | 0.14/0.14 → 0.01/0.00 | −0.11 → **0.17** | 0.12 → 0.02 | 0.36 → 0.00 | alive → alive | — |
| headon 2×28 | 1.28 → 0.65 | — | max 0.55/0.44 → **0.23/0.23** (impactLocal.x −0.49 → 0.00) | −0.03 → 0.01 | 0.44 → 0.04 | — | DEAD → **alive** | — (base: hubFL+FR popped) |
| headon 2×56 | 1.93 → 0.83 | — | max 0.97/0.45 → **0.55/0.55** | 0.01 → 0.04 | 0.79 → 0.29 | — | DEAD → DEAD | bumperF; hubFL+FR |
| tbone50 struck | 8.52 → 8.75 | — | door R 0.11 → 0.26 | 0.41 → 0.02 | 0.07 → 0.03 | — | alive → alive | doorR |

Open against §5: offset64 still lets a mass centre 0.24 m past the slab end
(the car pivots off the slab edge; the end face projection is not reached
before the clip); the pulse is 67–100 ms at 56–80 km/h (inside A1's
[60, 150] band, short of the 90–140 ms real range); the 2×56 head-on pops
both front hubs (fixed in §6.1).

### 6.1 Detach rules, wheels, engine block, derby damage (lane `crash-realism-2`)

Measured with `crash-scenarios.test-util.ts` (full speed, shape mode) on main
`a0cb3a2` + this lane; "base" is main before the lane.

| scenario | base | now |
|---|---|---|
| side slide 30 km/h | doorL detached | doorL sprung (hinge 0.59), stays on |
| side slide 50 km/h | doorL detached, mirrors untouched | doorL + mirrorL detached (EBS 13.9 ≥ 12.5) |
| T-bone 50, struck car | doorR detached; hubFL, RL, RR popped; block gap error 0.122 m | doorR sprung 0.88, mirrorR off, no hub popped, gap error 0.002 m |
| right-door hit, 45 frames (crash-parts) | mirrorR hinge 0 | mirrorR folds/breaks, mirrorL 0 |
| wall 20 / 35 km/h | bumper on (0.32/0.48) | bumper on (0.36/0.59) |
| wall 64 square / offset 40 % | doors latched | doors latched (frontal hits cap a door at 0.2 ajar) |
| offset 64 40 % | no hub popped, block gap error 0.022 m | hubFL popped, gap error 0.002 m |
| head-on 2×56 | hubFL + hubFR popped on both cars | no hub popped |
| 6-car derby, seed 7, 90 s | nobody disabled, stalemate crown at 90 s | 5 disabled (12.5–32.6 s), elimination win at 32.6 s |
| dump16 fleet replay, last 2 of 6 s | Khaki turns 115.6 rad (|ω| pinned at 6) | every car < 0.1 rad |

Mechanisms:

- **C1** (`car.ts:partOnHit`, `syncAttachedParts`, `evaluateBreakage`): doors
  and their mirrors take a hit only from their own side. A frontal or rear
  crush can jam a door at most `DOOR_AJAR` (0.2) open. A side hit tears it off
  only at `hitSpeedValue ≥ DOOR_TEAR_MPS` (12.5 m/s EBS, 45 km/h). This uses
  EBS, not the closing speed the spec named: a 50 km/h T-bone has 13.9 m/s
  closing but 6.9 m/s EBS, and real side-impact doors stay shut.
- **C2**: bumpers detach only at `hitSpeedValue ≥ 30 km/h` EBS. B1's stroke
  scaling already kept a 20 km/h bumper on, so this gate guards rather than
  changes today's walls.
- **C3**: the mirror's on-hit test is its door's side rule. Its fold target is
  the door-skin sensors under it, `(max(sensor) − 0.04)/0.3`.
- **C4** (`streamed-deform.ts:clampLocal`): a hub pops only on an off-centre
  (`|impactLocal.x| ≥ 0.2`, `cornerWeight > 0.6`) end-on hit at
  `hitSpeed ≥ 15 m/s` whose struck corner has crushed to within `TYRE_REACH`
  (0.42 m) of the hub, which means 0.30 m of corner crush. Past that a corner
  crushed to within `HUB_OVERRUN` (0.12 m) of its hub, i.e. 0.60 m of crush,
  loses the wheel on any real hit (`hitSpeed ≥ 3 m/s`, not a press), however
  wide and from whichever end: a full-width hit that crushes the nose back to
  the engine no longer keeps all four. Measured on main 108a7d8 and
  this tree (`.bench/wheel-loss/measure.ts`): fleet sweep (40 resets × 3 cars,
  115 crashed) wheels lost 26 → 32 (0.226 → 0.278 per crashed car), corners
  crushed ≥ 0.6 m still holding one 5/27 → 0/28, corners crushed 0.4–0.6 m
  unchanged; derby 10 cars × seeds 3, 4, 6 (30 cars) 9 → 10, ≥ 0.6 m still
  holding 6/9 → 0/4. The standard crash set (wall 35/56/64, offset 64/56, side
  50, rear 56, 2×56, 2×80, T-bone 64) changes only at 2×80 km/h head-on: both
  front wheels now come off both cars; 2×64 and under take none.
- **A3** (`holdEngineBlock`, every mass slice): engineL–engineR are projected
  back to their 0.60 m rest spacing, mass-weighted, with the relative
  velocity along the block removed.
- **Cumulative damage** (`rearmHit`, `DeformableCar.applyImpact`): a crashed
  car takes a new hit after `REARM_QUIET` (0.3 s) without contact if the hit's
  EBS is at least `REARM_EBS` (6 m/s). The new hit re-aims `impactInward` and
  `impactLocal`. Its stroke uses the root-sum-square of every EBS on the struck
  end. Each mass's displacement at re-arm becomes its `baseX/baseZ`, and
  clampLocal caps only what the new hit adds, so an old dent never springs
  back when the hit frame flips. A frontal wall under 50 km/h still leaves the
  car driveable. Below 6 m/s, constant derby shoving re-armed every 0.3 s and
  ended matches in 10–15 s.
- **Settle rule**: `notifyPower` (called from `applyDrive` while throttle is
  held) keeps a powered wreck from being zeroed by the quiet-wreck rule, so
  `DRIVE.launch` is gone. The derby durability and stall tests pass without
  it.
- **Tail stroke** (`crumpleTravelCorner`): the rear end is now measured from
  the car origin. Measured from the cell, a mint tail read 0.12 m longer than
  a mint nose, and the slab clip stopped a 50 km/h reverse hit at 0.23 m.
  Tail/nose at 50 km/h went from 0.17/0.34 to 0.32/0.35 m.
- **Wreck spin** (`followGroup`): yaw is the world engine→axleR angle minus
  the same axis's angle in the body frame the masses were last clamped into.
  Before, the clamp held that axis tilted after an asymmetric crush, so each
  of the ~12–24 followGroup calls per frame turned the car by the tilt.
  `angular.y` is the heading change over at least 1/60 s of sim time, with a
  ±12 rad/s guard. Some cars in the 16-car pile-up still reach 6–12 rad/s
  for 11–13 frames. That spin is real momentum: the mass cloud's L/I reaches
  8.7 rad/s.
- **A9**: `pointVelocity` gives v + ω×r with the sense `integrate` uses, and
  glass shards and debris bounce use it. The finite-difference test matches
  within 5 %; base had the opposite sign. The pair-contact torque on
  `angular.y` is deleted: both cars are mass-active by then, and followGroup
  overwrites the value before anything reads it.
- **A10**: `sliceSpeed` reads `|velocity|`, not the stale drive `speed`.
- **A15**: FX debris, glass dots and loose parts use `applyGroundFriction`
  (μ 0.6 for FX, `muSlide` for parts) within a 5 mm contact band. A 0.5 s
  slide at 60 and 240 Hz differed by 18 % before and matches within 5 % now.
  Debris that hits a car bounces off the panel's own velocity. `sphereHit`
  applies Coulomb friction (μ 0.45).

### 6.2 Slow motion and derby wrecks (lane `crash-realism-3`)

- **Slow-motion head-on** (`applyImpulse`): the rear's transferred share of a
  pair impulse now moves the rear as one body (equal Δv, momentum ∝ mass).
  Spread per node it gave a 26 kg hub ten times the cell's Δv. The pinned hubs
  and the clamped nose hid that, and in slow motion the cell kept about 8 m/s
  into the stopped car until the hub plant let it ride 0.12 m up the nose.
  2×56 head-on nose: slow motion 0.638 → 0.444, full speed 0.444. Test:
  `crash-parts.test.ts` "slow motion crushes a 2×56 km/h head-on…".
- **Derby zip** (`rearmHit`): a re-armed hit stores each mass's damage base
  relative to the cell. Stored raw, it was taken in the hub-planted frame,
  where the cell sits up to its 0.12 m cap off its rest. The next contact
  anchors the group on the cell, so every `clampLocal` dragged the cell back
  to the stale offset and the wreck crawled along the bowl rim. Owner 9-car
  derby, 15 s: 194 zips → 0 (mass centroid moves more than 3·v·h + 5 cm between
  two live slices). Test: `derby.test.ts` "a re-armed wreck never outruns its
  own masses".

Open:

| case | full speed | slow motion |
|---|---|---|
| 2×56 head-on nose L/R | 0.444 / 0.444 | 0.444 / 0.444 |
| offset 64, 40 % nose L/R | 0.628 / 0.353 | 0.522 / 0.245 (todo `slomo:offset64`) |
| wall 56 nose | 0.411 | 0.438 (+6.6 %) |
| rear 50 tail | 0.347 | 0.351 |

- Offset 64: the struck corner overshoots its stroke (0.9 m), slips off the
  slab end and springs back to the stroke cap. At quiet 0.2 s the hub plant
  re-anchors the group, and in slow motion the cell then rides 0.12 m up the
  nose. An incremental pitch read (axis tilt minus its body-frame tilt) brings
  wall56 to −4 % and rear50 to −1 %, but it moves derby balance, the
  rear/front stroke ratio and the A3 engine gap, so it is not landed.
- Derby group pops (todo `derby:pops`): 19 slices in 15 s where a crashed
  car's group moves 0.10–0.24 m, more than 3·v·h + 2 cm. They come at quiet
  0.00, not at the plant (0.2 s) or level-out (0.35 s) switches. The group
  moves 0.11–0.14 m inside one dt = 0 `syncPose` on a struck live wreck.
  `collideWith` does not move its cell by more than 3 cm. Slow wedged pairs
  also get 0.02 m hull pushes on every SAT pass. Blending the group anchor
  across the plant switch moved masses through the cell cap (zips came back),
  so it was reverted.

### 6.3 Pops, pitch and pair drag: measured causes (lane `crash-realism-4`, no source change)

Probes (worktree `.bench/`): `pops.ts` (owner derby with per-call group/centroid
attribution), `pitch.ts` (one struck car, pitch per call), `drag2.ts` (crashed
19 m/s car into a crashed 10 m/s car), `petrol.ts` (fleet-spin replay, yaw and
L per call). Patches: `.bench/pops-anchor.diff` (the anchor fix below).

- **Derby pops, main class: the plant switch.** `quiet 0.00` is read after the
  slice; the pop slice starts planted (quiet > 0.2). Planted, the group sits on
  the hubs and the cell is free up to its 0.12 m cap. The first contact resets
  quiet, `followGroup` re-anchors on `cell.world − R·cell.rest`, and the group
  and every pinned hub jump by the cell's offset inside one dt = 0 call.
  Second class: the planted anchor is computed under a yaw-only frame and then
  pitched, so each plant switch moves the group by tilt × height (0.07–0.10 m).
  Anchoring both modes on the held `local` under the final rotation, with the
  anchor's local y solved for the clamped group height (otherwise the clamp
  leaks `δ·sin(pitch)` into x/z every call and ratchets), takes the 15 s owner
  derby from 19 pops to 0–4. Every variant also flips tuned outcomes:
  side-piston crush 0.222 → 0.216 m between 50 and 60 km/h (tolerance
  0.005 m), derby elimination (4 of 5 deaths by 90 s), the fleet-spin replay
  (a late re-hit leaves Petrol turning 0.24 rad), and the owner-derby zips.
  Keeping the planted offset as a fixed anchor instead gives 107 pops: the
  re-arm bases are cell-relative (§6.2) and disagree with it.
- **Hull pushes.** With the extra ≤ 0 case still pushing 6 mm, every SAT pass
  pushes while any overlap is left (3 × 0.006–0.03 m per slice on a wedged
  car). A per-slice push budget (`satPushCap(dt)` per car) removes the second
  pop class, but in the drag probe the faster car then slides through the
  slower one.
- **Pitch.** An incremental read (world tilt − body-frame tilt) is neutral and
  accumulates. In `pitch.ts` a 10 m/s nose hit runs it to −0.11 rad in 0.4 s,
  and in the derby it sits on the −0.2/+0.22 clamps (7 pops against 1). The
  nose-up motion is real mass motion: the front hub rises 0.32 → 0.44 m even
  with hub height left to the ground. World tilt minus the rest tilt removes
  the −0.03 rad rest bias without memory.
- **Pair drag (owner dump-pull).** In the headless synthetic (`drag2.ts`), main
  shares momentum: the normal closing is gone within 0.25 s, and travel is 1.09–1.22×
  that of a lone car at the common speed. The owner's 30 m carry did not
  reproduce. Pushes that also exchange the closing they stand for
  (`Δv = min(closing, push/h)`, equal and opposite) and a centroid-preserving
  clamp are each sound, but each moves wall56 COM travel (0.637 m), the A3
  T-bone engine gap (0.035 m) or the later-rear-hit fixture.
- **Ground drag.** `bleedAfterSlide` gates `dragGround` on the contact-quiet
  timer, so a rubbing pair gets roughly hub friction only. Ramping on
  `crushElapsed` instead changes the six-car derby: deaths at 4.7 s and 4.8 s.

### 6.4 Pops, wheels, accumulation and pair drag (lane `crash-realism-5`)

Probes in the lane worktree's `.bench/` (`pops.ts`, `side.ts`, `corner.ts`,
`accum.ts`, `gap.ts`, `hrow.ts`, `pairdrag.ts`, `spinpeak.ts`).

- **Derby pops (owner 9-car derby, 15 s): 19 → 7** (≤ 0.07 m, zips 0). Both
  plant modes anchor on the clamp-held `local` under the final rotation, the
  anchor's local y is solved for the clamped group height, popped hubs leave
  the plant anchor, and a slice's pair pushes share one `satPushCap`
  (`takePush`). The rest are the plant switch at 0.35 s quiet (tilt × lever in
  one call) and one slow wedged pair push. Ramping the level-out took it to 0
  but moved the tap, A3 and tail/nose bands; `derby:pops` stays a todo.
- **Side-ram severity re-expressed** (approved): see `PISTON_RIG.md`. Fit row
  0.103 0.191 0.214 0.222 0.216 0.221 0.221 (20–80 km/h); door body-frame
  crush on its 0.278 m cap from 35 km/h at every speed.
- **45° corner kill** (`updateDrivetrain`): only the block's travel along the
  car toward the cabin counts, whatever the current hit's direction (a later
  side/rear hit no longer hides a packed block). Corner kill ≥ front-middle.
- **Graded drivetrain** for the handling model: `engineTravel` (worst block
  travel, only rises), per-car `killTravel` (default 0.15 m), `drivetrainHealth`
  (1 − travel/kill, 0 dead), `wheelsOn`.
- **Crumple absorbs, then passes the load on.** Audit: `CAGES.absorption`
  (`rig-spec.ts:46–63`) is only the shape-match β of each cage's clusters
  (`streamed-deform.ts` `clusterBeta`), not an energy share. The energy model
  is a linear spring per struck end: `rearmHit` adds each hit's EBS² and the
  stroke is `crushStroke(√ΣEBS²)`; the slab brakes with the constant force that
  spends the hit over that stroke (`engine-props.ts` `brake`); `forceTransfer`
  passes 0.1/0.5/0.62 of an impulse downstream by node band and 1 once packed
  (`nodePacked`); the block moves only once the nose packs to 0.54 m ahead of
  it (`clampLocal`, `ENGINE_PACK_GAP`). Defect: the barrier never re-armed a
  wreck (`resolve(deform = !crashed)`, `applyImpact` gated on `!crashed`,
  `notifyContact` before arming), so repeated wall hits reused the first
  hit's stroke: 43 km/h ×6 → block 0.075 0.079 0.078 … Fixed: a returning
  wreck arms on its first face touch. Now 0.075 0.222 0.368 0.530 0.562;
  35 km/h hits kill at hit 2 (three carry one 61 km/h hit's energy). With
  `killTravel` = 10 the block saturates at 0.64 m. Not done: a per-zone energy
  ledger (absorbed + transmitted ≈ input) — `brakeInbound` applies the
  plateau as one Δv over every inbound mass and the clamps move positions
  without an energy account, so per-zone absorption is not separable today.
- **Squeezed wheels** (owner screenshot): a planted hub is pinned at rest +
  the shove a squeezing face gives it (press plates, `projectOutOfBox` when
  `bidirectional`), meets the face with its tyre (0.32 m tread, 0.11 m
  sidewall), and pops past one wheel diameter (0.64 m); a popped wheel drops
  into the world as a loose body; four gone kill the drivetrain. One-sided
  faces leave planted hubs alone: shoving them there freed the corner rams'
  tyres (crush 0.481 at 65 km/h vs 0.420 at 70). `wheelsDetach` and
  `frameCrush` (default on) turn the pops and the past-midpoint cell crush off
  for race mode or NPC traffic. No sourced separation threshold was found
  (`.extraResearch/perplexity/13-wheel-separation-frame-crush.md`).
- **Pair drag**: the mass drag ramps on `sinceHit()` (reset only by a hit),
  not the contact-quiet timer, unless the car is under power, and skips an
  airborne wreck. T-bone grind over 1 s: 0.36 g → ≥ 0.85× a lone wreck
  (0.96 g).
- **Open.** Pitch: world tilt − rest tilt reads a resting car at 0.000 rad
  (was −0.031) and a 10 m/s nose hit peaks at 0.081 rad, but moves the A3 gap
  (+0.088 m), the side/rear taps (0.036 m > 0.03), the tail/nose ratio and
  the derby elimination: the bias is baked into frames captured at pitch 0 and
  first read at −0.03. Spin: the 16-car replay peaks at Khaki 7.1, Bronze 5.7,
  Slate 5.5 rad/s (0.1 s window); attribution on Khaki: `clampLocal`
  write-back 3.87 rad mass yaw / 18.4 rad/s ΣΔL/I, `separateAlong` 1.59 rad,
  sphere contacts 0.98 rad. The fixedStep dirty-flag re-sync was not started.

### 6.5 Realistic-default zips, crumple ordering and derby energy (lane `crash-realism-6`)

Probes in the lane worktree's `.bench/cr6/` (`derbyc.ts` six-car derby at explicit
knobs, `accum2.ts` single vs repeated wall hits, `hit3.ts` per-step trace of a
re-armed hit, `creep.ts`, `single.ts`) and `.bench/pops.ts` (now `SQUASH`/`REAR`).

- **Zip at the realistic defaults (owner derby, squash 0.32, rear 0.38).** At
  107db69 `o4` moved 0.119 m in 5.7 ms at 3.7 m/s: sandwiched by `o6` and `o7`,
  three SAT passes each pushed it 0.019 + 0.040 m with no shared budget. Main's
  per-slice push budget (72d8b3c) and 6 cm rigid-pair overlap cap (fa58923)
  already hold it; it vanished at 358e4cd only because trajectories changed.
  The zip test now runs at 0.4/0.45 and 0.32/0.38 (0 zips each).
- **Block creep before the nose packs.** `clampLocal` let the block go back as
  far as the hit's stroke reached (0.103 m at 43 km/h, squash 0.32) while the
  nose still had 0.58 m; dynamics took it 0.0452 m. The mounts now hold it to
  `ENGINE_SLACK` (past earlier hits' set) until the crushed nose packs against
  it: 0.040 m at 20–50 km/h, both squashes.
- **Packed nose crushing past its packed length.** A wreck resting on the slab
  had its bumpers pushed by `projectOutOfBox` after the clamp's pack rule, so
  52 + 35 km/h at 0.4 left a 0.476 m nose gap (packed is 0.54). The face push
  now shoves the block too, within the hit's reach, once the cell no longer
  drives into the face (a live hit's transient push killed 35 km/h hits).
- **Repeated hits vs the energy rule.** `rearmHit` sums EBS² per end, but the
  re-armed hit's geometric block peak did not follow it: three 35 km/h hits
  (60.6 km/h equivalent) peaked 0.128 m at squash 0.32 (single 60 km/h: 0.158)
  and two (49.5 km/h) peaked 0.154 m at 0.4 (single 50 km/h: 0.139). Single
  hits at 48–54 km/h peak the block at `stroke − 0.30 − 0.06 ± 0.01` m at both
  squashes, so a nose hit now counts `hitStroke() − crumple − STROKE_SHORTFALL`:
  outright on a re-armed hit, as a cap on a first hit's geometric peak (which
  was non-monotone: 49.5 km/h died at 0.4, 50 lived). Kills: three 35s on hit 3
  at both squashes; one hit at 52 km/h (0.4) and 56 km/h (0.32).
- **Derby elimination.** `REARM_EBS` was 6 m/s (22 km/h): each car's EBS is about
  half the closing, so every car-car hit under 43 km/h closing added nothing.
  Now 2.8 m/s, the IIHS 6 mph bumper test (damage onset). Six-car derby at
  0.32/0.38 with the class kill travel at realism 0.25 (0.45 m sedan), seeds
  7/11/13/17/19: deaths 3 → 14, first at 21.5 s, but 0/5 matches end by
  elimination in 90 s. With the same physics a 0.30 m kill travel ends 5/5
  (first death 14.7 s), 0.35 m 1/5: a 0.45 m kill needs Σ EBS² ≈ 600 m²/s² on
  the nose (≈ 20 rams at 40 km/h closing). `derby:elimination` stays a todo.
- **40 km/h piston parity at squash 0.32 (engineL car/piston 72/61 mm).** The
  gap was vertical: block-to-cell sag 63 mm under a car's nose, 45 mm under the
  piston (z within 8 mm). Per-call attribution: `stepStructure`'s integration
  after the shape window closed; `rebaseShapeRest` froze the shape while the
  non-hub masses kept their relative vertical bounce with nothing restoring it,
  and the car-car contact (so the window) ends ~0.12 s before the piston's.
  Zeroing the sphere contacts' vertical normal or friction changed nothing. At
  the falling edge the non-hub masses now take their mean vertical velocity:
  43/43 mm. The parity test runs at squash 0.4 and 0.32.

### 6.6 T-bone door, derby lethality, pile-up spin (lane `crash-realism-7`)

Probes in `.bench/cr7/` of the main checkout (`tbone-trace.ts` per-frame cell
positions and door depth, `tbone-attr.ts` per-call Δ position / Δ momentum of
both cars, `tbone-gap.ts` the test metric against any `ROOT`, `bench.ts` the
24/32-car headless pile-up timing).

- **T-bone door: the 0.26 m "door" was a pass-through, not a crush.** On
  `b9c5647`, on main with 9e36c2e's in-contact ground drag, and with the
  `q > 0.08` drag gate restored, the struck door stays ≤ 0.01 m for the first
  0.9 s. Attribution over the first 0.2 s: the struck car moved 1.23 m, 1.14 m
  of it from `separateAlong` (position only) and 0.09 m from `stepStructure`;
  its momentum changed by 0.03 m/s (`collideWith`); `applyImpulse` never ran
  (the cabin hulls never overlap, so the impulse branch is unreachable); the
  bullet's `feedOverlap` took 2.7 m/s off the bullet. The bullet's nose was
  stopped against a fixed face (`vn` killed to 0 in the world frame) while the
  struck car got no momentum. Without mass drag the pair then slid at
  6.8 m/s until the bullet accelerated to 12.5 m/s and drove through the
  struck car: its cell ended 3.6 m (gated) to 5 m (`b9c5647`) past the struck
  cell, and the door particle read 0.24–0.26 m as it passed. 9e36c2e's drag
  only stopped the pair before that.
- **Fix:** `feedOverlap` takes the face's speed (`refVn`); `resolveCarPair`
  passes the pair's common velocity along the normal when the contact meets
  either car on its side, so both cars' contact masses go to it. The door now
  intrudes 0.242 / 0.263 m (squash 0.32 / 0.4) within 0.1 s, the bullet's cell
  stays 2.41 m from the struck cell, the far door, tail and bullet nose
  (0.242 / 0.263 m) are unchanged. End-on pairs keep the fixed-face kill:
  with the common velocity the 40 km/h frontal parity car's tail crushed
  88 mm (piston 43 mm), because a nose driven to the common speed drags a
  tail whose beams yield at any force. `bleedAfterSlide` is one function
  (`physics-util.ts`) for the engine and the test harness, with 9e36c2e's
  semantics.
- **Derby lethality:** `killTravel(cls, realism, "derby")` = `DERBY_KILL_SCALE`
  (0.5) × the race/fleet value (HANDLING.md). The six-car `derby:elimination`
  todo now passes (was 0/5).
- **Squeeze snap-back (ContactParity `107db69`).** Probes `snapback.ts`,
  `snap-attr.ts`, `press-hold.ts`. Three causes, all measured per call:
  (1) `afterContacts` cleared `bidirectional`/`deepCrush` 0.25 s after an end
  stopped being struck and `clampLocal` re-applied the one-ended limits
  (fire("all") doorR 104 → 2 mm); (2) the squeeze pinned the group at the
  world origin, so a free car's travel read as crush and the cell caps
  dragged it back (bumperFR 0.50 → 0.02 m while still squeezed; a 2 s press
  hold at max face: bumperFR 1.29 → 0.62 m from the cell); (3) shape matching
  and the cabin fold sprang squeezed ends back 0.10–0.46 m in their last
  0.35 s window. Fix: `clampLocal` keeps the squeeze/deep shape limits until
  `reset` (only the origin-free anchor, planting and re-arm rules end with the
  squeeze); the squeeze anchors the group on the cell like any hit; a
  squeezed particle keeps its set distance change to the cell less
  `SPRINGBACK` (a bowed-out set holds only out of contact, so a pressing face
  can still push it in). fire("all") and the shape-mode press hold now lose
  ≤ 0.08 m. The compactor symmetry test reads world z (the plates' frame):
  `local` is cell-relative now. Lattice press hold still wobbles a rail
  ±0.1 m (0.19 m drop; 0.21–0.30 m before), open.
- **Free-car squeeze (open).** Reporting car-car struck ends
  (`noteContactEnd` from `resolveCarPair`) balances a 40 km/h sandwich (A nose
  / tail 166 / 25 → 246 / 227 mm) but the middle car then crushes 1.4–1.9× the
  striking noses, and two derby tests fail (≥ 10 deaths, re-armed-wreck
  zips). Not landed; the `feedOverlap` gate = 1 under a squeeze is not the
  cause (removing it changed A by 2 mm).

### 6.7 Tyre stop, pile-up spin, derby wrecking (lane `crash-realism-8`)

Probes in the main checkout's `.bench/cr8/` (`headon.ts`: per-frame tyre-tyre and
tyre-hull overlap through `runPair`; `attr.ts`: exclusive per-call yaw and L/I
ledger on the 16-car replay).

- **Head-on tyres passed through each other (owner screenshot).** A tyre seen
  from above is a 0.64 × 0.22 m rectangle on its hub. Main `1d3712f`, squash
  0.32: 40 / 56 km/h clear (0.249 / 0.036 m), 64 km/h overlap 0.089 m for
  0.03 s, 100 km/h 0.218 m for 0.15 s (tyre in the other car's hull 0.19 m).
  Cause: nothing in the car-car path knew the wheels; the crush hulls shrink
  with the nose, and at 100 km/h both hull pairs missed for a frame. Fix:
  `tyreStop` (`pair-contact.ts`) sweeps every tyre pair over the slice
  (SAT entry time); the closing the gap can't take goes to the common speed
  (`brakeInbound`, as for packed noses) and an existing overlap parts within
  the `takePush` budget. It also runs when both hull pairs miss. Now 64 /
  80 / 100 / 115 km/h ≤ 0.009 m. Nose at 56 km/h unchanged (0.428 m), cabin
  intrusion unchanged (≤ 0.052 m); above 64 km/h the nose stops at 0.46–0.50 m
  (was 0.49–0.83 m): the wheels are the stop. An unbudgeted push (0.09 m per
  SAT pass) zipped derby wrecks 0.27 m in a slice; the budget removed it.
- **Pile-up spin (16-car `dump16` replay, squash 0.4).** Peak heading rate over
  0.1 s on f9e42be: Khaki 11.69, Bronze 8.43 rad/s. Exclusive per-call ledger
  (Δ mass-cloud yaw and Δ L/I about the mass centroid, spawn to peak): Khaki
  +8.70 rad/s of L/I from `clampLocal`, −5.14 from the other cars' sphere
  contacts, ≤ 0.95 from every other call; Bronze −8.60 from `clampLocal`. The
  write-back moves positions of a body whose front masses are slower than its
  rear, so Σ m r × v changed with no torque; `separateAlong`, `feedOverlap`
  `refVn` and the sphere contacts stayed under 1.5 rad/s each. Fixes, together:
  (1) `clampLocal` hands back the masses' angular momentum (a rigid turn of
  their velocities, `yawMomentum`), (2) `followGroup` reads the clamp-held
  engine→axle axis under the pitch and roll the frame is about to take (left
  out, the tilt's yaw coupling turned the frame each call: Khaki 7.82 →
  3.28 rad/s with (1) alone vs both). Now Bronze 2.22, Khaki 1.35 rad/s. Making
  the heading a mass-weighted fit of all particles instead (four weightings
  tried) cut the replay to 1.2–2.6 rad/s but broke 2–6 tests (side-piston paint
  0.232 vs particles 0.211 m, rear-share of AI hits, fleet last-2 s turn), so
  it is not used. Ten-car derby, seeds 1–5, 120 s: contact peaks 6.0–9.1 →
  4.95–7.24 rad/s; free driving peaks at 4.86 (the AI's own steer through
  `driveMasses`), and the rest is `clampLocal`'s positional turn in contact
  (seed 4 c8: 0.78 rad in 0.15 s with ΔL = 0). `derby:contact-spin` stays a todo.
- **Derby lethality.** The spin fix made wrecks last longer: six-car
  elimination 3/5 (was ≥ 4/5). `DERBY_KILL_SCALE` sweep, ten-car seeds 1–5,
  300 s: ×0.5 wreck 1/5, ×0.46 3/5 (first death 10.6 s), ×0.44 3/5 (5.8 s),
  ×0.42 3/5 (4.8 s), ×0.36 4/5 (2.6 s). ×0.46 restores the six-car tests;
  `derby:wreck` (4/5 with no death before 8 s) needs accumulation, since below
  ×0.46 one hard hit kills.

### 6.8 Level-out pops, derby spin and wrecking (lane `crash-realism-9`)

Probes in the main checkout's `.bench/cr9/`: `slice.ts` (per-slice mass step
against 3·v·h + 5 cm after every `afterContacts`, then a replay with exclusive
per-call attribution of the worst slice), `probe.ts` (cr8's derby probe with
per-call centroid moves, `CALLS=1 WIN=<s> ATTR=<car>@<t>`), `flow.ts`, `rehit.ts`.

- **Roof pop as a stopped wreck levels out.** The zip check now runs per slice
  (`Probe.slice`, after each `afterContacts`); per frame it missed the pop.
  Base, worst slice step vs its limit: head-on 64/80/100/115 km/h roof
  0.127/0.128/0.128/0.128 m vs 0.050 at quiet 0.355 s (the planted level-out
  snapping pitch −0.2 → 0 in one call); past the limit, wall 64 roof 0.051 m,
  40 % offset 64 bumperFL 0.083 m, side 56 roof 0.029 m. Fix: the frame's tilt eases over
  `LEVEL_TIME` (0.1 s) both ways, levelling from 0.35 s quiet and tilting back
  on a new hit. Easing only the level-out (cr8's candidate) let a hit snap the
  tilt back on: derby seed 1, c6 parked at quiet 1.02 s and nudged at 27.12 s
  moved 0.069 m in the first SAT pass, 0.056 m of it `clampLocal` re-capping
  under pitch 0 → −0.08 with Δv = 0. A second, older pop: 100 km/h, the slice
  after the tyres stop both cars (every mass at rest), the free shape solver
  (4 passes at α 0.64) closed the remaining gap at once: bumpers 0.056 m vs
  0.050 (`writeShapeToMasses` 0.049 m). `CONTACT_HOLD` 1 → 2 frames lets the
  contact solver close it first (one frame 0.056, 0.034 s and longer ≤ 0.045 m).
  A 10 m/s per-slice shape-flow cap was tried and dropped: at 1/120 s slices the
  delayed flow popped the roof instead (80 km/h 0.064 m vs 0.050). Now every
  head-on 40–115 km/h stays under the limit (worst 100 km/h roof 0.045 m vs
  0.050, 0.90×), the three wall hits by 0.022–0.046 m; derby seeds 1–5 zip 0
  (90 s probe); `derby:pops` todo 12 → 4 pops.

### 6.9 Derby contact spin, wreck pacing (lane `crash-realism-10`)

Probes: `.bench/cr9/probe.ts` (ten-car derby, per-call ledger with `ATTR`/`CALLS`),
`.bench/cr10/door.ts` (side-piston door vs its cap per clamp call), `six.ts`
(the six-car realistic derby with death attribution), `seeds.sh` (peaks per seed).

- **Contact spin ≤ 5 rad/s.** Peak heading rate over 0.1 s within 0.6 s of a pair
  contact, ten cars, 120 s: 71ad020 4.74 / 4.71 / 6.41 / 6.42 / 4.67 rad/s (seeds
  1–5), now 4.07 / 4.61 / 4.48 / 4.33 / 4.57, and seeds 6–15 4.25–4.97; 0 spins in
  all 15, 0 zips except one in seed 11 (c5 at 82.49 s, 0.07 m: a `clampLocal`
  write-back moved a wreck squeezed between two cars 0.048 m, not attributed
  further). Free driving still peaks at 4.86 (the J-turn). Four sources, each a
  per-call ledger entry first:
  (1) `clampLocal`'s write-back turned the cloud after a shove-bent engine → axle
  axis (seed 3 c4 0.45 rad in 0.15 s, ΔL = 0); it now undoes its net turn about
  the centroid (`holdTurn` / `undoTurn`), except for a squeeze and a planted wreck.
  Undoing it on a planted wreck turned the body against its hubs each call and
  left the side piston's door 36 / 60 / 118 µm under its 0.2784 m cap at 60 / 65
  / 80 km/h (a real offset, not float: base sits on the cap within 1 µm on 151–169
  calls, the unplanted-only undo the same).
  (2) `collideWith`'s overlap push undoes its turn the same way (seed 4 c9
  0.256 rad); the sphere impulse keeps the real one.
  (3) `separateAlong`'s uneven push (crumple masses lag) changed Σ m r × v of a
  wreck whose nose and cabin move apart, and the next clamp kept it: −2.48 rad/s of
  L/I in 0.6 s of shoving (seed 4 c0, peak 6.49). It hands the angular momentum
  back, as `clampLocal` does.
  (4) The AI's own steer: `applyDrive` 0.40–0.68 rad in 0.15 s on top of the hit
  (seed 8 c0 0.673 rad, 4.5 rad/s, just after the other car left). Physics alone
  (1–3) read 5.53 / 4.88 / 6.22 / 6.24 / 5.79. Within 0.6 s of another car's centre
  inside 4.6 m a driver stops adding lock the way the car already turns from
  3.5 rad/s and lets go by 4.5 (`derby-ai.ts` `SPIN_*`). Tried: in the open it cut
  J-turns (seed 4 139 → 36) and the tail-first share failed (F47/R37); only while
  a car is near, a car leaving contact still stacked full lock (seed 8 6.16);
  sparing J-turns and swings put seeds 1 and 5 at 5.70 / 5.62; at √28 m seed 1's
  tail-first share fell to 39.8 % (F32/R43/S33).
  The `derby:contact-spin` todo is now a test on CI seeds 1–3 (71ad020: "seed 3:
  contact peak c4 6.41 rad/s at t=15.4").
- **Engine casting through the clamp (A3).** The mounts cap engineL and engineR
  separately, and `clampLocal` and `separateAlong` both pulled the 0.60 m block
  apart between slices (T-bone struck car 0.0106 m on 943ae5c, 0.0121 m after the
  turn undo vs the 0.012 limit). `clampLocal` now holds the block's rest spacing
  in the frame it clamps into (0.0000 m), except under a squeeze, whose held press
  kept its per-mass caps (engineL sprang 444 → 363 mm with it).
- **Derby wreck pacing: wear.** With travel alone (contact-spin fix, ×0.46) every
  derby death was engine travel; ten cars, seeds 1–5: 3/5 wrecks (41.4, 154.1,
  122.3 s), first death 13.8 s; at 8 s the worst car had 0.83 of its travel and
  Σ EBS² 180 (`.bench/cr10/wear.ts`, `series.jsonl`). Now `rearmHit` and
  `beginCrush` add each hit's EBS², capped at 36 m²/s² (6 m/s), to a wear total,
  and a derby car dies when travel / killTravel + wear / 400 > 1 (`armKill`:
  `DERBY_KILL_SCALE` 0.7935, `DERBY_WRECK_ENERGY` 400). The cap keeps one hard hit
  the travel's to judge: uncapped Σ EBS² / 300 killed a car at 4.7 s after 3 hits.
  Grid (seeds 1–5): ×0.69 / 300 first death 4.7 s; ×0.69 / 400 4/5 but seed 1
  nose-heavy (F55/R64/S27, tail-first test failed); ×0.69 / 500 3/5; ×0.69 × 0.85
  / 500 first death 7.8 s; ×0.79 / 400 5/5, first deaths 14.1–36.9 s, every heat
  tail first. A race or fleet car is armed with no wear limit: a sedan drives on
  after 30 side hits at 25 km/h, the derby sedan is worn out after 11. The
  `derby:wreck` todo is a test on seeds 1–5 (before: 3/5). The tactic counts held
  (seeds 1–5, swings / J-turns / sideswipes: 943ae5c 35 / 434 / 126, after the
  steer cap 29 / 387 / 121), now asserted (≥ 1 swing and sideswipe per heat,
  J-turn share ≥ 0.7 × 0.73). The grid ran the probe with killTravel × 1.15 on top
  of 0.69; the shipped 0.7935 in the test reads seeds 1–3 wreck 69.2 s, wreck
  191.8 s, time 300 s (first deaths 14.1 / 45.6 / 19.8 s), and the five-seed wreck
  test passes (≥ 4/5): chaotic heats move with the last digit.

### 6.10 Physics spikes, SAT allocation, dirty re-sync (lane `crash-realism-11`)

Probes in the main checkout's `.bench/cr11/`:
- `racespike.ts`: headless 8-car races through `race-world.test-util`'s `frame`, with per-frame time, optional per-call wrappers, GC events, an allocation profile and `WARM=prod`.
- `resync.ts`: 24-car derby in the engine's `fixedStep` order, with a contact and state digest, `CHECK` (does a clean re-sync change anything), `TIME` (per-call cost) and `ALLOC` (sampled allocation per frame).
- `mapcheck*.ts`: hidden-class changes across a first crash.

- **Race physics spikes (PERF_HITCH: `fixedStep` 26–48 ms single frames).**
  - Headless on the oval, the first pile-up frames (t = 6.7 s, the first `beginCrush`) took 12–29 ms cold against a 0.7 ms median. Their GC overlap was 0–9 ms. Wrapped, the time is spread over every deform method, which is the signature of unoptimised code.
  - `--trace-opt`: 139 optimisations in f400–410 against 7 in the five frames before.
  - Fix: `warmCrashPath` (pair-contact) runs a 100 km/h head-on and a T-bone through `stepCarPair` (1 s each, about 0.2 s of CPU) while the boot warm-up compiles programs.
  - Interleaved, 6 rounds, oval 15 s: max frame cold 12.4 / 12.5 / 13.4 / 13.9 / 16.6 / 29.3 ms; warmed 6.9 / 7.2 / 8.1 / 8.5 / 9.3 ms. One warmed round was 25.6 ms, but its whole run was slow (p50 0.98 vs 0.75), which is box load.
  - Each new car's first `beginCrush` still marks 45–84 functions for lazy deopt ("dependent prototype chain changed", within its `hitSpeed`/`wear` writes), warmed or not. Cause not found; the warmed frames stay under 10 ms regardless.
  - Test: a warm-up hit must crash both cars, and a 48 km/h head-on after the warm-up is digest-identical to one before it. Mutated to 0 m/s it fails: "a warm-up hit no longer crashes both cars, so it no longer compiles the crush path". In the browser this is not re-measured.
- **SAT allocation.**
  - `liveHulls` / `liveCrushHulls` built 5 hull literals and an array per call, two calls per car per SAT pass. They now rewrite two per-car buffers (`setHull` copies the rest hull when an extent is non-finite, instead of storing the shared `HULLS` object).
  - `satTwoHulls` built a 4-axis array per hull pair. `resolveCarPair` built two getter closures per call.
  - Measured at 24 cars, seed 1, 900 frames: sampled allocation 1130 → 913 KB per frame (`satTwoHulls` 196 → 92, `live*Hulls` 116 → 0). Contact digest `93c73ab517e0ec97` and state digest `1a849113ee11ac2d` are identical (15877 pair hits). CPU per call is unchanged within noise (`resolveCarPair` 0.73–0.93 vs 0.73–0.80 µs).
- **Dirty-flag re-sync: not landed.**
  - `syncPose(0)` is not idempotent. Of 11335 re-syncs of a car that nothing moved since its last sync, 11278 changed its masses (3047 by more than 1 µm, at most 11 mm): `clampLocal` re-clamps in the frame its own last clamp turned.
  - Skipping them changes the contacts (15877 → 17693 pair hits, different digest), so no skip can keep contacts identical.
  - The prize was small anyway: `syncPose(0)` costs 155 µs of 2.33 ms per frame at 24 cars, and the skip saved 45 % of those calls.
- **Top physics costs per frame, 24-car derby** (calls × µs per call = µs; frame 2.33 ms CPU):
  1. `resolveCarPair`: 783 × 0.50 = 390 (276 pairs × 2.84 SAT passes)
  2. `followGroup`: 96 × 3.15 = 302, of which `clampLocal` 96 × 2.21 = 212
  3. `stepStructure`: 15.4 × 15.5 = 240
  4. `syncPose(0)`: 46 × 3.35 = 155
  5. `syncPose(h)`: 31 × 3.79 = 117

  Then `think` + `applyDrive` at 95.
- **Corner pistons: far door and paint** (`.bench/cr11/corner.ts`, 1500 kg at 40 km/h). Not fixed.
  - Far door, `frontLeft` → `doorR`, 0.049 m against the 0.06 cabin limit (`frontRight` mirrors it). The door holds −0.005 m through the whole contact (0–0.35 s). It closes to 0.049 m between quiet 0.25 s and 0.45 s, in the slide after the hit (7 m/s diagonal), and keeps that as set.
  - Cause: unequal ground drag. `stepMassSlice` brakes the hubs at full μ, but ramps the body masses' drag in from quiet 0.12 s to 0.57 s (from ad6982b's "ice-skating" fix, not a calibration). The braked hubs shear the body.
  - Measured with temporary toggles:

    | variant | frontLeft far door (m) | left far door (m) | shove (m) |
    |---|---|---|---|
    | as is | 0.049 | 0.082 | 6.18 |
    | no body drag | 0.061 | 0.082 | 9.87 |
    | body at full μ from 0.12 s | −0.008 | 0.072 | 4.89 |
    | hubs on the body's ramp | −0.009 | 0.068 | 6.50 |

  - Equal drag fixes the door, but the full-μ variant fails 7 tests: the corner struck depth on both corners, side MDB 0.15–0.25 m, both corners' crush monotonicity, contact parity at 40 km/h, and rear far paint. It was reverted. Landing it needs those re-anchored or the hubs-on-the-ramp variant gated.
  - Paint: the `frontLeft` dent of 0.088 m is the mean over a 0.3 m sphere (28 vertices). The 5 nose/bumper vertices average 0.175 m, which matches `bumperFL`'s 0.188 m. The 23 wing/arch vertices average 0.069 m, and a quarter of them bulge out 0.033–0.037 m. The median is 0.110 m. This is geometry plus the wing grading behind the bumper (`wingFL` 0.030 m), not a skin defect.

### 6.11 Physics allocation (lane `crash-realism-12`)
Probes are in the main checkout's `.bench/cr12/`. `race.ts` is a headless 8-car oval race through `frame()`. It records allocation with the sampling heap profiler (collected objects included), GC counts by kind, and a state digest every 10 frames. `derby.ts` is CR11's 24-car `resync.ts` with per-site output. `pile.ts` is the 24-car pile-up from `physics-alloc.test.ts` with the profiler attached.
- **Cause.** Almost none of it is `new`. TurboFan boxes every double it passes to a call it did not inline: arguments, return values, and the result of `Math.hypot`, which is never inlined and also allocates a scratch array. `for…of` over arrays left iterator objects in functions that did not inline the iterator. `parts.some(closure)` in the hull getters allocated two closures per SAT pass.
- **Fixes.** Behaviour is unchanged: the oval digest `5d53cca21c62fa26` (60 s), `76e603e87adcb9d6` (30 s after 30 s), and the derby contact `a29f0ad17ec53683` and state `6958479bfc11c070` digests are identical to 75bc12d.
  - `hypot2`/`hypot3` in physics-core are bit-identical ports of V8's `Math.hypot`; a test checks 20 000 random and special-value cases. Their Infinity/NaN returns avoid a global load, which had made every inlined result tagged. shape-match-core keeps its own `hypot3`, because kernels import nothing (C3). Checked against `Math.hypot` on 3 million random and all special-value triples.
  - `satTwoHulls` returns a flag and puts the depth in a scratch.
  - Hot `for…of` loops are indexed loops.
  - `clampLocal`, `stepMassSlice` and `followGroup` use `Math.max/min` instead of `THREE.MathUtils.clamp`/`lerp`, and field writes instead of `set()`. `stepMassSlice` also hoists `quietTime()` and the scuff check out of the mass loop.
  - `writeShapeToMasses` inlines `bodyToWorld`, and the hull getters loop instead of using closures.
- **Per site, KB per frame** (base → lane):

  | site | race, steady 30 s | 24-car pile-up |
  |---|---|---|
  | `satTwoHulls` | 64.7 → 0 | 1107 → 0.1 |
  | `clampLocal` (with its `Math.hypot`) | 122.4 → 20.6 | 561 → 104 |
  | `stepMassSlice` | 87.8 → 41.7 | 9.5 → 3.1 |
  | `followGroup` | 26.0 → 15.9 | 101.5 → 51.6 |
  | `stepShapeMatch` | 10.6 → 4.5 | 154 → 48.8 |
  | `yawMomentum` | 4.4 → 2.4 | 18.0 → 17.7 |
  | `liveHulls` / `liveCrushHulls` | 2.0 / 3.1 → 2.0 / 3.0 | 0 → 0 |
  | hull getters (`carHulls`/`carCrushHulls`) | 1.3 → 0 | 203 → 0 |
  | `tyreStop` | 1.9 → 1.0 | 9.4 → 9.3 |
  | `skin` | 1.7 → 2.4 | 0 → 0 |
  | `applyDrive` | 13.6 → 14.1 | 11.9 → 12.2 |
  | `hypot2` (not inlined, boxed result) | 0 → 13.0 | 0 → 60.5 |
  | **total** | 460 → 213 (28.3 → 13.1 MB/s) | 2750 → 689 |

  The race total includes the race AI, session and test harness, about 3 MB/s. The physics files went from about 26 to about 9.6 MB/s.
- **GC, 60 s headless oval.**
  - Default heap: 130 → 63 scavenges, with 0 major GCs on both.
  - With a 1 MB semi-space to mimic the browser's young generation: 2063 → 985 scavenges. Major GCs were 0–1 on both across runs, so the headless count does not separate them.
- **Guard.** `physics-alloc.test.ts` warms a 24-car pile-up for 600 frames. It then sums positive `heapUsed` steps over 300 frames, which can only undercount. Measured: lane 560–670 KB per frame, 75bc12d 2280–2300. The bound is 1200, so 75bc12d fails it.
- **Not reached: the 2 MB/s target.** What is left is boxed arguments to calls that TurboFan stops inlining once a large method has used up its inlining budget:
  - the per-mass `Ground` queries and `applyGroundFriction` in `stepMassSlice`
  - `heightAt`, `hypot2` and `group.rotation.set` in `followGroup`
  - `driveMasses`/`heightAt` in `applyDrive`
  - the squeeze branch of `clampLocal`
  - `resolveCarPair`'s result object and its two `clone()`s. `StrongestContact` in engine-props keeps those references, so reusing them needs that class to copy.

  A larger budget flag made it worse (`clampLocal` 339 KB per frame). The way forward is per-call-site: pass objects instead of doubles, or split the per-mass bodies out.
- **`slomo:offset64`: attributed in part, not fixed** (`.bench/cr12/slomo64*.ts`). Measured: `noseShortR` 0.272 in slow motion against 0.330 at full speed (0.824); `noseShortL` 0.513 against 0.539.
  - Both runs reach the same peak: `noseMaxR` is 0.330 in each.
  - In slow motion the R nose springs back to its set within 0.29–0.33 s (0.330 → 0.255). At full speed it holds 0.330 until about 0.5 s, because the wreck is still in contact with the slab (quiet 0.003 s against 0.33 s in slow motion).
  - Net mass-centroid motion away from the slab over 0.28–0.34 s, by call:

    | call | full speed (m) | slow motion (m) |
    |---|---|---|
    | `barrier.resolve` | +0.104 | +0.075 |
    | `barrier.clip` | +0.036 | +0.083 |
    | `syncPose` | −0.103 | −0.018 |

  - At full speed the masses keep closing on the slab and `syncPose` carries them back in. In slow motion that inbound velocity is gone, so the clip's pushes (about 75 slices in that window against about 10) separate the wreck.
  - Ruled out:
    - The wall-clock gate on `bleedAfterSlide` (0.2 s wall is 6 ms of sim time at ×0.032): gating it on sim time gave 0.264.
    - The per-call floors in `satPushCap` and the barrier push (+0.004 m): scaling them by dt below 1/240 s left slow motion at 0.272.
  - Next: find what keeps the full-speed masses closing (or kills them in slow motion) per slice in `JerseyBarrier.clip`/`resolve`.

### 6.12 Physics allocation under 2 MB/s, deopt waves (lane `crash-realism-13`)
Probes are in the main checkout's `.bench/cr13/`: `race.ts` is CR12's oval race with a `@@MEASURE` marker; `race-boot.ts` runs `warmCrashPath` first, as the engine's boot does; `sites.mjs` sums the per-site table; `base/` is an f8821eb `src` copy. Behaviour is unchanged: the oval digests `5d53cca21c62fa26` (60 s) and `76e603e87adcb9d6` (30 s after 30 s), and the 24-car derby contact `a29f0ad17ec53683` / state `6958479bfc11c070` digests, are identical to f8821eb.
- **Cause 1: inlining budget.** TurboFan inlines at most 920 bytecode bytes into one function, and it charges a callee its size plus what that callee's own optimized code inlined: `TrackGround.heightAt` costs 309, `frictionAt` 275, `hypot2` 150, `applyMatrix4` 259. Ties go to the later call site. Every call left out boxes its double arguments and result.
  - `stepMassSlice` (41 KB/frame): the per-mass loop asked the ground twice and called the friction twice. It is now four loops: `sampleGround` (before the move), `moveMasses`, `sampleGround` (after it, with the grip) and `groundMasses`, with one friction call. The ground answers go through `Float64Array`s. A mass's step reads only that mass, so the order is the same per mass.
  - `followGroup` (16 KB/frame, 134 calls/frame): the per-mass `applyMatrix4` and the later matrix calls used up the budget before the two `hypot2` and the anchor's `heightAt`. Those now sit in `measurePose()`, which takes no doubles and writes its results to `pose`, a `Float64Array`.
  - `applyDrive`: the ground queries go through `floorUnder`/`gripUnder` (physics-util), which take a point and write to a typed array. `driveMasses` takes its four doubles in a typed array. THREE `clamp`/`lerp` became the same `Math.max/min` arithmetic. `assists()` reruns only when realism changes.
  - Out-of-line results: `yawMomentum` keeps its held angular momentum in `spinHeld[slot]`, and clampLocal reads `measureStroke()` from `strokeOut`, so it no longer gets a returned double or passes one as an argument. `resolveCarPair` rewrites one module `PairHit`; `StrongestContact` copies it into vectors it owns, instead of keeping two `clone()`s per hit. `satCars` and `sphereHit` use field arithmetic instead of `set`/`addScaledVector`. Two hot `for…of` loops (`separateAlong`, `feedOverlap`) are now indexed.
- **Cause 2: deopt waves from field generalization.** A field first written as a Smi (`wear = 0`, `hitSpeed = -1`) changes its map the first time it gets a double. Code that relied on the map deoptimises ("dependent prototype chain changed" / "wrong map"), and the functions run unoptimised until they re-tier, which can take seconds: `applyDrive` sat in Maglev for 365 frames after one deopt. This is CR11's unexplained "each new car's first `beginCrush` marks 45–84 functions for lazy deopt". The boot's `warmCrashPath` cars do not cover it, because race cars branch off their transition tree. With `warmCrashPath` first and a 60 s oval:
  - f8821eb: the first crash (f402) generalized `crushAmount` (+105 maps), `wear` (+97), `hitSpeed` (+76), `lastPower` (+65) and `wrinkleAmp` (+63), and later `impulse` (+77, f556). That was 75 and 79 lazy deopts. Also inside the measured window: `hitAt`/`baseX`/`baseZ` at the first `rearmHit` (104 deopts) and `crushSet` (70).
  - Fix: these fields, the masses' `shoveX/shoveZ/crushSet/baseX/baseZ`, the sensors' `compression` and `car.drive`'s numbers are declared `-0`, a double from construction. The constructor writes the `-1`/`-10` sentinels over it. f402 now has 9 deopts and f556 has none.
- **Race, steady 30 s (WARM=30), KB per frame**, physics files (streamed-deform, car-drive, physics-core, physics-util, pair-contact, shape-match-core, external-contact, sat, engine-props): **129.5 → 27.4 (7.95 → 1.68 MB/s)**. The whole race went from 186 to 70 KB/frame.

  | site | f8821eb | lane |
  |---|---|---|
  | `stepMassSlice` (incl. the new loops) | 41.0 | 0 |
  | `followGroup` / `measurePose` | 15.6 | 0 |
  | `applyDrive` (with its Math natives) | 13.8 | 9.4 |
  | `resolveCarPair` | 4.9 | 0.4 |
  | `stepShapeMatch` | 4.6 | 1.9 |
  | `hypot2` | 4.5 | 0.3 |
  | `clampLocal` | 3.5 | 3.9 |
  | `liveCrushHulls` / `liveHulls` | 2.8 / 1.4 | 0 / 0 |
  | `hitStroke` / `yawMomentum` | 2.6 / 2.4 | 0 / 0 |
  | `skin` / `skinPanel` | 2.5 / 2.1 | 0 / 0.4 |
  | `satCars` | 1.1 | 0.1 |

  What is left in `applyDrive` is mostly time spent out of TurboFan. The race still deopts it on branches it first takes mid-race ("Insufficient type feedback") and on `CLASSES[carClass(car)]` ("wrong name"), and it re-tiers slowly.
- **GC, 60 s headless oval, scavenges:** default heap 62–63 → 40–41. With a 1 MB semi-space, 1000–1004 → 651–655. Major GCs are 0–1 on both.
- **Pile-up guard** (`physics-alloc.test.ts`, 24 cars, positive `heapUsed` steps): f8821eb 657–672 KB per frame, lane 421–425. The bound went from 1200 to 540. In the pile-up the biggest sites left are `clampLocal` (96 KB/frame: `hypot2` calls left out of line), `collideWith`, `satCars`' returned overlap and `stepShapeMatch`'s `matchCluster`/`applyPlasticity` arguments (shape-match-core).
- **`slomo:offset64`: fixed** (`.bench/cr13/slomo64{v,s,f,c}.ts`, a per-call ledger on top of `runWall`). In slow motion the brake starts one bucket earlier and runs without gaps, so the wreck stops 8 cm further out (centroid x 1.578 vs 1.498). Both runs still peak at R 0.330. After the stop, the cabin floor (`clipCarToBarrier`) read the struck corner's *current* remaining length. The L corner springs back off the face about 1.5× faster per sim second in slow motion (3.8 vs 2.6 mm/ms), so `leftover`, and with it the floor `minLx`, rose 3.1 mm/ms against the group's 0.96, and caught it at t = 0.316 s. Its push (`separateAlong`, which keeps the crumple masses) stretched the nose, which raised the floor again. That loop moved the group 0.086 m and sprang R from 0.330 to 0.255 in 7 ms of sim time. At full speed the floor trailed by 2.8 cm and never fired. Fix: the floor reads `slabTravel()`, the hit's low mark of `crumpleTravelCorner` (reset by `beginCrush`, `rearmHit` and `reset`). Slow motion now gives L 0.523 vs 0.539 and R 0.284 vs 0.330 (0.97 and 0.86, was 0.95 and 0.82); full speed is unchanged. The remaining R gap is the designed `SPRINGBACK` (7 cm): it shows in slow motion, while at full speed the wreck's continued yaw (−1.82 → −1.87 rad after the stop) keeps that corner pressed. The `it.todo` is a test again.
- **Derby seed 11 zip: attributed, not reproducible on f8821eb** (`.bench/cr13/zip11.ts` replays `runField`; `zip11b.ts` adapts it to older trees; `bisect11.sh`). On d516b54, step 11156 (t = 82.49 s) moved c5 0.068 m against a 0.064 m limit. c5 was a dead wreck at 0.64 m/s, squeezed by c7. SAT passes 0 and 1 each pushed it 22.8 mm (`resolveCarPair` → `pushPair` → `separateAlong`). That is the slice's whole `takePush` budget: `satPushCap(7.4 ms)` = 45.5 mm, about 6.15 m/s, whatever the wreck's own speed. On top of that came the `followGroup`/`clampLocal` write-backs (16 + 2 × 2.6 mm) and `collideWith` (7 mm). The zip first disappears at f2a3318 (bisected on first-parent history: 759c377 zips, f2a3318 does not). That merge changed wreck pacing, so the trajectory changed; the mechanism itself was not fixed. f8821eb and this lane run seeds 1–30 with no zip in the first 2 min, so a fix has no failing case to test against. Seed 11 is now in the CI seeds (`1,2,3,11`).
- **Slope** (`slope.test.ts`; `.bench/cr13/slope-tail.ts`): the ground is a 6.8° side slope across the travel, and each car's final dents are compared with the flat pad.
  - A 48 km/h head-on keeps its dents, with no pops.
  - A 50 km/h T-bone has no pops but does not keep its dents (todo `slope:tbone-level`). The struck car faces uphill and its frame is at the −0.2 pitch clamp. At quiet 0.35 s it levels out to world level instead of to the slope: the cell shifts 0.058 m and the tail reads 0.083 m of crush, against 0.023 on the flat pad.
  - A first fix, `measurePose` easing to the ground normal's pitch and roll, still failed the dent check. It was reverted and needs per-mass attribution.

### 6.13 Body panels, hinge stages and dents on torn parts (lane `panel-detach`)

- **What tears.** Two quarter panels and four wheel-arch flares are patches of the body loft's own triangles (`car-panels.ts`: loft rings 1-5 / 12-16 are the side, the arch is the skin within ARCH_R-0.04 .. ARCH_R+0.10 of a hub, the quarter is the rest of the side from the rear door seam (two-doors: from behind the door) to the tail corner). Attached, a panel is body: no mesh, no draw, no per-frame work. From hinge value 0.03 a thin shell (4 mm proud of the skin, sheet 2 cm behind, rim skirt) is built on the same skinned vertices and bends away; under it the body's own vertices turn to primer (a per-vertex `primer` attribute the paint shader reads: no extra draw), so a torn panel leaves a darker under-panel of its shape (vertices shared with the neighbouring paint blend softly into it). Torn sheets turn to lie flat (thin axis up) and at most two shells per car are drawn, the oldest vanish. Placement is per body (sedan quarter 76 vertices / 102 triangles, coupe 101 / 144, pickup 113 / 170; front arch 47 / 64 on every body, rear arch 38 / 48 sedan, 27 / 30 pickup).
- **Hinge stages** (visual only; none feeds the sim). Quarter: peels from its leading edge about a vertical hinge at its tail, up to 1 rad. Arch: flaps out at both feet (up to 0.16 m, with a flutter off the crush clock). Bumper: hangs by the corner that took less, rolls about it up to 0.6 rad with the corner asymmetry, sags 6 cm. Light bar: tilts on its far mount toward the struck side, up to 0.5 rad, as the roof sinks / the hit speed rises toward the shear threshold (which is unchanged).
- **Thresholds.** hinge value = (crush - on) / range, crush = the larger of the part's two end sensors and its cage; tears at hinge > 0.8 and EBS >= 50 km/h (only on a hit that loads that side: bidirectional squeezes skip them, like the hood). Quarter: on 0.05, range 0.45. Arch: on 0.15, range 0.5. Probe peaks (shape mode, rig walls): 30 % offset rear wall, rear wing sensor 0.06 / 0.23 / 0.47 m at 40 / 56 / 80 km/h, so the quarter hinges 0.02 / 0.40 / 0.82 and tears at 80; 30 % offset front wall, front wing sensor 0.57 / 0.92 / 1.0 m, arch hinge 0.84 at 40 (flaps, EBS 40 km/h too slow to tear) and tears from 56; side wall, front wing 0.29 / 0.78 m at 40 / 56: arch hinge 0.28, tears at 56 (with the door at 48). The rear of the car is stiffer than the nose, which is why the quarter needs the lower `on`. `panels.test.ts` holds these fixtures.
- **Dents** (`loose-dent.ts`). Every bounce of a torn part that changes its velocity by >= 1.8 m/s is recorded in the part's frame (contact normal, depth min(5 cm, 1.2 cm per m/s), at most 4 per part) and carved later: vertices within 26 cm of the contact vertex move along the normal, none farther than 8 cm from where they began. Recording is a pure function of the loose body's state; `car.cosmetic = false` skips the carving (an off-camera caller) and `true` catches up to the identical shape. The tumble kick is now a hash of the part and the hit (was `Math.random`), so two identical runs dent identically. A reset restores the skin.
- **Digests.** Part rows are in `car.snapshot()` (name, detached, hingeT, pos, vel): the panels add six rows per car, and an attached bumper / the light bar now pose with their sag / tilt. No stored digest exists; every comparison is run against run. Measured: 29 crash fixtures (walls front / rear / side at 24-80 km/h, 100 % and 30 % offset, head-on and T-bone pairs at 40 / 90) give the same sha-256 in the base (108a7d8) and this build over everything the sim sees (every car field and the detached flags and hinge of the old parts; a loose part's own pose except the bumpers' and bar's, which start from the new sag pose), because the sim reads only `partOff`. Netplay: `PART_SLOTS` 9 -> 15, `NET_VERSION` 5 -> 6 (saved highlight clips from older builds read as another version).
- **Perf** (32 cars, node, `.bench/panel-detach/perf32.mts`, `loose32.mts`): the derby pile-up is unchanged (7.0-7.2 ms p50 per step both builds; no panel opens there; heap per frame 514 vs 518-524 KB, inside run-to-run noise). 32 cars each tearing every part (192 loose bodies before, 384 after): 0.07 -> 0.12-0.17 ms per 32-car step while they bounce and dent, 0.05 -> 0.06 ms settled; `stepLooseParts` allocates 19 B per call with 12 loose parts. Attached panels add no draw; each torn panel adds two (shell, under-panel). Browser (32 parked cars, then every car tears every part, `perf32.mjs`, one round each, box at load 50+): parked 561 draws / 7.9 ms (base) vs 522 / 6.3 ms; all parts torn and lying: 584 draws / 5.8 ms (base, 192 loose bodies) vs 648 draws / 5.4 ms with 384 (+64 = 32 cars x 2 drawn shells; the earlier build with a primer mesh and uncapped shells was 1154-1192 draws and 31-36 ms). The first 2 s, when 384 bounces dent at once, average 29 ms against 14 ms (p95 78 against 55): a burst no melee produces.
- **Shell frame** (lane `sim-fix`, `panel-frame.test.ts`). `assignClass` moves the body into the `classLift` group (class lift plus the suspension pose and a lost wheel's sag), so a shell added to the plain car group floated off its primer patch and a torn one spawned in the wrong frame. `openPanel` now parents the shell to `body.parent`. Hinge-line vertex against its body vertex, before: sedan 0 cm, sedan minus a front-left wheel 4.4 cm, minus a rear-right wheel 9.0 cm, truck 7.7 cm, truck minus a front-right wheel 23.9 cm, monster 47.7 cm, monster minus a rear-left wheel 31.3 cm; after: under 1 cm in every case. A torn monster panel started 36-40 cm below its patch of body; it now starts 8 cm above it (the launch lift). Sim digests (crash, fleet, derby, race) identical; only a loose monster / truck panel's own pose changes.

## Appendix

### Sources

- [02] `.extraResearch/perplexity/02-bugbear-wreckfest.md`: Bugbear clusters,
  breakable joints for doors/hoods/bumpers/wheels.
- [03] `.extraResearch/perplexity/03-burnout-deform.md`: BeamNG
  `beamDeform`/`beamStrength`, SUPPORT beams for the cabin.
- [04] `.extraResearch/perplexity/04-real-car-structure.md`: crash-box
  plateaus of 33–70 kN; 400–600 mm frontal crush at 56 km/h; non-crushing
  engine; crumple zone an order of magnitude softer than the cell; detaching
  parts.
- [09] `.extraResearch/perplexity/09-frontal-crush-pulse-intrusion.md`
  (new):
  - 56 km/h: 350–550 mm dynamic and 250–450 mm static crush, 90–140 ms pulse,
    18–25 g average, 30–45 g peak, 1–4 m/s rebound, 0–20 mm toe-pan;
  - IIHS bands Good 0–5 / Acceptable 5–10 / Marginal 10–15 / Poor > 15 cm;
  - offset residual 300–600 mm.

  It cites NHTSA FMVSS 208 docs
  (https://www.nhtsa.gov/sites/nhtsa.gov/files/fmvss_208_ii.pdf), the IIHS
  moderate-overlap protocol
  (https://www.iihs.org/media/0e3c2eb2-f3ef-4340-9f1f-e8b041526d8b/9U5siw/Ratings/Protocols/current/Moderate_overlap_2.0_test_protocol.pdf)
  and the ESV frontal stiffness paper
  (https://www-nrd.nhtsa.dot.gov/departments/esv/24th/files/24ESV-000257.PDF).
- [10] `.extraResearch/perplexity/10-side-rear-roof-intrusion.md` (new):
  - IIHS side rating thresholds: Good ≥ 12.5 cm, Acceptable 5.0–12.4,
    Marginal 0–4.9 cm B-pillar-to-seat-centre line
    (https://www.iihs.org/media/2104caa9-7f7e-41fa-a4a5-af65f1cab89e/l9AWAw/Ratings/Protocols/current/side_impact_guide.pdf);
  - 13.2 cm residual for a Camry with a 1500 kg MDB at 50 km/h
    (https://lsdyna.ansys.com/wp-content/uploads/2022/11/iihs-side-impact-parametric-study-using-ls-dyna-r.pdf).
  - The pole, rear-crush and side A/B items returned no citable numbers.
- [11] `.extraResearch/perplexity/11-rear-roof-side-stiffness.md` (new):
  - FMVSS 216a: 3.0× unloaded weight (GVWR ≤ 2722 kg), ≤ 127 mm platen travel
    (https://www.nhtsa.gov/sites/nhtsa.gov/files/tp-216a-00.pdf);
  - IIHS roof Good ≥ 4.0, Acceptable ≥ 3.25, Marginal ≥ 2.5
    (https://www.iihs.org/ratings/about-our-tests/roof-strength);
  - FMVSS 301: 1368 kg MDB, 80 km/h, 70 % overlap
    (https://crashstats.nhtsa.dot.gov/Api/Public/Publication/812038).
  - No citable rear or side stiffness coefficients or torsional stiffness.
- [12] `.extraResearch/perplexity/12-detach-part-thresholds.md` (new):
  - FMVSS 206 latch and hinge: 11,000 N longitudinal, 8,900 N transverse
    (https://www.nhtsa.gov/sites/nhtsa.gov/files/tp-206-08_19_feb_2010.pdf,
    https://www.govinfo.gov/content/pkg/FR-1995-07-12/html/95-17088.htm);
  - IIHS low-speed bumper protocol: tears ≤ 1 cm and cracks ≤ 2 cm acceptable
    (https://www.iihs.org/media/97eb5f7e-f18a-41ad-905c-baa930e8933c/8AZ1VA/Ratings/Protocols/archive/test_protocol_bumper_vV_0502.pdf).
  - No citable mirror, hood-latch, wheel-separation, lamp or windscreen
    numbers.

The four new queries were run serially with
`node ~/.claude/skills/ask/perplexityWithSourcesFormattedIntoSingleResponse.cjs "<question>"`
through a 429-retry wrapper; each succeeded on the first try. The real-world
numbers that are still missing (side/rear A–B stiffness coefficients,
torsional stiffness, pole intrusion, mirror breakaway force) are marked
"no citable number" above. The spec does not depend on them.

### A1. Crash matrix

Commands, run from the worktree `cwd` with
`B=/mnt/c/proj/crash-deformer-test/.bench/rig-analysis`:

```
node --experimental-strip-types --no-warnings .bench/rig-crash.ts wall56,offset64,tbone50,pole32,pole50rigid,side50wall,rear50,headon28,headon56 shape 0,1 > $B/shape.json
node --experimental-strip-types --no-warnings .bench/rig-crash.ts wall56,offset64,tbone50,side50wall,rear50,headon28 lattice 0 > $B/lattice.json
node --experimental-strip-types --no-warnings .bench/rig-crash.ts wall20,wall35,wall48,wall56,wall64,wall80 shape 0 > $B/sweep.json
node .bench/table.mjs $B/<file>.json
```

The three runs took 6.3 s together. Raw output follows. `engine_max(+=back)`
is the largest rearward engine shortening vs the cell. `nose_end` is permanent.
Glass entries are pane index : state.

```
== shape
scenario|mode|slomo|car|COMtravel|pulse_ms|avg_g|noseL_max|noseR_max|tail_max|engine_max(+=back)|nose_end L/R|tail_end|doorL/R_max|roof_max|skin cabinIn|skin doorL/R|massPastWall|engTravel|drive|hubsPopped|detached|lampsOut|glass(!intact)
wall56|shape|0|0*|0.17|14|110|0.14|0.04|0.08|0.02|0.04/-0.05|0.00|0.01/0.04|0.04|0.13|0.06/0.07|0.48|0.32|DEAD|-|bumperF|headL|0:cracked
wall56|shape|1|0*|0.17|12|126|0.08|0.26|0.13|0.02|-0.07/0.05|0.13|0.00/0.02|0.02|0.10|0.03/0.04|0.25|0.17|alive|-|bumperF|headL|-
offset64|shape|0|0*|0.15|13|135|0.18|0.05|0.08|0.03|0.02/-0.06|0.05|0.00/0.02|0.05|0.13|0.08/0.06|0.46|0.29|DEAD|-|bumperF,doorL|headL|0:cracked,2:cracked,4:cracked
offset64|shape|1|0*|0.15|8|200|0.12|0.10|0.04|0.02|-0.20/-0.21|0.03|0.00/0.00|0.01|0.07|0.03/0.03|0.34|0.35|DEAD|-|bumperF,doorL|headL|0:cracked,2:cracked,4:cracked
tbone50|shape|0|0*|8.33|1477|0|0.01|0.33|0.36|0.01|-0.13/0.06|0.32|0.02/0.11|0.01|0.31|0.12/0.21|-|0.08|alive|-|-|headR,tailR|-
tbone50|shape|0|1|9.97|1443|1|0.71|0.74|0.10|0.26|0.35/0.62|0.10|0.03/0.11|0.01|0.41|0.32/0.22|-|0.27|alive|hubFL|bumperF|headL|-
tbone50|shape|1|0*|5.63|900|0|0.01|0.55|0.39|0.06|-0.08/0.39|0.33|0.04/0.16|0.01|0.24|0.14/0.20|-|0.10|alive|hubFR|doorR|headR,tailR|3:shattered,5:shattered
tbone50|shape|1|1|9.96|1370|1|1.02|0.70|0.08|0.33|0.66/0.17|0.03|0.20/0.11|0.02|0.67|0.39/0.14|-|0.27|alive|hubFL,hubFR|bumperF|headL|-
pole32|shape|0|0*|4.84|859|1|0.02|0.01|0.00|0.01|-0.01/0.00|-0.01|0.01/0.05|0.00|0.27|0.06/0.09|-|0.08|alive|-|-|headR,tailR|-
pole32|shape|1|0*|4.54|835|1|0.01|0.01|0.00|0.01|-0.01/0.01|-0.01|0.00/0.02|0.00|0.24|0.04/0.05|-|0.08|alive|-|-|headR,tailR|-
pole50rigid|shape|0|0*|0.07|1433|0|0.01|0.01|0.00|0.01|0.01/0.01|-0.02|0.00/0.01|0.00|0.22|0.02/0.03|-|0.09|alive|-|-|headR,tailR|-
pole50rigid|shape|1|0*|0.07|1430|0|0.01|0.01|0.00|0.01|0.01/0.01|-0.02|0.00/0.01|0.00|0.22|0.02/0.03|-|0.09|alive|-|-|headR,tailR|-
side50wall|shape|0|0*|0.42|1055|1|0.61|0.35|0.55|0.25|0.57/0.35|0.55|0.11/0.00|0.01|0.31|0.26/0.12|0.56|0.27|alive|-|doorL|headL,tailL|2:shattered,4:shattered
side50wall|shape|1|0*|0.42|761|2|0.56|0.28|0.36|0.18|0.43/0.28|0.27|0.11/0.02|0.01|0.28|0.17/0.10|0.56|0.21|alive|-|doorL|headL,tailL|2:cracked,4:cracked
rear50|shape|0|0*|0.10|12|114|0.14|0.14|0.07|0.12|0.14/0.14|-0.00|0.00/0.01|0.02|0.07|0.08/0.12|0.53|0.14|alive|-|bumperR,trunk|tailL|1:shattered
rear50|shape|1|0*|0.10|8|162|0.11|0.11|0.15|0.01|-0.01/-0.01|0.15|0.00/0.00|0.01|0.12|0.04/0.07|0.47|0.12|alive|-|bumperR|tailL|-
headon28|shape|0|0*|2.71|1333|1|1.14|0.48|0.08|0.61|1.14/0.47|-0.04|0.00/0.00|0.09|0.83|0.17/0.10|-|0.40|DEAD|hubFL,hubFR|bumperF|headL|-
headon28|shape|0|1|1.50|1317|1|0.48|0.69|0.10|0.39|0.48/0.68|-0.03|0.02/0.03|0.02|0.42|0.13/0.19|-|0.20|DEAD|hubFL,hubFR|bumperF,doorR|headR|3:shattered,5:shattered
headon28|shape|1|0*|0.78|926|1|1.14|0.48|0.10|0.49|1.00/0.34|0.01|0.09/0.04|0.04|0.73|0.45/0.11|-|0.62|DEAD|hubFL,hubFR|bumperF,doorL|headL|2:shattered,4:shattered
headon28|shape|1|1|1.26|921|1|0.38|0.98|0.08|0.46|0.25/0.95|-0.02|0.04/0.10|0.02|0.53|0.13/0.30|-|0.35|DEAD|hubFL,hubFR|bumperF|headR|-
headon56|shape|0|0*|5.56|1242|1|1.14|0.47|0.08|0.62|1.04/0.38|0.02|0.08/0.09|0.07|0.82|0.39/0.26|-|0.63|DEAD|hubFL,hubFR|bumperF,doorL|headL|2:cracked,4:cracked
headon56|shape|0|1|2.25|1209|1|0.47|1.10|0.09|0.60|0.39/1.04|-0.00|0.02/0.05|0.03|0.83|0.10/0.39|-|0.68|DEAD|hubFL,hubFR|bumperF,doorR|headR|3:cracked,5:cracked
headon56|shape|1|0*|0.75|470|3|1.13|0.46|0.09|0.61|1.00/0.35|0.01|0.01/0.10|0.03|0.85|0.37/0.23|-|0.67|DEAD|hubFL,hubFR|bumperF,doorL|headL|2:shattered,4:shattered
headon56|shape|1|1|2.05|489|3|0.41|1.03|0.07|0.62|0.39/0.86|-0.03|0.10/0.08|0.02|0.79|0.20/0.31|-|0.47|DEAD|hubFL,hubFR|bumperF,doorR|headR|3:cracked,5:cracked
== lattice
wall56|lattice|0|0*|0.18|14|110|0.32|0.01|0.09|0.03|0.21/-0.06|0.08|0.05/0.05|0.06|0.05|0.10/0.05|0.59|0.05|DEAD|-|bumperF|headL|0:cracked
offset64|lattice|0|0*|0.15|8|204|0.28|0.01|0.09|0.02|0.27/-0.07|0.08|0.06/0.05|0.06|0.06|0.10/0.05|0.22|0.05|DEAD|-|bumperF|headL|0:cracked
tbone50|lattice|0|0*|7.92|1000|0|0.01|0.54|0.42|0.07|-0.07/0.41|0.33|0.00/0.12|0.03|0.28|0.03/0.13|-|0.07|alive|hubFR,hubRR|doorR|headR,tailR|-
tbone50|lattice|0|1|8.73|1467|1|1.17|1.17|0.08|0.34|1.12/1.07|0.01|0.04/0.02|0.08|0.30|0.03/0.05|-|0.27|alive|hubFL,hubFR|bumperF,doorL|headL|0:cracked,1:cracked,2:cracked,3:cracked,4:cracked,5:cracked
side50wall|lattice|0|0*|0.42|562|2|0.79|0.01|0.39|0.15|0.50/-0.06|0.39|0.11/0.00|0.03|0.25|0.16/0.03|0.54|0.22|alive|-|doorL|headL,tailL|2:cracked,4:cracked
rear50|lattice|0|0*|0.10|12|115|0.09|0.09|0.15|0.00|0.05/0.05|0.10|0.07/0.04|0.01|0.14|0.04/0.03|0.47|0.04|alive|-|bumperR,trunk|tailL|1:shattered
headon28|lattice|0|0*|0.95|983|1|1.13|0.48|0.08|0.42|1.09/0.45|-0.01|0.03/0.03|0.07|0.33|0.02/0.04|-|0.26|DEAD|hubFL,hubFR|bumperF,doorL|headL|2:shattered,4:shattered
headon28|lattice|0|1|0.95|991|1|0.43|1.13|0.08|0.44|0.43/1.08|-0.01|0.02/0.01|0.07|0.33|0.02/0.03|-|0.28|DEAD|hubFL,hubFR|bumperF,doorR|headR|3:shattered,5:shattered
== sweep (shape, full speed)
wall20|shape|0|0*|0.21|41|13|0.08|0.12|0.00|0.01|0.06/0.08|-0.01|0.00/0.00|0.02|0.02|0.03/0.02|0.35|0.13|alive|-|bumperF|headL|-
wall35|shape|0|0*|0.16|17|55|0.18|0.17|0.01|0.01|0.16/0.13|-0.01|0.00/0.00|0.04|0.09|0.04/0.02|0.37|0.19|alive|-|bumperF,doorL|headL|-
wall48|shape|0|0*|0.16|17|76|0.13|0.09|0.08|0.02|0.07/0.00|-0.02|0.01/0.02|0.03|0.10|0.06/0.05|0.45|0.27|alive|-|bumperF,doorL|headL|-
wall56|shape|0|0*|0.17|14|110|0.14|0.04|0.08|0.02|0.04/-0.05|0.00|0.01/0.04|0.04|0.13|0.06/0.07|0.48|0.32|DEAD|-|bumperF|headL|0:cracked
wall64|shape|0|0*|0.15|13|135|0.16|0.04|0.08|0.03|-0.01/-0.07|0.05|0.00/0.03|0.05|0.16|0.10/0.08|0.49|0.30|DEAD|-|bumperF,doorL|headL|0:cracked,2:cracked,4:cracked
wall80|shape|0|0*|0.09|8|252|0.23|0.02|0.08|0.04|0.08/-0.21|0.06|0.03/0.06|0.05|0.35|0.24/0.08|0.57|0.38|DEAD|-|bumperF|headL|0:cracked
```

Other recorded per-run values:

- contact detection for walls at 0.029–0.043 s;
- `impactLocal.x = −0.49` for wall56, offset64, rear50 and head-on car 0
  (+0.49 for car 1);
- impactInward `[0, −1]` for frontal hits;
- mirror `hingeT = 0` in every run;
- `totalMass = 858`.

### A2. Cluster ↔ cage probe and roof press

Command: `node --experimental-strip-types --no-warnings .bench/probe.ts`
(1.1 s).

```
cages=18 clusters=22
cluster 0: beta reads cage[0]=bumperFront | masses bumperFL,bumperFR,engineL,engineR
cluster 1: beta reads cage[1]=bumperRear | masses bumperRL,bumperRR,axleR
cluster 2: beta reads cage[2]=bonnet | masses engineL,railL,wingFL
cluster 3: beta reads cage[3]=boot | masses engineR,railR,wingFR
cluster 4: beta reads cage[4]=roof | masses railL,doorL,cell,roof
cluster 5: beta reads cage[5]=doorLeft | masses railR,doorR,cell,roof
cluster 6: beta reads cage[6]=doorRight | masses engineL,railL,wingFL
cluster 7: beta reads cage[7]=wingFL | masses engineR,railR,wingFR
cluster 8: beta reads cage[8]=wingFR | masses axleR,tank,bumperRL
cluster 9: beta reads cage[9]=wingRL | masses axleR,tank,bumperRR
cluster 10: beta reads cage[10]=wingRR | masses engineL,railL,wingFL
cluster 11: beta reads cage[11]=chassisFront | masses engineR,railR,wingFR
cluster 12: beta reads cage[12]=chassisCell | masses railL,railR,cell,doorL,doorR,roof
cluster 13: beta reads cage[13]=chassisRear | masses railL,wingFL,doorL,cell
cluster 14: beta reads cage[14]=skirtLeft | masses railR,wingFR,doorR,cell
cluster 15: beta reads cage[15]=skirtRight | masses roof,engineL,engineR,railL
cluster 16: beta reads cage[16]=glassFront | masses bumperFL,wingFL,engineL,railL
cluster 17: beta reads cage[17]=glassRear | masses bumperFR,wingFR,engineR,railR
cluster 18: beta reads cage[18]=(none, 0.1) | masses bumperRL,doorL,tank,axleR
cluster 19: beta reads cage[19]=(none, 0.1) | masses bumperRR,doorR,tank,axleR
cluster 20: beta reads cage[20]=(none, 0.1) | masses doorL,roof,railL,cell
cluster 21: beta reads cage[21]=(none, 0.1) | masses doorR,roof,railR,cell
roof press 1x weight (8.4 kN, 1 s) shape: roof drop vs cell max=0.015 m end=0.009 m, cell dy=0.075
roof press 1x weight (8.4 kN, 1 s) lattice: roof drop vs cell max=0.068 m end=0.010 m, cell dy=-0.060
roof press 4x weight (33.7 kN, 1 s) shape: roof drop vs cell max=0.030 m end=0.028 m, cell dy=0.075
roof press 4x weight (33.7 kN, 1 s) lattice: roof drop vs cell max=0.068 m end=0.010 m, cell dy=-0.060
roof press 10x weight (84.2 kN, 1 s) shape: roof drop vs cell max=0.061 m end=0.010 m, cell dy=-0.060
roof press 10x weight (84.2 kN, 1 s) lattice: roof drop vs cell max=0.068 m end=0.010 m, cell dy=-0.060
roof press 40x weight (336.7 kN, 1 s) shape: roof drop vs cell max=0.068 m end=0.010 m, cell dy=-0.060
roof press 40x weight (336.7 kN, 1 s) lattice: roof drop vs cell max=0.068 m end=0.010 m, cell dy=-0.060
```

The cage names come from `CAGES` order. The probe built a
`StreamedDeformation` on a `BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6)`, as
`crash-parts.test.ts:dummyGeom` does, and read `snapshot().clusters`. The roof
press used `armMasses`, then `kickNearest(roof, 0, −1, 0, F·h)` +
`stepStructure(h)` + `syncPose(h)` at h = 1/240 for 240 slices.

### A3. Spec arithmetic

Command: `node --experimental-strip-types -e '...'`. It imports
`streamed-deform.ts`, `physics-core.js` and `shape-match-core.js` and
evaluates the real functions.

```
total 858 COMz 0.226 COMy 0.476 frontAxleShare 0.584 {"front":342,"cabin":336,"rear":180}
bumperFL soft 1 bands {"yield":0.134,"middle":0.403,"max":0.84} gate min/fatal m/s 1.80 7.00
wingFL soft 0.78 bands {"yield":0.109,"middle":0.327,"max":0.682} gate min/fatal m/s 3.78 12.72
engineL soft 0.16 bands {"yield":0.038,"middle":0.113,"max":0.235} gate min/fatal m/s 9.36 28.84
railL soft 0.3 bands {"yield":0.054,"middle":0.161,"max":0.336} gate min/fatal m/s 8.10 25.20
doorL soft 0.22 bands {"yield":0.045,"middle":0.134,"max":0.278} gate min/fatal m/s 8.82 27.28
tank soft 0.34 bands {"yield":0.058,"middle":0.175,"max":0.365} gate min/fatal m/s 7.74 24.16
cell soft 0.08 bands {"yield":0.028,"middle":0.085,"max":0.178} gate min/fatal m/s 10.08 30.92
hubFL soft 0.06 bands {"yield":0.026,"middle":0.078,"max":0.163} gate min/fatal m/s 10.26 31.44
yieldC 0.1050 creep@1/240 0.0915 maxE 0.580 iters 4 alpha 0.592 beta 0.360
```

### A4. wall56 time trace (full speed, subject car, excerpt)

Command: `TRACE=1 node --experimental-strip-types .bench/rig-crash.ts wall56 shape 0`.

- `gx` is the group x. The slab face is at x = 0.38.
- `massMinX` is the smallest `world.x − radius` over all masses.
- The other fields are the cell-relative rig metrics from §3.1.

```
t=0.0ms   vCOM=15.27 vCell=15.55 gx=2.515 massMinX=0.192  noseL=0.054 noseR=0.006 engine=0.006
t=9.0ms   vCOM=14.94 vCell=15.55 gx=2.376 massMinX=0.057  noseL=0.130 noseR=0.010 engine=0.017
t=13.5ms  vCOM=0.00  vCell=0.67  gx=2.342 massMinX=-0.005 noseL=0.140 noseR=0.014 engine=0.024
t=16.7ms  vCOM=0.00  vCell=-3.33 gx=2.342 massMinX=-0.043 noseL=0.056 noseR=-0.053 engine=-0.032
t=30.2ms  vCOM=1.08  vCell=-3.33 gx=2.373 massMinX=-0.158 noseL=-0.074 noseR=-0.201 engine=-0.176
t=63.5ms  vCOM=1.11  vCell=-3.33 gx=2.373 massMinX=-0.204 noseL=-0.199 noseR=-0.253 engine=-0.344
t=121.2ms vCOM=0.00  vCell=-4.92 gx=2.342 massMinX=-0.225 noseL=-0.058 noseR=-0.259 engine=-0.369
t=371.2ms vCOM=0.00  vCell=-5.13 gx=2.343 massMinX=0.029  noseL=0.064 noseR=0.008  engine=-0.169
t=521.2ms vCOM=0.23  vCell=-4.37 gx=2.483 massMinX=0.066  noseL=0.067 noseR=0.023  engine=-0.158
t=671.2ms vCOM=0.00  vCell=0.00  gx=2.483 massMinX=0.011  noseL=0.040 noseR=-0.049 engine=-0.192
```

How to read it:

- The group stops 0.17 m after contact, at 13.5 ms. That is the
  `clipCarToBarrier` hold at `minLx ≈ 2.34`.
- The front masses keep moving into the slab: `massMinX` reaches −0.236 at
  92 ms. A mass sphere's edge is then 0.62 m past the face, so its centre is
  at least 0.26 m past (the largest mass radius is 0.36).
- The nose then reads longer than rest relative to the cell.
- The cell mass's velocity stays at −3.3…−5 m/s while its position is held,
  then the group jumps 0.14 m back at about 0.5 s.

The full trace (52 lines) and the JSON files were left in the gitignored
scratch dir `/mnt/c/proj/crash-deformer-test/.bench/rig-analysis/`. The
scripts (`rig-crash.ts`, `probe.ts`, `summ.mjs`, `table.mjs`, `ask.mjs`) were
deleted after the run.
