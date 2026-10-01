# HPBD (Müller 2008) — analysis for the crash-deformer rig

Source rewrite: `hpbd.md`. Code line numbers are from the working tree snapshot `streamed-deform.ts#4AB5`, `shape-match-core.js#5131`, `rig-spec.ts#1D89`, `engine.ts#4DF9` (2026-10-01). `streamed-deform.ts` is being split by a sibling lane while this was written (rig tables already moved to `rig-spec.ts`), so re-grep the symbol name if a line has drifted.

## Summary

- **Core idea:** keep PBD's local, non-linear, inequality-friendly Gauss-Seidel projection, but run it on a *fixed* hierarchy of particle subsets, coarsest level first; after each coarse solve, push only the coarse particles' **corrections** $\mathbf{p}_j - \mathbf{q}_j$ down to their children with fixed weights (Eq. 7). Stiffness that takes ~20 flat iterations is reached with 1 sweep down the hierarchy + 2 fine iterations.
- **Hierarchy shape:** level $l+1$ is a *proper subset* of level $l$ (no new particles are invented); every fine particle has $\ge k$ parents ($k = 2$ used) on the next coarser level; parent weights from rest-pose distances (Eq. 6), normalised, exact when a child coincides with a parent.
- **Constraint coarsening:** distance constraints are restricted by edge-collapsing each removed particle into the coarse neighbour nearest the average of its coarse neighbours; new rest length = sum of the two collapsed rest lengths (geodesic, does not bridge cuts) or original-pose distance (bridges cuts, too tight on curved shapes). Triangle meshes stay triangle meshes on all levels.
- **Inequalities across levels:** cardinality-1 constraints (collisions, attachments) live on the particle and are projected on *every* level that contains the particle; coarse-level distance constraints are made **unilateral upper limits**, so they only bite when the material between them is fully stretched and never fight fine detail.
- **Why it matters here:** this is the cleanest published recipe for "a coarse structural layer (our 20 named masses) drives an embedded fine layer that keeps its own persistent state" — exactly the step needed to go from 20 particles to N without losing the named roles that pose, hulls and drivetrain depend on.
- **Today's rig is the opposite flavour:** the fine surface is driven **absolutely** (each frame every vertex is rebuilt from rest × blended cluster transforms in `skin`), so there is no persistent fine state and dent detail must be faked (hash wrinkle). HPBD's correction-only prolongation is what lets fine dents persist under a coarse solve.
- **Numbers:** 11,500-triangle cloth at 60 fps (Core2 2.66 GHz, 2008) with multigrid + 2 symmetric GS iterations; flat PBD needs ~20 iterations for equal stiffness and drops to ~12 fps (≈5× slower). Total constraint count of all coarse levels < level 0, so the hierarchy costs less than one extra fine iteration.
- **Limits:** the hierarchy is static (the paper explicitly avoids adaptive refinement to avoid popping); only distance constraints are restricted (no shape-matching clusters, no plasticity, no bending on coarse levels); one V-sweep down only; sequential; tearing handled conservatively by deleting parent links up the hierarchy.
- **LoD hook the paper does give:** because every level is a valid mesh, "far objects can be simulated and rendered with coarse levels only". Combined with "coarse always runs, fine is optional", runtime LoD becomes *activating/deactivating the fine level per car (or per region)* rather than re-meshing.

## Useful content

**Per-constraint projection (Eqs. 4–5)** — what every fine-level distance/contact constraint would use:

$$
\Delta\mathbf{p}_i = -\frac{C(\mathbf{p})}{\sum_j w_j |\nabla_{\mathbf{p}_j} C|^2}\, w_i \nabla_{\mathbf{p}_i} C, \qquad w_i = 1/m_i .
$$

For a distance constraint $C = |\mathbf{p}_a - \mathbf{p}_b| - d$: $\Delta\mathbf{p}_a = -\frac{w_a}{w_a + w_b} C\,\hat{\mathbf{n}}$, $\Delta\mathbf{p}_b = +\frac{w_b}{w_a + w_b} C\,\hat{\mathbf{n}}$. Unilateral: skip when $C \ge 0$ (or $\le 0$ for upper-limit form).

**Parent weights (Eq. 6, [reconstructed])**:

$$
\tilde w_{ij} = \Big(\tfrac{d_{ij}}{\max_j d_{ij}} + \varepsilon\Big)^{-1}, \qquad w_{ij} = \tilde w_{ij} \Big/ \sum_j \tilde w_{ij},
$$

