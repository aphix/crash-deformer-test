import { detCos, hypot2 } from "../kernel/physics-core.js";
import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { FF_CLOSING, FF_CX, FF_CZ, FF_FD, FF_FNX, FF_FNZ, FF_FW, FF_FX, FF_FZ, FF_GAP, FF_NX, FF_NZ, FF_PEN, FF_SIZE, FOOT_FX, FOOT_FZ, FOOT_HL, FOOT_HW, FOOT_RX, FOOT_RZ, FOOT_SIZE, FOOT_X, FOOT_Z, footFace, PR_BASE, PR_COS, PR_ENDS, PR_GU, PR_GW, PR_HARD, PR_HX, PR_HZ, PR_ID, PR_KNOCK_V, PR_MASS, PR_R, PR_SIN, PR_TOP, PR_WALL, PR_X, PR_YAW, PR_Z, sideFace } from "../world/prism.ts";
import { C_ARG, C_DEPTH, C_NX, C_NY, C_NZ, HIT_SIZE, KNOCK, P_STRIDE, pointContact, PQ_SIZE, PQ_VX, PQ_VY, PQ_VZ, PQ_X, PQ_Y, PQ_Z, RIG, WALL, type Surface } from "../world/surfaces.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { type ContactBox, makeBox, partContact, solidFace } from "./external-contact.ts";
import { HIT_AHEAD, impulseCar, markApproach, wallBounce } from "./pair-contact.ts";
import { COM_Y, WALL_CRUSH } from "../vehicle/car-air.ts";
import { cageLift } from "../vehicle/car-cage-rig.ts";
import { UNDERSIDE } from "../vehicle/car-suspension.ts";

/** What a scene does with a car's prop contacts (`propContact`): the race records and draws them, the Lab reads them back. */
export type PropHits = {
  /** Knockable prop `index` was knocked off its spot by car `car`, flying off at (vx, vy, vz) m/s. */
  knock(index: number, car: number, vx: number, vy: number, vz: number): void;
  /** A contact worth FX at `at`, normal `n` out of the prop, `closing` m/s. */
  fx(at: THREE.Vector3, n: THREE.Vector3, closing: number): void;
  /** Solid prop `index` met by car `i` closing at `closing` m/s at (x, z), its normal (nx, nz) out of the prop. */
  wall(index: number, i: number, closing: number, x: number, z: number, nx: number, nz: number): void;
};

/**
 * The world heights (m) of the lowest and highest points of `car`'s drawn body (its cage's vertices, class lift on) as the group's own
 * quaternion tilts it, never a slice stale: a level car's keel and crown, a nose-down one's front-bottom and rear-top points.
 */
function bodySpan(car: DeformableCar, out: { low: number; high: number }): void {
  const { x, y, z, w } = car.group.quaternion;
  const rightY = 2 * (x * y + w * z);
  const upY = 1 - 2 * (x * x + z * z);
  const fwdY = 2 * (y * z - w * x);
  const cage = car.cage;
  const pos = cage.fields.pos;
  const lift = cageLift(car);
  let low = Infinity;
  let high = -Infinity;
  for (let k = 0; k < cage.style.vertexCount; k++) {
    const h = rightY * pos[k * 3]! + upY * (pos[k * 3 + 1]! + lift) + fwdY * pos[k * 3 + 2]!;
    if (h < low) low = h;
    if (h > high) high = h;
  }
  out.low = car.group.position.y + low;
  out.high = car.group.position.y + high;
}

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
/** The solid face of the prism the car is meeting this slice (`solidFace`), reused. */
const _face = makeBox();
/** The prism the car's doors are meeting this slice (`prismBox`), reused. */
const _solid = makeBox();
const _foot = new Float64Array(FOOT_SIZE);
const _hit = new Float64Array(FF_SIZE);

/**
 * The car this slice, as every solid meets it (`measure`): its body's lowest and highest points (m), its footprint (the cage's plan
 * box: the middle's offset (`cx` along right, `cz` along forward) from the origin, half width `hw`, half length `hl`, the far
 * corner's reach from the origin), how far past a solid's reach a hard-driving car is still asked about (`markApproach`), and the
 * plane of the wall piece whose hold face it was last held on (`braked`, the face's unit normal and its offset): the pieces of one
 * wall hold a car once.
 */
