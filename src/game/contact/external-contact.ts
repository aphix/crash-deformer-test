import * as THREE from "three";
import { CAR_HALF, DOOR, type DeformableCar } from "../vehicle/car.ts";
import { DOOR_INERTIA, DOOR_OPEN_MAX, HINGE_TEAR_J, MIRROR_BREAK_J, MIRROR_FOLD_MAX } from "../vehicle/car-core.ts";
import { PANEL_BEND_NM, PANEL_FRAGILE_J, PANEL_FRAGILE_T, PANEL_PULL_J, PANEL_SLAM_J } from "../vehicle/car-wear.ts";
import { detSin, detCos } from "../kernel/physics-core.js";

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
  /**
   * A solid fixed in the world (`solidFace`): a fresh hard touch re-arms a wreck's hit (`DeformableCar.applyImpact`, on quiet
   * time and energy, as the barrier and car-car do), and a particle in it leaves by the car-side face, never round an end (a
   * wall's end is the joint to its neighbour, so the particle would stay in the wall).
   */
  fixed: boolean;
  /** Whether the plan shape is a circle of radius `hx` (a palm, a lamp post) rather than a box (`partContact`, on a `fixed` box). */
  round: boolean;
};

export function makeBox(): ContactBox {
  return { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0, vx: 0, vz: 0, kg: Infinity, hardness: 1, fixed: false, round: false };
}

/**
 * `out` as the car-side face of a fixed solid, a striker that never moves: its leading face lies on the point (`fx`, `fz`)
 * with the unit normal (`nx`, `nz`) pointing out of the solid toward the car, `halfWidth` wide either side of the line
 * through (`mx`, `mz`) along that normal, and `depth` thick behind the face. A race wall, a prop's side, a ramp's flank:
 * each is met through `bodyContact` as the range's jersey slab is.
 */
