import * as THREE from "three";
import { DeformableCar, type Hull } from "./car.ts";

export const BARRIER_HALF = { x: 0.38, z: 1.96 };
export const BARRIER_MASS = 14000;

const _ha = new THREE.Vector3();
const _hb = new THREE.Vector3();
const _mtv = new THREE.Vector3();
const _bRight = new THREE.Vector3();
const _bFwd = new THREE.Vector3();
/** Split hull slots (front L/R 0–1, cabin 2, rear L/R 3–4) whose contacts B2 can pair up. */
const SPLIT_HULLS = 5;
const _pen = new Float64Array(SPLIT_HULLS);
const _cx = new Float64Array(SPLIT_HULLS);
const _cz = new Float64Array(SPLIT_HULLS);

export function hullCenter(car: DeformableCar, h: Hull, out: THREE.Vector3): void {
  const p = car.group.position;
  out.set(
    p.x + car.rightFlat.x * h.cx + car.fwdFlat.x * h.cz,
    0,
    p.z + car.rightFlat.z * h.cx + car.fwdFlat.z * h.cz,
  );
}

/** Max displacement per physics slice so a 30 m/s car cannot skip a 0.76 m wall. */
export function physicsSlice(dt: number, vmax: number): number {
  const maxMove = 0.07;
  const cap = maxMove / Math.max(vmax, 4);
  return Math.min(dt, Math.max(1 / 240, cap));
}

/** Fastest car this frame; `physicsSlice` sizes the sub-steps from it. A wreck's `speed` is the
 *  last driven value, so read the velocity followGroup measured from its masses. */
export function sliceSpeed(cars: readonly DeformableCar[]): number {
  let vmax = 8;
  for (const car of cars) vmax = Math.max(vmax, Math.hypot(car.velocity.x, car.velocity.z));
  return vmax;
}

export function satCarBarrier(
  car: DeformableCar,
  yaw: number,
  origin: THREE.Vector3,
  hx: number,
  normalOut: THREE.Vector3,
  contactOut: THREE.Vector3,
  hulls: Hull[] = car.hulls(),
): number | null {
  const pa = car.group.position;
  if ((pa.x - origin.x) ** 2 + (pa.z - origin.z) ** 2 > 64) return null;
  car.refreshBasis();
  _bRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  _bFwd.set(Math.sin(yaw), 0, Math.cos(yaw));

  let best = 0;
  let bestScore = 0;
  let bestI = -1;
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i]!;
    if (i < SPLIT_HULLS) _pen[i] = 0;
    hullCenter(car, h, _ha);
    const rx = _ha.x - origin.x;
    const rz = _ha.z - origin.z;
    const lx = rx * _bRight.x + rz * _bRight.z;
    const lz = rx * _bFwd.x + rz * _bFwd.z;
    const rX =
      Math.abs(car.rightFlat.x * _bRight.x + car.rightFlat.z * _bRight.z) * h.hx +
      Math.abs(car.fwdFlat.x * _bRight.x + car.fwdFlat.z * _bRight.z) * h.hz;
    const rZ =
      Math.abs(car.rightFlat.x * _bFwd.x + car.rightFlat.z * _bFwd.z) * h.hx +
      Math.abs(car.fwdFlat.x * _bFwd.x + car.fwdFlat.z * _bFwd.z) * h.hz;
    const overlapX = hx + rX - Math.abs(lx);
    const overlapZ = BARRIER_HALF.z + rZ - Math.abs(lz);
    if (overlapX <= 0 || overlapZ <= 0) continue;
    const overlap = Math.min(overlapX, overlapZ);
    const qx = THREE.MathUtils.clamp(lx, -hx, hx);
    const qz = THREE.MathUtils.clamp(lz, -BARRIER_HALF.z, BARRIER_HALF.z);
    const cx = origin.x + _bRight.x * qx + _bFwd.x * qz;
    const cz = origin.z + _bRight.z * qx + _bFwd.z * qz;
    if (i < SPLIT_HULLS) {
      _pen[i] = overlap;
      _cx[i] = cx;
      _cz[i] = cz;
    }
    const score = overlapX * 2 + overlapZ * 0.15;
    if (bestI < 0 || score > bestScore) {
      bestI = i;
      best = overlap;
      bestScore = score;
      contactOut.set(cx, 0.36, cz);
      if (overlapZ < overlapX) {
        normalOut.copy(_bFwd).multiplyScalar(lz >= 0 ? 1 : -1);
      } else {
        normalOut.copy(_bRight).multiplyScalar(lx >= 0 ? 1 : -1);
      }
    }
  }
  if (bestI < 0) return null;
  centreSquareHit(bestI, contactOut);
  return best;
}

/**
 * B2: when both split corner hulls of one end (0/1 front, 3/4 rear) are in
 * contact with penetrations within 30 % of each other, the hit is square —
 * put the contact between them so the impact snap keeps it centred.
 */
function centreSquareHit(bestI: number, contactOut: THREE.Vector3): void {
  const sib = bestI === 0 || bestI === 1 ? 1 - bestI : bestI === 3 || bestI === 4 ? 7 - bestI : -1;
  if (sib < 0) return;
  const a = _pen[bestI]!;
  const b = _pen[sib]!;
  if (a <= 0 || b <= 0 || Math.min(a, b) < Math.max(a, b) * 0.7) return;
  contactOut.x = (_cx[bestI]! + _cx[sib]!) * 0.5;
  contactOut.z = (_cz[bestI]! + _cz[sib]!) * 0.5;
}