const _span = { low: 0, high: 0, cx: 0, cz: 0, hw: 0, hl: 0, reach: 0, ahead: 0, braked: false, nx: 0, nz: 0, off: 0 };

/** Two wall faces are one wall's: normals within 5° (cos), planes within this many metres of each other. */
const SAME_WALL_COS = 0.996;
const SAME_WALL_GAP = 0.25;
/** How far (m) past its footprint a prism still touches a car's doors and mirrors, and the margin the reach adds. */
const DOOR_REACH = 0.3;
/** The car as every solid meets it this slice: `_span` filled from its drawn body (`bodySpan`) and its cage's plan box. */
function measure(car: DeformableCar): void {
  const v = car.velocity;
  bodySpan(car, _span);
  const plan = car.cage.fields.planBox;
  _span.cx = (plan[0]! + plan[1]!) / 2;
  _span.cz = (plan[2]! + plan[3]!) / 2;
  _span.hw = (plan[1]! - plan[0]!) / 2;
  _span.hl = (plan[3]! - plan[2]!) / 2;
  _span.reach = hypot2(Math.max(-plan[0]!, plan[1]!), Math.max(-plan[2]!, plan[3]!));
  _span.ahead = v.x * v.x + v.z * v.z > WALL_CRUSH * WALL_CRUSH ? hypot2(v.x, v.z) * HIT_AHEAD : 0;
  _span.braked = false;
}

/** Whether wall piece `b` of `s` continues piece `a`'s face: its plane is within `SAME_WALL_GAP` (centres across `a`'s axis) and `SAME_WALL_COS` of it. */
function coplanar(P: Float64Array, a: number, b: number): boolean {
  const c = P[a + PR_COS]!;
  const n = P[a + PR_SIN]!;
  return Math.abs(detCos(P[a + PR_YAW]! - P[b + PR_YAW]!)) >= SAME_WALL_COS && Math.abs((P[b + PR_X]! - P[a + PR_X]!) * c - (P[b + PR_Z]! - P[a + PR_Z]!) * n) <= SAME_WALL_GAP;
}

/**
 * Wall piece `i`'s hold face (`solidFace` into `_face`, where the car meets it at the footprint's face): over each joint end it
 * goes on across the pieces that continue it in one plane, up to a car's footprint length, so a car over a joint is held on the wall's
 * one face. Each piece holding only its own half left the other half's masses out in front of it, and the crush hulls that
 * follow the masses read that as a hit deep in the face (the car was shoved back by it, a different crush each way it met the grid).
 */
function holdFace(s: Surface, i: number, hit: Float64Array): ContactBox {
  const P = s.p;
  const o = i * P_STRIDE;
  const reach = 2 * _span.hl;
  let lo = 0;
  for (let k = i; lo < reach && (P[k * P_STRIDE + PR_ENDS]! & 1) === 0 && k > 0 && P[(k - 1) * P_STRIDE + PR_WALL] === WALL && coplanar(P, o, (k - 1) * P_STRIDE); k--) lo += 2 * P[(k - 1) * P_STRIDE + PR_HZ]!;
  let hi = 0;
  for (let k = i; hi < reach && (P[k * P_STRIDE + PR_ENDS]! & 2) === 0 && k + 1 < s.count && P[(k + 1) * P_STRIDE + PR_WALL] === WALL && coplanar(P, o, (k + 1) * P_STRIDE); k++) hi += 2 * P[(k + 1) * P_STRIDE + PR_HZ]!;
  lo = Math.min(lo, reach);
  hi = Math.min(hi, reach);
  // Along the piece (its local z) the face's middle moves by half the difference of the two reaches.
  const shift = (hi - lo) / 2;
  const fx = hit[FF_FX]!;
  const fz = hit[FF_FZ]!;
  return solidFace(_face, hit[FF_FNX]!, hit[FF_FNZ]!, fx, fz, fx + P[o + PR_SIN]! * shift, fz + P[o + PR_COS]! * shift, hit[FF_FW]! + (lo + hi) / 2, hit[FF_FD]!);
}

