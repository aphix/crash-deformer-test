# Research synthesis: what to implement

Sources: the 16 `papers/*.analysis.md` files (each lane checked its code anchors and ran
throwaway probes against the real modules), plus the `perplexity/*.md` answers. Paper IDs:
M05 = Müller 2005 meshless shape matching, PBD06 = position based dynamics, SSM07 = screen-space
meshes, HPBD08 = hierarchical PBD, ASM08 = Steinemann adaptive shape matching, RAJ08 = Rajala
(Bugbear) thesis, OP11 = oriented particles, SBD14 = strain based dynamics, SR16 = robust
rotation extraction, SVG16 = simulating visual geometry, XPBD16, EP16 = elasto-plastic shape
matching (SCA 2016), RC17 = reclustering, SS19 = small steps, XRB20 = XPBD rigid bodies,
PBSM22 = physically based shape matching.

Line numbers drift. Search by symbol.

## A. Verified defects (found independently by at least two lanes unless noted)

| ID | Defect | Measured effect | Found by | Fix direction |
|----|--------|-----------------|----------|---------------|
| A1 | 10 of 22 clusters are 3-particle or coplanar. Most particles sit in a flat slab (y 0.36–0.56 m), so `A` is singular, `m3Invert` fails, and `m3Polar` returns R = S = I | These clusters never rotate or yield and act as translation-only springs (0.28 m goal error at a 0.3 rad yaw). The front bumper box and the rail triangles are among them | M05, SR16, RAJ08, EP16, OP11, PBSM22, ASM08 | Full-rank, volumetric clusters: more particles off the slab (roof, sills, floor), rank-tolerant rotation extraction (SR16), and the `n_cur n_restᵀ` or OP11 moment term for any planar cluster that remains |
| A2 | `clusterBeta` reads `cages[ci]` by cluster index, but clusters do not map 1:1 to cages | 13–15 of 22 clusters use another part's absorption. Left/right mirror error is 0.72 m and drops to 0.001 m once fixed | XPBD16, PBSM22, EP16, M05, OP11, ASM08 | Store absorption and stiffness on the cluster at build time |
| A3 | `cageClusterIndices` breaks the railL/railR distance tie by array order, so the glassFront cluster has no railR | Contributes to the left/right asymmetry | PBSM22, EP16 | Build a symmetric cluster table with tagged owners |
| A4 | 6 of 22 clusters are exact duplicates; the front triangles appear 3 times | Their stiffness is weighted 3× | RAJ08, EP16, M05, OP11 | Dedupe, or keep one copy with a multiplicity weight |
| A5 | `matchSkinLocal` builds `skinM` without `·Sp`, while `matchCluster` includes it | Plastic dents do not reach the rendered mesh: a 30% squash renders as 0%, and kernel-level z is 0.999 instead of 0.6 | SBD14, EP16, RAJ08, M05, OP11, ASM08 | Compose `Sp` into the skin transform, in the car-local frame (see A6) |
| A6 | The shape-match rest is captured in world space at first impact (`captureShapeRest`). The half-space clamp dots car-local `impactInward` with world-frame displacements | The same local frontal crush leaves bumperFL at local z 0.878 / 1.404 / 1.427 / 1.351 for yaw 0 / π/2 / π / −π/2. A rigid yaw of an undamaged car distorts the body by 0.17–0.96 m; world-frame `Sp` squashes the wrong axis (SBD14) | M05, OP11, SBD14, RAJ08 (open item) | Run shape matching in the body frame: rest and `Sp` in car-local axes, with goals rotated by the rigid core transform |
| A7 | Stiffness and plastic flow depend on the timestep: `goalAlpha`/`stiffnessIters` and the 0.14 m goal cap are applied per call, creep has a `max(dt, 1/120)` floor, and `satPushCap` has a 0.01 m floor | railL crush is 0.745 / 0.195 / 0.136 m at 1 / 4 / 8 slices (5.5×). Under slow-mo there is up to 19× more plastic flow per sim-second | XPBD16, SS19, PBD06, PBSM22 | Compliance-based (XPBD) goal relaxation and dt-consistent creep and caps. Add a slice-invariance regression test |
| A8 | `overlapFrame` (the contact flag) is cleared by the first `stepShapeMatch` slice of a frame | Slices 2–4 of a contact frame run the free-body branch | XPBD16, SS19 | Latch the contact flag for the whole `stepStructure` call |
| A9 | Rotational velocity sign: `bindKinematic`, `shatterGlass` and the pair torque use −ω×r | A car that is turning when its masses switch on gets bumper velocities mirrored by 6–11 m/s | XRB20 (finite-difference check) | Flip the sign to match how yaw is integrated |
| A10 | `tickInner`'s `vmax` reads `car.speed`, which is stale for mass-active cars that are not being driven | `physicsSlice` is chosen from a stale speed | SS19 | Use the actual velocity |
| A11 | Damage persists only because particles freeze after the contact window | 51–61% of a front crush is lost after a later hit; a rest rebase keeps 83% | RAJ08 | Rebase rest to the current shape when the contact window closes |
| A12 | The `applyPlasticity` rotation bake uses `lerp(I, R, t)`, which is not a rotation | It shrinks the rest by 4.5–6% and has no steady-state effect | EP16, M05, RAJ08 | Use a real rotation (slerp), or drop it once A6/A11 land |
| A13 | `m3Polar` takes the rotation from polar(Apq·Aqq⁻¹) and mishandles inverted `A` with a blind column-2 flip | 0.5–0.65 rad off the optimum when inverted; shear injects angular momentum | SR16, M05 | SR16 warm-started extraction (ShapeKernel lane) |
| A14 | The wrinkle noise is keyed by vertex index, while 460 vertices share 182 positions | Seams can open by about 4 cm (computed) | SVG16 | Key the noise by rest position or a weld id |
| A15 | FX and loose-part ground friction uses per-call factors; debris ignores the car's velocity; `sphereHit` has no friction | Results depend on frame rate; debris gets dragged along | XRB20 | Use `applyGroundFriction` (already in the repo) and relative velocity |

