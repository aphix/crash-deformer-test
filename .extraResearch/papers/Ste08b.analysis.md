# Steinemann, Otaduy, Gross 2008 — "Fast Adaptive Shape Matching Deformations" → crash-deformer-test

Paper rewrite: [`Ste08b.md`](./Ste08b.md). Every code anchor below was read in the working tree. *Measured* numbers come from a throwaway node probe (in `/tmp`, since deleted). The probe imported the real `src/game/shape-match-core.js`, ran `matchCluster` / `m3Polar` 200 k times per configuration on synthetic particle clouds, and timed an Eq. (6)–(7) raw-moment region sum. It was run three times; reported ranges span all runs. `[INFERENCE]` marks claims that were not measured.

## Summary

- **What it is.** FLSM-style shape matching (every simulation node owns an overlapping region; node goals are blended region transforms), but on an **octree**: simulation nodes at leaf-cell centres, **virtual nodes** at inner cells that store their subtree sums. Detail is concentrated where needed and the interior stays coarse.
- **Regions use a tolerance band.** Node $n_j$ is in $R_i$ if its distance is $< w_i$, out if $> (1+\varepsilon)w_i$, and either way in between. A top-down pass over subtree distance intervals $[a_j,b_j]$ then picks a few **summation nodes** (simulation or virtual). With $\varepsilon=0.5$ the average is **6 per region**.
- **Hierarchical fast summation (HF), linear cost.** Depth pass: subtree sums bottom-up. Breadth pass: each region adds its ~6 summation nodes. It works because the region moments are written with **raw (uncentred) moments**: $\mathbf{c}_r = \tfrac1{M_r}\sum m_i\mathbf{x}_i$, $\mathbf{A}_r = \sum m_i\mathbf{x}_i\mathbf{x}^{0T}_i - M_r\mathbf{c}_r\mathbf{c}^{0T}_r$. Every per-particle term is independent of the region, so all regions share one set of sums.
- **Mass-weighted blend.** The goal is $\mathbf{g}_i = \tfrac1{M_i}\sum_{r\ni i} m_r\mathbf{T}_r\mathbf{x}^0_i$. Each region's transform is weighted by the mass of the node that owns it, not averaged uniformly.
- **Plasticity is a per-region matrix $\mathbf{S}_r$ applied outside the sums** (Eqs. 9–10), with $\mathbf{T}_r=[\mathbf{R}_r\mathbf{S}_r\;|\;\mathbf{c}_r-\mathbf{R}_r\mathbf{S}_r\mathbf{c}^0_r]$. The rest positions $\mathbf{x}^0_i$ stay shared by all regions. Same algebra as this repo's `Sp` (`q = Sp·q0`).
- **Dynamic LOD.** Refine: the node's cell splits into children (new simulation nodes) and the parent becomes virtual. Coarsen: the children are removed and the parent becomes a simulation node again. Regions to rebuild: the new nodes plus every region that referenced a removed node. Rebuild is dominated (>80 %) by graph-distance recomputation.
- **Distances are graph distances** on a max-norm visibility graph with integer edge lengths. Edges crossing concave surface regions are dropped, so material across a gap is not coupled. They are computed with a bucketed BFS (Bucket-Moore), $O(mn)$.
- **Costs (3.4 GHz P4, unoptimized C++).** Adaptive hand: 661 nodes at 222 fps ≈ 4.5 ms, ≈ 6.8 µs/node·step. Summation, polar and damping are **⅓ each**. Liver cut: 3.7–15.5 ms/frame, resample 62–124 ms per cut. Flowers: 40 × 142 nodes at 20 fps; refining 352 nodes over 3 levels took **121 ms** (≈ 0.34 ms/new node). Interactive refinement raised the total node count by only **6 %**.
- **Limits the authors state.** Not physically calibrated. Drastic LOD changes stall (only a bounded number of region rebuilds per frame). Needs **volumetric** sampling and **does not do shells/rods**. A car body is mostly shell, which matters a lot here (see caveats).
- **Verdict for this repo.** The paper gives a coherent recipe for going from 20 → N particles: a hierarchy whose L0 nodes are today's named particles, state transfer that cannot pop, and a summation scheme that keeps the per-region cost flat. In JS at 60 fps, though, with all 24 cars live at once the budget is only **~12–23 regions per car** on today's 4-slice × 2–4-iteration schedule, or 35–70 with a reduced schedule. That is today's density. Density only pays off if refinement is **concentrated on the few cars currently crashing**: with 4–8 cars live, 35–139 per car on today's schedule (see D5).

## Useful content

### U1 — Raw-moment region quantities (Eqs. 6–7) and their plastic form (Eqs. 9–10)

$$
\mathbf{c}_r=\frac{1}{M_r}\sum_{i\in R_r}m_i\mathbf{x}_i,\qquad
\mathbf{A}^{pq}_r=\sum_{i\in R_r}m_i\mathbf{x}_i\mathbf{x}^{0T}_i-M_r\mathbf{c}_r\mathbf{c}^{0T}_r,\qquad
\mathbf{A}^{qq}_r=\sum_{i\in R_r}m_i\mathbf{x}^0_i\mathbf{x}^{0T}_i-M_r\mathbf{c}^0_r\mathbf{c}^{0T}_r .
$$

With a plastic matrix $\mathbf{S}_r$ (this repo: `c.Sp`):

$$
\mathbf{A}_r=\mathbf{A}^{pq}_r\,\mathbf{S}_r^T\,\big(\mathbf{S}_r\mathbf{A}^{qq}_r\mathbf{S}_r^T\big)^{-1},\qquad
\mathbf{T}_r=\big[\mathbf{R}_r\mathbf{S}_r\;\big|\;\mathbf{c}_r-\mathbf{R}_r\mathbf{S}_r\mathbf{c}^0_r\big].
$$

Facts that matter here:

