import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { armPairWithRows, MU_BODY, rowsClosing, WALL_CRUSH } from "../vehicle/car-air.ts";
import type { MassNode } from "../deform/deform-rig.ts";
import { leftoverCrumple, cancelClosing, satPushCap, hypot2, CRASH } from "../deform/physics-util.ts";
import { satCars } from "./sat.ts";
import { bandsMeet, OUTLINE_REACH } from "./cage-outline.ts";
import { strikeCar, faceDepth, type ContactBox } from "./external-contact.ts";
import { ARM_CLOSING, SOLID_E } from "./constants.ts";
import { TYRE_HALF_W } from "../deform/deform-contact.ts";
import { FOOT_HALF_L } from "../vehicle/car-mesh.ts";
import { SOLID_AT_REST } from "../world/constants.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { detSin, detCos } from "../kernel/physics-core.js";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tn = new THREE.Vector3();

type PairHit = {
  impulse: number;
  contact: THREE.Vector3;
  normal: THREE.Vector3;
};
/** `resolveCarPair`'s result, rewritten by every call: read or copy it (`StrongestContact`) before the next. */
const _hit: PairHit = { impulse: 0, contact: new THREE.Vector3(), normal: new THREE.Vector3() };

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

export function pushCar(car: DeformableCar, nx: number, ny: number, nz: number, amount: number, dv = 0): void {
  if (car.deform.massActive) {
    const sep = Math.min(amount, 0.09);
    car.deform.separateAlong(nx, ny, nz, sep, dv);
    car.deform.followGroup(car.group, car.velocity, car.angular, 0);
    car.refreshBasis();
    return;
  }
  car.group.position.x += nx * amount;
  car.group.position.y += ny * amount;
  car.group.position.z += nz * amount;
  car.velocity.x += nx * dv;
  car.velocity.z += nz * dv;
  car.refreshBasis();
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
}

/**
 * How deep (m) a rigid car's footprint may sit in a solid with its hull not on the face yet; and how deep (m) a wreck's footprint may,
 * the most a crushed nose is shorter than the box it was built in (a wreck driven in further, by a car ramming it, is put back). The
 * rebound of a light touch is `SOLID_E` (a crash is past `WALL_CRUSH`).
 */
const WALL_HOLD = 0.4;
const WALL_REACH = 1.2;
/** How deep (m) a wreck's crush hulls may sit in a solid it has stopped driving into (the speed it has stopped at is `SOLID_AT_REST`). */
const WALL_SKIN = 0.015;

/**
 * Seconds of travel ahead of a car driving hard into a fixed solid or another car at which its step is a hit step (`nearHit`): two
 * steps of `SimPacer`'s 1/120 s floor, so no step carries it from clear of the face to inside it (0.46 m a step at 55 m/s).
 */
export const HIT_AHEAD = 1 / 60;
/**
 * A car `gap` m from a face (a fixed solid's or another car's; negative: in it) and closing on it at `closing` m/s is about to
 * land a hard hit (`WALL_CRUSH`) when the face is within `HIT_AHEAD` s of travel: whether the crush then kills the engine no longer
 * depends on where the step grid falls on the contact (`stepWorld` cuts such a step to the pacer's fine slice).
 */
export function markApproach(car: DeformableCar, gap: number, closing: number): void {
  if (closing > WALL_CRUSH && gap < closing * HIT_AHEAD) car.nearHit = true;
}

/** `markApproach` for each near pair (`pairs[0..count)` as index pairs, stepWorld's `collectNear` list, 7 m: more than a
 *  1/60 s look-ahead of any closing speed a car reaches) on one level: each one's gap to the other's nose or flank and their
 *  closing speed along the line of centres. The course marks the solids (`RaceField`). */
export function markApproaches(cars: readonly DeformableCar[], pairs: Int32Array, count: number): void {
  for (let k = 0; k < count; k += 2) {
    const ca = cars[pairs[k]!]!;
    const cb = cars[pairs[k + 1]!]!;
    const dx = cb.group.position.x - ca.group.position.x;
    const dz = cb.group.position.z - ca.group.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 === 0 || !bandsMeet(ca, cb) || ca.falling || cb.falling) continue;
    const d = Math.sqrt(d2);
    const closing = ((ca.velocity.x - cb.velocity.x) * dx + (ca.velocity.z - cb.velocity.z) * dz) / d;
    markApproach(ca, d - 2 * FOOT_HALF_L, closing);
    markApproach(cb, d - 2 * FOOT_HALF_L, closing);
  }
}

