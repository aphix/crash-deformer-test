# Rajala 2008 — analysis against `crash-deformer-test`

Source: `rajala-2008.md` (paraphrase of the thesis *Dynamic Controllable Mesh Deformation in Interactive Environments*, LiU / Bugbear, 2008) and the talk transcript `attachments/Dynamic_Mesh_Deformation_for_Car_Games-[VNS-0cJlpIs].en.srt`. Every code anchor below was read or grepped at the cited line. Unless stated otherwise, numbers in **Measured** were produced by throwaway Node 24 probes (`--experimental-strip-types`) against the current tree with the game defaults `squash = 0.4`, `buckle = 0.45` (`src/game/engine.ts:142-143`). The probes were deleted afterwards.

## Summary

- **Method:** Müller 2005 meshless shape matching on a **cluster of overlapping cubic cells**. Control particles sit at every cell corner, so 8 per cell, and neighbouring cells share them. The lattice is built automatically when the model loads: 39 cells for the car in the thesis, about 150 per car in the talk.
- **Goal transform:** $T = \beta A + (1-\beta)R$ with $\beta \in [0,1)$ and $g_i = T q_i + x_{cm}$. A particle shared by $n$ cells averages their goals (scale $= 1/n_{cells}$).
- **Additional stiffness:** doubling the cell count roughly halves the stiffness that $\alpha$ provides, so shape matching is run several times per step with $x_i \leftarrow g_i$. A hierarchical cluster (large cells for stiffness, small cells for detail) is proposed but not built.
- **Plasticity:** yield is tested with the **Frobenius** norm (Müller confirmed the spectral norm in the paper is a notation slip) of $T - I$, which includes rotation, instead of $S - I$. On yield the static particles are moved by $T$, the per-cell vertex matrix is updated incrementally ($U \leftarrow T U$) and the static centre of mass jumps to the current one ($x^0_{cm} \leftarrow x_{cm}$). Creep is **not** used because metal yields instantly. Linear-only plasticity cannot bend, and neighbouring cells end up pushing each other apart.
- **Inversion:** if $\det A_{pq} < 0$, the previous valid $T$ is reused. Rivers' "multiply by −1" leaves one or two axes wrong.
- **Volume:** optional $A / \sqrt[3]{\det A}$, which destabilises cases dominated by the linear part.
- **Pipeline:** simulate plastic objects **only while colliding**. Vertices are moved in a separate pass, possibly on another thread, from per-cell matrices and only when those changed. All car meshes map onto **one** deformation model.
- **Normals, tangents, binormals:** $n_{new} = (T^{-1})^T n_{old}$, using the same per-cell matrices.
- **Engine integration:** contact points, normal and momentum from the physics engine move the cell particles. Car parts have their own parameters (engine stiffer than doors, set automatically per part). Many debug visualisations exist. A hybrid with artist-authored high-frequency detail is suggested.

## Useful content

