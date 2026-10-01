# Control-particle density and LoD: spec

Status: **gate failed, not built** (lane skin-lod, 2026-10-01, on `9367e47` plus the anchored skin;
§6). The skin fix (A5) landed instead; the fine-patch LoD of §2–§4 stays unbuilt. The original
design was measured against `d117024` (snapshot in `.bench/particle-lod/snap`); its "+9 to +13 mm"
residual gain and "16–26 mm" coarsen pop were a harness artefact (§6.2). Inputs: `.extraResearch/SYNTHESIS.md` §B, the HPBD, Ste08b
(ASM08), FalkensteinRLP2017 (RC17) and sca2016 analyses, and Perplexity notes 20–22.

## 1. Decision

**Keep the 20 named masses as the only physics particles. Do not raise the count for every car.
Add one-way fine particles as *damage patches*: about 0.25 m apart, two layers thick, switched on
around a hit and baked into the skin when the car goes quiet.**
Do not use uniform 40/80/128-per-car tiers.

What the prototype measured (8 piston shots, 1500 kg at 40 km/h, shot minus a 3 km/h tap, rigid motion
fitted out the same way `measureShot` does it; tables in §5):

| Question | Answer | Evidence |
|----------|--------|----------|
| Can fine particles fix "one hit bends the whole side" (far particles move 0.065–0.140 m)? | **No.** A one-way layer reproduces the skeleton's far motion exactly: U128r far motion equals the embedding to the millimetre on all 8 pistons. The far motion is in the skeleton. | It does not go away with the car bolted down (`holdCar`: 0.076–0.173 m) or in lattice mode, which has no shape clusters (0.035–0.158 m). Corner and side shots are as bad in lattice mode as in shape mode, so the coupling is in the coarse beam/cluster graph, not the shove. |
| An HPBD-literal fine layer, where the fine clusters own the absolute shape? | **Rejected.** It hides far motion (U128 0.029–0.109 m against 0.062–0.146 m embedded) only by springing the whole car back toward rest. It removes 31–72% of the skeleton's dent (P25 full: 0.046–0.106 m against 0.119–0.180 m), with the rear shot as the exception (0.199 against 0.201 m). | §5 table A, "P25 full" column and the U-tier far columns. |
| A residual fine layer (fine clusters match only the deviation from the skeleton field)? | ~~**Small, real, local gain.** Under the 1.2 m face the paint goes in **+9 to +13 mm** further on every piston.~~ **Superseded (§6.2): no gain.** The +9 to +13 mm was a one-step double prolongation at refine; fixed, the patch adds 0.0–0.1 mm on every piston. Far motion changes by exactly 0. | P25r and P18r against the skeleton field, table A; §6. |
| Finer than 0.25 m? | Not worth it on these impactors: P18r dents equal P25r dents to within 1 mm. | Table A. |
| Narrow 0.3 m "pole" face? | ~~Fine particles add +9 to +16 mm.~~ Superseded (§6.2): 0.0 mm on 7 of 8 pistons; on the `front` pole the one-way patch is pushed 0.65 m into the car (risk 2 realised) and reads as +147 mm. | Table B; §6. |
| What limits dent fidelity today? | The skin path, not the particle count. Plain displacement embedding of the skeleton (IDW of the 20 masses) shows a **0.119 m** corner dent where today's cluster skin shows **0.046 m**. On the sides the cluster skin is deeper (0.202 against 0.149 m). **Fixed (§6.1)**: the anchored skin shows 0.097 m at the corners. | Table A, "real dent" and "skel-IDW" columns. This is defect A5 in the synthesis. |
| Cost | About **0.35–0.65 µs per fine particle per step** in contact (2 iterations, plasticity, prolongation, plane contact). Small layers cost up to 1.1 µs per particle because fixed overhead dominates. A 1.0 m patch at 0.25 m spacing (62 particles) costs **36–38 µs/step** in the bench. In-situ, JIT-cold, the 32–62 particle patches ran at 36–76 µs/step. The 4-iteration quiet mode costs about twice as much, so do not use it (see §3). | §5 table C. Two runs on a shared WSL box; `matchCluster` timed at 0.142 and 0.339 µs per call in the two runs. |

So more than 20 particles is only worth it as a capped, contact-driven visual and plastic detail layer.
The owner's main complaint, locality, needs skeleton work first: synthesis items A1–A8 and A11, cluster
spans, and plasticity gated per cluster. That work is outside this lane. Of the levers that exist today,
fixing the skin path (A5/A6) gives the largest dent-fidelity gain, more than any extra density.

