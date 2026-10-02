import * as THREE from "three";
import { CAR_HALF, DOOR, DOOR_INERTIA, DOOR_OPEN_MAX, HINGE_TEAR_J, MIRROR_BREAK_J, MIRROR_FOLD_MAX, type DeformableCar } from "./car.ts";

/**
 * One contact model for anything that strikes a car: the Doors ram, a press plate, a piston face
 * or another car's body. The striker is an oriented box with a velocity and a mass (`Infinity`:
 * a kinematic driver). Every scene runs the same door and mirror colliders against it
 * (`partContact`), the same body crush (`bodyContact`: the barrier's and car-car's
 * `applyImpact` / `feedOverlap` / slab / `brakeInbound` sequence) and reports the struck end to
 * the car (`DeformableCar.noteContactEnd`), so the hinge model and the crash rules see the same
 * hit whatever delivers it (docs/CONTACT_PARITY.md).
 */
export type ContactBox = {
  /** Centre (world, m). */
  x: number;
  y: number;
  z: number;
  /** Half extents along the box's own right, up and forward axes (m). */
  hx: number;
  hy: number;
  hz: number;
  /** Heading of the box's +z, as `DeformableCar.yaw` (rad). */
  yaw: number;
  /** World velocity (m/s). */
  vx: number;
  vz: number;
  /** kg; `Infinity` for a kinematic driver. */
  kg: number;
  /** Share of the crush energy the struck car takes: 1 for a rigid face, less for a face that
   *  crushes too (a piston's honeycomb). */
  hardness: number;
};

export function makeBox(): ContactBox {
  return { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0, vx: 0, vz: 0, kg: Infinity, hardness: 1 };
}

/**
 * Equivalent barrier speed a struck car of `carKg` takes from a striker of `strikerKg` closing at
 * `closing`: its `hardness` share of the reduced-mass energy ½·μ·v² (μ = m·M/(m+M); a kinematic
 * striker, M = ∞, gives μ = m). For two cars of the same structure the share is M/(m+M), which is
 * pair-contact's closing·M/(m+M).
 */