| Item | Paper value / rule | Why it matters for a real-time car body |
|---|---|---|
| Goal blend | $T = \beta A + (1-\beta)R$, $\beta < 1$; at $\beta \to 1$ "nothing holds the shape" | Low β gives rigid-looking metal; β near 1 gives jelly. The repo encodes the same blend as $R\,\mathrm{lerp}(I, S, \beta)$. |
| Shared-particle averaging | goal weight $1/n_{cells}$ | Overlapping clusters agree. Vertices **cannot** be averaged that way in the paper, which causes overlap and crack artefacts. |
| Stiffness loss | stiffness from α ≈ halves when the cell count doubles | Justifies a 2–5 iteration loop. A hierarchy is the cheaper alternative to more iterations. |
| Yield norm | $\lVert T - I \rVert_F$, Frobenius not spectral | Frobenius costs O(9), with no eigen-solve. |
| Plastic update | static particles ← $T$·static; $U \leftarrow T U$; $x^0_{cm} \leftarrow x_{cm}$; no creep | Once a crash yields, the deformation **is** the new rest, so there is no later springback. |
| Instability of linear plasticity | linear-only Sp plus volume-conserving cells overshoot and neighbours fight | A warning for any $S_p$-only design. |
| Flip rule | $\det A_{pq} < 0 \Rightarrow T = T_{prev}$ | Crushed clusters routinely pass through degenerate states. |
| Volume conservation | $A / \sqrt[3]{\det A}$, optional | Undefined for rank-deficient $A$. Use only on full-rank cells. |
| Cell shape | cubic or tetrahedral cells: every cell spans 3D and overlaps fully | Thin overlap bands from mesh-edge sharing "stop holding the model together". |
| Normal transform | $(T^{-1})^T$ for normals, tangents, binormals | Removes the per-frame face-normal recompute. Exact only for the per-cell linear map. |
| Scheduling | plastic objects simulate only in contact; vertex update only on change, can be threaded | Idle wrecks cost nothing. |
| Per-part material | parameters per component inside one cluster; automatic defaults (engine, base) | The engine block must not crumple like a fender. |
| Hybrid detail | shape matching for large-scale shape, artist detail blended on top | Matches the repo's procedural accordion wrinkle. |

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Control particles | `src/game/streamed-deform.ts:156-177` `MASS_SPECS` | variant | 20 hand-placed named particles (8–260 kg), not lattice corners. The four `hub*` particles are excluded from clusters (`:612`). |
| Cubic cell cluster built at load | `src/game/streamed-deform.ts:533-563` constructor; `:606-640` `cageClusterIndices` | variant | One cluster per FFD cage from the particles inside its padded AABB (pad 0.16). Centre cages are split L/R (`:545-547`), and 6 hand-listed cross clusters are added (`:552-563`). **Measured:** 22 clusters of 3–6 particles, 16 distinct sets, 10 rank-deficient. |
| Overlap holds the body together | `src/game/shape-match.test.ts:347` "every mass belongs to at least one overlapping cluster" | same | Only coverage is tested, not rank or overlap width. |
| $x^0_{cm}$, $q_i$, $A_{qq}$ | `src/game/shape-match-core.js:242` `makeCluster`; `:300` `rebuildAqqWeighted` | variant | $A_{qq}^{-1}$ gets **+1e-3** on the diagonal (`:306-308`). For planar clusters this makes $A$ rank-2 at rest. |
| $A = A_{pq}A_{qq}$, polar, $T$ | `src/game/shape-match-core.js:311` `matchCluster` (`:333` A, `:335` polar, `:337-338` $M = R\,\mathrm{lerp}(I,S,\beta)$) | same | $R\,\mathrm{lerp}(I,S,\beta) = (1-\beta)R + \beta RS = (1-\beta)R + \beta A$. This is eq. 2.19 exactly. |
| Polar decomposition | `src/game/shape-match-core.js:102` `m3Polar` | variant | Newton $R \leftarrow \tfrac12(R + R^{-T})$, at most 12 iterations. On a failed inverse or a blow-up it returns **R = S = I** (`:110-113`, `:125-128`). |
| Flip handling | `src/game/shape-match-core.js:131-136` (negate column 3) + `:193` `stabilizeMat` | contradicts | Rivers-style single-axis negation, then blending toward `Rprev`. The paper reuses the previous valid $T$ instead. |
| Rotation clamp | `src/game/shape-match-core.js:137` `m3ClampRotation(R, 0.85)` | missing in paper | Caps each cluster's rotation from its rest at 0.85 rad. Under Rajala's incremental $U$ the rotation accumulates without such a cap. |
| β per material | `src/game/streamed-deform.ts:1976` `clusterBeta`; `src/game/shape-match-core.js:508` `deformBeta` | same | β is low while in contact (0.03–0.27 via cage `absorption`) and `deformBeta(squash)·(1-absorb/2)` otherwise. |
| $1/n_{cells}$ goal averaging | `src/game/streamed-deform.ts:2019-2039` (`cw = 1`, `goal/goalW`) | same | Identical averaging. Duplicate clusters (see Measured) silently weight some particles 2–3×. |
| Iterate for stiffness | `src/game/streamed-deform.ts:2008` `iters`; `src/game/shape-match-core.js:502` `stiffnessIters`, `:505` `goalAlpha` | same + extras | 2 iterations in contact, 2–5 otherwise. α-blend per iteration, 0.14 m step cap (`:2057`), half-space clamp along the impact axis (`:2047-2051`). The extras improve stability. |
| Hierarchical cluster | `src/game/streamed-deform.ts:552-563` extra cross clusters | partial | Larger spanning clusters, but no levels or weighting. |
| Plastic yield | `src/game/shape-match-core.js:345-349` `applyPlasticity` | variant | $\lVert S - I\rVert_F$ (Müller), not $\lVert T - I\rVert_F$. The threshold is `0.035 + (1-squash)·0.08 + (1-buckle)·0.04`. |
| Creep / max plasticity | `src/game/shape-match-core.js:350-359` | contradicts (deliberately) | Rate-limited creep and a Frobenius cap `maxE`. The paper drops creep for metal. |
| Volume conservation | `src/game/shape-match-core.js:360-366` | variant | Only 8 % of the full $\det^{-1/3}$ correction is applied to $S_p$, not to $A$. |
| Rotation in plasticity | `src/game/shape-match-core.js:370-383` (rotate `q0` by `lerp(I,R,0.45·creep)` when contacting and angle > 0.08) | contradicts | **Measured:** a steady-state no-op on goals (see below). The paper's effect comes from replacing the *rest* by the current shape. |
| $x^0_{cm} \leftarrow x_{cm}$ | `src/game/shape-match-core.js:311-327` (goals use the current cm); `:449-476` `matchSkinLocal` recomputes `skinCm0` from the original rest | variant (not needed) | The cluster cm is recomputed every match. Skinning always maps original rest → current. |
| Incremental $U \leftarrow T U$ | `src/game/streamed-deform.ts:2284` `bakeLocalSkin` → `src/game/shape-match-core.js:449` `matchSkinLocal` | variant | `skinM` is refit from scratch each skinned frame: rest (with $S_p$ applied, `:484`) → current particle positions. No drift. However `skinM = skinR·lerp(I,S,β)` (`:496-497`) **omits $S_p$**, so recorded plastic squash is invisible (Measured). |
| Plastic only while colliding | `src/game/streamed-deform.ts:2135-2138` `stepMassSlice` (`live = bidirectional ∥ quietTime() < 0.35`); `:2092-2094` plasticity only when `contacting` | same | Damage persists because particles **stop being matched** after the window, not because the rest was updated. |
| Vertex pass separate, only on change | `src/game/streamed-deform.ts:1350-1370` `update` (skin only while `crushing`); `:337` `skinnedThisFrame` | same | Main thread only (no worker). |
| One deformation model for all meshes | `src/game/car.ts:141-146` body → `StreamedDeformation`; `src/game/car.ts:715-725` `skinPanel` for hood/trunk/glass; `src/game/streamed-deform.ts:2290` `solveCagesFromShape` | same (variant interpolation) | Body: 4-cluster linear blend (`:2466-2474`, weights `exp(-2.35 d)`, top 4 within 1.45 m from `buildSkinWeights` `:568-603`). Panels: trilinear FFD cages whose corners come from cluster transforms. |
| Vertex-level averaging | `src/game/streamed-deform.ts:568` `buildSkinWeights` | better than paper | The paper has one cell per vertex and gets overlap/crack artefacts. The repo blends up to 4 clusters, which is smooth but removes the "cracks" the talk liked. |
| Normal transform $(T^{-1})^T$ | `src/game/shape-match-core.js:342-343`, `:499-500` compute `skinInvT`; `:446` `transformNormal` | missing in render path | `skin()` calls `geometry.computeVertexNormals()` (`src/game/streamed-deform.ts:2548`), and so does `skinPanel` (`:1578`). `skinInvT` is only read in `src/game/shape-match.test.ts:221`. |
| Hybrid artist detail | `src/game/streamed-deform.ts:2500-2510` accordion wrinkle in `skin` | variant | Procedural sine folds (about 12 cm wavelength) instead of artist morphs. |
| Contact → particles | `src/game/streamed-deform.ts:1293` `feedOverlap`, `:841` `applyImpulse`, `:1260` `kickCore`, `:1085` `collideWith`; `src/game/pair-contact.ts:90-91`, `:161-162` | same idea, richer | The paper receives contact points, normal and momentum. The repo feeds overlap-to-crush and impulses, and also runs mass–mass contact between cars. |
| Deformed collision shape (talk) | `src/game/streamed-deform.ts:1404` `liveHulls`, `:1475` `liveCrushHulls` | same idea | 2D boxes derived from particle positions instead of spheres transformed by cell matrices. |
| Visual vs physical damage (talk) | `src/game/streamed-deform.ts:36` `ENGINE_KILL_TRAVEL`, `:969` `drivetrainAlive = false`; `src/game/streamed-deform.ts:1123` `followGroup` | contradicts (deliberately) | The repo couples deformation back into driving (engine travel kills the drivetrain) and into the rigid pose (car pose is derived from particles during a crash). |
| Part detachment | `src/game/car.ts:320` `registerParts`, `:790-814` `syncAttachedParts` (hinge target from sensor compression), `:913-933` `evaluateBreakage`, `:952` `detachPart`; hubs `src/game/streamed-deform.ts:1898-1901` | variant | Detachment is driven by crush **sensors** and hinge progress, not by cluster strain. |
| Per-part parameters | `src/game/physics-core.js:32` `regionSoftness`; `src/game/streamed-deform.ts:83-102` `CAGES` (`absorption`, `maxCrush`, `maxAngle`) | partial | Softness gates contact crush and cage absorption sets β, but `applyPlasticity` thresholds are global (`squash`, `buckle` only). |
| Debug visualisation / editor | `src/game/streamed-deform.ts:1581` `createHelper`, `:2553` `updateHelper`; `src/game/car.ts:202` `buildHullHelper` | same | Rig, cluster and hull overlays play the role of DeformEd's views. |
| Alternative methods kept switchable | `src/game/streamed-deform.ts:28` `DeformMode = "shape" \| "lattice"`, `:1923` `stepBeams` | same | The paper keeps the framework open to other methods. The repo keeps a mass-spring lattice mode. |
| FFD (§2.1.2) | `src/game/streamed-deform.ts:247` `trilinear` | variant | Degree-1 (trilinear) Bernstein cages, not tricubic B-splines. |

