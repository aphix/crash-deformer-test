# Physically Based Shape Matching (Müller et al., SCA 2022): analysis for crash-deformer-test

Evidence below comes from reading the code and from throwaway probes run against the real modules (`node --experimental-strip-types`, scripts deleted afterwards). Probe numbers are quoted as measured. Anything not measured is tagged `[INFERENCE]`.

## Summary

- **Same fit, different projection.** The paper keeps shape matching's least-squares deformation gradient $\mathbf{F} = \mathbf{P}\mathbf{Q}^{-1}$ (eq. 13; this is exactly `c.A` in `matchCluster`). It drops the "goal = $\mathbf{x}_{cm} + \mathbf{R}\bar{\mathbf{r}}_i$, blend by α" step and instead treats each particle group as a finite element with an energy $C(\mathbf{F})$.
- **Energies become XPBD constraints.** Neo-Hookean uses two constraints: $C_H = \det\mathbf{F} - \gamma$ with $\alpha_H = 1/(\lambda V)$, and $C_D = \sqrt{\operatorname{tr}\mathbf{F}^T\mathbf{F}}$ with $\alpha_D = 1/(\mu V)$. The new contribution is a Hookean (Green-strain) model written as **one** constraint $C = \sqrt{2\hat W(\mathbf{F})}$ with $\alpha = 1/(E\,V)$. Here $\hat W$ is the energy density at $E=1$, so $E$ and $V$ only enter through the compliance.
- **One λ per group.** Each group gets a single multiplier $\lambda = -C/(\sum_i w_i|\nabla_i C|^2 + \alpha/h^2)$. The gradients have closed forms of the type $m_i\,(\partial C/\partial\mathbf{F})\,\mathbf{Q}^{-1}\bar{\mathbf{r}}_i$ (eqs. 17–19). Stiffness is therefore a physical quantity that does not depend on time step or iteration count.
- **Zero-energy-mode filter.** After the λ update, $\mathbf{F}$ and $\mathbf{x}_{cm}$ are recomputed and every particle is overwritten with $\mathbf{x}_{cm} + \mathbf{F}\bar{\mathbf{r}}_i$ (eq. 15). This is linear shape matching with β = 1 and stiffness 1, applied after the physical correction. Like PIC, it removes particle motions the energy cannot see. The side effect is shear locking for soft, large deformations.
- **Tets reproduce FEM.** With tetrahedral groups, eq. 15 is the identity and the method is exactly XPBD FEM. With larger groups it acts as a meshless FEM.
- **Solver schedule.** Use many substeps with **one** iteration each (Small Steps [MSL*19]), the velocity update $\mathbf{v} = (\mathbf{x}-\mathbf{x}_{prev})/h$, and a per-group damping pass (Algorithm 2) that pulls velocities toward the group's rigid motion $(\mathbf{v}_{cm},\boldsymbol\omega)$ with factor $\min(c\Delta t,1)$.
- **Material behaviour (Figs. 2–3).** Neo-Hookean preserves volume within 3% and survives a 270° twist. Hookean with ν = 0.49 over-corrects volume at large strain, and Hookean with ν = 0 behaves like shape matching. Hookean cannot restore inverted elements.
- **Volume per group** sets the compliance. Options: object volume divided by group count, a sphere of radius $\bar r = \operatorname{mean}|\bar{\mathbf{r}}_i|$, $m_i/\rho_i$ from an SPH kernel, or exact cut-cell volumes.
- **Precision note.** Normalise $\mathbf{Q}$ by $s = 1/\sum|q_{ij}|$ before inverting so float32 does not underflow, and scale $\mathbf{P}$ and the gradients by the same $s$.

## Useful content

### 1. Closed-form group projection that drops into `matchCluster` `[derived here, checked numerically]`

The λ step (eq. 20) moves each particle by $\Delta\mathbf{x}_i = \lambda w_i \nabla_i C = \lambda\,\mathbf{D}\mathbf{Q}^{-1}\bar{\mathbf{r}}_i$, where $\mathbf{D} = \partial C/\partial\mathbf{F}$. Particle mass cancels. Because $\sum_i m_i\bar{\mathbf{r}}_i = 0$, the update keeps the centre of mass fixed. The filter (eq. 15) that follows therefore collapses to a single matrix:

