# Meshless Deformations Based on Shape Matching (Müller et al. 2005) — analysis for crash-deformer-test

Paper rewrite: `MeshlessDeformations_SIG05.md`. This paper is the base of `src/game/shape-match-core.js`. Below, "probe" means a throwaway script run under `node --experimental-strip-types` against the real modules (nothing was committed). Every number quoted from a probe was observed in that run. Line numbers are as of commit `a323477` ("Split the rig tables and debug view out of StreamedDeformation"), and all probes were re-run on that tree with identical results.

## Summary

- **Goal-position elasticity.** Energies and forces are replaced by a goal per particle. The goal is the rest shape after optimal alignment onto the current points (Eq. 8). Particles are pulled toward their goals, so the pull cannot overshoot.
- **Least-squares shape matching.** Translation is the mass-weighted centre of mass (Eq. 6). The best linear map is $\mathbf{A}=\mathbf{A}_{pq}\mathbf{A}_{qq}$ with $\mathbf{A}_{qq}=(\sum m\mathbf{q}\mathbf{q}^T)^{-1}$ (Eq. 7). The rotation is the polar factor of $\mathbf{A}_{pq}$ (Sec. 3.3), computed by Jacobi diagonalisation of $\mathbf{A}_{pq}^T\mathbf{A}_{pq}$ (5–10 sweeps).
- **Unconditionally stable integrator.** $\mathbf{v}\mathrel{+}=\alpha(\mathbf{g}-\mathbf{x})/h + h\mathbf{f}_{ext}/m$, then $\mathbf{x}\mathrel{+}=h\mathbf{v}$ (Eq. 9–10). In the 1D case the eigenvalues have modulus 1 for every $\alpha\in[0,1]$ and every $h$. There is no numerical damping. To make the behaviour independent of the step size, use $\alpha = h/\tau$.
- **Momentum.** Matching about the centre of mass, with mass weights and the true $\mathbf{A}_{pq}$ rotation, conserves linear and angular momentum.
- **Deformation modes.** Rigid: $\alpha=1$, goals use $\mathbf{R}$ only. Linear: goals use $\beta\mathbf{A}+(1-\beta)\mathbf{R}$, with $\mathbf{A}$ normalised to $\det=1$. Quadratic: a 3×9 matrix $\tilde{\mathbf{A}}$ over $\tilde{\mathbf{q}}\in\mathbb{R}^9$ adds bend and twist (Eq. 12–13).
- **Overlapping clusters.** The object is split into overlapping regions. Each cluster adds $\alpha(\mathbf{g}^c_i-\mathbf{x}_i)/h$ to its particles, and these contributions are summed (Eq. 14).
- **Plasticity.** It follows O'Brien 2002. Yield when $\|\mathbf{S}-\mathbf{I}\|>c_{yield}$. Creep with $\mathbf{S}_p\leftarrow[\mathbf{I}+hc_{creep}(\mathbf{S}-\mathbf{I})]\mathbf{S}_p$ (Eq. 15, left-multiplied). Cap at $c_{max}$, divide by $\sqrt[3]{\det\mathbf{S}_p}$, deform the rest shape with $\mathbf{q}_i=\mathbf{S}_p(\mathbf{x}^0_i-\mathbf{x}^0_{cm})$ (Eq. 16), then rebuild $\mathbf{A}_{qq}$.
- **Simulate few, skin many.** Only a few vertices need to be particles. Every other vertex is carried by the per-cluster transform (Sec. 4.1).

## Useful content

The parts that matter for a real-time car body:

1. **Eq. 7 plus the Sec. 3.3 rotation rule.** $\mathbf{R}$ is the polar factor of $\mathbf{A}_{pq}$, not of $\mathbf{A}$. That rotation is the least-squares rigid fit (Kabsch/Umeyama). It is the only choice that leaves zero net torque from the goals and so conserves angular momentum. Sec. 4.5 loosely says "polar of $\mathbf{A}$". The two choices agree only when $\mathbf{A}_{qq}$ is isotropic, and car clusters are long boxes, so they are not isotropic.
2. **Eq. 9–10 with $\alpha=h/\tau$.** This is the integration contract. The goal correction goes into the **velocity**. It is not a pure position projection, and that is what lets the structure exchange momentum. $\alpha = h/\tau$ makes the stiffness independent of the step size.
3. **Linear blend $\beta\mathbf{A}+(1-\beta)\mathbf{R}$.** One scalar controls how much the goal follows stretch and shear. The paper normalises $\det\mathbf{A}=1$ to keep volume. A crumpling car needs volume loss, so that normalisation is a knob, not a rule here.
4. **Plasticity (Eq. 15–16, $c_{yield}$, $c_{creep}$, $c_{max}$, $\det$ normalisation).** Three properties matter:
   - The update is left-multiplied. $\mathbf{S}$ is measured relative to the plastic rest, so $\mathbf{S}\mathbf{S}_p$ is the composed rest.
   - The creep term scales with $h$.
   - $\mathbf{A}_{qq}$ is rebuilt after every change to $\mathbf{S}_p$.
