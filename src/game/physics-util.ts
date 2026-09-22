import * as THREE from "three";

/**
 * Base crash-physics numbers (sedan, dry asphalt, ~50 km/h NCAP-style pulse).
 *
 * Pulse duration 90–150 ms (Glass 2002: ~120 ms at 56 km/h, peak ~29 g).
 * Crumple travel 0.45–0.75 m. F Δt = m Δv — extending Δt cuts peak force.
 * Rear mass keeps world velocity until rails yield; that pile-in is the buckle.
 * Tire μ_peak ≈ 0.90, μ_slide ≈ 0.75. During the pulse the fronts scuff (~0.40).
 * Restitution of a crumpled structure is ~0–0.15 (not a bounce).
 */
export const CRASH = {
  pulseSec: 0.12,
  crushMeters: 0.65,
  muPeak: 0.9,
  muSlide: 0.75,
  muScuff: 0.4,
  grazeMps: 1.8,
  /** Hard cap — above this a mass has teleported, not crashed. */
  maxMassMps: 55,
} as const;

/**
 * How easily this node yields (1 = crash-box mild steel, 0 = UHSS cage).
 * Matches a typical sedan: bumper < 300 MPa, rails/doors HS, cabin UHSS/MHSS.
 */
export function regionSoftness(name: string): number {
  if (name.startsWith("bumper")) return 1;
  if (name.startsWith("wing")) return 0.78;
  // Cast lump — it displaces, it does not squash. Bugbear DeformEd tagged engine/base as their own params.
  if (name === "engineL" || name === "engineR") return 0.16;
  if (name.startsWith("rail")) return 0.3;
  if (name.startsWith("door")) return 0.22;
  if (name === "tank" || name === "axleR") return 0.34;
  if (name === "roof" || name === "cell") return 0.08;
  if (name.startsWith("hub")) return 0.06;
  return 0.2;
}

/** 0 below this region's yield, 1 at fatal. Closing in m/s. */
export function crushGate(closing: number, softness: number): number {
  const v = Math.max(0, closing);
  const min = CRASH.grazeMps + (1 - softness) * 9;
  const fatal = 7 + (1 - softness) * 26;
  if (v <= min) return 0;
  return THREE.MathUtils.clamp((v - min) / Math.max(0.5, fatal - min), 0, 1);
}

const FRONTAL_REF = 14;

/** Scale a one-shot impulse so 2000 slomo substeps ≠ 2000 wall hits. */
export function dtImpulseScale(dt: number): number {
  return THREE.MathUtils.clamp(dt * 60, 0.04, 1.2);
}

/** KE scale vs a 14 m/s NCAP pulse. 5 m/s is a parking bump; 22 m/s is a real crash. */
export function closingKeScale(closing: number): number {
  const v = Math.max(0, closing);
  return THREE.MathUtils.clamp((v * v) / (FRONTAL_REF * FRONTAL_REF), 0, 2.4);
}

export const TRANSFER = {
  belowMiddle: 0.1,
  atMiddle: 0.5,
  above: 0.62,
  packed: 1,
} as const;

export type CrushBands = { yield: number; middle: number; max: number };

/** Crush-travel bands (m) for a named mass. Soft crash-box yields farther. */
export function regionCrushBands(name: string): CrushBands {
  const soft = regionSoftness(name);
  const max = 0.12 + soft * 0.72;
  return { yield: max * 0.16, middle: max * 0.48, max };
}

/**
 * Downstream force fraction for a node.
 *
 * Below the middle crush band the node is still eating energy (~0.1).
 * Past middle, half goes through. Past max, 62% — crumple still dissipates
 * unless the node is physically packed against the one behind it (100%).
 */
export function forceTransfer(travel: number, bands: CrushBands, packed: boolean): number {
  if (packed) return TRANSFER.packed;
  const t = Math.max(0, travel);
  if (t < bands.middle) return TRANSFER.belowMiddle;
  if (t < bands.max) return TRANSFER.atMiddle;
  return TRANSFER.above;
}

/**
 * Impulse that cancels leftover closing this slice — never more than the
 * remaining approach speed, so slomo substeps cannot reverse into a rocket.
 */
export function cancelClosing(closing: number, pass: number, invSum: number, dt: number, e = 0): number {
  if (closing <= 1e-6 || invSum < 1e-12) return 0;
  const used = leftoverPass(closing, pass);
  const dtS = dtImpulseScale(dt);
  const bounce = 1 + THREE.MathUtils.clamp(e, 0, 0.08);
  const dv = Math.min(used * dtS * bounce, closing * bounce);
  return dv / invSum;
}

/** Positional SAT shove cap. 1/240 slomo must not teleport 0.09 m every substep. */
export function satPushCap(dt: number): number {
  return 0.01 + 0.08 * dtImpulseScale(dt);
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function vec3(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: round4(v.x), y: round4(v.y), z: round4(v.z) };
}

/** Remaining crumple travel, 1 = still a full crush zone, 0 = cabin-on-cabin. */
export function leftoverCrumple(travel: number): number {
  return THREE.MathUtils.clamp(travel / 1.5, 0, 1);
}

/**
 * Rigid leftover closing after crumple has taken its share.
 * `pass` is the node / face transfer fraction (0.1 / 0.5 / 0.62 / 1).
 */
export function leftoverPass(remain: number, pass: number): number {
  return Math.max(0, remain) * THREE.MathUtils.clamp(pass, 0, 1);
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
  const s = Math.hypot(vel.x, vel.z);
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