/** `out` as prism `i` of `s` for `partContact`: its plan shape exact (a circle of radius `r`, or a box), its heights the prism's, its hardness the prism's. */
function prismBox(out: ContactBox, s: Surface, i: number): ContactBox {
  const P = s.p;
  const o = i * P_STRIDE;
  out.x = P[o + PR_X]!;
  out.z = P[o + PR_Z]!;
  out.y = (P[o + PR_BASE]! + P[o + PR_TOP]!) / 2;
  out.hy = (P[o + PR_TOP]! - P[o + PR_BASE]!) / 2;
  out.yaw = P[o + PR_YAW]!;
  out.round = P[o + PR_R]! > 0;
  out.hx = out.round ? P[o + PR_R]! : P[o + PR_HX]!;
  out.hz = out.round ? P[o + PR_R]! : P[o + PR_HZ]!;
  out.hardness = P[o + PR_HARD]!;
  out.fixed = true;
  return out;
}

/** Car `i` against prism `k` of `s` over a slice of `dt` s (`propContact`), the car as `measure` left it. */
function solidContact(car: DeformableCar, i: number, s: Surface, k: number, knocked: Uint8Array, hits: PropHits, dt: number): void {
  const P = s.p;
  const o = k * P_STRIDE;
  const role = P[o + PR_WALL];
  const id = P[o + PR_ID]!;
  // A rig's box (the slab, a press plate) meets a car through its own response; a sloped top (a ramp) through its body points (`sideContact`).
  if (role === RIG || (role === KNOCK && knocked[id] === 1) || _span.low >= P[o + PR_TOP]! || _span.high <= P[o + PR_BASE]! || sloped(s, k)) return;
  const v = car.velocity;
  const pos = car.group.position;
  _foot[FOOT_X] = pos.x + car.rightFlat.x * _span.cx + car.fwdFlat.x * _span.cz;
  _foot[FOOT_Z] = pos.z + car.rightFlat.z * _span.cx + car.fwdFlat.z * _span.cz;
  _foot[FOOT_RX] = car.rightFlat.x;
  _foot[FOOT_RZ] = car.rightFlat.z;
  _foot[FOOT_FX] = car.fwdFlat.x;
  _foot[FOOT_FZ] = car.fwdFlat.z;
  _foot[FOOT_HW] = _span.hw;
  _foot[FOOT_HL] = _span.hl;
  if (role !== KNOCK) partContact(car, prismBox(_solid, s, k), dt);
  const touched = footFace(P, o, _foot, v.x, v.z, dt, _hit);
  if (!touched) {
    if (_span.ahead > 0 && role !== KNOCK) markApproach(car, _hit[FF_GAP]!, _hit[FF_CLOSING]!);
    return;
  }
  const pen = _hit[FF_PEN]!;

  const nx = _hit[FF_NX]!;
  const nz = _hit[FF_NZ]!;
  const closing = Math.max(0, -(v.x * nx + v.z * nz));
  if (role !== KNOCK) markApproach(car, -pen, closing);
  _c.set(_hit[FF_CX]!, 0.5, _hit[FF_CZ]!);
  _n.set(nx, 0, nz);
  // A knockable prop goes at a hit closing above its knock speed (0: any touch); a slower one meets it as a solid (a lamp post under its fold speed).
  const knocks = role === KNOCK && closing > P[o + PR_KNOCK_V]!;
  if (knocks) {
    knocked[id] = 1;
    const mass = P[o + PR_MASS]!;
    const speed = hypot2(v.x, v.z);
    hits.knock(id, i, v.x * 1.1 - nx * 1.5, 2 + speed * 0.25, v.z * 1.1 - nz * 1.5);
    const keep = 1 - mass / (mass + 1400);
    if (car.deform.massActive) impulseCar(car, nx, 0, nz, mass * closing * 0.5);
    else {
      v.x *= keep;
      v.z *= keep;
    }
    if (closing > 2) hits.fx(_c, _n, closing * 0.4);
    return;
  }
  const hardness = P[o + PR_HARD]!;
  if (role !== WALL) {
    const box = solidFace(_face, _hit[FF_FNX]!, _hit[FF_FNZ]!, _hit[FF_FX]!, _hit[FF_FZ]!, _hit[FF_FX]!, _hit[FF_FZ]!, _hit[FF_FW]!, _hit[FF_FD]!);
    box.hardness = hardness;
    wallBounce(car, box, nx, nz, pen, dt, false);
    if (closing > 1.5) hits.fx(_c, _n, closing);
    hits.wall(id, i, closing, _hit[FF_CX]!, _hit[FF_CZ]!, nx, nz);
    return;
  }
  // A wall piece: held on the wall's face, which the wall's other pieces in this plane share, so once a slice.
  const fnx = _hit[FF_FNX]!;
  const fnz = _hit[FF_FNZ]!;
  const off = fnx * _hit[FF_FX]! + fnz * _hit[FF_FZ]!;
  const again = _span.braked && fnx * _span.nx + fnz * _span.nz >= SAME_WALL_COS && Math.abs(off - _span.off) <= SAME_WALL_GAP;
  const hold = holdFace(s, k, _hit);
  hold.hardness = hardness;
  wallBounce(car, hold, nx, nz, pen, dt, again);
  if (again) return;
  _span.braked = true;
  _span.nx = fnx;
  _span.nz = fnz;
  _span.off = off;
  if (closing > 1.5) hits.fx(_c, _n, closing);
  hits.wall(id, i, closing, _hit[FF_CX]!, _hit[FF_CZ]!, nx, nz);
}

