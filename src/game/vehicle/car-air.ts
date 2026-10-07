import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { NO_FLOOR } from "../world/ground.ts";
import { C_AUX, C_H, C_NX, C_NY, C_NZ, C_OWNER, C_PX, C_PY, C_PZ, C_TOUCH, EDGE_HIT, edgeCross, groundWalls, HIT_SIZE, MU_TYRE, patchOf, pointContact, wheelContact } from "../world/surfaces.ts";
import { HUB_FLOOR, TYRE_R } from "../deform/deform-state.ts";
import { hypot2 } from "../deform/physics-util.ts";
import { CAR_HALF, WHEEL_POS } from "./car-mesh.ts";
import { droop, SPRINGS, UNDERSIDE } from "./car-suspension.ts";
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
 * the keel (its height interpolated), so a car on another's flat roof rests on its width, not balanced on the keel line.
 */
const BELLY: readonly (readonly [number, number, number])[] = [
  ...UNDERSIDE.map(([x, z, h]): [number, number, number] => [x, h, z]),
  ...[2, 1, 0, -2].flatMap((z) => {
    const keel = UNDERSIDE.find((p) => p[0] === 0 && p[1] === z)![2];
    const rocker = UNDERSIDE.find((p) => p[0] === 0.8 && p[1] === z)![2];
    return [-0.5, 0.5].map((x): [number, number, number] => [x, keel + (rocker - keel) * 0.625, z]);
  }),
  ...[-0.5, 0.5].flatMap((z) => [-0.5, 0, 0.5].map((x): [number, number, number] => [x, 0.132, z])),
];
/**
 * `HULL` plus the belly: the points a car meets another car's top with, and the world's ground when it bottoms out in
 * flight (a keel 4–5 cm in the road at 30 m/s, a car parked on a bank's crease, a car across a ramp's edge).
 */
const POINTS: readonly (readonly [number, number, number])[] = [...HULL, ...BELLY];
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
/** How far (m) a wheel's tread may be off a surface for a spawn's first slice to lay the body on it (`DeformableCar.laying`): a bank's low side. */
const LAY_REACH = 0.4;
/** The ground's most upward push (m/s²) on a body through its tyres and springs: 8 g (Rapier's raycast vehicle
 *  peaked at 4–12 g on the same ramps and crests). The pose-following step shares it. */
const SUPPORT = 8 * G;
/** Restitution of a body point closing faster than `BOUNCE_V` (m/s); slower contacts and tyres (their springs,
 *  `Suspension`, take a landing) don't bounce. */
const RESTITUTION = 0.25;
const BOUNCE_V = 1.5;
/** Friction: the body scraping, a tyre across its tread (it rolls freely along it). */
const MU_BODY = 0.6;
/** Rate (1/s) a driven car's nose closes on its flight path, above `NOSE_V` (m/s): slower, the path's turn
 *  (g / speed) is a tumble's, not a jump's, and the body turns freely. `NOSE_V` is also the speed from which a driven car keeps its
 *  travel through the world's faces (`stepFree`) and is launched by a ramp's face (`stepPlane`). */
const NOSE_K = 6;
const SPIN_TAU = 0.05;
const NOSE_V = 6;
/** Least rise (m per m of travel) of a face that launches a car riding off it on one axle (`launching`): a ramp, not a level edge. */
const LAUNCH_RISE = 0.02;
/** Below these speeds (m/s, rad/s) a body on three or more hull points is at rest (on two it can still tip), on ground
 *  whose mean up-normal is over `REST_UP` (cos 14°). */