- $\mathbf{A}^{qq}_r$ depends only on rest data and region membership. Precompute it per region and per LoD configuration. Only $\mathbf{S}_r\mathbf{A}^{qq}_r\mathbf{S}_r^T$ changes when plasticity yields, and that is a 3×3 sandwich: no per-particle pass, unlike `rebuildAqqWeighted` (`shape-match-core.js:300-310`).
- Per iteration, each particle computes $m_i\mathbf{x}_i$ (3 numbers) and $m_i\mathbf{x}_i\mathbf{x}^{0T}_i$ (9 numbers) **once**, whatever the number of regions that contain it. A region then costs $K$ summation-node adds (~6) plus one polar decomposition.
- **Precision.** Shape particles live in **world** coordinates (`syncShapeFromMasses`, `streamed-deform.ts:553-564`). Raw moments subtract two large numbers, about $|\mathbf{x}|^2$ in size. In Float64 with arena coordinates of ~50 m that cancellation is harmless (~1e-12 relative) `[INFERENCE]`. In Float32 (GPU, typed arrays) it is not. Express moments relative to a per-car origin captured at activation (`captureShapeRest`, `:538-551`).

### U2 — Region-mass-weighted goal blend (Eq. 8)

$$
\mathbf{g}_i=\frac{\sum_{r\ni i}m_r\,\mathbf{T}_r\mathbf{x}^0_i}{\sum_{r\ni i}m_r}.
$$

Today the blend is unweighted: `cw = 1` (`streamed-deform.ts:1740`), then division by the region count (`:1756-1760`). Weighting by region mass makes a 260 kg `cell` region dominate the shared particles it touches, and stops a light bumper region from dragging cabin particles. The weight can be the owning node's mass $m_r$ (paper) or the region mass $M_r$ (a natural variant when regions are not node-owned, as with today's per-cage clusters).

### U3 — Hierarchical summation (Eq. 5)

```text
# once per shape-matching iteration
for leaf i (bottom-up order):            # depth summation
    s_i  = [m_i x_i , m_i x_i x0_i^T]     # 12 numbers
for virtual v (bottom-up):  s_v = Σ_children s_child
for region r:                            # breadth summation
    S = Σ_{k in summ(r)} s_k              # ~6 adds of 12 numbers
    c_r = S.mx / M_r ;  Apq = S.mxx0 - M_r c_r c0_r^T
    A = Apq · Sp^T · AqqPlasticInv_r  →  polar → R_r ;  T_r
for region r: scatter m_r·T_r to its member leaves (same HF pattern in reverse,
              or explicit member lists when regions are small)
```

At car scale (≤ 200 particles) explicit member lists are as cheap as the octree trick `[INFERENCE]`. What actually matters is the raw-moment form, which lets **one** per-particle pass serve all regions, and the bounded region size.

### U4 — Interval region construction (§4.2) as an offline tool

`BuildRegion` (rewrite §4.2) with $\varepsilon=0.5$, graph distance on a max-norm visibility graph whose edges are removed across concave surface regions. For a car this naturally:

- keeps every region a **solid box of cells** (max-norm ball), so $\mathbf{A}^{qq}$ is never rank-deficient, as long as the sampled material is at least 2 cells thick (see caveats);
- separates left and right through the cabin void and separates parts across panel gaps. Today this is done with Euclidean padding and side-sign tests (`cageClusterIndices`, `streamed-deform.ts:454-488`; `pad = 0.16` at `:455`, side filter at `:457-462`, nearest-4 fallback at `:474-486`).

### U5 — Refine/coarsen bookkeeping (§5.2–5.3)

- Refine $n_i$: children become simulation nodes, $n_i$ becomes virtual, $R_i$ is deleted. Regions that used $n_i$ as a summation node keep it: as a virtual node it now returns the children's sum automatically. $N_{update}$ is just the new children.
- Coarsen $\{n_k\}\to n_p$: the parent becomes a simulation node. $N_{update}$ = parent + every region that referenced a removed child.
- Rebuild per $n\in N_{update}$: distances to $(1+\varepsilon)w$ (>80 % of the time), intervals bottom-up, top-down selection, recompute $\mathbf{c}^0_r, M_r$.

### U6 — Region width = local stiffness

Stiffness is controlled per region by $w_i$; Figure 4 shows a soft pinky and a stiff thumb. Wider regions average more rigid motion and are stiffer per iteration. In a car this would let the cabin (`cell`, `roof`) use wide regions and the crumple zones narrow ones, replacing part of today's per-cluster β heuristics (`clusterBeta`, `streamed-deform.ts:1697-1704`).

### U7 — Measured kernel costs in this repo (probe)

| Kernel (JS, node, this machine) | µs per call |
|---|---:|
| `matchCluster`, 4–27 particles | 0.42–0.68 |
| `m3Polar` alone (well-conditioned A) | 0.33–0.41 |
| `matchCluster`, 3 random particles | **0.17–0.21** |
| Eq. (6)–(7) raw-moment region sum, K = 6–10 summation entries, polar excluded | 0.08–0.11 |

