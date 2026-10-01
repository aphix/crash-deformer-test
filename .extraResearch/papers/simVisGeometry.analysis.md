# Simulating Visual Geometry (Müller, Chentanez, Macklin — MIG 2016): analysis for crash-deformer-test

## Summary

- The paper simulates the render mesh almost directly. Each visual face is extruded by a user thickness along −normal into a convex polyhedron. Every touching or overlapping pair of polyhedra is linked, and the graph is simulated as oriented particles, with one shape-matching group per primitive plus its 1-ring. There is no separate cage or skeleton.
- Primitives are deformed by the local affine matrix $\mathbf D=\mathbf A\bar{\mathbf A}^{-1}$ (Eqs. 1–3). The map is linear, so primitives stay convex and SAT/fracture still work. In their notation $\bar{\mathbf A}$ is our $A_{qq}$ plus a per-particle term $\tfrac15 m_i r_i^2\mathbf I$, and $\mathbf A$ is our $A_{pq}$ plus $\tfrac15 m_i r_i^2\mathbf R_i$. That gives a physically sized, rotation-consistent regularizer. We use `+1e-3` instead.
- **Cost model.** A plastic (car) body is one rigid body between hits. Only a hit whose relative normal velocity exceeds a material threshold triggers a local **quasi-static** relax of the primitives. The touched primitive moves by $v_n\,\Delta t$ in the body's local frame, and primitives that intersect joint boxes stay pinned. For the 16–17k-primitive car this costs 1–10 ms per hit on one 3.1 GHz CPU core, and the car runs at >60–100 fps between hits.
- **Watertight visual mesh.** Each primitive vertex carries a body-global id (the source mesh vertex index). Positions are averaged per id (scatter, then gather). Fracture runs in rest space, where ids are regrouped by sorting rest positions. Tearing splits ids by flood fill over live links.
- **Local detail without dense authoring.** Applying a fracture pattern *without* separating the pieces subdivides the mesh near the impact. Door wings that start with 8 faces each gain ≈1k primitives on their first hit, which gives small-scale dents where they are needed.
- **Collision** is 3-stage: object-bounds SAP, then a primitive SAP restricted to the overlap box, then SAT. With many primitives, collision is the bottleneck.
- **Our rig vs. theirs.** We have 20 point particles (no orientation) and 22 clusters. Rendering is a top-4 blend of per-cluster affine transforms over the 1212-vertex chassis, plus trilinear cages for panels and a procedural accordion. Our dents can be no finer than the cluster footprint (≈0.4–1.4 m), which is exactly the gap the paper fills.
- **Full replacement is not viable** on our budget. One primitive per chassis triangle is 1712 per car, or ≈41k for 24 cars, in JS, inside a ≈10 ms sim budget, while derbies produce many hits at once. **Augmenting** is viable. A rest-space dent layer on the welded render mesh, relaxed quasi-statically only on hit frames, would ride on top of the 20-particle crumple (Candidate 3).
- Probing the actual mesh turned up two cheap correctness wins: (a) our wrinkle noise is indexed by vertex number, which breaks the paper's "co-located vertices move together" invariant on 182 co-located groups; (b) one of our 4-particle clusters is almost exactly planar, with $A_{qq}$ eigenvalue $10^{-4}$ against a $10^{-3}$ regularizer. Eq. 3's radius term (≈2.8) fixes (b).

## Useful content

**Eq. 1–3: affine deformation with oriented/radius terms**

$$\mathbf A=\sum_i\big(\tfrac15 m_i r_i^2\mathbf R_i+m_i\mathbf x_i\bar{\mathbf x}_i^T\big)-M\mathbf c\bar{\mathbf c}^T,\quad
\bar{\mathbf A}=\sum_i\big(\tfrac15 m_i r_i^2\mathbf I+m_i\bar{\mathbf x}_i\bar{\mathbf x}_i^T\big)-M\bar{\mathbf c}\bar{\mathbf c}^T,\quad
\mathbf D=\mathbf A\bar{\mathbf A}^{-1}$$

(The $\tfrac15 r_i^2$ factor is reconstructed from MC11 and Eq. 3.)
- With no per-particle orientation, set $\mathbf R_i:=\mathbf R_{\text{cluster,prev}}$. An undeformed, rigidly rotated cluster then gives $\mathbf D=\mathbf R$ exactly, so the extra term never biases a rigid motion. It only fills degenerate directions with the previous rotation.
- Compute $\mathbf D$ once per step, before collision. Do not recompute it every iteration.
- A linear $\mathbf D$ keeps primitives convex, so you can deform collision proxies with the same matrix.

