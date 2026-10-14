For ~30 deformable cars, the biggest wins usually come in this order:

1. **Reduce render passes and draw calls**
2. **Reduce rendered pixel count**
3. **Reduce shadow-map work**
4. **Reduce per-frame vertex-upload bandwidth**
5. **Simplify fragment shaders and post-processing**

There is no reliable public benchmark that isolates Adreno versus Mali specifically for this exact workload in Chrome Android and Firefox Android. Treat the numbers below as practical starting points, then validate on representative devices with GPU timing and `renderer.info`.

## Expected impact ranking

| Optimization | Typical opportunity | Notes |
|---|---:|---|
| Batch/instance draw calls | Very high: often 1.5–5× CPU-side improvement when calls are high | Mobile scenes generally benefit from staying below roughly 100–150 calls; lower is better.[1][2][3] |
| Pixel-ratio reduction | Very high: 2× linear resolution costs 4× pixels | Moving from DPR 3 to 1.5 reduces shaded pixels by 75%. |
| Shadow-map resolution/cascades | High | A 2048² map contains 4× as many texels as 1024² and 16× as many as 512². |
| Post-processing/render-target reduction | High | Each full-screen pass shades the entire render target and may add bandwidth-heavy texture reads/writes. |
| Partial vertex uploads | Medium to high | Particularly useful when only a small fraction of each car’s vertices changes. |
| Half-float/packed attributes | Medium | Saves bandwidth and memory, but may increase decode work or reduce quality. |
| `mediump` fragment precision | Low to medium | Usually most useful in fragment-heavy shaders; test visual correctness. |
| MSAA → FXAA | Medium | MSAA is often expensive in memory bandwidth; FXAA adds one full-screen pass. |
| Avoiding material recompiles | Spiky but potentially severe | Compilation stalls can cause frame hitches rather than merely lower average FPS. |
| Deformed-object bounds/culling | Medium | Important when many cars are off-screen or deformation changes their extents. |

## 1. Draw calls: batch compatible cars, but do not force incompatible deformation paths

`InstancedMesh` is the strongest option when cars share the same geometry and material; it renders all instances with one draw call.[4] For different car geometries that share materials, `BatchedMesh` can combine them while retaining separate geometry entries and per-object control.[5]

For 30 cars, the raw draw-call count may not sound large, but the total matters after adding:

- Main opaque pass
- Transparent pass
- Shadow-casting passes
- Reflection/environment passes
- Post-processing passes
- Multiple materials per car
- Wheels, glass, lights, decals, and accessories

A practical target is:

- **Main camera:** ideally below 50–100 calls
- **All scene passes combined:** minimize aggressively, especially shadow passes
- **Triangles:** keep low enough that vertex deformation and rasterization do not dominate; draw-call reduction alone will not fix an overdraw-heavy scene

The commonly quoted mobile target is below roughly 100 calls, while several practical guides recommend staying below approximately 100–150 calls on mid-range mobile hardware.[1][2][3] These are heuristics, not hardware limits.

### Important limitation for deformable meshes

If every car has unique per-frame vertex deformation, ordinary instancing becomes less attractive unless:

- The deformation is generated in the vertex shader from compact parameters; or
- All cars share the same topology and you update one shared base/deformation representation; or
- Per-instance deformation data is supplied through instanced attributes, textures, or uniforms.

Uploading a separate full vertex buffer for 30 cars can erase the benefit of reducing draw calls. A good architecture is often:

- `InstancedMesh` for identical car bodies
- Shared static geometry
- Per-instance transform, color, damage, wheel angle, suspension, and deformation parameters
- Vertex-shader deformation where feasible
- Separate batches for materials that cannot be shared

Use `BatchedMesh` for varied geometries, but remember that batching does not remove the cost of all vertices being transformed and rasterized.

## 2. Partial buffer uploads: useful, but measure the actual byte range

For CPU-deformed geometry, update only the changed ranges:

```js
positionAttribute.addUpdateRange(startVertex * 3, vertexCount * 3);
positionAttribute.needsUpdate = true;
```

Use the current three.js API available in the version being shipped; older examples often use a single `updateRange`, while newer versions support multiple update ranges.

The benefit depends on the fraction changed:

- Updating 10% of a buffer can approach a large bandwidth reduction.
- Updating 80–100% usually provides little benefit over a full upload.
- Many tiny ranges can incur driver overhead; coalesce adjacent ranges.

For 30 cars, track:

```js
bytesUploadedPerFrame =
  sumOfChangedAttributeElements * bytesPerElement;
```

A 30-car example:

- 20,000 position vertices per car
- 30 cars
- 3 position components
- 4-byte floats

Full position upload:

\[
30 \times 20{,}000 \times 3 \times 4
= 7.2\ \text{MB/frame}
\]

At 60 FPS, that is about 432 MB/s before normals, tangents, skinning data, and driver copies. Updating only 20% reduces the logical upload to about 1.44 MB/frame, though the observed gain depends on browser and driver behavior.