$$
\mathbf{F}' = \mathbf{F} + \lambda\,\mathbf{D}\mathbf{Q}^{-1},\qquad
\mathbf{g}_i = \mathbf{x}_{cm} + \mathbf{F}'\,\bar{\mathbf{r}}_i,\qquad
\sum_i w_i|\nabla_i C|^2 = \operatorname{tr}(\mathbf{D}\mathbf{Q}^{-1}\mathbf{D}^T) = \sum_{jk} (\mathbf{D}\mathbf{Q}^{-1})_{jk}\,D_{jk}.
$$

This has exactly the form of the repo's goal $\mathbf{g}_i = \mathbf{c}_{cm} + \mathbf{M}\mathbf{q}_i$ (`stepShapeMatch`, streamed-deform.ts:2022-2024), with $\mathbf{M} := \mathbf{F}'$. **No polar decomposition is needed** for the elastic goal.

For the Hookean case: $\boldsymbol\varepsilon = \tfrac12(\mathbf{F}^T\mathbf{F}-\mathbf{I})$, $\hat{\mathbf{S}} = \hat{\mathbf{C}}\boldsymbol\varepsilon$ (eq. 23 with $E=1$), $C = \sqrt{2\hat W}$, and $\mathbf{D} = \mathbf{F}\hat{\mathbf{S}}/C$.

Prototype (`/tmp`, deleted) on a 5-particle front cluster (engineL/R, railL/R, cell rest positions and masses), with $h = 1/240$ and $V = 0.6\ \text{m}^3$:

| check | result |
|---|---|
| closed-form denominator vs per-particle loop | 1.1259e-2 vs 1.1247e-2 (difference = the `+1e-3` Aqq regulariser) |
| rigid 1.6 rad yaw | $C = 1.8\times10^{-3}$, i.e. no rotation clamp needed. The residual is the `+1e-3` bias. |
| 30 % crush, one 1/240 s slice, E = 0.5 / 2 / 20 MPa | $F_{zz}$ 0.700 → 0.720 / 0.769 / 0.954 |
| cost | `projectHooke` 73 ns on top of `A`, vs `matchCluster` (incl. polar) 676 ns. `npm run bench` reports `matchCluster` 514 ns/op and `m3Polar` 346 ns/op. |

### 2. Compliance is the physical tuning knob

- In XPBD the per-substep correction factor is $\sim \text{den}/(\text{den} + \alpha/h^2)$. For the probe cluster, den ≈ 1.1e-2, so $\alpha/h^2 = 1/(E V h^2)$ gives: E = 0.5 MPa → 6 % of the error closed per slice; 2 MPa → 19 %; 20 MPa → 70 %. Effective, structural E for 1-m-scale clusters is therefore **0.5–50 MPa**, not steel's 200 GPa `[INFERENCE: calibrate from a vehicle frontal stiffness ≈ 1 MN/m via E ≈ kL/A]`.
- Stiffness spans orders of magnitude between regions, so interpolate E **logarithmically**. Proposed mapping from the existing unitless `absorption` (high = stiff, see `clusterBeta`): $E_c = 0.5\,\text{MPa}\cdot 400^{\text{absorption}}$. This gives bumper 0.1 → 0.91 MPa, door 0.22 → 1.9 MPa, roof 0.52 → 11 MPa, cell 0.72 → 37 MPa `[INFERENCE: starting values]`.
- Group volume $V_c$: the owning cage box ($\prod(\text{max}-\text{min})$ from `CAGES`, halved for split clusters), or the paper's sphere $\tfrac43\pi\bar r^3$ with $\bar r = \operatorname{mean}|\mathbf{q}_{0,i}|$ for the extra cross clusters.
- Poisson ratio: use **ν ≈ 0** for crumple regions. The paper's Fig. 2 shows ν = 0 matches shape matching and that ν → 0.5 over-corrects volume at large strain. Crash strains of 30–60 % are large.

### 3. Schedule: one iteration per substep

- [MSL*19]: for a fixed budget $b = s\cdot n$, use $s = b$ substeps and $n = 1$ iteration. The repo already slices to about 1/240 s (`stepStructure`, streamed-deform.ts:1117), so dropping `iters` (2–5) to 1 cuts cluster solves 2–5× without losing stiffness, *provided* the stiffness comes from compliance and not from the iteration count.
- Velocity update $\mathbf{v} = (\mathbf{x}-\mathbf{x}_{prev})/h$ (Algorithm 1). Without it a compliance has no inertial meaning; see candidate 7.

### 4. Damping that does not steal rigid motion (Algorithm 2)