Notes:

- **Velocity coupling (by design).** Shape matching moves positions and never writes velocities. Every lane agrees that adding the PBD/M05 velocity update naively makes crashes rebound at 4–27 m/s, so keep positions-only and add damping that preserves the rigid modes (PBSM22 Alg. 2, PBD06).
- **Shared-stack fix order.** A1 (SR16 extraction) is the ShapeKernel lane. A2–A8 and A11–A12 belong to one "shape-match core" owner, because they all touch `stepShapeMatch`, `applyPlasticity` and the cluster table. A9, A10 and A15 are small fixes in the integration and contact code.

## B. Particle density and LoD: decision

The owner asked whether more than 20 control particles is more realistic within the perf budget,
and whether density could scale like LoD.

- **More particles: yes, but not as a flat increase.** The 20-particle rig is too flat (A1) and too
  coarse for local dents. Per-region cost is dominated by the polar step (65–80% of `matchCluster`, ASM08).
  At 24–32 cars that are all live, today's density is already near a 4 ms shape-match budget
  (ASM08), so extra density only pays on the few cars that are actually crashing.
- **Architecture (consensus of HPBD08, ASM08, RC17, EP16, OP11):**
  - Keep the 20 named masses as the permanent structural skeleton. Pose, hulls, drivetrain and contact keep using them.
  - Add an embedded, prebaked surface particle layer, volumetric with at least 2 cells through the thickness so regions are never coplanar.
  - Fine particles hold their own plastic state.
  - The coarse layer drives them by prolonging corrections (HPBD Eq. 7: pass down `p_j − q_j` with rest-pose parent weights). It does not rebuild them from scratch.
  - Clusters are volumetric neighbourhoods (ASM08 regions, RC17 radius rule), with stiffness and absorption stored per cluster.
- **LoD tiers:**

  | Tier | Particles | Regions | Cost per live car |
  |------|-----------|---------|-------------------|
  | L0 | 20 | about 16 | about 0.1 ms |
  | L1 | about 40–50 | about 30–70 | about 0.3 ms |
  | L2 | about 80–128 | about 45–130 | about 0.9 ms |

  - Fleet budget: about 300–550 live regions, or a global pool of about 2k fine particles (about 2 ms).
  - Priority: contact or strain above yield, then screen size, then damage history, with hysteresis.
- **State transfer:**
  - Refine: children start on the parent's current deformation field, inheriting the parent's `Sp` and rotation history, so nothing pops.
  - Coarsen: allowed only while the car is quiet and the children's plastic states agree. Otherwise bake the deformed skin and let the car sleep, which is what already happens after the contact window.
  - Never change topology during a contact window. RC17: fewer clusters look stiffer, so each tier needs its own stiffness tuning.
- **Prerequisites before raising the count** (ASM08, RC17):
  - Neighbour lists for building clusters.
  - A per-cluster broad-phase in `collideWith`, which is currently nA × nB.
  - Clear the A1–A8 defects first, otherwise the extra particles inherit the bugs.
