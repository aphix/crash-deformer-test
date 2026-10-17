import * as THREE from "three";
import { DOOR, type DeformableCar } from "../vehicle/car.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";
import { detSin, detCos, detAtan2 } from "../kernel/physics-core.js";
import { bodyContact, BODY_HARD, BODY_I, BODY_M, BODY_SIZE, BODY_VX, BODY_VZ, BODY_W, BODY_X, BODY_Z, CT_DEPTH, CT_E, CT_JMAX, CT_MU, CT_NX, CT_NZ, CT_SIZE, CT_X, CT_Z, OUT_EBS_A, OUT_PUSH_A, OUT_SIZE } from "./body-contact.ts";
import { FACE_ROW } from "../deform/deform-contact.ts";
import { ARM_CLOSING, SOLID_MU } from "./constants.ts";
import { outlineOf } from "./cage-outline.ts";
import { _lane, hitDoor, hitMirror, hitPanel, partHit, shutDoorsOnSolid, SIDES } from "./door-contact.ts";

/**
 * One contact model for anything that strikes a car (the Doors ram, a press plate, a piston face, another car's body): an oriented
 * box with a velocity and a mass (`Infinity`: a kinematic driver), met by the same door and mirror colliders (`partContact`) and body
 * crush (`bodyContact`), and reporting the struck end to the car (`DeformableCar.noteContactEnd`).
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
   * time and energy, as the barrier and car-car do), and a particle in it leaves by the car-side face, never round an end unless the
   * box has `openEnds` (a wall's end is the joint to its neighbour, so the particle would stay in the wall).
   */
  fixed: boolean;
  /**
   * The face's span ends are the solid's own ends (a rail, a container, a pad), not a joint to a neighbour (a wall's hold face): a body
   * point nearer an end than the car-side face is out round that end when the car's centre stands beyond it (`faceDepth`).
   */
  openEnds: boolean;
  /** Whether the plan shape is a circle of radius `hx` (a palm, a lamp post) rather than a box (`partContact`, on a `fixed` box). */
  round: boolean;
};

export function makeBox(): ContactBox {
  return { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0, vx: 0, vz: 0, kg: Infinity, hardness: 1, fixed: false, openEnds: false, round: false };
}

/**
 * `out` as the car-side face of a fixed solid (a race wall, a prop's side, a ramp's flank): its leading face lies on (`fx`, `fz`)
 * with the unit normal (`nx`, `nz`) out of the solid toward the car, `halfWidth` wide either side of the line through (`mx`, `mz`)
 * along that normal, `depth` thick behind the face.
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
  out.yaw = detAtan2(nx, nz);
  out.vx = 0;
  out.vz = 0;
  out.kg = Infinity;
  out.hardness = 1;
  out.fixed = true;
  out.openEnds = false;
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
 * How far the box's leading face (its +z end) has pushed into the car's cage outline along its travel (m, ≤ 0 clear: the gap), the
 * contact point in `point`: the depth-weighted centre of the outline nodes across the face's span (the patch's pressure centre); before
 * any node is in, the nearest nodes'.
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

/** What the last `faceDepth` found (reused): the unit normal (plan) the deepest vertex is out along, the face's or an open end's. */
export const faceExit = { nx: 0, nz: 0 };