const REST_V = 0.15;
const REST_W = 0.3;
const REST_UP = 0.97;
/** Contact is solved at this rate (Hz) however long the physics step (`stepWorld` splits it): a face's crush depth is the slice's own discretisation otherwise (8 % apart at 60 and 240 Hz). */
const CONTACT_HZ = 480;
/** How far (m) past its own approach a body point may be in a face and still have come down onto it (`fromSide`). */
const STAND_SLOP = 0.005;

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
/** A driven car's Euler yaw drifts by up to this (rad) in a rigid turn before it is a tumble (a flip is no heading). */
const YAW_HOLD = 0.5;
const _qi = new THREE.Quaternion();
const _q0 = new THREE.Quaternion();
const _f = new THREE.Vector3();
const _x = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _k = new THREE.Vector3();
const _tn = new THREE.Vector3();
const GRAV = new THREE.Vector3(0, -G, 0);
const R = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
const _lift = new THREE.Vector3();
const N = Array.from({ length: CONTACTS }, () => new THREE.Vector3());
const TYRE = Array.from({ length: CONTACTS }, () => false);
const SOFT = Array.from({ length: CONTACTS }, () => false);
/** Per contact: the face slot it presses (-1 rigid), the car whose top it stands on (-1 the world), how far that point follows its crush, its sink past what holds it. */
const SLOT = Array.from({ length: CONTACTS }, () => -1);
const OWN = Array.from({ length: CONTACTS }, () => -1);
const FOLLOW = Array.from({ length: CONTACTS }, () => 1);
const SINK = Array.from({ length: CONTACTS }, () => 0);
/** Per tyre in its springs: how far (m, vertical) its spring is pressed past the rest ride, negative while it hangs toward its droop. */
const PRESS = new Float64Array(CONTACTS);
/** Per contact: the point is still closing on its surface (a point moving off needs no lift). */
const CLOSE = Array.from({ length: CONTACTS }, () => false);
/** Per contact: the belly resting on the world's ground (it only resists, see `stepFree`). */
const UNDER = Array.from({ length: CONTACTS }, () => false);
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

/** Contact `n`, a body point at `R[n]` from the centre `pen` m under the surface in `hit` (`pointContact`): `hull` a crushable hull point, else the belly. */
function bodyContact(surf: CarSurfaces, n: number, hit: Float64Array, pen: number, hull: boolean, q: THREE.Quaternion, v: THREE.Vector3, w: THREE.Vector3): void {
  const own = hit[C_OWNER]!;
  N[n]!.set(hit[C_NX]!, hit[C_NY]!, hit[C_NZ]!);
  TYRE[n] = false;
  OWN[n] = own;
  UNDER[n] = !hull && own < 0;
  FOLLOW[n] = own >= 0 ? hit[C_AUX]! : 1;
  if (own >= 0) surf.touch(own);
  SLOT[n] = surf.slot(own, N[n]!, hull, q, FOLLOW[n]!);
  SOFT[n] = false;
  SINK[n] = pen * N[n]!.y;
  CLOSE[n] = _vp.crossVectors(w, R[n]!).add(v).dot(N[n]!) < 0;
}

/** World inverse inertia (body orientation `q`, its inverse in `_qi`) applied to `x` in place. */
function invInertia(x: THREE.Vector3, q: THREE.Quaternion): THREE.Vector3 {
  return x.applyQuaternion(_qi).multiply(INV_I).applyQuaternion(q);
}

/** Impulse `j` along unit `dir` at `r` (from the centre of mass) on unit mass `v`, `w`. */
function push(v: THREE.Vector3, w: THREE.Vector3, q: THREE.Quaternion, r: THREE.Vector3, dir: THREE.Vector3, j: number): void {
  v.addScaledVector(dir, j);
  w.addScaledVector(invInertia(_rn.crossVectors(r, dir), q), j);
}

/** Unit-mass impulse per m/s of point speed along unit `dir` at `r`: 1 / (1 + dir · (I⁻¹(r × dir) × r)). */
function reach(r: THREE.Vector3, dir: THREE.Vector3, q: THREE.Quaternion): number {
  return 1 / (1 + _k.crossVectors(invInertia(_rn.crossVectors(r, dir), q), r).dot(dir));
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
    pointContact(pos.x + r.x, pos.z + r.z, pos.y + r.y, car.slot, HIT);
    if (HIT[C_H]! === NO_FLOOR || pos.y + r.y < HIT[C_H]!) return true;
  }
  return false;
}

/**
 * The rate (Hz) at which `stepWorld` splits a step on `car`'s account, 0 for its own slice: a rigid body touching something
 * (a landing, a face yielding, a stack it stands on) is solved at `CONTACT_HZ`. Free flight and a body frozen at rest on its
 * contact (exactly zero speed) cost a normal slice, as does every car on its wheels: a derby's wrecks never pay for it.
 */