5. **Overlapping clusters (Eq. 14).** Locality comes from many small overlapping regions. The paper's clusters are cubic grid cells holding many vertices. That implicitly assumes every cluster is full rank, with at least 4 non-coplanar points.
6. **Quadratic modes (Eq. 12–13).** Bend and twist inside one cluster. They need at least 10 well-spread particles per cluster for the 9×9 $\tilde{\mathbf{A}}_{qq}$ to be invertible.
7. **Skinning (Sec. 4.1).** Render vertices are moved by each cluster's affine map. The repo already does this. It adds normals through the inverse transpose, which the paper does not cover.
8. **Stability claims and their limits.** The proof covers one cluster with a constant system matrix. External forces must be position-independent or instantaneous. Summed overlapping clusters with $\alpha$ near 1 are not covered by the proof.

## Code anchors

All line numbers were re-read in the current tree.

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Particles with masses, rest $\mathbf{x}^0$ | `src/game/rig-spec.ts:118-139 MASS_SPECS`; `streamed-deform.ts:375-383` (`shapeParticles`) | variant | 20 control masses, 9–260 kg. Rest is **re-captured in world space** at the first impact (`captureShapeRest` `:538-551`, called from `beginCrush` `:616`). The paper's rest is frame-free, so this choice is harmless there. Here it is not; see the yaw rows below. |
| Centre of mass $\mathbf{x}_{cm}$, $\mathbf{x}^0_{cm}$ (Eq. 6) | `shape-match-core.js:276-287 makeCluster`; `:312-327 matchCluster` | same | Mass-weighted. |
| $\mathbf{A}_{pq}$ (Eq. 7) | `shape-match-core.js:328-332 matchCluster` | same | `m3OuterAdd(p, q, m)`. |
| $\mathbf{A}_{qq}=(\sum m\mathbf{q}\mathbf{q}^T)^{-1}$ | `shape-match-core.js:300-310 rebuildAqqWeighted` | variant | Adds an absolute `1e-3` to the diagonal (`:306-308`). Probe: **10 of 22 clusters are rank-deficient** (3 particles, or a symmetric 4-particle trapezoid). Their min eigenvalue is 0 (`[bumperFL,bumperFR,engineL,engineR]`, `[bumperRL,bumperRR,axleR]`, `[engineL,railL,wingFL]`×3, `[engineR,railR,wingFR]`×3, `[axleR,tank,bumperRL/RR]`). Two more are near-planar (`[bumperRL/RR,doorL/R,tank,axleR]`, min/max eigenvalue 1.6e-6). The regulariser turns the null direction into a zero column of $\mathbf{A}$. |
| $\mathbf{A}=\mathbf{A}_{pq}\mathbf{A}_{qq}$ | `shape-match-core.js:333` | same | Followed by a magnitude bail-out (`:334`). |
| $\mathbf{R}$ = polar factor of $\mathbf{A}_{pq}$ (Sec. 3.3) | `shape-match-core.js:335 matchCluster → m3Polar(c.A, …)` | **contradicts** | The code takes the polar factor of $\mathbf{A}=\mathbf{A}_{pq}\mathbf{A}_{qq}$, not of $\mathbf{A}_{pq}$. Probe, simple shear 0.35 on a 1.2×0.6×3.0 cluster: polar(A) gives 0.173 rad, the Kabsch rotation is 0.275 rad, and the net torque of the rigid goals is 1.18 with the code's R versus 0.00 with Kabsch. **Consequence:** shear injects angular momentum, so a cluster spins under shear. |
| Polar decomposition (Jacobi on $\mathbf{A}_{pq}^T\mathbf{A}_{pq}$) | `shape-match-core.js:102-145 m3Polar` | variant | Newton iteration $R\leftarrow\frac12(R+R^{-T})$, at most 12 iterations, each with a full inverse (`:109-124`). If an inverse has $\lvert\det\rvert<10^{-12}$ the routine returns **R = S = I** (`:110-114`). Probe: for all 10 degenerate clusters $\det\mathbf{A}\approx10^{-14}$ at rest, so they **always** return identity. Under a rigid 0.3 rad yaw the goal error is 0.276 m (1.04 m at 1.2 rad). Those clusters therefore act as translation-only springs that resist all rotation. |
| Reflection handling (det R < 0) | `shape-match-core.js:131-136` | variant | Flips the third column, whatever its singular value. The correct flip is the axis of the smallest singular value. The paper is silent; Irving 2004 does the correct flip. Inverted clusters recover along an arbitrary axis. |
| No rotation limit in paper | `shape-match-core.js:137 m3ClampRotation(R, 0.85)`; `:178-192` | contradicts | Caps the cluster rotation at 0.85 rad. Because the rest is in world space, this caps the **world yaw since the first impact**. Pinned by `shape-match.test.ts:77-84` ("180° yaw is clamped"). The clamp blends linearly toward I and re-orthonormalises, so the angle is only approximately 0.85. |
| No temporal filter in paper | `shape-match-core.js:193-219 stabilizeMat`, `:336 stabilizeR` | contradicts | After $\mathbf{S}$ has been computed, R is blended 55 % toward the previous R (`:209`). Then $\mathbf{M}=\mathbf{R}_{stab}\,\mathrm{lerp}(\mathbf{I},\mathbf{R}_{raw}^T\mathbf{A},\beta)$, so $\mathbf{R}\mathbf{S}\ne\mathbf{A}$. The lag acts as angular drag. `dot<0` negates R (`:205-208`), which flips the determinant; the fix at `:212-216` then repairs it. |
| $\mathbf{S}=\mathbf{R}^T\mathbf{A}$ | `shape-match-core.js:139-144` | variant | Symmetrised, which throws away any residual rotation left by the clamp. Reset to I when $\|\mathbf{S}-\mathbf{I}\|_F>1.8$. Probe: the near-planar clusters 18/19 have $\|\mathbf{S}-\mathbf{I}\|_F=0.926$ **at rest**, because the regulariser makes $S_{nn}\approx0.074$. |
| Linear goal $\beta\mathbf{A}+(1-\beta)\mathbf{R}$ | `shape-match-core.js:337-338` (`M = R·lerp(I,S,β)`) | same (modulo above) | Algebraically equal to $(1-\beta)\mathbf{R}+\beta\mathbf{R}\mathbf{S}$. It equals the paper's form only when $\mathbf{R}\mathbf{S}=\mathbf{A}$, which fails under clamp, stabilize or S-reset. |
| Volume normalisation $\mathbf{A}/\sqrt[3]{\det\mathbf{A}}$ | — (would go in `matchCluster` before `:337`) | missing | Intentional: a crumpling car should lose volume. There is also no guard against $\det\mathbf{S}\le0$. With β up to 0.9 off-contact (`deformBeta` `:508-510`), an eigenvalue of S below −0.11 produces inverted goals. |
| β per cluster | `streamed-deform.ts:1697-1704 clusterBeta` | variant + **bug** | β is 0.04 at rest; while contacting it is `lerp(0.18+0.22·squash, 0.03, absorb)`; otherwise it is `0.9·squash·(1-absorb/2)`. `absorb` is read from `this.cages[ci]` with the cluster index `ci`. Clusters are not 1:1 with cages: 4 cages are skipped, bonnet and chassisFront split in two, and 6 extras are appended. Probe: from cluster 3 on, every lookup is shifted. bonnet/R uses boot (0.18) while bonnet/L uses bonnet (0.16). doorLeft uses roof (0.52) while doorRight uses doorLeft (0.22). skirtLeft uses chassisRear (0.30) while skirtRight uses skirtLeft (0.22). Extras 16/17 use glass (0.48/0.50). **Consequence: left/right-asymmetric β.** |
| Cluster construction (overlapping cubic regions) | `streamed-deform.ts:388-412` (constructor), `:454-488 cageClusterIndices`, `rig-spec.ts:192-199 EXTRA_CLUSTERS`, `rig-spec.ts:45-64 CAGES` | variant | One cluster per cage (centred cages split L/R), plus 6 hand-picked extras. Probe: 22 clusters but only **14 unique**. `[engineL,railL,wingFL]` and its mirror appear 3× each; `[railL,doorL,cell,roof]` and its mirror appear 2× each. glassFront makes the asymmetric `[roof,engineL,engineR,railL]`. |
| Eq. 14 summed cluster contributions | `streamed-deform.ts:1737-1760 stepShapeMatch` | variant | Averages the goals per particle (`goalX/goalW`). Stiffness no longer grows with overlap count, which is good for stability. However $\sum m\Delta\mathbf{x}\ne0$, so the centre of mass is restored by hand at `:1787-1812`, and **only when not contacting**. Duplicate clusters triple-weight the front triangles. |
| Integrator Eq. 9–10 ($\Delta\mathbf{v}=\alpha(\mathbf{g}-\mathbf{x})/h$) | `streamed-deform.ts:1774-1784` (`p.x += α(g−x)`, step capped 0.14 m); velocity never touched (`writeShapeToMasses` `:566-577` writes back the unchanged `p.v`); integration `:1881` | **contradicts** | This is a position-only projection with **no velocity update**. Probe (8-particle cube, one corner with $v_{rel}=5$ m/s, h=1/240, α=0.51): with the code scheme $v_{rel}$ is still 5.000 after 1 s and the corner drifts 0.83 m. With Eq. 9–10, $v_{rel}$ decays and oscillates (1.39, 0.66, −0.46) and drift stays ≤ 0.042 m. The structure cannot decelerate or transmit momentum. Crush depth is set by the contact code and the `clampLocal` caps (`:1550-1642`), not by structural stiffness. |
| Matching iterations | `streamed-deform.ts:1729`, `:1732` loop; `shape-match-core.js:502-504 stiffnessIters` | variant | 2–5 re-match passes per substep, where the paper does one match per step. Effective per-substep pull is $1-(1-\alpha)^{iters}$. Off-contact: 0.9999 at squash 0, 0.95 at squash 0.5, 0.39 at squash 1. In contact (2 iterations): 0.76 at squash 0.5. |
| α (stiffness) and $\alpha=h/\tau$ | `streamed-deform.ts:1724-1728`; `shape-match-core.js:505-507 goalAlpha` | variant | α is fixed per substep, not scaled by $h$. The substep is `dt/round(dt·240)` (`:963`), with `dt` from `physicsSlice` (`sat.ts:23-27`, `engine.ts:1015`), so the slice is about 1/320–1/161 s. Stiffness per second therefore varies by up to ~2× with the slice length. |
| Half-space clamp (not in paper) | `streamed-deform.ts:1730-1731, 1767-1772` | contradicts (frame bug) | `impactInward` is in the **car-local** frame (set in `beginCrush` `:604`). It is dotted with **world**-frame particle displacements (`syncShapeFromMasses` `:553-564`). Probe, same local frontal crush at different world yaws, bumperFL local z after 24 frames: **0.878 at yaw 0, 1.404 at π/2, 1.427 at π, 1.351 at −π/2**. Rotating `impactInward` into world space inside `stepShapeMatch` gives 0.878/0.892/0.878/0.892. **Crush depth depends on world heading.** Existing tests only crash at yaw 0. |
| Rigid-motion invariance (implicit in paper) | `captureShapeRest` `:538-551` (world rest) + degenerate clusters + clamp | **contradicts** | Probe: after one crush, the masses were given an extra rigid yaw of 0.5 rad and run through live frames (`notifyContact` + `stepStructure` + `followGroup`). Heading per frame: 0.406, 0.342, 0.294, 0.255, 0.223, 0.196. With `stepShapeMatch` stubbed out it stays at 0.500. Dropping the 10 degenerate clusters only slows this (0.173 after 12 frames, against 0.096). **The wreck is pulled back toward its first-impact heading whenever shape matching is live**, for example on any later hit in a derby. |
| Plasticity yield test $\|\mathbf{S}-\mathbf{I}\|>c_{yield}$ | `shape-match-core.js:347-349 applyPlasticity` (`m3FrobeniusI`) | variant | Frobenius norm. $c_{yield}=0.035+0.08(1-\text{squash})+0.04(1-\text{buckle})$, so 0.035–0.155. Early exit when squash and buckle are both < 0.03 (`:346`). |
| Creep $h\,c_{creep}$ | `shape-match-core.js:350` | variant | `creep = min(0.85, (0.35+1.25·squash+0.55·buckle)·max(dt,1/120)·10)`. The `max(dt,1/120)` floor doubles the per-second creep at the actual ~1/240 slice compared with a linear-in-h law. |
| Eq. 15 order $[\ldots]\mathbf{S}_p$ (left) | `shape-match-core.js:351-353` (`Sp ← Sp·lerp(I,S,creep)`) | contradicts (minor) | Right-multiplied. Probe (pre-existing z-squash 0.6, then a symmetric shear 0.3, creep 0.85): residual $\|\mathbf{S}-\mathbf{I}\|$ after one update is 0.066 here and 0.070 with the paper's order; both reach ~0.001 within 3 updates. The fixed point is the same, so the practical impact is negligible. |
| $c_{max}$ cap | `shape-match-core.js:354-359` | same | `I + maxE·(Sp−I)/‖Sp−I‖`, with maxE = 0.18 + 0.55·squash + 0.4·buckle. |
| Volume: divide $\mathbf{S}_p$ by $\sqrt[3]{\det}$ | `shape-match-core.js:360-366` | variant | Applies only 8 % of the correction (`keep = 0.08`), so plastic volume loss is allowed. Probe: clusters 18/19, **undeformed**, 40 contact substeps reach $\|\mathbf{S}_p-\mathbf{I}\|=0.63$ and $\det\mathbf{S}_p=0.44$. This spurious yield comes from the near-singular normal (row above). |
| (extra) no-bulge cap | `shape-match-core.js:367-369` | missing in paper | Diagonal of $\mathbf{S}_p$ capped at 1.06. |
| Eq. 16 $\mathbf{q}=\mathbf{S}_p\mathbf{q}^0$, then rebuild $\mathbf{A}_{qq}$ | `shape-match-core.js:384-390` | same | |
| (extra) rotate rest by R while contacting (Bugbear) | `shape-match-core.js:370-383` | missing in paper | Multiplies $\mathbf{q}^0$ by `lerp(I, R, 0.45·creep)` **without re-orthonormalising** (`:375`), which shrinks $\mathbf{q}^0$ in the rotation plane. Probe: yaw 0.6 plus 25 % compression for 60 contact substeps shrinks Σ\|q0\| by **4.5 %**, outside the $c_{max}$ and volume budgets. It only fires while yielding (rigid yaw alone exits at `:349`). |
| Plasticity every step | `streamed-deform.ts:1813-1815` | variant | Only while `contacting` (`overlapFrame || bidirectional`, `:1708`). |
| Plastic state lifetime | `streamed-deform.ts:595-626 beginCrush` → `bindKinematic` `:579-593` + `captureShapeRest` → `resetCluster` (`shape-match-core.js:392-426`) | variant | Sp and the rest are reset once per car, on the first impact (`car.ts:610-625 applyImpact`, guarded by `!car.crashed` in `pair-contact.ts:84-85`). |
| Skinning with R, t (Sec. 4.1) | `shape-match-core.js:428-437 transformSkinPointInto`; `streamed-deform.ts:2178-2196 skin`, `:2003-2032 solveCagesFromShape`, `:1997-2001 bakeLocalSkin` | variant | The skin uses a **separate** body-frame fit, `matchSkinLocal` (`shape-match-core.js:449-501`), from `m.rest` to `m.local`, which is good. It is followed by `computeVertexNormals` (`streamed-deform.ts:2261`) rather than the available `skinInvT`. |
| Plastic rest in skin | `shape-match-core.js:484` (q = Sp·rest) and `:497` (`skinM = skinR·lerp(I,S,β)`, **no Sp**) | contradicts | The fit is taken against the plastic rest, but the rendered transform omits $\mathbf{S}_p$. Unlike `matchCluster` `:340` (`skinM = M·Sp`), this hides the plastic part. Probe (kernel): particles squashed to z·0.6 with $S_{p,zz}=0.6$ put the skin vertex at z = 0.999 instead of 0.6. In-engine the effect is small today (nose 1.2543 vs 1.2540 m at yaw 0; 1.735 vs 1.720 at yaw π/2) because skin β ≤ 0.4. There is also a frame mismatch: Sp is accumulated in capture-world axes but applied to car-local rest offsets. |
| Normals | `shape-match-core.js:342-343` (`skinInvT`), `:446-448 transformNormal` | missing in paper | Correct inverse transpose, but unused by `skin()`, which calls `computeVertexNormals`. |
| Quadratic modes (Eq. 12–13) | — (would go in `matchCluster` with a 3×9 `Ã` and a 9×9 `ÃqqInv` in `makeCluster`) | missing | Not feasible with 3–6 particles per cluster. See caveats. |
| Rigid mode α = 1 | `streamed-deform.ts:1726` (α = 0.9 when contacting with squash < 0.03) | variant | Near-rigid while contacting at very low squash. |

