import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { CAR_HALF, WHEEL_POS } from "./car-mesh.ts";
import { droop, UNDERSIDE } from "./car-suspension.ts";
import { carClass } from "./vehicle-classes.ts";
import { CarSurfaces } from "./car-surfaces.ts";
import { FACES, FACE_AXIS, faceFollow } from "../deform/load-crush.ts";

/**
 * A car with no wheel on the ground (`DeformableCar.airborne`): a rigid box under gravity that turns freely about
 * its centre of mass, with no drive or grip. Its hull points (tyre contacts, bumper, beltline and roof corners) meet
 * the active ground through impulses with restitution and friction, so it can land on its wheels, roof or side, tip
 * over or rock back, and come to rest on any of them. It goes back to the ground sim once three wheels are down
 * with the body upright (`stepAir`'s return).
 */
const G = 9.6;
/** Centre of mass above the group's origin (car-local y, m); the origin is on the ground under the body's middle. */
export const COM_Y = 0.55;
/** Inverse inertia per unit mass (1/m²) of the body's box about its centre of mass: car-local x, y, z. */
const INV_I = new THREE.Vector3(3 / (CAR_HALF.y ** 2 + CAR_HALF.z ** 2), 3 / (CAR_HALF.x ** 2 + CAR_HALF.z ** 2), 3 / (CAR_HALF.x ** 2 + CAR_HALF.y ** 2));
/** Car-local hull points: the four hubs first (their tyres meet the ground, `stepAir`), then bumper, beltline and roof corners. */
const HULL: readonly (readonly [number, number, number])[] = [
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
 * `HULL` plus the belly: the points a car meets another car's top with. Over the world's ground the belly is not a
 * contact (a body that bottoms out there is `car-support.ts`'s), so only `HULL` is.
 */
const POINTS: readonly (readonly [number, number, number])[] = [...HULL, ...BELLY];
/** Bumper, beltline and roof corners (`HULL[4..]`): the body points whose face a hit crushes (`load-crush.ts`). */
const BODY_FROM = 4;
/** How far each body point follows each face's crush depth (`faceFollow`), per `FACES` row. */
const BODY_W = Float64Array.from({ length: HULL.length * FACES }, (_, k) => {
  const p = (k / FACES) | 0;
  const [x, y, z] = HULL[p]!;
  return p < BODY_FROM ? 0 : faceFollow(k % FACES, x, y, z);
});
/** A wheel this close (m) to the ground counts as down. */
const TOUCH = 0.03;
/** The ground's most upward push (m/s²) on a body through its tyres and springs: 8 g (Rapier's raycast vehicle
 *  peaked at 4–12 g on the same ramps and crests). The ground sim's grounded support shares it. */
export const SUPPORT = 8 * G;
/** Body up · ground normal above this (cos ~25°) with two wheels down: back on its wheels (`stepAir`'s return). */
const UPRIGHT = 0.9;
/** Restitution of a body point closing faster than `BOUNCE_V` (m/s); slower contacts and tyres (their springs,
 *  `Suspension`, take a landing) don't bounce. */
const RESTITUTION = 0.25;
const BOUNCE_V = 1.5;
/** Friction: the body scraping, a tyre across its tread (it rolls freely along it). */
const MU_BODY = 0.6;
const MU_TYRE = 0.9;
/** Rate (1/s) a driven car's nose closes on its flight path, above `NOSE_V` (m/s): slower, the path's turn
 *  (g / speed) is a tumble's, not a jump's, and the body turns freely. */
const NOSE_K = 6;
const NOSE_V = 6;
/** Below these speeds (m/s, rad/s) a body on three or more hull points is at rest (on two it can still tip), on ground
 *  whose mean up-normal is over `REST_UP` (cos 14°). */
const REST_V = 0.15;
const REST_W = 0.3;
const REST_UP = 0.97;

const _r = new THREE.Vector3();
const _com = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _f = new THREE.Vector3();
const _x = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _k = new THREE.Vector3();
const _tn = new THREE.Vector3();
const GRAV = new THREE.Vector3(0, -G, 0);
const R = POINTS.map(() => new THREE.Vector3());
const _lift = new THREE.Vector3();
const N = POINTS.map(() => new THREE.Vector3());
const TYRE = POINTS.map(() => false);
const SOFT = POINTS.map(() => false);
/** Per contact: the face slot it presses (-1 rigid), the car whose top it stands on (-1 the world), how far that point follows its crush, its sink past what holds it. */
const SLOT = POINTS.map(() => -1);
const OWN = POINTS.map(() => -1);
const FOLLOW = POINTS.map(() => 1);
const SINK = POINTS.map(() => 0);
/** The surfaces of a car in no world (a bare harness): the world's ground alone. */
const LOCAL = new CarSurfaces();
const _s = new THREE.Vector3();

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
 * Hull point `i` turned by the body's orientation `q`, from a point `dy` above the group's origin (car-local y);
 * a tyre's lowest point, down from its hub within the wheel's plane (the axle `_x`, set by the caller, taken
 * out), radius = hub height.
 */
function hullPoint(i: number, q: THREE.Quaternion, dy: number, out: THREE.Vector3): THREE.Vector3 {
  const [x, y, z] = POINTS[i]!;
  out.set(x, y + dy, z).applyQuaternion(q);
  if (i < 4) {
    _b.set(0, 1, 0).addScaledVector(_x, -_x.y);
    const l = _b.length();
    if (l > 0.2) out.addScaledVector(_b, -y / l);
  }
  return out;
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

/**
 * Whether every hull point of `car` as posed is clear of the ground under it: `stepAir` can take the body there
 * without lifting it out (a wreck's masses fit a frame whose tilt is clamped: handed over on a ramp's face its
 * rear tyres and bumper were 4–11 cm in). Past the fleet disc's rim is the edge fall's, not this.
 */
export function hullClear(car: DeformableCar): boolean {
  const q = car.group.quaternion;
  const pos = car.group.position;
  const ground = activeGround();
  _x.set(1, 0, 0).applyQuaternion(q);
  for (let i = 0; i < HULL.length; i++) {
    const r = hullPoint(i, q, 0, _r);
    const gy = ground.heightAt(pos.x + r.x, pos.z + r.z, pos.y + r.y);
    if (gy === NO_FLOOR || pos.y + r.y < gy) return false;
  }
  return true;
}

/** Contact is solved at this rate (Hz) however long the physics step (`stepWorld` splits it): a face's crush depth is the slice's own discretisation otherwise (8 % apart at 60 and 240 Hz). */
export const CONTACT_HZ = 480;
/** A body whose origin is this far (m) over the ground, or beside another car, may be about to touch it (an upside-down roof is 1.4 m under the origin). */
const CONTACT_REACH = 1.6;

/**
 * Whether `car`, a body in flight, is in or about to be in contact within a step of `dt` (the world solves such a step at
 * `CONTACT_HZ`). A body `stepAir` has frozen at rest on its contact (exactly zero speed) is not: it costs a normal slice.
 */
export function nearContact(car: DeformableCar, dt: number): boolean {
  if (!car.airborne || car.deform.massActive) return false;
  if (car.airContact && car.velocity.lengthSq() === 0 && car.angular.lengthSq() === 0) return false;
  const pos = car.group.position;
  return car.airContact || (car.surfaces?.nearTo(car) ?? false) || pos.y - activeGround().heightAt(pos.x, pos.z, pos.y) < CONTACT_REACH + 2 * Math.abs(car.velocity.y) * dt;
}

/**
 * One slice of flight for `car` (`velocity` is its centre of mass's, `angular` its world spin). Returns true when it
 * is back on its wheels, upright: the caller hands it to the ground sim. `car.airContact` is set while any hull
 * point is on the ground.
 */
export function stepAir(car: DeformableCar, dt: number): boolean {
  const q = car.group.quaternion;
  const pos = car.group.position;
  const v = car.velocity;
  const w = car.angular;
  v.y -= G * dt;
  const sp2 = v.lengthSq();
  if (!car.crashed && !car.airContact && sp2 > NOSE_V * NOSE_V) {
    // A driven car's nose follows its flight path (arcade): the path's own turn (gravity bends it) plus a pull that
    // closes the angle between them, while that angle is under 30° (sin 0.5); further off, the body tumbles
    // freely. The roll about the nose stays free.
    _f.set(0, 0, 1).applyQuaternion(q);
    _b.crossVectors(_f, v).divideScalar(Math.sqrt(sp2));
    const off = _b.length();
    if (off < 0.5) {
      _a.crossVectors(v, GRAV).divideScalar(sp2);
      if (off > 1e-9) _a.addScaledVector(_b, (NOSE_K * Math.asin(off)) / off);
      const roll = w.dot(_f);
      w.copy(_a).addScaledVector(_f, roll - _a.dot(_f));
    }
  }
  _com.copy(_r.set(0, COM_Y, 0).applyQuaternion(q)).add(pos).addScaledVector(v, dt);
  const spin = w.length();
  if (spin > 1e-9) q.premultiply(_dq.setFromAxisAngle(_axis.copy(w).divideScalar(spin), spin * dt));
  _qi.copy(q).invert();

  const world = activeGround();
  const surf = car.surfaces ?? LOCAL;
  const ground = surf;
  surf.begin(car);
  const cr = car.deform.crush;
  const crushed = cr[0] !== 0 || cr[1] !== 0 || cr[2] !== 0 || cr[3] !== 0 || cr[4] !== 0;
  // A tyre within its springs' full travel of the ground sits in them: it pushes at most `SUPPORT` (shared by
  // the four, over every pass) and takes no positional lift. Past that, and for every body point, the contact is
  // rigid. Rigid tyres stopped a nose-first landing's front in one slice: 35 g on the body within one frame.
  const stop = 2 * droop(carClass(car));
  let budget = SUPPORT * dt;
  let n = 0;
  let wheels = 0;
  // The deepest rigid point's depth along its ground normal (a steep face's vertical gap overstates it).
  let deep = 0;
  _lift.set(0, 0, 0);
  _x.set(1, 0, 0).applyQuaternion(q);
  for (let i = 0; i < POINTS.length; i++) {
    if (i === HULL.length && !surf.near) break;
    const r = hullPoint(i, q, -COM_Y, R[n]!);
    if (crushed && i >= BODY_FROM && i < HULL.length) crushShift(i, q, cr, r);
    const px = _com.x + r.x;
    const py = _com.y + r.y;
    const pz = _com.z + r.z;
    const gy = ground.heightAt(px, pz, py);
    if (gy === NO_FLOOR) continue;
    const own = surf.owner;
    if (i >= HULL.length && own < 0) continue;
    const pen = gy - py;
    if (i < 4 && pen > -TOUCH) wheels++;
    if (pen <= 0) continue;
    ground.normalAt(px, pz, N[n]!, py);
    TYRE[n] = i < 4;
    OWN[n] = own;
    FOLLOW[n] = own >= 0 ? surf.follow : 1;
    SLOT[n] = surf.slot(own, N[n]!, i >= BODY_FROM && i < HULL.length, q);
    // How far past what holds it the point is: a tyre's springs and their full travel, else the surface.
    const sink = pen * N[n]!.y - (i < 4 ? stop : 0);
    SOFT[n] = i < 4 && sink < 0;
    SINK[n] = sink;
    n++;
  }

  for (let pass = 0; pass < 4; pass++) {
    for (let c = 0; c < n; c++) {
      const r = R[c]!;
      const nrm = N[c]!;
      const vn = _vp.crossVectors(w, r).add(v).dot(nrm);
      if (vn >= 0) continue;
      const e = pass === 0 && !TYRE[c] && vn < -BOUNCE_V ? RESTITUTION : 0;
      let jn = -(1 + e) * vn * reach(r, nrm, q);
      // A face carries what its strength law gives (`CarSurfaces.take`); the rest of the impulse is the face yielding.
      if (SLOT[c]! >= 0) jn = surf.take(SLOT[c]!, jn, G, dt);
      if (SOFT[c]) {
        jn = Math.min(jn, budget);
        budget -= jn;
      }
      if (OWN[c]! >= 0) surf.press(OWN[c]!, jn * nrm.y);
      push(v, w, q, r, nrm, jn);
      // Friction against the point's sliding: a tyre grips only across its tread (its axle laid in the contact plane).
      _vp.crossVectors(w, r).add(v);
      _vp.addScaledVector(nrm, -_vp.dot(nrm));
      if (TYRE[c]) {
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
  // The deepest point the ground can still hold up lifts the body out (a face that yields sinks instead).
  for (let c = 0; c < n; c++) {
    const s = SLOT[c]!;
    if (s >= 0 && surf.isYielding(s)) {
      if (!SOFT[c]) surf.note(s, SINK[c]!, FOLLOW[c]!);
    } else if (SINK[c]! > deep) {
      deep = SINK[c]!;
      _lift.copy(N[c]!).multiplyScalar(deep);
    }
  }
  _com.add(_lift);
  const yielded = surf.commit();
  // At rest: slow on three or more points whose ground is near level. Past ~14° a body there only creeps (a tyre grips
  // across its tread alone, gravity adds 0.04 m/s a slice, under `REST_V`), so freezing it held a car level on a slope,
  // tail on the road and the nose over the drop, for good (the stunt kicker's face): it keeps simulating until it
  // rolls onto its tyres (`land`) or its friction holds it.
  let up = 0;
  for (let c = 0; c < n; c++) up += N[c]!.y;
  if (n >= 3 && !yielded && up > REST_UP * n && v.lengthSq() < REST_V * REST_V && w.lengthSq() < REST_W * REST_W) {
    v.set(0, 0, 0);
    w.set(0, 0, 0);
  }
  car.airContact = n > 0;
  pos.copy(_com).sub(_r.set(0, COM_Y, 0).applyQuaternion(q));
  // Back on the ground sim: two wheels down, the body within ~25° of the ground's slope under it and its middle
  // within its wheels' `droop` of that ground (two wheels still on a ramp's lip under a body over the drop is not a landing).
  return (
    wheels >= 2 &&
    pos.y - world.heightAt(pos.x, pos.z, pos.y) < droop(carClass(car)) &&
    _r.set(0, 1, 0).applyQuaternion(q).dot(world.normalAt(_com.x, _com.z, _f, _com.y)) > UPRIGHT
  );
}
