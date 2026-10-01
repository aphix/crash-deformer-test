# Analysis — Falkenstein et al. 2017, *Reclustering for Large Plasticity in Clustered Shape Matching*

Rewrite: `FalkensteinRLP2017.md`. Code read at the time of writing: `src/game/shape-match-core.js`, `src/game/streamed-deform.ts`, `src/game/rig-spec.ts`.

## Summary

- **Rest state per cluster, not per particle.** Under large plasticity the body's rest shape can no longer be embedded in 3-D, so each cluster stores member offsets $p_{ic}$ relative to its own center, plus its own $F^p_c$. Our `makeCluster` already does this (`q0x/q0y/q0z` per cluster, `Sp` per cluster), so the paper's storage model is the one we already use.
- **Rotation must come from the polar decomposition of $F = A_{xr}A_{rr}^{-1}$, not of $A_{xr}$** (Müller 2005 got this wrong). With plasticity it must come from $F^e = F(F^p)^{-1}$. Our `matchCluster` does it correctly: since `qx = Sp·q0` and `AqqInv` is rebuilt from `qx`, `A = Apq·AqqInv` works out to exactly $F\,Sp^{-1} = F^e$.
- **Removal trigger: the condition number of $F^p$.** This catches clusters whose rest space is badly squashed or stretched, and keeps $F^p$ away from singularity. Today we clamp $\|Sp-I\|_F \le$ `maxE` instead. That caps how far a crumple can go, where the paper retires the distorted cluster and lets plastic flow continue.
- **Add and remove clusters gradually** by ramping the per-cluster weights $w_{ic}$: removal ramps slowly, addition faster. Re-center $p_{ic}$ whenever a weight change moves a cluster's center. Our goal blend already has a hook for this: `const cw = 1` in `stepShapeMatch`.
- **Where a new cluster's rest offsets come from.** Run a small **nonlinear embedding** (PBD/Jacobi, 20 iterations, zero allowed stretch) over the neighbor clusters $C_e$ (Eq. 22) and their particles $P_e$ (Eq. 23). Set $p_{ic} = e_i - e_c$ and $F^p = I$. Taking offsets from world space instead bakes elastic strain into the rest shape and causes spurious oscillation. A linear least-squares embedding gave a residual about 100× larger.
- **The paper never resamples particles**; it reclusters a fixed particle set, which keeps volume and mass trivially conserved. For us this means many crumple problems can be addressed by changing *clusters* rather than *particles*. Particle refinement is a separate, harder problem that the paper names as a limitation.
- **Results converge as the cluster count grows; fewer clusters look stiffer** (Fig. 3). Any LoD that changes cluster count changes apparent stiffness, so each tier needs its own calibration (`goalAlpha`, `stiffnessIters`), or tiers should only switch while the car is quiet.
- **Cost:** reclustering roughly doubles a heavily plastic simulation (16.17 → 35.54 ms/frame for 5317 particles and 200 clusters, unoptimized research code). Embedding is about ⅓ of the reclustering cost; cluster placement is negligible. With a higher yield threshold, reclustering cost falls more than 2×. The cost is event-driven, not per step.
- **Cluster quality is the actual lever for our 10 degenerate (3-particle/coplanar) clusters.** The paper gets volumetric clusters from dense blue-noise sampling plus fuzzy c-means, and drops ill-conditioned ones. We hand-author clusters from 20 sparse named masses, so half of them are rank-deficient.

## Useful content

**Shape-matching core (Eqs. 1–6, 15–16).**
$F = A_{xr}A_{rr}^{-1}$; $F^e = F(F^p)^{-1}$; $R = \mathrm{polar}(F^e)$; $g_i = R\,F^p\,(r_i-\bar r) + \bar x$. Use the SVD (or a rank-aware polar) for robustness. Do **not** take $\mathrm{polar}(A_{xr})$. Worked counter-example: rectangle corners $(1,3),(3,1),(-1,-3),(-3,-1)$ stretched 2× in $x$. $\mathrm{polar}(A_{xr})$ returns an ≈11.3° rotation that isn't there; $\mathrm{polar}(F)$ correctly returns $I$. This makes a good unit-test fixture.

