import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { NO_FLOOR } from "../world/ground.ts";
import { C_AUX, C_H, C_NX, C_NY, C_NZ, C_OWNER, C_PX, C_PY, C_PZ, C_TOUCH, EDGE_HIT, edgeCross, groundWalls, HIT_SIZE, MU_TYRE, patchOf, pointContact, PQ_SIZE, PQ_X, PQ_Y, PQ_Z, ridgeCross, wheelContact } from "../world/surfaces.ts";
import { HUB_FLOOR, TYRE_R } from "../deform/deform-state.ts";
import { hypot2 } from "../deform/physics-util.ts";
import { CAR_HALF, WHEEL_POS } from "./car-mesh.ts";
import { droop, PAN, SPRINGS, UNDERSIDE } from "./car-suspension.ts";
import { CLASSES, carClass } from "./vehicle-classes.ts";
import { CarSurfaces } from "./car-surfaces.ts";
import { FACES, FACE_AXIS, faceFollow } from "../deform/load-crush.ts";

/**
 * How a car meets the surfaces under it, one pass per slice (`world/surfaces.ts` answers every query): each wheel's tread
 * footprint (`wheelContact`) says how far its wheel must lift to clear, three or more wheels standing on the world fix the
 * body's height, pitch and roll to the rest plane through their contact points (`stepPlane`: the pose-following that keeps
 * a car level on a road and on a bank), and fewer leave the body a rigid box under gravity that turns about its centre of
 * mass (`stepFree`: its wheels, bumper, beltline, roof corners and belly meet what is under them through impulses with
 * restitution and friction, so it can land on its wheels, roof or side, rest on a ramp's edge, tip over or rock back).
 * `DeformableCar.airborne` is derived from the same contacts: no wheel within its springs' reach and no hull point in a surface.
 */
export const G = 9.6;
/** Centre of mass above the group's origin (car-local y, m); the origin is on the ground under the body's middle. */
export const COM_Y = 0.55;
/** Inverse inertia per unit mass (1/m²) of the body's box about its centre of mass: car-local x, y, z. */
const INV_I = new THREE.Vector3(3 / (CAR_HALF.y ** 2 + CAR_HALF.z ** 2), 3 / (CAR_HALF.x ** 2 + CAR_HALF.z ** 2), 3 / (CAR_HALF.x ** 2 + CAR_HALF.y ** 2));
/** Car-local hull points: the four hubs first (their tyres meet the ground through `wheelContact`), then bumper, beltline and roof corners. */
export const HULL: readonly (readonly [number, number, number])[] = [
  ...WHEEL_POS.map(([x, y, z]): [number, number, number] => [x, y, z]),
  ...[-1, 1].flatMap((sx) =>
    [-1, 1].flatMap((sz): [number, number, number][] => [
      [sx * CAR_HALF.x, 0.35, sz * CAR_HALF.z],
      [sx * CAR_HALF.x, 0.95, sz * 2.0],
      [sx * 0.7, 1.36, sz * 0.95],
    ]),
  ),
];
/**
 * The underside (car-local x, height, z): `UNDERSIDE`'s keel and rockers, and the belly between them 0.5 m either side of
 * the keel (its height interpolated), so a car on another's flat roof rests on its width, not balanced on the keel line, and `PAN`
 * (the belly's centre patch, car-suspension.ts): the only part of the belly that meets a car top's ridge between its points
 * (`ridgeCross`), since the hull lines past it slope down to the nose and stood under the pan at a roof's front edge (every car in a
 * stack rested 1° nose-up on the one under it).
 */
const BELLY: readonly (readonly [number, number, number])[] = [
  ...UNDERSIDE.map(([x, z, h]): [number, number, number] => [x, h, z]),
  ...[2, 1, 0, -2].flatMap((z) => {
    const keel = UNDERSIDE.find((p) => p[0] === 0 && p[1] === z)![2];
    const rocker = UNDERSIDE.find((p) => p[0] === 0.8 && p[1] === z)![2];
    return [-0.5, 0.5].map((x): [number, number, number] => [x, keel + (rocker - keel) * 0.625, z]);
  }),
  ...PAN,
];
/**
 * `HULL` plus the belly: the points a car meets another car's top with, and the world's ground when it bottoms out in
 * flight (a keel 4–5 cm in the road at 30 m/s, a car parked on a bank's crease, a car across a ramp's edge).
 */
const POINTS: readonly (readonly [number, number, number])[] = [...HULL, ...BELLY];
/** Where `PAN` starts in `POINTS`. */
const PAN_FROM = POINTS.length - PAN.length;
/** Neighbouring belly points as `POINTS` index pairs (along x at one z, along z at one x): where the two stand on different patches,
 *  the belly between them meets that patch's edge (`edgeCross`), as a ramp's crest does between rows half a metre apart. */
const SEGS: Int16Array = (() => {
  const pairs = new Int16Array(BELLY.length * BELLY.length);
  let m = 0;
  for (let i = 0; i < BELLY.length; i++) {
    for (let j = i + 1; j < BELLY.length; j++) {
      const [xi, , zi] = BELLY[i]!;
      const [xj, , zj] = BELLY[j]!;
      if (xi !== xj && zi !== zj) continue;
      let between = false;
      for (const [xk, , zk] of BELLY) {
        if (zi === zj && zk === zi && (xk - xi) * (xk - xj) < 0) between = true;
        if (xi === xj && xk === xi && (zk - zi) * (zk - zj) < 0) between = true;
      }
      if (between) continue;
      pairs[m++] = HULL.length + i;
      pairs[m++] = HULL.length + j;
    }
  }
  return pairs.slice(0, m);
})();
/** Contacts a body can hold in one slice: its tyres and points, and a belly segment's edge each. */
const CONTACTS = POINTS.length + SEGS.length / 2;
/** Bumper, beltline and roof corners (`HULL[4..]`): the body points whose face a hit crushes (`load-crush.ts`). */
const BODY_FROM = 4;
/** How far each body point follows each face's crush depth (`faceFollow`), per `FACES` row. */
const BODY_W = Float64Array.from({ length: HULL.length * FACES }, (_, k) => {
  const p = (k / FACES) | 0;
  const [x, y, z] = HULL[p]!;
  return p < BODY_FROM ? 0 : faceFollow(k % FACES, x, y, z);
});
/** A body at rest lifts out of its belly's depth in the ground by at most this (m) a slice: a body that has stopped on its belly can't pump energy, it only settles on it. */
export const REST_LIFT = 0.02;
/** A wheel this close (m) to the ground counts as down. */
export const TOUCH = 0.03;
/** Restitution of a body point closing faster than `BOUNCE_V` (m/s); slower contacts and tyres (their springs,
 *  `Suspension`, take a landing) don't bounce. */
