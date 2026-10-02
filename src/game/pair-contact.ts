import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { leftoverCrumple, cancelClosing, satPushCap, CRASH } from "./physics-util.ts";
import { carCrushHulls, satCars } from "./sat.ts";
import { TYRE_HALF_W, TYRE_R } from "./streamed-deform.ts";
import { partContactPair } from "./external-contact.ts";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _tn = new THREE.Vector3();

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
  car.refreshBasis();
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
}

/**
 * A pair push, within a wreck's per-slice budget (`takePush`): the three SAT passes of one slice
 * each pushing a full `satPushCap` moved a wedged wreck 0.11 m in 6 ms (derby group pops).
 */
function pushPair(car: DeformableCar, nx: number, nz: number, amount: number, dt: number): void {
  pushCar(car, nx, 0, nz, car.deform.massActive ? car.deform.takePush(amount, dt) : amount);
}

/**
 * Pair SAT + crumple. Persistent overlap after the zone is spent must not
 * keep dumping cancelClosing (that is the 10s / 120 km/h zip). Every contact
 * offers each car a hit: the first one starts its crash, a fresh hard one on
 * a wreck re-arms a new hit (`DeformableCar.applyImpact`).
 */
export function resolveCarPair(carA: DeformableCar, carB: DeformableCar, feed: boolean, dt: number): PairHit | null {
  const dist = carA.group.position.distanceTo(carB.group.position);
  if (dist > 5.2) return null;

  const crushHit = satCars(carA, carB, _cn, _cp, carCrushHulls);
  const hit = satCars(carA, carB, _n, _p);
  if (!crushHit && !hit) {
    // Crushed noses can leave both hull pairs apart while the tyres, which never crush, already meet: in a
    // 100 km/h head-on the hulls missed for a frame and the tyres passed 0.25 m through each other.
    if (!tyreStop(carA, carB, dt, _tn)) return null;
    return { impulse: 0, contact: _p.copy(carA.group.position).add(carB.group.position).multiplyScalar(0.5).clone(), normal: _tn.clone() };
  }

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

  if (closing > 0.2 && (crushHit ?? hit ?? 0) > 0.006) {
    // Equivalent barrier speed: each car takes the closing share the other's mass pushes into it.
    // Before notifyContact: a wreck's re-arm reads how long it has been quiet.
    const mA = carA.deform.totalMass;
    const mB = carB.deform.totalMass;
    carA.applyImpact(p, n, closing, (closing * mB) / (mA + mB));
    carB.applyImpact(p, _w.copy(n).negate(), closing, (closing * mA) / (mA + mB));
  }

  // Overlap after the wreck has settled is not a new hit — notifying every
  // slice zeroed quietTime and disabled damping for the whole clip.
  if (closing > CRASH.grazeMps) {
    carA.deform.notifyContact();
    carB.deform.notifyContact();
  }

  let remain = Math.max(0, closing);
  if (feed && crushHit) {
    // A side contact drives each car's contact masses to the pair's common speed along the normal: a
    // fixed-face kill (0) stopped a T-bone bullet's nose dead while the struck car got no momentum, only
    // whole-body pushes, so its door never crushed (0.02 m vs the 0.12–0.28 m band).
    // ponytail: end-on pairs keep the fixed-face kill, which the piston rig's frontal parity is matched
    // to; driving a struck nose to the common speed makes its tail lag into crush (beams have no yield
    // force). Upgrade path: car-car through external-contact's bodyContact (CONTACT_PARITY.md).
    let vc = 0;
    const rA = carA.rightFlat, fA = carA.fwdFlat, rB = carB.rightFlat, fB = carB.fwdFlat;
    const sideA = Math.abs(_cn.x * rA.x + _cn.z * rA.z) > Math.abs(_cn.x * fA.x + _cn.z * fA.z);
    if (sideA || Math.abs(_cn.x * rB.x + _cn.z * rB.z) > Math.abs(_cn.x * fB.x + _cn.z * fB.z)) {
      const mA = carA.deform.totalMass;
      const mB = carB.deform.totalMass;
      vc = (mA * carA.velocity.dot(_cn) + mB * carB.velocity.dot(_cn)) / (mA + mB);
    }
    const remainA = carA.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt, vc);
    const remainB = carB.deform.feedOverlap(_cp, _w.copy(_cn).negate(), crushHit, Math.max(0, closing), dt, -vc);
    remain = Math.max(0, Math.min(remainA, remainB));
  }
  if (feed && crushHit && closing > 0 && carA.crashed && carB.crashed && Math.min(carA.deform.strokeUsed(), carB.deform.strokeUsed()) >= 0.9) {
    // Both noses have crushed their stroke for this hit (B1): the packed
    // structure stops the relative closing, toward the pair's common velocity.
    const mA = carA.deform.totalMass;
    const mB = carB.deform.totalMass;
    const j = ((mA * mB) / (mA + mB)) * closing;
    const comVn = (mA * carA.velocity.dot(_cn) + mB * carB.velocity.dot(_cn)) / (mA + mB);
    carA.deform.brakeInbound(_cn.x, _cn.z, j, comVn);
    carB.deform.brakeInbound(-_cn.x, -_cn.z, j, -comVn);
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
    pushPair(carA, _n.x, _n.z, aAmt, dt);
    pushPair(carB, -_n.x, -_n.z, push - aAmt, dt);
  } else if (crushHit) {
    const allowed = leftoverA * 0.45 + leftoverB * 0.45 + 0.08;
    const extra = Math.min(crushHit - allowed, 0.04);
    if (extra > 0.012) {
      pushPair(carA, _cn.x, _cn.z, extra * 0.5, dt);
      pushPair(carB, -_cn.x, -_cn.z, extra * 0.5, dt);
    }
  }

  // Rigid 2.15 m COM gap launches crushed cars whose noses already occupy
  // that space. Only keep a floor while the crumple zone is still long and
  // they are still closing — a settled wreck must not get a late shove.
  if (leftover > 0.25 && closing > CRASH.grazeMps && dist > 1e-4) {
    const minSep = 2.15 + leftoverA * 0.28 + leftoverB * 0.28;
    if (dist < minSep) {
      _w.copy(carA.group.position).sub(carB.group.position).setY(0);
      if (_w.lengthSq() > 1e-8) {
        _w.normalize();
        const extra = Math.min((minSep - dist) * 0.5, satPushCap(dt));
        pushPair(carA, _w.x, _w.z, extra, dt);
        pushPair(carB, -_w.x, -_w.z, extra, dt);
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
  return { impulse: Math.max(closing, (crushHit ?? hit ?? 0) * 6), contact: p.clone(), normal: n.clone() };
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
 */
function tyreStop(carA: DeformableCar, carB: DeformableCar, dt: number, normalOut: THREE.Vector3): boolean {
  if (!carA.deform.massActive || !carB.deform.massActive) return false;
  tyreAxes(carA, carB);
  // A's travel relative to B over the slice.
  const wx = (carA.velocity.x - carB.velocity.x) * dt;
  const wz = (carA.velocity.z - carB.velocity.z) * dt;
  let first = Infinity,
    depth = 0;
  for (let ai = 0; ai < carA.deform.masses.length; ai++) {
    const a = carA.deform.masses[ai]!;
    if (!a.hub || a.popped) continue;
    for (let bi = 0; bi < carB.deform.masses.length; bi++) {
      const b = carB.deform.masses[bi]!;
      if (!b.hub || b.popped) continue;
      const dx = a.world.x - b.world.x;
      const dz = a.world.z - b.world.z;
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
        }
      } else if (enter <= exit && enter >= 0 && enter <= 1 && enter < first) {
        first = enter;
        normalOut.set(ex, 0, ez);
      }
    }
  }
  if (first > 1) return false;
  const n = normalOut;
  const mA = carA.deform.totalMass;
  const mB = carB.deform.totalMass;
  const vA = carA.velocity.x * n.x + carA.velocity.z * n.z;
  const vB = carB.velocity.x * n.x + carB.velocity.z * n.z;
  // Closing that the gap can't take this slice: the tyres just meet at its end.
  const excess = (vB - vA) * (1 - first);
  if (excess > 0) {
    const j = ((mA * mB) / (mA + mB)) * excess;
    carA.deform.brakeInbound(n.x, n.z, j, vA + (excess * mB) / (mA + mB));
    carB.deform.brakeInbound(-n.x, -n.z, j, -(vB - (excess * mA) / (mA + mB)));
  }
  if (depth > 0) {
    pushPair(carA, n.x, n.z, (depth * mB) / (mA + mB), dt);
    pushPair(carB, -n.x, -n.z, (depth * mA) / (mA + mB), dt);
  }
  return true;
}

/** One physics slice for a pair — same order as CrashEngine.fixedStep. */
export function stepCarPair(carA: DeformableCar, carB: DeformableCar, dt: number): void {
  if (!carA.deform.massActive) carA.integrate(dt);
  else carA.syncPose(dt);
  if (!carB.deform.massActive) carB.integrate(dt);
  else carB.syncPose(dt);

  if (carA.deform.massActive || carB.deform.massActive) carA.deform.collideWith(carB.deform, dt);
  partContactPair(carA, carB);

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
    const hit = resolveCarPair(carA, carB, k === 0, dt);
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

/** Warm-up crashes: car A at (x, z) facing `yaw` at 14 m/s into car B parked at the origin facing `yawB`, or driving at `vB`. */
const WARM_HITS = [
  // Head-on, 14 m/s each (100 km/h closing), noses 1.7 m apart.
  [0, -6, 0, Math.PI, 14],
  // T-bone into a parked car's door.
  [-4.5, 0, Math.PI / 2, 0, 0],
] as const;

/**
 * Run two throwaway crashes through `stepCarPair` (1 s each) so V8 has compiled the crush path before play.
 * Cold, a race's first crashes ran it unoptimised: single frames took 21–27 ms of physics headless (oval, 8 cars),
 * 26–48 ms in the browser (docs/PERF_HITCH.md); after this warm-up, ≤ 7.4 ms. Returns whether every hit crashed
 * both cars (else it no longer warms the code it is for).
 */
export function warmCrashPath(): boolean {
  const scene = new THREE.Scene();
  const paint = { body: 0x808080, accent: 0x404040, name: "warm-up" };
  let crashed = true;
  for (const [x, z, yaw, yawB, vB] of WARM_HITS) {
    const a = new DeformableCar(paint, scene);
    const b = new DeformableCar(paint, scene);
    a.spawnFacing(x, z, yaw, 14);
    b.spawnFacing(0, 0, yawB, vB);
    for (let i = 0; i < 240; i++) stepCarPair(a, b, 1 / 240);
    crashed &&= a.crashed && b.crashed && a.deform.massActive && b.deform.massActive;
    a.dispose();
    b.dispose();
  }
  return crashed;
}