**Mass sharing (Eqs. 7–8).** Replace $m_i$ by $w_{ic}m_i$ in each cluster's center-of-mass and $A$ sums. Blend goals as $g_i=\sum_c w_{ic}g_{ic}$ with $\sum_c w_{ic}=1$. Because $A=A_{xr}A_{rr}^{-1}$ and the center of mass are invariant to scaling a whole cluster's weights uniformly, a fade can be done **purely in the goal blend**. A per-particle $w_{ic}$ that differs within a cluster changes both.

**Plasticity (Eqs. 9–14), paper version.**
```text
F_e   = F * inv(Fp)
U,Σe,V = svd(F_e)
Fe*   = det(Σe)^(-1/3) * Σe                 # deviatoric only
dev   = ||Fe* - I||_F
if dev > λ:
    γ  = min(ν * (dev - λ - K*α) / dev, 1)   # flow rate ν, hardening K, accumulated α
    Fp = V * (Fe*)^γ * V^T * Fp               # no left rotation
    α += dev                                  # [reconstructed]
```
Parameters in the paper's experiments: $\lambda = 0$ (all deviatoric deformation plastic) and $\lambda = 0.1$ (partly elastic). $\nu$ and $K$ are user-set (values not reported).

**Cluster removal.** Trigger: $\kappa(F^p) = \sigma_{max}/\sigma_{min} > \kappa_{max}$ (threshold value not reported). Fade $w_{ic}\to 0$ over $T_{out}$ steps, with $T_{out} > T_{in}$. As weights change, shift $p_{ic}$ so the cluster's rest center stays at the origin.

**Cluster addition.**
1. Seed with any particle whose clusters are all marked for removal.
2. Build the local sets: $C_e = C_p \cup$ (clusters sharing a particle with $C_p$), and $P_e$ = all particles in $C_e$.
3. Embedding: minimize $\sum_c\sum_{i\in P_c} w_{ic}\|R_cF^p_cp_{ic} - (e_i-e_c)\|^2$ with a PBD/Jacobi loop (fit $R_c$, project, average). Use 20 iterations, or stop when $\sum|\Delta e|^2 < 10^{-8}\times$ the first iteration's value.
4. Place the new center at $e_{seed}$ and run a few fuzzy c-means iterations with the other clusters frozen, using their *eventual* weights (removing = 0, adding = 1).
5. Initialize $p_{ic}=e_i-e_c$, $F^p=I$, then fade in.