function strikeEbs(closing: number, strikerKg: number, carKg: number, hardness: number): number {
  const share = Number.isFinite(strikerKg) ? strikerKg / (strikerKg + carKg) : 1;
  return closing * Math.sqrt(share * hardness);
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * How far the box's leading face (its +z end) has pushed into the car's crush hulls along its
 * travel (m, ≤ 0 clear), with the contact point on the face in `point`.
 */
function faceOverlap(car: DeformableCar, box: ContactBox, point: THREE.Vector3): number {
  const fx = Math.sin(box.yaw);
  const fz = Math.cos(box.yaw);
  const rx = fz;
  const rz = -fx;
  const ax = car.rightFlat;
  const az = car.fwdFlat;
  const p = car.group.position;
  // Car axes against the box's travel (f) and width (r).
  const af = Math.abs(ax.x * fx + ax.z * fz);
  const zf = Math.abs(az.x * fx + az.z * fz);
  const ar = Math.abs(ax.x * rx + ax.z * rz);
  const zr = Math.abs(az.x * rx + az.z * rz);
  let best = -Infinity;
  let lat = 0;
  for (const h of car.crushHulls()) {
    const cx = p.x + ax.x * h.cx + az.x * h.cz - box.x;
    const cz = p.z + ax.z * h.cx + az.z * h.cz - box.z;
    const along = cx * fx + cz * fz;
    const side = cx * rx + cz * rz;
    const ef = h.hx * af + h.hz * zf;
    if (Math.abs(side) >= box.hx + h.hx * ar + h.hz * zr || along + ef <= -box.hz) continue;
    const o = box.hz - (along - ef);
    if (o > best) {
      best = o;
      lat = THREE.MathUtils.clamp(side, -box.hx, box.hx);
    }
  }
  point.set(box.x + fx * box.hz + rx * lat, Math.min(box.y, 0.48), box.z + fz * box.hz + rz * lat);
  return best;
}

function shiftVelocities(car: DeformableCar, dx: number, dz: number): void {
  for (const m of car.deform.masses) {
    if (!m.dynamic) continue;
    m.vel.x += dx;
    m.vel.z += dz;
  }
}

/** Result of the last `bodyContact` (reused): the face overlapped the hulls or held a particle. */
export const bodyHit = { touching: false };

/**
 * Body crush from a striker box, one physics slice: the first touch starts the crash
 * (`applyImpact`, `strikeEbs`, the energy split car-car uses); the particles are held on the face
 * in the striker's frame (`projectOutOfBox`, the barrier's slab) and, with `crush`, the crush force
 * spends the hit's stroke (`brakeInbound`, as the barrier and car-car's packed-stroke rule do).
 * Returns the momentum (N·s) the car took off the striker along its travel.
 */
export function bodyContact(car: DeformableCar, box: ContactBox, dt: number, crush: boolean): number {
  const d = car.deform;
  const fx = Math.sin(box.yaw);
  const fz = Math.cos(box.yaw);
  const closing = (box.vx - car.velocity.x) * fx + (box.vz - car.velocity.z) * fz;
  const overlap = faceOverlap(car, box, _p);
  bodyHit.touching = overlap > 0;
  _n.set(fx, 0, fz);
  if (overlap > 0.004 && closing > 0.2 && !car.crashed) car.applyImpact(_p, _n, closing, strikeEbs(closing, box.kg, d.totalMass, box.hardness));
  if (!d.massActive) return 0;
  const ub = box.vx * fx + box.vz * fz;
  shiftVelocities(car, -fx * ub, -fz * ub);
  // The slab's thin axis (`projectOutOfBox` x) is the striker's travel.
  let taken = d.projectOutOfBox(box.x, box.z, box.hz, box.hx, box.yaw - Math.PI / 2);
  if (d.faceContacts > 0) {
    bodyHit.touching = true;
    d.notifyContact();
    if (crush) {
      const ebs = d.hitSpeedValue;
      const j = ((d.totalMass * ebs * ebs) / (2 * Math.max(0.05, d.hitStroke()))) * dt;
      taken += d.brakeInbound(fx, fz, j, 0);
    }
  }
  shiftVelocities(car, fx * ub, fz * ub);
  return taken;
}

/** A car's body as a striker: its rest bounds (`CAR_HALF`), heading, velocity and mass. */
function carBox(car: DeformableCar, out: ContactBox): ContactBox {
  const p = car.group.position;
  out.x = p.x;
  out.y = p.y + CAR_HALF.y;
  out.z = p.z;
  out.hx = CAR_HALF.x;
  out.hy = CAR_HALF.y;
  out.hz = CAR_HALF.z;
  out.yaw = Math.atan2(car.fwdFlat.x, car.fwdFlat.z);
  out.vx = car.velocity.x;
  out.vz = car.velocity.z;
  out.kg = car.deform.totalMass;
  out.hardness = 1;
  return out;
}

/** The striker seen from the struck car on one side: the lane it sweeps and its run along the car. */
type Lane = {
  /** Travel along the car: +1 rear→front, −1 front→rear. */
  dir: 1 | -1;
  /** |x| of the striker's edge nearest the car, and its width outward (m). */
  inner: number;
  width: number;
  /** Bottom and top (m above the car's ground). */
  bottom: number;
  top: number;
  /** Leading face along car z (m) and the striker's length along its travel. */
  face: number;
  length: number;
  /** Speed along the travel relative to the car (m/s) and mass (kg). */
  u: number;
  kg: number;
};

const _lane: Lane = { dir: 1, inner: 0, width: 0, bottom: 0, top: 0, face: 0, length: 0, u: 0, kg: 0 };
const _push = new THREE.Vector3();
const SIDES = [-1, 1] as const;
/** cos 15°: how far off the car's axis a striker may run and still sweep a door/mirror lane. */
const PARALLEL = 0.966;
/** Striker ↔ door restitution. */
const DOOR_RESTITUTION = 0.2;

/** Result of the last `partContact` (reused, read it before the next call). */
const partHit = {
  /** The striker met a door or a mirror. */
  touched: false,
  /** Speed the striker lost along its travel (m/s). */
  du: 0,
  /** World direction of that travel (unit, xz). */
  nx: 0,
  nz: 0,
};

/**
 * How far along the run the mirror cap's trailing face has swung at fold `phi` (m, from the
 * base): the face pins the cap where the lane's inner edge crosses it (`gap` out from the base),
 * never inboard of the cap itself (0.11 m).
 */
function mirrorSweep(phi: number, gap: number): number {
  const r = Math.max(gap / Math.cos(phi), 0.11);
  return r * Math.sin(phi) - DOOR.mirrorHalfDepth * Math.cos(phi);
}

/**
 * Mirror on a shut door: the face pins the cap's trailing face and folds it about its base; at
 * `MIRROR_FOLD_MAX` the stop either stops the striker or, past `MIRROR_BREAK_J`, snaps off.
 * ponytail: shut doors only; an open door's mirror rides by the A-pillar, behind the slab.
 */
function hitMirror(car: DeformableCar, side: -1 | 1, lane: Lane): void {
  if (car.partOff(side < 0 ? "mirrorL" : "mirrorR")) return;
  const door = car.doorHinge(side);
  if (door.theta > 1e-4) return;
  const y = DOOR.hingeY + DOOR.mirrorY;
  if (lane.bottom > y + 0.05 || lane.top < y - 0.04) return;
  const gap = lane.inner - (DOOR.hingeX + DOOR.mirrorX);
  const s = lane.dir;
  // Face travel past the base along the run, against how far the cap's trailing face has swung.
  const reach = s * (lane.face - DOOR.hingeZ);
  const fold = Math.abs(door.mirrorFold);
  if (reach <= mirrorSweep(fold, gap) || gap / Math.cos(fold) > DOOR.mirrorReach) return;
  if (reach - lane.length > DOOR.mirrorReach) return;
  partHit.touched = true;
  if (reach <= mirrorSweep(MIRROR_FOLD_MAX, gap)) {
    let lo = fold;
    let hi = MIRROR_FOLD_MAX;
    for (let k = 0; k < 16; k++) {
      const mid = (lo + hi) * 0.5;
      if (mirrorSweep(mid, gap) < reach) lo = mid;
      else hi = mid;
    }
    car.setMirrorFold(side, -side * s * hi);
    return;
  }
  // Folded flat and still in the lane: the stop takes the striker.
  if (0.5 * lane.kg * lane.u * lane.u < MIRROR_BREAK_J) {
    car.setMirrorFold(side, -side * s * MIRROR_FOLD_MAX);
    lane.u = 0;
    return;
  }
  lane.u = Math.sqrt(lane.u * lane.u - (2 * MIRROR_BREAK_J) / lane.kg);
  car.breakMirror(side, _push.set(side * 0.8, 0.6, s * lane.u));
}

/**
 * Door slab (top view: hinge → trailing edge) against the face. Free door: one restitution
 * impulse through the door's effective mass I/k² at the contact (k = lever across the travel).
 * Door on its stop and pushed open: the car is rigid, so the strap takes the striker's closing
 * energy. The struck car itself is held: the slab is light against either body.
 */
function hitDoor(car: DeformableCar, side: -1 | 1, lane: Lane): void {
  if (car.partOff(side < 0 ? "doorL" : "doorR")) return;
  if (lane.bottom > DOOR.hingeY + DOOR.halfHeight || lane.top < DOOR.hingeY - DOOR.halfHeight) return;
  const door = car.doorHinge(side);
  const sin = Math.sin(door.theta);
  if (sin < 1e-3) return;
  const cos = Math.cos(door.theta);
  const rLo = (lane.inner - DOOR.hingeX) / sin;
  const rHi = Math.min(DOOR.length, (lane.inner + lane.width - DOOR.hingeX) / sin);
  if (rLo > rHi || rHi <= 0) return;
  const s = lane.dir;
  // A rear→front face meets the trailing (lowest-z) end of the slab in the lane first.
  const r = s > 0 ? rHi : Math.max(rLo, 0);
  const depth = s * (lane.face - (DOOR.hingeZ - r * cos));
  if (depth <= 0 || depth > lane.length) return;
  partHit.touched = true;
  const k = Math.max(r * sin, 0.02);
  const closing = lane.u - s * k * door.omega;
  if (s > 0 && door.theta >= DOOR_OPEN_MAX - 1e-4) {
    if (closing <= 0) return;
    const before = door.load;
    const energy = 0.5 * lane.kg * closing * closing;
    // What the striker still carries after paying for the tear.
    const left = Math.sqrt(Math.max(0, lane.u * lane.u - (2 * Math.max(0, HINGE_TEAR_J - before)) / lane.kg));
    if (car.loadDoorStop(side, energy, _push.set(side * 0.9, 0.8, s * Math.max(left, 1)))) lane.u = left;
    else {
      lane.u = 0;
      door.omega = 0;
    }
    return;
  }
  if (closing > 0) {
    const mEff = DOOR_INERTIA / (k * k);
    const j = ((1 + DOOR_RESTITUTION) * closing) / (1 / lane.kg + 1 / mEff);
    lane.u -= j / lane.kg;
    door.omega += (s * j * k) / DOOR_INERTIA;
  }
  // Push the slab out of the face.
  door.theta = THREE.MathUtils.clamp(door.theta + (s * depth) / k, 0, DOOR_OPEN_MAX);
}

/**
 * Door and mirror colliders of `car` against `box`, both sides. Only travel along the car moves a
 * door or a mirror (a shut door struck square is body crush, the crash rules' C1–C3). Returns
 * `partHit`; the caller takes `du` off the striker's speed along (`nx`, `nz`).
 */
export function partContact(car: DeformableCar, box: ContactBox): typeof partHit {
  partHit.touched = false;
  partHit.du = 0;
  const ax = car.rightFlat;
  const az = car.fwdFlat;
  const p = car.group.position;
  const rx = box.x - p.x;
  const rz = box.z - p.z;
  const lx = rx * ax.x + rz * ax.z;
  const lz = rx * az.x + rz * az.z;
  const uz = (box.vx - car.velocity.x) * az.x + (box.vz - car.velocity.z) * az.z;
  if (Math.abs(uz) < 0.05) return partHit;
  // The box's car-frame bounds (its own axes: right (c, −s), forward (s, c)). Only a striker
  // running along the car (within `PARALLEL`) sweeps a lane its bounds describe; an angled one
  // reaches the side as a body hit, and the crash rules take the door and mirror then.
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  if (Math.abs(s * az.x + c * az.z) < PARALLEL) return partHit;
  const ex = box.hx * Math.abs(c * ax.x - s * ax.z) + box.hz * Math.abs(s * ax.x + c * ax.z);
  const ez = box.hx * Math.abs(c * az.x - s * az.z) + box.hz * Math.abs(s * az.x + c * az.z);
  const lane = _lane;
  lane.dir = uz > 0 ? 1 : -1;
  lane.face = lz + lane.dir * ez;
  lane.length = 2 * ez;
  lane.bottom = box.y - box.hy - p.y;
  lane.top = box.y + box.hy - p.y;
  lane.kg = box.kg;
  const u0 = Math.abs(uz);
  lane.u = u0;
  for (const side of SIDES) {
    if (side * lx + ex <= 0) continue;
    lane.inner = side * lx - ex;
    // Past the open door's trailing edge and the mirror cap: nothing to meet. Reaching inside the
    // body's width is a body hit: the crash rules (C1–C3) take the door and mirror then.
    if (lane.inner > DOOR.hingeX + DOOR.length || lane.inner < CAR_HALF.x) continue;
    lane.width = 2 * ex;
    hitMirror(car, side, lane);
    hitDoor(car, side, lane);
  }
  partHit.du = u0 - lane.u;
  partHit.nx = az.x * lane.dir;
  partHit.nz = az.z * lane.dir;
  return partHit;
}

const _ba = makeBox();
const _bb = makeBox();

/** Take `du` (m/s) off a striker car's speed along (`nx`, `nz`): the whole car, every particle alike. */
function slowStriker(car: DeformableCar, nx: number, nz: number, du: number): void {
  car.velocity.x -= nx * du;
  car.velocity.z -= nz * du;
  if (car.deform.massActive) shiftVelocities(car, -nx * du, -nz * du);
}

/**
 * Car-car share of the shared contact model, once per physics slice per close pair, right after
 * the pair's `collideWith`: each body against the other's doors and mirrors. Car-car does not
 * report struck ends yet (docs/CONTACT_PARITY.md, "Open"): the squeeze mode's deform rules
 * assume a car held at the origin.
 */
export function partContactPair(a: DeformableCar, b: DeformableCar): void {
  carBox(a, _ba);
  carBox(b, _bb);
  let hit = partContact(a, _bb);
  if (hit.du > 0) slowStriker(b, hit.nx, hit.nz, hit.du);
  hit = partContact(b, _ba);
  if (hit.du > 0) slowStriker(a, hit.nx, hit.nz, hit.du);
}