/**
 * Car `i` against the prisms of `solids` near it over a slice of `dt` s: solid ones push the car out (and crumple it on a hard
 * hit); knockable ones not yet `knocked` fly off. The car's footprint meets each prism by the face it entered through
 * (`world/prism.ts` `footFace`), whatever the prism is: a prop, a race wall piece, a wedge's flank, a lamp post, a room wall.
 * A prism touches only a car whose body box (`lowestY`) spans part of its height: a car flying over it, or passing under it on
 * a road beneath its deck, clears it. The race's walls and props, the fleet's rigs and the Lab's room share it.
 */
export function propContact(car: DeformableCar, i: number, solids: Surface, knocked: Uint8Array, hits: PropHits, dt: number): void {
  measure(car);
  const pos = car.group.position;
  const count = solids.prismsNear(pos.x, pos.z, _span.reach + DOOR_REACH + _span.ahead);
  const list = solids.nearList;
  for (let n = 0; n < count; n++) solidContact(car, i, solids, list[n]!, knocked, hits, dt);
}

/** Fastest a side pushes a body point out (m/s): a point that came down deep in a wedge slides out, never teleports (a step's push stays under 1 cm); it ends this far (m) outside, so the push leaves nothing on its plane. */
const SIDE_PUSH_SPEED = 1;
const SIDE_PUSH_SKIN = 0.002;
/** Half the tread's flat (m) at wheel scale 1: the plan rectangle a tyre meets a side with; its rounded shoulders (the other 5 cm of the 10.4 cm half tread) give. */
const TREAD_HALF = 0.054;
const SIGNS = [-1, 1] as const;
const _pq = new Float64Array(PQ_SIZE);
const _pout = new Float64Array(HIT_SIZE);
const _pw = new THREE.Vector3();
const _pr = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _pcom = new THREE.Vector3();
/** The deepest side a body point of this slice is in: how far (m), its normal out of the prism, the point (plan) and the patch. */
const _side = { depth: 0, nx: 0, nz: 0, x: 0, z: 0, patch: -1 };

/** Whether prism patch `k` of `s` has a sloped top: a ramp's, met by the body's points (a plane top has no one height a rectangle could be over). */
function sloped(s: Surface, k: number): boolean {
  return s.p[k * P_STRIDE + PR_GU] !== 0 || s.p[k * P_STRIDE + PR_GW] !== 0;
}