### Measured evidence (throwaway probes, current tree)

1. **Cluster census.** `new StreamedDeformation(makeChassisGeometry())` → 22 clusters with sizes `4,3,3,3,4,4,3,3,3,3,3,3,6,4,4,4,4,4,4,4,4,4`. Duplicates: `{engineL, railL, wingFL}` ×3, `{engineR, railR, wingFR}` ×3, `{railL, doorL, cell, roof}` ×2, `{railR, doorR, cell, roof}` ×2. That is 16 distinct sets, so 6 cluster instances are redundant. The body mesh has 1212 vertices and 1712 triangles and is indexed.
2. **Rank-deficient clusters.** Ten clusters, the nine 3-particle ones plus the coplanar `bumperFL+bumperFR+engineL+engineR` quad, give $\det A \approx 10^{-14}$ at any pose. The `m3Invert` threshold of $10^{-12}$ then fails inside `m3Polar`, which returns $R = S = I$. When every particle is rotated rigidly by 0.36 rad, `matchCluster` reports rotation angle **0.000** for those 10 clusters and 0.360 for the other 12. `matchSkinLocal` behaves the same under a 0.3 rad rotation: 10/22 report 0.000. These clusters can only translate. Sibling lane `PaperStableRotation2016` confirmed this independently.
3. **"Rotation in plasticity" is goal-invariant.** One cluster, deformed particles. Rotating its rest offsets `q0` by 0.3 rad and rebuilding $A_{qq}$ changes its goals by **4e-16 m** when `Sp = I` and `Rprev` is reset. With a warm `Rprev`, goals jump **0.13 m** for one frame through `stabilizeMat` and decay to 5e-12 m within 30 frames. With `Sp ≠ I` there is a persistent 2.75 cm difference, caused only by $S_p$ and $R_q$ not commuting. Shape matching is rotation-invariant in the rest frame: $A' = A R_q^T$, $R' = R R_q^T$, $S' = R_q S R_q^T$, so $g' = g$.
4. **Earlier damage springs back on later contact.** Shape mode, 24 frames of frontal overlap (0.1 m/frame, 14 m/s), then 90 quiet frames: `bumperFL` dz = −1.055 m, then −1.053 m after settling. Then either
   - 0.5 s of `notifyContact()` with **no** new crush, giving `bumperFL` −0.459 m and `wingFL` −1.022 → −0.443 m (**56 % springback**), or
   - a separate run with a real rear crush (20 frames of overlap at the rear bumpers), giving `bumperFL` −0.412 m, `wingFL` −0.361 m and `railL` −0.593 → −0.322 m (**61 % springback**).

   In the engine, `notifyContact()` fires for any contact above the graze speed (`src/game/pair-contact.ts:79-80`, `src/game/engine.ts:1352`, `:1898`, `:1983`).