/**
 * How far (m, ≤ 0 clear) the box's leading face has passed the deepest vertex of the car's cage across the face's span (the mesh's
 * triangles are convex combinations of them), and where that vertex leaves (`faceExit`): through the face, or, on a box with
 * `openEnds` whose span the car's centre lies beyond, round the end the centre is beyond (a body whose centre stands past an end got
 * in round it: a corner of it that came in round a rail's end read the rail's whole width as its depth through the face, and the
 * push-out shoved the car that far, 0.2-2.1 m on derby wrecks, for as long as the turn kept the corner in). A car whose centre stands
 * over the span drove in through the face, however near an end the vertex lies (a narrow post struck square: its end is as near as
 * its face, and the push-out sideways spun the car). A torn-off or shattered panel's vertices are no part of the body. The outline
 * nodes (`faceOverlap`) lose a thin tip (a fender's corner stood 15 cm beyond its nearest covered node).
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
  const centreSide = ox * rx + oz * rz;
  // The end the car's centre is beyond (0: it stands over the span, no end to leave round).
  const endSign = box.openEnds && Math.abs(centreSide) > box.hx ? Math.sign(centreSide) : 0;
  let best = -Infinity;
  let bestAtEnd = false;
  let inside = false;
  for (let k = 0; k < vertexCount; k++) {
    const g = vertexGroup[k]!;
    if (g > 0 && panelOn[g - 1] === 0) continue;
    const x = pos[k * 3]!;
    const z = pos[k * 3 + 2]!;
    const wx = ox + ax.x * x + az.x * z;
    const wz = oz + ax.z * x + az.z * z;
    const side = wx * rx + wz * rz;
    if (Math.abs(side) > box.hx) continue;
    const along = wx * fx + wz * fz;
    if (along >= -box.hz) inside = true;
    const throughFace = box.hz - along;
    const endGap = box.hx - endSign * side;
    const atEnd = endSign !== 0 && endGap < throughFace;
    const depth = atEnd ? endGap : throughFace;
    if (depth <= best) continue;
    best = depth;
    bestAtEnd = atEnd;
  }
  faceExit.nx = bestAtEnd ? endSign * rx : fx;
  faceExit.nz = bestAtEnd ? endSign * rz : fz;
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

/** Result of the last `strikeCar` (reused): whether the face touches the hulls (or is a slice's travel from them) or held a particle, their depth in it (m, negative: the gap), the closing speed (m/s), and the contact point and unit normal into the car (plan). */
export const bodyHit = { touching: false, depth: 0, closing: 0, x: 0, z: 0, nx: 0, nz: 0 };

// The kernel's rows (`contact/body-contact.ts`): the struck car, the striker, the contact and the result, reused by every call.
const rows = new Float64Array(2 * BODY_SIZE);
const STRIKER = BODY_SIZE;
const contact = new Float64Array(CT_SIZE);
const result = new Float64Array(OUT_SIZE);

/**
 * Row `o` of `rows`: the car as one rigid body in plan, read off its masses: mass, yaw inertia, centre and spin about it. What closes on
 * the face is the structure still driving into it (a nose held on it is at rest, out of the face's impulse's reach): the row's velocity
 * is the mean of the masses moving into the face faster than `faceVn` along the normal, referred back to the centre by the body's spin
 * (else a spinning rigid wreck closes on its partner by its own turn every slice). With none driving, or no wreck, it is every mass.
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
  let drivingPX = 0;
  let drivingPZ = 0;
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
      drivingPX += m.mass * m.world.x;
      drivingPZ += m.mass * m.world.z;
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
  const w = live ? spin / inertia : car.angular.y;
  // The driving masses' mean velocity is the body's at their centroid: referred to the centre, a rigid spinning wreck presents no closing of its own.
  const lever = driving ? drivingMass : 1;
  out[o + BODY_VX] = driving ? drivingX / drivingMass - w * (drivingPZ / lever - cz) : meanX;
  out[o + BODY_VZ] = driving ? drivingZ / drivingMass + w * (drivingPX / lever - cx) : meanZ;
  out[o + BODY_W] = w;
  out[o + BODY_HARD] = 1;
}

/**
 * The kernel's change of row `o` (its velocity and spin against `vx`, `vz`, `w` before the call) onto the car's masses (the normal part
 * along (`nx`, `nz`) only to those driving in faster than `refVn`: `shiftBody`), or onto the car's own motion when it is no wreck.
 * Returns the normal momentum taken (N·s).
 */
export function takeRow(car: DeformableCar, rows: Float64Array, o: number, vx: number, vz: number, w: number, nx: number, nz: number, refVn: number): number {
  const dvx = rows[o + BODY_VX]! - vx;
  const dvz = rows[o + BODY_VZ]! - vz;
  const dw = rows[o + BODY_W]! - w;
  if (car.deform.massActive) return car.deform.shiftBody(car.velocity, car.angular, dvx, dvz, dw, rows[o + BODY_X]!, rows[o + BODY_Z]!, nx, nz, refVn);
  car.velocity.x += dvx;
  car.velocity.z += dvz;
  car.angular.y += dw;
  return (dvx * nx + dvz * nz) * rows[o + BODY_M]!;
}

