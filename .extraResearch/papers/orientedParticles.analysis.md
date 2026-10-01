# Oriented Particles (Müller & Chentanez, SIGGRAPH 2011) — analysis for crash-deformer-test

Source: `orientedParticles.md` (rewrite of the paper and slides). All code anchors below were checked against the working tree on 2026-10-01. `src/game/streamed-deform.ts` was being refactored at the same time (specs moved to `src/game/rig-spec.ts`, `startsWith("hub")` changed to `m.hub`), so line numbers in that file can drift; symbol names are the stable reference. Every "measured" number comes from throwaway node scripts that imported the real modules (`StreamedDeformation`, `shape-match-core.js`) and were run with `node --experimental-strip-types`. None of those scripts were added to the repo.

## Summary

- **The problem the paper solves is the one this repo has.** Shape matching (Eq. 1–4) needs particles that span 3D. When they are near-co-planar or co-linear, $\mathbf{A}$ becomes singular and $\mathbf{R}$ is undefined or jitters. Our rig has 20 control particles in clusters of 3–6, and **10 of the 22 clusters are exactly planar** (measured below).
- **The fix: per-particle orientation enters the moment matrix.** Each particle contributes its own moment matrix $\mathbf{A}_i = \tfrac15 m_i r_i^2\mathbf{R}_i$ (sphere) or $\tfrac15 m_i\,\mathrm{diag}(a^2,b^2,c^2)\mathbf{R}_i$ (ellipsoid). The group matrix becomes $\mathbf{A}=\sum_i(\mathbf{A}_i + m_i(\mathbf{x}_i-\mathbf{c})(\bar{\mathbf{x}}_i-\bar{\mathbf{c}})^T)$, which has full rank even for one particle. Intuitively, each particle acts like 6 virtual points at $\pm r\sqrt{3/5}$ along its own axes.
- **Orientation is real state, not a static fill-in.** Unlike the stabilized polar decomposition of Becker and Schmedding, which fills missing directions with identity, $\mathbf{q}$ and $\boldsymbol{\omega}$ are integrated with PBD (Eq. 10–15). Shape matching then writes the group rotation back into the center particle (implicit groups) or into all members (explicit/rigid groups). This keeps the choice of the missing eigenvectors temporally consistent, so there is no jitter.
- **The model is particles plus edges, with one implicit shape-match group per particle (itself and its 1-ring).** Optional PBD distance constraints separate stretch from bending, and an edge slerp (Eq. 22–23) gives torsion. Stiffness is set per particle.
- **Explicit groups give rigid parts; shared non-oriented particles give joints.** For a particle shared by two explicit groups, $\mathbf{A}_i=0$, so rotation does not leak between groups. The monster truck uses a rigid chassis, two rigid axles and a plastic body.
- **Plasticity is absorbed into one rest pose shared by all groups, never into per-group copies.** Per-group copies cause ghost forces. Skinning uses $d_i\circ r_i\circ b_i^{-1}$ (deformation ∘ plastic rest ∘ inverse bind) and collision uses $d_i\circ r_i$. Absorption is $r_i\leftarrow s^{-1}\circ d_i\circ r_i$, where $s$ is the rigid transform of the group.
- **Skinning: each vertex uses linear blend skinning over at most 4 oriented particles.** This works even far from the particles and with very sparse rigs. Dual quaternion blending is optional.
- **Ellipsoid collision shapes come from the visual mesh.** Orientation is the polar decomposition of the covariance of nearby vertices; radii are the OBB extents clamped to $[r/2, r]$. Collision uses the closed forms in Appendix A, where A.2 is only approximate.
- **Cost model:** time is dominated by per-particle shape matching and by skinning. Integrating orientation costs almost nothing. With 300 particles and a 63k-vertex mesh, skinning (30 ms) dwarfs simulation (8 ms). An oriented rope needs 6× fewer particles and runs about 6× faster than a non-oriented one.

## Useful content

**Generalized moment matrix (the core trick).** It fits the repo's linear form $A = A_{pq}A_{qq}^{-1}$ directly:

$$
A_{pq}' = \sum_i m_i(\mathbf{x}_i-\mathbf{c})\mathbf{q}_i^T + \kappa\sum_i \tfrac15 m_i r_i^2\,\mathbf{R}_i\bar{\mathbf{R}}_i^T,\qquad
A_{qq}' = \sum_i m_i\mathbf{q}_i\mathbf{q}_i^T + \kappa\sum_i \tfrac15 m_i r_i^2\,\mathbf{I}.
$$

Here $\mathbf{R}_i\bar{\mathbf{R}}_i^T$ is particle $i$'s rotation since rest. $\kappa$ (paper: 1) scales the orientation coupling. With our radii (0.26–0.5 m) and masses (8–260), $\tfrac15 m r^2$ runs from 0.11 (bumperRL) to 13 (cell). That is comparable to the cluster $A_{qq}$ eigenvalues (2–55, measured), so $\kappa$ matters and should be tunable. The term also makes the 1e-3 diagonal hack in `rebuildAqqWeighted`/`matchSkinLocal` unnecessary.