/** Keep the cabin from crossing the jersey face. leftover=1 → bumper still on the face. */
export function clipCarToBarrier(
  car: DeformableCar,
  yaw: number,
  origin: THREE.Vector3,
  hx: number,
  leftover: number,
): boolean {
  car.refreshBasis();
  _bRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
  _bFwd.set(Math.sin(yaw), 0, Math.cos(yaw));
  const px = car.group.position.x - origin.x;
  const pz = car.group.position.z - origin.z;
  const lx = px * _bRight.x + pz * _bRight.z;
  const lz = px * _bFwd.x + pz * _bFwd.z;
  const alongFwd = Math.abs(car.fwdFlat.x * _bRight.x + car.fwdFlat.z * _bRight.z) * 2.05;
  const bumperKeep = hx + 0.22 + alongFwd * 0.85 * leftover;
  const cabinKeep = hx + 1.08;
  const minLx = THREE.MathUtils.lerp(cabinKeep, bumperKeep, leftover);
  if (Math.abs(lz) > BARRIER_HALF.z + 1.1) return false;
  // Face from position — a rebound vel flip must not drag the car through the slab.
  const side = lx >= 0 ? 1 : -1;
  if (lx * side >= minLx) return false;
  const extra = minLx - lx * side;
  const push = Math.min(extra, 0.16);
  car.group.position.x += _bRight.x * side * push;
  car.group.position.z += _bRight.z * side * push;
  car.refreshBasis();
  const vn = car.velocity.x * _bRight.x * side + car.velocity.z * _bRight.z * side;
  if (car.deform.massActive) {
    car.deform.separateAlong(_bRight.x * side, 0, _bRight.z * side, push);
    if (vn < 0) car.deform.kickCore(_bRight.x * side, 0, _bRight.z * side, -vn);
  }
  if (vn < 0) {
    car.velocity.x -= _bRight.x * side * vn;
    car.velocity.z -= _bRight.z * side * vn;
  }
  return true;
}

export function satTwoHulls(a: DeformableCar, ha: Hull, b: DeformableCar, hb: Hull): number | null {
  hullCenter(a, ha, _ha);
  hullCenter(b, hb, _hb);
  const axes = [a.rightFlat, a.fwdFlat, b.rightFlat, b.fwdFlat];
  let minOverlap = Infinity;
  _mtv.set(0, 0, 0);
  for (const axis of axes) {
    const ax = axis.x;
    const az = axis.z;
    const len = Math.hypot(ax, az);
    if (len < 1e-6) continue;
    const nx = ax / len;
    const nz = az / len;
    const ca = _ha.x * nx + _ha.z * nz;
    const ra =
      Math.abs(a.rightFlat.x * nx + a.rightFlat.z * nz) * ha.hx +
      Math.abs(a.fwdFlat.x * nx + a.fwdFlat.z * nz) * ha.hz;
    const cb = _hb.x * nx + _hb.z * nz;
    const rb =
      Math.abs(b.rightFlat.x * nx + b.rightFlat.z * nz) * hb.hx +
      Math.abs(b.fwdFlat.x * nx + b.fwdFlat.z * nz) * hb.hz;
    const overlap = Math.min(ca + ra, cb + rb) - Math.max(ca - ra, cb - rb);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      _mtv.set(nx, 0, nz);
    }
  }
  if ((_ha.x - _hb.x) * _mtv.x + (_ha.z - _hb.z) * _mtv.z < 0) _mtv.negate();
  return minOverlap;
}

export function satCars(
  a: DeformableCar,
  b: DeformableCar,
  normalOut: THREE.Vector3,
  contactOut: THREE.Vector3,
  hullsOf: (car: DeformableCar) => Hull[] = (c) => c.hulls(),
): number | null {
  const pa = a.group.position;
  const pb = b.group.position;
  const dx = pb.x - pa.x;
  const dz = pb.z - pa.z;
  if (dx * dx + dz * dz > 36) return null;

  a.refreshBasis();
  b.refreshBasis();
  let best = 0;
  let bestI = -1;
  const hullsA = hullsOf(a);
  const hullsB = hullsOf(b);
  for (let i = 0; i < hullsA.length; i++) {
    const ha = hullsA[i]!;
    if (i < SPLIT_HULLS) _pen[i] = 0;
    for (const hb of hullsB) {
      const hit = satTwoHulls(a, ha, b, hb);
      if (!hit) continue;
      const better = hit > best;
      const sibling = i < SPLIT_HULLS && hit > _pen[i]!;
      if (!better && !sibling) continue;
      const mtvX = _mtv.x;
      const mtvZ = _mtv.z;
      hullCenter(a, ha, _ha);
      hullCenter(b, hb, _hb);
      const cx = (_ha.x + _hb.x) * 0.5;
      const cz = (_ha.z + _hb.z) * 0.5;
      if (sibling) {
        _pen[i] = hit;
        _cx[i] = cx;
        _cz[i] = cz;
      }
      if (better) {
        bestI = i;
        best = hit;
        normalOut.set(mtvX, 0, mtvZ);
        contactOut.set(cx, 0.36, cz);
      }
    }
  }
  if (bestI < 0) return null;
  centreSquareHit(bestI, contactOut);
  return best;
}