/** Move a wreck, every mass and its group, `d` m along the unit (nx, nz). */
function shoveWreck(car: DeformableCar, nx: number, nz: number, d: number): void {
  car.deform.translateMasses(nx * d, nz * d, 0, 0);
  car.group.position.x += nx * d;
  car.group.position.z += nz * d;
}

/**
 * `car` met a fixed solid (a race wall, a prop, a ramp's flank) whose car-side face is `face` (`solidFace`), its footprint
 * `pen` deep along the unit normal (nx, nz). A hard hit (past `WALL_CRUSH` into the face) or a wreck meets it as the range's
 * jersey slab does (`bodyContact`): the first touch starts the crash, a fresh hard one re-arms a wreck's, the masses are held
 * on the face and the crush force spends the hit's stroke, so the car goes on into the face at its own speed until the stroke
 * is gone (the wall used to cancel and bounce the whole closing speed in one step, before the crush had anything to take).
 * A light touch of a whole car, or a hard one whose hull is still `WALL_HOLD` short of the face while the footprint is in it
 * (a corner the face does not reach), pushes out and bounces by `WALL_E`; the car's tyres and its body's friction on the face
 * hold it where it touched or let it slide along the face. `held`: the wall's plane was met already this slice by another face of it
 * (the pieces of one wall share one hold face), so a hard hit has nothing left to do here.
 */
export function wallBounce(car: DeformableCar, face: ContactBox, nx: number, nz: number, pen: number, dt: number, held: boolean): void {
  const v = car.velocity;
  const pos = car.group.position;
  const fx = detSin(face.yaw);
  // `solidFace`'s box is a plan face with no height of its own: it stands at the car's.
  face.y = pos.y + 0.48;
  const fz = detCos(face.yaw);
  const into = -(v.x * fx + v.z * fz);
  if (into > WALL_CRUSH || car.deform.massActive) {
    if (held) return;
    strikeCar(car, face, dt, true);
    if (car.deform.massActive) {
      const over = pen - WALL_REACH;
      if (over > 0) shoveWreck(car, nx, nz, over);
      // The drawn body (the cage's vertices, `faceDepth`) is pushed out as the slab pushes it: while the car drives in as far as the
      // crumple of the face it is struck on (`faceTravel`, as the pair's own crush reads it) left allows (`0.4 · leftover`), at rest to
      // the skin, so a wreck a car pins against the solid is never left in it.
      const drive = Math.max(0, Math.min(1, (into - SOLID_AT_REST) / (WALL_CRUSH - SOLID_AT_REST)));
      const room = WALL_SKIN + (0.4 * leftoverCrumple(car.deform.faceTravel()) - WALL_SKIN) * drive;
      const sunk = faceDepth(car, face) - room;
      if (sunk > 0) shoveWreck(car, fx, fz, Math.min(sunk + 0.004, Math.max(pen, satPushCap(dt))));
      return;
    }
    if (pen < WALL_HOLD) return;
  }
  const closing = Math.max(0, -(v.x * nx + v.z * nz));
  const along0 = v.z * nx - v.x * nz;
  let j = closing * (1 + SOLID_E);
  // A car on its wheels goes where its nose points as far as the sideways grip its tyres have left this step holds it
  // (`drive.hold`): the face and the tyres meet the closing speed together, and the face takes what the tyres leave.
  const r = car.rightFlat;
  const k = nx * r.x + nz * r.z;
  if (closing > 0 && car.drive.hold > 0 && k * k < 1) {
    const side = v.x * r.x + v.z * r.z;
    const held = (j + k * side) / (1 - k * k);
    if (held >= 0) {
      const b = Math.max(-car.drive.hold, Math.min(car.drive.hold, -side - held * k));
      j = Math.max(0, j - b * k);
      car.drive.hold -= Math.abs(b);
      v.x += r.x * b;
      v.z += r.z * b;
    }
  }
  v.x += nx * j;
  v.z += nz * j;
  // The body scrapes the face: its friction takes at most `MU_BODY` of the face's push from the speed along it. A face that
  // takes all of it holds the car where it touched, so the push out takes it back the way it came in. Met one after the
  // other, the tyres kept the share of the face's along speed that lies along the nose, which drives into the face again,
  // and pushed out square to the face, a held car kept each slice's move along it and each crossing of the push's skin: a
  // car driven at a face 30° off it crept along it at 0.2–0.4 m/s.
  const along = v.z * nx - v.x * nz;
  const stuck = Math.abs(along) <= MU_BODY * j;
  const rub = stuck ? along : Math.sign(along) * MU_BODY * j;
  v.x += nz * rub;
  v.z -= nx * rub;
  const back = stuck && closing > 0 ? (along0 * pen) / closing : 0;
  pos.x += nx * pen + nz * back;
  pos.z += nz * pen - nx * back;
}