5. **Skin ignores recorded plasticity.** Particles held at a 30 % z-squash with `Sp_zz = 0.7` render the rest point (0,0,1) at z = **1.000** for β = 0.03, 0.2 and 0.4: no squash at all. With `Sp = I` the render is 1 − 0.3β (0.991 / 0.940 / 0.880). `skinM·Sp` would give 0.700.
6. **Deform cost split** (one car, 40 crush frames, Node): `update()` ≈ 0.63–0.67 ms/frame. Of that, `skin` ≈ 0.45 ms (including `computeVertexNormals` ≈ 0.12–0.13 ms, about 19 % of `update`), `solveCages` ≈ 0.14 ms, `bakeLocalSkin` ≈ 0.04 ms, `pullSensorsFromMasses` ≈ 0.03 ms. `stepStructure` ≈ 0.47 ms. A synthetic 4-cluster $(T^{-1})^T$ normal blend over the same 1212 vertices took 0.037 ms against 0.082 ms for `computeVertexNormals`.
7. **Not isolated.** A rigidly yawed, undamaged car run for 10 live `stepStructure`+`followGroup` frames distorts by 2.1 / 20.9 / 63.3 cm at yaw 0 / 0.1 / 0.3 rad. Removing the 10 rank-deficient clusters does **not** remove this (8.2 / 29.9 / 48.7 cm), so it comes from other code in `stepStructure` or from the probe setup. The cause is not attributed. It is listed only so that item 2 is not over-claimed.
8. **Prototype of candidate 1** (rest rebase applied from the probe to the private clusters after settling; no repo edit). The run was front hit, settle, rear hit, settle. `bumperFL` kept **83 %** of its settled crush (−1.050 → −0.873 m) and `wingFL` 94 %. In the same run without the rebase, `bumperFL` kept **49 %** (−1.050 → −0.520 m). Rear crush depth was unchanged (0.052 vs 0.058 m). The remaining 17 % was not attributed.

### Focus audit: what this repo does differently, and whether that is better or worse