export function contactHz(car: DeformableCar): number {
  if (!car.rigid || car.deform.massActive) return 0;
  const touching = !car.airborne;
  if (touching && car.velocity.lengthSq() === 0 && car.angular.lengthSq() === 0) return 0;
  return touching || car.yielding || car.restsOn !== null ? CONTACT_HZ : 0;
}

/** A wreck on its masses touches what its hubs do (`hubContact`: wheel i down while its hub is on its ground) and is in the air while they are (`aloft`). */
export function wreckContact(car: DeformableCar): void {
  car.wheelsDown = car.deform.hubContact(car.wheelHit);
  car.airborne = car.deform.aloft;
}

/**
 * What the body touches as posed, read off the pose where no slice carried it (a keyframe restored): which step moves it and
 * which wheels reach. A wreck on its masses is moved by them, and touches what their last slice left (`wreckContact`).
 */
export function readContact(car: DeformableCar): void {
  car.restsOn = null;
  car.yielding = false;
  if (car.deform.massActive) {
    car.rigid = false;
    wreckContact(car);
    return;
  }
  beginContacts(car);
  const mask = wheelsAt(car, droop(carClass(car)) + TOUCH);
  car.wheelsDown = mask;
  car.rigid = car.crashed || worldWheels(car, mask) < 3;
  car.airborne = mask === 0;
}

const _u = new Float64Array(4);
const _wd = new Float64Array(4);
const _hh = new Float64Array(4);
/** A fitted plane: height at the origin, rise per metre along the heading, rise per metre toward the car's +x side. */
const _pl = new Float64Array(3);
const _bp = new Float64Array(3);
/** The previous pass's plane (`stepPlane`). */
const _pp = new Float64Array(3);
/** The pose `_pl` gives a body facing the asked yaw: pitch, roll and the plane's unit up-normal (x, y, z). */
const _pose = new Float64Array(5);
/** Reads of the tyres per slice at most (`stepPlane`). */
const PASSES = 4;

/** The pose of `_pl` for a body facing yaw (sin `sy`, cos `cy`) into `_pose`. */
function planePose(sy: number, cy: number): void {
  const gx = _pl[1]! * sy + _pl[2]! * cy;
  const gz = _pl[1]! * cy - _pl[2]! * sy;
  const len = Math.hypot(gx, 1, gz);
  const nx = -gx / len;
  const ny = 1 / len;
  const nz = -gz / len;
  const nf = nx * sy + nz * cy;
  _pose[0] = Math.atan2(nf, ny);
  _pose[1] = Math.atan2(nz * sy - nx * cy, hypot2(nf, ny));
  _pose[2] = nx;
  _pose[3] = ny;
  _pose[4] = nz;
}

/**
 * The plane c + a·u + b·w the body's springs hold it at over the contacts of the wheels in `mask` into `_pl`; false when degenerate.
 * Each spring carries its static share at its rest ride and `hang` m of travel more or less; a wheel off the ground carries none, so
 * the others hold the whole weight about the origin. On four wheels that is the least-squares plane; on three it is the one the four
 * left as the fourth lost its load at full droop (`hang` under its foot), so a body handed from four wheels to three does not jump.
 */
function fitPlane(mask: number, hang: number): boolean {
  let m = 0;
  let su = 0;
  let sw = 0;
  let suu = 0;
  let suw = 0;
  let sww = 0;
  let sh = 0;
  let suh = 0;
  let swh = 0;
  for (let i = 0; i < 4; i++) {
    if (((mask >> i) & 1) === 0) continue;
    const u = _u[i]!;
    const w = _wd[i]!;
    const h = _hh[i]!;
    m++;
    su += u;
    sw += w;
    suu += u * u;
    suw += u * w;
    sww += w * w;
    sh += h;
    suh += u * h;
    swh += w * h;
  }
  // Off wheels' share: the springs in contact sink `hang` per wheel off in all, and turn the body toward where the off wheels' load was.
  sh -= hang * (4 - m);
  suh += hang * su;
  swh += hang * sw;
  const d = m * (suu * sww - suw * suw) - su * (su * sww - suw * sw) + sw * (su * suw - suu * sw);
  if (Math.abs(d) < 1e-9) return false;
  _pl[0] = (sh * (suu * sww - suw * suw) - su * (suh * sww - suw * swh) + sw * (suh * suw - suu * swh)) / d;
  _pl[1] = (m * (suh * sww - suw * swh) - sh * (su * sww - suw * sw) + sw * (su * swh - suh * sw)) / d;
  _pl[2] = (m * (suu * swh - suh * suw) - su * (su * swh - suh * sw) + sh * (su * suw - suu * sw)) / d;
  return true;
}

