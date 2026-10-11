import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { armPairWithRows, MU_BODY, rowsClosing, WALL_CRUSH } from "../vehicle/car-air.ts";
import type { MassNode } from "../deform/deform-rig.ts";
import { leftoverCrumple, satPushCap, hypot2, CRASH } from "../deform/physics-util.ts";
import { satCars } from "./sat.ts";
import { bandsMeet, OUTLINE_REACH } from "./cage-outline.ts";
import { strikeCar, faceDepth, carRow, takeRow, type ContactBox } from "./external-contact.ts";
import { bodyContact, BODY_SIZE, BODY_VX, BODY_VZ, BODY_W, BODY_X, BODY_Z, CT_DEPTH, CT_E, CT_JMAX, CT_MU, CT_NX, CT_NZ, CT_SIZE, CT_X, CT_Z, OUT_EBS_A, OUT_EBS_B, OUT_SIZE } from "./body-contact.ts";
import { ARM_CLOSING, PAIR_MU, SOLID_E } from "./constants.ts";
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
 * only with the speed of the cars touching. A shove is a position correction alone: the pair's momentum is the exchange's
 * (`exchangePair`), never a push's (a pusher kept its drive speed while its shoves moved the car it drove into 3.6–8.4 m/s at a
 * reported speed under 1 m/s: derby 10 cars, 40 s, 791 car-frames over 0.06 m in 1/60 s at under 1 m/s on main ef6611a).
 */
function pushApart(carA: DeformableCar, carB: DeformableCar, nx: number, nz: number, aAmt: number, bAmt: number, dt: number): void {
  const touchSpeed = Math.max(hypot2(carA.velocity.x, carA.velocity.z), hypot2(carB.velocity.x, carB.velocity.z));
  const okA = carA.deform.massActive ? carA.deform.takePush(nx, nz, aAmt, dt, touchSpeed) : aAmt;
  const okB = carB.deform.massActive ? carB.deform.takePush(-nx, -nz, bAmt, dt, touchSpeed) : bAmt;
  pushCar(carA, nx, 0, nz, okA);
  pushCar(carB, -nx, 0, -nz, okB);
}

/**
 * The packed structure's floor: a rigid 2.15 m centre gap launches crushed cars whose noses already occupy that space, so it holds
 * only once the crush along the contact is spent on both cars (`spent`, from `strokeUsed`: the struck face's stroke, a door on a
 * flank, not the nose the hit never touched; the minimum gap too reads the struck face's travel, `faceTravel`), and while they are
 * still closing. The pair's momentum is the exchange's (rigid then); this position push only takes the pair out of the floor.
 */
function holdComGap(carA: DeformableCar, carB: DeformableCar, leftoverA: number, leftoverB: number, dist: number, dt: number): void {
  const minSep = 2.15 + leftoverA * 0.28 + leftoverB * 0.28;
  if (dist >= minSep) return;
  _w.copy(carA.group.position).sub(carB.group.position).setY(0);
  if (_w.lengthSq() < 1e-8) return;
  _w.normalize();
  const extra = Math.min((minSep - dist) * 0.5, satPushCap(dt));
  pushApart(carA, carB, _w.x, _w.z, extra, extra, dt);
}

/** Share of a hit's stroke (`strokeUsed`) both noses must have crushed before the packed structure (B1) stops a pair's closing. */
const PACKED_STROKE = 0.9;

// The kernel's rows (`contact/body-contact.ts`) of the pair's exchange: car A, car B, the contact and the result, reused by every call.
const pairRows = new Float64Array(2 * BODY_SIZE);
const pairContact = new Float64Array(CT_SIZE);
const pairResult = new Float64Array(OUT_SIZE);

/**
 * Both cars of the pair as rows of `pairRows` (`carRow`: each a rigid body in plan, its velocity the mean of the masses still closing
 * on the other's, those moving along the normal slower than the pair's common speed `vc`) and the contact at `p` along the unit `n`
 * (out of B into A), plastic, with the friction of sheet metal on sheet metal and at most `maxJ` of normal impulse.
 */
