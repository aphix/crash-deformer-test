import * as THREE from "three";
import { DOOR, type DeformableCar } from "../vehicle/car.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";
import { DOOR_INERTIA, DOOR_OPEN_MAX, HINGE_TEAR_J, MIRROR_BREAK_J, MIRROR_FOLD_MAX } from "../vehicle/car-core.ts";
import { PANEL_BEND_NM, PANEL_FRAGILE_J, PANEL_FRAGILE_T, PANEL_PULL_J, PANEL_SLAM_J } from "../vehicle/car-wear.ts";
import { detSin, detCos } from "../kernel/physics-core.js";
import { bodyContact, BODY_HARD, BODY_I, BODY_M, BODY_SIZE, BODY_VX, BODY_VZ, BODY_W, BODY_X, BODY_Z, CT_DEPTH, CT_E, CT_JMAX, CT_MU, CT_NX, CT_NZ, CT_SIZE, CT_X, CT_Z, OUT_EBS_A, OUT_PUSH_A, OUT_SIZE } from "./body-contact.ts";
import { FACE_ROW } from "../deform/deform-contact.ts";
import { ARM_CLOSING, SOLID_MU } from "./constants.ts";
import { outlineOf } from "./cage-outline.ts";

/**
 * One contact model for anything that strikes a car: the Doors ram, a press plate, a piston face
 * or another car's body. The striker is an oriented box with a velocity and a mass (`Infinity`:
 * a kinematic driver). Every scene runs the same door and mirror colliders against it
 * (`partContact`), the same body crush (`bodyContact`: the barrier's and car-car's
 * `applyImpact` / `feedOverlap` / slab sequence) and reports the struck end to
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

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Outline nodes a gap from the face (the contact begins before the overlap) are as near as the nearest within this many metres. */
const TIE_GAP = 0.02;
/** Where the last `faceOverlap` found the face pushed: the depth-weighted centre of the car's outline nodes on it (plan). */
const pressure = { x: 0, z: 0 };
/**
 * How far the box's leading face (its +z end) has pushed into the car's cage along its travel (m, ≤ 0 clear: the gap), with the
 * contact point on the face in `point`. The car is its cage's plan outline: every outline node across the face's span takes part,
 * each as deep as the face has passed it. The point is the depth-weighted centre of the nodes in it (the patch's pressure centre:
 * a square hit's middle, a hit half on the face the half that is on it); before any node is in, the nearest nodes'.
 */
function faceOverlap(car: DeformableCar, box: ContactBox, point: THREE.Vector3): number {
  const fx = detSin(box.yaw);
  const fz = detCos(box.yaw);
  const rx = fz;
  const rz = -fx;
  const ax = car.rightFlat;
  const az = car.fwdFlat;
  const p = car.group.position;
  const outline = outlineOf(car);
  // The car's frame against the box's: a node at (x, z) is `along` the box's travel and `side` across it, from the box's centre.
  const ox = p.x - box.x;
  const oz = p.z - box.z;
  const a0 = ox * fx + oz * fz;
  const s0 = ox * rx + oz * rz;
  const axf = ax.x * fx + ax.z * fz;
  const azf = az.x * fx + az.z * fz;
  const axr = ax.x * rx + ax.z * rz;
  const azr = az.x * rx + az.z * rz;
  let best = -Infinity;
  let w = 0;
  let latSum = 0;
  for (let n = 0; n < outline.count; n++) {
    const x = outline.xs[n]!;
    const z = outline.zs[n]!;
    const side = s0 + axr * x + azr * z;
    if (Math.abs(side) > box.hx) continue;
    const along = a0 + axf * x + azf * z;
    if (along < -box.hz) continue;
    const depth = box.hz - along;
    if (depth > best) best = depth;
    if (depth > 0) {
      w += depth;
      latSum += depth * side;
    }
  }
  let mean = 0;
  if (w > 0) mean = latSum / w;
  else if (best > -Infinity) {
    // No node in yet: the nodes nearest the face, as near as the nearest within `TIE_GAP`.
    let count = 0;
    for (let n = 0; n < outline.count; n++) {
      const side = s0 + axr * outline.xs[n]! + azr * outline.zs[n]!;
      if (Math.abs(side) > box.hx) continue;
      const along = a0 + axf * outline.xs[n]! + azf * outline.zs[n]!;
      if (along < -box.hz || box.hz - along < best - TIE_GAP) continue;
      latSum += side;
      count++;
    }
    mean = latSum / count;
  }
  pressure.x = box.x + fx * box.hz + rx * mean;
  pressure.z = box.z + fz * box.hz + rz * mean;
  // The point rides at the car's own height (a solid stands where the car does: a monument on its embankment is 4 m up).
  point.set(pressure.x, Math.min(box.y, p.y + 0.48), pressure.z);
  return best;
}