Per group:
- $\mathbf{v}_{cm}$, $\mathbf{L} = \sum \mathbf{r}_i \times m_i\mathbf{v}_i$, $\mathbf{I} = \sum m_i\tilde{\mathbf{R}}_i\tilde{\mathbf{R}}_i^T$, $\boldsymbol\omega = \mathbf{I}^{-1}\mathbf{L}$
- $\mathbf{v}_i \mathrel{+}= \min(c\Delta t, 1)\,(\mathbf{v}_{cm} + \boldsymbol\omega\times\mathbf{r}_i - \mathbf{v}_i)$

It removes only relative (deformation) velocity, conserves linear and angular momentum, and is stable for any $c$.

### 5. Material-model facts that matter for a car

- Hookean / StVK **cannot restore inverted elements** (Fig. 3). Any Hookean goal path needs a $\det\mathbf{F}$ guard that falls back to the polar/rotation goal.
- Neo-Hookean's $C_H = \det\mathbf{F}-\gamma$ is what produces "bulge". For sheet-metal crumple zones that is *unwanted* (see caveats), but it is a cheap anti-inversion term if ever needed. Use $\gamma = 1 + \mu/\lambda$ for rest stability.
- Plasticity composes cleanly. The repo's rest offsets $\mathbf{q}_i = \mathbf{S}_p\mathbf{q}_{0,i}$ make `c.A` the *elastic* gradient $\mathbf{F}_e = \mathbf{F}\mathbf{S}_p^{-1}$, so the paper's elastic constraint can act on `c.A` unchanged.

### 6. Group conditioning (paper §3.4, §6.2)

$\mathbf{F}$ is only defined when $\mathbf{Q}$ has full rank (non-coplanar groups). The paper's normalisation trick fixes float32 underflow. It does **not** fix rank deficiency, and rank deficiency is the real problem in this repo (code anchors and candidate 2).

## Code anchors