/**
 * A pair's shove of one slice: car A along the unit (nx, nz) by `aAmt` m, car B against it by `bAmt`, each within its wreck's
 * per-slice budget (`takePush`): the three SAT passes of one slice each pushing a full `satPushCap` moved a wedged wreck
 * 0.11 m in 6 ms (derby group pops), and one cap a slice, shared with the sphere shifts and wall translations, still put
 * 0.04–0.05 m a step on a slow wedged wreck against a zip bound of 3·v·h + 0.05 m: the cap is a push-out speed that grows
 * only with the speed of the cars touching.
 *
 * A shove moves positions, so the cars' velocities carry it: what two closing cars push apart in a slice is the momentum that
 * stops their closing, shared by mass (the pair's momentum is kept) and never more than the `closing` speed (m/s, along the
 * push) there is, and a car's share of it is carried by its velocity one slice on, not also moved by position. Before this a
 * pusher kept its drive speed while its shoves moved the car it drove into 3.6–8.4 m/s at a reported speed under 1 m/s (derby
 * 10 cars, 40 s: 791 car-frames over 0.06 m in 1/60 s at under 1 m/s in the browser on main ef6611a, 221 a heat headless).
 * With `closing` 0 (the COM-gap floor, the tyres' stop: the closing is held or spent already) the shove is a position
 * correction alone. Returns the closing speed (m/s) it took.
 */
function pushApart(carA: DeformableCar, carB: DeformableCar, nx: number, nz: number, aAmt: number, bAmt: number, dt: number, closing: number): number {
  const touchSpeed = Math.max(hypot2(carA.velocity.x, carA.velocity.z), hypot2(carB.velocity.x, carB.velocity.z));
  const okA = carA.deform.massActive ? carA.deform.takePush(nx, nz, aAmt, dt, touchSpeed) : aAmt;
  const okB = carB.deform.massActive ? carB.deform.takePush(-nx, -nz, bAmt, dt, touchSpeed) : bAmt;
  const dv = Math.max(0, Math.min((okA + okB) / dt, closing));
  const kA = (dv * carB.deform.totalMass) / (carA.deform.totalMass + carB.deform.totalMass);
  const kB = dv - kA;
  // The velocity a car takes carries its share of the shove one slice on: only what it does not carry is moved by position.
  pushCar(carA, nx, 0, nz, Math.max(0, okA - kA * dt), kA);
  pushCar(carB, -nx, 0, -nz, Math.max(0, okB - kB * dt), kB);
  return dv;
}

/** The speed (m/s) car A and B close along the unit (nx, nz), which points from B to A. */
function closingAlong(carA: DeformableCar, carB: DeformableCar, nx: number, nz: number): number {
  return (carB.velocity.x - carA.velocity.x) * nx + (carB.velocity.z - carA.velocity.z) * nz;
}

/** A car's momentum over its mass (m/s) along the unit (nx, nz): its masses' mean velocity, whatever its frame last read. */
function momentumAlong(car: DeformableCar, nx: number, nz: number): number {
  if (!car.deform.massActive) return car.velocity.x * nx + car.velocity.z * nz;
  let p = 0;
  let m = 0;
  for (const q of car.deform.masses) {
    if (!q.dynamic) continue;
    p += (q.vel.x * nx + q.vel.z * nz) * q.mass;
    m += q.mass;
  }
  return m > 0 ? p / m : 0;
}

