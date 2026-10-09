import * as THREE from "three";
import { CAR_HALF, DeformableCar, type Hull } from "../vehicle/car.ts";
import { hypot2 } from "../deform/physics-util.ts";
import { bellyY, roofHeight, UPRIGHT } from "../vehicle/car-surfaces.ts";
import { detSin, detCos } from "../kernel/physics-core.js";

export const BARRIER_HALF = { x: 0.38, z: 1.96 };
/** The slab's top (m): `makeJerseyBarrier`'s profile peak. A car whose every mass clears it flies over (a ramp jump). */
export const BARRIER_TOP = 0.81;
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
/** satTwoHulls' overlap: a returned double was boxed on every hull pair. */
const _overlap = new Float64Array(1);
/** `satCars`' hull circles, car A's hulls from 0 and car B's from `CIRCLE_B`: per hull its centre x, z and the radius of the circle round its box. */
const MAX_HULLS = 8;
const CIRCLE_B = MAX_HULLS * 3;
const _circle = new Float64Array(MAX_HULLS * 6);

function hullCenter(car: DeformableCar, h: Hull, out: THREE.Vector3): void {
  const p = car.group.position;
  out.set(
    p.x + car.rightFlat.x * h.cx + car.fwdFlat.x * h.cz,
    0,
    p.z + car.rightFlat.z * h.cx + car.fwdFlat.z * h.cz,
  );
}

/** Max displacement per physics slice so a 30 m/s car cannot skip a 0.76 m wall; never shorter than `floor` (s, 1/240 unless the pacer is shedding load). */
export function physicsSlice(dt: number, vmax: number, floor = 1 / 240): number {
  const maxMove = 0.07;
  const cap = maxMove / Math.max(vmax, 4);
  return Math.min(dt, Math.max(floor, cap));
}

/** Fastest car this frame; `physicsSlice` sizes the sub-steps from it. A wreck's `speed` is the
 *  last driven value, so read the velocity followGroup measured from its masses. */
export function sliceSpeed(cars: readonly DeformableCar[]): number {
  let vmax = 8;
  for (let i = 0; i < cars.length; i++) vmax = Math.max(vmax, hypot2(cars[i]!.velocity.x, cars[i]!.velocity.z));
  return vmax;
}

/**
 * Bodies whose height bands overlap by less than this (m) are one on the other, not side by side: a car coming down on
 * another's roof (its belly 0.13 m up, the roof 1.3 m, bands 1.36 m tall) overlaps by 0.19 m when it touches, and the
 * plan SAT shoved it off before `CarSurfaces` carried it.
 */
const STACK_CLEAR = 0.3;
/** The slack (m) under a roof's crown that `STACK_CLEAR` allows a belly on it (0.3 less the 0.19 a sedan's overlap is when it touches). */
const ROOF_SLACK = 0.11;

/**
 * Whether two cars' bodies share a height band: each body's box (`CAR_HALF` above its ground point, as tilted)
 * spans `y ± (|right.y|·hx + |up.y|·hy + |fwd.y|·hz)` about its middle, less `STACK_CLEAR`. Car-car contact tests the
 * plan only, so a car flying over another (2 m up, or 1.95 m in the owner's fleet trace) or on a deck above it met it
 * there. Reads each group's world matrix (fresh after `refreshBasis`/`syncPose`).
 *
 * A car whose box bottom (plus its belly's rise over it, `bellyY`) is over the roof crown of the upright car under it
 * (`roofHeight`: that car's class lift on, its crush depth off, along its own up axis) less `ROOF_SLACK` is stacked on
 * it: the surfaces carry it and the plan SAT must not shove it off, whatever the body styles' roof heights and belly
 * lifts (a coupe's roof is lower than the box's, a monster's belly 0.48 m higher), however far the load has crushed
 * the roof (the box's slack is 0.11 m of crush; three sedans' weight is 0.12 m), however the car under tilts, and
 * whether this slice's contact pressed (`restsOn` flickers at rest). A car pitched over the other's roof has its nose
 * below its box's bottom less that rise and still shares.
 */