All line numbers were checked in the current tree. "Probe" means a throwaway script that ran against the real module.

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Deformation gradient $\mathbf{F}=\mathbf{P}\mathbf{Q}^{-1}$ (eq. 13) | `src/game/shape-match-core.js:328-333` `matchCluster` (`_Apq` accumulation, `m3Mul(_Apq, c.AqqInv, c.A)`) | same | Mass-weighted, same as the paper. `c.A` is the elastic gradient because `q = Sp·q0`. |
| Centre of mass (eq. 14) | `shape-match-core.js:312-327` `matchCluster` | same | — |
| Precomputed $\mathbf{Q}^{-1}$ | `shape-match-core.js:300-310` `rebuildAqqWeighted`; rebuilt at `:390` after plastic `Sp` update | variant | Adds `+1e-3·I` (`:306-308`). Probe: at rest this leaves strain of 1e-4 to 4e-2 in well-posed clusters and $C=1.8\times10^{-3}$ for a rigid pose. |
| §6.2 normalisation of $\mathbf{Q}$ | `shape-match-core.js:306-308` (`+1e-3` regulariser) and `:488-490` (`matchSkinLocal`) | variant | Float64 means no underflow. The real problem is **rank deficiency**: probe shows 10 of 22 clusters have $\det\mathbf{A}=0$ exactly, and clusters 18/19 have $\det\mathbf{A}=0.074$ at rest. |
| Rotation-free goal / projection | `shape-match-core.js:102-145` `m3Polar` → `:335-338` `M = R·lerp(I,S,β)` | variant | The paper's filter (eq. 15) is the β = 1 case ($\mathbf{M}=\mathbf{F}$), applied *after* a physical λ correction. The repo instead blends β by squash. |
| Polar on singular $\mathbf{A}$ | `shape-match-core.js:110-114` (`m3Invert` fails → `R=I,S=I`) | contradicts | Planar or 3-particle clusters always return R = I. Probe: a rigid yaw of 0.4 rad left 10/22 cluster R at identity; a planar 4-particle cluster gave 0.28 m goal error at 0.3 rad yaw. |
| Rotation invariance of energy ($\mathbf{F}^T\mathbf{F}$) | `shape-match-core.js:137` `m3ClampRotation(R, 0.85)`; `:193-219` `stabilizeMat` | contradicts | Clusters are re-based to world pose at crash start (`streamed-deform.ts:690-703` `captureShapeRest`, called at `:768` in `beginCrush`). Rotation beyond 0.85 rad since then is clipped `[INFERENCE: reachable when the car spins during the live window; yaw rate is clamped to ±6 rad/s at :1223]`. |
| Inversion handling (NH restores; Hooke fails, Fig. 3) | `shape-match-core.js:131-136` det(R) flip; `:144` S fallback when ‖S−I‖ > 1.8 | variant | Heuristic guard. A Hookean path needs its own det F guard. |
| Elastic constraint $C(\mathbf{F})$ + compliance (eqs. 3–6, 11–12) | — | missing | Would go in `shape-match-core.js` next to `matchCluster` as a `projectHooke`-style export writing `c.M` (Useful content §1). |
| XPBD λ with $\alpha/h^2$ (eq. 16) | `src/game/streamed-deform.ts:2003-2008` `stepShapeMatch` (contact α 0.32+0.38·squash, else `goalAlpha`), `shape-match-core.js:502-507` `stiffnessIters`/`goalAlpha`, `streamed-deform.ts:2056-2057` 0.14 m step cap | contradicts | PBD-style stiffness: it depends on `iters` (2–5) and on slice count. No units. |
| Material parameters per element ($E,\nu$ / Lamé) | `streamed-deform.ts:83-102` `CAGES[].absorption` (18 cages), read by `:1976-1983` `clusterBeta` (`:1977` `this.cages[ci]`) | contradicts | Unitless. **Also misindexed**: clusters are not 1:1 with cages (4 cages skipped at `:535`, 3 centred cages split at `:545-547`). Probe: 7 of 16 cage clusters read another cage's absorption (bonnet-R gets boot 0.18, doorLeft gets roof 0.52, glassFront gets 0.22 instead of 0.48 …). The 6 extras (`:552-563`, two of them contain cell+roof) get 0.1. |
| Region crush parameters | `src/game/physics-core.js:61-65` `regionCrushBands` (via `:32-42` `regionSoftness`), stored per mass `streamed-deform.ts:453`, used by `physics-core.js:67-73` `forceTransfer` | variant | Travel bands (m) drive contact force pass-through only. Plastic yield in `applyPlasticity` ignores them (next row). |
| Yield / plastic flow (paper: future work) | `shape-match-core.js:345-391` `applyPlasticity`: global `yieldC` `:347`, `creep` `:350`, `maxE` `:354`, det volume keep `:360-366`, rest rotation `:370-383` | missing in paper | Same `F = F_e·Sp` structure. Yield is global, not per region. Creep depends on slice size (probe: ‖Sp−I‖ after 50 ms held squash = 0.187 / 0.170 / 0.123 at dt 1/240 / 1/200 / 1/120). |
| Group volume $V_e$ | `streamed-deform.ts:83-102` cage `min`/`max` boxes; `:606-640` `cageClusterIndices` | missing | No volume is used today. Cage boxes give $V_c$ directly. |
| Groups = elements | `streamed-deform.ts:532-563` constructor cluster build; `:606-640` `cageClusterIndices` fallback `:626-638` | variant | 3–6 particles per cluster. Duplicate clusters: {engineL,railL,wingFL} three times (bonnet-L, wingFL, chassisFront-L), same on the right; doorLeft/Right equal extras 20/21. **Asymmetric fallback**: the equal-distance tie at `:630-636` gives glassFront {roof, engineL, engineR, railL} without railR. |
| Filter step eq. 15 / overlap resolution | `streamed-deform.ts:2016-2040` goal accumulate + average (`goalX/goalW`) | variant | Jacobi averaging instead of Gauss–Seidel overwrite. Order-independent ([BMM17] Jacobi variant). |
| Half-space / contact-specific shaping | `streamed-deform.ts:2041-2052` | missing in paper | Goals cannot push particles back out along the impact axis. This is a plasticity-like heuristic the paper has no equivalent for. Keep it. |
| Substeps × 1 iteration (Alg. 1, [MSL*19]) | `streamed-deform.ts:1114-1121` `stepStructure` (slices = round(dt·240) ≤ 4), `:2008` `iters`; `src/game/sat.ts:23-26` `physicsSlice`; `src/game/engine.ts:1015`, `:1302` | contradicts | 4 slices × 2–5 iterations × 22 clusters = 176–440 polar solves per car per 1/60 s frame. |
| Velocity update $\mathbf{v}=(\mathbf{x}-\mathbf{x}_{prev})/h$ | `streamed-deform.ts:705-729` `syncShapeFromMasses`/`writeShapeToMasses` (`:725` writes the *unchanged* `p.vx`) | missing | Shape-match position corrections never become momentum. Integration happens later at `:2160`. |
| Damping (Alg. 2, rigid-mode preserving) | `streamed-deform.ts:2151-2157` `stepMassSlice` (`m.vel.multiplyScalar(Math.pow(rate, dt))`, rate 0.988 → 0.18 after quiet) | contradicts | Damps world velocities, including whole-car translation and spin. `followGroup` derives car velocity from them (`:1214`). |
| Particles carry the surface (cut-cell) | `streamed-deform.ts:2450-2474` `skin` (cluster skin via `transformSkinPointInto`), `:2284-2288` `bakeLocalSkin` → `shape-match-core.js:449-501` `matchSkinLocal`; `:568-604` `buildSkinWeights` | variant | The skin uses a separate local-frame fit, so it inherits the rank problem. Probe at rest (local = rest): ‖skinM−I‖ of clusters 18/19 = 0.037 / 0.317 / 0.712 at squash 0.02 / 0.4 / 0.9, a bogus flattening along the cluster's thin axis. |
| Kernel types | `src/game/shape-match.ts:19` and `src/game/shape-match-core.d.ts:13` `ShapeCluster` | — | New per-cluster fields (normal `n0`, `E`, `V`, yield) must be added in both. |