/**
 * How far (m, ≤ 0 clear) the box's leading face has passed the deepest vertex of the car's drawn body (its cage's vertices: the
 * mesh's triangles are convex combinations of them, so its deepest point is one), across the face's span. A torn-off or shattered
 * panel's vertices (left at rest in `pos`) are no part of the body. The outline nodes (`faceOverlap`) are a lattice's reading of the
 * same shape and lose a thin tip (a fender's corner stood 15 cm beyond its nearest covered node).
 */
export function faceDepth(car: DeformableCar, box: ContactBox): number {
  const fx = detSin(box.yaw);
  const fz = detCos(box.yaw);
  const rx = fz;
  const rz = -fx;
  const ax = car.rightFlat;
  const az = car.fwdFlat;
  const p = car.group.position;
  const { pos, panelOn } = car.cage.fields;
  const { vertexCount, vertexGroup } = car.cage.style;
  const ox = p.x - box.x;
  const oz = p.z - box.z;
  let best = -Infinity;
  let inside = false;
  for (let k = 0; k < vertexCount; k++) {
    const g = vertexGroup[k]!;
    if (g > 0 && panelOn[g - 1] === 0) continue;
    const x = pos[k * 3]!;
    const z = pos[k * 3 + 2]!;
    const wx = ox + ax.x * x + az.x * z;
    const wz = oz + ax.z * x + az.z * z;
    if (Math.abs(wx * rx + wz * rz) > box.hx) continue;
    const along = wx * fx + wz * fz;
    if (along >= -box.hz) inside = true;
    if (box.hz - along > best) best = box.hz - along;
  }
  // A body with a point in the slab is as deep as its farthest point, however far past the back face (the pushed-through corner is
  // what the push-out must bring back); one wholly beyond the back face is on the slab's other side, no contact of this face.
  return inside ? best : -Infinity;
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

/**
 * Result of the last `strikeCar` (reused): the face overlapped the hulls (or is a slice's travel from them) or held a particle; how
 * deep the hulls are in it (m, negative: the gap), the closing speed (m/s), and the contact point and the unit normal into the car (plan).
 */
export const bodyHit = { touching: false, depth: 0, closing: 0, x: 0, z: 0, nx: 0, nz: 0 };

// The kernel's rows (`contact/body-contact.ts`): the struck car, the striker, the contact and the result, reused by every call.
const rows = new Float64Array(2 * BODY_SIZE);
const STRIKER = BODY_SIZE;
const contact = new Float64Array(CT_SIZE);
const result = new Float64Array(OUT_SIZE);

/**
 * Row 0 of `rows`: the car as one rigid body in plan, read off its masses (a car that is no wreck moves as its group does): mass, yaw
 * inertia and centre of its masses, and the spin their velocities have about it. What closes on the face is the structure still
 * driving into it (a nose held on the face is at rest on it, and the face's impulse cannot reach it): the row's velocity is the mean of
 * the masses moving into the face faster than `faceVn` along the normal, so the cabin piling into the stopped nose is the closing the
 * crush force acts on, and `shiftBody` gives the increment to those masses alone. With none driving, or no wreck, it is every mass.
 */
export function carRow(out: Float64Array, o: number, car: DeformableCar, nx: number, nz: number, faceVn: number): void {
  const masses = car.deform.masses;
  const live = car.deform.massActive;
  let mass = 0;
  let cx = 0;
  let cz = 0;
  let px = 0;
  let pz = 0;
  let drivingMass = 0;
  let drivingX = 0;
  let drivingZ = 0;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    if (live && !m.dynamic) continue;
    mass += m.mass;
    cx += m.mass * m.world.x;
    cz += m.mass * m.world.z;
    px += m.mass * m.vel.x;
    pz += m.mass * m.vel.z;
    if (m.vel.x * nx + m.vel.z * nz < faceVn) {
      drivingMass += m.mass;
      drivingX += m.mass * m.vel.x;
      drivingZ += m.mass * m.vel.z;
    }
  }
  cx /= mass;
  cz /= mass;
  const meanX = live ? px / mass : car.velocity.x;
  const meanZ = live ? pz / mass : car.velocity.z;
  let inertia = 0;
  let spin = 0;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    if (live && !m.dynamic) continue;
    const rx = m.world.x - cx;
    const rz = m.world.z - cz;
    inertia += m.mass * (rx * rx + rz * rz);
    spin += m.mass * (rz * (m.vel.x - meanX) - rx * (m.vel.z - meanZ));
  }
  const driving = live && drivingMass > 0;
  out[o + BODY_M] = mass;
  out[o + BODY_I] = inertia;
  out[o + BODY_X] = cx;
  out[o + BODY_Z] = cz;
  out[o + BODY_VX] = driving ? drivingX / drivingMass : meanX;
  out[o + BODY_VZ] = driving ? drivingZ / drivingMass : meanZ;
  out[o + BODY_W] = live ? spin / inertia : car.angular.y;
  out[o + BODY_HARD] = 1;
}