/**
 * Rigid 2.15 m COM gap launches crushed cars whose noses already occupy that space. It is the packed structure's floor, so it
 * holds only once the crush along the contact is spent on both cars (`spent`, from `strokeUsed`: the struck face's stroke, a
 * door on a flank, not the nose the hit never touched; the minimum gap too reads the struck face's travel, `faceTravel`),
 * and while they are still closing. Before that the crush and the hit's impulse carry the exchange. Once it holds, the pair
 * meets as a rigid inelastic impact along the line of centres (`stopClosing`, once a slice); the position push after it
 * only takes the pair out of the floor, so a push never becomes velocity.
 */
function holdComGap(carA: DeformableCar, carB: DeformableCar, leftoverA: number, leftoverB: number, dist: number, feed: boolean, dt: number): void {
  const minSep = 2.15 + leftoverA * 0.28 + leftoverB * 0.28;
  if (dist >= minSep) return;
  _w.copy(carA.group.position).sub(carB.group.position).setY(0);
  if (_w.lengthSq() < 1e-8) return;
  _w.normalize();
  if (feed) stopClosing(carA, carB, _w.x, _w.z);
  const extra = Math.min((minSep - dist) * 0.5, satPushCap(dt));
  pushApart(carA, carB, _w.x, _w.z, extra, extra, dt, 0);
}

/**
 * A rigid inelastic impact: every dynamic mass of both cars takes the speed the pair's momentum gives along the unit (nx, nz),
 * from B to A (`vc`), so they leave together, momentum kept and no internal speed left. Spent structures are one body: a mass
 * given only the pair's mean closing (an equal dv) kept the speed it had inside its car (a bumper pushed back at 21 m/s, the
 * cabin on at 14) and the shift rang the crush (200 km/h head-on: nose 0.775 m, clamped masses at ±8 m/s that a quiet wreck
 * let go 0.2 s later). A car's reported velocity is then the one its masses carry.
 */
function stopClosing(carA: DeformableCar, carB: DeformableCar, nx: number, nz: number): void {
  const vA = momentumAlong(carA, nx, nz);
  const vB = momentumAlong(carB, nx, nz);
  if (vB - vA <= 0) return;
  const mA = carA.deform.totalMass;
  const mB = carB.deform.totalMass;
  const vc = (mA * vA + mB * vB) / (mA + mB);
  matchAlong(carA, nx, nz, vA, vc);
  matchAlong(carB, nx, nz, vB, vc);
}

/** Set every dynamic mass's speed along the unit (nx, nz) to `vc`; the car's mean there was `mean`. */
function matchAlong(car: DeformableCar, nx: number, nz: number, mean: number, vc: number): void {
  if (car.deform.massActive) {
    for (const q of car.deform.masses) {
      if (!q.dynamic) continue;
      const d = vc - (q.vel.x * nx + q.vel.z * nz);
      q.vel.x += nx * d;
      q.vel.z += nz * d;
    }
  }
  car.velocity.x += nx * (vc - mean);
  car.velocity.z += nz * (vc - mean);
}

/** Centre-to-centre gap (m, about a car's width) that `closingCap` stops a pair's closing before. */
const STOP_GAP = 2;

/** Share of a hit's stroke (`strokeUsed`) both noses must have crushed before the packed structure (B1) or the tyres stop a pair's closing. */
const PACKED_STROKE = 0.9;
/** |cos| between a tyre contact's normal and each car's heading above which the contact is end-on (head-on, nose into tail). */
const END_ON = 0.7;

/**
 * Most closing impulse (N·s) one slice may cancel: 18 + 36·pass lets a hit grind on through the crumple,
 * raised to the impulse that stops the closing before the centres come within STOP_GAP. Uncapped, a derby
 * shove spun a pinned car past 5 rad/s (ten-car derby, 4 of 12 heats; main 1) and slid a squeezed one
 * 6–9 cm a slice (3 of 12; main 0). The bare cap shoved a t-bone's struck car at ~17 m/s² while the bullet
 * ground on, and from 58 m/s its nose came out of the struck car's far side (barrier.test.ts).
 */
function closingCap(remain: number, pass: number, invSum: number, dist: number, dt: number): number {
  return Math.max(18 + pass * 36, (remain * remain * dt) / (2 * Math.max(dist - STOP_GAP, 0.05) * invSum));
}