export function shareHeight(a: DeformableCar, b: DeformableCar): boolean {
  if (a.restsOn === b || b.restsOn === a) return false;
  const ea = a.group.matrixWorld.elements;
  const eb = b.group.matrixWorld.elements;
  const ha = Math.abs(ea[1]!) * CAR_HALF.x + Math.abs(ea[5]!) * CAR_HALF.y + Math.abs(ea[9]!) * CAR_HALF.z;
  const hb = Math.abs(eb[1]!) * CAR_HALF.x + Math.abs(eb[5]!) * CAR_HALF.y + Math.abs(eb[9]!) * CAR_HALF.z;
  const ca = ea[13]! + ea[5]! * CAR_HALF.y;
  const cb = eb[13]! + eb[5]! * CAR_HALF.y;
  if (Math.abs(ca - cb) >= ha + hb - STACK_CLEAR) return false;
  const aUnder = ca <= cb;
  const under = aUnder ? a : b;
  const over = aUnder ? b : a;
  const eu = aUnder ? ea : eb;
  const top = eu[13]! + eu[5]! * roofHeight(under);
  const eo = aUnder ? eb : ea;
  const bottom = eo[13]! + eo[5]! * bellyY(over);
  return !(eu[5]! > UPRIGHT && bottom >= top - ROOF_SLACK);
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
  _bRight.set(detCos(yaw), 0, -detSin(yaw));
  _bFwd.set(detSin(yaw), 0, detCos(yaw));

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
  _bRight.set(detCos(yaw), 0, -detSin(yaw));
  _bFwd.set(detSin(yaw), 0, detCos(yaw));
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

/** Whether the hulls overlap; the depth goes to `_overlap[0]`, the axis (b → a) to `_mtv`. */
function satTwoHulls(a: DeformableCar, ha: Hull, b: DeformableCar, hb: Hull): boolean {
  hullCenter(a, ha, _ha);
  hullCenter(b, hb, _hb);
  let minOverlap = Infinity;
  _mtv.set(0, 0, 0);
  // The four axes (a right, a forward, b right, b forward) without an array per hull pair.
  for (let k = 0; k < 4; k++) {
    const axis = k === 0 ? a.rightFlat : k === 1 ? a.fwdFlat : k === 2 ? b.rightFlat : b.fwdFlat;
    const ax = axis.x;
    const az = axis.z;
    const len = hypot2(ax, az);
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
    if (overlap <= 0) return false;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      _mtv.x = nx;
      _mtv.y = 0;
      _mtv.z = nz;
    }
  }
  // Out along the axis, b → a, by the cars' centres, not the hulls': a corner hull pushed past its partner's midplane
  // reads "out" the way that drives the whole cars deeper in, and the next pass picks the opposite pair (a hooked pair).
  if ((a.group.position.x - b.group.position.x) * _mtv.x + (a.group.position.z - b.group.position.z) * _mtv.z < 0) _mtv.negate();
  _overlap[0] = minOverlap;
  return true;
}

/** Hull `h` of `car` as a circle (centre and radius) at `_circle[o]`: boxes whose circles are clear of each other cannot overlap. */
function hullCircle(car: DeformableCar, h: Hull, o: number): void {
  hullCenter(car, h, _ha);
  _circle[o] = _ha.x;
  _circle[o + 1] = _ha.z;
  _circle[o + 2] = hypot2(h.hx, h.hz);
}

const carHulls = (c: DeformableCar): Hull[] => c.hulls();
/** The crush-hull getter for `satCars`, made once (a closure per call allocated on every SAT pass). */
export const carCrushHulls = (c: DeformableCar): Hull[] => c.crushHulls();

export function satCars(
  a: DeformableCar,
  b: DeformableCar,
  normalOut: THREE.Vector3,
  contactOut: THREE.Vector3,
  hullsOf: (car: DeformableCar) => Hull[] = carHulls,
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
  for (let i = 0; i < hullsA.length; i++) hullCircle(a, hullsA[i]!, i * 3);
  for (let j = 0; j < hullsB.length; j++) hullCircle(b, hullsB[j]!, CIRCLE_B + j * 3);
  for (let i = 0; i < hullsA.length; i++) {
    const ha = hullsA[i]!;
    if (i < SPLIT_HULLS) _pen[i] = 0;
    for (let j = 0; j < hullsB.length; j++) {
      const hb = hullsB[j]!;
      const apartX = _circle[i * 3]! - _circle[CIRCLE_B + j * 3]!;
      const apartZ = _circle[i * 3 + 1]! - _circle[CIRCLE_B + j * 3 + 1]!;
      const reach = _circle[i * 3 + 2]! + _circle[CIRCLE_B + j * 3 + 2]! + 1e-6;
      if (apartX * apartX + apartZ * apartZ > reach * reach) continue;
      if (!satTwoHulls(a, ha, b, hb)) continue;
      const hit = _overlap[0]!;
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
        // Field writes, not set(): out of line here, set() boxed its doubles.
        normalOut.x = mtvX;
        normalOut.y = 0;
        normalOut.z = mtvZ;
        contactOut.x = cx;
        contactOut.y = 0.36;
        contactOut.z = cz;
      }
    }
  }
  if (bestI < 0) return null;
  centreSquareHit(bestI, contactOut);
  return best;
}