**Tricks for a real-time car body.**
- *Rest rebasing* is the cheapest application of the paper and needs no new clusters. When a cluster's $\kappa(Sp)$ gets too large, replace `q0 ← embedded offsets` and `Sp ← I`. This is the paper's "remove plus add at the same spot", collapsed into one step for a fixed membership.
- Keep the embedding **local** (Eq. 22). In our 22-cluster rig the overlap is so high that $C_e$ is nearly every cluster, so a "local" embedding is effectively global — still cheap at 20 particles.
- Do reclustering as **events with a per-frame budget** (at most one per car per frame). The paper's cost is proportional to how much plastic flow is happening.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Eq. 3 $F=A_{xr}A_{rr}^{-1}$; §3.1 rotation from polar of $F$, not of $A_{xr}$ | `src/game/shape-match-core.js:333-335` `matchCluster` (`m3Mul(_Apq, c.AqqInv, c.A); m3Polar(c.A, c.R, c.S)`) | same | We already avoid the Müller-2005 error. The 2-D rectangle fixture in Eqs. 17–20 would pin this as a regression test. |
| Eq. 15 polar of $F^e = F(F^p)^{-1}$ | `shape-match-core.js:384-390` `applyPlasticity` (`qx = Sp·q0`, then `rebuildAqqWeighted`) + `:300-310` `rebuildAqqWeighted` | same (algebraically) | $A_{pq}=A_{xr0}Sp^T$ and $A_{qq}=Sp\,A_{rr0}\,Sp^T$, so $A = F\,Sp^{-1}$. Plastic rest is baked into `qx` rather than multiplied at goal time. |
| Eq. 16 goal $g = R F^p (r-\bar r)+\bar x$ | `src/game/streamed-deform.ts:1743-1745` `stepShapeMatch` (`goal = M·q + cm`), `M` from `shape-match-core.js:337-338` (`M = R·lerp(I,S,β)`) | variant | Adds Müller's β linear blend (`clusterBeta`). Paper uses pure $R$. |
| Eq. 5 SVD polar | `shape-match-core.js:102-145` `m3Polar` | variant | Iterative $R\leftarrow\frac12(R+R^{-T})$, 12 iterations. Falls back to `R=I` when `m3Invert` fails (`:110-113`). Clamps rotation to 0.85 rad (`:137`). The paper keeps SVD "for robustness": SVD gives a valid $R$ for rank-2 (coplanar) $F$, whereas ours returns $I$. |
| Eqs. 7–8 per-cluster mass share $w_{ic}$, goal blend | `streamed-deform.ts:1740` `const cw = 1`; `:1746-1749`, `:1758` (`goal/goalW`); `shape-match-core.js:319-331` (full `p.mass` in every cluster) | variant | Uniform $w_{ic}=1/n_i$ in the blend; mass not split. `cw` is the natural fade hook. |
| Fuzzy c-means clustering (Jones 2015) | `streamed-deform.ts:389-411` constructor (cage-box membership, L/R split) + `:454-488` `cageClusterIndices`; `src/game/rig-spec.ts:192-199` `EXTRA_CLUSTERS` | missing | Clusters are hand-authored and static. c-means would go in a new `shape-match-core.js` helper called from the constructor. It is only meaningful once N ≫ 20. |
| Cluster quality / non-degenerate clusters | `shape-match-core.js:306-309` (`+1e-3` diag on $A_{qq}$, identity fallback); `streamed-deform.ts:474-486` (pad to ≥3 members) | contradicts | 3-member/coplanar clusters are rank-deficient (known: 10 of 22), and $R$ falls back to $I$. The paper's dense sampling and $\kappa$-based removal never let such a cluster exist. |
| Plasticity Eqs. 10–14 (deviatoric yield λ, flow ν, hardening Kα) | `shape-match-core.js:345-391` `applyPlasticity` | variant | Yields on $\|S-I\|_F$ (`:347-349`), which includes volumetric strain. Creep is `lerp(I,S,creep)`, a first-order stand-in for $V\Sigma^\gamma V^T$ (`:350-353`). Partial det normalization with `keep = 0.08` (`:360-366`). No work-hardening $\alpha$. Plastic rotation creep under contact (`:370-383`) has no counterpart in the paper. |
| Per-cluster rest offsets $p_{ic}$ (§3.2 storage) | `shape-match-core.js:246-251, 291-296` `makeCluster` (`q0x..`, `qx..`) | same | Exactly the paper's and Chentanez's storage. `q0` is also mutated by contact rotation creep (`:376-381`). |
| Removal on $\kappa(F^p)$ | `shape-match-core.js:354-359` `applyPlasticity` (`pe > maxE` → shrink `Sp` toward `I`); `:367-369` (diag ≤ 1.06) | contradicts | We cap plastic flow because we cannot recluster. The paper retires the distorted cluster instead. The trigger would go after `streamed-deform.ts:1814` (the plasticity loop). |
| Weight fade-out/in, re-center $p_{ic}$ | `streamed-deform.ts:1740` `cw` | missing | Needs a per-cluster `w`/`fade` field on the cluster object (`shape-match-core.js:244-275`). |
| Embedding optimization (Eq. 21) | none (closest: the `stepShapeMatch` iteration loop `streamed-deform.ts:1732-1786`, with α = 1, β = 0, no step clamp) | missing | New `embedClusters(clusters, particles, iters)` in `shape-match-core.js`. Reuses `matchCluster` with `Sp`-baked `qx`; writes into scratch positions, not into `shapeParticles`. |
| Local embedding sets (Eqs. 22–23) | none (cluster adjacency derivable from `c.idx`) | missing | Precompute a cluster-neighbor list in the constructor (`streamed-deform.ts:388-412`). |
| Cluster optimization (c-means seed, frozen others) | none | missing | Degenerate at 20 particles. Only useful in a refined tier. |
| Strain limiting (Bargteil & Jones 2014) | `streamed-deform.ts:1774-1781` (per-iteration step clamp 0.14 m); `shape-match-core.js:144` (`S` reset if $\|S-I\|>1.8$), `:137` rotation clamp | variant | Ad-hoc displacement clamps, not per-cluster singular-value limits. |
| Collision proxies per cluster (Jones 2015: sphere ∩ half-spaces) | `streamed-deform.ts:931-955` `collideWith` (every mass of A × every mass of B) | variant | Per-particle spheres, $O(n_A n_B)$: 400 pairs at N = 20, 10,000 at N = 100. Must move to per-cluster proxies before raising N. |
| Sampling geometry (Poisson disk) | `src/game/rig-spec.ts:118-139` `MASS_SPECS` (20 hand-placed named masses) | missing | A refined tier would add anonymous child particles sampled on and inside the body shell. |
| Surface: "embed a surface mesh" (future work) | `streamed-deform.ts:2163-2261` `skin` (up to 4 clusters per vertex, `transformSkinPointInto`) + `:416-452` `buildSkinWeights` | variant | We already use the embedded-mesh route. Skin weights are built once from rest cluster centers and would need a local rebuild when clusters change. |
| Plastic-aware skin fit | `shape-match-core.js:449-501` `matchSkinLocal` (fits `local` vs `Sp·rest`) | same | Consistent with Eq. 15/16 in skin space. |
| Per-cluster parameters when clusters change | `streamed-deform.ts:1697-1698` `clusterBeta` (`ci < this.cages.length ? this.cages[ci]` …) | contradicts | Indexes cages by cluster index, but split clusters shift indices (known misindex). Any dynamic cluster list makes this worse; store `absorption` on the cluster. |
| Rotation hysteresis state | `shape-match-core.js:193-219` `stabilizeMat`, `Rprev`/`skinRprev` (`:266-268`) | missing (transfer) | No paper counterpart. On (re)creation, seed `Rprev` from the first polar so stabilization doesn't treat it as a jump. |
| Timestep dependence | `streamed-deform.ts:963` `stepStructure` (`slices = clamp(round(dt·240),1,4)`) | n/a | The paper says nothing about substeps. Our crush depends on the slice count (known). |