**Orientation update rules (paper §5.1/§5.3).**
- Implicit group: only the center particle gets $\mathbf{R}_{group}$.
- Explicit (rigid) group: every member gets $\mathbf{R}_{group}$.
- A particle in more than one explicit group is non-oriented ($\mathbf{A}_i = 0$).
- Over-stiff coupling is avoided because generalized shape matching only changes orientation along the directions spanned by $\mathbf{A}$. For a chain, twist about the chain axis stays free.

**Integration (Eq. 10–15), if angular velocity is wanted.**
- Predict: $\mathbf{q}_p = [\hat{\boldsymbol\omega}\sin(|\boldsymbol\omega|\Delta t/2), \cos(|\boldsymbol\omega|\Delta t/2)]\,\mathbf{q}$.
- Recover: $\boldsymbol\omega = \mathrm{axis}(\mathbf{q}_p\mathbf{q}^{-1})\,\mathrm{angle}(\mathbf{q}_p\mathbf{q}^{-1})/\Delta t$, taking the short arc (negate when $r.w<0$).
- Use $\varepsilon$ guards for small $|\boldsymbol\omega|$ and small angles.
- Precession is ignored; the paper says this is fine for multi-particle bodies.

**Stiffness scalars.** With variable $\Delta t$, use $s = s'\Delta t$ to reduce step-size dependence. Our substep count varies (`stepStructure`: `slices = round(dt*240)`, 1–4).

**Plastic workflow (§5.4).**
- Trigger: a collision with relative velocity above a threshold.
- Disable the rigid group for N frames (paper: 5) so soft implicit matching deforms.
- Re-enable, then absorb $r_i \leftarrow s^{-1}\circ d_i\circ r_i$ into a single rest pose shared by all groups.
- Keep the bind pose $b_i$ for skinning: vertex transform $= d_i\circ r_i\circ b_i^{-1}$.

**Torsion (Eq. 22–23).** For each edge, $\mathbf{q}_1 \leftarrow \mathrm{slerp}(\mathbf{q}_1,\mathbf{q}_2,\tfrac12 s_{torsion})$, and symmetrically for $\mathbf{q}_2$.

**Friction with spin (Eq. 16–21).** Tangential velocity is matched by $s_{lin}$. The contact-point slip $\mathbf{v}_s-\mathbf{v}-\boldsymbol\omega\times\mathbf{r}$ is removed through $\Delta\boldsymbol\omega = \frac{\mathbf{r}}{|\mathbf{r}|^2}\times(\ldots)\,s_{rot}$.

**Ellipsoid fit (§6.2).**
1. Gather vertices within $r$.
2. Orientation = polar decomposition of the covariance.
3. Radii = OBB extents in that frame, clamped to $[r/\sigma, r]$ with $\sigma=2$.
4. Optionally iterate re-centering so particles move to feature centers.

**Ellipsoid–plane contact (A.1, exact).** $\mathbf{x}=\pm\mathbf{A}^{-1}\mathbf{n}/\sqrt{\mathbf{n}^T\mathbf{A}^{-1}\mathbf{n}}$; take the root with smaller $\mathbf{n}^T\mathbf{x}$. A cheaper support-radius approximation is $r(\mathbf{n}) = \sqrt{\mathbf{n}^T\mathbf{A}^{-1}\mathbf{n}}$, which is the paper's Fig. 2(b) idea.

**Skinning (§7).**
- Use ≤4 influences per vertex.
- Blend full per-particle transforms with LBS; DQS is optional.
- Restrict links to a selected particle subset so separately moving parts (tentacles, or for us doors and hood) do not bleed into each other.

**Cost data points.**
- Paper, single Core2 core: 300 particles + 750 edges, simulation including self-collision takes 4 ms. 1k particles + 3.5k edges: 10 ms. Two trucks of 300 particles: 8 ms. Skinning a 63k-vertex mesh: 30 ms for two trucks.
- Slides, Core i7 + GTX 480 skinning: 10 trucks at 20 fps.
- Ours, measured with `npm run bench`:
  - `matchCluster`: 549 ns/op, of which `m3Polar` is 310 ns/op.
  - `applyPlasticity`: 310 ns/op.
  - `transformSkinPointInto`: 11.4 ns/op.
- Ours, per car per frame:
  - Shape step: 22 clusters × 2–5 iterations × ≤4 slices ≈ 176–440 `matchCluster` calls ≈ 0.1–0.24 ms.
  - Chassis mesh: 1212 vertices / 1712 triangles. `skin()` takes 0.26–1.1 ms per car in node (noisy WSL runs); `computeVertexNormals` is 0.07–0.25 ms of that. A CPU profile put the normals path (`computeVertexNormals` + `fromBufferAttribute` + `normalizeNormals` + `setXYZ`) above the skin loop's own self time.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Moment matrix Eq. (1), centers Eq. (2)–(3) | `src/game/shape-match-core.js:311-333 matchCluster` (`_Apq` built at 328–332, `A = Apq·AqqInv` at 333); `:242-299 makeCluster` (rest COM, `q0`) | variant | Uses Müller 2005's linear form $A_{pq}A_{qq}^{-1}$ and takes the polar of that instead of $A_{pq}$. Same $\mathbf{R}$ for rigid motion; differs under stretch. |
