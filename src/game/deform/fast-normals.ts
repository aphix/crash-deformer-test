import * as THREE from "three";

/**
 * Area-weighted vertex normals straight on the typed arrays — the same sums in the same order as
 * `BufferGeometry.computeVertexNormals` (so the output matches it), without its per-vertex
 * `Vector3.fromBufferAttribute` / `setXYZ` round trips. Reuses the geometry's normal attribute;
 * allocates only if it is missing or the vertex count changed.
 */
export function computeNormalsFast(geometry: THREE.BufferGeometry): void {
  const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
  const pos = posAttr.array as Float32Array;
  let normalAttr = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!normalAttr || normalAttr.count !== posAttr.count || !(normalAttr.array instanceof Float32Array)) {
    normalAttr = new THREE.BufferAttribute(new Float32Array(posAttr.count * 3), 3);
    geometry.setAttribute("normal", normalAttr);
  }
  const nor = normalAttr.array as Float32Array;
  nor.fill(0);
  const index = geometry.index;
  const triCount = index ? index.count : posAttr.count;
  const idx = index ? index.array : null;
  for (let t = 0; t + 2 < triCount; t += 3) {
    const a = (idx ? idx[t]! : t) * 3;
    const b = (idx ? idx[t + 1]! : t + 1) * 3;
    const c = (idx ? idx[t + 2]! : t + 2) * 3;
    const bx = pos[b]!;
    const by = pos[b + 1]!;
    const bz = pos[b + 2]!;
    const cbx = pos[c]! - bx;
    const cby = pos[c + 1]! - by;
    const cbz = pos[c + 2]! - bz;
    const abx = pos[a]! - bx;
    const aby = pos[a + 1]! - by;
    const abz = pos[a + 2]! - bz;
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    nor[a] += nx;
    nor[a + 1] += ny;
    nor[a + 2] += nz;
    nor[b] += nx;
    nor[b + 1] += ny;
    nor[b + 2] += nz;
    nor[c] += nx;
    nor[c + 1] += ny;
    nor[c + 2] += nz;
  }
  for (let i = 0; i < nor.length; i += 3) {
    const x = nor[i]!;
    const y = nor[i + 1]!;
    const z = nor[i + 2]!;
    const inv = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    nor[i] = x * inv;
    nor[i + 1] = y * inv;
    nor[i + 2] = z * inv;
  }
  normalAttr.needsUpdate = true;
}