| Focus | Rajala | This repo | Verdict |
|---|---|---|---|
| Control-particle placement and count | Automatic cubic lattice, 8 corners per cell, 39 cells (thesis) or about 150 (talk), so hundreds of particles. Per-particle artist parameters. | 20 anatomical particles (`MASS_SPECS`), with masses and roles tied to gameplay (engine-block travel, cabin cell, hubs). | **Better** for gameplay semantics and cost (24 cars). **Worse** for resolution: one particle per door or roof means panels cannot bend through shape matching. Visible creasing comes from cages and the wrinkle layer. |
| Cluster construction | Cubic or tetrahedral cells always span 3D and overlap through whole shared corner sets. | AABB membership per cage plus hand-listed extras. 10/22 clusters are rank-deficient and 6/22 are duplicates (Measured 1–2). | **Worse.** Rank-deficient clusters cannot rotate, in the simulation or in the skin. Duplicates waste work and skew averaging and skin slots. |
| Plasticity with rotation | Yield on $\lVert T - I\rVert_F$. On yield the rest becomes the current shape ($U \leftarrow TU$, $x^0_{cm} \leftarrow x_{cm}$), instantly with no creep. | Müller linear $S_p$ with creep, max and partial volume preservation. Rotates per-cluster `q0` copies, which does nothing in steady state (Measured 3). Damage persists only because matching stops after the contact window. | **Worse.** Any later contact un-crumples old damage by 56–61 % (Measured 4). |
| Updating rest centres of mass | Required because $U$ is incremental. | Not needed: goals use the current cm and skin refits from the original rest every frame. | **Equivalent**, and drift-free. |
| Final vertex transform | Incremental $U \leftarrow T U$ per cell, one cell per vertex. | Per-frame refit from original rest to current particles, blended over 4 clusters. $S_p$ is dropped from `skinM`. | **Better** on drift and smoothness. **Worse** in that plastic $S_p$ never reaches the vertices (Measured 5) and per-cluster rotation is capped at 0.85 rad. |
| Stiffness by iteration | Repeat shape matching, $x \leftarrow g$. Hierarchy suggested. | 2–5 α-blended iterations, step cap, half-space clamp, COM restore. | **Same or better** (more stable). No hierarchy. |
| Normal transformation | $(T^{-1})^T$ for normals, tangents, binormals. | `computeVertexNormals` per skinned frame. `skinInvT` is computed and never used in rendering. | **Correct but slower.** It handles the nonlinear post-steps (wrinkle, caps, hub pin) that $(T^{-1})^T$ cannot, but costs about 19 % of `update`. The `skinInvT` computation is dead work. |
| Part detachment | Separate meshes on one deformation model; detach on connection stress (talk: cell deformation can drop tyres). | Staged hinges from crush-sensor compression; detach on hinge thresholds; hubs pop on travel > 0.5·radius. | **Variant, adequate.** Hinge staging looks better than a binary detach. It ignores cluster strain. |
| Coupling to rigid-body physics | One-way: physics → contact data → particles. Visual and physical damage kept separate so the car stays drivable. Collision spheres deformed with the cells. | Two-way: during a crash the rigid pose comes from particles (`followGroup`), impulses go into particles, hulls come from particles, and engine travel kills the drivetrain. | **Better realism, higher risk.** Many clamps exist to keep it stable. It contradicts the talk's "keep it drivable", but on purpose. |


## Candidates to implement

1. **Plastic rest capture when the contact window closes (Rajala: rest ← current shape, $x^0_{cm} \leftarrow x_{cm}$).**
   - **Area:** correctness, realism.
   - **Change:**
     - Add `rebaseRest(c, particles)` to `src/game/shape-match-core.js`, next to `applyPlasticity` (`:345`). Call it right after `matchCluster`, so `c.R` and `c.cm*` are current. For each member, set $v = R^T(x_i - cm)$, `q = v` and `q0 = Sp⁻¹·v` (`m3Invert(c.Sp)`), then `rebuildAqqWeighted`.
     - Keeping `Sp` means the skin fit (`matchSkinLocal` `:484`) is unchanged, so nothing pops visually.
     - Declare it in `src/game/shape-match-core.d.ts` and re-export it from `src/game/shape-match.ts` (export list `:52-86`).
     - In `StreamedDeformation.stepMassSlice` (`src/game/streamed-deform.ts:2135-2139`), track the previous `live` value. On the true→false edge in shape mode, run `syncShapeFromMasses()`, then `matchCluster(c, shapeParticles, clusterBeta(ci,false))` and `rebaseRest(c, shapeParticles)` for every cluster.
     - Delete the `q0`-rotation branch in `applyPlasticity` (`shape-match-core.js:370-383`). It is a steady-state no-op (Measured 3).
   - **Expected effect:** a later contact no longer un-crumples earlier damage. Today 51–61 % of a 1.05 m front crush springs back (Measured 4, 8). The prototype keeps 83 % instead of 49 % (Measured 8).
   - **Cost:** S.
   - **Risk:** low–medium. Whatever bounce remains at window close (0.35 s after the last contact) is frozen into the rest. Pre-existing damping keeps it small.
   - **Verify:** add a regression test to `src/game/crash-physics.test.ts` using its `spawn` / `stepWall` / `alongZ` helpers (`:26-90`): front hit for 24 frames, 90 quiet frames, a rear hit, 90 quiet frames. Assert `alongZ(d,"bumperFL")` keeps ≥ 80 % of its settled value (today 39–49 %; the probe prototype reaches 83 %, Measured 8). Then run `npm run test:game`.