| Polar decomposition $\mathbf{A}=\mathbf{RS}$ | `src/game/shape-match-core.js:102-145 m3Polar` | contradicts (for degenerate A) | Newton iteration with a full 3×3 inverse. When `m3Invert` fails (`|det| < 1e-12`, line 110) it returns **R = I, S = I**. A planar cluster always has $\det A\approx10^{-14}$, so it can never rotate or stretch. This is exactly the "R not well defined" case of §3, handled by giving up. |
| Rotation clamp | `src/game/shape-match-core.js:137 m3Polar → m3ClampRotation(R, 0.85)`; `:178 m3ClampRotation` | missing in paper / contradicts | No counterpart in the paper. Combined with the world-space rest (row below), any body yaw beyond 0.85 rad since `beginCrush` is read as deformation. |
| Static stabilization (Becker/Schmedding) instead of oriented state | `src/game/shape-match-core.js:306-308 rebuildAqqWeighted` and `:488-490 matchSkinLocal` (`+= 1e-3` diagonal); `:193-219 stabilizeMat` / `:220 stabilizeR` (blend toward `Rprev`) | variant (the approach the paper argues against) | The 1e-3 regularizer is isotropic and static. For planar clusters it does not restore rank, because $A_{pq}\bar{\mathbf{n}} = 0$ exactly. `stabilizeR` is a state variable, but it is blended per **iteration** (called inside `matchCluster`, which runs 2–5× per slice and up to 4 slices per frame), so lag depends on the iteration count. |
| Oriented-particle moment $\mathbf{A}_i=\tfrac15 m r^2\mathbf{R}_i$, Eq. (7)–(9) | missing. Would go in `src/game/shape-match-core.js:311 matchCluster` (add to `_Apq` after line 332), `:300 rebuildAqqWeighted` (diagonal), `:449 matchSkinLocal` | missing | Particle radius already exists (`src/game/rig-spec.ts:118-139 MASS_SPECS.radius`, copied to `MassNode.radius`). `ShapeParticle` (`src/game/shape-match.ts:9-17`) has no orientation field. |
| Per-particle orientation and spin $\mathbf{q},\boldsymbol\omega$, Eq. (10)–(15) | missing. `ShapeParticle` at `src/game/shape-match.ts:9-17`; particles built at `src/game/streamed-deform.ts:375 constructor (this.shapeParticles = …)` | missing | Masses carry only `world`, `local`, `vel`. The body's rigid pose is rebuilt heuristically in `followGroup` (`src/game/streamed-deform.ts:969`) from the engine midpoint, `axleR`, `cell` and an engine-height roll, with pitch and roll clamped. |
| PBD integration $\mathbf{v}\leftarrow(\mathbf{x}_p-\mathbf{x})/\Delta t$, Eq. (12) | `src/game/streamed-deform.ts:1706 stepShapeMatch` (moves `p.x/y/z` only) → `:566 writeShapeToMasses` writes back the **unchanged** `p.vx` | contradicts (deliberately) | Shape-match corrections never change velocity, so there is no elastic second-order response. Positions are integrated with semi-implicit Euler at `:1881 stepMassSlice` (`m.world.addScaledVector(m.vel, dt)`). Reasonable for metal (plastic, no spring-back) but it differs from the paper. |
| Goals Eq. (4) and $s_{stiffness}$ | `src/game/streamed-deform.ts:1737-1751 stepShapeMatch` (goal = `c.M·q + cm`, averaged over overlapping clusters); `:1724-1729` (`alpha`, `iters`); `:1778` (0.14 m step cap) | variant | Jacobi-style averaging over clusters rather than Gauss–Seidel per group. `M = R·lerp(I,S,β)` (`shape-match-core.js:337-338`) adds the Müller-2005 linear blend. A half-space clamp along the impact axis is at `:1768-1772`. |
| Implicit groups: one per particle plus its 1-ring over edges | Edges exist as `src/game/rig-spec.ts:142-189 BEAM_SPECS` (46 edges, lattice mode only); clusters are built per cage plus 6 extras in `src/game/streamed-deform.ts:388-411 constructor` and `src/game/rig-spec.ts:192-199 EXTRA_CLUSTERS` | variant | 22 clusters, only 16 unique. `[engineL,railL,wingFL]` appears 3× (#2, #6, #10), `[engineR,railR,wingFR]` 3×, and `{railL,doorL,cell,roof}` / `{railR,doorR,cell,roof}` 2× each. Duplicates count multiple times in goal averaging and in skin influences. |
| Per-particle stiffness (Fig. 3(c)) | `src/game/streamed-deform.ts:1697-1704 clusterBeta` (`this.cages[ci]` indexed by **cluster** index) | contradicts (index bug) | Clusters do not map 1:1 to cages: 4 cages are skipped, 2 are split L/R, and 6 extras are appended. 15 of 22 clusters read another cage's `absorption`, which creates L/R asymmetry. Examples: #4 (built from doorLeft, 0.22) reads roof (0.52) while its mirror #5 reads 0.22; #10 (chassisFront L, 0.28) reads wingRR 0.16 while #11 reads 0.28; the front-corner EXTRA clusters #16/#17 read glassFront/glassRear 0.48/0.50. |
| Explicit rigid group, transform $s$ | `src/game/streamed-deform.ts:969 followGroup` (rigid pose from 4 masses + clamps); no explicit shape-match group | variant | No least-squares rigid fit of the core. The world→local transform used everywhere comes from this heuristic. |
| Rest state in rest space, $r_i \leftarrow s^{-1}\circ d_i\circ r_i$ | `src/game/streamed-deform.ts:538-551 captureShapeRest` (world positions → `resetCluster`, called once from `:595 beginCrush` at `:616`); `beginCrush` only runs from `src/game/car.ts:610-625 applyImpact` while `!crashed` (`src/game/pair-contact.ts:84-85`) | contradicts | Cluster rest `q0` is captured **once, in world space**, at the first crash. Later live phases compare world positions against that heading, so body rotation looks like deformation (measured below). |
| Single shared rest vs per-group rest copies ("ghost forces") | `src/game/shape-match-core.js:345-391 applyPlasticity` (per-cluster `Sp` creep at 350–353, per-cluster `q0` rotated by `c.R` at 370–383) | contradicts | Each cluster absorbs plasticity into its own `q0`/`Sp`. Overlapping clusters then disagree on rest, which the paper says produces ghost forces. Matches the in-code note "Residual bounce / cluster breathing … polar snap-back flicker" at `src/game/streamed-deform.ts:1204-1208 update`. `q0` is also rotated by the world-space `c.R`, which includes body yaw since the first crash. |
| Plastic trigger: impact speed above a threshold → soft for N frames | `src/game/streamed-deform.ts:1706 stepShapeMatch` (`contacting` → lower `alpha`, 2 iterations, β per `clusterBeta`, `applyPlasticity` at `:1813-1815`); yield/creep in `shape-match-core.js:347-366` | variant | Same idea (soften during contact, absorb into rest), but gated by contact/overlap frames rather than a velocity threshold plus a fixed frame window. |
| Skinning transform $d_i\circ r_i\circ b_i^{-1}$ | `src/game/shape-match-core.js:449-501 matchSkinLocal` (fits `Sp·q` → current at 484–486, then `skinM = skinR·lerp(I,S,β)` at **497 without `Sp`**) vs `:340 matchCluster` (`skinM = M·Sp`) | contradicts | The production skin path (`src/game/streamed-deform.ts:1997 bakeLocalSkin` → `matchSkinLocal`) drops the plastic rest $r_i b_i^{-1}$. Once plasticity has absorbed a dent, the skinned mesh springs back even though the particles stay dented (measured below). |
| LBS over ≤4 influences | `src/game/streamed-deform.ts:416-452 buildSkinWeights` (top-4 clusters by `exp(-2.35 d)`, cutoff 1.45 m at 441/446); `:2163 skin` (blend at 2181–2185) | variant | Same ≤4 LBS, but over **cluster affine transforms** (R·S·Sp) rather than per-particle rigid transforms. 10 of 22 clusters contribute translation only, because their `skinR` and `S` are identity. |
| Normals from transforms | `src/game/shape-match-core.js:446 transformNormal` / `skinInvT` (built at 342–343 and 499–500) vs `src/game/streamed-deform.ts:2261 skin → geometry.computeVertexNormals()` | missing (unused helper) | `skinInvT` is computed every match but only used in `shape-match.test.ts`. Production recomputes normals from triangles. |
| Ellipsoid shapes and contact (§6, App. A) | `src/game/streamed-deform.ts:931 collideWith` (all 20×20 mass pairs as spheres) and `:2267 sphereHit` (`_n.y *= 0.18`) | missing | Spheres of radius 0.26–0.5 m. Primary car–car contact is the 2D SAT hulls (`src/game/sat.ts`, `src/game/pair-contact.ts`); `liveHulls` at `streamed-deform.ts:1244` builds axis-aligned local boxes from mass positions with no orientation. |
| Joints via shared non-oriented particles (§5.3) | `src/game/car.ts:809-812` (`hingeT` targets) and `:821-849` (scripted cowl/tail/door/two-point rotations); `:952 detachPart` | missing | Hinges are keyframed from crush amount, not simulated; detached parts are rigid bodies in `stepLooseParts`. |
| Torsion slerp (Eq. 22–23) and spin friction (Eq. 16–21) | missing. Would go in `stepShapeMatch`, and ground friction in `stepMassSlice` (`applyGroundFriction`, `:1881` region) | missing | Requires per-particle orientation and spin first. |

### Measurements behind the anchors

All from throwaway scripts against the current tree.

1. **Planar clusters.** Each of the 22 clusters was rigidly rotated by 0.3 rad about x, y and z, then `matchCluster(c, P, 0)` was run.
   - #0 [bumperFL,bumperFR,engineL,engineR], #1 [bumperRL,bumperRR,axleR], #2/#6/#10 [engineL,railL,wingFL], #3/#7/#11 (mirror), #8 [axleR,tank,bumperRL] and #9 (mirror): smallest $A_{qq}$ eigenvalue ≈ 0, $\det A\approx10^{-14}$, recovered rotation **0°**, i.e. an error of the full 17.2°.
   - The other 12 clusters recover the rotation exactly.
   - #18 [bumperRL,doorL,tank,axleR] and its mirror #19 are near-planar (smallest eigenvalue 8e-5, below the 1e-3 regularizer, $\det A = 0.074$).
2. **Skin after a real crush.** Offset frontal hit, `squash = 0.5`, 24 frames of `feedOverlap`, same setup as `shape-match.test.ts` "frontal pulse": **10/22 clusters end with `skinR == I` and `S == I` exactly**. The non-degenerate clusters reach `skinR` of 17–50°, i.e. they saturate near the 0.85 rad clamp.
3. **Oriented term fixes planar clusters.** Adding $\sum\tfrac15 m r^2\mathbf{R}_i$ to $A_{pq}$ and $\sum\tfrac15 m r^2\mathbf{I}$ to $A_{qq}$, on the same planar clusters and 0.3 rad rotations:

   | Particle orientation used | Error |
   |---|---|
   | true $\mathbf{R}_i$ | 0.00° |
   | $\mathbf{R}_i$ lagging by 0.05 rad | 0.7–2.4° |
   | static $\mathbf{R}_i = \mathbf{I}$ (Becker-style) | 4–14° |
   | current code | 17.2° |

   So the term needs real orientation **state**, as the paper argues.
4. **World-space rest after the first crash.** `beginCrush`, settle 60 frames, then yaw the whole wreck rigidly while keeping it live (`notifyContact`). The metric is the maximum non-hub change of `m.local` (body-frame shape):

   | Yaw | Instant yaw | Gradual yaw (spread over 40 live frames) | Gradual, degenerate clusters removed |
   |---|---|---|---|
   | 0 (control) | 0.075 m | 0.079 m | — |
   | 0.5 rad | 0.20 m | 0.17 m | 0.23 m |
   | 1.0 rad | 0.32 m | 0.19 m | 0.47 m |
   | 1.57 rad | 0.48 m | 0.19 m | 0.43 m |
   | 3.14 rad | 0.96 m | 0.38 m | 0.43 m |

   Removing the degenerate clusters does not help (last column), so the world-space rest plus the clamp/`stabilizeMat` is the cause, not degeneracy alone.
5. **Plastic dent springs back in skin.** Six-particle cluster, particles squashed to z·0.6, `matchSkinLocal(..., β = 1)`, rest vertex (0,0,1):

   | `Sp_zz` | Skinned z |
   |---|---|
   | 1.0 | 0.600 |
   | 0.8 | 0.750 |
   | 0.6 (dent fully absorbed) | **0.999** |

   The skinned dent disappears while the particles stay dented.
6. **Appendix A.2 accuracy.** Four random ellipsoid pairs: the paper's $d$ was −2.5 %, −6.6 %, −1.1 % and +0.1 % relative to the bisection-found touching distance.

## Candidates to implement

Ordered by value/cost. "Measured" refers to the list above. Items 3 → 4 → 5 → 8 build on each other.

1. **Compose the plastic rest into the skin transform ($d\circ r\circ b^{-1}$).**
   - **Area:** visual quality / correctness.
   - **Change:** `src/game/shape-match-core.js` `matchSkinLocal`. After `m3Mul(c.skinR, _tmp, c.skinM)` (line 497), post-multiply by `c.Sp`, as `matchCluster` already does at line 340 (`m3Mul(c.skinM, c.Sp, _tmp2); m3Copy(_tmp2, c.skinM)`). Keep the guard (498) and the `skinInvT` rebuild (499–500) after it.
   - **Expected effect:** dents absorbed by `applyPlasticity` stay in the mesh instead of springing back during the contact window. In measurement 5, a fully absorbed z·0.6 squash goes from 0.999 back to 0.600. This removes one plausible source of the "polar snap-back" noted at `streamed-deform.ts:1204-1208`.
   - **Cost:** S.
   - **Risk:** low–medium. Caps in `skin` (travel 1.35 m, `extraCap`) were tuned while the spring-back existed, so dents may read deeper; `deformBeta`/`maxE` may need a retune.
   - **Verify:** add a test under "local cell skin (Bugbear pipeline)" in `src/game/shape-match.test.ts`: "plastic absorption does not spring the skin back". Squash the particles to z·0.6, set `c.Sp[8] = 0.6`, call `matchSkinLocal(..., 1)`, and expect `transformSkinPoint(c,0,0,1)[2]` within 0.05 of 0.6 (today 0.999). Then `npm run test:game` (the "frontal pulse" nose-drift assertion guards against blow-ups) and a visual offset hit with `scripts/bench-browser.mjs`.

2. **Give each cluster its own source cage, and drop duplicate clusters.**
   - **Area:** correctness / performance.
   - **Change:** in `src/game/streamed-deform.ts` `constructor` (cluster loop 388–411):
     - record a parallel `clusterCage: Int16Array` holding the source cage index, or −1 for `EXTRA_CLUSTERS`;
     - skip a cluster whose sorted `idx` key is already present, keeping the softer absorption.
     In `clusterBeta` (1697–1704), read `this.cages[this.clusterCage[ci]]` and give `EXTRA_CLUSTERS` a named constant instead of the accidental `glassFront`/`glassRear` (0.48/0.50) or the 0.1 fallback.
   - **Expected effect:** left/right-symmetric stiffness. Today #4 vs #5 is 0.52 vs 0.22 and #10 vs #11 is 0.16 vs 0.28. Going from 22 to 16 clusters cuts `matchCluster`/`matchSkinLocal` calls by 27%. Skin influences stop spending up to 3 of 4 slots on the same transform (#2/#6/#10).
   - **Cost:** S.
   - **Risk:** medium. Crash feel was tuned against the wrong values, so assertions in `crash-physics.test.ts`, `crash-parts.test.ts` and `barrier.test.ts` may move. The "≥ 8 clusters" assertion in `shape-match.test.ts:356` still passes (16).
   - **Verify:** add a mirror test in `src/game/crash-parts.test.ts` using its `spawnOffset(impactX, speed, mode)` helper in `"shape"` mode: ±0.5 m corner hits should give mirrored `bumperFL`/`bumperFR` travel within 5%. This is not measured yet; the asymmetry is inferred from the beta values. Then `npm run test:game`, and check the deform ms in `scripts/bench-browser.mjs` drops.

3. **Match clusters in the body frame (explicit rigid core group).**
   - **Area:** correctness / stability.
   - **Change, `src/game/shape-match-core.js`:** give `matchCluster` an optional `frame: Mat3` (F).
     - Accumulate `_Apq` from $F^T(\mathbf{x}-\mathbf{c})$.
     - Set `c.M = F·R·lerp(I,S,β)`, so the 0.85 rad clamp and `stabilizeR` act only on local bending.
     - Mirror the change in `src/game/shape-match.ts` / `shape-match-core.d.ts`.
   - **Change, `src/game/streamed-deform.ts` `stepShapeMatch` (1706):** once per call, compute F as the polar rotation of a mass-weighted rigid "core" group of the masses cell, roof, doorL, doorR, tank, railL, railR. Their rest comes from `captureShapeRest`; this set is well conditioned (cluster #12, a near-identical set, has eigenvalues 8.4/25.5/43). This is the paper's transform $s$ (§5.3–5.4).
   - **Knock-on:** the rest rotation in `applyPlasticity` (`shape-match-core.js:370-383`) then uses local `c.R`, so body yaw is no longer baked into `q0`.
   - **Expected effect:** heading changes after the first crash stop showing up as crush. Measurement 4 has 0.17–0.38 m (gradual yaw) and 0.2–0.96 m (instant) against a 0.08 m control.
   - **Cost:** M.
   - **Risk:** medium. In `deepCrush`/`foldCabin` the core itself deforms; weight by mass (cell is 260 of 444 core kg) or exclude doors when `deepCrush`.
   - **Verify:** add to `src/game/shape-match.test.ts` "StreamedDeformation shape mode": after `beginCrush`, settle 60 frames, then apply 1.57 rad yaw over 40 live frames (`notifyContact`). Non-hub `m.local` should change by < 0.1 m (today 0.19 m). Run `npm run test:game`; the extra polar per `stepShapeMatch` costs about 0.3 µs in `npm run bench`.

4. **Oriented control particles: generalized moment matrix (Eq. 7–8) plus orientation state.**
   - **Area:** stability / realism.
   - **Change, data:**
     - `src/game/shape-match.ts` `ShapeParticle` (9–17): add `R: Mat3` (rotation since rest, in the frame from #3) and `r2: number` (radius², default 0 so kernel tests keep current behaviour).
     - Populate both in `src/game/streamed-deform.ts:375` from `MASS_SPECS.radius`.
   - **Change, kernel (`src/game/shape-match-core.js`):**
     - add `ORIENT_K` (start 1.0, tune down to about 0.3 if crumple stiffens);
     - `rebuildAqqWeighted` (306–308): replace `+= 1e-3` with `+= ORIENT_K·Σ m·r2/5` on the diagonal;
     - `matchCluster` (after 332): `_Apq += ORIENT_K·(m·r2/5)·R_i` per member;
     - `matchSkinLocal` (after 487): same, using the local-frame orientation.
   - **Change, orientation update:** in `stepShapeMatch`, after each iteration's cluster loop (1737–1751), set `R_i ← orthonormalize(Σ_{c∋i} m_c · c.R)` (the explicit-group rule of §5.3). Reset `R_i = I` in `captureShapeRest`/`resetCluster`. ω integration (Eq. 11/14) is optional and not needed for stabilization.
   - **Alternative:** the slides' "6 virtual particles" (mass m/6 at ±r√(3/5) on the particle axes) is algebraically identical but costs 6×; use the closed form.
   - **Expected effect:** the 10 planar clusters (bumpers, bonnet halves, wing/chassisFront/wingRL/RR copies) recover rotation and stretch instead of translating. Measurement 3: 0° error with exact orientation and ≤2.4° with 0.05 rad lag, versus 17.2° today. Front and rear skin regions gain rotation, so corners can fold. The `+1e-3` hack goes away.
   - **Cost:** M.
   - **Risk:** medium.
     - Orientation coupling is comparable to $A_{qq}$ (0.11–13 vs 2–55), so too high `ORIENT_K` makes clusters follow lagging orientations; measurement 3's static-identity case (4–14°) is the worst case.
     - The "Z squash ⇒ S_zz < 0.7" kernel test is unaffected only while `r2 = 0`.
     - Do #3 first, otherwise `R_i` absorbs world yaw and the 0.85 rad clamp still bites.
   - **Verify:** add a kernel test to `src/game/shape-match.test.ts` "shape matching goals": a 3-particle planar cluster with `r2 > 0` and `R_i` set to the applied rotation recovers a 0.3 rad rotation about each axis within 1° (today 17.2°, `m3Polar` falls back to I). Also re-run the measurement-4 test from #3, `npm run test:game`, and `npm run bench` (`matchCluster` ns/op budget: +15%).

5. **One shared plastic rest per particle instead of per-cluster `q0`/`Sp` (no ghost forces).**
   - **Area:** stability / realism.
   - **Change, `src/game/streamed-deform.ts`:**
     - add `plasticRest: Float64Array(3·n)` in the body frame (initialized from `m.rest`);
     - in `stepShapeMatch` (plasticity block at 1813–1815), when contacting and the particle's averaged goal residual exceeds the yield, set `plasticRest_i ← lerp(plasticRest_i, Fᵀ(x_i − c_core) + c̄_core, creep)`. This is $r_i\leftarrow s^{-1}\circ d_i\circ r_i$ with $s = F$ from #3.
   - **Change, kernel:** add `setClusterRest(c, restXYZ)` to `src/game/shape-match-core.js`. It rewrites `q0`/`q` and calls `rebuildAqqWeighted` with `Sp = I`; call it for every cluster after absorption.
   - **Change, `applyPlasticity`:** retire its per-cluster `Sp`/`q0` absorption (`shape-match-core.js:345-391`), but port the yield and volume rules (347–369).
   - **Change, skin:** `matchSkinLocal` fits bind (`m.rest`) → current local directly, which gives $d\circ r\circ b^{-1}$ by construction and makes #1 moot.
   - **Expected effect:** all clusters agree on rest, so post-crash goal residuals go to zero. That should remove the "cluster breathing" / snap-back flicker (`update`, 1204–1208). This is the paper's ghost-force diagnosis, not measured here.
   - **Cost:** L.
   - **Risk:** high. It replaces tuned yield/creep/volume logic, and crash-feel tests will need a retune.
   - **Verify:**
     - throwaway: log $\sum_i|\mathbf{g}_i-\mathbf{x}_i|$ once `quietTime() > 0.35` in the `crash-physics.test.ts` frontal scenario, before and after (it should drop to about 0);
     - `npm run test:game`;
     - `scripts/bench-browser.mjs` visual check of the slomo→1× handoff.

6. **Skin normals from the cluster transforms instead of `computeVertexNormals`.**
   - **Area:** performance.
   - **Change, `src/game/streamed-deform.ts`:**
     - `constructor`: copy rest normals into a `Float32Array`.
     - `skin` (2163): blend `skinInvT·n_rest` over the same ≤4 clusters (`skinInvT` is already built at `shape-match-core.js:499-500`, and the helper `transformNormal` at 446 exists), normalize, and write the `normal` attribute.
     - Add the analytic tilt of the accordion wrinkle ($\partial p_z/\partial r_z = 18\,\mathrm{amp}\cos(\ldots)$), or fall back to `computeVertexNormals` only while `wrinkle > 0.02`.
     - Remove `geometry.computeVertexNormals()` at 2261. Do the same in `skinPanel` (1381, normals at 1402).
   - **Expected effect:** the triangle/normalize pass disappears. In the node profile it costs at least as much as the skin loop itself (0.07–0.25 ms per car). The 24-car share of the 15 ms deform budget has not been measured in the browser.
   - **Cost:** M.
   - **Risk:** medium. The non-affine post-steps in `skin` (extra cap, travel cap, roof and hub-well clamps) make blended normals slightly wrong there, and the wrinkle shading needs the analytic term.
   - **Verify:** deform ms in `scripts/bench-browser.mjs` for a 24-car fleet crash before/after, plus side-by-side screenshots; `npm run test:game`.

7. **GPU (vertex-shader) LBS of the body.**
   - **Area:** performance. This is the paper's stated bottleneck and its future work.
   - **Change:**
     - Upload per car the cluster `skinM`, `skinCm0` and `skinCm` (16–22 × 15 floats) as uniforms.
     - Bake `skinWeights` from `buildSkinWeights` (416–452) into 4 index + 4 weight vertex attributes.
     - Do LBS in the body material via `onBeforeCompile`, including the depth/shadow material.
     - Port or simplify the per-vertex post-steps of `skin` (2206–2255).
     - Keep the CPU path only for the trilinear-cage fallback (`wsum < 1e-8` branch) and for lattice mode.
   - **Expected effect:** removes the CPU skin, the normals pass and the per-frame position/normal buffer uploads. The fleet-crash deform cost (about 15 ms) should mostly vanish; the split is not measured.
   - **Cost:** L.
   - **Risk:** high. Panels (`skinPanel`), glass, shadow depth, and anything that reads deformed CPU positions all need parity.
   - **Verify:** render-submit and deform ms in `scripts/bench-browser.mjs`, plus CPU-vs-GPU screenshot parity.

8. **Implicit groups per particle from `BEAM_SPECS`, with torsion.**
   - **Area:** realism / tooling.
   - **Change:**
     - Replace the cage-derived clusters (`constructor` 388–411) with one cluster per non-hub mass: the mass plus its `BEAM_SPECS` neighbours (`src/game/rig-spec.ts:142-189`).
     - Add a per-mass `stiffness` to `MASS_SPECS` (`rig-spec.ts:118-139`).
     - Update only the center particle's orientation (§5.1).
     - Add the edge torsion slerp (Eq. 22–23) in `stepShapeMatch`.
     - Rebuild a group without an edge when `beam.alive` goes false.
     - Requires #4, because 1-rings such as bumperFL's {bumperFR, wingFL} are 3-particle, planar sets.
   - **Expected effect:** one artist-editable topology shared by both modes, per-mass stiffness as in paper Fig. 3(c), and natural tearing when an edge dies.
   - **Cost:** L.
   - **Risk:** high; a full retune.
   - **Verify:** `npm run test:game` (crash-physics, crash-parts, barrier, fleet, derby) and the browser bench.

9. **Ellipsoidal control particles for mass–mass contact.**
   - **Area:** realism (minor).
   - **Change:**
     - Fit `radii: [a,b,c]` per `MASS_SPECS` entry offline with §6.2: vertices of `makeChassisGeometry` within `radius`, covariance → polar decomposition, OBB extents, clamp to `[r/2, r]`.
     - In `collideWith` (931) / `sphereHit` (2267), replace `a.radius + b.radius` with support radii $\sqrt{\mathbf{n}^T\mathbf{A}^{-1}\mathbf{n}}$ in the current orientation (body frame from #3, or `R_i` from #4).
     - Skip Appendix A.2: it is approximate and costlier.
   - **Expected effect:** fewer false contacts in thin directions. This would replace the `_n.y *= 0.18` hack with geometry. Radii never exceed `r`, so gaps between the two bumper spheres do not close.
   - **Cost:** M.
   - **Risk:** low; primary contact remains SAT in `pair-contact.ts`.
   - **Verify:** `crash-physics.test.ts` and `fleet.test.ts`; throwaway count of `sphereHit` contacts per frame in a fleet crash.

10. **Simulated hinges: explicit rigid part groups sharing non-oriented particles.**
    - **Area:** realism (low priority).
    - **Change:**
      - Give doors, bonnet and trunk (`src/game/car.ts` `registerParts` from 320; scripted hinges at 809–849) an explicit rigid group of 3–4 particles.
      - Share 2 hinge particles with the body group and set $\mathbf{A}_i = 0$ for them, as the paper does for axles, so the part swings about the hinge line.
      - `detachPart` (952) removes the shared particles.
    - **Expected effect:** physically driven door swing and bonnet pop instead of `hingeT` keyframes.
    - **Cost:** L.
    - **Risk:** high. It loses the deterministic, tuned behaviour and adds 4–8 groups per car.
    - **Verify:** `crash-parts.test.ts` detach thresholds, plus a visual check.

## Not applicable / caveats

- **Full generalized PBD velocity update (Eq. 12/14) is a deliberate mismatch.** `stepShapeMatch` corrects positions without touching velocities, so shape matching never injects spring-back energy. That fits plastic sheet metal. Adopting $\mathbf{v}\leftarrow(\mathbf{x}_p-\mathbf{x})/\Delta t$ would make the body elastic and bouncy. Add orientation as state (#4) but keep the position-only shape step. Angular velocity per particle is not needed for stabilization.
- **Precession, spin friction (Eq. 16–21) and particle–particle spin friction** only matter for free-flying oriented particles. Ours are bound to a car whose rigid motion comes from `followGroup` and the SAT pair solver.
- **Appendix A.2 (ellipsoid–ellipsoid) is approximate.** The step to Eq. (38) multiplies inside quadratic forms. It is exact for spheres; measured between 6.6 % short and 0.1 % long on random pairs. A.1 (ellipsoid–plane) is exact but we have no plane contacts on masses except the ground clamps.
- **Uniform radius plus spatial hashing (§6.2)** solves broad phase for thousands of particles. We have 20 per car, brute-forced 20×20 in `collideWith`, gated by `quietTime`.
- **Rivers–James summation (Eq. 5)** pays off for large overlapping groups and lattice sums. Our clusters have 3–6 members.
- **Authoring tools (spray particles/edges, weight painting, auto-ellipsoid editor)** do not apply to a procedural car. `buildSkinWeights` is procedural, and the part-bleeding problem the paper solves with selection-restricted links is already avoided because doors, hood, trunk and bumpers are separate meshes skinned via `skinPanel`.
- **Rigid LBS over per-particle transforms (§7) and DQS** assume rigid per-particle transforms. Our skin blends **affine** cluster transforms that carry squash (`R·lerp(I,S,β)·Sp`), which a 20-particle rig needs. Keep affine LBS; DQS does not apply unless the rig moves to many more particles with rigid frames.
- **The paper's plastic trigger** (velocity threshold, rigid group disabled for 5 frames) assumes a rigid explicit body group. Ours is always soft-ish with contact-gated parameters. The useful part to borrow is the shared-rest absorption (#5), not the trigger.
- **Time-step dependence.** The paper defines stiffness per step and suggests $s=s'\Delta t$ for variable steps. Our `alpha`/`iters` apply per slice while `stepStructure` varies the slice count (1–4) with frame dt, so effective stiffness may vary with frame rate. This is inferred, not measured, and is outside this paper's fixes.
- **Convergence and level-of-detail concerns (§10)** do not apply: one fixed rig per car.
