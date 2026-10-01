For 10–30 deforming car meshes updated on the CPU each frame, the main wins are: upload only changed vertex ranges, avoid recomputing normals on the CPU, reduce shadow cost aggressively, and collapse as many repeated/debris objects as possible into instanced or batched draws[1][2][6][14]. The most expensive part is usually not the vertex math itself but the per-frame buffer traffic, draw calls, and shadow passes[1][2][12].

## Practical recommendations

- Use `BufferAttribute.addUpdateRange(start, count)` plus `needsUpdate = true` so only modified components are uploaded to the GPU instead of the full buffer[1][3].
- Clear and re-add update ranges each frame when the modified span changes, because the current API supports multiple contiguous ranges rather than a single legacy range[1][3].
- If deformation is small or localized, keep vertex positions in a CPU-side typed array and upload only the touched sections; this maps to `gl.bufferSubData` behavior through partial updates[2].
- Avoid calling `computeVertexNormals()` every frame if possible, because it is costly for dynamic meshes; prefer transforming precomputed normals in the shader with the inverse-transpose normal matrix when deformation preserves the usefulness of the original normals[2].
- If deformation changes surface shape too much for transformed normals to remain acceptable, consider approximating with fewer normal updates, lower-frequency updates, or splitting the mesh so only the damaged section recomputes normals.
- Reduce or disable shadows on the deforming cars unless they are essential, because shadow maps add extra rendering passes and are often a major cost multiplier in scenes with many dynamic meshes[12].
- For debris, fragments, wheels, and other repeated objects, use `InstancedMesh` so many copies of the same geometry render in one draw call[14].
- If debris pieces share a material but differ in geometry, use `BatchedMesh` to reduce draw calls while still keeping per-object transforms and culling support[6][2].
- Move physics and deformation prep off the main thread using Web Workers, and use `SharedArrayBuffer` for efficient shared state when cross-origin isolation is available; this helps preserve frame time even if the total CPU work stays similar[5].
- If physics is heavy, a WASM SIMD path can help, especially for broad-phase collision, constraint solving, or repeated vector math.
- For a more advanced pipeline, keep deformation clusters or “damage regions” in a data texture and apply them in the vertex shader, so CPU work only updates cluster transforms while the GPU handles per-vertex reconstruction.
- Profile first with `renderer.info.render.calls`, then Chrome DevTools Performance for frame timing and GC spikes, and `renderer.info.memory` for leaks and resource churn[8].
- Test with shadows off, then instancing/batching on, then partial uploads on, so the bottleneck becomes obvious step by step[8][12].

## Best-fit architecture for your case

- **Car body meshes:** CPU deformation is fine if update regions are small and partial uploads are used[1][2].
- **Normals:** transform precomputed normals in the shader where acceptable; only recompute on the CPU when the deformation visibly breaks shading[2].
- **Debris:** `InstancedMesh` first; `BatchedMesh` when debris pieces are not identical but share a material[6][14].
- **Physics:** move to a worker; share buffers for positions, transforms, and collision state[5].
- **Advanced deformation:** if many cars deform similarly, drive cluster transforms from a data texture and do the final deformation in the vertex shader to cut CPU uploads.

## Profiling order

1. Measure baseline frame time and draw calls[8].
2. Disable shadows and compare[12].
3. Switch repeated objects to instancing or batching[6][14].
4. Replace full-buffer uploads with partial updates[1][2][3].
5. Move physics off-thread[5].
6. Only then consider GPU-side deformation or shader-based cluster skinning.

If helpful, a compact implementation plan can be drafted next for either:
- a CPU-deformation path using partial buffer uploads, or
- a GPU-cluster deformation path using a data texture.

[1] BufferAttribute – three.js docs (https://threejs.org/docs/pages/BufferAttribute.html)
[2] BufferGeometry & Vertex Data | mrdoob/three.js | DeepWiki (https://deepwiki.com/mrdoob/three.js/2.3-buffergeometry-and-vertex-data)
[3] Migration Guide · mrdoob/three.js Wiki (https://github.com/mrdoob/three.js/wiki/Migration-Guide/55ac079fd7f0cfab7f576e24a97f183a49fb5940)
[4] Migration Guide · mrdoob/three.js Wiki · GitHub (https://github.com/mrdoob/three.js/wiki/Migration-Guide/0405954911c7cfd005f4a93eed07116cf2246e6a)
[5] GitHub - zakky8/web-optimization: The definitive Three.js ... (https://github.com/zakky8/web-optimization)
[6] BatchedMesh – three.js docs (https://threejs.org/docs/pages/BatchedMesh.html)
[7] Migration Guide · mrdoob/three.js Wiki - GitHub (https://github.com/mrdoob/three.js/wiki/Migration-Guide)
[8] Three.js Performance Optimisation: 60fps Patterns | IGC (https://www.intelligentgraphicandcode.com/development/threejs-interfaces/performance)
[9] Migration Guide · mrdoob/three.js Wiki - GitHub (https://github.com/mrdoob/three.js/wiki/Migration-Guide/7ca1a2f749ea6d87c4b134f97ab47866e64f9abd)
[10] How to Use Three.js BufferAttribute updateRange - three.js (https://salivity.github.io/three.js/article/how-to-use-three-js-bufferattribute-updaterange)
[11] Migration Guide (https://github.com/mrdoob/three.js/wiki/Migration-Guide/e9a07ac56491e661dbff2d9fd8d482b594664046)
[12] WebGL best practices - Web APIs | MDN (https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
[13] A Practical Guide to Profiling and Optimizing WebGL Scenes (https://webeyez.com/insights/guides/three-js-performance-profile-guide)
[14] InstancedMesh – three.js docs (https://threejs.org/docs/pages/InstancedMesh.html)
[15] glance/docs/notes/threejs-best-practices-100-tips.md at main ... (https://github.com/Xqd9912/glance/blob/main/docs/notes/threejs-best-practices-100-tips.md)