const RESTITUTION = 0.25;
const BOUNCE_V = 1.5;
/** Friction: the body scraping, a tyre across its tread (it rolls freely along it). */
const MU_BODY = 0.6;
/** Below these speeds (m/s, rad/s) a body on three or more hull points is at rest (on two it can still tip), on ground
 *  whose mean up-normal is over `REST_UP` (cos 14°). */
const REST_V = 0.15;
const REST_W = 0.3;
const REST_UP = 0.97;
/** Contact is solved at this rate (Hz) however long the physics step (`stepWorld` splits it): a face's crush depth is the slice's own discretisation otherwise (8 % apart at 60 and 240 Hz). */
const CONTACT_HZ = 480;
/** How far (m) past its own approach a body point may be in a face and still have come down onto it (`fromSide`). */
const STAND_SLOP = 0.005;
/** A point on a face this shallow (normal's up component over it: a slope under 70°) pushes and lifts straight up: a tyre anywhere, in its springs and past their stop alike, and any body point on the world's ground (no drag on the world: the drive grips). A steeper face is a wall: the point pushes along its normal. */
const CLIMB_NY = 0.34;

/**
 * Whether a body point `sink` m in a face (along the face's normal), moving at `vn` m/s along that normal (closing < 0), reached
 * it from the side in a slice of `dt` s: deeper than its own approach explains, it crossed the face's wall (a wedge's end or
 * flank), it did not come down onto the face. Over a ground with walls, `stepFree` takes no contact from such a hull point and
 * the wall (`FleetRamps.contact`) parts it: lifted out by its depth, a front bumper crossing a wedge's end 0.117 m under its top
 * raised the body 0.113 m in one slice (fleet-ramps D1).
 */
export function fromSide(sink: number, vn: number, dt: number): boolean {
  return sink > STAND_SLOP + Math.max(0, -vn) * dt;
}

const _r = new THREE.Vector3();
const _com = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _eul = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const _up = new THREE.Vector3();
const _fd = new THREE.Vector3();
/** A driven car's Euler yaw drifts by up to this (rad) in a rigid turn before it is a tumble (a flip is no heading). */
const YAW_HOLD = 0.5;
const _qi = new THREE.Quaternion();
const _x = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _k = new THREE.Vector3();
const _tn = new THREE.Vector3();
const R = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
const _lift = new THREE.Vector3();
const N = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
/** Per contact: the direction its impulse and its lift go: up for a tyre on a face it can climb, else the face's normal. */
const DIR = Array.from({ length: CONTACTS }, () => UP);
const TYRE = Array.from({ length: CONTACTS }, () => false);
const SOFT = Array.from({ length: CONTACTS }, () => false);
/** Per contact: the face slot it presses (-1 rigid), the car whose top it stands on (-1 the world), how far that point follows its crush, its sink past what holds it. */
const SLOT = Array.from({ length: CONTACTS }, () => -1);
const OWN = Array.from({ length: CONTACTS }, () => -1);
const FOLLOW = Array.from({ length: CONTACTS }, () => 1);
const SINK = Array.from({ length: CONTACTS }, () => 0);
/** Per tyre in its springs: how far (m, vertical) its spring is pressed past the rest ride, negative while it hangs toward its droop. */
const PRESS = new Float64Array(CONTACTS);
/** Per tyre in its springs: the impulse (per unit mass) its spring and damper push with this slice, what its face carries of it. */
const ASK = new Float64Array(CONTACTS);
/**
 * Per contact of the rigid solve: its normal impulse over the passes; the first contact pressing the same face slot (-1: a rigid
 * surface); and, at that first contact, what the slot carries this slice, the most its contacts asked of it, and their sum in a pass.
 */
const ACC = new Float64Array(CONTACTS);
const FIRST = new Int32Array(CONTACTS);
const ROOM = new Float64Array(CONTACTS);
const DEMAND = new Float64Array(CONTACTS);
const SUMF = new Float64Array(CONTACTS);
/** Per contact: the point is still closing on its surface (a point moving off needs no lift). */
const CLOSE = Array.from({ length: CONTACTS }, () => false);
/** Per contact: the belly resting on the world's ground (it only resists, see `stepFree`). */
const UNDER = Array.from({ length: CONTACTS }, () => false);
/**
 * Per contact: the car whose top it is on when that car is in the rigid step (null: the world's ground, or a car its wheels or its
 * masses hold, which stays put), that car's arm to the point from its centre of mass, and the stepping car's mass over its.
 */
const HELD = Array.from({ length: CONTACTS }, (): DeformableCar | null => null);
const ARM = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
const RATIO = new Float64Array(CONTACTS);
/** Per contact: the friction impulse (world, per unit mass) it has given over the passes, held within its friction of `ACC`. */
const FRA = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
/**
 * Per contact this slice: the closing its own gravity and the weight borne on the stepping car bring there, left to stop against the car
 * under as fixed (a tyre in its springs: its quarter of the weight), and the impulse beyond it that moved that car at once.
 */
const REST = new Float64Array(CONTACTS);
const DYN = new Float64Array(CONTACTS);
/** The weight borne on the stepping car since its last step (`CarSurfaces.takeBorne`): its velocity and spin change. */
const _lv = new THREE.Vector3();
const _lw = new THREE.Vector3();
/** Per belly point (`POINTS` index) this slice: its world position, its rise (surface height less its own) and its patch (`patchOf`). */
const BX = new Float64Array(POINTS.length);
const BY = new Float64Array(POINTS.length);
const BZ = new Float64Array(POINTS.length);
const BRISE = new Float64Array(POINTS.length);
const BPATCH = new Float64Array(POINTS.length);
/** The surfaces of a car in no world (a bare harness): the world's ground alone. */
const LOCAL = new CarSurfaces();
const _s = new THREE.Vector3();
const HIT = new Float64Array(HIT_SIZE);
/** The query point `pointContact` is asked (world x, z and the asking height y). */
const PQ = new Float64Array(PQ_SIZE);