$d_{ij}$ measured in the rest pose; computed once; child coincident with a parent ⇒ weight ≈ 1 for that parent.

**Prolongation of corrections (Eq. 7)** — the key line:

$$
\mathbf{p}_i \leftarrow \mathbf{p}_i + \sum_{j \in \mathcal{P}(i)} w_{ij}\, (\mathbf{p}_j - \mathbf{q}_j), \qquad \mathbf{q}_j = \text{parent position saved before the coarse solve}.
$$

Only the *delta* is transferred, so whatever the fine particle already had (plastic dent, wrinkle) survives the coarse solve.

**Solver schedule (Sec. 7 + Sec. 9)** for one step:

```text
save q_j for coarse particles
coarse solve: 1+ GS iterations of coarse constraints + all cardinality-1 (contacts) of coarse particles
prolongate: fine p_i += Σ w_ij (p_j - q_j)
fine solve: 2 GS iterations of level-0 constraints + contacts; 2nd iteration in REVERSE order (symmetric)
v = (p - x)/dt ; x = p
```

**Coarsening algorithm (Sec. 6.2)**, $k = 2$: mark all coarse; demote a particle to fine iff it keeps $\ge k$ coarse neighbours and no fine neighbour drops to $< k$. Keep "attached"/important particles coarse by processing them last (or demoting with low probability). For us: *never* demote the 20 named masses → they become the coarsest level automatically.

**Constraint restriction (Sec. 6.3)**: collapse each fine particle into the coarse neighbour closest to the average of its coarse neighbours (even edge lengths); new rest length $d_{kj} = d_{ki} + d_{ij}$ (geodesic) or $|\mathbf{x}^0_k - \mathbf{x}^0_j|$ (original pose).

**Unilateral coarse constraints (Sec. 8)**: on levels $\ge 1$, $C = d_{kj} - |\mathbf{p}_k - \mathbf{p}_j| \ge 0$ — coarse constraints only stop over-stretch; they never resist compression. For a crash body the mirror-image also makes sense (coarse lower limit = crush stop; see candidates).

**Tearing (Sec. 8)**: on split, delete the particle's parent links and adjacent constraints, then walk up parent links and delete coarse constraints/parent links touching the split region (conservative; weakens around the tear).

