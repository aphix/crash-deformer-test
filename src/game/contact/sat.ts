import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { CageStyle } from "../vehicle/car-cage.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";
import { hypot2 } from "../deform/physics-util.ts";
import { detSin, detCos } from "../kernel/physics-core.js";
import { bandAround, OUTLINE_REACH, outlineOf, SAMPLE, sampleAt, VERTICAL_CLEAR } from "./cage-outline.ts";

export const BARRIER_HALF = { x: 0.38, z: 1.96 };
/** The slab's top (m): `makeJerseyBarrier`'s profile peak. A car whose every mass clears it flies over (a ramp jump). */
export const BARRIER_TOP = 0.81;
export const BARRIER_MASS = 14000;

const _bRight = new THREE.Vector3();
const _bFwd = new THREE.Vector3();
/** `deepestIn`'s band of the other cage around a node: lowest and highest height. */
const _band = new Float64Array(2);

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

/**
 * Per direction of `deepestIn`, sums over the overlap patch in the container's frame, each node weighted by its depth: the weight,
 * the place (x, z), the world height, and the container's outline normal (x, z) there.
 */
const F_W = 0;
const F_X = 1;
const F_Z = 2;
const F_Y = 3;
const F_NX = 4;
const F_NZ = 5;
const F_BEST = 6;
const _inA = new Float64Array(7);
const _inB = new Float64Array(7);
const _grad = new Float64Array(2);

/**
 * How deep (m) the nodes of `a`'s plan outline reach into `b`'s plan (the signed distance field, the outline half a step further out
 * than its node), counting only nodes where the two bodies' heights overlap by more than `VERTICAL_CLEAR` there; 0 when none does.
 * That depth goes to `found[F_BEST]`; every such node also adds to `found`'s sums with its depth as weight: the overlap patch's
 * centre and outward normal (b's outline) in `b`'s frame, and its height in the world. Both cars' bases are fresh. (Out through
 * `found` and `SAMPLE`: a double returned or passed across a call V8 does not inline is a heap number.)
 */
function deepestIn(a: DeformableCar, b: DeformableCar, found: Float64Array): void {
  const outline = outlineOf(a);
  const style = b.cage.style;
  const plan = b.cage.planField();
  const fb = b.cage.fields;
  const box = fb.planBox;
  const xMin = box[0]! - OUTLINE_REACH;
  const xMax = box[1]! + OUTLINE_REACH;
  const zMin = box[2]! - OUTLINE_REACH;
  const zMax = box[3]! + OUTLINE_REACH;
  const ra = a.rightFlat;
  const fwA = a.fwdFlat;
  const rb = b.rightFlat;
  const fwB = b.fwdFlat;
  const dx = a.group.position.x - b.group.position.x;
  const dz = a.group.position.z - b.group.position.z;
  const tx = dx * rb.x + dz * rb.z;
  const tz = dx * fwB.x + dz * fwB.z;
  const m00 = ra.x * rb.x + ra.z * rb.z;
  const m01 = fwA.x * rb.x + fwA.z * rb.z;
  const m10 = ra.x * fwB.x + ra.z * fwB.z;
  const m11 = fwA.x * fwB.x + fwA.z * fwB.z;
  const ea = a.group.matrixWorld.elements;
  const eb = b.group.matrixWorld.elements;
  const liftA = CLASSES[carClass(a)].lift;
  const liftB = CLASSES[carClass(b)].lift;
  let best = 0;
  found.fill(0);
  for (let n = 0; n < outline.count; n++) {
    const x = outline.xs[n]!;
    const z = outline.zs[n]!;
    const bx = tx + m00 * x + m01 * z;
    const bz = tz + m10 * x + m11 * z;
    if (bx < xMin || bx > xMax || bz < zMin || bz > zMax) continue;
    SAMPLE[0] = bx;
    SAMPLE[1] = bz;
    sampleAt(plan, style);
    const depth = OUTLINE_REACH - SAMPLE[2]!;
    if (!(depth > 0)) continue;
    const yA = ea[13]! + ea[1]! * x + ea[9]! * z;
    const aLow = yA + ea[5]! * (outline.lows[n]! + liftA);
    const aHigh = yA + ea[5]! * (outline.highs[n]! + liftA);
    let low = Math.min(aLow, aHigh);
    let high = Math.max(aLow, aHigh);
    bandAround(fb, style, Math.round((bx - style.u0) / style.step) | 0, Math.round((bz - style.v0) / style.step) | 0, _band);
    if (_band[0]! <= _band[1]!) {
      const yB = eb[13]! + eb[1]! * bx + eb[9]! * bz;
      const bLow = yB + eb[5]! * (_band[0]! + liftB);
      const bHigh = yB + eb[5]! * (_band[1]! + liftB);
      low = Math.max(low, Math.min(bLow, bHigh));
      high = Math.min(high, Math.max(bLow, bHigh));
      if (high - low <= VERTICAL_CLEAR) continue;
    }
    if (depth > best) best = depth;
    outlineNormal(plan, style);
    found[F_W] += depth;
    found[F_X] += depth * bx;
    found[F_Z] += depth * bz;
    found[F_Y] += depth * (low + high) * 0.5;
    found[F_NX] += depth * _grad[0]!;
    found[F_NZ] += depth * _grad[1]!;
  }
  found[F_BEST] = best;
}