/** Contact `n`, a body point at `R[n]` from the centre `pen` m under the surface in `hit` (`pointContact`): `hull` a crushable hull point, else the belly. */
function bodyContact(surf: CarSurfaces, n: number, hit: Float64Array, pen: number, hull: boolean, q: THREE.Quaternion, v: THREE.Vector3, w: THREE.Vector3, mass: number): void {
  const own = hit[C_OWNER]!;
  N[n]!.set(hit[C_NX]!, hit[C_NY]!, hit[C_NZ]!);
  TYRE[n] = false;
  DIR[n] = own < 0 && N[n]!.y >= CLIMB_NY ? UP : N[n]!;
  OWN[n] = own;
  UNDER[n] = !hull && own < 0;
  FOLLOW[n] = own >= 0 ? hit[C_AUX]! : 1;
  if (own >= 0) surf.touch(own);
  SLOT[n] = surf.slot(own, N[n]!, hull, q, FOLLOW[n]!);
  SOFT[n] = false;
  SINK[n] = pen * N[n]!.y;
  carrier(surf, n, own, mass);
  CLOSE[n] = pointVel(n, v, w, _vp).dot(N[n]!) < 0;
}

/** Contact `n` (its arm `R[n]` set) on car `own`'s top (-1: the world's ground): the car that takes its reaction (`HELD`), for a stepping car of `mass`. */
function carrier(surf: CarSurfaces, n: number, own: number, mass: number): void {
  const o = own >= 0 ? surf.cars[own]! : null;
  if (o === null || !o.rigid) {
    HELD[n] = null;
    return;
  }
  HELD[n] = o;
  RATIO[n] = mass / o.deform.totalMass;
  ARM[n]!.copy(_com).add(R[n]!).sub(o.group.position).sub(_r.set(0, COM_Y, 0).applyQuaternion(o.group.quaternion));
}

/** World inverse inertia (body orientation `q`, its inverse `qi`) applied to `x` in place. */
function invInertia(x: THREE.Vector3, q: THREE.Quaternion, qi: THREE.Quaternion): THREE.Vector3 {
  return x.applyQuaternion(qi).multiply(INV_I).applyQuaternion(q);
}

/** Impulse `j` along unit `dir` at `r` (from the centre of mass) on unit mass `v`, `w`. */
function push(v: THREE.Vector3, w: THREE.Vector3, q: THREE.Quaternion, r: THREE.Vector3, dir: THREE.Vector3, j: number): void {
  v.addScaledVector(dir, j);
  w.addScaledVector(invInertia(_rn.crossVectors(r, dir), q, _qi), j);
}

const _ov = new THREE.Vector3();
const _qo = new THREE.Quaternion();
/** Contact `c`'s point velocity on the stepping body (`v`, `w`) against its surface, into `out`: the top of a car in the rigid step moves with that car. */
function pointVel(c: number, v: THREE.Vector3, w: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.crossVectors(w, R[c]!).add(v);
  const o = HELD[c];
  if (o !== null) out.sub(_ov.crossVectors(o.angular, ARM[c]!).add(o.velocity));
  return out;
}

/**
 * Impulse `j` along unit `dir` at contact `c` on the stepping body (unit mass `v`, `w`, orientation `q`), and its reaction at the same
 * point on the car under it (`HELD`), centre and spin both: the part `jd` that stops closing beyond this slice's weight at once, the
 * weight's part (`j - jd`) borne on it for its next step (`CarSurfaces.bear`), which its own contacts then hold and bear on. Taken at
 * that car's centre alone, a load off the middle of its roof never turned it, and a car turning back under a still rider lifted it
 * 48 mm in 0.1 s (329 J) on 54 J of its own spin.
 */
function give(c: number, v: THREE.Vector3, w: THREE.Vector3, q: THREE.Quaternion, dir: THREE.Vector3, j: number, jd: number, surf: CarSurfaces): void {
  push(v, w, q, R[c]!, dir, j);
  const o = HELD[c];
  if (o === null) return;
  const oq = o.group.quaternion;
  invInertia(_rn.crossVectors(ARM[c]!, dir), oq, _qo.copy(oq).invert());
  o.velocity.addScaledVector(dir, -jd * RATIO[c]!);
  o.angular.addScaledVector(_rn, -jd * RATIO[c]!);
  if (j !== jd) surf.bear(OWN[c]!, dir, _rn, (jd - j) * RATIO[c]!);
}

/**
 * Unit-mass impulse per m/s of contact `c`'s closing speed along unit `dir`: 1 / (1 + dir · (I⁻¹(r × dir) × r)) for the stepping body,
 * with `both` the car under it (`HELD`) taking its share. Stopping the rider alone against a car of its own weight handed that car the
 * whole closing speed: an elastic pair, and a stack whose cars never came to rest.
 */
function reach(c: number, dir: THREE.Vector3, along: THREE.Vector3, q: THREE.Quaternion, both: boolean): number {
  let k = along.dot(dir) + _k.crossVectors(invInertia(_rn.crossVectors(R[c]!, dir), q, _qi), R[c]!).dot(along);
  const o = HELD[c];
  if (both && o !== null) {
    const oq = o.group.quaternion;
    k += RATIO[c]! * (along.dot(dir) + _k.crossVectors(invInertia(_rn.crossVectors(ARM[c]!, dir), oq, _qo.copy(oq).invert()), ARM[c]!).dot(along));
  }
  return 1 / k;
}

const ANG = new Float64Array(CONTACTS);
/** Whether the first `n` contacts (`R`, from the centre of mass) surround the centre in plan: no gap of half a turn between their bearings. */
function surrounds(n: number): boolean {
  for (let c = 0; c < n; c++) {
    const a = Math.atan2(R[c]!.z, R[c]!.x);
    let k = c;
    for (; k > 0 && ANG[k - 1]! > a; k--) ANG[k] = ANG[k - 1]!;
    ANG[k] = a;
  }
  let gap = ANG[0]! + 2 * Math.PI - ANG[n - 1]!;
  for (let c = 1; c < n; c++) gap = Math.max(gap, ANG[c]! - ANG[c - 1]!);
  return gap < Math.PI;
}

/**
 * Body point `i` of `POINTS` turned by the body's orientation `q`, from a point `dy` above the group's origin (car-local y).
 * The belly rides the class's body `lift` (the drawn body is what bottoms out; the bumper, beltline and roof hulls stay
 * stock), so a lifted monster's keel is not 0.48 m under the body it draws.
 */
function hullPoint(i: number, q: THREE.Quaternion, dy: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
  const [x, y, z] = POINTS[i]!;
  return out.set(x, y + dy + (i >= HULL.length ? lift : 0), z).applyQuaternion(q);
}