## Candidates to implement

Ordered by value divided by cost. "Probe" numbers are from the throwaway runs cited in Code anchors.

1. **Fix the world/local frame mix-up in the half-space clamp.** Area: correctness.
   - **Change:** in `src/game/streamed-deform.ts` `stepShapeMatch` (`:1730-1731`), rotate `impactInward` into world space before it is dotted with world displacements: `ix = cos(yaw)·in.x + sin(yaw)·in.z`, `iz = −sin(yaw)·in.x + cos(yaw)·in.z`, using `this.prevYaw` (the heading `followGroup` maintains, `:1070`). The bidirectional branch (`:1762-1766`) compares world `|gz|` with `|p.z|`, which only means something with the car at the origin at yaw 0. That holds for its current callers (`compactor.ts:114`, `engine.ts:749`, `engine.ts:2052`), so leave it unless bidirectional mode spreads.
   - **Effect:** crush depth stops depending on world heading. Probe: bumperFL local z goes from 0.878/1.404/1.427/1.351 (yaw 0, π/2, π, −π/2) to 0.878/0.892/0.878/0.892. In-game crashes at non-zero heading (almost all of them) will crumple like the yaw-0 cases the tests were tuned on.
   - **Cost:** S.
   - **Risk:** low code risk, but in-game crush gets deeper at non-zero yaw, so caps such as `clampLocal` may need a look.
   - **Verify:** add a case to `src/game/shape-match.test.ts` ("StreamedDeformation shape mode"): the frontal pulse at `:310-339`, run with `group.rotation.y = 0` and `π/2`, must give bumperFL `local.z` within 0.03. Then `npm run test:game`.
   - **Interaction:** superseded by #3. If #3 lands, the local `impactInward` becomes correct as-is.