export function solidFace(out: ContactBox, nx: number, nz: number, fx: number, fz: number, mx: number, mz: number, halfWidth: number, depth: number): ContactBox {
  // The face's lateral centre is where (mx, mz) projects onto it; the box centre is `depth` behind that.
  const lat = (mx - fx) * -nz + (mz - fz) * nx;
  out.x = fx - nz * lat - nx * depth;
  out.z = fz + nx * lat - nz * depth;
  out.y = 0.48;
  out.hx = halfWidth;
  out.hy = 0.48;
  out.hz = depth;
  out.yaw = Math.atan2(nx, nz);
  out.vx = 0;
  out.vz = 0;
  out.kg = Infinity;
  out.hardness = 1;
  out.fixed = true;
  out.round = false;
  return out;
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
export function faceOverlap(car: DeformableCar, box: ContactBox, point: THREE.Vector3): number {
  const fx = detSin(box.yaw);
  const fz = detCos(box.yaw);
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
  const hulls = car.crushHulls();
  for (let q = 0; q < hulls.length; q++) {
    const h = hulls[q]!;
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
  // The point rides at the car's own height (a solid stands where the car does: a monument on its embankment is 4 m up).
  point.set(box.x + fx * box.hz + rx * lat, Math.min(box.y, p.y + 0.48), box.z + fz * box.hz + rz * lat);
  return best;
}

function shiftVelocities(car: DeformableCar, dx: number, dz: number): void {
  const masses = car.deform.masses;
  for (let q = 0; q < masses.length; q++) {
    const m = masses[q]!;
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
  const fx = detSin(box.yaw);
  const fz = detCos(box.yaw);
  const closing = (box.vx - car.velocity.x) * fx + (box.vz - car.velocity.z) * fz;
  const overlap = faceOverlap(car, box, _p);
  bodyHit.touching = overlap > 0;
  _n.set(fx, 0, fz);
  if (overlap > 0.004 && closing > 0.2 && (box.fixed || !car.crashed)) car.applyImpact(_p, _n, closing, strikeEbs(closing, box.kg, d.totalMass, box.hardness));
  if (!d.massActive) return 0;
  const ub = box.vx * fx + box.vz * fz;
  shiftVelocities(car, -fx * ub, -fz * ub);
  // The slab's thin axis (`projectOutOfBox` x) is the striker's travel.
  let taken = d.projectOutOfBox(box.x, box.z, box.hz, box.hx, box.yaw - Math.PI / 2, !box.fixed);
  // A fixed solid narrower than the car (a palm between the bumpers) meets the crush hulls before any particle, and the slab's own
  // rule (`BarrierSlab.resolve`) holds: hulls on the face are a contact all the same. The hit stays open (the quiet clock ran out while
  // the hulls held the wreck off the palm, and the particles' arrival re-armed the hit: an 8 m/s tap read 0.016 m of block travel
  // against the slab's 0), the force spends the stroke from the first touch (a rigid shove (`wallBounce`) takes a wreck's position off
  // the face but none of its speed: a sedan at 55 m/s stood on its treadmill at the palm for 12 steps, then drove round it at
  // 40 m/s), and the hulls crush the particles near their deepest point (`feedOverlap`) until the particles are on the face.
  const hulled = box.fixed && overlap > 0.004 && closing > 0.2;
  if (d.faceContacts > 0 || hulled) {
    bodyHit.touching = true;
    d.notifyContact();
    if (crush) {
      if (d.faceContacts === 0) d.feedOverlap(_p, _n, overlap, closing, dt);
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
  const r = Math.max(gap / detCos(phi), 0.11);
  return r * detSin(phi) - DOOR.mirrorHalfDepth * detCos(phi);
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
  if (reach <= mirrorSweep(fold, gap) || gap / detCos(fold) > DOOR.mirrorReach) return;
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

/** The point `radius` m along a door's plan line from its hinge, the door open `theta` rad, in the car's frame: `across` outward from the car's middle, `along` forward (m). */
const doorPoint = { across: 0, along: 0 };

function doorPointAt(radius: number, theta: number): typeof doorPoint {
  doorPoint.across = DOOR.hingeX + radius * detSin(theta);
  doorPoint.along = DOOR.hingeZ - radius * detCos(theta);
  return doorPoint;
}

/** Whether a body from `bottom` to `top` (m above the car's ground) reaches the door's own heights. */
function doorInHeights(bottom: number, top: number): boolean {
  return bottom <= DOOR.hingeY + DOOR.halfHeight && top >= DOOR.hingeY - DOOR.halfHeight;
}

/**
 * Door slab (top view: hinge → trailing edge) against the face. Free door: one restitution
 * impulse through the door's effective mass I/k² at the contact (k = lever across the travel).
 * Door on its stop and pushed open: the car is rigid, so the strap takes the striker's closing
 * energy. The struck car itself is held: the slab is light against either body.
 */
function hitDoor(car: DeformableCar, side: -1 | 1, lane: Lane): void {
  if (car.partOff(side < 0 ? "doorL" : "doorR")) return;
  if (!doorInHeights(lane.bottom, lane.top)) return;
  const door = car.doorHinge(side);
  const sin = detSin(door.theta);
  if (sin < 1e-3) return;
  const rLo = (lane.inner - DOOR.hingeX) / sin;
  const rHi = Math.min(DOOR.length, (lane.inner + lane.width - DOOR.hingeX) / sin);
  if (rLo > rHi || rHi <= 0) return;
  const s = lane.dir;
  // A rear→front face meets the trailing (lowest-z) end of the slab in the lane first.
  const r = s > 0 ? rHi : Math.max(rLo, 0);
  const depth = s * (lane.face - doorPointAt(r, door.theta).along);
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
 * A stretched quarter panel (top view: hinge at the tail → free end ahead), the door slab's mirror image against the same
 * face: rear→front pushes it back onto the body, front→rear pulls it out. Sheet steel creases rather than springs: the slab
 * goes where the face pushes it and the striker pays the plastic work of the bend (`PANEL_BEND_NM` over the angle moved), with
 * no rebound. A striker carrying more than the tear energy comes through instead and the panel goes (one already stretched
 * to `PANEL_FRAGILE_T` goes at a nudge), the way the strap takes a door. Pushed back it stays dented (`bendPanel`: a hinge
 * value kept, never flat); pulled out it opens up to full hinge and holds there. Only the relative motion enters, so the ram
 * on a parked car and a car driven into a still ram agree.
 */
function hitPanel(car: DeformableCar, side: -1 | 1, lane: Lane): void {
  const p = car.quarterPanel(side);
  if (p.detached || !p.open) return;
  const r = p.region!;
  if (lane.bottom > r.span[1] || lane.top < r.span[0]) return;
  const t = p.hingeT;
  const theta = r.peel * t;
  const sin = detSin(theta);
  if (sin < 1e-3) return;
  const hx = Math.abs(r.pivot[0]);
  const rLo = (lane.inner - hx) / sin;
  const rHi = Math.min(r.reach, (lane.inner + lane.width - hx) / sin);
  if (rLo > rHi || rHi <= 0) return;
  const s = lane.dir;
  // A rear→front face meets the slab's rear-most (lowest-z) end in the lane first, a front→rear face its front-most.
  const at = s > 0 ? Math.max(rLo, 0) : rHi;
  const depth = s * (lane.face - (r.pivot[1] + at * detCos(theta)));
  if (depth <= 0 || depth > lane.length) return;
  partHit.touched = true;
  const limit = t >= PANEL_FRAGILE_T ? PANEL_FRAGILE_J : s > 0 ? PANEL_SLAM_J : PANEL_PULL_J;
  if (0.5 * lane.kg * lane.u * lane.u >= limit) {
    // What the striker still carries after paying for the tear.
    lane.u = Math.sqrt(Math.max(0, lane.u * lane.u - (2 * limit) / lane.kg));
    car.ripPanel(side, _push.set(side * 0.9, 0.6, s * Math.max(lane.u, 1)));
    return;
  }
  // Push the slab out of the face: back (s > 0: the angle falls) or out (s < 0: it rises).
  const k = Math.max(at * sin, 0.02);
  car.bendPanel(side, t - (s * depth) / (k * r.peel));
  const moved = Math.abs(p.hingeT - t) * r.peel;
  // A panel that cannot go further (full hinge) holds the striker.
  lane.u = moved > 0 ? Math.sqrt(Math.max(0, lane.u * lane.u - (2 * PANEL_BEND_NM * moved) / lane.kg)) : 0;
}

/** Plan samples along a door, hinge to trailing edge, a fixed solid is asked about: a door is 0.57 m long, a lamp post 0.17 m across. */
const DOOR_SAMPLES = 8;
/** The door skin's reach (m) past its plan line, the angle step (rad) a door is walked shut by (1.7 cm of trailing edge) and the halvings that then find the angle it clears at. */
const DOOR_SKIN = 0.03;
const DOOR_STEP = 0.03;
const DOOR_HALVINGS = 6;
/** An open door narrower than this (rad) is a door shut. */
const DOOR_SHUT = 0.02;

/** Whether door `side`, open `angle` rad, has a point of its plan line inside the fixed solid `box` (its heights taken as read). */
function doorMeetsSolid(car: DeformableCar, side: -1 | 1, angle: number, box: ContactBox): boolean {
  const p = car.group.position;
  const c = detCos(box.yaw);
  const n = detSin(box.yaw);
  for (let k = 1; k <= DOOR_SAMPLES; k++) {
    const point = doorPointAt((DOOR.length * k) / DOOR_SAMPLES, angle);
    const lx = side * point.across;
    const dx = p.x + car.rightFlat.x * lx + car.fwdFlat.x * point.along - box.x;
    const dz = p.z + car.rightFlat.z * lx + car.fwdFlat.z * point.along - box.z;
    const meets = box.round ? dx * dx + dz * dz < (box.hx + DOOR_SKIN) * (box.hx + DOOR_SKIN) : Math.abs(dx * c - dz * n) < box.hx + DOOR_SKIN && Math.abs(dx * n + dz * c) < box.hz + DOOR_SKIN;
    if (meets) return true;
  }
  return false;
}

/** The angle (rad) door `side`, open `angle`, clears the fixed solid `box` at: walked shut by `DOOR_STEP`, then halved to the edge; 0 when even shut it meets the solid. */
function angleClearingSolid(car: DeformableCar, side: -1 | 1, angle: number, box: ContactBox): number {
  let hi = angle;
  let lo = angle - DOOR_STEP;
  while (lo > 0 && doorMeetsSolid(car, side, lo, box)) {
    hi = lo;
    lo -= DOOR_STEP;
  }
  lo = Math.max(lo, 0);
  if (lo === 0 && doorMeetsSolid(car, side, 0, box)) return 0;
  for (let k = 0; k < DOOR_HALVINGS; k++) {
    const mid = (lo + hi) / 2;
    if (doorMeetsSolid(car, side, mid, box)) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * The car's open doors against a fixed solid over a slice of `dt` s, beyond the footprint where the body is held: a door stands
 * out past the tyres (a crash leaves one hanging open, 1.4 m off the car's middle) and is drawn into whatever stands there. The
 * solid shuts a door it meets just far enough to clear it (`shutDoor`), at the closing rate that took: a door the crash jammed
 * open cannot shut and is torn off, and so is one slammed shut past the hinge's limit. A door the solid stands against even
 * shut is the body's to hold.
 */
function shutDoorsOnSolid(car: DeformableCar, box: ContactBox, dt: number): void {
  const groundY = car.group.position.y;
  if (!doorInHeights(box.y - box.hy - groundY, box.y + box.hy - groundY)) return;
  for (let q = 0; q < SIDES.length; q++) {
    const side = SIDES[q]!;
    const angle = car.doorAngle(side);
    if (angle < DOOR_SHUT || !doorMeetsSolid(car, side, angle, box)) continue;
    const clearing = angleClearingSolid(car, side, angle, box);
    car.shutDoor(side, clearing, (angle - clearing) / dt);
    partHit.touched = true;
  }
}

/**
 * Door and mirror colliders of `car` against `box`, both sides. A striker that moves sweeps a lane, and only its travel along
 * the car moves a door or a mirror (a shut door struck square is body crush, the crash rules' C1–C3). A `fixed` solid stands
 * where the door is drawn and shuts it over a slice of `dt` s (`shutDoorsOnSolid`). Returns `partHit`; the caller takes `du`
 * off the striker's speed along (`nx`, `nz`).
 */
export function partContact(car: DeformableCar, box: ContactBox, dt: number): typeof partHit {
  partHit.touched = false;
  partHit.du = 0;
  if (box.fixed) {
    shutDoorsOnSolid(car, box, dt);
    return partHit;
  }
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
  const c = detCos(box.yaw);
  const s = detSin(box.yaw);
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
  for (let q = 0; q < SIDES.length; q++) {
    const side = SIDES[q]!;
    if (side * lx + ex <= 0) continue;
    lane.inner = side * lx - ex;
    // Past the open door's trailing edge and the mirror cap: nothing to meet. Reaching inside the
    // body's width is a body hit: the crash rules (C1–C3) take the door and mirror then.
    if (lane.inner > DOOR.hingeX + DOOR.length || lane.inner < CAR_HALF.x) continue;
    lane.width = 2 * ex;
    hitMirror(car, side, lane);
    hitDoor(car, side, lane);
    hitPanel(car, side, lane);
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
 * assume a car held at the origin. Returns whether a door, mirror or panel met the other body: a sideswipe moves
 * and breaks parts with no SAT contact, and the highlight recorder keeps both cars of it.
 */
export function partContactPair(a: DeformableCar, b: DeformableCar, dt: number): boolean {
  carBox(a, _ba);
  carBox(b, _bb);
  let hit = partContact(a, _bb, dt);
  const first = hit.touched;
  if (hit.du > 0) slowStriker(b, hit.nx, hit.nz, hit.du);
  hit = partContact(b, _ba, dt);
  if (hit.du > 0) slowStriker(a, hit.nx, hit.nz, hit.du);
  return first || hit.touched;
}
