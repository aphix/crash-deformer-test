import * as THREE from "three";
import { DeformableCar, type Hull } from "./car.ts";

export const BARRIER_HALF = { x: 0.38, z: 1.96 };
export const BARRIER_MASS = 14000;

const _ha = new THREE.Vector3();
const _hb = new THREE.Vector3();
const _mtv = new THREE.Vector3();
const _bRight = new THREE.Vector3();
const _bFwd = new THREE.Vector3();

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
  let found = false;
  for (const h of hulls) {
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
    const score = overlapX * 2 + overlapZ * 0.15;
    if (!found || score > bestScore) {
      found = true;
      best = overlap;
      bestScore = score;
      const qx = THREE.MathUtils.clamp(lx, -hx, hx);
      const qz = THREE.MathUtils.clamp(lz, -BARRIER_HALF.z, BARRIER_HALF.z);
      contactOut.set(
        origin.x + _bRight.x * qx + _bFwd.x * qz,
        0.36,
        origin.z + _bRight.z * qx + _bFwd.z * qz,
      );
      if (overlapZ < overlapX) {
        normalOut.copy(_bFwd).multiplyScalar(lz >= 0 ? 1 : -1);
      } else {
        normalOut.copy(_bRight).multiplyScalar(lx >= 0 ? 1 : -1);
      }
    }
  }
  return found ? best : null;
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
  const bumperKeep = hx + 0.22 + alongFwd * 0.85;
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
  car.group.updateMatrixWorld();
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
  let found = false;
  for (const ha of hullsOf(a)) {
    for (const hb of hullsOf(b)) {
      const hit = satTwoHulls(a, ha, b, hb);
      if (hit && hit > best) {
        found = true;
        best = hit;
        normalOut.copy(_mtv);
        hullCenter(a, ha, _ha);
        hullCenter(b, hb, _hb);
        contactOut.set((_ha.x + _hb.x) * 0.5, 0.36, (_ha.z + _hb.z) * 0.5);
      }
    }
  }
  return found ? best : null;
}