2. **Make every cluster full-rank, like Rajala's 8-corner cells.**
   - **Area:** correctness, stability.
   - **Change (preferred, kernel-level):**
     - In `makeCluster` (`src/game/shape-match-core.js:242`), detect planar rest sets: the nine 3-particle clusters and the coplanar quad (Measured 2). Store a member triple `(a,b,c)` and the rest normal $n_0 = \widehat{(x_b-x_a)\times(x_c-x_a)}$.
     - In `matchCluster` (`:328-333`) and `matchSkinLocal` (`:477-492`), add a virtual axis term $w_n\, n\, n_0^T$ to $A_{pq}$ and $w_n\, n_0 n_0^T$ to $A_{qq}$ (`rebuildAqqWeighted` `:300`). Here $n$ is the current triple normal and $w_n = \sum m \cdot r_{rms}^2$. If the triple degenerates to a line, keep the last $n$.
   - **Alternative:** use the warm-started rotation extraction of Müller 2016 in place of the Newton loop in `m3Polar` (`:102-145`). Rank 2 is enough for a unique proper rotation. See the sibling analysis `stablePolarDecomp.analysis.md`.
   - **Expected effect:** 10/22 clusters (front engine/rail/wing triads, the bumper quad, the rear axle/tank/bumper triads) start following rotation in both simulation and skin. Today they only translate.
   - **Cost:** S–M.
   - **Risk:** medium. The front and rear structure will start rotating where it was previously only translated, so crush-shape tests may need retuning.
   - **Verify:** in `src/game/shape-match.test.ts` "shape matching goals" (`:104`), add a case where a 3-particle cluster is rotated rigidly by 0.3 rad and expect `m3RotationAngle(c.R)` ≈ 0.3 (today 0.000). Run `npm run test:game` and `npm run bench`.

3. **Deduplicate identical clusters and keep their multiplicity as a weight.**
   - **Area:** performance, visual quality.
   - **Change:**
     - In the constructor (`src/game/streamed-deform.ts:533-563`), key clusters by their sorted `idx`. When a key repeats, increment `weight` on the existing cluster instead of pushing a new one.
     - Add `weight: 1` to the object built in `makeCluster` (`shape-match-core.js:244-275`) and to `ShapeCluster` in `shape-match-core.d.ts` / `shape-match.ts`.
     - Use it in `stepShapeMatch` (`streamed-deform.ts:2019`, `cw = c.weight`) and in `solveCagesFromShape` (`:2306`, `w *= c.weight`), so simulation and cage results stay identical.
     - In `buildSkinWeights` (`:595`), multiply the score by `weight`. The 4 slots then go to distinct clusters.
   - **Expected effect:** 22 → 16 `matchCluster` calls per iteration (×2–5) and per `bakeLocalSkin`, about 27 % less per-cluster work. Skin vertices near the front fenders get 4 distinct influences instead of up to 3 copies of one.
   - **Cost:** S.
   - **Risk:** low. Skin weights change slightly.
   - **Verify:** `src/game/shape-match.test.ts:347` coverage test, `src/game/crash-physics.test.ts` unchanged, `node scripts/bench-browser.mjs` deform/physics ms in a 24-car crash.

4. **Rajala's inversion rule: when det ≤ 0, keep the previous rotation.**
   - **Area:** stability.
   - **Change:** in `matchCluster` (`src/game/shape-match-core.js:335`) and `matchSkinLocal` (`:494`), use `if (m3Det(c.A) <= 0) { m3Copy(c.Rprev, c.R); m3Id(c.S); } else m3Polar(...)`, with `skinRprev`/`skinR` in the skin path. This replaces the column-3 negation (`:131-136`) for full-rank clusters.
   - **Prerequisite:** candidate 2. For today's rank-deficient clusters the sign of det is ±1e-14 noise (Measured 2), so the rule would fire at random.
   - **Expected effect:** a cluster crushed through itself holds its last valid orientation instead of an arbitrary single-axis mirror fix.
   - **Cost:** S.
   - **Risk:** low.
   - **Verify:** new case in `src/game/shape-match.test.ts` "polar decomposition" (`:44`): invert particles through the cluster plane after one valid match and expect `c.R` ≈ previous `c.R`. The existing `:68` det(R)=+1 case must still pass.

5. **Apply plastic $S_p$ in the skin transform (Rajala $U \leftarrow T\,U$).**
   - **Area:** realism, visual quality.
   - **Change:** in `matchSkinLocal` (`src/game/shape-match-core.js:496-500`), compute `skinM = skinR·lerp(I,S,β)·Sp`, then compute `skinInvT` from that product. (`matchCluster` already does `M·Sp` at `:340`, but `bakeLocalSkin` overwrites `skinM` before `skin()` runs.)
   - **Expected effect:** recorded plastic squash becomes visible on the body. Today a cluster with `Sp_zz = 0.7` renders unsquashed, at 1.000 instead of 0.700 (Measured 5).
   - **Cost:** S.
   - **Risk:** medium. Looks may become more "clay"; the `clusterBeta` comment (`src/game/streamed-deform.ts:1979-1980`) shows linear cell squash was deliberately damped. `Sp` is capped by `maxE` and the diagonal ≤ 1.06 (`shape-match-core.js:354-369`).
   - **Verify:** extend `src/game/shape-match.test.ts` "local cell skin" (`:227`) with an Sp_zz = 0.7 case expecting z ≈ 0.7. Visually compare a 14 m/s barrier hit in the browser.