/**
 * Pair SAT + crumple. Persistent overlap after the zone is spent must not
 * keep dumping cancelClosing (that is the 10s / 120 km/h zip). Every contact
 * offers each car a hit: the first one starts its crash, a fresh hard one on
 * a wreck re-arms a new hit (`DeformableCar.applyImpact`). The closing impulse is capped by `closingCap`.
 */
export function resolveCarPair(carA: DeformableCar, carB: DeformableCar, feed: boolean, dt: number): PairHit | null {
  const pa = carA.group.position;
  const pb = carB.group.position;
  const gx = pa.x - pb.x;
  const gy = pa.y - pb.y;
  const gz = pa.z - pb.z;
  const dist = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (dist > 5.2) return null;

  const hit = satCars(carA, carB, _n, _p);
  if (hit === null) {
    // The drawn bodies can be apart while the tyres, which never crush, already meet: in a
    // 100 km/h head-on the bodies missed for a frame and the tyres passed 0.25 m through each other.
    if (!tyreStop(carA, carB, dt, _tn)) return null;
    _hit.impulse = 0;
    _hit.contact.copy(_p.copy(carA.group.position).add(carB.group.position).multiplyScalar(0.5));
    _hit.normal.copy(_tn);
    return _hit;
  }

  const n = _n;
  n.y = 0;
  if (n.lengthSq() > 1e-8) n.normalize();
  const rel = _v.copy(carA.velocity).sub(carB.velocity);
  const closing = -rel.dot(n);
  // What the pair met with: the rows of the rigid step that met it this slice have traded part of it already (read before `armPairWithRows` takes them).
  const met = Math.max(closing, rowsClosing(carA, carB));

  if (closing > ARM_CLOSING && hit > 0.006) {
    // Equivalent barrier speed: each car takes the closing share the other's mass pushes into it. The rows of the rigid step that met
    // this pair in this slice (a car's nose on the other's top) read the same contact from before their exchange: it is armed once, at
    // the larger reading, as it stood before it (`armPairWithRows`).
    // Before notifyContact: a wreck's re-arm reads how long it has been quiet.
    const mA = carA.deform.totalMass;
    const mB = carB.deform.totalMass;
    const shareA = (closing * mB) / (mA + mB);
    const shareB = (closing * mA) / (mA + mB);
    if (!armPairWithRows(carA, carB, _p, n, closing, shareA, shareB)) {
      carA.applyImpact(_p, n, closing, shareA);
      carB.applyImpact(_p, _w.copy(n).negate(), closing, shareB);
    }
  }

  // Overlap after the wreck has settled is not a new hit — notifying every
  // slice zeroed quietTime and disabled damping for the whole clip.
  if (closing > CRASH.grazeMps) {
    carA.deform.notifyContact();
    carB.deform.notifyContact();
  }

  let remain = Math.max(0, closing);
  if (feed) {
    // A side contact drives each car's contact masses to the pair's common speed along the normal: a
    // fixed-face kill (0) stopped a T-bone bullet's nose dead while the struck car got no momentum, only
    // whole-body pushes, so its door never crushed (0.02 m vs the 0.12–0.28 m band).
    // ponytail: end-on pairs keep the fixed-face kill, which the piston rig's frontal parity is matched
    // to; driving a struck nose to the common speed makes its tail lag into crush (beams have no yield
    // force). Upgrade path: car-car through external-contact's bodyContact (CONTACT_PARITY.md).
    let vc = 0;
    const rA = carA.rightFlat, fA = carA.fwdFlat, rB = carB.rightFlat, fB = carB.fwdFlat;
    const sideA = Math.abs(_n.x * rA.x + _n.z * rA.z) > Math.abs(_n.x * fA.x + _n.z * fA.z);
    if (sideA || Math.abs(_n.x * rB.x + _n.z * rB.z) > Math.abs(_n.x * fB.x + _n.z * fB.z)) {
      const mA = carA.deform.totalMass;
      const mB = carB.deform.totalMass;
      vc = (mA * carA.velocity.dot(_n) + mB * carB.velocity.dot(_n)) / (mA + mB);
    }
    // The crush a hit feeds scales with the depth of the overlap, and the drawn bodies' contact begins where their surfaces do (the
    // cage): a hit's first slice is as deep as the closing travelled after the touch, anywhere up to the slice's whole travel, so the
    // feed is never less than that travel (`closing * dt`).
    const fed = Math.max(hit, closing * dt);
    const remainA = carA.deform.feedOverlap(_p, _n, fed, Math.max(0, closing), dt, vc);
    const remainB = carB.deform.feedOverlap(_p, _w.copy(_n).negate(), fed, Math.max(0, closing), dt, -vc);
    remain = Math.max(0, Math.min(remainA, remainB));
  }
  const spent = carA.crashed && carB.crashed && Math.min(carA.deform.strokeUsed(), carB.deform.strokeUsed()) >= PACKED_STROKE;
  if (feed && closing > 0 && spent) {
    // Both noses have crushed their stroke for this hit (B1): the packed
    // structure stops the relative closing, toward the pair's common velocity.
    const mA = carA.deform.totalMass;
    const mB = carB.deform.totalMass;
    const j = ((mA * mB) / (mA + mB)) * closing;
    const comVn = (mA * carA.velocity.dot(_n) + mB * carB.velocity.dot(_n)) / (mA + mB);
    carA.deform.shiftBody((_n.x * j) / mA, (_n.z * j) / mA, 0, 0, 0, _n.x, _n.z, comVn);
    carB.deform.shiftBody((-_n.x * j) / mB, (-_n.z * j) / mB, 0, 0, 0, -_n.x, -_n.z, -comVn);
  }

  const leftoverA = leftoverCrumple(carA.deform.faceTravel());
  const leftoverB = leftoverCrumple(carB.deform.faceTravel());
  const leftover = Math.min(leftoverA, leftoverB);
  const pass = Math.min(carA.deform.frontTransfer(), carB.deform.frontTransfer());
  const packed = leftover < 0.12;
  // The hit's pushes trade momentum (`pushApart`); the COM-gap floor below exchanges the pair's momentum itself once the crush is spent.
  // The cage's overlap is the crush's to take (`feedOverlap`): as deep as this slice's own travel explains it (`closing * dt`, how
  // deep a body that was clear at the last slice can be) or as the stroke this hit has left on either face (`hitStroke`, the speed's
  // crush length, less what `strokeUsed` has taken). Only what is deeper is a push.
  // A push moves the cars apart by position, so it carries the closing it trades (`pushApart`) on a slice that does not feed the crush (on a
  // feed slice `feedOverlap` drives the contact masses to the pair's common speed: the exchange is its), unless the zone is packed and not
  // spent (its momentum is the zone-spent path's, `kickCore` below). A shove that kept no velocity moved the struck car 0.06 m a frame at a
  // reported speed under 1 m/s (shove-momentum), and a pair held at its closing for 15 frames against a heavy flank (ejection-matrix:
  // t-bone sedan into monster, thrown at 17.4 m/s).
  const give = Math.max(carA.deform.hitStroke() * (1 - carA.deform.strokeUsed()), carB.deform.hitStroke() * (1 - carB.deform.strokeUsed()));
  const extra = Math.max(0, hit - OUTLINE_REACH - Math.max(give, closing * dt));
  if (extra > 0) {
    const push = Math.min(extra + 0.006, satPushCap(dt));
    const both = carA.deform.massActive && carB.deform.massActive;
    const aAmt = both ? push * 0.5 : carA.deform.massActive ? push * 0.62 : push * 0.38;
    remain = Math.max(0, remain - pushApart(carA, carB, _n.x, _n.z, aAmt, push - aAmt, dt, !feed && (spent || !packed) ? closingAlong(carA, carB, _n.x, _n.z) : 0));
  }

  if (spent && closing > 0 && dist > 1e-4) holdComGap(carA, carB, leftoverA, leftoverB, dist, feed, dt);

  if (feed && extra > 0 && remain > 0.25) {
    const e = pass >= 0.97 ? 0.02 : 0;
    const invA = 1 / carA.deform.totalMass;
    const invB = 1 / carB.deform.totalMass;
    if (!packed) {
      const j = Math.min(cancelClosing(remain, pass, invA + invB, dt, e), closingCap(remain, pass, invA + invB, dist, dt));
      impulseCar(carA, _n.x, 0, _n.z, j);
      impulseCar(carB, -_n.x, 0, -_n.z, j);

      const tAx = carA.velocity.x - carB.velocity.x;
      const tAz = carA.velocity.z - carB.velocity.z;
      const relT = tAx * _n.z - tAz * _n.x;
      const mu = 0.45;
      const jt = Math.max(-mu * j, Math.min(mu * j, relT / (invA + invB)));
      impulseCar(carA, _n.z, 0, -_n.x, -jt);
      impulseCar(carB, _n.z, 0, -_n.x, jt);
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

  tyreStop(carA, carB, dt, _tn);
  _hit.impulse = Math.max(met, hit * 6);
  _hit.contact.copy(_p);
  _hit.normal.copy(n);
  return _hit;
}

/** A pair's four tyre-rectangle axes (unit x, z) and both tyres' summed half-extent along each. */
const _axes = new Float64Array(12);

/** A tyre seen from above is a 2·TYRE_R × 2·TYRE_HALF_W rectangle on its hub, along its car. */
function tyreAxes(carA: DeformableCar, carB: DeformableCar): void {
  const fA = carA.fwdFlat,
    rA = carA.rightFlat,
    fB = carB.fwdFlat,
    rB = carB.rightFlat;
  for (let k = 0; k < 4; k++) {
    const u = k === 0 ? fA : k === 1 ? rA : k === 2 ? fB : rB;
    _axes[k * 3] = u.x;
    _axes[k * 3 + 1] = u.z;
    _axes[k * 3 + 2] =
      TYRE_R * (Math.abs(fA.x * u.x + fA.z * u.z) + Math.abs(fB.x * u.x + fB.z * u.z)) +
      TYRE_HALF_W * (Math.abs(rA.x * u.x + rA.z * u.z) + Math.abs(rB.x * u.x + rB.z * u.z));
  }
}

/** Deepest overlap (m) of the two cars' tyres, negative for the closest clearance. */
export function tyreOverlap(carA: DeformableCar, carB: DeformableCar): number {
  tyreAxes(carA, carB);
  let depth = -Infinity;
  for (let ai = 0; ai < carA.deform.masses.length; ai++) {
    const a = carA.deform.masses[ai]!;
    if (!a.hub || a.popped) continue;
    for (let bi = 0; bi < carB.deform.masses.length; bi++) {
      const b = carB.deform.masses[bi]!;
      if (!b.hub || b.popped) continue;
      const dx = a.world.x - b.world.x;
      const dz = a.world.z - b.world.z;
      let pen = Infinity;
      for (let k = 0; k < 12; k += 3) pen = Math.min(pen, _axes[k + 2]! - Math.abs(dx * _axes[k]! + dz * _axes[k + 1]!));
      depth = Math.max(depth, pen);
    }
  }
  return depth;
}

/**
 * The tyres are the pair's final stop: the owner's dead-on showed them passing through each other (64 km/h
 * head-on: 0.091 m, 72+: 0.22 m). A swept test of every tyre pair over this slice of `dt` finds the first to
 * meet, and its normal (B → A, into `normalOut`): the closing that would carry those tyres in goes to the
 * pair's common speed, as for packed noses (B1), and tyres already overlapping part within the push budget.
 * Stopping only once they overlapped let one slice carry them its whole travel through (80 km/h: 0.17 m).
 * That stop is final for packed noses and for hits too soft to reach the wheels (`hubReach`); end-on with stroke
 * left (`PACKED_STROKE`) the touching wheels tear off their hubs and the noses crush on, so a harder hit crushes at least as far.
 */
function tyreStop(carA: DeformableCar, carB: DeformableCar, dt: number, normalOut: THREE.Vector3): boolean {
  if (!carA.deform.massActive || !carB.deform.massActive) return false;
  tyreAxes(carA, carB);
  // A's travel relative to B over the slice.
  const wx = (carA.velocity.x - carB.velocity.x) * dt;
  const wz = (carA.velocity.z - carB.velocity.z) * dt;
  let first = Infinity,
    depth = 0,
    hubA: MassNode | null = null,
    hubB: MassNode | null = null;
  for (let ai = 0; ai < carA.deform.masses.length; ai++) {
    const a = carA.deform.masses[ai]!;
    if (!a.hub || a.popped) continue;
    for (let bi = 0; bi < carB.deform.masses.length; bi++) {
      const b = carB.deform.masses[bi]!;
      if (!b.hub || b.popped) continue;
      const dx = a.world.x - b.world.x;
      const dz = a.world.z - b.world.z;
      // Clear of each other along some axis by more than the travel along it: no overlap now, none within the slice.
      let apart = false;
      for (let k = 0; k < 12; k += 3) {
        const ux = _axes[k]!,
          uz = _axes[k + 1]!;
        if (Math.abs(dx * ux + dz * uz) - _axes[k + 2]! > Math.abs(wx * ux + wz * uz) + 1e-9) {
          apart = true;
          break;
        }
      }
      if (apart) continue;
      let enter = -Infinity,
        exit = Infinity,
        ex = 0,
        ez = 0,
        pen = Infinity,
        px = 0,
        pz = 0;
      for (let k = 0; k < 12; k += 3) {
        const ux = _axes[k]!,
          uz = _axes[k + 1]!,
          r = _axes[k + 2]!;
        const c = dx * ux + dz * uz;
        const s = wx * ux + wz * uz;
        if (r - Math.abs(c) < pen) {
          pen = r - Math.abs(c);
          px = c < 0 ? -ux : ux;
          pz = c < 0 ? -uz : uz;
        }
        if (Math.abs(s) < 1e-9) {
          if (Math.abs(c) >= r) exit = -Infinity;
          continue;
        }
        const t1 = (-r - c) / s;
        const t2 = (r - c) / s;
        if (Math.min(t1, t2) > enter) {
          enter = Math.min(t1, t2);
          const side = c + enter * s;
          ex = side < 0 ? -ux : ux;
          ez = side < 0 ? -uz : uz;
        }
        exit = Math.min(exit, Math.max(t1, t2));
      }
      if (pen > 0) {
        if (first > 0 || pen > depth) {
          first = 0;
          depth = pen;
          normalOut.set(px, 0, pz);
          hubA = a;
          hubB = b;
        }
      } else if (enter <= exit && enter >= 0 && enter <= 1 && enter < first) {
        first = enter;
        normalOut.set(ex, 0, ez);
        hubA = a;
        hubB = b;
      }
    }
  }
  if (first > 1) return false;
  const n = normalOut;
  // Head-on (or nose into tail) whose crush stroke reaches both wheels and has some left in either nose: the wheel that
  // met a wheel is torn back off its hub, as a nose crushed onto its tyre tears it (`HUB_OVERRUN`), and the noses go
  // on crushing. Stopping the whole pair at the tyres here cut a 55 m/s head-on's stroke at 45 % (engine block 0.37 m,
  // alive) while 30 m/s crushed on through it (0.52 m, dead). A hit too soft to reach the wheels meets them as a rigid stop.
  if (
    hubA &&
    hubB &&
    Math.abs(n.x * carA.fwdFlat.x + n.z * carA.fwdFlat.z) > END_ON &&
    Math.abs(n.x * carB.fwdFlat.x + n.z * carB.fwdFlat.z) > END_ON &&
    carA.deform.hitStroke() >= carA.deform.hubReach(hubA) &&
    carB.deform.hitStroke() >= carB.deform.hubReach(hubB) &&
    Math.min(carA.deform.strokeUsed(), carB.deform.strokeUsed()) < PACKED_STROKE
  ) {
    carA.deform.popHub(hubA);
    carB.deform.popHub(hubB);
    return true;
  }
  const mA = carA.deform.totalMass;
  const mB = carB.deform.totalMass;
  const vA = carA.velocity.x * n.x + carA.velocity.z * n.z;
  const vB = carB.velocity.x * n.x + carB.velocity.z * n.z;
  // Closing that the gap can't take this slice: the tyres just meet at its end.
  const excess = (vB - vA) * (1 - first);
  if (excess > 0) {
    const j = ((mA * mB) / (mA + mB)) * excess;
    carA.deform.shiftBody((n.x * j) / mA, (n.z * j) / mA, 0, 0, 0, n.x, n.z, vA + (excess * mB) / (mA + mB));
    carB.deform.shiftBody((-n.x * j) / mB, (-n.z * j) / mB, 0, 0, 0, -n.x, -n.z, -(vB - (excess * mA) / (mA + mB)));
  }
  if (depth > 0) {
    // The closing the tyres' stop took is spent already (`shiftBody`): what is left of the depth is a position correction.
    pushApart(carA, carB, n.x, n.z, (depth * mB) / (mA + mB), (depth * mA) / (mA + mB), dt, 0);
  }
  return true;
}