**Plastic impact scheme (§3.5)**
- Treat the body as rigid until $|v_n|>\theta_{\text{material}}$.
- Offset = $v_n\,\Delta t$ (not overlap/dt), expressed in the body's local frame and applied to the touched primitive's *rest/local* position.
- Run a quasi-static shape-matching relax with joint-box primitives pinned.
- Recompute COM and inertia afterwards.

**Visual mesh (§3.4)**
- Global id per vertex. Positions are averaged per id each frame (O(V)).
- Ids come from the source mesh's vertex index. Extruded back faces copy the connectivity, so the shell stays closed.
- **Invariant:** vertices that coincide in rest space must receive the same displacement.

**Rest-space topology edits (§3.6)**
- Always cut and subdivide in the undeformed configuration.
- Regroup ids by sorting rest positions on one axis and merging equal positions.
- Links break when $\lVert\mathbf x_a-\mathbf x_b\rVert>\varepsilon_{\max}\cdot$ rest length. Only pattern-created links can break, so authored tear lines are possible.
- id split: flood-fill over live links. If the visited count is below `val(id)`, mint a new id.

**Joints as volumes**
- A joint box acts both as a boundary condition (pinned primitives) and as the rule for re-attaching after fracture (any new piece that intersects the box inherits the joint).

**Numbers**

| Scene | Size | Time / rate |
|---|---|---|
| Car | 21 objects, 28 joints, 16k primitives, 20 rigid parts | >60 fps (>100 quoted); 1–10 ms per deforming hit |
| Door | 700 primitives; +≈1k per first hit | >100 fps |
| Monster truck | 45k primitives, 2.5k per soft tire | 30 fps |
| Bridge scene | — | 20 fps |

All of these ran single-core and serial.