A denser *two-way* skeleton, for example 6 more off-slab masses for A1, may well improve locality,
but it was not measured here [INFERENCE]. If the skeleton lane adds masses, they should be named and
fixed in number with no LoD. Physics that changes with the camera would make crash outcomes, AI and
replays depend on where the camera is. RC17 also finds that every cluster count needs its own stiffness
tuning.

## 2. Architecture

### 2.1 Layers

- **Skeleton (L0, always on).** This is today's 20 `MASS_SPECS` and the `SHAPE_CLUSTERS`. It stays the
  only authority for pose, hulls, drivetrain, contact impulses, crush energy and `collideWith`.
  Nothing the fine layer does is written back.
- **Fine patch layer (L1/L2, LoD).** It is one-way and residual:
  - Each fine particle `f` has a rest site `s_f`, 4 skeleton parents `j` with fixed weights `w_fj`
    (normalised `1/(d² + 0.04)` over the 4 nearest non-hub masses; hubs are never parents), an
    embedded position `e_f`, and a live position `x_f`.
  - **Prolongation (HPBD Eq. 7).** Every skeleton step `e_f += Σ w_fj (P_j − P_j^prev)` and
    `x_f += Σ w_fj (P_j − P_j^prev)`. Here `P` is the body-frame skeleton (the
    `syncShapeFromMasses` heading fit, so rigid motion is never prolonged).
  - **Residual** `r_f = x_f − e_f`. Fine clusters shape-match `y_f = s_f + r_f` against the rest
    sites, with their own `Sp` and `applyPlasticity`, and apply the same correction to `x_f`. The
    skeleton's deformation is therefore never "undone" by the fine layer, and the layer sits exactly
    on the skeleton field wherever nothing touched it.
  - **Contact.** Fine particles are projected out of the contact geometry (box and plane faces of the
    piston, barrier and compactor; the opposing car's crush hull in car-car contact). The push depth
    is clamped per particle to `FINE.maxResidual`, about 0.12 m, roughly one panel depth (risk 2).
  - **Patch boundary.** Particles in the outer 20% of the patch radius are kinematic (`kin = 1`): they
    sit on the skeleton field. This is HPBD's cardinality-1 attachment for inactive neighbours, and it
    makes the patch edge seamless (measured: far = 0 and no seam term in the skin metric).
- **Why residual and not HPBD-literal.** In HPBD the coarse level only accelerates convergence of the
  fine material. Here the skeleton is the authority, with its own plasticity. If the fine layer owned
  the absolute shape it would fight the skeleton's permanent set, which is the 31–72% dent loss in
  §1. The residual form keeps both properties we need: the fine layer cannot change gameplay
  physics, and wherever `r = 0` the fine layer agrees exactly with the L0 picture.
- **Residual frame.** `r` is stored in body-frame axes. Under a later large local rotation of the
  region, the orientation error is about `|r| × angle`, roughly 1 cm for a 5 cm dent turned 0.2 rad
  [INFERENCE]. When the patch coarsens the residual is moved into rest space (§3.4), which removes
  that error for baked dents.

### 2.2 Cluster generation (per body style, built lazily, no offline tool)

- **Sites.** Use a greedy Poisson-disk lattice over the unique rest positions of the body mesh
  (`restPos`, y between 0.12 and 1.5 m) at 0.25 m spacing. That gives 152 outer sites for the
  current body (about 304 particles over the whole car).
  - Each outer site gets an inner partner 0.15 m inward, toward the car's long axis at
    (0, 0.6, clamp(z, ±1.6)), so every region is at least 2 layers thick.
  - The generator is deterministic and takes milliseconds, so build it on the first
    `StreamedDeformation` of each body style and cache it in a module `Map` keyed by style.
  - The 5 styles share the skeleton but not the mesh, so there is one bake per style: about 100 kB of
    typed arrays each, about 0.5 MB in total.
- **Clusters.** Make one cluster per outer site: its 10 nearest sites from both layers, with its own
  inner partner forced in.
  - Reject planar clusters. `makeCluster(...).planar` flagged 1 of 152 at 0.25 m and 18 of 251 at
    0.18 m, so the generator must add the next off-plane neighbour until the cluster is not planar.
    "Never coplanar" is a bake-time assertion.
- **Parents.** The 4 nearest non-hub skeleton masses, as above. If the skeleton gains masses, the bake
  picks them up automatically.
- **Skin weights.** For each vertex, store up to 4 outer sites within `h = 1.6 × spacing`, with
  `φ = (1 − d/h)²`. At runtime the vertex residual is `Σ φ r / max(1, Σ φ)`. This is a Shepard
  average that fades to zero at the patch edge, so there is no seam.

### 2.3 Data layout (SoA)

```
FineBake (per body style, immutable)
  site      Float64Array(3·S)        rest xyz (outer 0..S/2-1, inner partners S/2..S-1)
  parent    Int32Array(4·S)          skeleton mass index
  pw        Float64Array(4·S)        parent weight
  nbr       Int32Array CSR           cluster member lists (offsets + indices)
  vtxSite   Int32Array CSR + Float32Array φ    vertex → ≤4 outer sites
FinePatch (runtime, pooled, preallocated at pool cap)
  ids       Int32Array(n)            bake site index
  e, rest   Float64Array(3n)
  kin       Uint8Array(n)
  x         ShapeParticle[n]         objects, because matchCluster/applyPlasticity take particles by object (unchanged core)
  y         ShapeParticle[n]         residual-space scratch
  clusters  ShapeCluster[]           makeCluster on the residual rest (see §3.4 re-refine)
```

Only `x`/`y` stay as objects, so the shared `shape-match-core.js` needs no change. A SoA
`matchCluster` is not justified: the measured per-call cost (0.14–0.34 µs) is already the budgeted figure.

### 2.4 Skinning

- `StreamedDeformation` gets `fineOffset: Float32Array(3·vertexCount)`, a rest-space displacement.
  `skin()` adds it to `restPos` before the existing per-vertex cluster transform, so baked dents ride
  every later rotation of the region.
- While a patch is active, its live residual for the patch's vertices is written into `fineOffset`
  each frame through `vtxSite`. Vertices outside every patch read only the skeleton skin, exactly as
  today.
- Weights go to the fine sites near damage, and the skeleton covers everything else, as the brief asks.
- The cost is O(vertices in patches): about 150–300 vertices per 1.0 m patch [INFERENCE from mesh
  density, 1231 unique paint positions per car].

## 3. LoD

### 3.1 Tiers

| Tier | What runs | Particles | Clusters | Cost (contact) | Cost (settling) |
|------|-----------|-----------|----------|----------------|-----------------|
| L0 | skeleton only (today) | 20 | 16 | today's | today's |
| L1 | L0 + 1 patch, r 1.0 m, 0.25 m spacing | +32–62 | +16–31 | 36–38 µs/step (bench); ≤ 76 cold | ≈ ¼ of contact, 1 iteration [INFERENCE] |
| L2 | L0 + up to 3 patches (the struck regions) | +≤ 192 | +≤ 96 | ≤ 3 × L1 | idem |
| Baked | L0 + `fineOffset` | 20 | 16 | 0 | 0 |

- There are 2 `stepStructure` calls per 60 Hz frame (as in the engine and in `firePiston`), so an L1
  patch in contact costs about 72–76 µs per frame (up to about 150 µs JIT-cold).
- Run the fine layer once per `stepStructure` call while contacting, and once per frame with
  1 iteration and no plasticity while settling.

### 3.2 Activation (refine) rule

Refine only when all of the following hold:

1. The car is mass-active and the contact window is opening: either at first touch (`applyImpact`,
   `feedOverlap`), or predicted by `contactEta() < 2 frames` with a known contact point. Use the
   predicted or actual struck point in the body frame as the patch centre.
2. The car is on screen at stride 1: `skinStride(car) === 1`, meaning projected size ≥
   `LOD_SMALL_PX`, or it is the followed car. Off-screen or small cars stay at L0, and their dents
   are carried by the skeleton only.
3. The pool has capacity (§3.5).

On a fresh hit, an existing patch whose centre is within 0.5 m of the new strike is reused. Otherwise
a new patch is added, up to L2's 3 patches per car.

### 3.3 Hysteresis and topology freeze

- **Freeze.** Never add, drop or reshape a patch while `contacting` holds (`bidirectional` or
  `elapsed − contactAt ≤ CONTACT_HOLD`). The only exception is creating a patch at window open, when
  the residual is 0 by construction.
- **Coarsen** when:
  - `quietTime() > 0.35 s`, and
  - max |Δr| per frame < 0.5 mm over the last 0.2 s, and
  - the patch's clusters agree plastically: `max ‖Sp − Sp_neighbour‖_F < 0.02`.
    - If they disagree the patch still bakes; the condition only decides whether the bake is lossless.
- **Screen hysteresis.** Refine needs stride 1. A patch that is already active is not dropped for
  going small until stride is 4 or 0 (tiny or off-screen) for 1 s, and even then it bakes rather than
  being discarded.

### 3.4 State transfer

- **Refine.**
  - `e_f` is the current embedding `s_f + Σ w_fj (P_j − P_j^0)`.
  - `x_f = e_f + r_baked(f)`, where `r_baked` is sampled from `fineOffset` back to the site (IDW of
    the site's nearest vertices).
  - The clusters are built by `makeCluster` on `y = s + r_baked`, so an old dent becomes the new
    rest, with `Sp = I` and `R = I`. That is a rest rebase, the same idea as A11.
  - The children's rotation history starts from the skeleton cluster that owns the region. Seed
    `Rprev` with it so `stabilizeMat` does not see a jump.
  - Measured: the residual is exactly 0 at activation, so the skin does not move on refine.
- **Coarsen.**
  - Write the residual into rest-space `fineOffset` (rotate by the inverse of the vertex's current
    blended cluster rotation), then free the patch.
  - Measured: dropping the patch without baking would pop the skin by **16–26 mm** (the
    "naive-coarsen pop" column), so the bake is mandatory. With the bake the pop is 0 by construction.
    **Superseded (§6.2):** with the refine double count fixed the residual left to pop is 1.2–1.8 mm.
- **Skeleton rebase (A11).** When the skeleton rebases its rest, `e` is re-derived from the new
  `P^0`. `fineOffset` is unaffected because it is rest-space.

### 3.5 Fleet budget allocator

- There is one global pool of fine particles, `FINE.poolCap`, default **768**.
- Worst case: 768 × 0.6 µs × 2 steps ≈ **0.92 ms/frame** with every pooled particle in contact.
  Typical: 3–6 cars contacting at once gives 0.2–0.5 ms.
- `poolCap = 0` switches the feature off. There is no separate flag.
- **Priority** (highest first), re-evaluated once per frame in `scheduleFine`:
  1. Followed or driven car in contact.
  2. Other on-screen cars in contact, ordered by contact energy (EBS² of the current hit), then by
     projected pixels.
  3. Settling patches (they keep their slot until they bake).
- Requests that do not fit wait. They are never pre-empted mid-window, because of the topology freeze.

| Cars | Pool | Typical use |
|------|------|-------------|
| 10 | 768 | Every contacting on-screen car can be L2 (≤ 192 each) |
| 24 | 768 | Followed car L2; about 6–10 others L1; the rest L0 |
| 32 | 768 | Same pool: pile-ups degrade to L1/L0 gracefully; the frame cost is capped |

## 4. Implementation plan (for a later lane, after A1–A8 + A11 + A5/A6 land)

### Prerequisites and gates

- The skeleton defects come first. The residual layer reads the skeleton field, so A6 (body-frame
  rest) and A5 (`Sp` in the skin) must be in, or the fine layer inherits wrong dents.
- **Measurement gate before building.** Re-run `.bench/particle-lod/shots.ts` on the post-fix
  skeleton. Build only if P25r still adds at least 5 mm under the face on at least 6 of 8 pistons.
  If the fixed skin path already gives sharp dents, stop at that point and record the result.

### Steps

1. **New module `src/game/fine-layer.ts`.**
   - `bakeFine(restPos, masses, spacing)` returns a `FineBake`, with the planar-cluster repair and
     the per-style cache.
   - `class FinePatch` with:
     - `activate(bake, centre, radius, P, P0, fineOffset)`
     - `step(dP, dt, contacts, contacting)`
     - `bakeInto(fineOffset, skinFrames)`
     - `release()`
   - `class FinePool` with `request`, `release` and `cap`.
   - Port the prototype's `FineLayer` (`.bench/particle-lod/fine.ts`) in residual mode only.
2. **`streamed-deform.ts` → `StreamedDeformation`.**
   - Add `fine: FinePatch[]` and `fineOffset`.
   - At the end of `stepStructure`, prolong the body-frame skeleton deltas and step the patches. Use
     `bodyCos`, `bodySin`, `bodyC` and `bodyRestC`, which `syncShapeFromMasses` already computes, so
     no second fit is needed.
   - Record the contact geometry for the fine layer in `projectOutOfBox`, the barrier path and
     `collideWith` (the other car's hull and its frame).
   - `skin()` adds `fineOffset` to rest.
   - The coarsen bake hooks into the same place as the A11 rest rebase.
   - `particleView` lists active fine particles with `lod: 1|2` and `sleeping`. The fields already
     exist in `ParticleView`.
3. **`engine.ts`.** Add `scheduleFine(cars)` next to `scheduleSkins`. It reuses `skinStride`,
   `followedCar` and the pool. `maybePreSlowmo`'s `contactEta` gives the predictive refine.
4. **`deform-helper.ts`.** Draw fine particles smaller, with the colour from `lod`.

### Tests (`src/game/fine-layer.test.ts`, piston harness `firePiston`)

| Test | Assertion | Why it can fail |
|------|-----------|-----------------|
| One-way invariance | The skeleton `local` and `world` of all 20 masses, and `crushAmount`, are bit-identical with `poolCap` 768 and 0 on 4 pistons plus `runWall(56)` | A write-back sneaks in |
| Far field untouched | Fine particles beyond the patch radius have `r = 0`. Skin vertices beyond the patch move by exactly the skeleton skin | The boundary ring or Shepard fade is broken |
| Refine continuity | Activating a patch mid-flight moves no skin vertex by more than 1 mm in that frame | Bad state transfer |
| Coarsen continuity | Baking moves no vertex by more than 1 mm. Positive control: the same test with the bake disabled moves at least 10 mm (measured 16–26) | Bake missing or in the wrong frame |
| Re-refine | Coarsen, then refine on the same spot: the skin moves by less than 1 mm, and after 1 s of quiet the residual has not sprung back (more than 90% kept) | Rest rebase on re-activation |
| Dent | P25 residual dent under the face is at least the skeleton-field dent + 5 mm on 6 of 8 pistons (measured +9 to +13) | Contact or plasticity not reaching the patch |
| Determinism | Two identical shots give bit-identical `x` (measured 0 difference) | Order-dependent pool or allocation |
| Budget | 32 cars all contacting: active fine particles ≤ `poolCap`, the followed car is served first, no patch changes during a contact window | Allocator bugs |
| Never coplanar | Every baked cluster of every body style has `planar === false` | Generator regression |

The far-particle locality todos in `piston-rig.test.ts` stay todos for this lane. The measurement says
the fine layer cannot move them, by construction. They are the acceptance test for the skeleton lane.

### Bench acceptance

- Extend `scripts/bench-physics.mjs` with a fine-pool case.
- Add physics + fine p95 ≤ 1.0 ms at 24 cars (derby) and ≤ 1.2 ms at 32 cars with `poolCap` 768 and
  every car contacting. The typical derby increase should stay under 0.5 ms.
- `fineµs` is reported separately from the deform buckets.

### Risks

1. **Value.** The measured realism gain is about +1 cm of local paint conformity, against 7–14 cm of
   far-field error in the skeleton. Building this before the skeleton and skin fixes would spend
   effort where it does not show. That is the reason for the gate above.
2. **Narrow impactors.** One-way fine contact has no reaction. A pole or a car corner that slips
   between skeleton spheres would push fine particles in without limit. Mitigations:
   - Clamp the residual (`FINE.maxResidual`).
   - If that looks wrong in practice, restrict the fine contact impulse to the parents
     (`Δp_j += w_fj Δx_f`, HPBD's cardinality-1 contact on every level). This makes the layer
     two-way, which breaks the invariance test and makes physics depend on the camera; it then needs
     its own decision and measurement.
3. **Formulation and tuning.**
   - HPBD-literal ownership of the absolute shape erases 31–72% of the dent (measured), so only the
     residual form is acceptable.
   - Residual orientation error under large rotation is about 1 cm [INFERENCE].
   - Per-tier stiffness differs (RC17).
   - At finer spacing the generator produced planar clusters (18 of 251 at 0.18 m).
   - Patch-edge seams depend on the Shepard fade.
   - Bench timings on this shared box vary by about 2× between runs.

## 5. Appendix: prototype and raw numbers

Files are in `.bench/particle-lod/` (gitignored):

- `fine.ts`: `FineLayer` with prolongation, plane contact, residual or full matching via the real
  `matchCluster`/`applyPlasticity`, and the FPS and lattice generators.
- `shots.ts`: hooks `PistonRig.prototype.attach` and `StreamedDeformation.prototype.stepStructure`
  on the snapshot, runs `firePiston` tap and shot per piston, and measures them.
- `bench.ts`: microbenchmark per tier.
- `summary.ts`: prints the tables below.
- `snap/`: `git archive d117024 src`.

```
cd .bench/particle-lod
node --experimental-strip-types --no-warnings shots.ts            # results.json   (standard 1.2 m face)
node --experimental-strip-types --no-warnings shots.ts narrow     # results-narrow.json (0.3 m face)
node --experimental-strip-types --no-warnings shots.ts hold       # results-hold.json (car bolted down)
node --experimental-strip-types --no-warnings shots.ts lattice    # results-lattice.json (no shape clusters)
node --experimental-strip-types --no-warnings shots.ts det        # determinism: max |Δ| = 0
node --experimental-strip-types --no-warnings summary.ts
node --experimental-strip-types --no-warnings bench.ts
```

### How the measurements work

- **Positive control.** My skeleton far-particle metric ("control") equals the real `pistonLocality`
  `farParticle` on all 16 standard and narrow runs. The body frame and the fit are therefore the same
  as the harness uses.
- **Dent** is the mean inward travel of skin vertices within 0.3 m of the strike, at face height.
- **Ring** is the same for vertices 0.1–0.4 m beyond the face's half-width, on the struck side.
- **Skel-IDW** is a skin driven only by the embedded skeleton field. It is the base the fine residual
  is added to.
- **Real** is today's cluster skin.
- **Layer names:**
  - `U40`, `U80`, `U128`: uniform farthest-point tiers over the whole car (2 layers).
  - `P25`, `P18`: 1.0 m patches at 0.25 or 0.18 m spacing, activated at first touch.
  - Suffix `r`: residual mode. No suffix: HPBD-literal (full).

**A. Standard face (1.2 × 0.5 m): skin dent / ring (m), naive-coarsen pop, P25r size and µs/step (in-situ, JIT-cold)**

```
piston      | real dent | skel-IDW dent/ring | P25 full dent/ring | P25r dent/ring  pop | P18r dent/ring  pop | U128r dent/ring | P25r n µs
frontLeft   | 0.046     | 0.119/0.098        | 0.056/0.104        | 0.128/0.104 0.022 | 0.129/0.105 0.025 | 0.119/0.098   | 32 36
front       | 0.111     | 0.180/0.135        | 0.051/0.106        | 0.192/0.143 0.024 | 0.192/0.143 0.026 | 0.180/0.135   | 42 63
frontRight  | 0.046     | 0.119/0.098        | 0.046/0.104        | 0.128/0.104 0.023 | 0.129/0.105 0.025 | 0.119/0.098   | 32 42
right       | 0.202     | 0.149/0.056        | 0.062/0.051        | 0.158/0.059 0.020 | 0.158/0.059 0.022 | 0.149/0.056   | 62 76
rearRight   | 0.161     | 0.154/0.109        | 0.106/0.115        | 0.167/0.115 0.025 | 0.167/0.115 0.026 | 0.154/0.109   | 38 47
rear        | 0.184     | 0.201/0.200        | 0.199/0.209        | 0.213/0.212 0.024 | 0.213/0.212 0.025 | 0.202/0.201   | 48 56
rearLeft    | 0.161     | 0.154/0.109        | 0.104/0.115        | 0.166/0.115 0.024 | 0.167/0.115 0.026 | 0.154/0.109   | 38 46
left        | 0.202     | 0.149/0.056        | 0.067/0.051        | 0.158/0.058 0.020 | 0.158/0.059 0.021 | 0.149/0.056   | 56 52

far motion (m, > 1.2 m from strike) — fine / embedded
piston      | real far (name)   | control | U40 fine/emb | U80 fine/emb | U128 fine/emb | U128r fine/emb | U128 site dent fine/emb
frontLeft   | 0.077 (bumperFR ) | 0.077   | 0.056/0.051  | 0.059/0.073  | 0.030/0.073   | 0.073/0.073    | 0.021/0.101
front       | 0.065 (axleR    ) | 0.065   | 0.120/0.062  | 0.092/0.062  | 0.086/0.062   | 0.062/0.062    |   -  /  -
frontRight  | 0.077 (bumperFL ) | 0.077   | 0.030/0.073  | 0.052/0.073  | 0.029/0.073   | 0.073/0.073    |   -  /  -
right       | 0.137 (bumperFR ) | 0.137   | 0.061/0.067  | 0.048/0.103  | 0.049/0.104   | 0.104/0.104    |   -  /  -
rearRight   | 0.140 (bumperFL ) | 0.140   | 0.066/0.118  | 0.070/0.118  | 0.087/0.119   | 0.119/0.119    | 0.050/0.146
rear        | 0.133 (tank     ) | 0.133   | 0.075/0.144  | 0.104/0.144  | 0.109/0.146   | 0.147/0.146    | 0.082/0.201
rearLeft    | 0.140 (bumperFR ) | 0.140   | 0.056/0.108  | 0.064/0.118  | 0.081/0.119   | 0.119/0.119    | 0.035/0.142
left        | 0.137 (bumperFL ) | 0.137   | 0.045/0.103  | 0.047/0.103  | 0.054/0.104   | 0.104/0.104    |   -  /  -
```

**B. Narrow 0.3 m face**

```
piston      | real dent | skel-IDW dent/ring | P25 full dent/ring | P25r dent/ring  pop | P18r dent/ring  pop | U128r dent/ring
frontLeft   | 0.014     | 0.124/0.121        | 0.096/0.108        | 0.133/0.128 0.016 | 0.134/0.128 0.019 | 0.124/0.121
front       | -0.049    | 0.084/0.106        | 0.040/0.068        | 0.095/0.114 0.016 | 0.095/0.115 0.017 | 0.094/0.120
frontRight  | 0.014     | 0.125/0.121        | 0.085/0.096        | 0.135/0.129 0.017 | 0.135/0.129 0.018 | 0.125/0.121
right       | 0.202     | 0.149/0.093        | 0.062/0.051        | 0.158/0.099 0.020 | 0.158/0.099 0.022 | 0.149/0.093
rearRight   | 0.188     | 0.161/0.154        | 0.162/0.157        | 0.173/0.164 0.017 | 0.173/0.164 0.018 | 0.161/0.154
rear        | 0.218     | 0.212/0.212        | 0.231/0.227        | 0.228/0.224 0.019 | 0.228/0.225 0.019 | 0.213/0.213
rearLeft    | 0.188     | 0.161/0.154        | 0.162/0.157        | 0.172/0.164 0.017 | 0.173/0.163 0.018 | 0.161/0.154
left        | 0.202     | 0.149/0.093        | 0.067/0.057        | 0.158/0.099 0.020 | 0.158/0.099 0.021 | 0.149/0.093
narrow far motion, real (control): 0.224 0.169 0.224 0.137 0.188 0.199 0.188 0.137; U128r = embedding on every piston
```

**Far-motion attribution** (real rig `farParticle`, m)

```
piston      free (shape)      held car (holdCar)   lattice mode (no shape clusters)
frontLeft   0.077 bumperFR    0.173 bumperFR       0.147 bumperFR
front       0.065 axleR       0.173 railL          0.046 bumperRR
frontRight  0.077 bumperFL    0.173 bumperFL       0.147 bumperFL
right       0.137 bumperFR    0.076 bumperRR       0.158 doorL
rearRight   0.140 bumperFL    0.159 bumperFL       0.148 bumperRL
rear        0.133 tank        0.136 engineL        0.035 railL
rearLeft    0.140 bumperFR    0.159 bumperFR       0.148 bumperRR
left        0.137 bumperFL    0.076 bumperRL       0.157 doorR
```

The held car takes the impactor's whole ½Mv², which is 2–3× the energy, so the held column is not an
equal-energy comparison. Far motion persists in it all the same.

**C. Cost per tier**: residual mode, `bench.ts`, deterministic jitter + advancing plane, best of 3 × 4000 steps, two runs on a shared WSL box

```
tier                    n  clusters planar spacing | contact µs/step run1 / run2 | quiet (4 it) run1 / run2 | µs/particle·step run1 / run2
U40                    40     20       1    0.87    |  38.6 /  44.0             |  84.6 /  61.0            | 0.964 / 1.100
U80                    80     40       2    0.59    |  68.5 /  66.0             | 127.0 / 100.9            | 0.856 / 0.825
U128                  128     64       1    0.44    | 114.0 /  76.7             | 159.3 / 138.7            | 0.891 / 0.600
patch P25 (r 1.0)      62     31       0    0.26    |  35.6 /  37.8             |  50.9 /  73.0            | 0.575 / 0.610
patch P18 (r 1.0)      98     49       0    0.20    |  33.8 /  57.3             |  63.5 / 108.0            | 0.345 / 0.585
patch P12 (r 0.7)      76     38       0    0.13    |  26.0 /  46.2             |  48.6 /  92.5            | 0.342 / 0.608
whole-car P25         304    152       1    0.27    | 107.2 / 199.3             | 203.4 / 377.0            | 0.353 / 0.656
whole-car P18         502    251      18    0.20    | 183.7 / 334.1             | 494.6 / 387.3            | 0.366 / 0.665
matchCluster, 10 members: 0.142 / 0.339 µs per call
```

- Run 1 shared the CPU with two piston sweeps and run 2 with other lanes' test runs, so read these as
  a range.
- In-situ skeleton `stepStructure` timings from the shots (13–299 µs per call) include JIT warm-up and
  are not used for planning. Use `npm run bench` for skeleton cost.
- Determinism: `shots.ts det` gave a maximum |Δ| of 0 over every fine layer between two identical
  `right` shots.

## 6. Gate re-run on the anchored skin (lane skin-lod, 2026-10-01)

Harness: `.bench/skin-lod/proto/` (the §5 prototype, `snap` → the lane worktree, plus `anchor.ts` and
`gate.mjs`); per-piston skin numbers: `.bench/skin-lod/measure.ts`. Same shots as §5 (1500 kg at
40 km/h, shot − tap, rigid motion fitted out).

### 6.1 Skin fix (A5), landed

Each skin vertex and cage corner sits on its parent masses (the 4 nearest non-hub masses by
1/(d² + 0.04), minus the 5th's weight so a parent fades out before it is swapped; cabin points take
cabin masses plus the cell-face share, D1), plus the blended cluster map on its short offset from
them with 0.65 of the cluster strain. At strain 1 the door paint 0.1 m outboard of the door particle
went 8% deeper than the particle.

```
piston      | skin dent before → after | struck particles | after / particles | far paint before → after (far particles)
frontLeft   | 0.045 → 0.097            | 0.121            | 0.80              | 0.095 → 0.095 (0.077)
front       | 0.111 → 0.245            | 0.252            | 0.97              | 0.086 → 0.081 (0.065)
right       | 0.202 → 0.215            | 0.213            | 1.01              | 0.119 → 0.126 (0.137)
rearRight   | 0.161 → 0.177            | 0.197            | 0.90              | 0.228 → 0.150 (0.140)
rear        | 0.184 → 0.202            | 0.223            | 0.90              | 0.160 → 0.165 (0.133)
```

Mirrored pistons match to 1 mm. Cost: skin + cages + bake 85 → 90 µs per crushed car per skin.
The narrow 0.3 m face is unchanged in kind (corners 0.012 → 0.010 m, front −0.049 → −0.031 m):
its corner dent region is a third wheel-arch vertices planted on the hub, and the front one is a
single vertex.

### 6.2 Fine-patch gate

Two harness defects in §5, both fixed for the re-run (`shots.ts fixrefine fixcontact`):

1. **Refine double count.** The patch was activated on this step's skeleton and then prolonged by
   the same step's ΔP. Every site kept that one-step offset (about 1 cm along the hit) as a uniform
   residual, which shape matching cannot remove. Positive control: P25r gains +9.2 to +12.5 mm with
   zero contact (`rearRight`, `rearLeft`: 0 touches) and the naive-coarsen pop is 20–25 mm. Fixed,
   the gain is 0.0–0.1 mm and the pop 1.2–1.8 mm.
2. **Contact window never open.** Piston pushes go through `projectOutOfBox`, which does not feed
   `contactAt`, so the fine layer always ran the quiet 4-iteration mode without plasticity. With the
   window taken from the piston planes (27–29 steps per shot) the fine clusters yield a little
   (‖Sp − I‖ ≤ 0.03) and still spring back.

`P25a` is the same residual patch embedded in the anchored skin field instead of the IDW field, so
its residual is what the patch adds over the improved skin. `peak` is the largest push of a fine
particle past its embedding during the shot (m ×1000): the most a perfectly plastic patch could keep.

```
piston      | skin  | IDW   | P25r as specced  Δ    pop | P25r fixed  Δ   pop  peak | P25a (over skin)  Δ  peak | gate (Δ ≥ 5 mm)
frontLeft   | 0.097 | 0.119 | 0.128   9.2  21.9 | 0.119   0.1   1.6  38.6 | 0.097   0.0  31.2 | no
front       | 0.245 | 0.180 | 0.192  12.5  23.9 | 0.180   0.0   1.3  38.6 | 0.245   0.0   1.3 | no
frontRight  | 0.097 | 0.119 | 0.128   9.6  22.6 | 0.119  -0.0   1.6  17.8 | 0.097  -0.0   1.8 | no
right       | 0.215 | 0.149 | 0.158   9.4  20.2 | 0.149  -0.0   1.3  88.7 | 0.215   0.0  33.3 | no
rearRight   | 0.177 | 0.154 | 0.167  12.1  24.9 | 0.154   0.0   1.8  13.0 | 0.177   0.0   2.0 | no
rear        | 0.202 | 0.201 | 0.213  12.2  23.9 | 0.201   0.0   1.2  20.6 | 0.202   0.0  19.8 | no
rearLeft    | 0.177 | 0.154 | 0.166  11.9  24.2 | 0.154   0.0   1.6   4.6 | 0.177   0.0   1.7 | no
left        | 0.215 | 0.149 | 0.158   9.7  20.4 | 0.149   0.1   1.3  88.7 | 0.215   0.0  33.3 | no
gate: 0 of 8 pistons (needs ≥ 6)
```

**Decision: do not build §2–§4.** The patch adds nothing over the anchored skin on any piston. A
re-tuned, more plastic patch cannot pass either: the face never gets more than 2 mm past the
anchored skin on `front`, `frontRight`, `rearRight` and `rearLeft`, so at most 4 of 8 pistons could
reach 5 mm. On the narrow face the one-way patch is pushed 0.65 m into the car on the `front` pole
(risk 2). More than 20 particles is only worth revisiting as a denser two-way skeleton (A1), which
changes physics and needs its own measurement.