## Particle density & LoD design input

### What the paper actually offers for scaling

The paper's resolution knob is the **number of clusters over a fixed particle set**, not the particle count. Its LoD-relevant contributions:

1. **Cluster count converges** (Fig. 3): beyond some count, adding clusters stops changing the motion; below it, the body looks stiffer. So a coarse tier will look **stiffer** than a fine one unless recalibrated.
2. **Per-cluster state is self-contained** ($p_{ic}$, $F^p_c$). Clusters can be added and removed independently, provided weights are faded and the new cluster's rest is taken from a **minimum-elastic-energy embedding** rather than world space.
3. **Particle resampling is explicitly *not* done.** The authors list adaptive sampling as the thing their method cannot do. Any particle-count LoD is therefore our own extension; the paper only tells us how to keep cluster state consistent around it.

### Hierarchy proposal (grounded in the paper's state model)

- **Level 0 (skeleton):** the 20 named `MASS_SPECS` particles (`rig-spec.ts:118-139`) are never removed. Pose, hulls, drivetrain and `followGroup` read them by name, so they must survive every LoD change.
- **Level 1 (refined patches):** anonymous child particles, sampled ahead of time per body region (nose, tail, each door/side, roof). They are activated only in damaged or visible regions. Each patch brings its own small, well-conditioned clusters (≥4 non-coplanar members, $\kappa(A_{qq})$ below a threshold) that overlap the skeleton particles at their border, so the patch stays attached (the overlap is what holds CSM together).
- **Clusters are the budget unit.** Per-cluster cost is dominated by fixed 3×3 work (polar plus two inversions in `matchCluster`), so the frame cost of shape matching ≈ (number of clusters) × sweeps × $t_c$, plus a small per-member term.