## Candidates to implement

Ordered by value/cost. Items 1–2 fix correctness problems that the paper's physics would expose, since $\det\mathbf{F}$ or $\mathbf{F}^T\mathbf{F}$ is meaningless on a rank-2 cluster. Item 3 is the core upgrade path for `matchCluster` + `stepShapeMatch` and keeps the 20-particle budget.

1. **Symmetric, owner-tagged cluster table**
   - Area: correctness / realism.
   - Change (`src/game/streamed-deform.ts`):
     - `cageClusterIndices` (`:626-638`): in the nearest-mass fallback, when `side === 0`, take mirror pairs together. A tie at equal distance (railL/railR) must add both, or neither.
     - Constructor (`:533-563`): when pushing each cluster, record `clusterOwner[ci]`, i.e. the owning cage's `absorption` (later E/V; extras use the member-mass-weighted mean of their cages, not 0.1).
     - `clusterBeta` (`:1977`): read `clusterOwner[ci]` instead of `this.cages[ci]`.
     - Drop exact duplicate clusters (the {engineL,railL,wingFL} triple, its mirror, and extras 20/21 = doorLeft/doorRight clusters) or keep them deliberately with a weight. Today they triple-count the front triangles in the goal average.
   - Expected effect: probe with mirrored ±0.62 m corner wall hits (shape mode, 24 × 1/60 s). L/R mirror error summed over bumper/wing/engine/rail/door is 0.281 m (worst 0.109 m, railR 0.933 vs railL 1.031 m). Making only the glassFront cluster symmetric drops it to **0.011 m (worst 0.003 m)**. Fixing only the absorption index gives 0.270 m, so that fix matters for region tuning rather than symmetry.
   - Cost: S. Risk: low–medium. Removing duplicates changes goal weights near the nose, so recheck crush depths.
   - Verify: new test in `src/game/crash-physics.test.ts` under `forModes("offset / corner barrier")` (`:252`): "good: a right-front and a mirrored left-front hit crush mirror-symmetrically (≤ 1 cm per mass)". Existing `:253`/`:275` corner tests must stay green. Run `npm run test:game`.

