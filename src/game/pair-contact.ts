import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { leftoverCrumple, cancelClosing, satPushCap, CRASH } from "./physics-util.ts";
import { satCars } from "./sat.ts";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();

export type PairHit = {
  impulse: number;
  contact: THREE.Vector3;
  normal: THREE.Vector3;
};

export function impulseCar(car: DeformableCar, nx: number, ny: number, nz: number, j: number): void {
  if (j === 0) return;
  if (car.deform.massActive) {
    car.deform.applyImpulse(nx, ny, nz, j);
    return;
  }
  const inv = 1 / car.deform.totalMass;
  car.velocity.x += nx * j * inv;
  car.velocity.y += ny * j * inv;
  car.velocity.z += nz * j * inv;
}

export function pushCar(car: DeformableCar, nx: number, ny: number, nz: number, amount: number): void {
  if (car.deform.massActive) {
    const sep = Math.min(amount, 0.09);
    car.deform.separateAlong(nx, ny, nz, sep);
    car.deform.followGroup(car.group, car.velocity, car.angular, 0);
    car.refreshBasis();
    return;
  }
  car.group.position.x += nx * amount;
  car.group.position.y += ny * amount;
  car.group.position.z += nz * amount;
  car.group.updateMatrixWorld();
  car.refreshBasis();
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
}

/**
 * Pair SAT + crumple. Persistent overlap after the zone is spent must not
 * keep dumping cancelClosing (that is the 10s / 120 km/h zip).
 */
export function resolveCarPair(
  carA: DeformableCar,
  carB: DeformableCar,
  deform: boolean,
  feed: boolean,
  dt: number,
): PairHit | null {
  const dist = carA.group.position.distanceTo(carB.group.position);
  if (dist > 5.2) return null;

  const crushHit = satCars(carA, carB, _cn, _cp, (c) => c.crushHulls());
  const hit = satCars(carA, carB, _n, _p, (c) => c.hulls());
  if (!crushHit && !hit) return null;

  const n = crushHit ? _cn : _n;
  n.y = 0;
  if (n.lengthSq() > 1e-8) n.normalize();
  _n.y = 0;
  if (_n.lengthSq() > 1e-8) _n.normalize();
  _cn.y = 0;
  if (_cn.lengthSq() > 1e-8) _cn.normalize();
  const p = crushHit ? _cp : _p;
  const rel = _v.copy(carA.velocity).sub(carB.velocity);
  const closing = -rel.dot(n);

  // Overlap after the wreck has settled is not a new hit — notifying every
  // slice zeroed quietTime and disabled damping for the whole clip.
  if (closing > CRASH.grazeMps) {
    carA.deform.notifyContact();
    carB.deform.notifyContact();
  }

  if (deform && closing > 0.2 && (crushHit ?? hit ?? 0) > 0.006) {
    if (!carA.crashed) carA.applyImpact(p, n.clone(), closing);
    if (!carB.crashed) carB.applyImpact(p, n.clone().negate(), closing);
  }

  let remain = Math.max(0, closing);
  if (feed && crushHit) {
    const remainA = carA.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
    const remainB = carB.deform.feedOverlap(_cp, _w.copy(_cn).negate(), crushHit, Math.max(0, closing), dt);
    remain = Math.max(0, Math.min(remainA, remainB));
  }

  const leftoverA = leftoverCrumple(carA.deform.crumpleTravelCorner());
  const leftoverB = leftoverCrumple(carB.deform.crumpleTravelCorner());
  const leftover = Math.min(leftoverA, leftoverB);
  const pass = Math.min(carA.deform.frontTransfer(), carB.deform.frontTransfer());
  const packed = leftover < 0.12;

  if (hit) {
    const maxPen = packed ? 0.02 : leftover * 0.1;
    const extra = Math.max(0, hit - maxPen);
    const push = Math.min(extra + 0.006, satPushCap(dt));
    const both = carA.deform.massActive && carB.deform.massActive;
    const aAmt = both ? push * 0.5 : carA.deform.massActive ? push * 0.62 : push * 0.38;
    pushCar(carA, _n.x, 0, _n.z, aAmt);
    pushCar(carB, -_n.x, 0, -_n.z, push - aAmt);
  } else if (crushHit) {
    const allowed = leftoverA * 0.45 + leftoverB * 0.45 + 0.08;
    const extra = Math.min(crushHit - allowed, 0.04);
    if (extra > 0.012) {
      pushCar(carA, _cn.x, 0, _cn.z, extra * 0.5);
      pushCar(carB, -_cn.x, 0, -_cn.z, extra * 0.5);
    }
  }

  // Rigid 2.15 m COM gap launches crushed cars whose noses already occupy
  // that space. Only keep a floor while the crumple zone is still long.
  if (leftover > 0.25 && dist > 1e-4) {
    const minSep = 2.15 + leftoverA * 0.28 + leftoverB * 0.28;
    if (dist < minSep) {
      _w.copy(carA.group.position).sub(carB.group.position).setY(0);
      if (_w.lengthSq() > 1e-8) {
        _w.normalize();
        const extra = Math.min((minSep - dist) * 0.5, satPushCap(dt));
        pushCar(carA, _w.x, 0, _w.z, extra);
        pushCar(carB, -_w.x, 0, -_w.z, extra);
      }
    }
  }

  if (hit && feed && remain > 0.25) {
    const e = pass >= 0.97 ? 0.02 : 0;
    const invA = 1 / carA.deform.totalMass;
    const invB = 1 / carB.deform.totalMass;
    if (!packed) {
      const jMax = 18 + pass * 36;
      const j = Math.min(cancelClosing(remain, pass, invA + invB, dt, e), jMax);
      impulseCar(carA, _n.x, 0, _n.z, j);
      impulseCar(carB, -_n.x, 0, -_n.z, j);

      const tAx = carA.velocity.x - carB.velocity.x;
      const tAz = carA.velocity.z - carB.velocity.z;
      const relT = tAx * _n.z - tAz * _n.x;
      const mu = 0.45;
      const jt = THREE.MathUtils.clamp(relT / (invA + invB), -mu * j, mu * j);
      impulseCar(carA, _n.z, 0, -_n.x, -jt);
      impulseCar(carB, _n.z, 0, -_n.x, jt);

      _r.copy(_p).sub(carA.group.position);
      carA.angular.y += (_r.x * _n.z - _r.z * _n.x) * j * 0.00008;
      _r.copy(_p).sub(carB.group.position);
      carB.angular.y += (_r.x * -_n.z - _r.z * -_n.x) * j * 0.00008;
    } else {
      // Zone spent: kill leftover closing on the cabin, not the bumper.
      const j = Math.min(cancelClosing(remain, 1, invA + invB, dt, 0), remain / (invA + invB));
      const dvA = j * invA;
      const dvB = j * invB;
      carA.deform.kickCore(_n.x, 0, _n.z, dvA);
      carB.deform.kickCore(-_n.x, 0, -_n.z, dvB);
      carA.velocity.x += _n.x * dvA;
      carA.velocity.z += _n.z * dvA;
      carB.velocity.x -= _n.x * dvB;
      carB.velocity.z -= _n.z * dvB;
    }
  }

  return { impulse: Math.max(closing, (crushHit ?? hit ?? 0) * 6), contact: p.clone(), normal: n.clone() };
}