### State transfer when refining (activating a patch)

1. **Child particle position and velocity.** Spawn each child at the *skinned* image of its rest point: `transformSkinPointInto` blended over its ≤4 skin clusters, exactly as `skin()` (`streamed-deform.ts:2181-2186`) maps vertices. Velocity is the same blend applied to the cluster's affine velocity (finite-difference the previous frame's transform). This places children on the current crumpled surface without new solver error.
2. **Mass.** Take child mass from the neighboring skeleton particles so total mass and center of mass are unchanged. The paper preserves mass trivially by never resampling; we must enforce it ourselves.
3. **Rest offsets of new patch clusters.** Follow the paper (Eq. 21): run the local embedding over $C_e$ = the new patch clusters plus every existing cluster sharing a particle with them, for ≤20 Jacobi iterations. Set `q0 ← e_i − e_c`, `Sp ← I`. *Do not* use current world offsets: that freezes the current elastic strain into the rest shape (the paper's "no optimization" variant oscillates). *Do not* use original rest offsets: that makes the patch spring back and undo the dent.
   A cheaper initial guess for $e$: for each particle, average its "plastic rest" over the old clusters containing it, $\frac1{n_i}\sum_c (\bar r_c + Sp_c\,q0_{ic})$ (`qx` is $Sp\cdot q0$). Then run a few iterations.
4. **Rotations.** Set the new cluster's `R`/`Rprev`/`skinR`/`skinRprev` from its first `m3Polar` result, so `stabilizeMat` (`shape-match-core.js:193-219`) sees no jump.
5. **Fade-in** the new clusters' `cw` over ~4–8 steps. Fade the skin weights of affected vertices in parallel (rebuild `buildSkinWeights` for vertices within ~1.45 m of the changed clusters only; `streamed-deform.ts:441` already uses that radius).

### State transfer when coarsening (deactivating a patch)

1. Fade out the patch clusters' `cw`, slower than fade-in (the paper's asymmetry).
2. The plastic state of the region must survive in the skeleton clusters. Refit each surviving skeleton cluster that overlapped the patch by **rest rebasing**: embed (Eq. 21) using the patch clusters' still-valid $Sp,q0$, then set the skeleton cluster's `q0 ← e_i − e_c`, `Sp ← I`. This is the paper's reclustering applied to a cluster whose members are fixed.
3. Child particles are removed only after their clusters reach zero weight. Return their mass to the skeleton particles they borrowed it from.
4. Rebuild skin weights for the affected vertices. The surface is then driven by fewer clusters, so small dents finer than the skeleton's spacing (~0.4–0.6 m) will smooth out. **Accept this, or bake the residual into a per-vertex rest offset** before coarsening (cheap: 1.2k × 3 floats).

### Refinement and coarsening criteria

| Criterion | Signal in code today | Use |
|---|---|---|
| Contact | `overlapFrame` / `bidirectional` (`streamed-deform.ts:1708`), `impactLocal`, `impactWeight` | Refine the patch around `impactLocal` on contact onset (prefer the predicted contact: closing speed × lookahead). |
| Elastic strain | `m3FrobeniusI(c.S)` vs `yieldC` (`shape-match-core.js:347-349`) | Refine where skeleton clusters exceed yield, i.e. where plastic flow is actually happening. |
| Plastic distortion (paper) | $\kappa(Sp)$ (not computed today) | Recluster/rebase when $\kappa > \kappa_{max}$; also refine there. |
| Accumulated damage | `crushAmount`, `|Sp − I|` | Keep refined while damaged *and* visible. |
| Screen size | camera distance → projected car height in px | Allow the fine tier only above ~150 px tall; coarse tier below ~60 px. |
| Quiescence | `quietTime()` (`streamed-deform.ts:1857` gate) | Coarsen only when quiet (> 0.35 s, the same gate that turns shape matching off). Then no dynamic stiffness pop is visible (Fig. 3 effect). |