/** Body point `i`'s world offset `r` moved inward by the faces' crush depths `cr` (the crushed car's hull shrinks with it). */
function crushShift(i: number, q: THREE.Quaternion, cr: Float64Array, r: THREE.Vector3): void {
  _s.set(0, 0, 0);
  for (let f = 0; f < FACES; f++) {
    const d = cr[f]! * BODY_W[i * FACES + f]!;
    _s.x -= FACE_AXIS[f * 3]! * d;
    _s.y -= FACE_AXIS[f * 3 + 1]! * d;
    _s.z -= FACE_AXIS[f * 3 + 2]! * d;
  }
  r.add(_s.applyQuaternion(q));
}

/** Picks the other cars' tops `car`'s queries see (a car in no world sees none); the slice's contact bookkeeping starts here. */
function beginContacts(car: DeformableCar): CarSurfaces {
  const surf = car.surfaces ?? LOCAL;
  surf.begin(car);
  return surf;
}

const _e = new Float64Array(9);
const _hub = new Float64Array(3);
const _hit = new Float64Array(HIT_SIZE);
const WX = Float64Array.from(WHEEL_POS, (p) => p[0]);
const WZ = Float64Array.from(WHEEL_POS, (p) => p[2]);

/** The body's x, y and z axes in world (9 numbers) from `q` into `_e`. */
function basisOf(q: THREE.Quaternion): void {
  const x2 = q.x + q.x;
  const y2 = q.y + q.y;
  const z2 = q.z + q.z;
  const xx = q.x * x2;
  const xy = q.x * y2;
  const xz = q.x * z2;
  const yy = q.y * y2;
  const yz = q.y * z2;
  const zz = q.z * z2;
  const wx = q.w * x2;
  const wy = q.w * y2;
  const wz = q.w * z2;
  _e[0] = 1 - (yy + zz);
  _e[1] = xy + wz;
  _e[2] = xz - wy;
  _e[3] = xy - wz;
  _e[4] = 1 - (xx + zz);
  _e[5] = yz + wx;
  _e[6] = xz + wy;
  _e[7] = yz - wx;
  _e[8] = 1 - (xx + yy);
}

/**
 * Each wheel's contact (`wheelContact`: its tread's footprint on what is under it) with the body as posed, into
 * `car.wheelHit` (slot i at `i * HIT_SIZE`: the lift it needs, the normal, grip, surface, owner and the footprint point).
 * Returns the wheels reaching, bit i: the tread within `within` m above its surface (or in it).
 */
function wheelsAt(car: DeformableCar, within: number): number {
  const p = car.group.position;
  basisOf(car.group.quaternion);
  const hit = car.wheelHit;
  let mask = 0;
  for (let i = 0; i < 4; i++) {
    const sc = car.wheels[i]!.scale.x;
    const r = TYRE_R * sc;
    // The hub on its rest ride: the tyre's bottom is the body's y = 0 for every class.
    _hub[0] = p.x + _e[0]! * WX[i]! + _e[3]! * r + _e[6]! * WZ[i]!;
    _hub[1] = p.y + _e[1]! * WX[i]! + _e[4]! * r + _e[7]! * WZ[i]!;
    _hub[2] = p.z + _e[2]! * WX[i]! + _e[5]! * r + _e[8]! * WZ[i]!;
    wheelContact(_hub, _e, sc, car.slot, _hit);
    const o = i * HIT_SIZE;
    for (let k = 0; k < HIT_SIZE; k++) hit[o + k] = _hit[k]!;
    if (-_hit[C_TOUCH]! <= within && _hit[C_H]! > NO_FLOOR) mask |= 1 << i;
  }
  return mask;
}

/** How many of the wheels in `mask` stand on the world rather than on another car's top. */
function worldWheels(car: DeformableCar, mask: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if (((mask >> i) & 1) !== 0 && car.wheelHit[i * HIT_SIZE + C_OWNER]! < 0) n++;
  return n;
}

/** Whether any wheel or hull point of `car` as posed is in a surface (or has none under it): a wreck's masses fit a frame whose tilt is clamped, handed over on a ramp's face its rear tyres and bumper were 4–11 cm in. */
export function pressing(car: DeformableCar): boolean {
  const q = car.group.quaternion;
  const pos = car.group.position;
  beginContacts(car);
  wheelsAt(car, 0);
  for (let i = 0; i < 4; i++) {
    const rise = car.wheelHit[i * HIT_SIZE + C_H]!;
    if (rise > 0 || rise === NO_FLOOR) return true;
  }
  for (let i = BODY_FROM; i < HULL.length; i++) {
    const r = hullPoint(i, q, 0, 0, _r);
    PQ[PQ_X] = pos.x + r.x;
    PQ[PQ_Z] = pos.z + r.z;
    PQ[PQ_Y] = pos.y + r.y;
    pointContact(PQ, car.slot, HIT);
    if (HIT[C_H]! === NO_FLOOR || pos.y + r.y < HIT[C_H]!) return true;
  }
  return false;
}

/**
 * The rate (Hz) at which `stepWorld` splits a step on `car`'s account, 0 for its own slice: a body holding a hard contact or about to
 * (`hardTouch`: a hull point or belly in a surface or reaching one, a tyre at its spring stop or taking a landing), a face yielding under
 * it, or standing on another car is solved at `CONTACT_HZ`. A car rolling on its tyre springs, free flight and a body frozen at rest on
 * its contact (exactly zero speed) cost a normal slice: a derby's wrecks never pay for it, nor do 32 cars driving.
 */
export function contactHz(car: DeformableCar): number {
  if (car.falling || car.deform.massActive) return 0;
  if (car.velocity.lengthSq() === 0 && car.angular.lengthSq() === 0) return 0;
  return car.hardTouch || car.yielding || car.restsOn !== null ? CONTACT_HZ : 0;
}

/** A wreck on its masses touches what its hubs do (`hubContact`: wheel i down while its hub is on its ground) and is in the air while they are (`aloft`). */
export function wreckContact(car: DeformableCar): void {
  car.wheelsDown = car.deform.hubContact(car.wheelHit);
  car.airborne = car.deform.aloft;
}

/**
 * What the body touches as posed, read off the pose where no slice carried it (a keyframe restored): which wheels reach. A wreck on its
 * masses touches what their last slice left (`wreckContact`).
 */
export function readContact(car: DeformableCar): void {
  car.restsOn = null;
  car.yielding = false;
  car.hardTouch = false;
  if (car.deform.massActive) {
    wreckContact(car);
    return;
  }
  beginContacts(car);
  const mask = wheelsAt(car, droop(carClass(car)) + TOUCH);
  car.wheelsDown = mask;
  car.airborne = mask === 0;
}

const _lay = new THREE.Vector3();

