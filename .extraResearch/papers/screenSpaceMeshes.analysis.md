# Screen Space Meshes (Müller, Schirm, Duthaler — SCA 2007) — analysis for crash-deformer-test

Direct relevance is **low**. The paper is a fluid-surface *renderer* for SPH particles; the repo has no fluid simulation and the car body is a small fixed-topology loft mesh. What carries over is (a) the "spend surface work proportional to projected screen size" principle, (b) the cheap depth-splat + symmetric binomial filter + outline-smoothing tricks (good for a ground-plane fluid leak), and (c) its vertex-normal step, which led to a measured finding about this repo's normal recompute.

## Summary

- Splat every particle into a coarse screen grid (spacing $h$ = 1–10 px): $z_{i,j} \leftarrow \min(z_{i,j}, z_p - r_z h_{i,j})$, kernel $h_{i,j} = 1 - d^2/r_p^2$ (parabola; the sphere version uses a square root). Depth is kept linear (no divide by $w$).
- Screen position/radius per particle from the projection matrix: $x_p = W(\tfrac12 + \tfrac12 x'/w)$, $r_p \propto r\,\lVert P_{\text{row}}\rVert / w$ (Eqs. 2–3).
- Edges whose end depths differ by more than $z_\text{max}$ are silhouette edges; a second particle pass puts one silhouette node on each (front-layer only, farthest from the shallow end).
- A 16-case Marching-Squares-style table triangulates each cell; inner silhouettes get duplicated front/back vertices so layers separate in depth; fixed triangulation choices avoid flicker.
- The mesh is back-projected with $\mathbf{Q} = \mathbf{P}^{-1}$, recovering $w$ from the last row (Eq. 7); vertex normals are angle-weighted face-normal sums.
- Depth smoothing: separable binomial filter (1, 6, 15, 20, 15, 6, 1)/64. Near discontinuities a tap is dropped together with its mirror tap so the kernel stays symmetric and edges don't tilt.
- Silhouette smoothing: iterated neighbour averaging of screen x/y. The regular interior is a fixed point, so only outlines move. It shrinks small blobs, which reads as surface tension.
- Cost scales with screen coverage, not particle count. Limits: only valid for one view, so shadows break, and only the front layer is built. The paper reports 1–3 fps cost on 10–16K-particle scenes (CPU, 2007).

## Useful content

1. **View-dependent effort.** Surface work should follow projected size. For a three.js `PerspectiveCamera`, the projected radius in pixels of a bounding sphere with radius $r$ at view depth $w = -(\mathbf{V}\mathbf{x})_z$ is $r_\text{px} = r \cdot \tfrac{H}{2} \cdot P_{2,2} / w$, where $P_{2,2}$ = `camera.projectionMatrix.elements[5]` $= 1/\tan(\text{fov}/2)$. This is Eq. 3 specialized; the paper's $\sqrt{p_{2,1}^2+p_{2,2}^2+p_{2,3}^2}$ reduces to $p_{2,2}$ for a symmetric frustum. Applying this principle to deformation: a car 60 m away that covers 30 px does not need per-frame re-skinning plus a normal rebuild.
2. **Shadow caveat (Sec. 6).** Anything culled or decimated by camera view is still seen by the shadow light. The repo has a `PCFShadowMap` directional light, so a view-based skin skip must account for shadow casters.
3. **Splat kernel.** $h = 1 - d^2/r^2$ is a sqrt-free, compact "height" contribution per particle. It is cheap enough to splat hundreds of drips per frame into a small grid, e.g. an oil/coolant puddle heightfield seen from above. In that setup the "camera" is a fixed top-down grid and no view dependence is involved.
4. **Symmetric-omission filter (Sec. 4.1).** When smoothing a field over a grid that contains discontinuities, drop tap $i+k$ **and** $i-k$ together. Otherwise the smoothed value is biased toward the continuous side (the paper's "tilt", Fig. 7). This applies to any regular-grid field, including displacement on the car's loft grid (vertices `s*n + i`).
5. **Outline smoothing = surface-tension look (Sec. 4.2).** Iterated averaging shrinks and rounds small blobs. For a puddle texture, a blur followed by a threshold gives the same rounded, shrinking edge.
6. **Normals.** The paper uses angle-weighted vertex normals. Measured on this repo's chassis (below), angle weighting is **not** a safe swap here. The useful part is that a raw-array normal pass is about 2.9× faster than three.js `computeVertexNormals` and produces identical output.
7. **Flicker discipline.** Ambiguous cases (1, 2, 4, 8) must always use the same fixed choice, or the result flickers frame to frame. The repo already treats polar-decomposition jitter as flicker: `streamed-deform.ts:1363-1369` stops re-skinning outside the contact window.

### Measured on this repo (throwaway node script, not committed)

`makeChassisGeometry()` → **1212 vertices, 1712 triangles** (indexed); hood/trunk 132 verts / 260 tris each.

| Normal pass on chassis | µs/call (node, WSL) |
|---|---|
| three.js `computeVertexNormals` (area-weighted, `BufferAttribute` accessors) | 79.4 |
| raw `Float32Array`/index loop, area-weighted | 27.1 (min dot vs three = 1.000000) |
| raw loop, angle-weighted (paper Sec. 3.4) | 133.6 |

Angle-weighted normals disagree with area-weighted ones (dot < 0.9) on **156–158 of 1212 vertices**, worst dot −0.9995. 60 triangles are exactly degenerate (zero area), and skipping them does not fix the disagreement. The loft contains folded or near-zero-thickness sections (door-aperture and wheel-well rings in `sectionPoints`), where sliver triangles get angle weights comparable to large faces. On this mesh, area weighting effectively ignores slivers, which is what keeps the current shading stable.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Point splat into depth grid (Eqs. 4–5) | — | missing | No splatting anywhere. A top-down puddle grid would go in a new `LeakPuddleSystem` class in `src/game/engine-fx.ts`, next to `TireSmokeSystem` (`engine-fx.ts:340`). |
| Particle sets for FX | `engine-fx.ts:4 DebrisSystem`, `:123 SparkSystem`, `:239 GlassDotSystem`, `:340 TireSmokeSystem` | variant | Particles are drawn individually: instanced boxes, additive `Points`, camera-facing quads (`:475` copies `camera.quaternion`). No surface is reconstructed from them, which is fine for sparks, glass and smoke. |
| Fluid/leak source | `engine.ts:1045` `if (!car.deform.drivetrainAlive)` → `puffDeadEngine` (`:1573`), `puffEngine` (`:1580`) | missing | A dead engine only emits smoke wisps (`TireSmokeSystem.wisp`, `engine-fx.ts:409`). There is no fluid leak. |
| Ground receiver | `engine.ts:2180-2191` `ground` (`CircleGeometry(48, 64)`, `receiveShadow`) | — | Target surface for a puddle overlay. `GridHelper` sits at y = 0.012 (`:2193-2194`). |
| Soft/translucent particle draw | `engine-fx.ts:372` `depthWrite: false`, `:367` `PlaneGeometry(1,1)` smoke quads | variant | Sorting-free billboards. The paper's depth-map idea is not used (and not needed). |
| View-dependent LOD (Sec. 1, Eq. 3) | `engine.ts:1026-1029` `for (const car of cars) … car.updateDeform(simDt)` | missing | Every crashed car re-skins at full rate regardless of screen size or visibility. Camera: `engine.ts:189` `PerspectiveCamera(50, 1, 0.1, 180)`. |
| Per-frame surface rebuild gate | `streamed-deform.ts:1350 update` → `:1362 this.skin(geometry)`; `:1369` `this.crushing = this.bidirectional \|\| this.quietTime() < 0.28` | variant | This is a time-based gate (contact window). There is no view-based gate. |
| Panel skinning follows body skin | `car.ts:712 updateDeform`, `:715` `if (this.deform.skinnedThisFrame)` → `skinPanel` hood/trunk/glass | — | Any skin throttle is inherited by panels for free. |
| Shadow limitation (Sec. 6) | `engine.ts:186-187` `shadowMap.enabled`, `PCFShadowMap`; `:2166` `dir.castShadow`; `car.ts:143` `body.castShadow` | contradicts (constraint) | View-based skipping can leave a stale shadow from an off-screen wreck. |
| Angle-weighted vertex normals (Sec. 3.4) | `streamed-deform.ts:2548` `geometry.computeVertexNormals()` in `skin`; `:1578` in `skinPanel`; `:1746` in `restoreRest`; `car.ts:222` `restoreRest` | contradicts | three.js is area-weighted (`node_modules/three/src/core/BufferGeometry.js:1049-1059`, unnormalized cross product accumulated). On this mesh, angle weighting flips about 13% of the normals (see measurement). |
| Analytic normal transform | `shape-match-core.js:343` `m3Transpose(_tmp, c.skinInvT)`, `:446 transformNormal` | variant (unused by `skin`) | The kernel has $(M^{-1})^T$ per cluster, but `skin` rebuilds normals from topology instead. |
| Regular grid that a separable filter can run on | `car-mesh.ts:200 loftFromRings` (vertex `s*n+i`, quads `:220-228`), `:99 SLICES = 40`, `:151 sectionPoints` (13 points per ring), `:378` body is the first part merged at `:395` | same (structure) | Body vertices `0 … 40*13-1` form a wrapped (s, i) grid at the front of the merged chassis buffer, so a paper-style separable filter over displacement is indexable. |
| Accordion high-frequency detail | `streamed-deform.ts:2500-2510` (`Math.sin(rz * 18 …)`, ~12 cm wavelength along z) | contradicts (for smoothing) | The slice spacing is about 4.3 m / 39 ≈ 0.11 m, close to the wrinkle wavelength. Any smoothing along s must run **before** the wrinkle is added, or it erases the wrinkle. |
| Depth threshold $z_\text{max}$ for connectivity | — | missing | Nearest analogue: the per-vertex `extraCap` / `cap` clamps (`streamed-deform.ts:2512-2526`), which bound displacement but do not test discontinuity. |
| SPH fluid | — | missing / not wanted | No fluid solver. Not proposed. |

## Candidates to implement

1. **Raw-array normal recompute in the skin hot path**
   - Area: performance
   - Change: add `accumulateAreaNormals(pos: Float32Array, index: Uint16Array | Uint32Array, out: Float32Array): void` to `src/game/physics-util.ts`. It zeroes `out`, accumulates the unnormalized cross product per triangle, then normalizes, which matches three's math exactly. Call it in place of `geometry.computeVertexNormals()` at `streamed-deform.ts:2548` (`skin`) and `:1578` (`skinPanel`), writing into `geometry.getAttribute("normal").array` and setting `needsUpdate`. Cache the index array once in the `StreamedDeformation` constructor (`streamed-deform.ts:392`).
   - Effect: measured 79.4 → 27.1 µs per chassis rebuild with bit-equivalent output (min dot 1.000000). At 24 simultaneously crushing cars that is about 1.25 ms/frame of the ~15 ms deform bucket, plus hood/trunk/glass panels [INFERENCE: panel share unmeasured].
   - Cost: S. Risk: low; the index may be `Uint16`/`Uint32`, and the normal attribute must already exist (it does after `makeChassisGeometry` → `:398`).
   - Verify: add a case to `src/game/physics-util.test.ts` that compares against `computeVertexNormals` on `makeChassisGeometry()` after a non-rigid perturbation (dot ≥ 0.99999 per vertex). This catches index-stride or winding bugs. Then `scripts/bench-browser.mjs` (`deform` column) in a 24-car derby, before and after.
   - **Do not** switch to the paper's angle weighting; see measurement.

2. **Screen-size / visibility skin throttle (paper's view-dependent LOD)**
   - Area: performance
   - Change: add a `skinAllowed = true` parameter to `StreamedDeformation.update(simDt, geometry, skinAllowed)` (`streamed-deform.ts:1350`). When it is false, skip `bakeLocalSkin` / `solveCages` / `skin` (`:1360-1362`), set `this.skinOwed = true`, and keep `this.crushing` true while `skinOwed`, so the final plastic pose is never dropped when the contact window closes (`:1369`). Forward the flag through `DeformableCar.updateDeform(dt, skinAllowed = true)` (`car.ts:712`); panels follow automatically via `skinnedThisFrame` (`car.ts:715`).
   - In `engine.ts:1026-1029`, compute per car $r_\text{px} = 2.3 \cdot \tfrac{H}{2} \cdot$ `camera.projectionMatrix.elements[5]` $/ w$, plus a `THREE.Frustum` sphere test. Skin every frame when $r_\text{px} \ge 80$, every 3rd frame when $r_\text{px} < 80$, and skip entirely when the car is outside both the camera frustum and the directional light's shadow camera frustum (`engine.ts:2166`; the paper's shadow caveat).
   - Effect: in fleet derby views most of the 24 cars are small or off-screen, so the deform cost should scale with on-screen cars [INFERENCE; magnitude unmeasured].
   - Cost: S–M. Risk: medium. A stale pose on a re-entering car pops for one frame; `skinOwed` must survive `reset`. Tests are unaffected because they call `updateDeform(dt)` with the default.
   - Verify: a new case in `src/game/zip.test.ts` (it already counts `skinnedThisFrame`, `:305`). Run a crush with `skinAllowed=false` until `quietTime() > 0.28`, then call one allowed update. Body positions must equal those of an always-skinned run (max abs diff < 1e-5), and `skinnedThisFrame` must fire exactly once. Then `scripts/bench-browser.mjs` derby 24 cars, `deform` ms.

3. **Oil/coolant leak puddle under dead engines (splat + symmetric binomial filter + threshold)**
   - Area: realism / visual quality
   - Change: new `LeakPuddleSystem` in `src/game/engine-fx.ts`. It holds one small top-down `Float32Array` grid (e.g. 32×32 over 1.6 m) per leaking car, uploaded as a `THREE.DataTexture` on a ground quad at y ≈ 0.006 (below the `GridHelper` at 0.012), with `polygonOffset` and `MeshStandardMaterial({ transparent, roughness: 0.05, metalness: 0 })`. Each frame a few drips are splatted under `massWorld("engineL"/"engineR")` with the paper's kernel $h = 1 - d^2/r^2$ (accumulate with `max`, not `min`, since this is height, not depth). Apply 1–2 passes of the (1, 4, 6, 4, 1)/16 or (1, 6, 15, 20, 15, 6, 1)/64 separable filter, then threshold in the material (`alphaTest`) so the outline rounds and shrinks (Sec. 4.2 effect).
   - Emit from the existing dead-engine branch `engine.ts:1045-1050`, next to `puffDeadEngine`; update next to the other FX at `engine.ts:1039-1042`; `reset()` alongside them.
   - Effect: a slowly growing dark glossy pool under wrecks, which is a strong "this car is dead" cue. Cost is a 1K-cell CPU filter plus a tiny texture upload per leaking car.
   - Cost: M. Risk: low (isolated FX). A car that keeps sliding needs per-car world anchoring: freeze the puddle's world position when `quietTime()` exceeds a threshold, and start a new puddle if the car moves more than 1 m.
   - Verify: a browser visual check via `scripts/bench-browser.mjs` (confirm `calls` and `render` stay flat with 24 dead cars). No permanent unit test (FX have none today). Use a throwaway script to assert the filtered grid is symmetric for a centered splat.

4. **Symmetric-omission smoothing of crush displacement on the body loft grid**
   - Area: visual quality
   - Change: in `StreamedDeformation.skin` (`streamed-deform.ts:2450`), split the loop. Pass A computes the base position (`bx,by,bz`, `:2493-2495`) for all vertices into a scratch `Float32Array`. Pass B runs one separable binomial pass (1, 2, 1)/4 over displacement $d = p - p_\text{rest}$ along `s` and wrapped `i` for vertices `< SLICES*13`. A tap pair is dropped when $\lVert d_{i\pm k} - d_i\rVert > d_\text{max}$ (≈ 0.06 m, the analogue of $z_\text{max}$). Pass C then adds the accordion wrinkle (`:2500-2510`) and the existing clamps (`:2511-2542`). Export the grid shape from `makeChassisGeometry` (`car-mesh.ts:368`) as `geometry.userData.loftGrid = { slices: SLICES, ring: 13 }` rather than hard-coding it.
   - Effect: removes per-vertex cluster-blend noise and polar jitter between overlapping clusters while keeping sharp crush fronts. The symmetric drop keeps the panel edges at a crease from being dragged (paper Fig. 7).
   - Cost: M. Risk: medium-high. It can soften deliberate creases; the ring is non-uniform (13 points, with dense points near the sills); the merged non-loft parts (roof, pillars, wells) are not smoothed and may seam against the body.
   - Verify: `src/game/zip.test.ts` frame-to-frame `dVert` stats (`:306-316`) should drop or stay the same. `src/game/rest-mesh.test.ts` must remain green (rest profile untouched). Visual check in browser.

## Not applicable / caveats

- **The core algorithm (screen-space Marching Squares meshing of SPH fluid) has no target here.** There is no fluid simulation and no particle cloud whose *surface* needs reconstructing. Sparks, glass dots and smoke are correctly drawn as individual sprites or instances (`engine-fx.ts:123/239/340`). Meshing them would cost more and look worse.
- **The car body is not a point cloud.** It is a fixed-topology loft (1212 verts / 1712 tris) skinned from cages and clusters. View-dependent re-meshing would break the rest-pose correspondence that `influences` / skin weights depend on.
- **Angle-weighted normals (Sec. 3.4)** contradict what this mesh needs. On the chassis they flip about 13% of the normals relative to the current area-weighted result (measured above), because of sliver and folded triangles in the door/well rings. Keep area weighting.
- **Camera-only validity.** The paper's own shadow problem applies to any view-based shortcut (candidate 2), and the scene uses a shadowed directional light. Gate on the light frustum too.
- **Depth linearization detail.** The paper's claim that $\sqrt{p_{3,1}^2+p_{3,2}^2+p_{3,3}^2} = 1$ does not hold for a standard three.js/OpenGL perspective matrix, whose third row is $(0, 0, -(f+n)/(f-n), \cdot)$. Use view-space $-z$ for $w$ / depth instead of trusting $r_z = r$.
- **Front-layer-only and CPU 2007 numbers** are irrelevant to perf planning here. The repo's measured bottleneck is render submit (≈ 21 ms) plus deform (≈ 15 ms), not surface extraction.
- **Soft-particle depth fade for smoke** (fading billboards where they intersect ground or cars) is a related screen-space depth idea but **not in this paper**, so it is not proposed here. It would need a depth pre-pass that `engine.ts` does not have.
