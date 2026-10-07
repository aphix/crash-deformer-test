import * as THREE from "three";

/** Test helper, not a test file: what a set of meshes fills of the sun's shadow map, as a texel mask. */

/** The sun's shadow box over its map (`WorldStage`: 48 m over 1024 texels): one texel in metres. */
const TEXEL = 48 / 1024;
/** The mask's side, in texels: 7.5 m, past any car's footprint. */
export const MASK_SIDE = 160;
/** From the ground to the sun (`WorldStage` / `RaceField` sun offset). */
const TO_SUN = new THREE.Vector3(-10, 22, 9).normalize();
const AXIS_U = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), TO_SUN).normalize();
const AXIS_V = new THREE.Vector3().crossVectors(TO_SUN, AXIS_U).normalize();

/** The side three draws into the shadow map: the opposite face unless the material says otherwise. */
const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide } as const;

const _world = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
const _edgeA = new THREE.Vector3();
const _edgeB = new THREE.Vector3();
const _normal = new THREE.Vector3();

/** Fill `mask` with the triangles of `mesh` the shadow pass draws, projected along the sun onto texels centred on `centre`. */
function fillMask(mesh: THREE.Mesh, centre: THREE.Vector3, mask: Uint8Array): void {
  const material = mesh.material as THREE.Material;
  const side = material.shadowSide ?? SHADOW_SIDE[material.side];
  const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = mesh.geometry.index;
  const count = index ? index.count : position.count;
  const centreU = centre.dot(AXIS_U);
  const centreV = centre.dot(AXIS_V);
  mesh.updateWorldMatrix(true, false);
  const p = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const corner = _world[k]!.fromBufferAttribute(position, index ? index.getX(t + k) : t + k).applyMatrix4(mesh.matrixWorld);
      p[k * 2] = (corner.dot(AXIS_U) - centreU) / TEXEL + MASK_SIDE / 2;
      p[k * 2 + 1] = (corner.dot(AXIS_V) - centreV) / TEXEL + MASK_SIDE / 2;
    }
    _normal.crossVectors(_edgeA.subVectors(_world[1]!, _world[0]!), _edgeB.subVectors(_world[2]!, _world[0]!));
    const towardSun = _normal.dot(TO_SUN);
    if ((towardSun > 0 && side === THREE.BackSide) || (towardSun < 0 && side === THREE.FrontSide)) continue;
    const det = (p[2]! - p[0]!) * (p[5]! - p[1]!) - (p[4]! - p[0]!) * (p[3]! - p[1]!);
    if (Math.abs(det) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(p[0]!, p[2]!, p[4]!)));
    const maxX = Math.min(MASK_SIDE - 1, Math.ceil(Math.max(p[0]!, p[2]!, p[4]!)));
    const minY = Math.max(0, Math.floor(Math.min(p[1]!, p[3]!, p[5]!)));
    const maxY = Math.min(MASK_SIDE - 1, Math.ceil(Math.max(p[1]!, p[3]!, p[5]!)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const qx = x + 0.5 - p[0]!;
        const qy = y + 0.5 - p[1]!;
        const a = (qx * (p[5]! - p[1]!) - (p[4]! - p[0]!) * qy) / det;
        const b = ((p[2]! - p[0]!) * qy - qx * (p[3]! - p[1]!)) / det;
        if (a >= 0 && b >= 0 && a + b <= 1) mask[y * MASK_SIDE + x] = 1;
      }
    }
  }
}

/** The texels of the sun's shadow map the meshes fill (1 = shadowed), around `centre`. */
export function sunCoverage(meshes: readonly THREE.Mesh[], centre: THREE.Vector3): Uint8Array {
  const mask = new Uint8Array(MASK_SIDE * MASK_SIDE);
  for (const mesh of meshes) fillMask(mesh, centre, mask);
  return mask;
}

/** Texels `whole` fills that `part` leaves lit, and the texels `whole` fills. */
export function uncovered(whole: Uint8Array, part: Uint8Array): { missing: number; of: number } {
  let missing = 0;
  let of = 0;
  for (let i = 0; i < whole.length; i++) {
    if (!whole[i]) continue;
    of++;
    if (!part[i]) missing++;
  }
  return { missing, of };
}