/**
 * `car` placed on the active ground once, as a placement and not as physics: its up turned to the mean normal under its four tyres (the
 * heading kept) and its origin raised until none sinks, so it stands as it will roll. Call it where a car is set down on a slope or a bank.
 */
export function layOnGround(car: DeformableCar): void {
  const q = car.group.quaternion;
  const hit = car.wheelHit;
  beginContacts(car);
  wheelsAt(car, 0);
  _lay.set(0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const o = i * HIT_SIZE;
    if (hit[o + C_H]! > NO_FLOOR) _lay.add(_r.set(hit[o + C_NX]!, hit[o + C_NY]!, hit[o + C_NZ]!));
  }
  if (_lay.lengthSq() > 0) q.setFromUnitVectors(UP, _lay.normalize()).multiply(_dq.setFromAxisAngle(UP, car.yaw));
  wheelsAt(car, 0);
  let sink = -Infinity;
  for (let i = 0; i < 4; i++) if (hit[i * HIT_SIZE + C_H]! > NO_FLOOR) sink = Math.max(sink, hit[i * HIT_SIZE + C_H]!);
  if (sink > -Infinity) car.group.position.y += sink;
  _eul.setFromQuaternion(q, "YXZ");
  car.yaw = _eul.y;
  car.pitch = _eul.x;
  car.roll = _eul.z;
  car.refreshBasis();
  readContact(car);
}

/**
 * Whether the contacts just solved (the first `tyres` of `n` are tyres) hold a hard one or are about to: a hull point or a belly's edge in
 * a surface or reaching one within the slice (`nearing`), or a tyre at its spring stop. Tyres riding in their springs are not: a car
 * rolling on the road costs the plain slice.
 */
function hardContactNear(tyres: number, n: number, nearing: boolean): boolean {
  if (nearing || n > tyres) return true;
  for (let c = 0; c < tyres; c++) if (!SOFT[c]) return true;
  return false;
}

/** Whether the body is taking a landing: a wheel within its springs' reach (bit i of `down`) of a surface the body closes on faster than a bounce (`BOUNCE_V`). */
function landing(hit: Float64Array, down: number, v: THREE.Vector3): boolean {
  for (let i = 0; i < 4; i++) {
    if (((down >> i) & 1) === 0) continue;
    const o = i * HIT_SIZE;
    if (v.x * hit[o + C_NX]! + v.y * hit[o + C_NY]! + v.z * hit[o + C_NZ]! < -BOUNCE_V) return true;
  }
  return false;
}

/**
 * One slice of a rigid body's flight for `car` (`velocity` is its centre of mass's, `angular` its world spin): the four
 * wheels' footprints (`wheelContact`) and the hull's points meet the surfaces under them through impulses. Returns true
 * when it is back on its wheels: three of them on the world's ground (the caller hands it to the pose-following step).
 * `car.airborne`, `wheelsDown` and `restsOn` are derived from the contacts.
 */