Also consider avoiding CPU updates to normals when possible. Recompute normals in a shader, use precomputed deformation normals, or update normals at a lower frequency if visual quality permits.

## 3. Half-float and packed normals

Normals are a good candidate for bandwidth reduction because they are bounded and often tolerate modest precision loss.

Options include:

- `Float16BufferAttribute` for positions or normals where supported and visually acceptable
- Packed normalized `snorm16`-style representations
- Octahedral normal encoding
- `RGB10_A2`-style packed formats where the pipeline supports them
- Shader reconstruction of the third normal component

Potential benefits:

- Roughly half the attribute bandwidth when replacing 32-bit floats with 16-bit values
- Lower GPU memory traffic
- Better cache utilization

Tradeoffs:

- Half-float positions can show deformation jitter, especially with large world coordinates.
- Packed normals require decode instructions.
- Normal-map and tangent-space pipelines may expose artifacts sooner than simple Lambertian shading.
- WebGL/browser support and attribute-type behavior must be tested on both Adreno and Mali.

A robust compromise is often:

- Keep positions at 32-bit float if deformation precision matters.
- Use half-float or packed normals/tangents.
- Keep car-local coordinates near the origin and apply object transforms separately.

## 4. Shadows: often the largest GPU cost after resolution

Shadow rendering multiplies geometry work. A car that casts shadows may be rendered once per shadow-casting light, and cascaded directional shadows render multiple shadow views.

Start with:

- Shadow map size: **512² or 1024²**
- One shadow-casting directional light
- One or two cascades at most
- Disable shadows for distant or insignificant cars
- Use a separate low-detail shadow caster mesh
- Avoid transparent shadow casters where possible
- Tighten the light’s shadow camera bounds
- Increase shadow bias carefully rather than using excessive map resolution

A 2048² shadow map has four times the texels of a 1024² map and sixteen times those of a 512² map. If cascades use equal-sized maps, two cascades approximately double the shadow rendering and sampling cost.

For a car game, a strong mobile configuration is often:

- One 1024² map on higher-end devices
- One 512² map on lower-end devices
- One cascade, or no cascades unless the camera covers a large depth range
- Contact shadows or baked/cheap local shading for nearby visual detail

Do not judge shadow cost only from the main camera’s draw-call counter: shadow passes can dominate GPU time while looking inexpensive in the main scene.

## 5. MSAA versus FXAA

For mobile WebGL, MSAA can be expensive because it increases multisample color/depth storage and resolve bandwidth. FXAA avoids multisampled render targets but costs an additional full-screen shader pass.

A practical decision rule:

- Use **FXAA** when the scene is pixel-fill or bandwidth limited.
- Use **MSAA** when geometry edges are the dominant artifact and the render target is modest.
- Avoid combining high MSAA, high DPR, and several post-processing passes.

FXAA is not automatically cheaper: at high pixel ratios it still shades every output pixel, and it can blur fine details. At reduced DPR, however, FXAA is often a good mobile-quality compromise.

## 6. Pixel-ratio scaling: usually one of the safest large wins

Rendering cost is approximately proportional to pixel count:

\[
\text{pixel cost} \propto
(\text{CSS width} \times \text{DPR})
(\text{CSS height} \times \text{DPR})
\]

Therefore:

- DPR 3 versus DPR 1.5: **4× more pixels**
- DPR 2 versus DPR 1: **4× more pixels**
- DPR 1.5 versus DPR 1: **2.25× more pixels**

Use a dynamic cap rather than trusting `devicePixelRatio`:

```js
const maxDpr = isLowEnd ? 1.0 : 1.5;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr));
```

A practical adaptive scheme:

- Start at 1.25–1.5 on Android
- Drop toward 1.0 when GPU frame time exceeds the budget
- Raise gradually only after sustained headroom
- Keep UI rendering separate if it needs native resolution

For 60 FPS, the frame budget is 16.67 ms; for 30 FPS, it is 33.3 ms. A GPU budget of roughly 10–12 ms at a 60-FPS target leaves room for CPU work, browser overhead, and thermal variation.

## 7. Render targets and post-processing

Every full-resolution render target can consume substantial memory bandwidth, especially with:

- HDR color buffers
- Depth textures
- Multiple ping-pong targets
- Bloom
- SSAO
- Motion blur
- TAA history
- Multiple intermediate formats

Prefer:

- One scene render target where possible
- Half-resolution bloom, SSAO, and blur
- Fewer ping-pong stages
- Reusing render targets
- No depth texture unless required
- No separate normal/material buffers unless the effect genuinely needs them
- Combining simple color operations into one pass

A single extra full-screen pass may be cheaper than an extra shadow cascade, but several high-resolution passes can quickly dominate. Profile each pass separately rather than assuming post-processing is negligible.

## 8. `mediump` precision

Use `mediump` selectively in fragment shaders:

```glsl
precision mediump float;
```

It is generally appropriate for:

- Colors
- UV calculations
- Fog factors
- Simple lighting terms
- FXAA kernels
- Bloom threshold and blur calculations

Retain `highp` where needed for:

- World-space position
- Depth reconstruction
- Large coordinate ranges
- Shadow comparisons
- Screen-space effects sensitive to precision
- Long-distance camera calculations

Adreno and Mali differ in their precision implementations and performance characteristics, so validate both. `mediump` is not guaranteed to produce a dramatic speedup; it is most valuable when it reduces register pressure, improves occupancy, or avoids expensive high-precision arithmetic in fragment-heavy shaders.

## 9. Avoid material recompiles and pipeline churn

Material recompiles often appear as frame spikes rather than a consistently low frame rate.

Avoid changing frequently:

- `material.defines`
- `material.transparent`
- `material.alphaTest`
- `material.fog`
- `material.lights`
- Texture presence
- Shader source
- Color-space-related material configuration
- Shadow-related feature flags

Prefer:

- One stable material variant per feature set
- Uniform updates for animation and deformation parameters
- Prewarming visible materials before gameplay
- Reusing textures and materials
- Avoiding repeated material cloning
- Keeping shader branches stable

Compile all likely combinations during loading or a noninteractive warm-up phase.

## 10. Frustum culling with deformed bounds

Three.js culling uses object bounds, but CPU deformation does not automatically make those bounds correct. An incorrectly small bound can cause visible popping; an excessively large bound can eliminate the value of culling.

Options:

- Compute a conservative static bound containing the maximum deformation.
- Update bounding spheres/boxes only when deformation crosses a meaningful threshold.
- Use car-local bounds plus object transforms.
- Split large cars into cullable parts only if the additional draw calls are affordable.
- For instanced objects, update `instanceMatrix` bounds conservatively; ordinary instance culling does not provide independent per-instance visibility in the same way as separate meshes.
- Use `BatchedMesh` when per-object culling is important and the geometries/materials are compatible.

Culling will help most when many cars are outside the camera or shadow frusta. It will help little when all 30 cars occupy the screen.

## Recommended first experiment

Test these configurations on at least one mid-range Adreno and one mid-range Mali device in both browsers:

1. **Baseline:** current architecture, DPR capped at 1.5.
2. **Batching:** identical cars in `InstancedMesh`; shared materials.
3. **Uploads:** partial position ranges; coalesced updates; no unnecessary normal uploads.
4. **Shadows:** 512², one cascade or none.
5. **Post-processing:** half-resolution effects; remove one full-screen pass.
6. **Precision:** `mediump` in fragment-only paths.
7. **Adaptive quality:** DPR and shadow resolution reduced when GPU time exceeds budget.

Record separately:

- CPU frame time
- GPU frame time, if available
- `renderer.info.render.calls`
- `renderer.info.render.triangles`
- Shadow-pass time
- Main-pass time
- Post-processing time
- Bytes logically uploaded per frame
- Number of material/program changes
- Thermal behavior after 5–10 minutes

The most likely high-value combination for this workload is **shared materials plus batching, DPR around 1–1.5, 512–1024² shadows with minimal cascades, partial position uploads, and half-resolution post-processing**. Draw-call guidance consistently identifies sub-100 mobile calls as a useful target, but actual gains depend on whether the workload is CPU submission-bound, vertex-upload-bound, shadow-bound, or fill-rate-bound.[1][2][3]

[1] Three.js Performance Optimization: Best Practices for High-FPS (https://metadesignsolutions.com/blog/threejs-performance-optimization-best-practices)
[2] marceloretana.com · checklist · threejs-performanceThree.js Performance Checklist: 24 Essential Steps (https://marceloretana.com/checklist/threejs-performance-checklist)
[3] Article 09: Performance: Instancing, LOD, Draw Calls — Three ... (https://masterallarts.com/learn/threejs-from-zero/09-performance-instancing-lod/)
[4] 100 Three.js Tips That Actually Improve Performance (2026) - Utsubo (https://www.utsubo.com/blog/threejs-best-practices-100-tips)
[5] Three.js Performance Optimisation: 60fps Patterns | IGC (https://www.intelligentgraphicandcode.com/development/threejs-interfaces/performance)
[6] InstancedMesh – three.js docs (https://threejs.org/docs/pages/InstancedMesh.html)
[7] BatchedMesh – three.js docs (https://threejs.org/docs/pages/BatchedMesh.html)
[8] How to Build a 3D Product Configurator for E-Commerce in 2026 ... (https://kanopylabs.com/blog/how-to-build-a-3d-product-configurator)
[9] Three.js Performance: Instancing, LOD, and Draw Call Batching (https://www.aetumi.app/news/threejs-performance-instancing-lod/)
[10] Three.js Performance Optimization: 7 Fixes for Low FPS (https://www.hontran.dev/blog/three-js-performance-optimization)