/** One physics slice for a pair — same order as CrashEngine.fixedStep. */
export function stepCarPair(carA: DeformableCar, carB: DeformableCar, dt: number): void {
  if (!carA.deform.massActive) carA.integrate(dt);
  else carA.syncPose(dt);
  if (!carB.deform.massActive) carB.integrate(dt);
  else carB.syncPose(dt);

  if (carA.deform.massActive || carB.deform.massActive) carA.deform.collideWith(carB.deform);

  const satBusy = carA.velocity.lengthSq() > 1.4 || carB.velocity.lengthSq() > 1.4;
  const leftover = Math.min(
    leftoverCrumple(carA.deform.crumpleTravelCorner()),
    leftoverCrumple(carB.deform.crumpleTravelCorner()),
  );
  const wrecked = carA.crashed && carB.crashed && leftover < 0.2;
  const iters = satBusy && !wrecked ? 3 : 1;
  for (let k = 0; k < iters; k++) {
    if (carA.deform.massActive) carA.syncPose(0);
    else carA.refreshBasis();
    if (carB.deform.massActive) carB.syncPose(0);
    else carB.refreshBasis();
    const hit = resolveCarPair(carA, carB, !(carA.crashed && carB.crashed), k === 0, dt);
    if (!hit) break;
  }

  if (carA.deform.massActive) {
    carA.deform.stepStructure(dt);
    carA.syncPose(dt);
  }
  if (carB.deform.massActive) {
    carB.deform.stepStructure(dt);
    carB.syncPose(dt);
  }
  carA.afterContacts(dt);
  carB.afterContacts(dt);
}