/** Every dynamic mass of `car` takes the rigid motion of the row at `o` of `rows` (its velocity and spin about its centre): momentum and angular momentum kept, the internal motion gone. */
export function moveAsOneBody(car: DeformableCar, rows: Float64Array, o: number): void {
  if (!car.deform.massActive) return;
  const vx = rows[o + BODY_VX]!;
  const vz = rows[o + BODY_VZ]!;
  const w = rows[o + BODY_W]!;
  const cx = rows[o + BODY_X]!;
  const cz = rows[o + BODY_Z]!;
  car.velocity.x = vx;
  car.velocity.z = vz;
  car.angular.y = w;
  for (const q of car.deform.masses) {
    if (!q.dynamic) continue;
    q.vel.x = vx + w * (q.world.z - cz);
    q.vel.z = vz - w * (q.world.x - cx);
  }
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
 * The one momentum exchange of a striker and a car at the face's deepest hull point (`_p`, normal `_n` into the car), at the most
 * `maxJ` of normal impulse (the crush force over the slice; 0 only reads the equivalent barrier speed). Plastic: the rebound of a
 * light touch is `wallBounce`'s. Returns the momentum the striker gave back to the caller.
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
  if (maxJ === Infinity) moveAsOneBody(car, rows, 0);
  return car.deform.massActive ? taken : j;
}

/** Most masses one slab can hold rows for (a car has 20); `faceHits` drops the rest. */
const FACE_MAX = 64;
const faceHits = new Float64Array(FACE_MAX * FACE_ROW);
const faceWho = new Int32Array(FACE_MAX);
const faceRows = new Float64Array(2 * BODY_SIZE);
const faceContact = new Float64Array(CT_SIZE);
const faceResult = new Float64Array(OUT_SIZE);

/** [0]: the deepest mass (m) past the face in the last `holdOnFace` call, as it met them; -Infinity when none was inside. */
const holdDepth = new Float64Array(1);

/**
 * The rigid slab (centre `cx`/`cz`, half extents `hx`/`hz`, rotated by `yaw`) at rest in the frame the masses' velocities are in: each
 * mass inside it is one kernel contact along the nearer face's normal (plastic, no friction, the slab kinematic) that takes the inbound
 * speed off the mass and moves it out by the whole depth. Returns the momentum the slab took (N·s). Without `ends` a mass never leaves round an end face.
 */
export function holdOnFace(d: DeformableCar["deform"], cx: number, cz: number, hx: number, hz: number, yaw: number, ends: boolean, topY = Infinity): number {
  const n = d.faceHits(cx, cz, hx, hz, yaw, ends, faceHits, faceWho, topY);
  if (n === 0) {
    holdDepth[0] = -Infinity;
    return 0;
  }
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
  holdDepth[0] = -Infinity;
  for (let i = 0; i < n; i++) holdDepth[0] = Math.max(holdDepth[0]!, faceHits[i * FACE_ROW + 4]!);
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
 * A striker's contact with a car, one physics slice. The contact begins before the overlap: active while the face is nearer the hull
 * than this slice's closing travel, so the hit starts at 0 depth. The particles are held on the face (`holdOnFace`) and, with `crush`,
 * the momentum exchange (`bodyContact`) is capped by the structure's crush force over the slice. `rigid` (closing no faster than
 * `CRASH.grazeMps`) makes every mass take the car's rigid motion. Returns the momentum (N·s) the car took off the striker along its travel.
 */