/** Car-local point (`lx`, `ly`, `lz`) of `car`, as the body is posed, asked of the one query with its own velocity; a side of a ramp it is in is kept if it is the deepest. */
function askPoint(car: DeformableCar, s: Surface, lx: number, ly: number, lz: number): void {
  const q = car.group.quaternion;
  const pos = car.group.position;
  _pw.set(lx, ly, lz).applyQuaternion(q).add(pos);
  _pr.subVectors(_pw, pos).sub(_pcom.set(0, COM_Y, 0).applyQuaternion(q));
  _pv.crossVectors(car.angular, _pr).add(car.velocity);
  _pq[PQ_X] = _pw.x;
  _pq[PQ_Y] = _pw.y;
  _pq[PQ_Z] = _pw.z;
  _pq[PQ_VX] = _pv.x;
  _pq[PQ_VY] = _pv.y;
  _pq[PQ_VZ] = _pv.z;
  pointContact(_pq, car.slot, _pout);
  const depth = _pout[C_DEPTH]!;
  if (_pout[C_NY] !== 0 || !(depth > _side.depth)) return;
  const patch = _pout[C_ARG]!;
  if (!sloped(s, patch)) return;
  _side.depth = depth;
  _side.nx = _pout[C_NX]!;
  _side.nz = _pout[C_NZ]!;
  _side.x = _pw.x;
  _side.z = _pw.z;
  _side.patch = patch;
}

/**
 * The car's points against the sides of the sloped prisms of `s` (a wedge's flanks and back), over a slice of `dt` s: each tyre's
 * tread corners, every vertex of the cage (the drawn body, crushed as drawn) and the underside (the belly the rigid step carries: it
 * stands lower than the cage's sill, so a car on its side lies on it against a wedge's flank), as the one query answers them (`pointContact`: a
 * point is in a side when it came in by one, on the top when it came down onto it or is within the step a tyre mounts). The deepest
 * pushes the car out and takes the hit as a solid face does (`wallBounce`): a light touch bounces, a hard hit crushes. True when a
 * point was in a side. A plane top gives no height a plan rectangle could be over, so the rectangle (`propContact`) leaves sloped
 * prisms to the points.
 */
export function sideContact(car: DeformableCar, s: Surface, hits: PropHits, dt: number): boolean {
  _side.depth = 0;
  for (let w = 0; w < car.wheels.length; w++) {
    const wheel = car.wheels[w]!;
    const hw = TREAD_HALF * wheel.scale.x;
    const r = TYRE_R * wheel.scale.x;
    for (let a = 0; a < SIGNS.length; a++) {
      for (let b = 0; b < SIGNS.length; b++) askPoint(car, s, wheel.position.x + SIGNS[a]! * hw, wheel.position.y, wheel.position.z + SIGNS[b]! * r);
    }
  }
  const cage = car.cage;
  const pos = cage.fields.pos;
  const lift = cageLift(car);
  for (let k = 0; k < cage.style.vertexCount; k++) askPoint(car, s, pos[k * 3]!, pos[k * 3 + 1]! + lift, pos[k * 3 + 2]!);
  for (let k = 0; k < UNDERSIDE.length; k++) askPoint(car, s, UNDERSIDE[k]![0], UNDERSIDE[k]![2] + lift, UNDERSIDE[k]![1]);
  if (_side.depth <= 0) return false;
  const o = _side.patch * P_STRIDE;
  const nx = _side.nx;
  const nz = _side.nz;
  sideFace(s.p, o, nx, nz, _hit);
  const box = solidFace(_face, _hit[FF_FNX]!, _hit[FF_FNZ]!, _hit[FF_FX]!, _hit[FF_FZ]!, _hit[FF_FX]!, _hit[FF_FZ]!, _hit[FF_FW]!, _hit[FF_FD]!);
  box.hardness = s.p[o + PR_HARD]!;
  const v = car.velocity;
  const closing = Math.max(0, -(v.x * nx + v.z * nz));
  wallBounce(car, box, nx, nz, Math.min(_side.depth + SIDE_PUSH_SKIN, SIDE_PUSH_SPEED * dt), dt, false);
  car.deform.notifyContact();
  hits.wall(s.p[o + PR_ID]!, car.slot, closing, _side.x, _side.z, nx, nz);
  return true;
}