**Practical tricks**: symmetric GS (forward then reverse order) for level 0; iteration count 3–4 on level 0 if the hierarchy meshes are poor; regular base meshes can build the hierarchy directly by subsampling; hierarchy overhead < 1 fine iteration.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Coarsest level = small set of structural particles | `src/game/rig-spec.ts:118 MASS_SPECS` (20 named masses) | variant | These *are* a natural coarse level. Unlike HPBD they are not a subset of a finer mesh (engine/cell/tank are interior points), so "parents" must be embedding links, not shared mesh edges. |
| Level-0 (fine) particle set | — | missing | Would be built in `src/game/streamed-deform.ts:214 constructor` right after clusters (`:388-413`) from the body `restPos`; car body ≈1.2k verts is level-0 *render* geometry, not simulated. |
| Coarse cardinality-n constraints | `rig-spec.ts:142 BEAM_SPECS`, `rig-spec.ts:192 EXTRA_CLUSTERS`, `streamed-deform.ts:454 cageClusterIndices` | variant | Hand-authored coarse constraints (beams, 22 SM clusters) instead of HPBD's automatic edge-collapse restriction. |
| Particle restriction (vertex cover, $k=2$ parents) | `streamed-deform.ts:454 cageClusterIndices` | missing | No automatic coarsening. For a fine layer, use the Sec. 6.2 sweep with the 20 names pinned "coarse" (process last / never demote). |
| Constraint restriction / rest length ($d_{ki}+d_{ij}$ vs original pose) | `shape-match-core.js:242 makeCluster` (q0 from rest pose); `streamed-deform.ts:214 constructor` beam `rest = distanceTo` | variant | Everything uses original-pose rest distances, i.e. the paper's "bridges cuts" option. Correct for a closed rigid body shell; wrong after a panel detaches (see tearing). |
| Non-linear GS projection (Eqs. 4–5), mass-weighted | `streamed-deform.ts:1663 stepBeams` (`len > beam.rest * maxStretch` → split by `ima/inv`); `streamed-deform.ts:2267 sphereHit` (`:2284-2286`) | same | Both are textbook PBD distance projections with $w_i = 1/m_i$. Reusable verbatim as the fine-level kernel. |
| Unilateral upper-limit coarse constraint (Sec. 8) | `streamed-deform.ts:1663 stepBeams` maxStretch; `:1687 beam.plastic = Math.max(minLen, …)` | variant | Coarse beams already have a hard stretch cap (unilateral) and a crush floor `minLen`; the paper's rule "coarse constraints only bite at the limit" is exactly this pattern. |
| Solver loop: predict → project → $v=(p-x)/\Delta t$ (Sec. 3) | `streamed-deform.ts:1856 stepMassSlice` → `:1706 stepShapeMatch` (`p.x += ax` at `:1782`), integration `:1881` | contradicts | Shape-match corrections are applied *before* integration and never written into velocity (`p.vx` untouched; `writeShapeToMasses` `:566` copies old `vel`). Paper: velocity update from corrections is "essential" for second-order behaviour. Here corrections act as first-order creep. |
| GS per-constraint ordering / symmetric reverse sweep | `streamed-deform.ts:1737-1751` (goal accumulate, `cw = 1`, `goalW`) | variant | Coarse SM is **Jacobi** (all clusters vote, average, apply with α). Ordering-independent, so the reverse-sweep trick is moot on the coarse level; it applies to a future fine GS layer. |
| Flat iteration count vs hierarchy | `shape-match-core.js:502 stiffnessIters` (2–5), `streamed-deform.ts:1729 iters` | variant | Stiffness is bought with iterations on one level only; plus a per-iteration step clamp `0.14 m` (`:1778`). HPBD's lesson: with ≥2 levels, 2 fine iterations suffice. |
| Parent pointers + weights (Eq. 6) | `streamed-deform.ts:416 buildSkinWeights` (`exp(-2.35 d)`, top-4, normalised); `:2003 solveCagesFromShape` (same kernel for cage corners) | variant | Same structure (precomputed parents + normalised weights from rest distance) but parents are *clusters*, weights exponential, and not exact at coincidence. |
| Prolongation of **corrections** (Eq. 7) | `streamed-deform.ts:2163 skin` (`:2182 transformSkinPointInto`), `shape-match-core.js:428 transformSkinPointInto` | contradicts | Skin maps rest → current **absolutely** every frame (no persistent fine state). Paper transfers only $\mathbf{p}_j-\mathbf{q}_j$, so fine detail survives coarse solves. Today dent detail is synthesised (`:2218` hash `wave`) and capped (`:2224-2225 extraCap`). |
| Coarse-level plastic state | `shape-match-core.js:345 applyPlasticity` (Sp, q0 rotation); `streamed-deform.ts:1814` call | missing (in paper) | HPBD has no plasticity; our coarse Sp stays as is and the fine level would carry its own plastic rest lengths + offsets. |
| Cardinality-1 constraints on every level (collisions) | `streamed-deform.ts:1133 feedOverlap`, `:931 collideWith`, `:2267 sphereHit` | missing (fine) | Contacts exist only on the 20 masses (radii 0.26–0.5 m). A fine level would also take a per-particle contact constraint at the impact plane/point. |
| Rotation extraction for coarse frames | `shape-match-core.js:102 m3Polar`, `:311 matchCluster` | missing (in paper) | HPBD needs none (distance constraints). Our coarse clusters give $R_c$ per region, which lets us store fine plastic offsets in a rotating local frame (state transfer). |
| Tearing: delete parent links up the hierarchy | `streamed-deform.ts:1652` (`beam.alive = false` at 2.2× rest) | variant | Beam break exists on the coarse level only; no child links to invalidate yet. A fine layer must drop parent links to any mass on the far side of a broken beam/detached part. |
| LoD: far objects use coarse level only | `streamed-deform.ts:1857 stepMassSlice` (`live = … quietTime() < 0.35`) | variant | Today's only "LoD" is temporal (sleep when quiet), not spatial/screen-size. |
| Time-step / slice count | `streamed-deform.ts:963` (`slices = round(dt*240)` 1–4), `src/game/engine.ts:1195 fixedStep` (`slices` 1–3) | variant | HPBD stiffness is still iteration- and dt-dependent (pure PBD). It does not fix the known "crush depends on slice count" issue. |

## Particle density & LoD design input