/** `_grad` ← the unit direction in which `plan` (a cage's plan distance field) grows fastest at frame (x, z): out of the outline; zero where it has none. */
function outlineNormal(plan: Float32Array, style: CageStyle): void {
  const h = style.step;
  const x = SAMPLE[0]!;
  const z = SAMPLE[1]!;
  SAMPLE[0] = x + h;
  sampleAt(plan, style);
  const xp = SAMPLE[2]!;
  SAMPLE[0] = x - h;
  sampleAt(plan, style);
  const gx = xp - SAMPLE[2]!;
  SAMPLE[0] = x;
  SAMPLE[1] = z + h;
  sampleAt(plan, style);
  const zp = SAMPLE[2]!;
  SAMPLE[1] = z - h;
  sampleAt(plan, style);
  const gz = zp - SAMPLE[2]!;
  const len = hypot2(gx, gz);
  _grad[0] = len > 1e-9 ? gx / len : 0;
  _grad[1] = len > 1e-9 ? gz / len : 0;
}

/**
 * Whether two cars' drawn bodies overlap in the plan, where their heights meet (the cage's top and bottom at each outline node; a
 * car over another or on its roof never does). Returns the depth (m) of the deeper side, or null. The contact is the overlap patch
 * itself, both ways: `contactOut` is the depth-weighted centre of every covered outline node of either cage (the point the contact's
 * pressure acts at), `normalOut` the depth-weighted mean of the outline normals there, pointing b → a (turned to the side of the
 * centres where the two cross). Neither car's list order nor one corner node picks them. The cages are as of the last slice's sync.
 */
export function satCars(a: DeformableCar, b: DeformableCar, normalOut: THREE.Vector3, contactOut: THREE.Vector3): number | null {
  const pa = a.group.position;
  const pb = b.group.position;
  const dx = pb.x - pa.x;
  const dz = pb.z - pa.z;
  if (dx * dx + dz * dz > 36) return null;

  a.refreshBasis();
  b.refreshBasis();
  deepestIn(a, b, _inA);
  deepestIn(b, a, _inB);
  const depthA = _inA[F_BEST]!;
  const depthB = _inB[F_BEST]!;
  if (depthA <= 0 && depthB <= 0) return null;

  // A's nodes inside B: B's frame, B's outline normal points out of B (b → a). B's nodes inside A: A's frame, A's normal points a → b.
  const wA = _inA[F_W]!;
  const wB = _inB[F_W]!;
  const w = wA + wB;
  const rb = b.rightFlat, fb = b.fwdFlat, ra = a.rightFlat, fa = a.fwdFlat;
  let nx = rb.x * _inA[F_NX]! + fb.x * _inA[F_NZ]! - (ra.x * _inB[F_NX]! + fa.x * _inB[F_NZ]!);
  let nz = rb.z * _inA[F_NX]! + fb.z * _inA[F_NZ]! - (ra.z * _inB[F_NX]! + fa.z * _inB[F_NZ]!);
  const nLen = hypot2(nx, nz);
  if (nLen > 1e-9) {
    nx /= nLen;
    nz /= nLen;
  } else {
    nx = 0;
    nz = 0;
  }
  const apart = nx * -dx + nz * -dz;
  if (apart < 0) {
    nx = -nx;
    nz = -nz;
  }
  if (nx === 0 && nz === 0) {
    const len = hypot2(dx, dz) || 1;
    nx = -dx / len;
    nz = -dz / len;
  }
  normalOut.x = nx;
  normalOut.y = 0;
  normalOut.z = nz;
  contactOut.x = (pb.x * wA + rb.x * _inA[F_X]! + fb.x * _inA[F_Z]! + pa.x * wB + ra.x * _inB[F_X]! + fa.x * _inB[F_Z]!) / w;
  contactOut.y = (_inA[F_Y]! + _inB[F_Y]!) / w;
  contactOut.z = (pb.z * wA + rb.z * _inA[F_X]! + fb.z * _inA[F_Z]! + pa.z * wB + ra.z * _inB[F_X]! + fa.z * _inB[F_Z]!) / w;
  return Math.max(depthA, depthB);
}