function loadPair(carA: DeformableCar, carB: DeformableCar, n: THREE.Vector3, p: THREE.Vector3, vc: number, maxJ: number): void {
  carRow(pairRows, 0, carA, n.x, n.z, Infinity);
  carRow(pairRows, BODY_SIZE, carB, -n.x, -n.z, Infinity);
  pairContact[CT_X] = p.x;
  pairContact[CT_Z] = p.z;
  pairContact[CT_NX] = n.x;
  pairContact[CT_NZ] = n.z;
  pairContact[CT_DEPTH] = 0;
  pairContact[CT_E] = 0;
  pairContact[CT_MU] = PAIR_MU;
  pairContact[CT_JMAX] = maxJ;
}

/**
 * The crush force (N) a car's armed hit yields at: the energy of its barrier speed over the stroke that speed crushes
 * (`m·ebs²/(2·stroke)`, the rigs' `strikeCar` reads the same); 0 before the hit is armed.
 */
function crushForce(d: DeformableCar["deform"]): number {
  const ebs = Math.max(0, d.hitSpeedValue);
  return (d.totalMass * ebs * ebs) / (2 * Math.max(0.05, d.hitStroke()));
}

/**
 * The pair's one momentum exchange: `bodyContact` between the two cars at the patch `p`, normal `n` out of B into A, the normal
 * impulse at most `maxJ`. Each car's change of speed and spin goes onto every mass (or onto the car of a body that is no wreck), as
 * the rigs' strike does (`takeRow`). A rigid contact (`maxJ` infinite: the crush is spent, packed, or too slow to crush) leaves each
 * car one body: every mass at the rigid motion of its car, as a spent structure is, so no internal speed is left to crush the
 * structure further (200 km/h head-on: clamped masses at ±8 m/s that a quiet wreck let go 0.2 s later).
 */
function exchangePair(carA: DeformableCar, carB: DeformableCar, n: THREE.Vector3, p: THREE.Vector3, vc: number, maxJ: number): void {
  loadPair(carA, carB, n, p, vc, maxJ);
  const axv = pairRows[BODY_VX]!;
  const azv = pairRows[BODY_VZ]!;
  const aw = pairRows[BODY_W]!;
  const bxv = pairRows[BODY_SIZE + BODY_VX]!;
  const bzv = pairRows[BODY_SIZE + BODY_VZ]!;
  const bw = pairRows[BODY_SIZE + BODY_W]!;
  if (bodyContact(pairRows, 0, BODY_SIZE, pairContact, pairResult) === 0) return;
  takeRow(carA, pairRows, 0, axv, azv, aw, n.x, n.z, Infinity);
  takeRow(carB, pairRows, BODY_SIZE, bxv, bzv, bw, -n.x, -n.z, Infinity);
  if (maxJ === Infinity) {
    moveAsOneBody(carA, 0);
    moveAsOneBody(carB, BODY_SIZE);
  }
}

/** Every dynamic mass of `car` takes the rigid motion of the row at `o` of `pairRows` (its velocity and spin about its centre): momentum and angular momentum kept, the internal motion gone. */
function moveAsOneBody(car: DeformableCar, o: number): void {
  if (!car.deform.massActive) return;
  const vx = pairRows[o + BODY_VX]!;
  const vz = pairRows[o + BODY_VZ]!;
  const w = pairRows[o + BODY_W]!;
  const cx = pairRows[o + BODY_X]!;
  const cz = pairRows[o + BODY_Z]!;
  for (const q of car.deform.masses) {
    if (!q.dynamic) continue;
    q.vel.x = vx + w * (q.world.z - cz);
    q.vel.z = vz - w * (q.world.x - cx);
  }
}

/** The pair's momentum before the crush layer's feed (`pairMomentum`: x, z, and the mass it is over). */
const _momentum = new Float64Array(3);

/** `out` ← the momentum (kg m/s, x then z) and mass (kg) of the two cars' dynamic masses; a car that is no wreck is its own velocity and mass. */
function pairMomentum(carA: DeformableCar, carB: DeformableCar, out: Float64Array): void {
  out.fill(0);
  for (let c = 0; c < 2; c++) {
    const car = c === 0 ? carA : carB;
    if (car.deform.massActive) {
      for (const q of car.deform.masses) {
        if (!q.dynamic) continue;
        out[0] += q.mass * q.vel.x;
        out[1] += q.mass * q.vel.z;
        out[2] += q.mass;
      }
    } else {
      const m = car.deform.totalMass;
      out[0] += m * car.velocity.x;
      out[1] += m * car.velocity.z;
      out[2] += m;
    }
  }
}