6. **Per-part plastic parameters (Rajala §3.4: components with their own parameters, automatic per-part defaults).**
   - **Area:** realism.
   - **Change:**
     - In the constructor (after `src/game/streamed-deform.ts:563`), set `c.yieldScale` and `c.maxScale` from the mean `regionSoftness` of each cluster's members (`src/game/physics-core.js:32-42`). For example, yield × (1.5 − soft) and maxE × (0.4 + 0.6·soft).
     - In `applyPlasticity` (`shape-match-core.js:347` and `:354`), multiply `yieldC` and `maxE` by them.
   - **Expected effect:** engine and cabin clusters (soft 0.08–0.16) resist permanent set, while bumper and wing clusters (0.78–1.0) yield first. Today the thresholds depend only on the global `squash` / `buckle`.
   - **Cost:** S.
   - **Risk:** medium (retuning).
   - **Verify:** the engine-travel and cabin cases in `src/game/crash-physics.test.ts` (`ENGINE_KILL_TRAVEL`), plus `src/game/crash-parts.test.ts`.

7. **Normals from $(T^{-1})^T$ when no nonlinear post-step is active, otherwise delete the dead `skinInvT`.**
   - **Area:** performance.
   - **Change:**
     - Capture rest normals in the constructor next to `restPos` (`src/game/streamed-deform.ts:395`).
     - In `skin()` (`:2458-2548`), compute $n = \mathrm{normalize}(\sum w\,\mathrm{skinInvT}\,n_{rest})$ per vertex. Call `computeVertexNormals()` (`:2548`) only when the wrinkle is active (`wrinkle > 0.02`, `:2500`) or a cap/pin branch (`:2511-2541`) fired this frame.
     - If not adopted, delete the `skinInvT` computation (`shape-match-core.js:342-343`, `:499-500`), `transformNormal` (`:446`) and its test (`src/game/shape-match.test.ts:206-224`). They have no render consumer.
   - **Expected effect:** about −0.08 ms per skinned car-frame (Measured 6), roughly 2 ms with 24 cars crushing at once.
   - **Cost:** M.
   - **Risk:** medium. Linear-blend normal error at blend seams. Needs candidate 2 (rank-deficient clusters give `skinInvT = I`).
   - **Verify:** `node scripts/bench-browser.mjs` deform ms plus a visual check.

8. **GPU cluster skinning.** Rajala notes that the per-cell matrices alone place the vertices, so the vertex pass can be separated.
   - **Area:** performance.
   - **Change:**
     - Upload per car 22 × (`skinM`, `skinCm0`, `skinCm`) as a uniform array.
     - Bake 4 cluster indices and weights per vertex from `buildSkinWeights` (`src/game/streamed-deform.ts:568`).
     - Skin and transform normals ($(T^{-1})^T$) in the body material's vertex shader via `onBeforeCompile`, with a matching depth material for shadows.
     - Move the wrinkle (`:2500-2510`) into the shader. The CPU keeps `bakeLocalSkin` (≈ 0.04 ms).
   - **Expected effect:** removes `skin` (≈ 0.45 ms per car-frame, including normals) from the main thread, which is most of the ≈ 15 ms fleet-crash deform cost.
   - **Cost:** L.
   - **Risk:** high. The nonlinear caps and hub pinning (`:2511-2541`) and the cage fallback (`:2475-2483`) must be ported. Panels (`skinPanel` `:1557`) stay on the CPU. Any CPU reader of body positions would need an audit; not checked here.
   - **Verify:** `node scripts/bench-browser.mjs` (deform ms near 0, render ms flat) plus screenshot parity.

9. **Detachment and hub pop driven by cluster strain** (talk: cell deformation is cheap to read, e.g. to drop tyres).
   - **Area:** realism.
   - **Change:**
     - Add `StreamedDeformation.clusterStrain(part: BodyPartName)` next to `partCompression` (`src/game/streamed-deform.ts:1712`): the max $\lVert S_p - I\rVert_F$ or rotation-from-rest of clusters that skin-weight that cage.
     - Feed it into the hinge target in `DeformableCar.syncAttachedParts` (`src/game/car.ts:807-813`) and into the hub pop test (`streamed-deform.ts:1898-1901`).
   - **Expected effect:** parts come off where the structure actually yielded, not only where a sensor compressed.
   - **Cost:** M.
   - **Risk:** medium (double triggering).
   - **Verify:** `src/game/crash-parts.test.ts`.

10. **Hierarchical stiffness cluster (Rajala §3.2 option 2).**
    - **Area:** stability, tooling.
    - **Change:** add one whole-body cluster of non-hub particles after `src/game/streamed-deform.ts:563`, using candidate 3's `weight`. Apply it only when `!contacting` in `stepShapeMatch` (`:2016-2030`) and lower the `stiffnessIters` cap (`shape-match-core.js:502-504`).
    - **Expected effect:** settle stiffness with fewer iterations. Compute here is small (20 particles), so this is mainly a tuning knob.
    - **Cost:** M.
    - **Risk:** medium. It fights legitimate residual shape unless candidate 1 rebases the rest.
    - **Verify:** the settle cases in `src/game/crash-physics.test.ts` and `npm run bench`.

## Not applicable / caveats