- **Polar is ~65–80 % of `matchCluster`.** The paper's split was ⅓ summation / ⅓ polar / ⅓ damping. Here the per-particle summation is already cheap at cluster sizes 4–27. Cost is driven by the **number of regions × iterations**, not by particles per region.
- **The 3-particle timing is a fingerprint of the degenerate-cluster bug.** A coplanar cluster gives rank-2 $\mathbf{A}$. `m3Invert` fails on the first polar iteration (`shape-match-core.js:110-114`) and returns $\mathbf{R}=\mathbf{I}$. That shortcut is why it is 2–3× "faster". The paper's volumetric (cube) regions make this impossible by construction.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Simulation nodes (octree leaves) with mass from cell volume × density | `rig-spec.ts:118-139 MASS_SPECS` (20 named particles, hand-placed); built in `streamed-deform.ts:263-284` and copied to `shapeParticles` `:375-383` | variant | Flat list, hand-tuned masses (8–260 kg), no hierarchy. Named roles (`this.at`, `:290-305`) feed pose, hulls, suspension and drivetrain, so they must survive any refinement as L0/virtual nodes. |
| Virtual nodes storing subtree sums | — | missing | Would sit beside `shapeParticles` (`streamed-deform.ts:203`): parent index + child range per node. A named L0 particle becomes the virtual parent of its refined children. |
| Octree base lattice + subdivision criterion | `rig-spec.ts:45-64 CAGES` (18 FFD boxes) | variant | The cages are a fixed, non-nested decomposition of the body. They could seed the base lattice, but they overlap and are not a tree. |
| Region $R_i$ per simulation node, width $w_i$, interval band $(1+\varepsilon)w_i$ | `streamed-deform.ts:388-411` (constructor: one cluster per cage, L/R split `:401-403`, plus `EXTRA_CLUSTERS` `:408-411`); membership `cageClusterIndices` `:454-488` | variant | Regions are per **cage**, not per particle (22 regions / 20 particles). Membership is a Euclidean AABB with `pad = 0.16` (`:455`), side tests (`:457-462`), and a nearest-≤4 fallback (`:474-486`) that produces the 3-particle/coplanar clusters. |
| Region symmetry $n_i\in R_j\Leftrightarrow n_j\in R_i$ | — | missing | Not meaningful with cage-owned regions. It becomes necessary once regions are particle-owned (Eq. 8 blend). |
| Visibility graph, edges removed across concavities | `cageClusterIndices` side filter `streamed-deform.ts:457-462,482` | variant | A sign-of-x hack stands in for "do not couple across the cabin void". A graph would generalise it (offline tool). |
| Bucket-Moore shortest paths | — | missing (offline only) | Car-scale N ≤ 200 and a fixed topology mean it belongs in a build-time script that emits per-level region tables into `rig-spec.ts`. |
| Eq. (6) region centroid via sums | `shape-match-core.js:311-327 matchCluster` (per-cluster centroid loop) | same (math), variant (evaluation) | Computed per cluster by its own pass over members; nothing is shared between overlapping clusters. |
| Eq. (7) raw-moment $\mathbf{A}^{pq}$ | `shape-match-core.js:328-332 matchCluster` (centred `m3OuterAdd(p−cm, q)`) | variant | Centred form needs the centroid first (two passes, nothing shareable). The raw form allows one per-particle pass shared by all regions (U1). |
| $\mathbf{A}^{qq}$ precomputed per region | `shape-match-core.js:300-310 rebuildAqqWeighted` (+1e-3·I at `:306-308`) | variant | Rebuilt by a per-particle pass after every plastic step (`applyPlasticity` `:390`). The paper form is a 3×3 sandwich $\mathbf{S}\mathbf{A}^{qq}_0\mathbf{S}^T$. The 1e-3 ridge hides rank deficiency instead of preventing it. |
| Polar decomposition → $\mathbf{R}_r$ | `shape-match-core.js:102-145 m3Polar`; called at `:335`; temporal blend `stabilizeMat` `:193-219` | same (+ extra guards) | Early-outs to identity (`:103-107`, `:110-114`, `:125-129`) and the 0.85 rad clamp (`:137`) have no counterpart in the paper. Measured at 65–80 % of `matchCluster` time. |
| $\mathbf{T}_r = [\mathbf{R}\mathbf{S}_r \mid \mathbf{c}-\mathbf{R}\mathbf{S}_r\mathbf{c}^0]$ | `matchCluster` `shape-match-core.js:337-340` (`M = R·lerp(I,S,β)`, `skinM = M·Sp`); goal at `streamed-deform.ts:1743-1745` (`M·q + cm`, with `q = Sp·q0`) | same + variant | Matches the paper's plastic transform, plus Müller's β linear blend, which the paper does not use. |
| Eq. (8) region-mass-weighted goal blend | `streamed-deform.ts:1737-1760 stepShapeMatch` (`cw = 1` at `:1740`, divided by count at `:1756-1760`) | variant | Unweighted average over clusters. The paper weights by $m_r$ (U2). |
| Integration Eqs. (2)–(3), no α | `streamed-deform.ts:1724-1785 stepShapeMatch` (`alpha` `:1724-1728`, 0.14 m step clamp `:1777-1778`, COM restore `:1787-1812`) | variant | Positions are moved by α·(g−x) with a clamp. Velocities are not updated from the goal here; integration happens in `stepMassSlice` (`:1864-1916`). |
| Plastic $\mathbf{S}_r$ update rule | `shape-match-core.js:345-391 applyPlasticity` (yield `:347-349`, creep `:350-353`, magnitude clamp `:354-359`, volume nudge `:360-366`, rest rotation creep on `q0` `:370-383`, `q = Sp·q0` `:384-389`) | variant (richer) | The paper only says it adopts [MHTG05]. The repo's rule is more elaborate. The **q0 rotation creep (`:376-381`) mutates per-cluster rest data**, so rest positions are no longer shared, which conflicts with HF. It is a uniform linear map per cluster, so it can be folded into a matrix (Candidate 4). |
| Per-region stiffness via $w_i$ | `streamed-deform.ts:1697-1704 clusterBeta` (indexes `this.cages[ci]` at `:1698`) | variant + **bug** | Stiffness is per-cluster β from cage absorption, but `ci` is a cluster index, not a cage index (L/R splits `:401-403`, skipped cages `:391`, extras `:408-411`). The paper attaches stiffness to the region itself. |
| Iteration count / global stiffness | `shape-match-core.js:502-510 stiffnessIters`, `goalAlpha`, `deformBeta`; used at `streamed-deform.ts:1729` | missing (paper has none) | The paper is single-pass per step. Iterations multiply region cost (budget arithmetic below). |
| Damping (FLSM region damping, ⅓ of paper's time) | `streamed-deform.ts:1872-1878 stepMassSlice` (isotropic `vel *= rate^dt`) | variant | Per-particle damping also damps rigid motion. Region damping removes only the non-rigid velocity component (Candidate 10). |
| Dynamic LOD refine/coarsen with $N_{update}$ | — | missing | Would live in a new `StreamedDeformation` method called from `CrashEngine.fixedStep` (`engine.ts:1160`) before `stepStructure` (`engine.ts:1302`). |
| Activity gating (only simulate what moves) | `streamed-deform.ts:1856-1860 stepMassSlice` (`live` gate), `engine.ts:1302` (`massActive`) | variant (coarser) | Today the LoD is binary per car: full 22 clusters or nothing. This is the hook for the particle-budget allocator. |
| Surface animation by interpolating nearby node fields [MKN\*04] | `streamed-deform.ts:2163-2264 skin` (4 clusters/vertex `:2179-2187`, `computeVertexNormals` `:2261`); weights `buildSkinWeights` `:416-452` (d ≤ 1.45, exp(−2.35 d), top-4 at `:441-446`); per-frame skin matching `bakeLocalSkin` `:1997-2001` → `matchSkinLocal` `shape-match-core.js:449-501` | same (idea) | Cost is O(V·4), independent of particle count. `buildSkinWeights` is O(V·C) and runs only in the constructor, so a runtime LoD switch needs precomputed per-level weights. |
| Find nearby nodes after topology change (augmented visibility graph) | `streamed-deform.ts:2003-2032 solveCagesFromShape` (every corner scans **all** clusters `:2012-2025`); `pullSensorsFromMasses` `:1956-1995` (every sensor scans all masses twice, rest distances recomputed every frame `:1964-1969,1985-1992`) | missing | Both are O(C) or O(N) scans that are fine at 20–22 but grow linearly with refinement. Precompute neighbour lists per level. |
| Collision via spatial hashing of transformed leaf cells + distance field | `streamed-deform.ts:931-958 collideWith` (all-pairs `nA×nB` sphere test `:939-957`); called per close pair at `engine.ts:1220-1221` | variant | All-pairs is 400 tests per pair at 20 particles. At 128 it would be 16 384 per pair per fixedStep. The hierarchy doubles as a sphere tree (Candidate 8). |
| Topological change (cut edge → $N_{update}$) | `liveHulls` / `liveCrushHulls` `streamed-deform.ts:1244,1308` (`frontDetached`/`rearDetached` flags); `popHub` `:775` | variant (coarse) | Detachment exists only as hull/flag changes, with no region rebuild. Precomputed region tables per detach state would cover it. |
| Debug visualisation of hierarchy | `streamed-deform.ts:1405 createHelper`; `helper?.update()` `:1211` | missing | `DeformRigHelper` draws cages and sensors. Octree cells and active levels would go here (tooling). |
| Timestep coupling | `streamed-deform.ts:960-967 stepStructure` (`slices = round(dt·240)` `:963`); `sat.ts:23-27 physicsSlice`; `engine.ts:1014-1016` (≤ 8 fixed steps/frame) | n/a (budget input) | About 4 `stepMassSlice` calls per 1/60 s in practice, so every per-region cost is ×4 slices ×2–4 iterations. |
| Measured degeneracy (3-particle → R = I) | `shape-match-core.js:110-114 m3Polar` invert-fail path; `rebuildAqqWeighted` ridge `:306-308` | contradicts (paper's volumetric regions forbid it) | Probe: 3-particle `matchCluster` 0.17–0.21 µs vs 0.42+ µs for ≥ 4. The fast time is the identity fallback. |

## Particle density & LoD design input

### D1 — Hierarchy: today's 20 named particles become the root level

- **L0 = the 20 `MASS_SPECS` particles** (`rig-spec.ts:118-139`), never removed. Every named role (`this.at.*` `streamed-deform.ts:290-305`, `massByName`, hulls `:1244/:1308`, suspension `:307-312`, drivetrain) keeps reading an L0 node. Once an L0 node is refined it becomes a **virtual node**: its `world/local/vel` is the mass-weighted mean of its active descendants. That mean is exactly the paper's depth summation ($\sum m\mathbf{x}$, $\sum m$) and costs one pass over leaves. Every existing consumer keeps working unchanged.
- **L1/L2 = octree children of the L0 cells**, generated offline per car template:
  - Give each L0 particle a box cell sized by its `radius` (0.26–0.5 m) and clipped to the cage volumes (`CAGES`).
  - Subdivide 2×2×2 and keep only children that contain material. A child inherits its parent's role flags (`bumper`, `crumple`, `rail`, `softness`, `bands` from `:277-282`).
  - Masses: $m_k = m_p V_k/\sum V$. Child rest positions are chosen so $\sum m_k\mathbf{x}^0_k = m_p\mathbf{x}^0_p$, which conserves COM and momentum on refine and coarsen.
- **Regions = one per active leaf** (paper) **plus the existing per-cage/extra clusters kept at L0** as the coarse skeleton. Build them offline with `BuildRegion` (ε = 0.5, max-norm graph distance, no edges across the cabin void or panel gaps). Store the result as summation-node lists per region per configuration of refined L0 nodes. Each L0 node is either refined or not, which gives at most $2^{12}$ configurations for the 12 crumple-zone nodes. Store per-L0-node local tables plus boundary regions that are rebuilt incrementally, not all $2^{12}$ `[INFERENCE]`.
- **Keep region width constant in metres across levels.** Fine regions then contain more summation nodes but have the same physical reach and per-iteration stiffness. If width scales with cell size, refined areas go soft (see caveats).

### D2 — State transfer at runtime

Notation: parent $p$ with region transform $\mathbf{F}_p = \mathbf{R}_p\,\mathrm{lerp}(\mathbf{I},\mathbf{S}_p,\beta)\,\mathbf{S}^{pl}_p$ (`c.skinM`/`c.M·c.Sp`, `shape-match-core.js:337-340`), current centroid $\mathbf{c}_p$, rest centroid $\mathbf{c}^0_p$.

**Refine $p \rightarrow \{k\}$:**

| State | Transfer | Why it does not pop |
|---|---|---|
| Position | $\mathbf{x}_k = \mathbf{c}_p + \mathbf{F}_p(\mathbf{x}^0_k - \mathbf{c}^0_p)$ | Children start exactly on the parent's current deformation field. |
| Velocity | $\mathbf{v}_k = \mathbf{v}_p + \mathbf{L}_p(\mathbf{x}^0_k - \mathbf{x}^0_p)$, with $\mathbf{L}_p = \big(\sum_{j\in R_p} m_j(\mathbf{v}_j-\bar{\mathbf{v}})\mathbf{q}_j^T\big)\mathbf{A}^{qq}_p$; or simply $\mathbf{v}_k=\mathbf{v}_p$ | Momentum is conserved because $\sum m_k(\mathbf{x}^0_k-\mathbf{x}^0_p)=0$. $\mathbf{L}_p$ keeps spin. |
| Rest shape | $\mathbf{x}^0_k$ = undeformed precomputed child rest | Plasticity stays in the matrices, so the rest data is not edited. |
| Plastic $\mathbf{S}^{pl}$ | every child region and every region overlapping $p$'s cell: $\mathbf{S}^{pl}_k := \mathbf{S}^{pl}_p$, and the folded rest-rotation creep matrix too (Candidate 4) | A linear map applied about a different centre differs only by a translation, which $\mathbf{c}_r$ absorbs. Shape matching on the transferred (affine) positions with Eqs. 9–10 recovers exactly $\mathbf{R}_p$ and $\mathbf{S}^{pl}_p$. Only the small β-elastic stretch re-equilibrates ($\beta\le 0.4$ under contact, `clusterBeta` `streamed-deform.ts:1702`). |
| Rotation history | `Rprev`/`skinRprev` $:= \mathbf{R}_p$ (`stabilizeMat` `shape-match-core.js:193-219`) | A new cluster with `Rprev = I` takes the "idle" branch (`:199-201`) and copies $\mathbf{R}$ unsmoothed. Inheriting keeps the temporal blend continuous. |
| Parent | becomes virtual; its region is retired; other regions that summed $p$ keep it as a summation node | §5.2: only the new children need regions. |
| Skin weights | switch the vertices in $p$'s influence radius to precomputed level-L weights, blended over ~0.1–0.15 s | At the switch instant the child transforms equal the parent's up to the β-elastic part, so the blend only hides that residual and polar/stabilize rounding `[INFERENCE]`. |

**Coarsen $\{k\}\rightarrow p$** (only when allowed, see D3):

- $\mathbf{x}_p=\sum m_k\mathbf{x}_k/m_p$ and $\mathbf{v}_p=\sum m_k\mathbf{v}_k/m_p$ conserve COM and momentum.
- $\mathbf{S}^{pl}_p$ = mass-weighted mean of the children's $\mathbf{S}^{pl}_k$. This is allowed **only if** $\max_k\|\mathbf{S}^{pl}_k-\overline{\mathbf{S}}\|_F < 0.02$ (plastically uniform). Otherwise the dent detail would be destroyed, so **damage pins refinement**.
- $\mathbf{R}_p$, `Rprev` = polar of the shape-match fit of the children's current positions.
- $N_{update}$ = $p$ + every region that summed a removed child. The tables are precomputed, so this is a lookup, not a graph search.

### D3 — Refinement / coarsening criteria (priority-ordered)

1. **Predicted contact (pre-emptive, mandatory).** In `CrashEngine.fixedStep` the pair loop already culls at $dx^2+dz^2>28$ (`engine.ts:1220`). For a pair closing faster than ~5 m/s with time-to-contact < 0.1 s, refine the L0 crumple nodes within `feedOverlap`'s reach of the predicted contact point ($1.05+0.35\,\text{squash}$, `streamed-deform.ts:1162`). Refinement after the hit is useless: the first 1–3 fixed steps of the impact are where `feedOverlap` (`:1133-1178`) writes the dent.
2. **Strain.** Refine when a region's $\|\mathbf{S}-\mathbf{I}\|_F$ exceeds ~0.5× the yield threshold. `applyPlasticity` already computes `err` against `yieldC` (`shape-match-core.js:347-349`).
3. **Damage (pin).** $\|\mathbf{S}^{pl}-\mathbf{I}\|_F > 0.03$ keeps the node refined. Coarsening is only allowed when plastically uniform (D2).
4. **Screen size.** Projected cell size $s_{px} = \dfrac{h_{cell}\,H_{vp}}{2\,d\,\tan(\text{fov}/2)}$. Refine if $s_{px} > 24$ px **and** criterion 1 or 2 holds. Coarsen (if allowed) when $s_{px} < 8$ px. The hysteresis prevents flicker.
5. **Quiet.** Coarsen candidates need `quietTime()` > 1 s (`streamed-deform.ts:633`). An idle car already costs **zero** shape-matching time (live gate `:1857-1859`), so coarsening idle cars only saves memory and `collideWith` work, not solver time.
6. **Budget.** Run a global priority queue (severity × screen weight) with per-car and fleet caps (D5). Allow at most one refine/coarsen event per car per frame. The paper warns that drastic LOD changes stall the method.

### D4 — Costs per particle / region

From the paper (3.4 GHz P4, C++, no low-level optimization):

| Quantity | Value |
|---|---|
| Step cost per node (adaptive hand) | 4.5 ms / 661 ≈ **6.8 µs** |
| Step cost per node (regular 35 k) | 217 ms / 35 000 ≈ **6.2 µs** |
| Split | summation ⅓, polar ⅓, damping ⅓ |
| Summation nodes per region | ~6 (ε = 0.5) |
| LOD refine event | 121 ms / 352 nodes ≈ **0.34 ms per new node**, >80 % of it distance recomputation |
| Cut resample | 62–124 ms per event |

Measured here (U7): region evaluation ≈ polar 0.33–0.41 µs + raw-moment sum 0.08–0.11 µs + goal scatter (not measured; assume ≈ the sum cost) ≈ **0.5–0.6 µs** in a tight loop. In-game `matchCluster` is 0.5–2.4 µs (brief), so I budget with **c_e = 0.6 µs (best) to 1.2 µs (in-game mid)**.

Schedule multiplier today: `physicsSlice` keeps $h\in[1/240,1/60]$ (`sat.ts:23-27`), and `stepStructure` subdivides into `round(h·240)` slices (`streamed-deform.ts:963`). Either way that is **≈ 4 `stepMassSlice` per 1/60 s**. Each live slice runs `iters` = 2 (contact) or `stiffnessIters(0.4)` = round(2 + 0.65·3) = **4** (`:1729`, `shape-match-core.js:502-504`). Average about 3. That gives **12 region evaluations per region per frame**.

Sanity check against the brief: 22 regions × 12 × 0.5–2.4 µs = 0.13–0.63 ms per live car → 3.2–15 ms for 24 live cars. That brackets the measured ≈ 10 ms sim.

Other per-N costs that grow with refinement:

- `collideWith`: $N_A N_B$ sphere tests per close pair per fixed step (`:939-957`). That is 400 → 4 096 (N = 64) → 16 384 (N = 128). At an assumed ~5 ns/test × 4 steps: **0.33 ms per contacting pair at N = 128** `[INFERENCE]`. This needs Candidate 8.
- `solveCagesFromShape`: 18 cages × 8 corners × C clusters (`:2004-2025`); at C = 128 that is 18 k distance tests per frame per crushing car.
- `pullSensorsFromMasses`: 20 sensors × N × 2 rest-distance scans (`:1959-1993`).
- `bakeLocalSkin`: C × `matchSkinLocal` ≈ C × 0.6 µs.
- `skin`: **independent of N.** 4 influences per vertex (`:2179-2187`). Per-vertex work plus `computeVertexNormals` (`:2261`) is where the 7–15 ms deform cost lives. Particle density does not move it, and particle LoD will not fix it.

### D5 — Recommended budget (arithmetic)

The frame is already over budget at 24 cars: sim ≈ 10 + deform 7–15 = 17–25 ms > 16.7 ms. Particle density therefore has to fit inside a **fixed reallocated slice**. I take **B = 4 ms/frame fleet-wide for shape matching**, i.e. today's sim cost minus the non-shape-matching work. Per-region per-frame cost:

- today's schedule (12 evals): 7.2 µs (best) – 14.4 µs (in-game) → **B buys 280–555 live regions per frame**;
- reduced schedule (shape matching on 2 of the 4 slices, 2 iterations = 4 evals): 2.4–4.8 µs → **830–1 670 live regions**. Not from the paper. It changes stiffness and needs the known slice-count dependency fixed first.

Regions per live car with **a** cars simultaneously crash-live (only these cost anything):

| a (live cars) | today, in-game cost | today, best cost | reduced schedule |
|---:|---:|---:|---:|
| 4 | 70 | 139 | 208–417 |
| 8 | 35 | 69 | 104–208 |
| 10 | 28 | 56 | 83–167 |
| 24 | 12 | 23 | 35–70 |
| 32 | 9 | 17 | 26–52 |

Reading the table: if all 24–32 cars are crash-live at once, today's 20 particles / 22 regions is already the ceiling. Uniformly denser cars are not affordable in JS at 60 fps on the current schedule. The paper's model wins the same way the flowers scene did (+6 % nodes): **refine only the few cars that are crashing and visible.**

**Recommendation:**

| Level | Particles / car | Live regions / car | When |
|---|---:|---:|---|
| L0 | 20 | 22 (today's skeleton clusters) | always; every live car |
| L1 | ≈ 50: 8 unrefined L0 + 12 crumple-zone nodes (bumpers ×4, wings ×4, rails ×2, engine ×2) split into 3–4 material-bearing children each | ≈ 70 (≈ 45 leaf regions + 22 skeleton) | crash-predicted and on screen ≥ 24 px |
| L2 | ≈ 110, cap 128: L1 plus the ~8–10 L1 cells within ±0.5 m of the contact split into 6–8 children each | ≈ 130 | top-priority 1–3 cars per frame |

- **Caps.** 128 particles per car. Fleet-wide live-region cap **≈ 300** at the in-game per-region cost, rising to ≈ 550 if the probe's best-case cost holds in the browser (both ≈ 4 ms with today's schedule). Calibrate with `scripts/bench-browser.mjs`.
- **Example, 32-car derby with 6 cars crash-live:**
  - 550 cap: 2 × L2 (130) + 2 × L1 (70) + 2 × L0 (22) ≈ 444 regions;
  - 300 cap: 1 × L2 + 1 × L1 + 4 × L0 ≈ 288.
- **Example, 10 cars with 3 live:**
  - 550 cap: all three at L2 (≈ 390);
  - 300 cap: 1 × L2 + 2 × L1 ≈ 270.
- **24 cars all colliding at once:** the allocator falls back to L0 everywhere, i.e. today's behaviour. That is 24 × 22 = 528 regions, already above the 300 cap: this is the measured ≈ 10 ms sim case, and only the schedule (fewer slices/iterations for shape matching) can bring it down.
- **Refine-event cost** must be ≪ the paper's 0.34 ms/node. That requires precomputed tables (D1). With them a refine is O(children) state writes. Estimated ≤ 5 µs/node in JS `[INFERENCE]`, so ≈ 0.2 ms for a full L1 refine (~40 new nodes), spread over 2–3 frames.
- **Prerequisites before N > ~40:** Candidates 8 (collision hierarchy) and 9 (neighbour lists). Otherwise O(N²)/O(N·C) side costs eat the budget.

## Candidates to implement

1. **Volumetric regions only (no coplanar/3-particle clusters)**
   - Area: correctness / realism
   - Change: in the `StreamedDeformation` constructor (`streamed-deform.ts:389-411`) and `cageClusterIndices` (`:454-488`), reject or augment any cluster whose **unregularised** rest $\mathbf{A}^{qq}$ has $\lambda_{min}/\lambda_{max} < \tau$ (e.g. 0.02). Add the nearest off-plane non-hub particle until the cluster is volumetric. This is the paper's guarantee: max-norm cube regions are always 3-D.
   - Expected effect: the 10 degenerate clusters stop falling back to $\mathbf{R}=\mathbf{I}$ (`shape-match-core.js:110-114`), so rotations propagate through bumpers and wings instead of being pinned. It is also the precondition for any finer sampling: a one-layer refinement would recreate the same bug.
   - Cost: S
   - Risk: medium. Crush tuning (crumple travel, cabin intrusion) was calibrated with the identity-fallback clusters.
   - Verify: throwaway script that counts clusters below τ before/after (expect 10 → 0); `npm run test:game`; `npm run bench` (expect a slight cost rise, since those clusters stop taking the 0.17 µs early-out). Peers `ShapeKernel`/`PaperRajala2008` are measuring the same defect; reconcile thresholds with them.

2. **Attach stiffness to the region, not to `cages[ci]`**
   - Area: correctness
   - Change: store `absorb` (from the source cage; extras use the 0.1 default) on each cluster when it is pushed in the constructor (`streamed-deform.ts:402-410`). `clusterBeta` (`:1697-1704`) then reads the cluster's own value instead of `this.cages[ci]` (`:1698`).
   - Expected effect: β per cluster matches its actual body part. Today, once any cage is split (`:401-403`) or skipped (`:391`), every later cluster index is offset from its cage index, so those clusters read another cage's absorption. With 22 clusters and 18 cages, extras at indices < 18 read some cage's absorption, and the rest fall to the 0.1 default.
   - Cost: S
   - Risk: low/medium (retune)
   - Verify: throwaway dump of (cluster → cage name → β) before/after; `npm run test:game`.

3. **Region-mass-weighted goal blend (Eq. 8)**
   - Area: realism / stability
   - Change: in `stepShapeMatch` (`streamed-deform.ts:1740`) replace `cw = 1` with the cluster's precomputed total mass $M_r$ (or the owning node's $m_r$ once regions are particle-owned). Store $M_r$ in `makeCluster` (`shape-match-core.js:276-287` already sums `msum`).
   - Expected effect: heavy structural regions (cell 260 kg, engine 88 kg) dominate the particles they share with light crumple regions. The cabin is pulled less by bumper clusters, and dents stay more local.
   - Cost: S
   - Risk: medium. Changes the effective stiffness balance.
   - Verify: `npm run test:game` (crash-physics, barrier, compactor suites); compare `crumpleTravel()` and cabin `cell` displacement on a 50 km/h barrier hit via a throwaway script.

4. **Fold the contact rest-rotation creep into a per-cluster matrix**
   - Area: correctness (prerequisite for HF sharing and LoD transfer)
   - Change: in `applyPlasticity` (`shape-match-core.js:370-383`), accumulate `c.Pc = lerp(I, R, creep·0.45)·Pc` (orthonormalised) instead of rewriting `q0`. Use `q = Sp·Pc·q0` at `:384-389`, and apply the same `Sp·Pc` in `matchSkinLocal` (`:484`), which today applies `Sp` only and so **does not see the creep the solver uses**.
   - Expected effect: the solver path is unchanged up to rounding. The skin path becomes consistent with the solver. Rest data becomes immutable, which state transfer requires (D2).
   - Cost: S/M
   - Risk: low
   - Verify: throwaway script comparing per-particle goals from old vs new `applyPlasticity` over a scripted crush (max abs diff ≲ 1e-9 m); `npm run test:game`.

5. **Raw-moment shared summation + precomputed $\mathbf{A}^{qq}_0$ (Eqs. 6–7, 9–10)**
   - Area: performance
   - Change: new kernel `matchRegions` in `shape-match-core.js`:
     - one pass per iteration computes $m_i\mathbf{x}_i$ and $m_i\mathbf{x}_i\mathbf{x}^{0T}_i$ relative to a per-car origin;
     - each region sums its member/summation entries;
     - $\mathbf{A}=\mathbf{A}^{pq}\mathbf{S}^T(\mathbf{S}\mathbf{A}^{qq}_0\mathbf{S}^T)^{-1}$ replaces both `matchCluster`'s two passes (`:316-332`) and the per-plastic-step `rebuildAqqWeighted` (`:300-310`, called at `:390`).
   - Expected effect: per-region cost ≈ polar + 0.08–0.11 µs (measured), whatever the region size. Small gain at 20 particles `[INFERENCE: ~10–20 %]`; this is what makes N ≈ 100 regions × 6 entries linear.
   - Cost: M
   - Risk: low/medium. Different rounding; the ridge `+1e-3·I` (`:306-308`) must become a deliberate choice.
   - Verify: throwaway equivalence test vs `matchCluster` on random clouds (R, S within 1e-9); `npm run bench`.

6. **Offline particle hierarchy + region tables per car template**
   - Area: tooling / realism
   - Change:
     - a `scripts/` generator emits L1/L2 children per L0 `MASS_SPECS` entry (rest, mass fraction, inherited role flags), plus per-level region summation lists, $\mathbf{A}^{qq}_0$, $\mathbf{c}^0$, $M_r$, built with `BuildRegion` (ε = 0.5, max-norm graph distance, BFS/Bucket-Moore);
     - output goes into `rig-spec.ts` next to `MASS_SPECS`/`EXTRA_CLUSTERS`;
     - per-level skin weights are precomputed the same way as `buildSkinWeights` (`streamed-deform.ts:416-452`).
   - Expected effect: refine/coarsen become table lookups, with no runtime distance computation (the paper's >80 % cost).
   - Cost: M
   - Risk: low (data only until wired)
   - Verify: the generator asserts per-parent mass/COM conservation and $\lambda_{min}/\lambda_{max}\ge\tau$ for every region; `npm run test:game` unchanged with LoD pinned to L0.

7. **Runtime refine/coarsen with state transfer + fleet budget allocator**
   - Area: realism / performance
   - Change:
     - `StreamedDeformation.refine(l0)` / `coarsen(l0)` implementing D2. Named L0 nodes become virtual aggregates, so `this.at.*`, hulls and the drivetrain keep working;
     - `feedOverlap` (`:1156-1176`), `kickNearest`, `collideWith`, `stepShapeMatch` and `stepMassSlice` iterate active leaves;
     - an allocator in `CrashEngine.fixedStep` (`engine.ts:1160`), run before `stepStructure` (`engine.ts:1302`), applies the D3 criteria and the D5 caps (128/car, ≈ 300–550 live regions fleet-wide).
   - Expected effect: localized, higher-frequency dents on the 1–3 cars that matter. The 24–32-car worst case is unchanged.
   - Cost: L
   - Risk: high (wide surface; pop/feel regressions)
   - Verify: `npm run test:game` with LoD forced to L0 (must be identical); throwaway crash replay comparing dent footprint at L0 vs forced L2; `scripts/bench-browser.mjs` at 10/24/32 cars (frame time, sim ms, deform ms), checking that the allocator holds the 4 ms shape-matching slice.

8. **Hierarchical broadphase in `collideWith`**
   - Area: performance (prerequisite for N > ~40)
   - Change: in `collideWith` (`streamed-deform.ts:931-958`), test L0 bounding spheres (the radius bound of their active descendants) pairwise first, i.e. today's 400 tests, and descend only into overlapping pairs. This is the hierarchy reused as a sphere tree; the paper uses spatial hashing of transformed leaf cells.
   - Expected effect: per-pair cost ~O(contacts) instead of $N_AN_B$ (16 384 tests at N = 128).
   - Cost: M
   - Risk: low
   - Verify: throwaway equality of contact sets vs brute force on recorded pairs; `npm run bench`.

9. **Precomputed neighbour lists for cage corners and sensors**
   - Area: performance
   - Change: in the constructor, precompute corner → cluster lists (`d ≤ 1.4`, `solveCagesFromShape` `:2012-2019`) and sensor → mass lists with weights (constant rest distances, `pullSensorsFromMasses` `:1964-1969,1985-1992`).
   - Expected effect: removes per-frame O(C)/O(N) scans and up to ~800 `distanceTo` calls per crushing car per frame today (20 sensors × 20 masses × 2 loops; far-side sensors skip the first loop). Needed before refinement multiplies C and N.
   - Cost: S
   - Risk: low
   - Verify: output equality throwaway; `npm run bench`.

10. **Rigid-preserving region damping ([RJ07], HF-compatible per the paper)**
    - Area: stability / realism
    - Change: during live crush, replace part of the isotropic per-mass damping (`stepMassSlice` `:1872-1878`). Per region, compute $\mathbf{v}_{cm}$ and $\boldsymbol\omega$ from linear and angular momentum, and damp only $\mathbf{v}_i-(\mathbf{v}_{cm}+\boldsymbol\omega\times\mathbf{r}_i)$.
    - Expected effect: cluster "breathing" and wobble die quickly without bleeding the wreck's rigid slide or spin. That rigid motion is currently patched by the COM restore (`:1787-1812`) and the quiet-time velocity flattening (`:1917-1936`).
    - Cost: M
    - Risk: medium (settle timing tests)
    - Verify: `npm run test:game` (settle and derby suites); throwaway measurement of post-hit non-rigid kinetic energy decay.

11. **Region width as the local stiffness control (Fig. 4)**
    - Area: realism
    - Change: once Candidates 5–6 exist, give cabin/cell/roof regions a wider $w$ (more summation nodes) and crumple zones a narrow one. Shrink `clusterBeta`'s role (`:1697-1704`) to the elastic β only.
    - Expected effect: a stiff safety cell and soft crumple zones expressed geometrically, with no per-contact β hacks.
    - Cost: M
    - Risk: medium (retune)
    - Verify: `npm run test:game`; throwaway cabin-intrusion vs crumple-travel sweep.

## Not applicable / caveats

- **Shells are out of scope for the paper, and a car is mostly shell.** The authors state the model needs volumetric sampling. An octree over sheet metal produces one-cell-thick layers, and a region inside a single layer is **coplanar**: the same rank-deficient $\mathbf{A}$ that makes today's 3-particle clusters fall back to $\mathbf{R}=\mathbf{I}$. Refinement must keep ≥ 2 cells through the thickness, i.e. sample the crash structure (rails, sills, engine bay, bumper beams) as a thick layer of ~0.15–0.25 m, which is effectively what `MASS_SPECS` does. Panel buckling stays a skin effect (wrinkle at `streamed-deform.ts:2213-2223`), not an octree outcome.
- **Runtime cutting, visibility-graph updates and Bucket-Moore at runtime are unnecessary.** Topology is fixed apart from a few detach states (`frontDetached`/`rearDetached`, popped hubs), so everything can be precomputed (Candidate 6). The paper's 62–124 ms resample and 121 ms LOD-event costs are what precomputation avoids. Paying them at runtime would be a multi-frame hitch.
- **Flood-fill distance field + spatial-hash self-collision** has no counterpart need yet. Cabin intrusion is handled by `foldCabin` (`:1820-1843`) and the roof clamp in `skin` (`:2240-2242`).
- **Stiffness depends on resolution.** Shape-matching information travels about one region width per iteration. If refined regions keep the same *cell* count rather than the same *metric* width, refined areas get visibly softer than their L0 neighbours under the same `iters` (`:1729`) `[INFERENCE]`. Keep $w$ fixed in metres (D1). The ε band means a ±50 % stiffness variance is built in.
- **The paper has no α, no iterations, and no plastic update rule** (it defers to [MHTG05]). This repo's `goalAlpha`, `stiffnessIters`, step clamp and `applyPlasticity` rules are outside the paper and have to be re-validated after any region change.
- **Paper timings do not transfer.** They come from a P4 running unoptimized C++ (≈ 6–7 µs/node·step). JS here is ≈ 0.5–0.6 µs per region evaluation, but the repo runs ≈ 12 evaluations per region per frame. Per-frame cost per region (7.2–14.4 µs) is therefore similar in magnitude only by coincidence.
- **Damage pins refinement.** The "+6 % nodes" result assumes most objects return to coarse. Plastically non-uniform dents cannot coarsen without losing detail (D2), so wrecked cars keep their refined nodes. Idle cars cost no solver time (live gate), but they still cost memory and `collideWith` work. That makes the per-car cap mandatory.
- **Mass weighting cuts both ways.** The paper weights by the owning node's $m_r$. With today's cage-owned clusters there is no owning node, so use $M_r$. With masses spanning 8–260 kg, Eq. 8 can make crumple particles shared with the cell almost rigid. Tune before adopting wholesale.
- **Deform cost (7–15 ms at 24 cars) is not particle-bound.** `skin` is O(V·4) plus `computeVertexNormals` (`:2261`). Particle LoD will not recover that budget. Vertex/skin LoD is a separate problem the paper does not address beyond "surface animation took 4 ms per flower".