2. **Store cage absorption per cluster.** Area: correctness (left/right symmetry).
   - **Change:** in the `StreamedDeformation` constructor (`:388-411`), push the absorption alongside each `makeCluster`: `cage.spec.absorption` for cage clusters (both halves of a split), and an explicit value for each `extra` (for example 0.1, or the max over member cages). In `clusterBeta` (`:1697-1704`), read `this.clusterAbsorb[ci]` instead of `this.cages[ci].spec.absorption`.
   - **Effect:** removes the shifted lookup that currently gives mirrored clusters different β: bonnet L 0.16 vs R 0.18, doorLeft 0.52 vs doorRight 0.22, skirtLeft 0.30 vs skirtRight 0.22. Left and right hits should then crumple symmetrically.
   - **Cost:** S. **Risk:** low; β changes for 13 of 22 clusters.
   - **Verify:** new test in `shape-match.test.ts`: for every mirrored cluster pair (names with L↔R swapped), `clusterBeta(ci, true)` matches; `crash-parts.test.ts` side hits still pass. Run `npm run test:game`.

3. **Run shape matching in the car body frame, not the first-impact world frame.** Area: correctness/realism.
   - **Change:**
     - `captureShapeRest` (`:538-551`): build cluster rests from `m.rest` (body frame) instead of `m.world`.
     - `stepShapeMatch`: before matching, map each particle into the body frame with the current heading. Estimate the heading per slice exactly as `followGroup` does, from engine mid minus axle (`:974-978`): `p_b = R_y(−yaw)(p_w − pivot)`. After the iterations, map the result back with `R_y(yaw)` before `writeShapeToMasses` (`:1816`). Velocities are untouched (see #9).
   - **Effect:**
     - The wreck is no longer pulled back to its first-impact heading. Probe: a 0.5 rad rigid yaw currently decays to 0.196 rad in 6 live frames; the target is ~0.5.
     - The 0.85 rad clamp in `m3Polar` (`shape-match-core.js:137`) becomes a real "cluster rotation relative to body" limit instead of a cap on world yaw.
     - The local `impactInward` becomes correct (subsumes #1).
     - $\mathbf{S}_p$ ends up in the same axes as the `m.rest` offsets that `matchSkinLocal` applies it to (`:484`).
   - **Cost:** M. **Risk:** medium. Pitch and roll are ignored (followGroup clamps them to ±0.2/±0.5 rad), so the remainder must be absorbed by R. That needs #4 for the degenerate clusters.
   - **Verify:** new `shape-match.test.ts` case reproducing the probe: crush, impose a +0.5 rad rigid yaw on all `masses[].world`, run 12 frames of `notifyContact`/`stepStructure`/`followGroup`, and assert `|group.rotation.y − 0.5| < 0.03` and max `local` drift < 0.05 m. `shape-match.test.ts:77-84` ("180° yaw is clamped") still holds at kernel level. Then `npm run test:game`.

4. **Take R from $\mathbf{A}_{pq}$ with a robust warm-started extractor, and regularise $\mathbf{A}$ toward R.** Area: correctness/stability.
   - **Rotation:** add `m3ExtractRotation(Apq, R, iters)` to `shape-match-core.js`. It is the quaternion fixed-point iteration from Müller et al. 2016, "A Robust Method to Extract the Rotational Part of Deformations": $\boldsymbol\omega=\sum_k \mathbf{r}_k\times\mathbf{a}_k / (|\sum_k\mathbf{r}_k\cdot\mathbf{a}_k|+\epsilon)$, then rotate $q$ by $|\boldsymbol\omega|$ about $\hat{\boldsymbol\omega}$. In `matchCluster`, warm-start it from `c.Rprev` instead of calling `m3Polar(c.A)` (`:335`) and `stabilizeR` (`:336`).
   - **Linear map:** form $\mathbf{A}=(\mathbf{A}_{pq}+\varepsilon\mathbf{R})(\mathbf{A}_{qq,raw}+\varepsilon\mathbf{I})^{-1}$, the Tikhonov solution of $\min\sum m\|\mathbf{A}\mathbf{q}-\mathbf{p}\|^2+\varepsilon\|\mathbf{A}-\mathbf{R}\|_F^2$. Store the raw moment matrix in `rebuildAqqWeighted` (`:300-310`) and use a relative $\varepsilon$ (for example $10^{-3}\,\mathrm{tr}\,\mathbf{A}_{qq}$). Keep $\mathbf{S}=\mathrm{sym}(\mathbf{R}^T\mathbf{A})$ for β and plasticity.
   - **Effect:**
     - The 10 rank-deficient clusters rotate. Today they return R = S = I and leave a 0.28 m goal error at 0.3 rad.
     - Rigid goals stop injecting torque under shear (probe: net torque 1.18 → 0).
     - The near-planar clusters stop yielding at rest (probe: ‖S−I‖ = 0.93 at rest; ‖Sp−I‖ = 0.63 after 40 contact steps with zero strain).
     - Inversions resolve to a proper rotation without the column-3 flip.
     - The temporal filter is replaced by warm-starting, as the paper intends.
   - **Cost:** M.
   - **Risk:** medium; it changes feel for every cluster. `m3Polar` stays for `matchSkinLocal`, or can switch later.
   - **Verify:**
     - New kernel tests in `shape-match.test.ts`: (a) the 3-particle cluster `[1,0,0],[−1,0,0],[0,0,1]` under a 0.3 rad yaw has goal error < 1e-3; (b) after a simple shear, the net goal torque about the centre of mass is < 1e-6.
     - The existing polar tests `:44-102` must still pass (keep `m3Polar` covered).
     - `npm run bench` (`scripts/bench-physics.mjs:39-41`, rows `matchCluster` and `m3Polar`): expected neutral or faster, since a warm-started quaternion iteration needs 1–3 steps versus up to 12 3×3 inverses.

5. **Deduplicate clusters.** Area: performance (also correctness of weighting).
   - **Change:** in the constructor (`:388-411`), skip any cluster whose sorted `idx` key already exists.
   - **Effect:** 22 → 14 clusters, so about 36 % fewer `matchCluster` and plasticity calls per iteration × slice × live car. The front triangles `[engineL,railL,wingFL]` and mirror stop being triple-weighted in the goal average.
   - **Cost:** S. **Risk:** low to medium; front-quarter stiffness drops, so re-check `crash-physics.test.ts`.
   - **Verify:** `shape-match.test.ts:347-357` (needs ≥ 8 clusters, every mass covered); `npm run test:game`; sim ms in `scripts/bench-browser.mjs` fleet runs.

6. **Keep the rest-rotation in plasticity orthonormal.** Area: correctness.
   - **Change:** in `applyPlasticity`, call `m3Orthonormalize(_tmp)` right after `m3Lerp(_I, c.R, creep*0.45, _tmp)` (`shape-match-core.js:375`), or build an exact partial rotation by axis-angle.
   - **Effect:** stops the hidden rest shrink. Probe: yaw 0.6 plus 25 % compression for 60 contact substeps shrinks Σ\|q0\| by 4.5 %, and this bypasses both $c_{max}$ and the volume term.
   - **Cost:** S. **Risk:** low.
   - **Verify:** new kernel test in `shape-match.test.ts` "plasticity": rotated and strained cluster, 60 `applyPlasticity(…, true)` steps, Σ\|q0\| unchanged within 1e-6. The existing plasticity tests `:160-204` must pass.

7. **Render the plastic rest in the skin.** Area: visual quality.
   - **Change:** in `matchSkinLocal` (`shape-match-core.js:497`), set `skinM = skinR·lerp(I,S,β)·Sp`, mirroring `matchCluster` `:340`. Raise or remove the `m3MaxAbs > 4` bail-out at `:498` to match `:341`.
   - **Effect:** the part of the dent absorbed by plasticity stays visible. Kernel probe: z = 0.999 now, 0.6 correct. In-engine the change today is ≤ 1.5 cm at the nose, because skin β ≤ 0.4.
   - **Cost:** S. **Risk:** low, **but only after #3**. Otherwise Sp (world axes at capture) is applied along the wrong body axes whenever the first impact happened at non-zero heading.
   - **Verify:** new kernel test next to `shape-match.test.ts:250-272`: Sp z-squash 0.6 with matching particles gives skin z within 0.05 of 0.6. `npm run test:game`; visual check in the browser bench.

8. **Make stiffness and creep step-size invariant (paper: $\alpha=h/\tau$).** Area: stability/tooling.
   - **Change:** in `stepShapeMatch` (`:1724-1728`), use `alpha = 1 − (1 − α_ref)^(dt·240)` so the current values stay the 240 Hz reference. In `applyPlasticity` (`shape-match-core.js:350`), replace `max(dt, 1/120)·10` with an h-linear or exponential law tuned to keep today's value at dt = 1/240 (`rate·dt·20`, or `1−exp(−rate·dt·20)`).
   - **Effect:** removes the ~2× swing in per-second stiffness and creep across the 1/320–1/161 s slice range produced by `physicsSlice` (`sat.ts:23-27`) and `stepStructure` (`:963`).
   - **Cost:** S. **Risk:** low.
   - **Verify:** `crash-physics.test.ts:843-863` (slomo vs 1/60). Add a test that runs the same crush with `stepStructure(1/240)` ×N and `stepStructure(1/120)` ×N/2 and compares the final `‖Sp−I‖` within 10 %.

9. **Feed shape-matching corrections back into velocity (Eq. 9).** Area: realism.
   - **Change:** in `stepShapeMatch`, record each particle's position after `syncShapeFromMasses` (`:1707`). After the iteration loop, before `writeShapeToMasses` (`:1816`), add `p.v += κ·(Δx_shape)/dt`, excluding the centre-of-mass restore shift. κ ∈ [0,1]; κ = 1 is the paper/PBD rule.
   - **Effect:** the structure finally carries momentum. Crumple-zone masses decelerate the cabin and vice versa, and elastic spring-back appears. Probe: with the current scheme a 5 m/s relative velocity survives 1 s untouched (0.83 m drift); with Eq. 9 drift stays ≤ 0.042 m.
   - **Cost:** L. **Risk:** high. Crumple depth today relies on undamped relative velocity, so every crash tune changes.
   - **Verify:** `crash-physics.test.ts` (rebound `:865-873`, slomo `:843-863`, cabin `:837-841`), `barrier.test.ts`, `compactor.test.ts`, `npm run test:game`; then a feel pass in the browser.

10. **Left-multiply the plastic update (Eq. 15 order).** Area: correctness.
    - **Change:** in `applyPlasticity` (`shape-match-core.js:352`), use `m3Mul(_tmp, c.Sp, _tmp2)` instead of `m3Mul(c.Sp, _tmp, _tmp2)`.
    - **Effect:** small. Probe: residual after one update is 0.070 vs 0.066, and both converge.
    - **Cost:** S. **Risk:** very low.
    - **Verify:** `shape-match.test.ts:160-204`; `npm run test:game`.

11. **Skinned normals from cluster inverse-transposes instead of `computeVertexNormals`.** Area: performance/visual quality.
    - **Change:** store rest normals at construction. In `skin()` (`streamed-deform.ts:2163-2264`, shape branch `:2178-2196`), blend `transformNormal(c, …)` (`shape-match-core.js:446-448`) with the same weights as positions, normalise, and skip `computeVertexNormals` (`:2261`) when the wrinkle amplitude is ~0.
    - **Effect:** removes a full normal recompute from the ~15 ms deform bucket in fleet crashes, on frames where no wrinkle is active.
    - **Cost:** M. **Risk:** medium. The accordion wrinkle (`:2213-2223`) moves vertices outside the cluster transform, so those vertices still need recomputed normals, and blending can show seams.
    - **Verify:** deform ms in `scripts/bench-browser.mjs` (24-car fleet); visual comparison of lighting on crushed panels.

## Not applicable / caveats

- **The unconditional-stability proof does not transfer.** It covers one cluster with summed, linear, velocity-level updates. The code averages overlapping goals, iterates 2–5 times, clamps steps to 0.14 m, adds a half-space clamp, and projects positions only. Its robustness comes from bail-outs in `m3Polar`, `clampLocal` and `clampSpeed`, not from the eigenvalue argument. Do not cite Eq. 11 as a guarantee for this kernel.
- **Quadratic modes (Eq. 12–13) are not usable at the current resolution.** $\tilde{\mathbf{A}}_{qq}$ is 9×9 and needs at least 10 well-spread particles per cluster, but clusters here have 3–6 masses and several are planar. Bend and twist of rails or roof would need cage corners or extra masses promoted to particles (cost: a 9×9 inverse per Sp update plus a 3×9 goal per particle). The paper also shows more clusters (Fig. 7) reaching a similar effect.
- **Volume normalisation $\det\mathbf{A}=1$ / $\det\mathbf{S}_p=1$ is wrong for crumpling sheet metal**, which loses enclosed volume. The code's 8 % partial correction and missing $\mathbf{A}$ normalisation are deliberate. What is missing is only an inversion guard ($\det\mathrm{lerp}(\mathbf{I},\mathbf{S},\beta)>0$).
- **Rigid mode (α = 1, Sec. 4.1) is not the car's rigid motion.** Whole-car motion comes from `followGroup` (`streamed-deform.ts:969-1071`) and the SAT pipeline; shape matching only shapes the wreck.
- **The paper's cluster generation does not scale down.** It uses a regular overlapping grid of cubes over a dense surface mesh. With 20 control masses a grid would produce mostly degenerate clusters, as the hand-made list already does (10/22 rank-deficient). Any cluster list must be audited for rank: at least 4 non-coplanar members.
- **Jacobi on $\mathbf{A}_{pq}^T\mathbf{A}_{pq}$** (the paper's polar method) squares the condition number and still fails on rank-deficient $\mathbf{A}_{pq}$. Prefer the warm-started extractor of #4.
- **Collision handling.** The paper relies on penalty collisions and names them its bottleneck. The repo's 2D SAT hulls and mass-sphere contacts (`collideWith` `:931-958`) are outside this paper's scope.
- **The angular-momentum claim** holds only with R from $\mathbf{A}_{pq}$ and with summed, unclamped goals. The code violates all three today. Fixing #4 restores only the first.