/** Give every dynamic mass of both cars (a car that is no wreck: its velocity) the one velocity change that brings the pair's momentum back to `before`. */
function restoreMomentum(carA: DeformableCar, carB: DeformableCar, before: Float64Array): void {
  pairMomentum(carA, carB, _after);
  const dvx = (before[0]! - _after[0]!) / before[2]!;
  const dvz = (before[1]! - _after[1]!) / before[2]!;
  for (let c = 0; c < 2; c++) {
    const car = c === 0 ? carA : carB;
    car.velocity.x += dvx;
    car.velocity.z += dvz;
    if (!car.deform.massActive) continue;
    for (const q of car.deform.masses) {
      if (!q.dynamic) continue;
      q.vel.x += dvx;
      q.vel.z += dvz;
    }
  }
}
const _after = new Float64Array(3);

/** A car's momentum (kg m/s) along the unit (nx, nz): its dynamic masses' (a car that is no wreck: its own velocity's). */
function momentumAlong(car: DeformableCar, nx: number, nz: number): number {
  if (!car.deform.massActive) return car.deform.totalMass * (car.velocity.x * nx + car.velocity.z * nz);
  let p = 0;
  for (const q of car.deform.masses) if (q.dynamic) p += q.mass * (q.vel.x * nx + q.vel.z * nz);
  return p;
}

/** How far (m) a car's structure has crushed in the hit that is still on (`crushing`: a contact within the last 0.28 s), 0 for a car with none. */
function crushedSoFar(d: DeformableCar["deform"]): number {
  return d.massActive && d.crushing ? d.hitStroke() * d.strokeUsed() : 0;
}

/**
 * Pair SAT + crumple. Persistent overlap after the zone is spent must not
 * keep dumping cancelClosing (that is the 10s / 120 km/h zip). Every contact
 * offers each car a hit: the first one starts its crash, a fresh hard one on
 * a wreck re-arms a new hit (`DeformableCar.applyImpact`). The closing impulse is capped by `closingCap`.
 */
