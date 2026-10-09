import * as THREE from "three";
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

/** The weight (N per kg) Coulomb friction presses with (`applyGroundFriction`): the real g, where the sim's falls use `GRAVITY`. */
export const FRICTION_G = 9.81;

export function applyGroundFriction(vel: THREE.Vector3, dt: number, mu: number, grounded: boolean): void {
  if (!grounded || dt <= 0) return;
  const s = hypot2(vel.x, vel.z);
  if (s < 1e-5) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const drop = Math.min(s, mu * FRICTION_G * dt);
  const k = (s - drop) / s;
  vel.x *= k;
  vel.z *= k;
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