/**
 * The kernel's change of the car's row `o` of `rows` (its velocity and spin now, against `vx`, `vz`, `w` before the call) onto every mass of
 * the car (the normal part along (`nx`, `nz`), into the car, to the masses still driving in faster than the face's `refVn`: `shiftBody`),
 * or onto the car's own velocity and spin when it is no wreck. Returns the normal momentum taken (N·s).
 */
export function takeRow(car: DeformableCar, rows: Float64Array, o: number, vx: number, vz: number, w: number, nx: number, nz: number, refVn: number): number {
  const dvx = rows[o + BODY_VX]! - vx;
  const dvz = rows[o + BODY_VZ]! - vz;
  const dw = rows[o + BODY_W]! - w;
  if (car.deform.massActive) return car.deform.shiftBody(dvx, dvz, dw, rows[o + BODY_X]!, rows[o + BODY_Z]!, nx, nz, refVn);
  car.velocity.x += dvx;
  car.velocity.z += dvz;
  car.angular.y += dw;
  return (dvx * nx + dvz * nz) * rows[o + BODY_M]!;
}

/** Row 1 of `rows`: the striker box on rails (no spin of its own), its mass (`Infinity` kinematic) and the hardness of its face. */
function strikerRow(box: ContactBox): void {
  rows[STRIKER + BODY_M] = box.kg;
  rows[STRIKER + BODY_I] = Infinity;
  rows[STRIKER + BODY_X] = box.x;
  rows[STRIKER + BODY_Z] = box.z;
  rows[STRIKER + BODY_VX] = box.vx;
  rows[STRIKER + BODY_VZ] = box.vz;
  rows[STRIKER + BODY_W] = 0;
  rows[STRIKER + BODY_HARD] = box.hardness;
}

/**
 * The one momentum exchange of a striker and a car at the face's deepest hull point (`_p`, normal `_n` out of the striker into the
 * car), at the most `maxJ` of normal impulse (the structure's crush force over the slice; 0 reads the hit's equivalent barrier speed
 * and changes nothing). The car's change of motion goes onto every mass (or the group of a car that is no wreck); the striker's is
 * read back by the caller as the momentum returned. Plastic (the cars leave together): the rebound of a light touch is `wallBounce`'s.
 */
function exchange(car: DeformableCar, box: ContactBox, depth: number, maxJ: number): number {
  carRow(rows, 0, car, _n.x, _n.z, box.vx * _n.x + box.vz * _n.z);
  strikerRow(box);
  contact[CT_X] = pressure.x;
  contact[CT_Z] = pressure.z;
  contact[CT_NX] = _n.x;
  contact[CT_NZ] = _n.z;
  contact[CT_DEPTH] = depth;
  contact[CT_E] = 0;
  contact[CT_MU] = SOLID_MU;
  contact[CT_JMAX] = maxJ;
  const vx = rows[BODY_VX]!;
  const vz = rows[BODY_VZ]!;
  const w = rows[BODY_W]!;
  const j = bodyContact(rows, 0, STRIKER, contact, result);
  if (j === 0) return 0;
  const taken = takeRow(car, rows, 0, vx, vz, w, _n.x, _n.z, box.vx * _n.x + box.vz * _n.z);
  return car.deform.massActive ? taken : j;
}

/** Most masses one slab can hold rows for (a car has 20); `faceHits` drops the rest. */
const FACE_MAX = 64;
const faceHits = new Float64Array(FACE_MAX * FACE_ROW);
const faceWho = new Int32Array(FACE_MAX);
const faceRows = new Float64Array(2 * BODY_SIZE);
const faceContact = new Float64Array(CT_SIZE);
const faceResult = new Float64Array(OUT_SIZE);