- **The $\lVert T - I\rVert_F$ yield cannot be used as written.** Here the particles live in **world space**: `syncShapeFromMasses` copies `m.world` (`src/game/streamed-deform.ts:705-716`), and the clusters capture rest in world orientation at `beginCrush` (`:768`). A spinning car's rigid yaw therefore appears as $R \ne I$ in every cluster and would trigger yield everywhere. Rajala's particles are presumably in body space [INFERENCE]. Any rotation-aware yield here has to be measured against a body reference frame, for example the `followGroup` quaternion or the cabin cluster's $R$.
- **The paper is ambiguous about where the rotation enters plasticity.** "Static particles updated by $T$" only bends a stack of cells if those cells **share** one static particle array. With per-cluster rest copies, as in this repo, the rotational part is goal-invariant (Measured 3). The actionable reading is therefore "rest := current shape" (candidate 1), not "rotate `q0`".
- **Volume conservation $A/\sqrt[3]{\det A}$** is undefined for the 10 rank-deficient clusters ($\det A \approx 10^{-14}$). It only becomes usable after candidate 2. The repo's partial $S_p$ normalisation (`src/game/shape-match-core.js:360-366`) is the safer existing variant.
- **Instant plasticity without creep** suits Rajala's collision-only simulation. Here contact frames are fed incrementally by `feedOverlap` and slow-motion changes `dt`, and the creep in `applyPlasticity` (`:350`) is part of keeping that rate-independent (`crash-physics.test.ts` covers dt invariance around `:847-857`). Candidate 1 adds an instant rebase at window close without removing creep.
- **A full automatic cube lattice** (39–150 cells, hundreds of particles) would discard the semantic particles that gameplay depends on: `ENGINE_KILL_TRAVEL` (`src/game/streamed-deform.ts:36`, `:969`), cabin handling in `foldCabin` (`:2099`), hulls in `liveHulls` (`:1404`), wheel hubs. It would also multiply the cost across 24 cars. The local fixes (candidates 2 and 3) bring the repo's clusters to the lattice's key property, full rank with clean overlap, without that.
- **A separate vertex-update thread** has no direct JS equivalent without `SharedArrayBuffer` (cross-origin isolation). The GPU route (candidate 8) is the practical form of "the vertex pass only needs per-cell matrices".
- **Artist-authored crash morphs (hybrid detail):** the car is procedural (`src/game/car-mesh.ts:368` `makeChassisGeometry`), so there are no artist wreck meshes. The procedural wrinkle already fills this role.
- **FEM, FFD and mass-spring survey (§2.1):** informative only. The repo already keeps a mass-spring lattice mode (`stepBeams`) and trilinear FFD cages. Nothing to adopt.
- **Integrators (Euler / Verlet / leap-frog, eqs. 2.1–2.5):** the repo's semi-implicit Euler plus damping inside `stepStructure` (240 Hz slices, `src/game/streamed-deform.ts:1117`) is covered by existing tests. Switching integrators is not motivated by this paper.
- **Measurement limits:** all timings are Node on WSL, one car, about 40 frames, not the browser. Treat them as ratios, not budgets. The springback probes use the test `BoxGeometry` and the game-default `squash`/`buckle`. Particle dynamics do not depend on the render mesh, but the absolute crush depths (≈ 1 m) are larger than a tuned in-game hit.
- **Unexplained rigid-yaw distortion** (Measured 7) is outside this paper and was not root-caused.

## Talk transcript extras

Things only the seminar recording says (auto-captions, paraphrased):

- **Cell count in production:** "we have 150 cells now in one car", against 39 in the thesis figure. More cells made the body "squiggly" until it was iterated, which confirms the stiffness-halving effect.
- **Particle placement:** the preprocessing builds a "cell crate" of cubes around the mesh, with **one control particle at every corner of every cell**. The cubes only need to be connected, and the mesh inside can be any shape. (This repo has 20 particles, not crate corners.)
- **Cracks between cells are a feature.** Rotation in plasticity causes trouble because vertices are not interpolated between control particles, but on cars this gives "nice cracks" between cells. The repo's 4-cluster blend (`src/game/streamed-deform.ts:2466-2474`) deliberately smooths these away, and creases come from the wrinkle layer (`:2500-2510`) instead.
- **Artist control per control point:** the engine must be stiffer than the doors, and the roof less stiff than the doors. Artists get per-control-point properties. The repo only has per-particle `regionSoftness` for contact gating (`src/game/physics-core.js:32-42`). See candidate 6.
- **Deformed collision shape:** red collision spheres are transformed by the same cell matrices, so a "banana-shaped" wreck rolls and behaves differently. The repo equivalent is `liveHulls` / `liveCrushHulls`, built from particle positions (`src/game/streamed-deform.ts:1404`, `:1475`).
- **Visual vs physical damage are kept apart on purpose** so the player can keep driving. Cell deformation is cheap to read, so it can still drive gameplay, e.g. detect misplaced tyres and drop them. The repo couples harder (`drivetrainAlive`, `src/game/streamed-deform.ts:969`) and pops hubs from travel (`:1898-1901`). See candidate 9.
- **Everything in the demo deformation is simulated;** artists only supplied textures.
- **Fracture was not implemented** because the engine already had a similar system. The repo's analogue is glass crack/shatter plus part detachment (`src/game/car.ts:890-933`).
- **Rationale against FEM:** shape matching is lighter and per-cell independent, so it suits threads or the GPU. Polar decomposition (Shoemake & Duff) is the heaviest maths in the method. The talk also mentions that TOCA and LucasArts (DMM) use FEM-style systems.