export function resolveCarPair(carA: DeformableCar, carB: DeformableCar, dt: number): PairHit | null {
  const pa = carA.group.position;
  const pb = carB.group.position;
  const gx = pa.x - pb.x;
  const gy = pa.y - pb.y;
  const gz = pa.z - pb.z;
  const dist = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (dist > 5.2) return null;

  // The contact begins before the overlap, as the rigs' does (`strikeCar`): while the bodies are apart by less than the travel the
  // pair closes in this slice, and, once the hit is on, by less than the crush has taken both faces back (a crush that keeps up with
  // the closing leaves the faces apart by what it has eaten: the contact does not end where it works), the hit goes on.
  const eaten = crushedSoFar(carA.deform) + crushedSoFar(carB.deform);
  const hit = satCars(carA, carB, _n, _p, hypot2(carA.velocity.x - carB.velocity.x, carA.velocity.z - carB.velocity.z) * dt + eaten);
  const n = _n;
  n.y = 0;
  if (n.lengthSq() > 1e-8) n.normalize();
  const rel = _v.copy(carA.velocity).sub(carB.velocity);
  const closing = -rel.dot(n);
  if (hit === null || hit < -(Math.max(0, closing) * dt + eaten)) return null;

  // What the pair met with: the rows of the rigid step that met it this slice have traded part of it already (read before `armPairWithRows` takes them).
  const met = Math.max(closing, rowsClosing(carA, carB));

  const mA = carA.deform.totalMass;
  const mB = carB.deform.totalMass;
  // Where the contact masses of both cars are driven to along the normal, and what the exchange ends at: the pair's common speed.
  const vc = (mA * carA.velocity.dot(n) + mB * carB.velocity.dot(n)) / (mA + mB);
  if (closing > ARM_CLOSING) {
    // Equivalent barrier speed: each car takes the share of the pair's plastic exchange the kernel gives it at the contact point (a hit
    // through both centres: the closing times the other's mass share). The rows of the rigid step that met this pair in this slice (a
    // car's nose on the other's top) read the same contact from before their exchange: it is armed once, at the larger reading, as it
    // stood before it (`armPairWithRows`).
    // Before notifyContact: a wreck's re-arm reads how long it has been quiet.
    loadPair(carA, carB, n, _p, vc, 0);
    bodyContact(pairRows, 0, BODY_SIZE, pairContact, pairResult);
    const shareA = pairResult[OUT_EBS_A]!;
    const shareB = pairResult[OUT_EBS_B]!;
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

  pairMomentum(carA, carB, _momentum);
  const preA = momentumAlong(carA, n.x, n.z);
  const preB = momentumAlong(carB, -n.x, -n.z);
  // Each car's contact masses are driven to the pair's common speed along the normal (a fixed face at 0 stopped a T-bone bullet's nose
  // dead while the struck car got no momentum; end-on the common speed is 0 for equal cars, the fixed face's).
  // The crush a hit feeds scales with the depth of the overlap, and the drawn bodies' contact begins where their surfaces do (the
  // cage): a hit's first slice is as deep as the closing travelled after the touch, anywhere up to the slice's whole travel, so the
  // feed is never less than that travel (`closing * dt`).
  const fed = Math.max(hit, closing * dt);
  carA.deform.feedOverlap(_p, n, fed, Math.max(0, closing), dt, vc);
  carB.deform.feedOverlap(_p, _w.copy(n).negate(), fed, Math.max(0, closing), dt, -vc);
  // The momentum (N·s) the feed took off each car's closing along the normal: the structure's force already at work this slice.
  const killed = 0.5 * (momentumAlong(carA, n.x, n.z) - preA + momentumAlong(carB, -n.x, -n.z) - preB);
  const spent = carA.crashed && carB.crashed && Math.min(carA.deform.strokeUsed(), carB.deform.strokeUsed()) >= PACKED_STROKE;
  // A face whose crumple travel is used up (`leftoverCrumple`) is stiff: it takes whatever the pair's other face passes on.
  const leftoverA = leftoverCrumple(carA.deform.faceTravel());
  const leftoverB = leftoverCrumple(carB.deform.faceTravel());
  const stiffA = leftoverA < 0.12;
  const stiffB = leftoverB < 0.12;
  if (closing > 0) {
    // The one exchange of the pair, at the patch, once per slice: the normal impulse that closes the approach of the two cars' contact
    // points (the lever of each about its centre in the kernel's effective mass), at the most what the crush force over the slice has
    // left after the feed's kill while a structure still yields (the hit's own barrier speed over its stroke: that of the face that
    // is not stiff, a T-bone's packed bullet nose passes on what the struck door yields), rigid once both are stiff or the crush is
    // spent or too slow to crush.
    const crushes = closing > CRASH.grazeMps && !spent && !(stiffA && stiffB);
    const force = Math.min(stiffA ? Infinity : crushForce(carA.deform), stiffB ? Infinity : crushForce(carB.deform));
    exchangePair(carA, carB, n, _p, vc, crushes ? Math.max(0, force * dt - Math.max(0, killed)) : Infinity);
  }
  // The crush layer's kills are the lattice's, not an exchange: the pair's momentum is the one it had, the kernel's impulse the only
  // thing that moved it between the cars.
  restoreMomentum(carA, carB, _momentum);

  // The cage's overlap is the crush's to take (`feedOverlap`): as deep as this slice's own travel explains it (`closing * dt`, how
  // deep a body that was clear at the last slice can be) or as the stroke this hit has left on either face (`hitStroke`, the speed's
  // crush length, less what `strokeUsed` has taken). Only what is deeper is a push, by position: the momentum is the exchange's.
  const give = Math.max(carA.deform.hitStroke() * (1 - carA.deform.strokeUsed()), carB.deform.hitStroke() * (1 - carB.deform.strokeUsed()));
  const extra = Math.max(0, hit - OUTLINE_REACH - Math.max(give, closing * dt));
  if (extra > 0) {
    const push = Math.min(extra + 0.006, satPushCap(dt));
    const both = carA.deform.massActive && carB.deform.massActive;
    const aAmt = both ? push * 0.5 : carA.deform.massActive ? push * 0.62 : push * 0.38;
    pushApart(carA, carB, n.x, n.z, aAmt, push - aAmt, dt);
  }

  if (spent && closing > 0 && dist > 1e-4) holdComGap(carA, carB, leftoverA, leftoverB, dist, dt);
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
