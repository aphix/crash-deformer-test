import * as THREE from "three";
import { activeGround } from "../world/ground.ts";
import { CRASH, hypot2, round4 } from "../kernel/physics-core.js";

export {
  CRASH,
  TRANSFER,
  regionSoftness,
  crushGate,
  dtImpulseScale,
  closingKeScale,
  regionCrushBands,
  forceTransfer,
  leftoverPass,
  leftoverCrumple,
  crushStroke,
  cancelClosing,
  satPushCap,
  round4,
  hypot2,
  hypot3,
  type CrushBands,
} from "../kernel/physics-core.js";

/**
 * Base crash-physics numbers (sedan, dry asphalt, ~50 km/h NCAP-style pulse).
 * Kernels live in physics-core.js so the hot path is not TS-transformed.
 */

export function vec3(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: round4(v.x), y: round4(v.y), z: round4(v.z) };
}


/** Kill NaNs and clamp |v| so a bad polar/impulse cannot light-speed the car. */
export function clampSpeed(vel: THREE.Vector3, max = CRASH.maxMassMps): void {
  const sp2 = vel.lengthSq();
  if (!Number.isFinite(sp2)) {
    vel.set(0, 0, 0);
    return;
  }
  if (sp2 > max * max) vel.multiplyScalar(max / Math.sqrt(sp2));
}

export function applyGroundFriction(vel: THREE.Vector3, dt: number, mu: number, grounded: boolean): void {
  if (!grounded || dt <= 0) return;
  const s = hypot2(vel.x, vel.z);
  if (s < 1e-5) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const drop = Math.min(s, mu * 9.81 * dt);
  const k = (s - drop) / s;
  vel.x *= k;
  vel.z *= k;
}

/** `out[i]`: the active ground's height under `p` on its layer (`NO_FLOOR` past the fleet disc's rim). A point
 *  in and a typed array out: in a hot caller whose inlining budget TurboFan had spent, the `Ground` call
 *  boxed its three arguments and its result. */
export function floorUnder(p: { x: number; y: number; z: number }, out: Float64Array, i: number): void {
  out[i] = activeGround().heightAt(p.x, p.z, p.y);
}

/** `out[i]`: the active ground's grip under `p` on its layer (see `floorUnder`). */
export function gripUnder(p: { x: number; y: number; z: number }, out: Float64Array, i: number): void {
  out[i] = activeGround().frictionAt(p.x, p.z, p.y);
}

export function snapshotPoints(
  px: ArrayLike<number>,
  py: ArrayLike<number> | null,
  pz: ArrayLike<number> | null,
  life: ArrayLike<number>,
  packed: boolean,
  cap = 16,
): { count: number; items: { x: number; y: number; z: number; life: number }[] } {
  const items: { x: number; y: number; z: number; life: number }[] = [];
  const n = life.length;
  for (let i = 0; i < n && items.length < cap; i++) {
    if (life[i]! <= 0) continue;
    const y = packed ? px[i * 3 + 1]! : py![i]!;
    if (y > 80 || y < -1) continue;
    if (packed) {
      items.push({
        x: round4(px[i * 3]!),
        y: round4(px[i * 3 + 1]!),
        z: round4(px[i * 3 + 2]!),
        life: round4(life[i]!),
      });
    } else {
      items.push({
        x: round4(px[i]!),
        y: round4(py![i]!),
        z: round4(pz![i]!),
        life: round4(life[i]!),
      });
    }
  }
  return { count: items.length, items };
}

/**
 * Keep a sphere inside [lo, hi] along one axis. Used for kinematic press
 * faces, ground planes, etc. — same projection for masses and debris.
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

/**
 * Push a sphere out of an AABB and kill inbound speed on the contact axis.
 * Same response for cars, jersey barriers, press platens, poles.
 */
export function separateSphereFromAabb(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  radius: number,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): boolean {
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  const dz = pos.z - cz;
  const ox = hx + radius - Math.abs(dx);
  const oy = hy + radius - Math.abs(dy);
  const oz = hz + radius - Math.abs(dz);
  if (ox <= 0 || oy <= 0 || oz <= 0) return false;
  if (ox <= oy && ox <= oz) {
    const s = dx >= 0 ? 1 : -1;
    pos.x += s * ox;
    if (vel.x * s < 0) vel.x = 0;
  } else if (oy <= oz) {
    const s = dy >= 0 ? 1 : -1;
    pos.y += s * oy;
    if (vel.y * s < 0) vel.y *= -0.2;
  } else {
    const s = dz >= 0 ? 1 : -1;
    pos.z += s * oz;
    if (vel.z * s < 0) vel.z = 0;
  }
  return true;
}