### Costs (paper vs ours)

- **Paper:** 16.17 ms/frame for 5317 particles and 200 clusters without reclustering (≈3.0 µs/particle/frame, ≈81 µs/cluster/frame, unoptimized). Reclustering adds about 19 ms when heavily plastic (≈2.2×); embedding is ≈⅓ of that. It drops by >2× with a higher yield threshold.
- **Ours (given):** `matchCluster` ≈ 0.5–2.4 µs; 22 clusters per car. At 60 fps, `slices = round(dt·240) = 4` (`streamed-deform.ts:963`), and iterations are 2 (contact) to 5 (`stiffnessIters`). Shape matching per live car per frame: 22 × (4×2 … 4×5) × ~1.2 µs ≈ **0.21–0.53 ms**. This matches the measured sim ≈ 10 ms / 24 cars ≈ 0.42 ms/car.
- **Embedding event (ours, est.):** 20 Jacobi iterations × |C_e| ≈ 22 clusters × ~1.2 µs ≈ **0.5 ms per event per car** [INFERENCE]. With patches, $C_e$ is ~10–15 clusters, so ≈0.3 ms. Budget: at most 1 event per car per frame, and at most 2–3 cars per frame globally.
- **Collision:** `collideWith` is $n_A n_B$ sphere tests. Raising N from 20 to 100 is 25× more pair tests per colliding pair, unless replaced by per-cluster proxies (Jones 2015) or broad-phased.
- **Skin:** ≤4 influences per vertex regardless of cluster count. Deform cost (7–15 ms/24 cars) is roughly independent of N, except `bakeLocalSkin` (`matchSkinLocal` per cluster per frame, `streamed-deform.ts:1997-2000`) and local skin-weight rebuilds on LoD change (≈1.2k vertices × clusters-in-radius distance tests ≈ 0.05–0.2 ms, event only) [INFERENCE].

### Recommended budget (arithmetic)