- **Deform cost.** Skin and normal cost scales with vertices, not particles (ASM08). Particle LoD will not recover the 7–15 ms deform budget; that comes from section D below.

## C. Realism

### Measured structural gaps (from `docs/RIG_ANALYSIS.md`; crash harness in shape and lattice modes)

- **The nose does not crumple against a rigid wall.**
  - At 56 km/h the car stops 0.17 m after contact in 14 ms (about 110 g). A real car crushes 0.35–0.55 m over 90–140 ms at 18–25 g.
  - The front particles carry on 0.48 m past the slab, and the permanent nose crush is about 0.
  - Cause: `sat.ts` `clipCarToBarrier` (`bumperKeep`) holds the car's centre, and no particle is ever pushed back out of the slab.
  - The engine-kill check uses unsigned travel, so a forward stretch kills the drivetrain.
- **Car-to-car crush ignores speed.** Both 2×28 and 2×56 km/h hit the `clampLocal` cap (1.13 m). Full-overlap hits snap to one corner because the hulls are split left/right.
- **Side crush is capped at 0.11 m.** The leftover motion folds the car lengthwise instead.
- **Rear hits crush the nose more than the tail.**
- **Detach rules are off:**
  - The front bumper falls off at 20 km/h.
  - The left door falls off in frontal wall hits (real doors stay latched, FMVSS 206).
  - The mirror test never fires because it is checked in door-local space.
  - Wheels come off in a 2×28 km/h head-on but never in the 64 km/h offset hit.
- **The cabin particle structure is fine**: at most 0.06–0.10 m intrusion, and the roof holds 4× vehicle weight at 0.03 m. The cabin skin still moves 0.13–0.35 m because it blends the front clusters.
- The doc's implementation spec (groups A–E) gives the order: particle wall contact and signed engine travel first, then re-measure.

### Material, detachment and dents

- **Per-region material:**
  - Map cage absorption to a Young's modulus per cluster: `E_c = 0.5 MPa · 400^absorption` (PBSM22 Hookean projection, closed form, +73 ns).
  - Per-axis yield and strain limits from `maxCrush` / `maxAngle` (SBD14).
  - Work hardening (RC17).
  - When a cluster is ill-conditioned, re-rest it instead of hard-clamping at `maxE` (RC17, EP16).
- **Structure:** see `docs/RIG_ANALYSIS.md` (rig vs body-in-white, measured crush versus NCAP targets).
- **Detachment and hinges:**
  - Detach on load or cluster strain instead of `hingeT` crush thresholds, and keep the part's velocity when it detaches (XRB20, SVG16, RAJ08).
  - Doors, hood and trunk on real hinge joints with limits, where crush sets the minimum open angle (XRB20).
  - Wheels detach when a hub is popped by suspension failure.
- **Dents:** add a rest-space dent layer on the render mesh near contacts, pinned near the hubs (SVG16). This gives local detail without simulating the whole render mesh.

## D. Performance

| ID | Item | Evidence | Status / owner |
|----|------|----------|----------------|
| D1 | Recursive `updateMatrixWorld` on every pose sync | 35–45% of CPU; physics went from 53.7 to 10.6 ms at 24 cars | Done (70fc3e9) |
| D2 | Transparent DoubleSide glass is drawn in 2 passes, each with `needsUpdate` and `getProgram` | `getParameters` was 6–12% of CPU; 2× glass draws | Render lane: `forceSinglePass` on glass, the arena lip and the rings |
| D3 | `computeVertexNormals` | A raw-array area-weighted loop gives identical output 2.9× faster (SSM07). Alternatively, the unused `skinInvT` transform could produce normals (RAJ08, OP11) | Deform-perf lane |
| D4 | SR16 rotation extraction | `matchCluster` 495 → 262 ns | ShapeKernel lane |
| D5 | `satCars` evaluates the other car's hull list once per hull | — | Contact lane |
| D6 | View-dependent skin throttle with a `skinOwed` flag | — | Deform-perf / LoD lane |
| D7 | About 65 draw calls per car | Render submit is about 21 ms at 24 cars | Render lane: merge static sub-meshes, cut shadow casters |

## E. Deliberately not doing

- Simulating the full render mesh (SVG16): about 41k primitives across 24 cars, far over budget.
- A car body as a single XPBD rigid body or the RC-car model (XRB20).
- A naive velocity update from projection (bounces).
- Global volume conservation (a crushed hollow body should lose volume).
- SSM07 angle-weighted normals: they flip about 13% of normals on this mesh.
