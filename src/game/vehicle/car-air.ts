import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { CAR_HALF, WHEEL_POS } from "./car-mesh.ts";

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
/** The middle's ground this far (m) below a body: no wheel holds it, it flies (`DeformableCar.integrate`). */
export const AIR_GAP = 0.08;
/** A wheel this close (m) to the ground counts as down. */
const TOUCH = 0.03;
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
/** Below these speeds (m/s, rad/s) a body on three or more hull points is at rest (on two it can still tip). */
const REST_V = 0.15;
const REST_W = 0.3;

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
const R = HULL.map(() => new THREE.Vector3());
const _lift = new THREE.Vector3();
const N = HULL.map(() => new THREE.Vector3());
const TYRE = HULL.map(() => false);

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

  const ground = activeGround();
  let n = 0;
  let wheels = 0;
  // The deepest point's depth along its ground normal (a steep face's vertical gap overstates it).
  let deep = 0;
  _lift.set(0, 0, 0);
  _x.set(1, 0, 0).applyQuaternion(q);
  for (let i = 0; i < HULL.length; i++) {
    const [x, y, z] = HULL[i]!;
    const r = R[n]!.set(x, y - COM_Y, z).applyQuaternion(q);
    if (i < 4) {
      // A tyre's lowest point: down from its hub within the wheel's plane (the axle `_x` taken out), radius = hub height.
      _b.set(0, 1, 0).addScaledVector(_x, -_x.y);
      const l = _b.length();
      if (l > 0.2) r.addScaledVector(_b, -y / l);
    }
    const px = _com.x + r.x;
    const py = _com.y + r.y;
    const pz = _com.z + r.z;
    const gy = ground.heightAt(px, pz, py);
    if (gy === NO_FLOOR) continue;
    const pen = gy - py;
    if (i < 4 && pen > -TOUCH) wheels++;
    if (pen <= 0) continue;
    ground.normalAt(px, pz, N[n]!, py);
    TYRE[n] = i < 4;
    if (pen * N[n]!.y > deep) {
      deep = pen * N[n]!.y;
      _lift.copy(N[n]!).multiplyScalar(deep);
    }
    n++;
  }

  for (let pass = 0; pass < 4; pass++) {
    for (let c = 0; c < n; c++) {
      const r = R[c]!;
      const nrm = N[c]!;
      const vn = _vp.crossVectors(w, r).add(v).dot(nrm);
      if (vn >= 0) continue;
      const e = pass === 0 && !TYRE[c] && vn < -BOUNCE_V ? RESTITUTION : 0;
      const jn = -(1 + e) * vn * reach(r, nrm, q);
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
  _com.add(_lift);
  if (n >= 3 && v.lengthSq() < REST_V * REST_V && w.lengthSq() < REST_W * REST_W) {
    v.set(0, 0, 0);
    w.set(0, 0, 0);
  }
  car.airContact = n > 0;
  pos.copy(_com).sub(_r.set(0, COM_Y, 0).applyQuaternion(q));
  // Back on the ground sim: two wheels down, the body within ~25° of the ground's slope under it and its middle
  // within `AIR_GAP` of that ground (two wheels still on a ramp's lip under a body over the drop is not a landing).
  return (
    wheels >= 2 &&
    pos.y - ground.heightAt(pos.x, pos.z, pos.y) < AIR_GAP &&
    _r.set(0, 1, 0).applyQuaternion(q).dot(ground.normalAt(_com.x, _com.z, _f, _com.y)) > UPRIGHT
  );
}