2. **Rank-complete planar / 3-particle clusters and drop the `+1e-3·I` bias**
   - Area: correctness / stability.
   - Change (`src/game/shape-match-core.js`):
     - `makeCluster` / `rebuildAqqWeighted`: detect a thin rest direction (smallest eigenvalue of Aqq < 1e-3·trace; for a rank-2 symmetric matrix the null vector is the normalised cross product of two independent rows). Store the unit rest normal `n0` and two in-plane axes `t1, t2` on the cluster, and invert Aqq as a pseudo-inverse plus `n0 n0ᵀ` instead of adding `1e-3·I`.
     - `matchCluster` after `:333`, and `matchSkinLocal` after `:492`: replace the column action $\mathbf{A}\mathbf{n}_0$ with $\hat{\mathbf{n}} = \operatorname{normalize}((\mathbf{A}\mathbf{t}_1)\times(\mathbf{A}\mathbf{t}_2))$, i.e. $\mathbf{A} \leftarrow \mathbf{A} + (\hat{\mathbf{n}} - \mathbf{A}\mathbf{n}_0)\,\mathbf{n}_0^T$. This is the standard treatment of 2-D elements in 3-D: no strain normal to the plane.
     - Add `n0`/`t1`/`t2` to `ShapeCluster` in `src/game/shape-match.ts:19` and `src/game/shape-match-core.d.ts:13`.
   - Expected effect:
     - 10/22 clusters regain rotation (today `R ≡ I`). The front triangles can then hinge and fold, which is also what makes Bugbear's "rotation in plasticity" (`:370-383`) work on them.
     - The rest-state bias goes away: clusters 18/19 no longer report ‖S−I‖ = 0.93 at rest, so there is no spurious plastic yield and no skin flattening (‖skinM−I‖ 0.32 at squash 0.4 at rest).
     - It is a prerequisite for candidate 3.
   - Cost: S–M (≈ +20–40 ns per `matchCluster` `[INFERENCE]`). Risk: medium. Clusters that were rotation-locked will now rotate, so frontal crush shapes change.
   - Verify:
     - New test in `src/game/shape-match.test.ts` next to `:105` ("rigid translate+rotate"): "good: a rigid rotation of a coplanar 4-particle cluster has near-zero goal error". The probe shows 0.28 m today at 0.3 rad.
     - "bad: an undeformed car has identity skinM on every cluster".
     - `npm run bench` (`matchCluster` line, today 514 ns/op).
     - `npm run test:game`.