export function strikeCar(car: DeformableCar, box: ContactBox, dt: number, crush: boolean, arm = crush, rigid = false, topY = Infinity): number {
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
  let onset = false;
  // The hit's equivalent barrier speed is read before the face takes anything off the particles' speed.
  let armable = arm && closing > ARM_CLOSING && (box.fixed || !car.crashed);
  let barrierSpeed = 0;
  if (armable) {
    exchange(car, box, Math.max(0, overlap), 0);
    barrierSpeed = result[OUT_EBS_A]!;
    if (near) {
      onset = car.applyImpact(_p, _n, closing, barrierSpeed);
      armable = false;
    }
  }
  let taken = 0;
  let held = false;
  if (d.massActive) {
    d.markMotion();
    const ub = box.vx * fx + box.vz * fz;
    shiftVelocities(car, -fx * ub, -fz * ub);
    // The slab's thin axis (`holdOnFace` x) is the striker's travel.
    taken = holdOnFace(d, box.x, box.z, box.hz, box.hx, box.yaw - Math.PI / 2, !box.fixed || box.openEnds, topY);
    // A fixed solid narrower than the car (a palm between the bumpers) meets the crush hulls before any particle: hulls on the face
    // are a contact all the same, and the hit stays open (the quiet clock ran out while the hulls held the wreck off: an 8 m/s tap
    // read 0.016 m of block travel against the slab's 0). The hulls crush the particles (`feedOverlap`) until they are on the face.
    const hulled = box.fixed && overlap > 0.004 && closing > ARM_CLOSING;
    if (d.faceContacts > 0 || hulled) {
      held = true;
      bodyHit.touching = true;
      // A wreck coming back for another hit touches the face with its particles while its shrunken hulls are clear of it: the fresh hit
      // arms here (before the contact is marked: a re-arm needs the quiet time the wreck has had).
      if (armable) {
        d.takeMotion(car.velocity, car.angular);
        car.applyImpact(_p, _n, closing, barrierSpeed);
        d.markMotion();
      }
      if (crush || arm) d.notifyContact();
      // A fixed solid's hulls are fed as crush while they overlap it. A moving striker (piston head, press plate) feeds them only until
      // a particle reaches its face: then the structure's stroke (`exchange`) spends the hit, and feeding both crushes the corner twice
      // (wing 0.188 m against 0.029 m). A fixed solid no particle reaches (a 0.4 m arm tip between the bumper particles) has the hulls
      // alone to crush the nose: the tip's 0.409 m of block travel against the slab's 0.499 at 55 m/s.
      if (crush && overlap > 0 && (box.fixed || d.faceContacts === 0)) d.feedOverlap(_p, _n, overlap, closing, dt, 0, box.fixed && d.faceContacts === 0);
    }
    shiftVelocities(car, fx * ub, fz * ub);
    d.takeMotion(car.velocity, car.angular);
  }
  if (crush && held) {
    const ebs = Math.max(0, d.hitSpeedValue);
    // The arming slice starts the stroke at the masses' first touch, not at the slice's end: they (armed at the slice's start, `unstep`)
    // met the face earlier by the depth they are in then (`holdDepth`) and the slice's travel, so the grid cut does not move it. With no mass in, the hull's overlap reads it.
    const deepest = holdDepth[0]!;
    const inContact = onset && closing > 0 ? (deepest > -Infinity ? Math.max(0, dt + deepest / closing) : Math.min(dt, Math.max(0, dt + overlap / closing))) : dt;
    const maxJ = rigid ? Infinity : ((d.totalMass * ebs * ebs) / (2 * Math.max(0.05, d.hitStroke()))) * inContact;
    taken += exchange(car, box, Math.max(0, overlap), maxJ);
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
  out.yaw = detAtan2(car.fwdFlat.x, car.fwdFlat.z);
  out.vx = car.velocity.x;
  out.vz = car.velocity.z;
  out.kg = car.deform.totalMass;
  out.hardness = 1;
  return out;
}

/** cos 15°: how far off the car's axis a striker may run and still sweep a door/mirror lane. */
const PARALLEL = 0.966;

/**
 * Door and mirror colliders of `car` against `box`, both sides: only a striker's travel along the car moves a door or mirror (a
 * shut door struck square is body crush). A `fixed` solid shuts doors instead (`shutDoorsOnSolid`). The caller takes `du` off the striker along (`nx`, `nz`).
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
  // The box's car-frame bounds (its own axes: right (c, −s), forward (s, c)). Only a striker running along the car (within
  // `PARALLEL`) sweeps a lane; an angled one is a body hit.
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
    // Past the open door's trailing edge and the mirror cap: nothing to meet; inside the body's width is a body hit.
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
 * Car-car share of the contact model, once per slice per close pair: each body (as its cage's plan box) against the other's doors and
 * mirrors. Returns whether a door, mirror or panel met the other body: a sideswipe has no SAT contact and the highlight recorder keeps both cars.
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