Assume a shape-matching budget of **≈6 ms/frame** total (today's sim is already ≈10 ms at 24 cars, and render/deform needs the rest of the 16.7 ms). Model: cost/car/frame = C × sweeps × $t_c$, with $t_c$ ≈ 1.2 µs (k ≤ 6 members) to 1.6 µs (k ≈ 8–10) [INFERENCE from the given 0.5–2.4 µs range].

| Tier | Particles | Clusters C | Sweeps (slices×iters) | Cost/car/frame |
|---|---|---|---|---|
| Asleep (not live) | 20 | 22 | 0 (gated by `quietTime`) | ≈0 |
| Coarse live (far, < 60 px) | 20 | ~16 (degenerate ones faded out) | 2×2 = 4 | 16×4×1.2 µs ≈ **0.08 ms** |
| Medium live | 20 + ~20 in one patch ≈ 40 | ~28 | 4×2 = 8 | 28×8×1.4 µs ≈ **0.31 ms** |
| Fine live (hero, near, damaged) | 20 + ~60–80 in 2–3 patches ≈ 80–100 | ~45 | 4×3 = 12 | 45×12×1.6 µs ≈ **0.86 ms** |

Worst case, 32 cars **all live** (pile-up): 2 fine (1.7 ms) + 6 medium (1.9 ms) + 24 coarse (1.9 ms) ≈ **5.5 ms**, inside the 6 ms budget. Add the embedding events (≤3 × 0.3–0.5 ms ≈ 1–1.5 ms, short bursts). At 10 cars all live, everyone can afford medium, and 3–4 can be fine: 4×0.86 + 6×0.31 ≈ 5.3 ms.

Today's flat rig at 32 live cars: 32 × 0.42 ≈ 13 ms, which **already busts** the budget. The coarse tier with fewer sweeps for far cars pays for the fine tier near the camera. A global allocator should assign tiers by (contact, strain, screen size), sorted by priority, until the budget is spent. Recommended per-car ceiling: **~100 particles / ~45 clusters**. Recommended steady state for most cars: **20 particles / ≤16 well-conditioned clusters**.

Key caveat: the paper's convergence result means the fine tier should be calibrated first. Then fit `goalAlpha`/`stiffnessIters` per tier so the coarse tier matches its stiffness, since the coarse tier is otherwise *stiffer* (Fig. 3).

## Candidates to implement

1. **Per-cluster weight `w` with fade ramps**
   - Area: tooling / stability
   - Change: add a `w` field to the cluster object in `makeCluster` (`shape-match-core.js:244-275`). Use `c.w` in place of `const cw = 1` in `stepShapeMatch` (`streamed-deform.ts:1740`) and in the skin blend (`skin`, `:2181-2186`, weight × `c.w`, renormalized). Add `fadeIn/fadeOut` step counters, with fade-out longer than fade-in.
   - Effect: a prerequisite for every reclustering or LoD change. Degenerate clusters can be switched off without a pop.
   - Cost: S. Risk: low (with w ≡ 1 it is a no-op).
   - Verify: `npm run test:game` unchanged; a throwaway script that fades one cluster over 8 steps and checks goal continuity; `npm run bench` shows no regression.
2. **Store per-cluster parameters on the cluster (fix the `clusterBeta` misindex)**
   - Area: correctness
   - Change: in the constructor (`streamed-deform.ts:389-411`), record `absorption` (and the source cage) on each cluster. `clusterBeta` (`:1697-1704`) then reads `this.clusters[ci].absorption` instead of `this.cages[ci]`.
   - Effect: correct per-region stiffness. Required before any dynamic cluster list.
   - Cost: S. Risk: low–medium (it changes tuning, since the misindexed values are what is tuned today).
   - Verify: `npm run test:game`; compare crush depth per cage in `npm run bench` before and after.
3. **Cluster-quality gate at build time (paper's well-conditioned clusters)**
   - Area: correctness / stability
   - Change: after `makeCluster`, compute $\kappa(A_{qq})$ (or the smallest eigenvalue / largest one) in `rebuildAqqWeighted` (`shape-match-core.js:300-310`). Reject or merge clusters below threshold in the constructor (`streamed-deform.ts:401-411`), e.g. by adding the nearest off-plane mass, or fade them to `w = 0` via candidate 1.
   - Effect: removes the 10 rank-deficient clusters that today fall back to `R = I` (rigid snap). More plausible rotation of nose and tail parts.
   - Cost: S–M. Risk: medium (crush shape changes; some regions may lose coverage — check the skin fallback at `:2188-2196`).
   - Verify: a throwaway script printing $\kappa$ per cluster; `npm run test:game`; `scripts/bench-browser.mjs` visual crash.
4. **Rest rebasing on $\kappa(Sp)$ instead of the `maxE` clamp (paper §3.2.1 + Eq. 21, fixed membership)**
   - Area: realism
   - Change: new `embedClusters(clusters, particles, iters)` in `shape-match-core.js`: a Jacobi loop reusing `matchCluster` (β = 0) over scratch positions. In `applyPlasticity` (`:354-359`), replace the shrink-to-`maxE` with: if $\kappa(Sp) > \kappa_{max}$, mark the cluster for rebase. After the plasticity loop (`streamed-deform.ts:1814`), embed the cluster's neighborhood and set `q0 ← e − e_c`, `Sp ← I`, `rebuildAqqWeighted`.
   - Effect: lifts today's cap on plastic flow, so deep crumple accumulates over repeated hits instead of saturating at `maxE`. No spring-back, because the rest shape takes the embedded (not world) configuration.
   - Cost: M. Risk: medium (could over-soften; keep the diagonal `1.06` guard and `κmax` conservative, ~3–5).
   - Verify: a repeated-ram scenario in `npm run bench` showing crush depth growing past today's plateau; `npm run test:game`; a throwaway check that a rebased cluster at rest has goal = current position (zero residual force).
5. **Paper-faithful plasticity option: deviatoric yield + work hardening**
   - Area: realism / stability
   - Change: in `applyPlasticity` (`shape-match-core.js:345-391`), take the SVD of `S` (already symmetric). Det-normalize before the yield test (Eq. 10) and use $\gamma$ from Eq. 13 with accumulated `c.alpha` (Eq. 14). Keep the volumetric crush pathway separate and explicit (sheet-metal cages *do* lose enclosed volume).
   - Effect: monotone hardening, so repeated hits on one area stiffen it as real crumple zones do. Yield becomes independent of compression-only strain.
   - Cost: M. Risk: medium–high (re-tuning; volumetric crush is a feature for us).
   - Verify: `npm run test:game` (`shape-match.test.ts`); bench crush-depth curves for 1, 2 and 3 successive hits.
6. **Rotation regression fixture (§3.1)**
   - Area: correctness
   - Change: add the rectangle case (Eqs. 17–20, lifted to 3-D with a z-thickness) to `src/game/shape-match.test.ts`, asserting `matchCluster` yields `R ≈ I` for a pure non-axis-aligned stretch.
   - Effect: guards against anyone "optimizing" to `polar(Apq)`.
   - Cost: S. Risk: none.
   - Verify: `npm run test:game`.
7. **Per-cluster collision proxies before raising N**
   - Area: performance
   - Change: replace the $n_An_B$ mass loop in `collideWith` (`streamed-deform.ts:931-955`) with per-cluster bounding spheres (center `cm`, radius = max member distance + mass radius) as a broad phase, then member pairs only inside overlapping cluster pairs.
   - Effect: keeps collision cost roughly linear when particles go from 20 to 100.
   - Cost: M. Risk: medium (contact attribution feeds `impactLocal` and pass-through).
   - Verify: `npm run bench` at 24/32 cars; `npm run test:game` (crash and derby tests).
8. **Patch-based particle refinement with paper-style state transfer**
   - Area: realism / performance
   - Change: prebaked child-particle patches per region. Activate them in `stepShapeMatch` callers using the criteria table. Spawn children via `transformSkinPointInto`; build patch clusters; set rest via `embedClusters`; fade in with candidate 1. Add a global tier allocator in `src/game/engine.ts:1160` (`CrashEngine.fixedStep`).
   - Effect: sub-0.4 m dents near the camera; coarse far cars pay for it.
   - Cost: L. Risk: high (named-mass consumers, skin weights, hull generation, determinism).
   - Verify: `scripts/bench-browser.mjs` frame time at 10/24/32 cars, with fine tier on 2–4 cars; a visual comparison of the front crush; `npm run test:game`.

## Not applicable / caveats

- **Volume conservation via $\det F^p = 1$** suits solid plastic beams. Our clusters span a hollow shell plus control points, and the crush *should* reduce enclosed volume. Adopt the deviatoric yield test, but keep an explicit volumetric crush term.
- **Blue-noise volume sampling and fuzzy c-means** need hundreds to thousands of particles (the paper uses 5317 particles / 200 clusters ≈ 27 particles per cluster). At 20–100 particles, hand-authored or region-prebaked clusters with a conditioning gate are the practical substitute.
- **Absolute timings** (16–46 ms/frame for one beam) come from unoptimized research code and a much larger particle count. They are not a real-time budget; only the ratios carry over (reclustering ≈ 2× when heavily plastic; embedding ≈ ⅓ of reclustering).
- **Table 1 columns do not add up** in the extracted text (see the rewrite). Only Total, Reclustering and Embedding are trustworthy.
- **§3.1's rotation error does not affect us**: `matchCluster` already takes the polar of $A_{pq}A_{qq}^{-1}$. The useful takeaway is the test fixture plus the reminder to use $F^e$, which we do implicitly.
- **The paper does not resample particles.** All particle-count LoD here (spawn via skin map, mass borrowing, coarsening bake) is our extension. The paper only covers the cluster-state side.
- **SVD for the polar** is recommended for robustness. Our iterative polar plus identity fallback is the reason coplanar clusters fail. Peers working on the shape kernel may own that change; it is listed as context, not as a candidate here.
- **No substep/timestep analysis** in the paper, so it does not address our slice-count-dependent crush.