3. **XPBD Hookean group projection replaces `goalAlpha`/`stiffnessIters`**
   - Area: realism / stability / performance.
   - Change:
     - `src/game/shape-match-core.js`: add export `projectHooke(c, nu, alphaTilde)`. It works on `c.A`: ε, $\hat{\mathbf S}$ (eq. 23 with E = 1, ν ≈ 0), $C=\sqrt{2\hat W}$, $\mathbf D=\mathbf F\hat{\mathbf S}/C$, $\mathbf G=\mathbf D\,$`c.AqqInv`, $\lambda=-C/(\sum\mathbf G\circ\mathbf D+\tilde\alpha)$, then `c.M = A + λG`. Guard: if $\det\mathbf{A} < 0.2$ or non-finite, keep the existing polar goal, because Hookean cannot un-invert (Fig. 3).
     - `src/game/streamed-deform.ts` `stepShapeMatch` (`:2003-2030`): set `iters = 1` (`:2008`). Per cluster, use $\tilde\alpha_c = 1/(E_c V_c h^2)$ with `h` = the slice `dt`, $E_c = 0.5\,\text{MPa}\cdot400^{\text{absorption}}$ and $V_c$ = owning cage box volume (both from candidate 1's table). Call `projectHooke` instead of the β-lerp `M` (`matchCluster` still computes `c.A`; skip `m3Polar` unless candidate 4 needs `S`). Apply the averaged goal fully (`alpha = 1`; keep the 0.14 m cap `:2056-2057` only as a safety net).
     - Delete `goalAlpha`, `stiffnessIters` and the contact α branch (`:2003-2007`), plus their assertions in `shape-match.test.ts:155-156` (they pin implementation constants).
   - Expected effect:
     - Region stiffness is set in physical units and no longer changes with slice count or iteration count.
     - Mass-consistent corrections: the 9 kg bumper and the 260 kg cell get λG·q, so the centre of mass is exactly preserved.
     - No rotation clamp acts on the elastic goal.
     - Performance: today a car does 4 slices × 2–5 iterations × 22 clusters × ~514 ns ≈ 90–226 µs per 1/60 s. With `A` (≈150 ns `[INFERENCE]`) plus `projectHooke` (73 ns, probe) × 4 × 1 × 22 that becomes ≈ 20 µs, saving roughly 0.07–0.2 ms per crashing car. That matters at 24 cars (sim ≈ 10 ms).
   - Cost: M. Requires: 2. Risk: medium–high. Crush feel changes and E needs calibration.
   - Verify:
     - `crash-physics.test.ts:813` (20 m/s vs 5 m/s), `:837` (5 m/s does not fold the cabin), `:865` (no rebound above impact speed).
     - `shape-match.test.ts:310` (frontal pulse shortens the nose).
     - New test "close-but-wrong: crush depth after the same pulse at frame dt 1/60 vs 1/120 differs < 5 %" (pattern of `crash-physics.test.ts:667`).
     - `npm run bench`, then `node scripts/bench-browser.mjs` and compare `phys` ms at 24 cars.

4. **Per-region yield and bottom-out strain from `regionCrushBands`**
   - Area: realism.
   - Change:
     - `src/game/shape-match-core.js` `applyPlasticity`: take per-cluster `yieldStrain` and `maxStrain` arguments instead of the global `yieldC` (`:347`) and `maxE` (`:354`). Measure the yield criterion on the Green strain $\|\boldsymbol\varepsilon\|$ from `c.A` (no polar), and run `m3Polar` only for clusters past yield.
     - `src/game/streamed-deform.ts` constructor (`:532-563`): compute both values per cluster from member masses' `bands` (`:453`, `physics-core.js:61-65`), i.e. `bands.yield / L_c` and `bands.max / L_c`, where `L_c` is the cluster's rest extent along its longest axis.
     - Pass them from `stepShapeMatch:2093`.
   - Expected effect: crumple order (bumper → wing/rail → cell) comes from the same travel bands that `forceTransfer` already uses for force pass-through. Region tuning becomes three physical knobs per region: E (elastic), yield strain (onset) and max strain (bottom-out). `squash` and `buckle` remain global style scalars.
   - Cost: S–M. Risk: medium (global plastic feel changes).
   - Verify: new test in `src/game/shape-match.test.ts` `describe("plasticity")` (`:160`): "good: the same held 10 % squash yields a bumper-region cluster but leaves a cell-region cluster's Sp at identity". `physics-util.test.ts` band tests unchanged. `crash-physics.test.ts:837`.

5. **Time-step-independent plastic creep**
   - Area: correctness.
   - Change: `src/game/shape-match-core.js:350` `applyPlasticity`. Replace `creep = min(0.85, k0·max(dt, 1/120)·10)` (where `k0 = 0.35 + 1.25·squash + 0.55·buckle`) with `creep = 1 − exp(−k'·dt)`, where `k' = −240·ln(1 − min(0.85, k0/12))`. This reproduces today's flow exactly at 1/240 s slices and makes it rate-based at every other slice length.
   - Expected effect: the probe shows plastic flow after a 50 ms held squash of 0.187 / 0.170 / 0.123 at slice 1/240 / 1/200 / 1/120. Slice length varies with frame time and speed (`physicsSlice` `sat.ts:23-26`, `stepStructure` `:1117`), so today crush depth depends on frame rate. This is the same class of bug `crash-physics.test.ts:667` already guards for `feedOverlap`.
   - Cost: S. Risk: low.
   - Verify: new `shape-match.test.ts` test "close-but-wrong: plastic flow over 50 ms matches within 5 % at dt 1/240 and 1/120".

6. **Rigid-mode-preserving damping (Algorithm 2)**
   - Area: stability / realism.
   - Change: `src/game/streamed-deform.ts` `stepMassSlice` (`:2143-2157`).
     - Add a per-cluster pass after `stepShapeMatch`: compute $\mathbf v_{cm}$, $\mathbf L$, $\mathbf I$ (3×3 via `m3Invert`), $\boldsymbol\omega$, then blend each member velocity toward $\mathbf v_{cm}+\boldsymbol\omega\times\mathbf r_i$ with `min(c·dt, 1)` (a member's result is averaged over its clusters).
     - Keep the post-crash "ease to rest" as an explicit drag on the whole-car $\mathbf v_{cm}$ and ω, so it stops masquerading as material damping.
   - Expected effect: jiggle and over-shoot of crushed parts settle quickly without bleeding car momentum during contact. Today, during contact, rate 0.988/s gives almost no internal damping, while after quiet a 0.18/s rate damps rigid motion and internal motion alike.
   - Cost: S–M (22 small 3×3 solves per slice). Risk: medium (post-crash coasting distance changes).
   - Verify: `crash-physics.test.ts:307` (equal-and-opposite ΔP) and `:865`. Throwaway check: total linear and angular momentum before and after the damping pass are equal to 1e-9.

7. **Velocity-consistent position solve (Algorithm 1)**
   - Area: realism.
   - Change: `src/game/streamed-deform.ts` `stepMassSlice` / `stepShapeMatch`.
     - Store `x_prev = world` and integrate `world += vel·h` *before* the shape solve (today at `:2160`, after it).
     - Then set `vel = (world − x_prev)/h`.
     - `writeShapeToMasses` (`:718-729`) must stop writing back the stale `p.vx` (`:725`).
   - Expected effect: the compliance from 3 gets its real inertial meaning ($\alpha/h^2$ vs mass), and elastic spring-back and panel rebound become momentum. Without this step, candidate 3's E behaves as a pure relaxation rate.
   - Cost: L. Risk: high. It interacts with `feedOverlap`/`collideWith`/`applyImpulse` writes, `followGroup` velocity extraction (`:1214`) and the rebound and Newton-3 tests.
   - Verify: full `npm run test:game`, especially `crash-physics.test.ts:307`, `:865`, `:813`. Then `node scripts/bench-browser.mjs` fleet runs, watching for jitter.

8. **Run the cluster solve in the body frame**
   - Area: correctness.
   - Change: `src/game/streamed-deform.ts` `stepShapeMatch` (`:1985-2096`) and `captureShapeRest` (`:690-703`). Feed `m.local` (already maintained in `followGroup:1195`) instead of `m.world` into `shapeParticles`, and convert the goal deltas back to world with the group rotation.
   - Expected effect: `R` holds only deformation rotation, so the 0.85 rad clamp (`shape-match-core.js:137`) and `stabilizeMat` no longer act on whole-car spin during long contacts `[INFERENCE: not measured]`. Lower value once candidate 3 removes R from the elastic goal.
   - Cost: M. Risk: medium.
   - Verify: throwaway that spins a crushing car 1.5 rad during contact and compares goal error. `crash-physics.test.ts` corner/rotation suites.

## Not applicable / caveats

- **Volume conservation is the paper's headline and the wrong goal for a car body.** Folded sheet-metal boxes lose enclosed volume, so crumple regions should be close to ν = 0. The paper shows this reproduces shape-matching behaviour (Fig. 2), and the Hookean ν → 0.5 case over-corrects at large strain, which a crash always reaches. Do not add the Neo-Hookean $C_H$ term to the body. The repo's small plastic volume keep (`applyPlasticity:360-366`, 8 %) is a separate, plastic-side choice. NH bulge would only suit tyres or seats.
- **Resolution and cost.** The paper runs 1800–2300 particles at 82–170 ms per frame single-threaded. This repo has 20 particles per car × 24 cars with a 10 ms sim budget. Take the per-group math (closed form, one λ per cluster), not the discretisation. Cut-cell meshes do not apply: the visual mesh is skinned, not simulated.
- **The zero-energy filter is already implicit.** With 3–6 particles per cluster the extra subspace is tiny, and the goal overwrite in `stepShapeMatch` already plays the role of eq. 15. The paper's real lesson for this repo is the opposite problem: *too few* particles (rank-2 $\mathbf{Q}$), which the paper does not discuss. Shear locking from the linear filter is invisible here because in-cluster bending is supplied by the skin's accordion wrinkle (`skin`, `streamed-deform.ts:2500`+), not by particles.
- **Gauss–Seidel ordering is not recommended here.** The paper prefers sequential GS with a fixed random order. The repo's Jacobi averaging is order-independent, and order dependence would reintroduce left/right asymmetry (candidate 1 shows how sensitive mirror symmetry is).
- **Hookean cannot un-invert.** Deep crush (`deepCrush`, cabin fold) can invert clusters, so candidate 3 must keep the polar goal as a fallback below a det F threshold.
- **Appendix 6.1 shear convention.** With tensor shear strains in a 6-vector, $\tfrac12\boldsymbol\varepsilon^T\mathbf C\boldsymbol\varepsilon$ counts shear energy once, i.e. half the tensor contraction. The prototype used the Voigt form consistently, with $\partial\hat W/\partial\mathbf F = \mathbf F\hat{\mathbf S}$ and off-diagonals σ/2. Eq. 19 as printed reads $\mathbf S\mathbf F$, and $\mathbf F\mathbf S$ is the correct order.
- **§6.2 normalisation is irrelevant** for the Float64Array kernel. Do not mistake it for a fix to the singular-cluster problem.
- **E values are structural, not material.** 0.5–50 MPa for metre-scale clusters versus 200 GPa for steel. They must be calibrated against crush depth and pulse targets (`CRASH` in `physics-core.js:13-21`, the "researched sedan barrier pulse" test), not taken from handbooks.
- **No plasticity, fracture or contact in the paper.** `applyPlasticity`, part detachment (`car.ts`) and the impact half-space clamp (`stepShapeMatch:2041-2052`) stay heuristic. The paper only supplies the elastic core they sit on.
