import type * as THREE from "three";

/**
 * Keep a sphere inside [lo, hi] along one axis: the projection a kinematic press face or a ground plane gives a mass or a
 * debris bit. Only the tests of the clamp use it now (debris meets the ground and the car tops through the surface store).
 */
export function separateSphereFromBounds(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  radius: number,
  axis: "x" | "y" | "z",
  lo: number,
  hi: number,
): boolean {
  let hit = false;
  const p = pos[axis];
  if (p + radius > hi) {
    pos[axis] = hi - radius;
    if (vel[axis] > 0) vel[axis] = 0;
    hit = true;
  }
  if (p - radius < lo) {
    pos[axis] = lo + radius;
    if (vel[axis] < 0) vel[axis] = 0;
    hit = true;
  }
  return hit;
}