**Future-work hint.** Sub-threshold features should go to normal maps rather than the physical mesh. For us this supports keeping fine crease detail in shading or a procedural layer.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Simulation primitives derived from visual faces | `src/game/streamed-deform.ts:156` `MASS_SPECS` (20 hand-placed masses) | contradicts | Our control particles are authored, not derived from the mesh. Paper: one primitive per face. |
| Per-particle radius $r_i$ | `streamed-deform.ts:153` `MassSpec.radius`; `streamed-deform.ts:519-527` `shapeParticles` (no radius copied); `src/game/shape-match.ts:9` `ShapeParticle` (no radius field) | missing (in the shape-matching math) | Radius is used only for contacts (`:1104` in `collideWith`). It would feed Eq. 3 in `rebuildAqqWeighted`. |
| One shape-matching group per primitive + 1-ring | `streamed-deform.ts:533-563` (cluster build per cage, L/R split, 6 `extra` clusters at `:552-559`) | variant | 22 coarse clusters from cage membership, not mesh adjacency. |
| $\bar{\mathbf A}$ normalization (Eq. 2–3) | `src/game/shape-match-core.js:300` `rebuildAqqWeighted` (`+1e-3` at `:306-308`); `:449` `matchSkinLocal` (`+1e-3` at `:488-490`) | variant | Same $A_{pq}A_{qq}^{-1}$ form, but an arbitrary ε replaces $\sum\tfrac15 m r^2\mathbf I$. Cluster {bumperRL, doorL, tank, axleR} has $A_{qq}$ eigenvalues (1e-4, 6.7, 51.7). The Eq. 3 term would be 2.8 (computed). |
| $\mathbf A_i=\tfrac15 m r^2\mathbf R_i$ in Eq. 1 | `shape-match-core.js:311` `matchCluster` (Apq at `:328-333`) | missing | Needs a rotation per particle. Use `c.Rprev` (field at `:266`) as a stand-in. |
| Degenerate-A safety | `shape-match-core.js:334` (A→I if `|A|>12`); `:102` `m3Polar` guard; `:193` `stabilizeMat` | variant | We clamp or reset after the fact. The paper avoids the singularity by construction. |
| Deform geometry by local affine D | `shape-match-core.js:337-338` (`M = R·lerp(I,S,β)`); `:428` `transformSkinPointInto`; `streamed-deform.ts:2466-2474` (skin blend) | same / variant | We apply a blended per-cluster affine to vertices (LBS-like). The paper applies D per primitive and then averages vertices by id. |
| Visual mesh = averaged primitive vertices by global id | `streamed-deform.ts:568` `buildSkinWeights` (top-4 clusters, `exp(-2.35d)`, `d≤1.45`) | variant | Our mesh is one indexed geometry, so it is watertight by construction *only if* displacement depends on rest position alone. |
| Invariant: co-located vertices move identically | `streamed-deform.ts:2502` `n0 = hash01(i, 3)` inside `skin` (wrinkle `:2500-2510`) | contradicts | Noise keyed by vertex **index**. Probe: chassis has 1212 verts, 934 unique positions, 182 co-located groups (460 verts, 436 above y=0.34, inside the wrinkle gate). Phase differs by up to 1.2 rad, so co-located verts split by up to ≈`amp` (≈4 cm at full wrinkle, capped by `extraCap` `:2512`). |
| One deformation field across touching parts | `streamed-deform.ts:1557` `skinPanel` (trilinear cage); cages from `:2290` `solveCagesFromShape` (8 corners, all-cluster blend, `d≤1.4`, no top-4 or roof filter); callers `src/game/car.ts:715-725` | variant (inconsistent) | Hood, trunk and glass take a different interpolant from the body (`skin`). Their edges can drift apart from the adjacent wing and roof verts [INFERENCE: not measured]. |
| Rigid between hits; deform only on hits | `streamed-deform.ts:1350-1370` `update` (skin only while `crushing`); `:785` `quietTime`; `:1086` `collideWith` quiet gate | same | Our "rigid" phase is no re-skin plus pose follows masses. |
| Plastic trigger: $v_n$ above material threshold | `streamed-deform.ts:1293` `feedOverlap` (`crushGate(closing, soft)` `:1326`) | same (variant gating) | Our threshold is a soft gate per region (`regionSoftness`). |
| Offset = $v_n\Delta t$ in local frame | `streamed-deform.ts:1304` (crush from overlap × KE scale), `:1332` (`m.world += inward·posNibble`), `:1335` (kill inbound $v_n$) | variant | We displace *dynamic* world positions of masses within a 1.05 m reach. The paper displaces rest/local positions of the touched primitive only. |
| Quasi-static relax after displacement | `streamed-deform.ts:1985` `stepShapeMatch` (`alpha`, `iters` `:2003-2008`; step cap 0.14 m `:2057`) | variant | Ours is dynamic, 2–5 iterations. Plastic state lives in `Sp` (`shape-match-core.js:345` `applyPlasticity`). |
| Joint primitives pinned as boundary conditions | `streamed-deform.ts:1995`, `:2034` (hubs skipped unless `deepCrush`); `:2530-2541` (skin pins verts within 0.4 m of hubs) | same | Wheels act as our "joints". Panel hinges are not used as pins. |
| Recompute COM/inertia after plastic change | `src/game/car.ts:627` `syncPose` → `streamed-deform.ts:1123` `followGroup` | variant (implicit) | Once `massActive`, pose derives from the masses, so the COM shift is implicit. There is no inertia tensor to update. |
| Strain-limit link breaking | `streamed-deform.ts:1931` (`len > rest·2.2` → beam dead) in `stepBeams` | same (beam mode only) | Shape mode has no link breaking. Panel detach uses `hingeT` thresholds `car.ts:924-929`. |
| Breakable subset / authored tear lines | `car.ts:952` `detachPart`; `car.ts:78` hinge types | variant | Detachment is whole-panel and authored per part. There is no partial tearing. |
| Adaptive subdivision at impact (fracture pattern, not separated) | `src/game/car-mesh.ts:99` `SLICES = 40`; `:368` `makeChassisGeometry` | missing | Fixed tessellation, ≈0.11 m ring spacing along z. Would go in a new rest-space refine step called from `StreamedDeformation.applyImpact` (`streamed-deform.ts:1340`), rebuilding `restPos`/`skinWeights`. |
| Fine-scale dent detail | `streamed-deform.ts:2500-2510` accordion wrinkle (procedural `sin(rz·18)`) | variant (fake) | Procedural fold in place of simulated local geometry. |
| Brittle fracture pattern aligned to impact (glass) | `car.ts:982` `shatterGlass` (hides pane, emits 56 FX shards at pane centre `:995`); `car.ts:40` `GlassState` | variant | No impact-aligned pattern, and pieces do not stay on the surface. |
| Collision on detailed geometry | `streamed-deform.ts:1404` `liveHulls` (≈5 2D boxes); `src/game/sat.ts:157` `satCars`; `src/game/pair-contact.ts:61-62` | contradicts | Contact uses coarse car-frame boxes, not the deformed mesh. |
| 3-stage collision culling | `pair-contact.ts:58-59` (5.2 m cull); `sat.ts:168` (6 m cull); `sat.ts:174-175` (`hullsOf(b)` re-evaluated inside the `ha` loop); `src/game/engine.ts:1255-1258` (O(n²) pair loop) | variant | Stage 1 exists. There is no stage-2 restriction. `liveHulls` allocates on every call and runs once per `ha`. |
| Normals of deformed mesh | `streamed-deform.ts:2548`, `:1578` `computeVertexNormals` | n/a (paper silent) | Covered under caveats. |