/**
 * The rigid slab (centre `cx`/`cz`, half extents `hx`/`hz`, rotated by `yaw`) at rest in the frame the masses' velocities are in: each
 * mass inside it is one kernel contact (`bodyContact`: the mass a point body, the slab kinematic; plastic, no friction) along the
 * nearer face's normal, which takes the inbound speed off the mass, and moves the mass out by the kernel's push-out (the whole depth:
 * the slab never moves). Returns the momentum the slab took (N·s). Without `ends` a mass never leaves round an end face.
 */
export function holdOnFace(d: DeformableCar["deform"], cx: number, cz: number, hx: number, hz: number, yaw: number, ends: boolean): number {
  const n = d.faceHits(cx, cz, hx, hz, yaw, ends, faceHits, faceWho);
  if (n === 0) return 0;
  const masses = d.masses;
  faceRows[BODY_SIZE + BODY_M] = Infinity;
  faceRows[BODY_SIZE + BODY_I] = Infinity;
  faceRows[BODY_SIZE + BODY_X] = cx;
  faceRows[BODY_SIZE + BODY_Z] = cz;
  faceRows[BODY_SIZE + BODY_VX] = 0;
  faceRows[BODY_SIZE + BODY_VZ] = 0;
  faceRows[BODY_SIZE + BODY_W] = 0;
  faceRows[BODY_SIZE + BODY_HARD] = 1;
  faceRows[BODY_I] = Infinity;
  faceRows[BODY_W] = 0;
  faceRows[BODY_HARD] = 1;
  faceContact[CT_E] = 0;
  faceContact[CT_MU] = 0;
  faceContact[CT_JMAX] = Infinity;
  let taken = 0;
  for (let i = 0; i < n; i++) {
    const o = i * FACE_ROW;
    const m = masses[faceWho[i]!]!;
    faceRows[BODY_M] = m.mass;
    faceRows[BODY_X] = faceHits[o]!;
    faceRows[BODY_Z] = faceHits[o + 1]!;
    faceRows[BODY_VX] = m.vel.x;
    faceRows[BODY_VZ] = m.vel.z;
    faceContact[CT_X] = faceHits[o]!;
    faceContact[CT_Z] = faceHits[o + 1]!;
    faceContact[CT_NX] = faceHits[o + 2]!;
    faceContact[CT_NZ] = faceHits[o + 3]!;
    faceContact[CT_DEPTH] = faceHits[o + 4]!;
    taken += bodyContact(faceRows, 0, BODY_SIZE, faceContact, faceResult);
    m.vel.x = faceRows[BODY_VX]!;
    m.vel.z = faceRows[BODY_VZ]!;
    const push = faceResult[OUT_PUSH_A]!;
    d.pushMass(faceWho[i]!, faceHits[o + 2]! * push, faceHits[o + 3]! * push);
  }
  d.packEngineBlock(cx, cz, yaw);
  return taken;
}

/**
 * A striker's contact with a car, one physics slice. The contact begins before the overlap: it is active while the face is nearer the
 * hull than this slice's closing travel, so the hit starts at 0 depth (`applyImpact` with the kernel's equivalent barrier speed:
 * the lever of the point and the striker's mass and face hardness are in it). The particles are held on the face in the striker's
 * frame (`holdOnFace`, the barrier's slab) and, with `crush`, the face's momentum exchange (`bodyContact`) is limited by the
 * structure's crush force over the slice, which spends the hit's stroke, and gives the car its spin from the lever.
 * Returns the momentum (N·s) the car took off the striker along its travel.
 */