export function stepFree(car: DeformableCar, dt: number): boolean {
  const q = car.group.quaternion;
  const pos = car.group.position;
  const v = car.velocity;
  const w = car.angular;
  v.y -= G * dt;
  // The centre moves at the slice's mean velocity under gravity, so its fall over a frame does not depend on how many slices cut it:
  // stepped at the end velocity, the 480 Hz contact slices dropped it 0.17 mm a frame less than the plain ones, a pop where they switch.
  _com.copy(_r.set(0, COM_Y, 0).applyQuaternion(q)).add(pos).addScaledVector(v, dt);
  _com.y += 0.5 * G * dt * dt;
  const spin = w.length();
  if (spin > 1e-9) q.premultiply(_dq.setFromAxisAngle(_axis.copy(w).divideScalar(spin), spin * dt));
  if (!car.crashed) {
    // A driven car's heading is its steering's alone: a roll about a pitched body's horizontal axis swings its nose sideways (a lip's
    // 23° of roll under 14° of pitch read as 4° of yaw), so the Euler yaw goes back to the car's own.
    let drift = _eul.setFromQuaternion(q, "YXZ").y - car.yaw;
    drift -= 2 * Math.PI * Math.round(drift / (2 * Math.PI));
    if (Math.abs(drift) < YAW_HOLD) q.premultiply(_dq.setFromAxisAngle(UP, -drift));
  }
  _qi.copy(q).invert();
  pos.copy(_com).sub(_r.set(0, COM_Y, 0).applyQuaternion(q));
  const y0 = pos.y;
  const mass = car.deform.totalMass;

  const surf = beginContacts(car);
  // The weight the cars on its top bore on it since its last step, taken after its move so its contacts hold it (no sinking under it).
  surf.takeBorne(car.slot, _lv, _lw);
  v.add(_lv);
  w.add(_lw);
  const cls = carClass(car);
  const spring = droop(cls);
  const within = spring + TOUCH;
  const stop = 2 * spring;
  const lift = CLASSES[cls].lift;
  const walls = groundWalls();
  // A driven car with a wheel on a surface, the world's ground or another car's top alike, rolls on it: the drive owns its travel along
  // the road, so the world's faces neither drag it nor grip its tyres along their tread (a rear tyre meeting a ramp's toe at 30° with the
  // front in the air turned its travel 2-3° through the face's slope and the tyre's friction against the body's spin).
  // Every body's tyres are read each slice, a wreck's too: skipped, a wreck's tyres kept their reading from its hand-over and it never
  // landed on them (a struck wreck came to rest on its belly 10 cm in the floor, its tyres read 0.9-1.5 m up).
  const rolling = wheelsAt(car, within) !== 0 && !car.crashed;
  const hit = car.wheelHit;
  const cr = car.deform.crush;
  const crushed = cr[0] !== 0 || cr[1] !== 0 || cr[2] !== 0 || cr[3] !== 0 || cr[4] !== 0;
  // A driven wheel rolls freely along its tread wherever it stands; an unpowered one on another car's top grips both ways.
  const powered = car.drive.throttle !== 0;
  // A tyre within its springs' full travel of the surface, its wheel hanging down to its droop below the rest ride, sits in them: the
  // class's spring and damper (`SPRINGS`, the drawn suspension's: per corner a quarter of the car, k = ω², c = 2ζω, a quarter of its
  // weight at the rest ride) push the body straight up, and it takes no positional lift. Past that travel, and for every body point,
  // the contact is rigid. Rigid tyres stopped a nose-first landing's front in one slice: 35 g on the body within one frame.
  const sp = SPRINGS[cls];
  const om = 2 * Math.PI * sp.hz;
  const stiff = (om * om) / 4;
  const damp = (sp.zeta * om) / 2;
  let n = 0;
  // The deepest rigid point's depth along its surface normal (a steep face's vertical gap overstates it).
  let deep = 0;
  // How deep the belly is in the world's ground (m, vertical): what a body at rest lifts out of.
  let under = 0;
  _lift.set(0, 0, 0);
  _x.set(1, 0, 0).applyQuaternion(q);
  for (let i = 0; i < 4; i++) {
    const o = i * HIT_SIZE;
    const pen = hit[o + C_H]!;
    if (!(pen > -spring)) continue;
    const own = hit[o + C_OWNER]!;
    R[n]!.set(hit[o + C_PX]! - _com.x, hit[o + C_PY]! - _com.y, hit[o + C_PZ]! - _com.z);
    N[n]!.set(hit[o + C_NX]!, hit[o + C_NY]!, hit[o + C_NZ]!);
    TYRE[n] = true;
    OWN[n] = own;
    DIR[n] = N[n]!.y >= CLIMB_NY ? UP : N[n]!;
    UNDER[n] = false;
    FOLLOW[n] = own >= 0 ? hit[o + C_AUX]! : 1;
    if (own >= 0) surf.touch(own);
    SLOT[n] = surf.slot(own, N[n]!, false, q, FOLLOW[n]!);
    // How far past what holds it the point is: a tyre's springs and their full travel; a wreck's tyre no deeper than its masses
    // hold it (`HUB_FLOOR` under its hub): sunk to the springs' stop, a wreck's front tyres sat 0.13 m in a wedge's face when it
    // landed, and its masses lifted them out by the difference in the slice they took it.
    const sink = pen * N[n]!.y - (car.crashed ? Math.min(stop, TYRE_R * car.wheels[i]!.scale.x - HUB_FLOOR) : stop);
    SOFT[n] = sink < 0;
    SINK[n] = sink;
    PRESS[n] = pen;
    carrier(surf, n, own, mass);
    CLOSE[n] = pointVel(n, v, w, _vp).dot(N[n]!) < 0;
    n++;
  }
  const tyres = n;
  let nearing = false;
  for (let i = BODY_FROM; i < POINTS.length; i++) {
    const r = hullPoint(i, q, -COM_Y, lift, R[n]!);
    if (crushed && i < HULL.length) crushShift(i, q, cr, r);
    const px = _com.x + r.x;
    const py = _com.y + r.y;
    const pz = _com.z + r.z;
    PQ[PQ_X] = px;
    PQ[PQ_Z] = pz;
    PQ[PQ_Y] = py;
    pointContact(PQ, car.slot, HIT);
    const gy = HIT[C_H]!;
    if (i >= HULL.length) {
      BX[i] = px;
      BY[i] = py;
      BZ[i] = pz;
      BRISE[i] = gy - py;
      BPATCH[i] = patchOf(HIT);
    }
    if (gy === NO_FLOOR) continue;
    const pen = gy - py;
    if (pen <= 0) {
      // A point that reaches the surface within this slice's travel at its closing speed: the next slice is cut finer.
      if (!nearing) {
        _vp.crossVectors(w, r).add(v);
        nearing = (_vp.x * HIT[C_NX]! + _vp.y * HIT[C_NY]! + _vp.z * HIT[C_NZ]!) * -dt >= -pen * HIT[C_NY]!;
      }
      continue;
    }
    // Over a ground with walls a hull point deeper in the world's face than its own approach came from the side: the wall parts it.
    if (walls && i < HULL.length && HIT[C_OWNER]! < 0) {
      _vp.crossVectors(w, r).add(v);
      if (fromSide(pen * HIT[C_NY]!, _vp.x * HIT[C_NX]! + _vp.y * HIT[C_NY]! + _vp.z * HIT[C_NZ]!, dt)) continue;
    }
    bodyContact(surf, n, HIT, pen, i < HULL.length, q, v, w, mass);
    n++;
  }
  // Between two belly points on different patches the belly meets that edge where it crosses (`edgeCross`, the tyres' rule): a car
  // dropped level across a ramp's crest balanced on the row in front of it, the crest 17 cm inside the belly half a metre behind.
  // Over one car's top (one patch) the pan's lines rest on the top's ridge between their points where that stands above both
  // (`ridgeCross`), pressed along the belly's own normal, not the windscreen's: a sedan on another's roof, its middle row on the roof and
  // its front row past the roof's front edge, tipped 10° nose-down onto the windscreen with its centre still 25 cm behind that edge.
  _up.set(0, 1, 0).applyQuaternion(q);
  for (let s = 0; s < SEGS.length; s += 2) {
    let a = SEGS[s]!;
    let b = SEGS[s + 1]!;
    let pen: number;
    if (BPATCH[a] === BPATCH[b]) {
      if (!(BPATCH[a]! >= 0) || a < PAN_FROM || b < PAN_FROM) continue;
      pen = ridgeCross(BX[a]!, BY[a]!, BZ[a]!, BX[b]!, BY[b]!, BZ[b]!, car.slot, BPATCH[a]!);
      if (!(pen > 0 && pen > BRISE[a]! && pen > BRISE[b]!)) continue;
      EDGE_HIT[C_NX] = _up.x;
      EDGE_HIT[C_NY] = _up.y;
      EDGE_HIT[C_NZ] = _up.z;
    } else {
      if (BRISE[b]! > BRISE[a]!) {
        a = b;
        b = SEGS[s]!;
      }
      if (BRISE[a] === NO_FLOOR) continue;
      pen = edgeCross(BX[a]!, BY[a]!, BZ[a]!, BX[b]!, BY[b]!, BZ[b]!, 0, 0, 0, 0, NaN, car.slot, BPATCH[a]!);
      if (!(pen > 0)) continue;
    }
    R[n]!.set(EDGE_HIT[C_PX]! - _com.x, EDGE_HIT[C_PY]! - _com.y, EDGE_HIT[C_PZ]! - _com.z);
    bodyContact(surf, n, EDGE_HIT, pen, false, q, v, w, mass);
    n++;
  }

  // The tyres in their springs push together, from the slice's state, and share each face's budget (`take`) in proportion to what each
  // asks: in list order the first spent it, and a coupe's two rear tyres landing on a wagon's roof took 6.2 and 2.3 of 6.2 each and rolled
  // it off the column.
  for (let c = 0; c < tyres; c++) {
    if (!SOFT[c]) continue;
    pointVel(c, v, w, _vp);
    const rate = N[c]!.y > 0 ? -_vp.dot(N[c]!) / N[c]!.y - 0.5 * G * dt : 0;
    ASK[c] = Math.max(0, G / 4 + stiff * PRESS[c]! + damp * rate) * dt;
  }
  for (let c = 0; c < tyres; c++) {
    const s = SLOT[c]!;
    if (!SOFT[c] || s < 0) continue;
    let seen = false;
    for (let k = 0; k < c; k++) if (SOFT[k] && SLOT[k] === s) seen = true;
    if (seen) continue;
    let sum = 0;
    for (let k = c; k < tyres; k++) if (SOFT[k] && SLOT[k] === s) sum += ASK[k]!;
    if (sum === 0) continue;
    const share = surf.take(s, sum, G, dt) / sum;
    for (let k = c; k < tyres; k++) if (SOFT[k] && SLOT[k] === s) ASK[k] = ASK[k]! * share;
  }
  // The rigid contacts on a face that yields share what it carries in proportion to what each asks, after every pass: cut in list
  // order, the left side of a coupe's belly on a wagon's yielding roof stopped and the right sank, and it rolled 0.43 rad/s off.
  // Shock propagation for the weight: of each contact's closing this slice, the share its own gravity and the weight borne on it
  // (`takeBorne`) bring there is stopped against the car under as fixed and borne on that car for its next step; only closing beyond it
  // (a landing, a rock, a car turning under it) moves both at once. Pushed into the car under at once, every support moved down at the
  // weight above it each slice and was lifted back: 28-34 kJ of lift every 0.5 s on the owner's 11-car column, which then fell.
  for (let c = 0; c < n; c++) {
    ACC[c] = 0;
    DYN[c] = 0;
    FRA[c]!.set(0, 0, 0);
    if (SOFT[c]) REST[c] = (G / 4) * dt;
    else REST[c] = Math.max(0, -_vp.crossVectors(_lw, R[c]!).add(_lv).addScaledVector(UP, -G * dt).dot(N[c]!));
    FIRST[c] = -1;
    const s = SLOT[c]!;
    if (SOFT[c] || s < 0) continue;
    FIRST[c] = c;
    for (let k = 0; k < c; k++) {
      if (!SOFT[k] && SLOT[k] === s) {
        FIRST[c] = k;
        break;
      }
    }
    if (FIRST[c] !== c) continue;
    ROOM[c] = surf.room(s, G, dt);
    DEMAND[c] = 0;
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let c = 0; c < n; c++) {
      const nrm = N[c]!;
      let jn: number;
      if (SOFT[c]) {
        // A tyre in its springs: once a slice its spring and damper push the body straight up, whatever face its tread meets, the damper
        // on the rate that face rises under the wheel. Pushed along the face's normal and rigid up to 8 g, a monster's rear tyres against
        // a sedan's rear window (n.y 0.43) took its whole drive; along the body's up axis a car rolled 32° on one tyre was kicked
        // 1 rad/s sideways into a wedge's wall; straight up but rigid, a car whose front had passed a ramp's lip sank its rear into the
        // face (v.y 3.2 -> 1.3 m/s in 12 frames). Friction stays in the face's plane.
        if (pass > 0) continue;
        jn = ASK[c]!;
        if (OWN[c]! >= 0) surf.press(OWN[c]!, jn);
        give(c, v, w, q, UP, jn, jn - Math.min(jn, REST[c]!), surf);
      } else {
        const dir = DIR[c]!;
        const vn = pointVel(c, v, w, _vp).dot(nrm);
        // A contact that closes takes what it needs. One that already parts takes back, of the dynamic impulse the earlier passes gave it,
        // what its parting asks (never more: it never pulls). A neighbour's impulse that had over-corrected it kept it for good, so the
        // first of several equal contacts took most of the load and rolled the car: an 11-car column walked 69 mm for the order the belly's
        // points are listed in.
        if (vn >= 0 && DYN[c] === 0) continue;
        if (vn >= 0) {
          jn = Math.max(-DYN[c]!, -vn * reach(c, dir, nrm, q, true));
          ACC[c] = ACC[c]! + jn;
          DYN[c] = DYN[c]! + jn;
          give(c, v, w, q, dir, jn, jn, surf);
        } else {
          const e = pass === 0 && !TYRE[c] && !UNDER[c] && vn < -BOUNCE_V ? RESTITUTION : 0;
          const rest = Math.min(-vn, REST[c]!);
          REST[c] = REST[c]! - rest;
          const jd = (1 + e) * (-vn - rest) * reach(c, dir, nrm, q, true);
          jn = rest * reach(c, dir, nrm, q, false) + jd;
          ACC[c] = ACC[c]! + jn;
          DYN[c] = DYN[c]! + jd;
          give(c, v, w, q, dir, jn, jd, surf);
        }
      }
      if (rolling && OWN[c]! < 0) continue;
      // Friction against the point's sliding: a tyre grips only across its tread (its axle laid in the contact plane) where it
      // rolls: on the world's ground and under power. A car in flight on another car's top is unpowered with its wheels not
      // turning under it, and a free-rolling tyre slid a car down the 8° of a pickup's bed at 0.38 m/s, for good: it grips both ways.
      pointVel(c, v, w, _vp);
      _vp.addScaledVector(nrm, -_vp.dot(nrm));
      if (TYRE[c] && (OWN[c]! < 0 || powered)) {
        _tn.copy(_x).addScaledVector(nrm, -_x.dot(nrm)).normalize();
        const across = _vp.dot(_tn);
        _vp.copy(_tn).multiplyScalar(across);
      }
      const slide = _vp.length();
      if (slide < 1e-6) continue;
      // Friction holds what the contact carries over the passes: its normal impulse after a yielding face's cut (a tyre in its springs:
      // its push). Bounded by each pass's push instead, a sedan's belly rows on a roof whose budget its tyres had spent gripped at 0.6 of
      // impulses the cut then took back, and the sedan under took that grip as a 4 rad/s roll.
      _tn.copy(_vp).divideScalar(-slide);
      _fd.copy(FRA[c]!).addScaledVector(_tn, slide * reach(c, _tn, _tn, q, true));
      const cap = (TYRE[c] ? MU_TYRE : MU_BODY) * (SOFT[c] ? jn : ACC[c]!);
      const held = _fd.length();
      if (held > cap) _fd.multiplyScalar(cap / held);
      _fd.sub(FRA[c]!);
      FRA[c]!.add(_fd);
      const fj = _fd.length();
      if (fj < 1e-9) continue;
      give(c, v, w, q, _fd.divideScalar(fj), fj, fj, surf);
    }
    for (let c = 0; c < n; c++) if (FIRST[c] === c) SUMF[c] = 0;
    for (let c = 0; c < n; c++) if (FIRST[c]! >= 0) SUMF[FIRST[c]!] = SUMF[FIRST[c]!]! + ACC[c]!;
    for (let c = 0; c < n; c++) {
      const f = FIRST[c]!;
      if (f < 0) continue;
      if (f === c) DEMAND[c] = Math.max(DEMAND[c]!, SUMF[c]!);
      if (SUMF[f]! <= ROOM[f]!) continue;
      const cut = ACC[c]! * (1 - ROOM[f]! / SUMF[f]!);
      const cutD = DYN[c]! * (1 - ROOM[f]! / SUMF[f]!);
      give(c, v, w, q, DIR[c]!, -cut, -cutD, surf);
      ACC[c] = ACC[c]! - cut;
      DYN[c] = DYN[c]! - cutD;
      const cap = (TYRE[c] ? MU_TYRE : MU_BODY) * ACC[c]!;
      const held = FRA[c]!.length();
      if (held <= cap) continue;
      _fd.copy(FRA[c]!).multiplyScalar(-1 / held);
      FRA[c]!.multiplyScalar(cap / held);
      give(c, v, w, q, _fd, held - cap, held - cap, surf);
    }
  }
  for (let c = 0; c < n; c++) {
    if (FIRST[c] === c) surf.take(SLOT[c]!, DEMAND[c]!, G, dt);
    if (!SOFT[c] && OWN[c]! >= 0) surf.press(OWN[c]!, ACC[c]! * DIR[c]!.y);
  }
  // The deepest point the surface can still hold up lifts the body out (a face that yields sinks instead). The belly over the
  // world's ground only resists (impulse, no bounce, no lift while it moves): lifting a moving body out by a belly point's
  // depth pumped energy into a car resting on a ramp's edge (it tipped off) and hopped a car rolling back out of the corkscrew's mouth.
  // Nor does a point already moving off its surface lift anything: its impulse is nil, so the lift raised the body with no speed to
  // show for it (a wreck's pitching tail moved it 1-3 cm a frame over another car's roof, fleet-ramps D1).
  for (let c = 0; c < n; c++) {
    const s = SLOT[c]!;
    if (UNDER[c]) under = Math.max(under, SINK[c]!);
    else if (s >= 0 && surf.isYielding(s)) {
      if (!SOFT[c]) surf.note(s, SINK[c]!, FOLLOW[c]!);
    } else if (CLOSE[c] && SINK[c]! > deep) {
      deep = SINK[c]!;
      // A point its friction holds (gripping both ways, under its cap at the passes, on a face no steeper than that friction) goes back
      // up the way the slice's drop took it in: straight up by its depth there. Lifted along the face's normal, each slice's drop under
      // gravity walked a car at rest down its support: a sedan frozen on another's crushed roof (normal 1° off) crept 0.68 mm a second.
      const mu = TYRE[c] ? MU_TYRE : MU_BODY;
      const grips = (!rolling || OWN[c]! >= 0) && (!TYRE[c] || (OWN[c]! >= 0 && !powered));
      if (DIR[c] === UP || (grips && hypot2(N[c]!.x, N[c]!.z) <= mu * N[c]!.y && FRA[c]!.length() < mu * ACC[c]!)) _lift.set(0, deep / N[c]!.y, 0);
      else _lift.copy(N[c]!).multiplyScalar(deep);
    }
  }
  // The tyres in their springs push straight up, so the world's face under them leaves the body its gravity along it, each tyre's share
  // by the weight it carries (a frictionless face would hand the body G·ny·n horizontal): it slows a car uphill and speeds it downhill.
  for (let c = 0; c < tyres; c++) {
    if (!rolling || !SOFT[c] || OWN[c]! >= 0) continue;
    v.x += ASK[c]! * N[c]!.y * N[c]!.x;
    v.z += ASK[c]! * N[c]!.y * N[c]!.z;
  }
  _com.add(_lift);
  const yielded = surf.commit();
  // At rest: slow on three or more points whose surface is near level and which stand around its centre of mass. Past ~14° a body there
  // only creeps (a tyre grips across its tread alone, gravity adds 0.04 m/s a slice, under `REST_V`), so freezing it held a car level on
  // a slope, tail on the road and the nose over the drop, for good (the stunt kicker's face): it keeps simulating until it rolls onto
  // its tyres or its friction holds it. A tyre in its springs on another car's top, unpowered, pushes straight up and grips both ways (it
  // does not creep), so it counts as level: read by its face, a roof's 58° shoulder under a coupe's rear tyres kept the coupe on a wagon
  // from ever coming to rest. Three points in a row are no stand: a sedan on another's roof froze 10° nose-down on its belly's middle
  // row, its centre 7 cm past it and its front row 25 mm off the windscreen, and the column built on it fell.
  let up = 0;
  for (let c = 0; c < n; c++) up += SOFT[c] && OWN[c]! >= 0 ? 1 : N[c]!.y;
  const stands = !powered && n >= 3 && !yielded && up > REST_UP * n && v.lengthSq() < REST_V * REST_V && w.lengthSq() < REST_W * REST_W && surrounds(n);
  const hard = hardContactNear(tyres, n, nearing);
  if (stands && !hard) {
    // On its springs alone they hold it: its vertical speed and its roll and pitch are theirs (zeroed, a body that landed 1.75° nose-down froze
    // so, and one sat 32 mm lower a second for ever); only what its tyres' friction holds is stopped.
    v.x = 0;
    v.z = 0;
    w.y = 0;
  } else if (stands) {
    v.set(0, 0, 0);
    w.set(0, 0, 0);
    _com.y += Math.min(under, REST_LIFT);
  }
  pos.copy(_com).sub(_r.set(0, COM_Y, 0).applyQuaternion(q));
  // What the body touches now: each wheel's tread gap moved by the lift. No wheel within its springs' reach and no hull point
  // in a surface is flight; a belly or a roof resting on something is not.
  const dy = pos.y - y0;
  let down = 0;
  for (let i = 0; i < 4; i++) {
    const o = i * HIT_SIZE + C_H;
    hit[o] = hit[o]! - dy;
    if (-hit[o]! <= within) down |= 1 << i;
  }
  car.wheelsDown = down;
  car.airborne = down === 0 && n === 0;
  car.hardTouch = hard || landing(hit, down, v);
  return worldWheels(car, down) >= 3;
}