## Candidates to implement

1. **Rest-position-keyed wrinkle noise (honour the co-located-vertex invariant)**
   - **Area:** correctness, visual quality.
   - **Change:** in `streamed-deform.ts` `skin`, replace `hash01(i, 3)` (`:2502`) with a hash of the quantized rest position (`rx, ry, rz`). Alternatively, build a `weldId: Uint32Array` once in the constructor by sorting rest positions (the paper's §3.6 trick) and hash `weldId[i]`.
   - **Expected effect:** the 182 co-located vertex groups (pillars, rails, headers and box corners merged at `car-mesh.ts:395`) stop separating by up to ≈4 cm under accordion wrinkle. No more pinholes or cracks at part seams near the impact.
   - **Cost:** S. **Risk:** the wrinkle pattern changes look slightly (different noise), with no physics impact.
   - **Verify:** throwaway script that skins with `wrinkleAmp>0` and asserts max distance within each co-located group is 0. Then `npm run test:game`, and a visual check of a side hit in the browser.

2. **Eq. 3 radius regularizer for cluster matching**
   - **Area:** stability.
   - **Change:**
     - Add `radius` to `ShapeParticle` (`shape-match.ts:9`) and copy it in `streamed-deform.ts:519-527`.
     - In `shape-match-core.js` `rebuildAqqWeighted`, replace `+1e-3` with $\sum\tfrac15 m_i r_i^2$ on the diagonal, and store that scalar `c.k`.
     - In `matchCluster`, add `c.k · c.Rprev` to `_Apq` before multiplying by `AqqInv` (Eq. 1 with $\mathbf R_i:=\mathbf R_{\text{prev}}$).
     - Do the same in `matchSkinLocal` with `c.skinRprev`, passing radius alongside `skinMassN`.
   - **Expected effect:** the near-planar cluster {bumperRL, doorL, tank, axleR} goes from conditioning 1e-4 (against ε 1e-3) to a 2.8 floor. Its out-of-plane column becomes the previous rotation instead of amplified noise, so fewer A→I resets (`:334`) and polar fallbacks, and less snap flicker. Rigid rotations stay exact ($\mathbf D=\mathbf R$).
   - **Cost:** S. **Risk:** the stretch component (`S`) along well-conditioned axes shrinks a little, because $\bar{\mathbf A}$ grows. That shifts plastic yield (`applyPlasticity` reads `‖S−I‖`), so `yieldC` may need retuning. Rotation lags slightly while the cluster is degenerate.
   - **Verify:** `npm run test:game` (shape-match.test.ts, crash-physics.test.ts). Throwaway: perturb the 4 particles out of plane and check `R` is continuous and `A` never trips the `>12` guard. Then `npm run bench` to confirm no cost change.

3. **Rest-space dent layer on the welded render mesh (paper §3.5 applied to visual vertices)**
   - **Area:** realism.
   - **Change:**
     - **State:** add `dentRest: Float32Array(vertexCount*3)` and a welded adjacency, built once from `geometry.index` plus `weldId` from Candidate 1, to `StreamedDeformation`.
     - **Contact:** in `feedOverlap` (`:1293`), map the contact into rest space. `impactLocal`/`impactInward` are already kept (`applyImpact` `:1340`), and you can refine by inverting the nearest cluster's `skinM`. Push welded vertices within ρ≈0.2–0.3 m along `-inward` by `crush·kernel(d)`, capped by a material thickness. This is the paper's "offset in local frame on the touched primitive".
     - **Relax:** run 4–8 Jacobi iterations of edge-length or Laplacian shape preservation over the touched set plus its 1-ring. Pin vertices outside ρ and within 0.4 m of hubs, which are our "joints".
     - **Skinning:** in `skin` (`:2458+`), add `dentRest` to `(rx,ry,rz)` before the cluster blend. The dent then rides the 20-particle crumple.
     - **Panels:** apply the same offsets by world-space kernel to hood, trunk and glass in `skinPanel`, so seams stay consistent.
   - **Expected effect:** pole, corner and bumper-edge dents at mesh resolution (≈0.1 m), independent of the 0.4–1.4 m cluster footprint. This is the "denser, more local dent" the 20-particle rig can't express. Cost stays bounded because the relax runs only on contact frames and only over the touched set (tens to hundreds of verts).
   - **Cost:** M. **Risk:**
     - ≈0.11 m vertex spacing (`SLICES=40`) limits sharpness; see Candidate 6.
     - The layer must not double-count the crush the particles already take, so scale it by `leftoverCrumple` or apply it only to the extra beyond cluster motion.
     - Self-intersection under deep crush.
     - `restPos`-based caches (hub pins `:2530`, the `ry` gates) must use dented or rest positions consistently.
   - **Verify:**
     - `npm run test:game`.
     - Throwaway: a pole hit should give a localized max displacement within ρ, zero beyond it, and welded groups equal.
     - `npm run bench` for the sim-time delta, and `node scripts/bench-browser.mjs` for the deform-ms delta at 24 cars.

4. **Skin panels with the body's cluster field in shape mode**
   - **Area:** visual quality, correctness.
   - **Change:** in `streamed-deform.ts` `skinPanel` (`:1557`), when `mode === "shape"`, use per-vertex cluster weights instead of trilinear cage interpolation. Compute them with the same scorer as `buildSkinWeights` (`:568`) on `rest + origin`, cache them per panel geometry, then blend with `transformSkinPointInto`.
   - **Expected effect:** hood, trunk and windshield edges follow exactly the same displacement field as the adjacent body vertices (the paper's "one field, averaged per id" property). Seams no longer open between panels and wings or roof under asymmetric crush [INFERENCE: seam drift not measured].
   - **Cost:** S–M. **Risk:** the hinge animation in `car.ts:817-849` moves panels on top of the skin, so cached weights must use the panel's rest/origin frame, not the hinged pose. The glass `skin` keys map to cages (`glassFront`, `glassRear`), so you need a mapping.
   - **Verify:** throwaway that measures, after a frontal crush, the distance between the hood's rest-coincident edge verts and the nearest body verts. Plus `npm run test:game`.

5. **Hoist hull evaluation out of the SAT inner loop (stage-2 culling spirit)**
   - **Area:** performance.
   - **Change:** in `sat.ts` `satCars` (`:174-175`), evaluate `hullsOf(a)` and `hullsOf(b)` once before the loops. Optionally drop hull pairs whose bounding circles fall outside the intersection of the two cars' bounds before calling `satTwoHulls` (the paper's stage 2).
   - **Expected effect:** each `satCars` call stops re-running `liveHulls`/`sanitizeHulls` (which allocate) once per `ha`. `resolveCarPair` calls `satCars` twice, up to 3 iterations per step (`pair-contact.ts:188`), so this cuts allocation and GC in packed derbies.
   - **Cost:** S. **Risk:** negligible; the hulls are pure functions of state within a call.
   - **Verify:** `npm run test:game`; `npm run bench` (sim ms) in a 24-car derby.

6. **Impact-local rest-space subdivision (paper's "fracture pattern without separation")**
   - **Area:** realism, visual quality.
   - **Change:** on the first strong hit per region, run a new routine called from `applyImpact` (`streamed-deform.ts:1340`).
     - Split triangles of the chassis index within ρ of `impactLocal` in **rest space** (e.g. 1–2 levels of midpoint subdivision).
     - Append new verts to `restPos`/position/normal/uv, recompute `skinWeights` for the new verts only, and set new `weldId`s by sorting rest positions.
     - Then let Candidate 3's dent layer act on the refined patch.
   - **Expected effect:** creases of a few centimetres near impacts while the base mesh stays at 1212 verts; the paper reports ≈1k extra primitives per first hit.
   - **Cost:** L. **Risk:**
     - Three.js buffer reallocation needs a new `BufferAttribute`, so you get a GPU upload hitch.
     - T-junction cracks at refinement boundaries unless you use a red-green split.
     - Growing vertex count raises the `skin` + `computeVertexNormals` cost, which is already ≈15 ms for 24 cars.
     - Must cap per car.
   - **Verify:** throwaway (watertightness: every edge has 2 triangles across the refinement boundary); `node scripts/bench-browser.mjs` deform ms before and after a derby; `npm run test:game`.

7. **Strain-limit link breaking for partial tearing and detachment in shape mode**
   - **Area:** realism.
   - **Change:** replace or augment the `hingeT` thresholds (`car.ts:924-929`) with a paper-style test on authored breakable links between panel attach points and body particles: break when $\lVert x_a-x_b\rVert>\varepsilon_{\max}\cdot$ rest length. Mirror `stepBeams`' `len > rest·2.2` (`streamed-deform.ts:1931`) for shape mode. Only authored links (hinges, latches) are breakable, as in the paper's tear lines.
   - **Expected effect:** doors and hood tear off in response to measured strain instead of a scalar crush proxy. One hinge can go first, so the panel dangles before it detaches.
   - **Cost:** M. **Risk:** tuned detachment tests in `crash-parts.test.ts` may shift; it interacts with hinge animation.
   - **Verify:** `npm run test:game` (crash-parts, crash-physics); manual side-impact replay.

8. **Impact-aligned glass crack pattern that stays on the pane**
   - **Area:** visual quality.
   - **Change:** in `car.ts` `shatterGlass` (`:982`) and the `cracked` state, project a precomputed 2D Voronoi or radial crack pattern centred at the impact point onto the pane (decal, texture or split mesh). Keep the shards in place on the skinned pane for a short time before handing them to FX. This follows paper Fig. 7: pieces remain at the correct positions on the surface.
   - **Expected effect:** the crack origin matches the hit and the shatter reads as believable.
   - **Cost:** M. **Risk:** the extra draw calls add to the render submit, which is already ≈21 ms/frame; reuse one instanced shard mesh.
   - **Verify:** visual check in the browser; `node scripts/bench-browser.mjs` draw-call or frame delta.

## Not applicable / caveats

- **Full WYSIWYS replacement of the rig is out of budget.** One convex primitive per face is 1712 per car, ≈41k at 24 cars. Per-primitive SAT collision and per-primitive 1-ring shape matching in JS would blow both the ≈10 ms sim budget and the ≈15 ms deform budget. The paper's own numbers are 1–10 ms per hit for *one* car on native code, and it avoided simultaneous many-body hits. Keep the 20-particle rig for global crumple and momentum; borrow the paper's local, hit-only, rest-space mechanisms.
- **Collision on visual geometry** (contact against the deformed mesh) is not adopted. Our contact is 2D car-frame SAT boxes (`liveHulls`, `satTwoHulls` with car axes only). Moving to deformed convex polygons needs general-axis SAT. The cheaper realistic proxy is Candidate 3: dent the mesh where the coarse contact says it was hit.
- **Extrusion into thick shells and inner-surface closure** do not apply. Our car is a single-sided procedural loft; there is no back surface to keep closed.
- **Oriented particles:** our particles carry no orientation, so Eq. 1's $\mathbf R_i$ must be approximated (cluster `Rprev`). The paper's ellipsoid-to-polyhedron generalization is irrelevant to us.
- **Joint re-creation after splitting** (object replaced by new objects inheriting joints that overlap a box) only matters if bodies split into multiple simulated pieces. Our detached parts are free rigid props (`car.ts:998` `stepLooseParts`) with no joints.
- **Brittle fracture via convex decomposition** [MCK13] is a heavy pipeline; for glass, the visual-only Candidate 8 is enough.
- **Performance figures** in the paper are single-core and serial (Core i7, 3.1 GHz), and the paper is inconsistent about the car: 16k vs 17k primitives, >60 vs >100 fps. Treat them as order-of-magnitude only.
- **Equation (1)** is partly reconstructed: the PDF text shows $\mathbf A_i=m_ir_i\mathbf R_i$, and $\tfrac15 r_i^2$ is inferred from Eq. 3 and MC11. Candidate 2 only needs the property that the same scalar multiplies $\mathbf R$ in $\mathbf A$ and $\mathbf I$ in $\bar{\mathbf A}$, which holds either way.
- **Not from the paper, but adjacent:** `skinInvT` and `transformNormal` (`shape-match-core.js:343`, `:446`) already compute inverse-transpose normal transforms, yet `skin` still calls `computeVertexNormals` (`streamed-deform.ts:2548`). Whether blending transformed rest normals beats recomputing normals for the deform-ms budget is a separate question.