/** The most (m) any wheel in `mask` has its contact above `_pl` (a spring pushed past its bump stop). */
function bumped(mask: number): number {
  let worst = -Infinity;
  for (let i = 0; i < 4; i++) {
    if (((mask >> i) & 1) === 0) continue;
    worst = Math.max(worst, _hh[i]! - (_pl[0]! + _pl[1]! * _u[i]! + _pl[2]! * _wd[i]!));
  }
  return worst;
}

/**
 * The plane the body rests on over the wheels in `mask` (at least three), facing `yaw`: the least-squares plane through each wheel's
 * foot (its hub's point on the tyre plane, the body's y = 0, on the pose `wheelsAt` read) lifted by its rise: where the wheel's hub
 * comes to rest on what its tread meets, so a tyre on a lip or rolling off an edge holds its corner of the body as high as its hub
 * stands, not as high as the point it touches. Springs absorb what the plane leaves, up to `stop` m of bump; a wheel pushed past that
 * holds the body up alone with two others (a car on a kerb's corner rests on three). One axle's two wheels (a launch, `stepPlane`) give
 * the plane through their two feet at the pitch the body rides: it leaves a face in the attitude it climbed it in.
 */
function restPlane(car: DeformableCar, mask: number, yaw: number, stop: number): boolean {
  const p = car.group.position;
  const hit = car.wheelHit;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  for (let i = 0; i < 4; i++) {
    if (((mask >> i) & 1) === 0) continue;
    const dx = _e[0]! * WX[i]! + _e[6]! * WZ[i]!;
    const dz = _e[2]! * WX[i]! + _e[8]! * WZ[i]!;
    _u[i] = dx * sy + dz * cy;
    _wd[i] = dx * cy - dz * sy;
    _hh[i] = p.y + _e[1]! * WX[i]! + _e[7]! * WZ[i]! + hit[i * HIT_SIZE + C_H]!;
  }
  if (mask === 3 || mask === 12) {
    const i = mask === 3 ? 0 : 2;
    const a = -Math.tan(car.pitch);
    const b = (_hh[i]! - a * _u[i]! - _hh[i + 1]! + a * _u[i + 1]!) / (_wd[i]! - _wd[i + 1]!);
    _pl[0] = _hh[i]! - a * _u[i]! - b * _wd[i]!;
    _pl[1] = a;
    _pl[2] = b;
    return true;
  }
  if (!fitPlane(mask, stop)) return false;
  if (mask !== 15 || bumped(mask) <= stop) return true;
  // Past a stop the body rests on three, the fourth's spring at full droop: of those that leave the fourth within its stop, the one
  // that turns it least from the pose it rides (a twist growing under it, the corkscrew's floor, hands it on without a jump).
  let best = Infinity;
  for (let j = 0; j < 4; j++) {
    if (!fitPlane(15 & ~(1 << j), stop)) continue;
    if (_hh[j]! - (_pl[0]! + _pl[1]! * _u[j]! + _pl[2]! * _wd[j]!) > stop) continue;
    planePose(sy, cy);
    const turn = Math.abs(_pose[0]! - car.pitch) + Math.abs(_pose[1]! - car.roll);
    if (turn >= best) continue;
    best = turn;
    _bp.set(_pl);
  }
  if (best === Infinity) return fitPlane(mask, stop);
  _pl.set(_bp);
  return true;
}

/**
 * Whether the plane through one axle's feet (`restPlane`) launches `car`, facing (`sy`, `cy`): it rises along the car's travel by at
 * least `LAUNCH_RISE` (a ramp's face, not a level edge the car rolls off) and the surface under the car's origin is within `reach` of it
 * (the face goes on under its middle).
 */