export function strikeCar(car: DeformableCar, box: ContactBox, dt: number, crush: boolean, arm = crush): number {
  const d = car.deform;
  const fx = detSin(box.yaw);
  const fz = detCos(box.yaw);
  const closing = (box.vx - car.velocity.x) * fx + (box.vz - car.velocity.z) * fz;
  const overlap = faceOverlap(car, box, _p);
  const near = overlap > -Math.max(0, closing) * dt;
  _n.set(fx, 0, fz);
  bodyHit.touching = near;
  bodyHit.depth = overlap;
  bodyHit.closing = closing;
  bodyHit.x = _p.x;
  bodyHit.z = _p.z;
  bodyHit.nx = fx;
  bodyHit.nz = fz;
  // The hit's equivalent barrier speed is read before the face takes anything off the particles' speed.
  let armable = arm && closing > ARM_CLOSING && (box.fixed || !car.crashed);
  let barrierSpeed = 0;
  if (armable) {
    exchange(car, box, Math.max(0, overlap), 0);
    barrierSpeed = result[OUT_EBS_A]!;
    if (near) {
      car.applyImpact(_p, _n, closing, barrierSpeed);
      armable = false;
    }
  }
  let taken = 0;
  let held = false;
  if (d.massActive) {
    const ub = box.vx * fx + box.vz * fz;
    shiftVelocities(car, -fx * ub, -fz * ub);
    // The slab's thin axis (`holdOnFace` x) is the striker's travel.
    taken = holdOnFace(d, box.x, box.z, box.hz, box.hx, box.yaw - Math.PI / 2, !box.fixed);
    // A fixed solid narrower than the car (a palm between the bumpers) meets the crush hulls before any particle, and the slab's own
    // rule (`BarrierSlab.resolve`) holds: hulls on the face are a contact all the same. The hit stays open (the quiet clock ran out while
    // the hulls held the wreck off the palm, and the particles' arrival re-armed the hit: an 8 m/s tap read 0.016 m of block travel
    // against the slab's 0), and the hulls crush the particles near their deepest point (`feedOverlap`) until the particles are on the face.
    const hulled = box.fixed && overlap > 0.004 && closing > ARM_CLOSING;
    if (d.faceContacts > 0 || hulled) {
      held = true;
      bodyHit.touching = true;
      // A wreck coming back for another hit touches the face with its particles while its shrunken hulls are clear of it: the fresh hit
      // arms here (before the contact is marked: a re-arm needs the quiet time the wreck has had).
      if (armable) car.applyImpact(_p, _n, closing, barrierSpeed);
      if (crush || arm) d.notifyContact();
      // A fixed solid's hulls are fed as crush for as long as they overlap it (the barrier slab's own rule). A striker that moves (a
      // piston head, a press plate) feeds them only until a particle reaches its face: from then on the structure's stroke (`exchange`)
      // spends the hit, and feeding the overlap as well crushes the corner twice (wing 0.188 m against 0.029 m on the corner piston).
      if (crush && overlap > 0 && (box.fixed || d.faceContacts === 0)) d.feedOverlap(_p, _n, overlap, closing, dt);
    }
    shiftVelocities(car, fx * ub, fz * ub);
  }
  if (crush && held) {
    const ebs = Math.max(0, d.hitSpeedValue);
    taken += exchange(car, box, Math.max(0, overlap), ((d.totalMass * ebs * ebs) / (2 * Math.max(0.05, d.hitStroke()))) * dt);
  }
  return taken;
}

/** A car's body as a striker: its cage's plan box and height span (level about its origin), heading, velocity and mass. */
function carBox(car: DeformableCar, out: ContactBox): ContactBox {
  const p = car.group.position;
  const plan = car.cage.fields.planBox;
  const midX = (plan[0]! + plan[1]!) / 2;
  const midZ = (plan[2]! + plan[3]!) / 2;
  const cage = car.cage;
  const pos = cage.fields.pos;
  let low = Infinity;
  let high = -Infinity;
  for (let k = 0; k < cage.style.vertexCount; k++) {
    const y = pos[k * 3 + 1]!;
    if (y < low) low = y;
    if (y > high) high = y;
  }
  const lift = CLASSES[carClass(car)].lift;
  out.x = p.x + car.rightFlat.x * midX + car.fwdFlat.x * midZ;
  out.y = p.y + lift + (low + high) / 2;
  out.z = p.z + car.rightFlat.z * midX + car.fwdFlat.z * midZ;
  out.hx = (plan[1]! - plan[0]!) / 2;
  out.hy = (high - low) / 2;
  out.hz = (plan[3]! - plan[2]!) / 2;
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
  const plan = car.cage.fields.planBox;
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
    if (lane.inner > DOOR.hingeX + DOOR.length || lane.inner < (side > 0 ? plan[1]! : -plan[0]!)) continue;
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
 * Car-car share of the shared contact model, once per physics slice per close pair: each body, as its cage's plan box (`carBox`),
 * against the other's doors and mirrors. Car-car does not report struck ends yet (docs/CONTACT_PARITY.md, "Open"): the squeeze
 * mode's deform rules assume a car held at the origin. Returns whether a door, mirror or panel met the other body: a sideswipe moves
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