### Shape of the hierarchy (20 → N)

HPBD's contract is: the coarse level is solved first by *whatever* solver it uses, its particles' positions are saved before ($\mathbf{q}_j$) and after ($\mathbf{p}_j$), and each finer particle receives $\sum_j w_{ij}(\mathbf{p}_j-\mathbf{q}_j)$, then runs a couple of cheap local GS iterations of its own constraints and contacts. Nothing in Eq. 7 requires the coarse solver to be PBD distance constraints, so our existing coarse layer (20 named masses, beams, 22 SM clusters, plastic Sp) stays **unchanged** and keeps feeding pose (`followGroup`), hulls (`liveHulls`) and drivetrain. Proposed levels:

| Level | Particles / car | Constraints | Parents | Role |
|---|---|---|---|---|
| L2 (coarsest, always on) | 20 named masses | beams + 22 SM clusters + Sp (today) | — | vehicle dynamics, contact force, pose, hulls |
| L1 (optional, medium LoD) | ~60–100 | plastic distance edges, $k=2$ parents in L2 | 2–3 named masses | regional crumple shape (bonnet arch, door bow) |
| L0 (fine, contact LoD) | ~128–256 surface particles | plastic distance edges (surface triangulation, E≈3V) + per-particle tether + contact | $k=2$–$3$ in L1 (or L2 if no L1) | dents, folds, panel gaps; drives the render skin |