function launching(car: DeformableCar, sy: number, cy: number, reach: number): boolean {
  const v = car.velocity;
  const along = v.x * sy + v.z * cy;
  if (!(_pl[1]! * along > LAUNCH_RISE * Math.abs(along))) return false;
  const p = car.group.position;
  pointContact(p.x, p.z, _pl[0]!, car.slot, HIT);
  return HIT[C_H]! >= _pl[0]! - reach;
}

/**
 * One slice of a driven car whose wheels stand on the world: its pose is the rest plane through their contacts (yaw kept),
 * its height follows that plane's height under its origin, climbing at the rate the plane rises along its travel and sinking
 * into its springs where the plane rose faster than the ground's push (`SUPPORT`) can follow. Returns false when fewer than
 * three wheels stand on the world, unless one axle is launching the car off a ramp's face (`launching`): the caller hands it to the
 * rigid step.
 */
export function stepPlane(car: DeformableCar, dt: number): boolean {
  beginContacts(car);
  const q = car.group.quaternion;
  const pos = car.group.position;
  const v = car.velocity;
  const spring = car.laying ? LAY_REACH : droop(carClass(car));
  car.laying = false;
  const yaw = car.yaw;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  _q0.copy(q).invert();
  // The pose a pass leaves moves the tyres over the surface (a lip's face, a bank): the next pass reads them where it left them, until
  // the plane holds (a wheel easing over an edge took three passes). A plane that sends the body back to the pose before the last one
  // has a tyre straddling a step's edge that each pose moves on and off it: the body rests on that edge, between the two.
  let p2 = car.pitch;
  let r2 = car.roll;
  for (let pass = 0; pass < PASSES; pass++) {
    const mask = wheelsAt(car, spring + TOUCH);
    const ww = worldWheels(car, mask);
    // A jump's launch (arcade, as the nose follows the path in flight): above `NOSE_V` a car whose front wheels have left a ramp's lip
    // rides its rear axle up the face, as on its wheels, until its middle is past the lip. Left to the rigid step, the rear axle carried
    // its share alone: the front half fell at G/2 and the springs pitched the nose down (11 m/s: off the lip at 1.3 m/s up, not 2.7).
    const axle = ww === 2 && (mask === 3 || mask === 12) && v.lengthSq() > NOSE_V * NOSE_V;
    if ((ww < 3 && !axle) || !restPlane(car, mask, yaw, spring) || (axle && !launching(car, sy, cy, spring + TOUCH))) {
      // The body takes off from the pose this read was taken on: a tyre on a face's corner that the first pass's plane rolls off it
      // has no rest on that corner, and handed back the pose it had, the corner (risen under it meanwhile) sank the drawn tyre 6-13 cm.
      car.wheelsDown = mask;
      car.airborne = mask === 0;
      return false;
    }
    planePose(sy, cy);
    const moved = Math.abs(_pose[0]! - car.pitch) + Math.abs(_pose[1]! - car.roll);
    const cycled = pass > 0 && moved >= 1e-3 && Math.abs(_pose[0]! - p2) + Math.abs(_pose[1]! - r2) < 1e-3;
    if (cycled) {
      for (let k = 0; k < 3; k++) _pl[k] = (_pl[k]! + _pp[k]!) / 2;
      planePose(sy, cy);
    }
    _pp.set(_pl);
    p2 = car.pitch;
    r2 = car.roll;
    car.pitch = _pose[0]!;
    car.roll = _pose[1]!;
    car.group.rotation.set(car.pitch, yaw, car.roll, "YXZ");
    if (moved < 1e-3) break;
    // The last pass moved the body off where its tyres were read (a wheel at the edge of its reach): read them where it rests.
    if (cycled || pass === PASSES - 1) {
      wheelsAt(car, spring + TOUCH);
      break;
    }
  }
  const gy = _pl[0]!;
  const nx = _pose[2]!;
  const ny = _pose[3]!;
  const nz = _pose[4]!;
  // The tilt's turn over this slice (world rad/s) is what the body carries into the air at a takeoff, smoothed over `SPIN_TAU`: the
  // pose snaps a few degrees in a slice where a wheel meets a lip or leaves a ledge, and that is no turn the body is making.
  _q0.premultiply(q);
  const keep = Math.exp(-dt / SPIN_TAU);
  const k = ((_q0.w < 0 ? -2 : 2) / dt) * (1 - keep);
  car.groundSpin.set(car.groundSpin.x * keep + _q0.x * k, car.groundSpin.y * keep + _q0.y * k, car.groundSpin.z * keep + _q0.z * k);

  const yEval = pos.y;
  const y0 = yEval - v.y * dt;
  const was = Number.isNaN(car.support) ? gy : car.support;
  const climb = (gy - was) / dt;
  car.support = gy;
  if (pos.y <= gy) {
    // The ground only pushes up, by at most `SUPPORT`: the body climbs with its support and, where the slice started in its
    // springs, rises out of them no faster than gravity stops it at the top (no hop), as far as that push allows; past it
    // the body sinks into them, down to their stop (their full travel, its tyres' give included). Set onto its support
    // in one slice, a ramp's foot, a dip's floor or a landing kicked the body up at 20–36 g within one frame.
    const sunk = was - y0;
    const want = sunk > 0 ? climb + Math.sqrt(2 * G * sunk) : climb;
    if (sunk <= 0 && want - v.y <= SUPPORT * dt) {
      pos.y = gy;
      v.y = climb;
    } else {
      const lift = Math.min(Math.max(0, want - v.y), SUPPORT * dt);
      v.y += lift;
      pos.y += lift * dt;
    }
    if (pos.y < gy - 2 * spring && v.y < climb) {
      // On the stop the body sinks no further: it moves with its support and the push brings it back out.
      v.y = climb;
      pos.y = y0 + climb * dt;
    }
    // Gravity along the surface (none on the level): it slows a car uphill and speeds it downhill.
    v.x += G * ny * nx * dt;
    v.z += G * ny * nz * dt;
  }
  const dy = pos.y - yEval;
  let down = 0;
  for (let i = 0; i < 4; i++) {
    const o = i * HIT_SIZE + C_H;
    car.wheelHit[o] = car.wheelHit[o]! - dy;
    if (-car.wheelHit[o]! <= spring + TOUCH) down |= 1 << i;
  }
  car.wheelsDown = down;
  car.airborne = false;
  car.restsOn = null;
  car.yielding = false;
  return true;
}