- Build L0 offline by decimating the body render mesh (≈1.2k verts) to 128–256 vertices; build L1 from L0 with the Sec. 6.2 sweep ($k=2$) and edge-collapse restriction (Sec. 6.3, original-pose rest lengths since the shell is closed and curved — **not** the geodesic sum, which is too loose on a 3-D box).
- Parent links from a fine particle to the coarse level: HPBD's "connected by a constraint" rule cannot be used directly because named masses are interior points. Use $k=3$ nearest named masses on the same side (reuse the side filter of `cageClusterIndices` and the `ry > 1.02 && cm.y < 0.78` roof rule of `buildSkinWeights`) with Eq. 6 weights.
- Render vertices embed in L0 (3–4 nearest L0 particles, barycentric/Eq. 6 weights, rotation from the dominant coarse cluster's `skinM`) instead of directly in the 22 clusters. Cost per vertex ≈ today's `transformSkinPointInto` blend, so `deform` time is roughly flat [INFERENCE].
- One-way coupling (coarse → fine) as in the paper: fine contacts never push the coarse masses; coarse contact handling (`feedOverlap`/`collideWith`) already carries momentum. This keeps the fine layer visual-plus-local and makes LoD switching invisible to vehicle dynamics.
- Fine constraints the paper does not have but a car needs: (a) **plastic edges** — on compression beyond yield, shrink rest length (copy the `beam.plastic` rule at `streamed-deform.ts:1687`); (b) a **tether** cardinality-1 constraint per particle, $|\mathbf{p}_i - \hat{\mathbf{p}}_i| \le r_i$ with $\hat{\mathbf{p}}_i = \sum_c w_{ic} T_c(\bar{\mathbf{x}}_i + \boldsymbol\delta_i)$ (embedded rest + stored plastic offset); when exceeded, the excess is moved into $\boldsymbol\delta_i$ (plastic yield). This stands in for bending stiffness, which HPBD deliberately omits and sheet metal needs.

### State transfer when refining / coarsening at runtime

HPBD itself keeps the hierarchy static and warns that adaptive refinement causes artifacts; the scheme below avoids topology changes entirely by keeping all levels allocated and only switching *which levels are integrated*.

- **Persistent per-fine-particle state (never discarded):** plastic offset $\boldsymbol\delta_i$ stored in the local frame of its dominant coarse cluster (rotate by $R_c^T$, `matchCluster` already gives $R_c$); plastic rest lengths of its edges; alive flags of parent links.
- **Coarsen (deactivate L0/L1 for a car or region):** compute $\boldsymbol\delta_i = R_c^T(\mathbf{p}_i - T_c(\bar{\mathbf{x}}_i))$, freeze. While inactive, particle positions are evaluated kinematically $\mathbf{p}_i = \sum_c w_{ic}T_c(\bar{\mathbf{x}}_i + \boldsymbol\delta_i)$ — i.e. exactly today's skinning plus a baked dent — so the visible shape does not pop. Coarse state is untouched because the coarse level never stopped.
- **Refine (activate):** positions from the same kinematic formula (continuity guaranteed); velocities $\mathbf{v}_i = \sum_j w_{ij}\mathbf{v}_j$ from parents; rest lengths from the persistent arrays. From then on, Eq. 7 prolongates per-step **deltas** only. Do not use a stale $\mathbf{q}_j$ from the time of deactivation — that delta includes rigid motion and LBS-style collapse; re-embed instead.
- **Rotations / Sp:** fine distance constraints carry no rotation; if fine SM clusters are ever used, initialise $R$ and $S_p$ from the parent cluster so inherited plastic strain matches. No upward restriction of fine plastic state into coarse $S_p$ is needed (paper is one-way; coarse already integrates the impact).
- **Frame:** run L0 in car-local coordinates (as `skinLocal`/`m.local` already are). Shape particles are world-space (`syncShapeFromMasses` `:553`), so per-step coarse deltas include rigid motion; converting $\mathbf{p}_j-\mathbf{q}_j$ to local before prolongation removes that term.
- **Region boundary:** inactive fine particles next to active ones are treated as kinematic ($w_i = 0$) — HPBD's cardinality-1 "attachment" case.

### Refinement criteria (not in the paper — derived for this rig)

1. **Contact:** `feedOverlap` / `collideWith` touched the car this frame, or predicted contact within ~0.2 s (closing speed × gap). Activate fine particles within ~0.8 m of `impactLocal` (the same radius `skin` already uses for wrinkles).
2. **Strain:** a cluster's $\|S - I\|_F$ above the `applyPlasticity` yield (`shape-match-core.js:347`) → activate that cluster's fine particles + one ring.
3. **Damage history:** $\|S_p - I\|_F$ or `beam.plastic / beam.rest < 0.9` — keeps already-crumpled regions refined while still moving.
4. **Screen size:** projected bounding-sphere radius < ~60 px → coarse only (paper: far objects use coarse levels for simulation *and* visualisation). The chase/driven car always qualifies.
5. **Hysteresis:** deactivate after `quietTime() > ~0.5 s` (today's `live` gate uses 0.35 s) and only when criteria 1–3 are all false.

### Costs

From the paper (Core2 2.66 GHz, C++, 2008): 11,500 triangles ≈ 17k distance constraints [INFERENCE: $E \approx 1.5T$]; 2 iterations + multigrid = 60 fps; flat 20 iterations ≈ 12 fps. 18 extra iterations ≈ 83 − 17 = 66 ms ⇒ ≈ 3.7 ms per iteration ⇒ **≈ 0.2 µs per distance projection** including memory traffic on 2008 hardware. Whole hierarchy < one level-0 iteration.

Model for our fine level in JS (Float64Array SoA; **assumed** 30–50 ns per projection on a modern JIT — must be microbenchmarked, Candidate 1):

- per fine particle per slice: 3 surface edges + 1 tether ≈ 4 constraints × 2 iterations = 8 projections ≈ 0.3 µs; prolongation ($k=3$) + velocity update ≈ 0.03 µs ⇒ ≈ 0.33 µs/slice;
- slices per frame 2–4 (`streamed-deform.ts:963`) ⇒ **≈ 0.7–1.3 µs per active fine particle per frame**; plan with **1 µs**.
- Compare coarse SM today: 22 clusters × 0.5–2.4 µs × 2–5 iters × 1–4 slices ≈ 0.02–1 ms per car per frame. A fine SM-cluster level (one cluster per fine particle) would cost ≈ 1.5 µs × 2 × slices ≈ 6–12 µs per particle — 10× the distance-constraint layer, so keep shape matching on the coarse level only.

### Recommended budget per car

Measured today at 24 cars: sim ≈ 10 ms + deform ≈ 7–15 ms = 17–25 ms, already over a 16.7 ms frame. The fine level must therefore be (a) confined to *active* cars by LoD and (b) capped by a global pool. Allocate **≈ 2 ms/frame** to fine physics ⇒ pool ≈ 2,000 fine particle-updates per frame at 1 µs.

| Cars | Active (fine) cars, cap | L0 per active car | L1 per medium car | Fine cost | Note |
|---|---|---|---|---|---|
| 10 | all 10 | 192 | — | 10 × 192 × 1 µs ≈ 1.9 ms | fits if deform stays flat |
| 16 | 8 | 192 | 64 for the rest | 1.5 + 0.5 ≈ 2.0 ms | |
| 24 | 6 | 160 | 48 for ~6 near cars | 0.96 + 0.29 ≈ 1.25 ms | only affordable together with deform savings for quiet/far cars |
| 32 | 4 | 128 | 32–48 for ~6 near cars | 0.51 + 0.29 ≈ 0.8 ms | coarse-only beyond that |

Recommendation: **20 coarse (always) + L0 128–256 for contact/strain-active cars, L1 32–96 for near-but-quiet damaged cars, 0 extra for far/undamaged cars; global pool ≈ 2k fine particles.** Raising the *coarse* count above 20 is not what HPBD suggests and would multiply the expensive SM-cluster cost; density should go into the cheap fine layer.

## Candidates to implement

1. **Fine-layer kernel microbenchmark** — area: tooling.
   - Change: add a case to `scripts/bench-physics.mjs` (`npm run bench`) that projects plastic distance edges + tethers on a 256-particle synthetic shell (Float64Array SoA, 2 symmetric GS iterations, 4 slices), next to the existing `matchCluster` timing.
   - Effect: replaces the assumed 30–50 ns per projection / 1 µs per particle-frame with a measured number before any rig work; fixes the per-car budget table.
   - Cost: S. Risk: none (bench only).
   - Verify: `npm run bench` prints ns/projection and µs/particle-frame; repeat 3× for variance.

2. **Embedded L0 surface layer with correction-only prolongation (HPBD Eq. 6/7) driving the skin** — area: realism / visual quality.
   - Change: in `src/game/streamed-deform.ts` `StreamedDeformation` constructor (after `:412`), build 128–256 L0 particles from a decimated body `restPos`, surface edges, $k=3$ parent links to named masses with Eq. 6 weights. New `stepFineLayer(dt)` called from `stepMassSlice` (`:1856`) after the coarse step: save $\mathbf{q}_j$ before `stepShapeMatch`, prolongate local-frame deltas, 2 symmetric GS iterations of plastic edges (reuse `stepBeams` `:1663` projection / `beam.plastic` `:1687` yield) + tether with plastic offset $\boldsymbol\delta_i$ + per-particle contact at the impact plane, then $v=(p-x)/\Delta t$. `skin` (`:2163`) embeds vertices in L0 instead of `skinWeights` clusters; drop the hash wrinkle (`:2218`) once real folds exist.
   - Effect: persistent, localized dents and folds at contact (detail scale ≈ fine edge length ~0.25 m instead of ~1 m clusters); dents no longer rebuilt from a 22-cluster blend each frame; coarse vehicle dynamics untouched (one-way coupling).
   - Cost: L. Risk: medium — tether/plastic tuning, panel self-intersection, skin seams between L0 regions.
   - Verify: new `src/game/*.test.ts` case: after a contact pushes L0 particles in and the coarse rig relaxes back to rest, the L0 dent depth stays > 0 (fails with today's absolute skin); `npm run test:game`; `npm run bench`; `node scripts/bench-browser.mjs --cars 2,10,24` deform+physics buckets.

3. **Per-car fine-layer LoD with global pool and stateful switch** — area: performance.
   - Change: in `src/game/engine.ts` `CrashEngine.fixedStep` (`:1160`) rank cars by criteria (contact this frame, cluster strain > `applyPlasticity` yield, damage, screen radius, driven car) and set `fineActive` on `StreamedDeformation`; coarsen = bake $\boldsymbol\delta_i$ in cluster-local frame, refine = kinematic re-embed + parent-velocity interpolation (see design section). Cap total active L0 particles ≈ 2k.
   - Effect: fine detail where visible/damaged, ~0 extra cost for the rest; cost grows with active cars, not car count.
   - Cost: M (after #2). Risk: low–medium — popping if bake/re-embed formulas disagree.
   - Verify: test that coarsen→refine round-trip leaves every L0 position unchanged (≤ 1e-6 m); `node scripts/bench-browser.mjs --cars 10,16,24,32 --modes fleet,derby` physics bucket stays within +2 ms at 24 cars.

4. **Regional (per-cluster) activation inside a car** — area: performance.
   - Change: in `stepFineLayer`, active set = L0 particles whose dominant cluster is strained/contacted + one ring; inactive neighbours are kinematic ($w=0$) and evaluated by the bake formula.
   - Effect: frontal hit only pays for the nose (~30–40 % of L0), roughly 2–3× more active cars per budget.
   - Cost: M. Risk: medium — seams at the active/kinematic boundary under large strain.
   - Verify: `npm run bench` fine-layer case with 30 % active; visual check of boundary in browser at 35 and 62 km/h wall hits.

5. **Invalidate fine parent links on beam break / part detach (HPBD tearing)** — area: correctness.
   - Change: where `stepBeams` sets `beam.alive = false` (`:1652`) and on bumper/hub detach, remove L0 parent links to masses on the far side and renormalise remaining $w_{ij}$; delete L0 edges crossing the break.
   - Effect: no "ghost" pulling of a detached panel's skin back toward the car (the paper's ghost-influence-across-cut issue).
   - Cost: S (after #2). Risk: low.
   - Verify: test: after breaking the `bumperFL–bumperFR` beam, no L0 particle on the bumper keeps a parent in the cabin set; `npm run test:game`.

6. **Write shape-match corrections into velocity (PBD Sec. 3)** — area: correctness / stability.
   - Change: `stepShapeMatch` (`:1782`): `p.vx += ax / dt` (same y/z), so `writeShapeToMasses` (`:566`) carries the correction; possibly damp.
   - Effect: second-order response (springback, ringing) instead of first-order creep; may reduce slice-count dependence of crush depth slightly, but not remove it.
   - Cost: S code, M retune. Risk: high — every crash tuning constant assumes today's creep; energy injection near contact.
   - Verify: `npm run test:game` crash-depth tests at 1/2/4 slices; compare crush depth vs `dt` before/after; `npm run bench`.

7. **Eq. 6 normalised inverse-relative-distance weights for skin/cage parents** — area: visual quality.
   - Change: `buildSkinWeights` (`:416`) and `solveCagesFromShape` (`:2003`) replace `exp(-2.35 d)` with Eq. 6.
   - Effect: vertices/corners near a cluster centre follow it exactly; less smearing between neighbouring clusters. Minor.
   - Cost: S. Risk: low–medium — sharper transitions may show seams with today's coarse 22 clusters.
   - Verify: `npm run test:game`; side-by-side screenshot in browser after a 50 km/h corner hit.

## Not applicable / caveats

- **Cloth and distance constraints only.** HPBD restricts distance constraints; it says nothing about shape-matching clusters, rotations, plastic $S_p$ or volume. Our coarse solver stays as is; HPBD only contributes the *coarse→fine coupling* and the fine-level kernel.
- **Static hierarchy by design.** The paper rejects adaptive refinement to avoid artifacts. Runtime LoD here is our extension; it is safe only because no topology changes — all levels stay allocated, only integration is switched.
- **Proper-subset property does not hold** for the 20 named masses (interior points, not surface vertices). Parents must be embedding links; the vertex-cover coarsening is only useful *within* the fine layer (L0→L1).
- **Convergence gain is smaller for us.** HPBD's 5× win comes from long propagation paths (126-row cloth). A car's fine shell is ~10–15 particles across, already driven by coarse corrections; the main value is *persistent local detail*, not stiffness. [INFERENCE]
- **Does not fix time-step dependence.** Stiffness in HPBD still depends on iteration count and $\Delta t$; the known "crush depends on slice count" problem (`streamed-deform.ts:963`, `engine.ts:1195`) needs a compliance formulation (XPBD), not a hierarchy.
- **Jacobi coarse solve.** Our coarse SM averages cluster goals (`:1737-1751`), so the paper's symmetric forward/reverse GS ordering only applies to a new fine GS layer.
- **Upper-limit coarse constraints are a cloth idea.** For crashes the dominant mode is compression; the mirror image (coarse crush floor `minLen`) already exists in `stepBeams`.
- **No bending on coarse levels; sheet metal needs it.** A distance-only fine shell folds freely; the tether-with-plastic-offset constraint (design section) is our stand-in and is not from the paper.
- **Does not address the known 3-particle coplanar clusters** (10 of 22 → $R = I$ fallback). A fine layer could make coarse clusters full-rank if fine particles were added to cluster sums, but that is denser shape matching, not HPBD, and raises `matchCluster` cost linearly.
- **One-way coupling.** Fine contacts do not feed back into vehicle dynamics; a fine-only contact (e.g. a pole between two coarse masses) will not slow the car unless the coarse spheres also hit it.