/**
 * One slice of a rigid body's flight for `car` (`velocity` is its centre of mass's, `angular` its world spin): the four
 * wheels' footprints (`wheelContact`) and the hull's points meet the surfaces under them through impulses. Returns true
 * when it is back on its wheels: three of them on the world's ground (the caller hands it to the pose-following step).
 * `car.airborne`, `wheelsDown` and `restsOn` are derived from the contacts.
 */
export function stepFree(car: DeformableCar, dt: number): boolean {
  const q = car.group.quaternion;
  car.laying = false;
  const pos = car.group.position;
  const v = car.velocity;
  const w = car.angular;
  v.y -= G * dt;
  const sp2 = v.lengthSq();
  if (!car.crashed && car.airborne && sp2 > NOSE_V * NOSE_V) {
    // A driven car's nose follows its flight path (arcade): the path's own turn (gravity bends it) plus a pull that
    // closes the angle between them, while that angle is under 30° (sin 0.5); further off, the body tumbles
    // freely. The roll about the nose stays free. The spin eases onto that turn over `SPIN_TAU`: set at once, it stepped
    // 0.33 rad/s as the last tyre left its reach over the disc's rim (the origin's height popped 0.0031 m/frame²).
    _f.set(0, 0, 1).applyQuaternion(q);
    _b.crossVectors(_f, v).divideScalar(Math.sqrt(sp2));
    const off = _b.length();
    if (off < 0.5) {
      _a.crossVectors(v, GRAV).divideScalar(sp2);
      if (off > 1e-9) _a.addScaledVector(_b, (NOSE_K * Math.asin(off)) / off);
      _a.addScaledVector(_f, w.dot(_f) - _a.dot(_f));
      w.lerp(_a, 1 - Math.exp(-dt / SPIN_TAU));
    }
  }
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

  const surf = beginContacts(car);
  const cls = carClass(car);
  const spring = droop(cls);
  const within = spring + TOUCH;
  const stop = 2 * spring;
  const lift = CLASSES[cls].lift;
  const walls = groundWalls();
  // A driven car with a wheel on a surface, the world's ground or another car's top alike, travels as its drive takes it, as on its
  // wheels (`stepPlane`): the faces lift and turn it but neither push it along nor drag it (no friction on the world: the drive grips).
  // A rear tyre meeting a ramp's toe at 30° with the front in the air turned its travel 2-3° through the face's slope and the tyre's
  // friction against the body's spin; a monster on a sedan, its rear tyres on the trunk against the rear window, never drove off.
  // Every body's tyres are read each slice, a wreck's too: skipped, a wreck's tyres kept their reading from its hand-over and it never
  // landed on them (a struck wreck came to rest on its belly 10 cm in the floor, its tyres read 0.9-1.5 m up).
  const rolling = wheelsAt(car, within) !== 0 && !car.crashed;
  const vx0 = v.x;
  const vz0 = v.z;
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
    CLOSE[n] = _vp.crossVectors(w, R[n]!).add(v).dot(N[n]!) < 0;
    n++;
  }
  for (let i = BODY_FROM; i < POINTS.length; i++) {
    const r = hullPoint(i, q, -COM_Y, lift, R[n]!);
    if (crushed && i < HULL.length) crushShift(i, q, cr, r);
    const px = _com.x + r.x;
    const py = _com.y + r.y;
    const pz = _com.z + r.z;
    pointContact(px, pz, py, car.slot, HIT);
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
    if (pen <= 0) continue;
    // Over a ground with walls a hull point deeper in the world's face than its own approach came from the side: the wall parts it.
    if (walls && i < HULL.length && HIT[C_OWNER]! < 0) {
      _vp.crossVectors(w, r).add(v);
      if (fromSide(pen * HIT[C_NY]!, _vp.x * HIT[C_NX]! + _vp.y * HIT[C_NY]! + _vp.z * HIT[C_NZ]!, dt)) continue;
    }
    bodyContact(surf, n, HIT, pen, i < HULL.length, q, v, w);
    n++;
  }
  // Between two belly points on different patches the belly meets that edge where it crosses (`edgeCross`, the tyres' rule): a car
  // dropped level across a ramp's crest balanced on the row in front of it, the crest 17 cm inside the belly half a metre behind.
  for (let s = 0; s < SEGS.length; s += 2) {
    let a = SEGS[s]!;
    let b = SEGS[s + 1]!;
    if (BPATCH[a] === BPATCH[b]) continue;
    if (BRISE[b]! > BRISE[a]!) {
      a = b;
      b = SEGS[s]!;
    }
    if (BRISE[a] === NO_FLOOR) continue;
    const pen = edgeCross(BX[a]!, BY[a]!, BZ[a]!, BX[b]!, BY[b]!, BZ[b]!, 0, 0, 0, 0, NaN, car.slot, BPATCH[a]!);
    if (!(pen > 0)) continue;
    R[n]!.set(EDGE_HIT[C_PX]! - _com.x, EDGE_HIT[C_PY]! - _com.y, EDGE_HIT[C_PZ]! - _com.z);
    bodyContact(surf, n, EDGE_HIT, pen, false, q, v, w);
    n++;
  }

  for (let pass = 0; pass < 4; pass++) {
    for (let c = 0; c < n; c++) {
      const r = R[c]!;
      const nrm = N[c]!;
      let jn: number;
      if (SOFT[c]) {
        // A tyre in its springs: once a slice its spring and damper push the body straight up, whatever face its tread meets, the damper
        // on the rate that face rises under the wheel. Pushed along the face's normal and rigid up to 8 g, a monster's rear tyres against
        // a sedan's rear window (n.y 0.43) took its whole drive; along the body's up axis a car rolled 32° on one tyre was kicked
        // 1 rad/s sideways into a wedge's wall; straight up but rigid, a car whose front had passed a ramp's lip sank its rear into the
        // face (v.y 3.2 -> 1.3 m/s in 12 frames). Friction stays in the face's plane.
        if (pass > 0) continue;
        _vp.crossVectors(w, r).add(v);
        const rate = nrm.y > 0 ? -_vp.dot(nrm) / nrm.y : 0;
        jn = Math.max(0, G / 4 + stiff * PRESS[c]! + damp * rate) * dt;
        // A face carries what its strength law gives (`CarSurfaces.take`); the rest of the impulse is the face yielding.
        if (SLOT[c]! >= 0) jn = surf.take(SLOT[c]!, jn, G, dt);
        if (OWN[c]! >= 0) surf.press(OWN[c]!, jn);
        push(v, w, q, r, UP, jn);
      } else {
        const vn = _vp.crossVectors(w, r).add(v).dot(nrm);
        if (vn >= 0) continue;
        const e = pass === 0 && !TYRE[c] && !UNDER[c] && vn < -BOUNCE_V ? RESTITUTION : 0;
        jn = -(1 + e) * vn * reach(r, nrm, q);
        if (SLOT[c]! >= 0) jn = surf.take(SLOT[c]!, jn, G, dt);
        if (OWN[c]! >= 0) surf.press(OWN[c]!, jn * nrm.y);
        push(v, w, q, r, nrm, jn);
      }
      if (rolling && OWN[c]! < 0) continue;
      // Friction against the point's sliding: a tyre grips only across its tread (its axle laid in the contact plane) where it
      // rolls: on the world's ground and under power. A car in flight on another car's top is unpowered with its wheels not
      // turning under it, and a free-rolling tyre slid a car down the 8° of a pickup's bed at 0.38 m/s, for good: it grips both ways.
      _vp.crossVectors(w, r).add(v);
      _vp.addScaledVector(nrm, -_vp.dot(nrm));
      if (TYRE[c] && (OWN[c]! < 0 || powered)) {
        _tn.copy(_x).addScaledVector(nrm, -_x.dot(nrm)).normalize();
        const across = _vp.dot(_tn);
        _vp.copy(_tn).multiplyScalar(across);
      }
      const slide = _vp.length();
      if (slide < 1e-6) continue;
      _tn.copy(_vp).divideScalar(-slide);
      push(v, w, q, r, _tn, Math.min((TYRE[c] ? MU_TYRE : MU_BODY) * jn, slide * reach(r, _tn, q)));
    }
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
      _lift.copy(N[c]!).multiplyScalar(deep);
    }
  }
  // So does one whose body strikes the world's faces (a point closing on its surface): a rocker meeting the wedge's corner as the car
  // drove off its side took 0.7-0.8 m/s and 1.4-1.6° of heading in one slice. A belly resting or sliding on a face keeps its friction.
  // Under throttle the drive owns the travel from a standstill (a monster pulling away with its rear tyres against a sedan's rear window
  // held 0.47 m/s at 0.25 s against 3.73 on a platform). Coasting or braked, it is kept in full from `NOSE_V` down to none at a
  // standstill: a stopped car's resting contacts close under gravity every slice, and kept at its slice-start zero they held its centre
  // still while it tipped over a wedge's side edge (it pivoted about its centre, 35 frames on the edge). The drop matrix and
  // ramp-crossing give the same cells with the full keep from 2, 4, 6 or 8 m/s.
  let struck = false;
  for (let c = 0; c < n; c++) if (OWN[c]! < 0 && CLOSE[c]) struck = true;
  if (rolling || (!car.crashed && struck)) {
    const keep = powered ? 1 : Math.min(1, Math.sqrt(vx0 * vx0 + vz0 * vz0) / NOSE_V);
    v.x += (vx0 - v.x) * keep;
    v.z += (vz0 - v.z) * keep;
    _lift.x *= 1 - keep;
    _lift.z *= 1 - keep;
  }
  _com.add(_lift);
  const yielded = surf.commit();
  // At rest: slow on three or more points whose surface is near level. Past ~14° a body there only creeps (a tyre grips
  // across its tread alone, gravity adds 0.04 m/s a slice, under `REST_V`), so freezing it held a car level on a slope,
  // tail on the road and the nose over the drop, for good (the stunt kicker's face): it keeps simulating until it
  // rolls onto its tyres or its friction holds it.
  let up = 0;
  for (let c = 0; c < n; c++) up += N[c]!.y;
  if (n >= 3 && !yielded && up > REST_UP * n && v.lengthSq() < REST_V * REST_V && w.lengthSq() < REST_W * REST_W) {
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
  return worldWheels(car, down) >= 3;
}
