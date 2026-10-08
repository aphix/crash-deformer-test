import * as THREE from "three";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import {
  leftoverCrumple,
  clampSpeed,
  CRASH,
  crushGate,
  closingKeScale,
  crushStroke,
  forceTransfer,
  hypot2,
} from "./physics-util.ts";
import { DeformState, ENGINE_PACK_GAP, HUB_FLOOR, PLANT_QUIET, TYRE_R } from "./deform-state.ts";
import { HubPlane } from "./hub-plane.ts";
import { BodyFit } from "./body-fit.ts";
import type { MassNode } from "./deform-rig.ts";
import type { StreamedDeformation } from "./streamed-deform.ts";

/** Engine slack (m) a hit too slow to pack the nose still allows (mounts, not crush).
 *  This replaces the old first-hit ENGINE_LIGHT_CAP: the block's reach now
 *  follows the hit's own stroke, so car-car at 25 km/h each cannot grind it. */
export const ENGINE_SLACK = 0.04;
/** Physics slice (s) the per-call contact shares (feedOverlap nibble and inbound-speed kill) are tuned at. */
const CONTACT_REF_SLICE = 1 / 240;
export const TYRE_HALF_W = 0.11;
/** Steel-on-steel sliding friction for car-car mass contacts (same μ as the hull contact in pair-contact). */
const SHEET_MU = 0.45;
/** Largest overlap (m) one car-car mass pair resolves per CONTACT_REF_SLICE (sphereHit). */
const SPHERE_STEP = 0.06;
/** Shortest sim time (s) a wreck's vertical-speed sample spans: just under the 1/240 s shortest slice (followGroup). */
const VY_SPAN = 0.004;
const DRIVE_TURN_HOLD = 1 / 30; // sim s a driven wreck's turn rate stays reported after `applyDrive` set it (followGroup)
/** A mass this close (m) to a rigid face still counts as resting on it. */
const FACE_SKIN = 0.02;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
/** sphereHit's sliding (tangential) relative velocity. */
const _t = new THREE.Vector3();
/** `sphereHit`'s mass-weighted shift (mass × m, x then z) of the pair's `a` side, then its `b` side: what `collideWith` debits from each car's `PushBudget`. */
const _shift = new Float64Array(4);
/** followGroup's world→local: one invert per call, not one per mass (Object3D.worldToLocal). */
const _toLocal = new THREE.Matrix4();
/** Sim seconds the frame's tilt takes to level out on planting, or to come back on a new hit (followGroup):
 *  0.1 s, CR8's eased level-out (64 km/h head-on roof 0.61× its per-slice 3·v·h + 5 cm limit). */
const LEVEL_TIME = 0.1;
const _plane = new HubPlane();
/** The masses' spin sums (`followGroup` resets and fills them). */
const _fit = new BodyFit();
/** The ground plane holds a wreck's tilt while its lowest hub is within this (m) of its `HUB_FLOOR`, and fades out over `PLANE_FADE` more: a wreck in flight has no ground under it to lie on. */
const PLANE_FADE_FROM = 0.05;
const PLANE_FADE = 0.25;
/** A wreck's middle this far (m) over its ground band, with a wheel off its ground, takes off (followGroup's `aloft`); one in flight lands on a wall's top only from within this far (plus its fall) under it. */
export const LIFT_OFF = 0.1;

const _boxA = new THREE.Box3();
const _boxB = new THREE.Box3();
/** `box` round `masses`, grown by their largest radius and a hair: masses of two cars whose boxes are apart cannot touch. */
function massBox(masses: readonly MassNode[], box: THREE.Box3): THREE.Box3 {
  box.makeEmpty();
  let r = 0;
  for (let i = 0; i < masses.length; i++) {
    box.expandByPoint(masses[i]!.world);
    r = Math.max(r, masses[i]!.radius);
  }
  return box.expandByScalar(r + 5e-10);
}

/** `slice` is the call's slice over CONTACT_REF_SLICE: the overlap and inbound shares are per-slice rates. */
function sphereHit(a: MassNode, b: MassNode, slice: number): void {
  _n.copy(b.world).sub(a.world);
  const dist = _n.length();
  const minD = a.radius + b.radius;
  if (dist >= minD || dist < 1e-6) return;
  _n.y *= 0.18;
  const nl = _n.length();
  if (nl < 1e-6) return;
  _n.multiplyScalar(1 / nl);
  const ima = a.dynamic ? 1 / a.mass : 0;
  const imb = b.dynamic ? 1 / b.mass : 0;
  const inv = ima + imb;
  if (inv < 1e-8) return;
  const crumple = a.crumple || b.crumple;
  const travelA = a.local.distanceTo(a.rest);
  const travelB = b.local.distanceTo(b.rest);
  const tA = forceTransfer(travelA, a.bands, travelA >= a.bands.max * 0.97);
  const tB = forceTransfer(travelB, b.bands, travelB >= b.bands.max * 0.97);
  const t = Math.min(tA, tB);
  // A rigid pair (cell on cell) resolves at most SPHERE_STEP per reference slice: in one call it resolved
  // a 0.15 m overlap and jumped the struck cell 0.15 m in 4.5 ms (a derby zip); the rest goes over the
  // next slices. Crumple pairs already take a per-slice share.
  const overlap = crumple ? (minD - dist) * (1 - Math.pow(1 - Math.max(0.28, t), slice)) : Math.min(minD - dist, SPHERE_STEP * slice);
  // Field arithmetic, not addScaledVector (the same sums): in a pile-up these calls ran out of line and boxed
  // their scale per call.
  if (a.dynamic) {
    const s = -overlap * (ima / inv);
    a.world.x += _n.x * s;
    a.world.y += _n.y * s;
    a.world.z += _n.z * s;
    _shift[0] += a.mass * _n.x * s;
    _shift[1] += a.mass * _n.z * s;
  }
  if (b.dynamic) {
    const s = overlap * (imb / inv);
    b.world.x += _n.x * s;
    b.world.y += _n.y * s;
    b.world.z += _n.z * s;
    _shift[2] += b.mass * _n.x * s;
    _shift[3] += b.mass * _n.z * s;
  }
  const rel = b.vel.dot(_n) - a.vel.dot(_n);
  if (rel < 0) {
    const e = crumple ? (t >= 0.97 ? 0.08 : 0) : 0.18;
    const absorb = 1 - Math.pow(1 - (crumple ? Math.max(0.12, t) : 0.55), slice);
    const j = (-(1 + e) * rel * absorb) / inv;
    // Coulomb friction: sheet metal scraping past sheet metal takes at most μ·j off the sliding velocity.
    _t.x = b.vel.x - a.vel.x + _n.x * -rel;
    _t.y = b.vel.y - a.vel.y + _n.y * -rel;
    _t.z = b.vel.z - a.vel.z + _n.z * -rel;
    const slide = _t.length();
    const jt = slide > 1e-6 ? Math.min(slide / inv, SHEET_MU * j) / slide : 0;
    if (a.dynamic) {
      const sn = -j * ima;
      const st = jt * ima;
      a.vel.x = a.vel.x + _n.x * sn + _t.x * st;
      a.vel.y = a.vel.y + _n.y * sn + _t.y * st;
      a.vel.z = a.vel.z + _n.z * sn + _t.z * st;
    }
    if (b.dynamic) {
      const sn = j * imb;
      const st = -jt * imb;
      b.vel.x = b.vel.x + _n.x * sn + _t.x * st;
      b.vel.y = b.vel.y + _n.y * sn + _t.y * st;
      b.vel.z = b.vel.z + _n.z * sn + _t.z * st;
    }
  }
}

/**
 * Contact: pair collision, the structure step, following the group, pose measurement, stroke, pushes and the impact entry.
 */
export abstract class DeformContact extends DeformState {
  /** Defined by a later layer (the turn guards are public: `collideWith` calls them on the other car too). */
  protected abstract clampLocal(group: THREE.Object3D): void;
  abstract holdTurn(): void;
  protected abstract stepMassSlice(dt: number): void;
  abstract undoTurn(): void;
  protected abstract yawMomentum(slot: number, restore: boolean): void;

  /** Sphere contact between two cars' masses for one physics slice of `dt` seconds; whether any mass of one met a mass of the other. */
  collideWith(other: StreamedDeformation, dt: number): boolean {
    if (this.quietTime() > 0.22 && other.quietTime() > 0.22) return false;
    const massesA = this.masses;
    const massesB = other.masses;
    const nA = massesA.length;
    const nB = massesB.length;
    const slice = dt / CONTACT_REF_SLICE;
    for (let i = 0; i < nA; i++) massesA[i]!.clipping = false;
    for (let j = 0; j < nB; j++) massesB[j]!.clipping = false;
    if (!massBox(massesA, _boxA).intersectsBox(massBox(massesB, _boxB))) return false;
    _shift.fill(0);
    let hit = false;
    // The pairs are solved one after another (each moves its masses before the next reads them), so their order is
    // part of the answer. Taken i-major (every pair of car A's mass 0, then 1, ...) two identical cars in a mirror
    // head-on did not crush alike: A's mass i met B's j before B's i met A's j, so the car first in the world's list
    // took the other's hits ahead of its own (180 km/h: noses 0.800 / 0.779 m, engine blocks 0.481 / 0.498 m). The
    // pairs go by their lower mass index first, (i, j) then (j, i): those two touch four different masses, so their
    // order changes nothing, and a mirror pair is visited at the same place whichever car is `this`.
    const n = Math.max(nA, nB);
    for (let lo = 0; lo < n; lo++) {
      for (let hi = lo; hi < n; hi++) {
        for (let side = 0; side < (lo === hi ? 1 : 2); side++) {
          const i = side === 0 ? lo : hi;
          const j = side === 0 ? hi : lo;
          if (i >= nA || j >= nB) continue;
          const a = massesA[i]!;
          const b = massesB[j]!;
          const dx = b.world.x - a.world.x;
          const dy = b.world.y - a.world.y;
          const dz = b.world.z - a.world.z;
          const minD = a.radius + b.radius;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= minD * minD) continue;
          if (!hit) {
            this.holdTurn();
            other.holdTurn();
            hit = true;
          }
          a.clipping = true;
          b.clipping = true;
          sphereHit(a, b, slice);
        }
      }
    }
    // The overlap push is positional: off the centroid it turned the car with no torque (derby seed 4
    // c9: 0.256 rad in 0.15 s). Its impulse already carries the turn a real contact gives.
    if (hit) {
      this.undoTurn();
      other.undoTurn();
      this.push.debit(this.budgetAt(), _shift[0]! / this.totalMass, _shift[1]! / this.totalMass);
      other.push.debit(other.budgetAt(), _shift[2]! / other.totalMass, _shift[3]! / other.totalMass);
      this.noteTouch(other);
    }
    return hit;
  }

  stepStructure(dt: number): void {
    if (!this.massActive) return;
    // Contact fed since the last call: latched in sim time so every slice of this call, and
    // every sub-call of a split frame, solves the same contact.
    if (this.overlapFrame) {
      this.overlapFrame = false;
      this.contactAt = this.elapsed;
    }
    const at = this.budgetAt();
    this.driftFrom();
    const wasLive = this.quietTime() < PLANT_QUIET;
    this.elapsed += dt;
    if (wasLive && !this.bidirectional && this.quietTime() >= PLANT_QUIET) this.seatHubs();
    const slices = Math.max(1, Math.min(4, Math.round(dt * 240)));
    const h = dt / slices;
    this.shapeRan = false;
    for (let s = 0; s < slices; s++) this.stepMassSlice(h);
    // The solver window closed this step: the shape the contacts left becomes every cluster's
    // rest (Sp folded in), so a later hit cannot spring earlier damage back. Nothing restores that
    // shape any more, so a body mass's vertical bounce relative to the others would drift on until
    // damped and freeze in as sag: the 40 km/h parity hit's block sank 63 mm under a car's nose but
    // 45 mm under the piston, whose contact (and so window) ran 0.12 s longer. The body moves as one.
    if (this.shapeWasLive && !this.shapeRan) {
      this.rebaseShapeRest();
      let vy = 0;
      let mass = 0;
      for (let i = 0; i < this.masses.length; i++) {
        const m = this.masses[i]!;
        if (m.dynamic && !m.hub) { vy += m.vel.y * m.mass; mass += m.mass; }
      }
      if (mass > 0) for (let i = 0; i < this.masses.length; i++) { const m = this.masses[i]!; if (m.dynamic && !m.hub) m.vel.y = vy / mass; }
    }
    this.shapeWasLive = this.shapeRan;
    this.updateDrivetrain();
    this.settleDrift(dt, at);
  }

  followGroup(group: THREE.Object3D, velocityOut: THREE.Vector3, angularOut: THREE.Vector3, dt: number): void {
    const cell = this.at.cell;
    const y0 = group.position.y;
    // leanAt is unset from arming to the first read: that read re-poses the frame from the masses.
    const first = this.leanAt === -Infinity;
    _fit.reset();
    this.measurePose();
    const pose = this.pose;
    const pitch = pose[0]!;
    const yawSafe = pose[1]!;
    const roll = pose[2]!;
    const wx = pose[3]!;
    const wy = pose[4]!;
    const wz = pose[5]!;
    const floor = pose[8]!;
    if (Number.isFinite(pitch + roll)) group.rotation.set(pitch, yawSafe, roll, "YXZ");
    else group.rotation.set(0, yawSafe, 0, "YXZ");
    // The cell's height over the frame's origin under the frame's own tilt. A wreck planted on level ground keeps the
    // rest height level (`pose[14]`); planted on a slope that read jumped the frame 3 cm at the plant switch of a wreck
    // pitched 12° on a ramp's top.
    let gy = pose[14] !== 0 ? cell.world.y - cell.rest.y : cell.world.y - _a.set(cell.local.x, cell.rest.y, cell.local.z).applyQuaternion(group.quaternion).y;
    // On its ground the frame keeps the body's middle in a band over the ground under the anchor (the body masses
    // carry no weight of their own: the hubs and that band hold the body up). Above the band nothing under the
    // middle holds it (in flight, or over a ramp's lip on its rear wheels): the frame follows the masses, which
    // fly (`aloft`: gravity on every mass, `stepMassSlice`). Clamping it there dropped a struck flying car, or a
    // wreck sliding off a lip, onto the ground in one call (1.85 → 0.08 m). It takes off only where its support fell
    // away: `LIFT_OFF` clear of the band with a wheel off its ground, the band's top that far under the frame's last
    // measured height (a crushed cell pushed up over four planted hubs stays clamped: switching there flipped road
    // wrecks between the rules, 2.3 m off a replay's record; a frontal hit or the compactor pushing the masses up off
    // a level road lofted the body 0.21–0.25 m). It lands back into the band, but not from inside a wall (`Ground.walls`; `LIFT_OFF`): a hit in flight starts it aloft.
    const was = this.aloft;
    this.aloft = false;
    let lift = 0;
    if (floor !== NO_FLOOR) {
      // The band's top over what holds the body up (`pose[11]`); its bottom stays the ground under the anchor, so
      // a hub on a higher edge (a ramp's side) never lifts the frame.
      const band = pose[11]! + (pose[9]! - floor > 0.5 ? 0.12 : 0.08);
      this.aloft = (gy > band || (was && activeGround().walls === true && floor - gy > LIFT_OFF + Math.max(0, -this.frameVy) * dt)) && (was || (gy > band + LIFT_OFF && pose[10] === 0 && band < this.frameY - LIFT_OFF));
      if (!this.aloft) gy = Math.max(floor, Math.min(band, gy));
      else if (!was) {
        // Leaving the ground: the masses sat off the frame the ground held, and the ground's lift never fed their
        // speed. They take the frame's height and its measured climb, so the body leaves on its path (off a
        // ramp's lip it dipped 4–7 cm and flew on 2.6 m/s off a 3.9 m/s face).
        lift = group.position.y - gy;
        gy += lift;
        for (let mi = 0; mi < this.masses.length; mi++) {
          const m = this.masses[mi]!;
          m.world.y += lift;
          if (m.vel.y < this.frameVy) m.vel.y = this.frameVy;
        }
      }
    }
    // The group's height clamp must not leak into the anchor's held x/z through the tilt (a ratchet):
    // solve the anchor's local y for that height so its x/z stay exactly held.
    _a.set(pose[6]!, 0, pose[7]!).applyQuaternion(group.quaternion);
    _b.set(0, 1, 0).applyQuaternion(group.quaternion);
    _a.addScaledVector(_b, (wy + lift - gy - _a.y) / _b.y);
    // A squeeze anchors on the cell too. Pinning the group at the world origin read a free car's travel
    // as crush: the caps (cell 0.12–0.72 m) held the cell near the origin while the shoved car moved on,
    // and fire("all")'s bumperFR sprang 0.50 → 0.02 m in the 0.25 s after the heads left.
    group.position.set(wx - _a.x, gy, wz - _a.z);
    group.updateWorldMatrix(false, false);
    _toLocal.copy(group.matrixWorld).invert();

    let mx = 0,
      mz = 0,
      mass = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      m.local.copy(m.world).applyMatrix4(_toLocal);
      this.hubStand[mi * 2] = m.local.x;
      this.hubStand[mi * 2 + 1] = m.local.z;
      mx += m.vel.x * m.mass;
      mz += m.vel.z * m.mass;
      mass += m.mass;
      _fit.addSpin(m.mass, m.world.x - cell.world.x, m.world.z - cell.world.z, m.vel.x, m.vel.z);
    }
    this.driftFrom();
    this.clampLocal(group);
    this.settleDrift(0, this.budgetAt());
    // Vertical speed, measured: the frame's rise over at least `VY_SPAN` of sim time (the SAT passes in between move it
    // too). The masses' own would not do: on the ground the band, not they, sets the frame's height, and a mass the
    // ground lifts keeps its old speed (a wreck at rest on the level read up to 4 m/s, one sliding up a ramp's face
    // 1.9 m/s against the face's 3.9). Over the 24 µs remainder of a frame it is noise: 0.2 mm of band jitter read
    // −9.9 m/s (a derby heat: 7 frames flagged by the 2 cm rule, vy down to −29 m/s). A slice is never shorter than
    // 1/240 s, so a span that short folds into the next call's.
    // A re-measure (a call that took no time: the SAT passes, a pair push; or the first read since arming) re-poses the
    // frame without the body moving: its shift is taken off the sample, not read as a speed (a tilted car pushed 0.15 m
    // moved its frame 0.35 m in one dt = 0 call, then read −55 m/s).
    const vySpan = this.elapsed - this.frameAt;
    if (dt > 0 && !first && vySpan >= VY_SPAN) {
      this.frameVy = (gy - this.frameY) / vySpan;
      this.frameY = gy;
      this.frameAt = this.elapsed;
    } else if (dt === 0 || first) this.frameY += gy - y0;
    velocityOut.set(mx / mass, this.frameVy, mz / mass);
    clampSpeed(velocityOut, CRASH.maxMassMps);
    // Spin: what the masses carry (L/I) plus a driven wreck's steer (`driveTurn`); the write-back's kept turn is a position
    // correction, so only `keptSpin` shows it. Never the frame's own turn. Field writes: set() boxed all three.
    angularOut.x = Math.max(-2, Math.min(2, pitch * 0.4));
    angularOut.y = _fit.spin() + (this.drivetrainAlive && this.elapsed - this.keptTurn[2]! < DRIVE_TURN_HOLD ? this.keptTurn[1]! : 0);
    if (dt > 0) { this.keptTurn[3] = this.keptTurn[0]! / dt; this.keptTurn[0] = 0; } // prettier-ignore
    angularOut.z = Math.max(-2, Math.min(2, roll * 0.4));
    this.prevYaw = yawSafe;
  }

  /** followGroup's measurements into `pose`: pitch, yaw, roll, the anchor's world x/y/z and body x/z, the
   *  ground under the anchor and the lowest hub, what holds the body up, and the slope tilt. Its own method, with
   *  no doubles in or out, so TurboFan inlines its `hypot2` and `Ground` calls: in followGroup they lost the
   *  inlining budget to the matrix calls, and each call left out boxed its doubles (~20 KB per race frame). */
  private measurePose(): void {
    const cell = this.at.cell;
    const engL = this.at.engineL;
    const engR = this.at.engineR;
    const axle = this.at.axleR;
    // Heading: the engine mid → axleR axis in world, minus the same axis's angle in the body frame
    // the masses were last clamped into (`local`), seen under the pitch and roll the frame is about to
    // take (YXZ: world = yaw · pitch · roll · local). Reading it against a fixed +z assumed that axis
    // never tilts in the body; an asymmetric crush holds it tilted there, so every call turned the
    // frame by the tilt and clampLocal wrote the turn back into world — up to ~1 rad per frame at a
    // dozen calls per frame (the "wreck spins on the spot" defect). Leaving the frame's own pitch and
    // roll out did the same with the tilt's yaw coupling (dump16 replay: Khaki 11.7 → 7.3 rad/s).
    const fx = (engL.world.x + engR.world.x) * 0.5 - axle.world.x;
    const fy = (engL.world.y + engR.world.y) * 0.5 - axle.world.y;
    const fz = (engL.world.z + engR.world.z) * 0.5 - axle.world.z;
    const yawLen = hypot2(fx, fz);
    let minHub = Infinity;
    // The attached hubs' ground (last slice's floors, once sampled since the masses armed): their mean, whether
    // every one is on it (within 3 cm of its `HUB_FLOOR` `groundMasses` holds it at), and the plane through it.
    let held = 1;
    let hubFloor = 0;
    let hubs = 0;
    let low = Infinity;
    const plane = _plane;
    plane.reset();
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.hub) continue;
      if (m.world.y < minHub) minHub = m.world.y;
      const f = this.floorPost[mi]!;
      if (m.popped || !this.floorsFresh || f === NO_FLOOR) continue;
      hubFloor += f;
      hubs++;
      if (m.world.y - f > HUB_FLOOR + 0.03) held = 0;
      low = Math.min(low, m.world.y - f);
      plane.add(m.world.x - cell.world.x, m.world.z - cell.world.z, f);
    }
    if (hubs === 0) held = 0;
    plane.fit(this.prevYaw, 1 - Math.max(0, Math.min(1, (low - HUB_FLOOR - PLANE_FADE_FROM) / PLANE_FADE)));
    const planePitch = plane.pitch;
    const planeRoll = plane.roll;
    // Pitch and roll stay absolute and clamped: they are re-read each call, never accumulated.
    const plant = !this.bidirectional && this.quietTime() > PLANT_QUIET;
    // A planted wreck levels out from 0.35 s quiet, to the ground plane under its hubs (the world's level on the
    // flat), and a hit tilts it back, each eased over LEVEL_TIME of sim time. Either switch in one call swung every
    // mass through the tilt: a stopped 64 km/h head-on's roof jumped 0.127 m in one slice (pitch −0.2 → 0), and a
    // parked derby wreck nudged back into play 0.069 m (pitch 0 → −0.08, derby seed 1, c6 at 27.12 s). Levelled
    // to the world's 0 on a slope, it sat 21° off a −21° road with its tail 48 cm under it.
    const ease = (this.elapsed - this.leanAt) / LEVEL_TIME;
    this.leanAt = this.elapsed;
    this.lean += Math.max(-ease, Math.min(ease, (plant && this.quietTime() >= 0.35 ? 0 : 1) - this.lean));
    const pitch = Math.max(-0.2, Math.min(0.22, Math.atan2(-fy, Math.max(yawLen, 0.15)))) * this.lean + planePitch * (1 - this.lean);
    const roll = Math.max(-0.5, Math.min(0.5, (engR.world.y - engL.world.y) * 0.55)) * this.lean + planeRoll * (1 - this.lean);
    const tilt = Number.isFinite(pitch + roll);
    const cp = Math.cos(tilt ? pitch : 0);
    const sp = Math.sin(tilt ? pitch : 0);
    const cr = Math.cos(tilt ? roll : 0);
    const sr = Math.sin(tilt ? roll : 0);
    const ax = (engL.local.x + engR.local.x) * 0.5 - axle.local.x;
    const ay = (engL.local.y + engR.local.y) * 0.5 - axle.local.y;
    const az = (engL.local.z + engR.local.z) * 0.5 - axle.local.z;
    const bx = ax * cr - ay * sr;
    const bz = (ax * sr + ay * cr) * sp + az * cp;
    const yaw = yawLen > 0.15 && hypot2(bx, bz) > 0.15 ? Math.atan2(fx, fz) - Math.atan2(bx, bz) : this.prevYaw;
    // Anchor: a planted wreck on its hubs, a live one on its cell — each at the world point where the
    // last clamp held it in the body (`local`), under the rotation the masses are about to be clamped
    // in. Anchoring on rest, or under a yaw-only frame, jumped the group (and every pinned hub) by the
    // cell's up-to-cap offset or by tilt × height at each plant switch, inside one dt = 0 call. A hub's point is where it
    // stood (`hubStand`), not its pin: a planted hub is never written back, so with the pins the anchor read each hub's
    // standing offset (0.1–0.5 m) and the set changing when one popped re-anchored the wreck by their difference.
    let wx = cell.world.x,
      wy = cell.world.y,
      wz = cell.world.z,
      lx = cell.local.x,
      lz = cell.local.z;
    if (plant) {
      let hubM = 0,
        hx = 0,
        hy = 0,
        hz = 0,
        hlx = 0,
        hlz = 0;
      for (let mi = 0; mi < this.masses.length; mi++) {
        const m = this.masses[mi]!;
        if (!m.hub || m.popped) continue;
        hx += m.world.x * m.mass;
        hy += m.world.y * m.mass;
        hz += m.world.z * m.mass;
        hlx += this.hubStand[mi * 2]! * m.mass;
        hlz += this.hubStand[mi * 2 + 1]! * m.mass;
        hubM += m.mass;
      }
      if (hubM > 1e-8) {
        wx = hx / hubM;
        wy = hy / hubM;
        wz = hz / hubM;
        lx = hlx / hubM;
        lz = hlz / hubM;
      }
    }
    const p = this.pose;
    p[0] = pitch;
    p[1] = Number.isFinite(yaw) ? Math.atan2(Math.sin(yaw), Math.cos(yaw)) : this.prevYaw;
    p[2] = roll;
    p[3] = wx;
    p[4] = wy;
    p[5] = wz;
    p[6] = lx;
    p[7] = lz;
    // The ground under the anchor (a course's hill or bridge deck; 0 on the flat pad; past the fleet disc's rim
    // none: the group follows the anchor down), and what holds the body up: that ground, or the hubs' mean ground
    // where that is higher, as a driven car stands on its axle chord. A wreck whose middle is over a gap or a
    // drop while its wheels are still on the deck (a stunt course's edge, a ramp's lip) stands there, not on the
    // ground below (it was clamped onto that ground, 1.2 m down in one call).
    const under = activeGround().heightAt(wx, wz, wy);
    p[8] = under;
    p[9] = minHub;
    p[10] = held;
    p[11] = under === NO_FLOOR || hubs === 0 ? under : Math.max(under, hubFloor / hubs);
    // The suspension hangs from the plane under the hubs at any lean: world-vertical rest offsets left a live car's
    // hubs on a side slope 0.16 m over the road on its high side while the low side sat on it, so after a 52 km/h
    // T-bone the cell sank 0.014 m (flat pad 0.106) and the nose sprang back 0.012 m (0.052).
    p[12] = planePitch;
    p[13] = planeRoll;
    p[14] = plant && planePitch === 0 && planeRoll === 0 ? 1 : 0;
  }

  /** Move the whole wreck, including planted hubs, so a bowl clip is not undone next frame. */
  translateMasses(dx: number, dz: number, dvx: number, dvz: number): void {
    this.push.debit(this.budgetAt(), dx, dz);
    for (const m of this.masses) {
      m.world.x += dx;
      m.world.z += dz;
      if (!m.dynamic) continue;
      m.vel.x += dvx;
      m.vel.z += dvz;
    }
  }

  /**
   * Crush length (m) this hit takes out of the struck end, from its
   * equivalent barrier speed: the crumple corner on a frontal, the door band
   * on a side hit, and (B4) the frontal stroke scaled by the chassisRear /
   * chassisFront cage ratio on a rear hit — softer, shorter tail.
   */
  hitStroke(): number {
    this.measureStroke();
    return this.strokeOut[0]!;
  }

  /** `hitStroke` into `strokeOut[0]`: clampLocal calls it out of line, and a returned double was boxed. */
  protected measureStroke(): void {
    const ix = this.impactInward.x;
    const iz = this.impactInward.z;
    const stroke = Math.min((0.5 + this.squash * 1.15) * 1.1, crushStroke(Math.max(0, this.hitSpeed), this.squash));
    const out = this.strokeOut;
    if (Math.abs(ix) > Math.abs(iz)) out[0] = Math.min(this.at.doorL.bands.max, stroke);
    else if (iz <= 0) out[0] = stroke;
    else out[0] = stroke * (this.cageByPart.get("chassisRear")!.spec.maxCrush / this.cageByPart.get("chassisFront")!.spec.maxCrush);
  }

  /**
   * Crush force from a face moving at `refVn` along its outward normal
   * (nx, nz): impulse `j` (N·s) comes off the masses still moving into it, as
   * one equal Δv, never past the face's speed. Relative motion is kept, so the
   * cabin keeps piling into the stopped nose. Returns the momentum taken (N·s).
   */
  brakeInbound(nx: number, nz: number, j: number, refVn = 0): number {
    if (!this.massActive || j <= 0) return 0;
    let moving = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (m.dynamic && m.vel.x * nx + m.vel.z * nz < refVn) moving += m.mass;
    }
    if (moving < 1e-6) return 0;
    const dv = j / moving;
    let taken = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.dynamic) continue;
      const vn = m.vel.x * nx + m.vel.z * nz - refVn;
      if (vn >= 0) continue;
      const cut = Math.min(-vn, dv);
      m.vel.x += nx * cut;
      m.vel.z += nz * cut;
      taken += cut * m.mass;
    }
    return taken;
  }

  /**
   * Rigid slab at mass level: a mass whose half-radius sphere is inside the
   * box (centre cx/cz, half extents hx/hz, rotated by yaw) goes back out
   * through the nearer of the car-side face or an end face and loses its
   * inbound speed there. Planted hubs are the world pin and stay put on a one-sided
   * hit (the car moves away from the face); squeezed (`bidirectional`) the car
   * cannot, so the face meets the tyre and shoves the hub (`shoveHub`).
   * Returns the momentum taken out (N·s) for the caller to hand to the slab. Without `ends` a mass never leaves round an end
   * face (a fixed wall's end is the joint to the next panel, which would hold it in the wall): only by the car-side face.
   */
  projectOutOfBox(cx: number, cz: number, hx: number, hz: number, yaw: number, ends = true): number {
    if (!this.massActive) return 0;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const cell = this.at.cell;
    const side = (cell.world.x - cx) * rx + (cell.world.z - cz) * rz >= 0 ? 1 : -1;
    // Group yaw from the last followGroup: keeps `local` (and so crumpleTravelCorner,
    // which the slab clip reads) in step with the projected world positions.
    const gc = Math.cos(this.prevYaw);
    const gs = Math.sin(this.prevYaw);
    let removed = 0;
    let moved = false;
    this.faceContacts = 0;
    for (const m of this.masses) {
      const planted = m.hub && !m.popped;
      // Planted hubs pin the wreck on a one-sided hit; a squeeze (`bidirectional`) or a face past the wheel
      // centres (`deepCrush`) meets the tyres.
      if (!m.dynamic || (planted && !this.bidirectional && !this.deepCrush)) continue;
      const ox = m.world.x - cx;
      const oz = m.world.z - cz;
      let r = m.radius * 0.5;
      let rEnd = r;
      if (planted) {
        // The face meets the tyre: its tread (TYRE_R) along the car, its sidewall across it.
        r = hypot2(TYRE_HALF_W * (rx * gc - rz * gs), TYRE_R * (rx * gs + rz * gc));
        rEnd = hypot2(TYRE_HALF_W * (fx * gc - fz * gs), TYRE_R * (fx * gs + fz * gc));
      }
      const lz = ox * fx + oz * fz;
      const penX = hx + r - (ox * rx + oz * rz) * side;
      const penZ = hz + rEnd - Math.abs(lz);
      if (penZ > 0 && penX > -FACE_SKIN) this.faceContacts++;
      if (penX <= 0 || penZ <= 0) continue;
      let nx: number;
      let nz: number;
      let pen: number;
      if (penX <= penZ || !ends) {
        nx = rx * side;
        nz = rz * side;
        pen = penX;
      } else {
        const end = lz >= 0 ? 1 : -1;
        nx = fx * end;
        nz = fz * end;
        pen = penZ;
      }
      const dx = nx * pen;
      const dz = nz * pen;
      m.world.x += dx;
      m.world.z += dz;
      m.local.x += dx * gc - dz * gs;
      m.local.z += dx * gs + dz * gc;
      moved = true;
      if (planted && !this.deepCrush) this.shoveHub(m, dx, dz);
      const vn = m.vel.x * nx + m.vel.z * nz;
      if (vn < 0) {
        m.vel.x -= nx * vn;
        m.vel.z -= nz * vn;
        removed -= vn * m.mass;
      }
    }
    // A wreck resting on the face: the face moved its bumpers after this call's clamp, so the packed nose
    // shoves the block with it (clampLocal's pack rule, within the hit's reach). Without it a dead wreck sat
    // at 0.476 m nose gap after 52 + 35 km/h. Not while the cell still drives in: the face's transient push
    // reached the block and killed it in single 35–50 km/h hits.
    const into = -(cell.vel.x * rx + cell.vel.z * rz) * side;
    if (moved && into < 0.3 && !this.bidirectional && this.hitSpeed >= 0 && -this.impactInward.z > Math.abs(this.impactInward.x)) {
      const front = Math.min(this.at.bumperFL.local.z, this.at.bumperFR.local.z) - ENGINE_PACK_GAP;
      const crumple = Math.min(this.at.bumperFL.rest.z, this.at.bumperFR.rest.z) - Math.max(this.at.engineL.rest.z, this.at.engineR.rest.z) - ENGINE_PACK_GAP;
      const reach = Math.max(ENGINE_SLACK, this.hitStroke() - crumple);
      for (const m of [this.at.engineL, this.at.engineR]) {
        const back = Math.min(m.local.z - front, m.local.z - (m.rest.z - reach));
        if (back <= 0) continue;
        m.local.z -= back;
        m.world.x -= gs * back;
        m.world.z -= gc * back;
      }
    }
    return removed;
  }

  /**
   * Hull push (m) along the unit (nx, nz) this car may still take now, out of `amount` (`PushBudget`): one slice's
   * pairs and SAT passes, mass-sphere shifts and wall translations share one cap. `touchSpeed` is the faster of
   * the two touching cars.
   */
  takePush(nx: number, nz: number, amount: number, dt: number, touchSpeed: number): number {
    if (touchSpeed > this.sliceTouch) this.sliceTouch = touchSpeed;
    return this.push.take(this.budgetAt(), nx, nz, amount, dt, touchSpeed);
  }

  /**
   * Push the passenger cell out of overlap. Crumple-zone masses stay on the contact plane so the leftover penetration
   * becomes plastic crush — only as far as the push runs into the struck end (impactInward). Across it, e.g. a derby
   * shove on the side of a car whose last hit was frontal, the lagging nose read as a turn of the engine→axle axis and
   * clampLocal turned the whole wreck with it, with no angular momentum (zips 2 → 0 in derby seed 1, 120 s). Positions
   * only: the uneven push changed Σ m r × v of a wreck whose nose and cabin move apart, and the next clamp kept it as
   * spin (derby seed 4 c0: −2.5 rad/s of L/I in 0.6 s of shoving), so the angular momentum is handed back. `dv` (m/s)
   * is the speed the push trades (`pushApart`), added to the same masses by the same weights. A push of nothing (the
   * slice's `takePush` budget spent: 87 % of a derby-32's pushes) moves nothing and returns.
   */
  separateAlong(nx: number, ny: number, nz: number, amount: number, dv = 0): void {
    if (!this.massActive || (amount === 0 && dv === 0)) return;
    this.yawMomentum(1, false);
    const gc = Math.cos(this.prevYaw);
    const gs = Math.sin(this.prevYaw);
    const into = Math.max(0, (nx * gc - nz * gs) * this.impactInward.x + (nx * gs + nz * gc) * this.impactInward.z);
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.dynamic) continue;
      const keep = 1 - this.crumpleWeight(m) * 0.88 * into;
      m.world.x += nx * amount * keep;
      m.world.y += ny * amount * keep;
      m.world.z += nz * amount * keep;
      m.vel.x += nx * dv * keep;
      m.vel.z += nz * dv * keep;
    }
    this.yawMomentum(1, true);
  }

  /** Kill incoming speed on the cabin only — crumple zones keep their inertia. */
  kickCore(nx: number, ny: number, nz: number, dv: number): void {
    if (!this.massActive || dv === 0) return;
    for (const m of this.masses) {
      if (!m.dynamic) continue;
      const w = 1 - this.crumpleWeight(m);
      if (w < 0.08) continue;
      m.vel.x += nx * dv * w;
      m.vel.y += ny * dv * w;
      m.vel.z += nz * dv * w;
    }
  }

  crumpleTravel(): number {
    const cell = this.at.cell;
    const nose = (this.at.bumperFL.local.z + this.at.bumperFR.local.z) * 0.5;
    const tail = (this.at.bumperRL.local.z + this.at.bumperRR.local.z) * 0.5;
    return Math.max(nose - cell.local.z - 0.36, cell.local.z - tail - 0.36, 0);
  }

  /**
   * The least `crumpleTravelCorner` of this hit, for the slab's cabin floor (`clipCarToBarrier`). A floor read
   * off the current length moved out as the nose sprang back off the face, pushed the cabin out, and the push
   * (`separateAlong`) stretched the nose further: a loop that ran away in slow motion only, where the corner
   * springs back faster per sim second (64 km/h 40 % offset: R nose 0.330 → 0.255 within 7 ms of sim time).
   */
  slabTravel(): number {
    const travel = this.crumpleTravelCorner();
    if (travel < this.cornerLow) this.cornerLow = travel;
    return this.cornerLow;
  }

  /**
   * Remaining crumple on the most-crushed corner of the struck end — SAT
   * bounce and the slab clip use this so a hit actually spends the zone.
   * (Taking the max over both ends read the untouched end on every hit.)
   * Both ends are measured from the car origin, not the cell (which sits
   * `cell.rest.z` ahead of it): from the cell a mint tail read 0.12 m longer
   * than a mint nose, the slab clip saw a full zone until 0.26 m of tail
   * crush and stopped a 50 km/h reverse hit at 0.23 m.
   */
  crumpleTravelCorner(): number {
    const cell = this.at.cell;
    if (this.impactInward.z > 0) {
      const lag = 0.36 + 2 * cell.rest.z;
      const rl = cell.local.z - this.at.bumperRL.local.z - lag;
      const rr = cell.local.z - this.at.bumperRR.local.z - lag;
      return Math.max(Math.min(rl, rr), 0);
    }
    const fl = this.at.bumperFL.local.z - cell.local.z - 0.36;
    const fr = this.at.bumperFR.local.z - cell.local.z - 0.36;
    return Math.max(Math.min(fl, fr), 0);
  }

  kickAlong(nx: number, ny: number, nz: number, dv: number): void {
    this.kickCore(nx, ny, nz, dv);
  }

  /**
   * Contact crush from a face pressing in along `inward`. `refVn` is the face's speed along `inward`: a
   * fixed slab's 0, or a car-car pair's common velocity, so the struck car's contact masses are driven
   * to it (its side crushes) rather than the bullet's nose stopping dead against a car that gets no momentum.
   */
  feedOverlap(worldPoint: THREE.Vector3, inward: THREE.Vector3, overlap: number, closing: number, dt = 1 / 60, refVn = 0): number {
    if (!this.massActive) return closing;
    this.overlapFrame = true;
    const leftover = leftoverCrumple(this.crumpleTravel());
    const s = this.squash;
    const live = s < 0.03 ? 0 : 1;
    const ke = closingKeScale(closing);
    const absorbFrac = leftover * (0.5 + s * 0.42) * live;
    const eaten = Math.max(0, closing) * absorbFrac;
    // Per-call shares are tuned at the engine's 1/240 s slice; scale them to the slice actually
    // taken so slow motion (1/1875 s slices, 8× the calls per sim second) crushes the same.
    const slice = dt / CONTACT_REF_SLICE;
    // Overlap becomes local crush. Amount tracks ½mv², never (overlap/dt) velocity.
    const crush = Math.min(Math.max(0, overlap) * (0.4 + s * 0.35) * ke, 0.06 + ke * 0.2) * Math.min(1, 0.35 * slice) * live;
    if (crush < 1e-5 && eaten < 1e-5) return closing;
    this.impulse = Math.max(this.impulse, THREE.MathUtils.clamp(closing, 0, 70));

    const cell = this.at.cell;
    const nose = (this.at.bumperFL.local.z + this.at.bumperFR.local.z) * 0.5;
    const tail = (this.at.bumperRL.local.z + this.at.bumperRR.local.z) * 0.5;
    const noseLeft = Math.max(0, nose - cell.local.z - 0.38);
    const tailLeft = Math.max(0, cell.local.z - tail - 0.38);
    const bumperLeft = THREE.MathUtils.clamp(Math.max(noseLeft, tailLeft) / 1.45, 0, 1);
    const passFront = this.frontTransfer();

    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.dynamic) continue;
      if (m.hub && !m.popped && !this.deepCrush) continue;
      const zone = this.impactWeight(m);
      if (zone < 0.04) continue;
      const d = m.world.distanceTo(worldPoint);
      const reach = 1.05 + s * 0.35;
      if (d > reach) continue;
      const fall = (1 - d / reach) ** 2 * zone;
      const soft = m.softness;
      const gate = this.bidirectional ? 1 : crushGate(closing, soft) * live;
      if (gate < 1e-4) continue;
      const engine = m.name === "engineL" || m.name === "engineR";
      const engineGate = engine ? (bumperLeft > 0.55 ? 0.4 : 1) : 1;
      const pass = this.crumpleWeight(m) < 0.45 ? passFront : 1;
      const posNibble = crush * fall * gate * soft * engineGate * pass;
      m.world.addScaledVector(inward, posNibble);
      const vn = m.vel.dot(inward) - refVn;
      // Plastic: kill inbound speed relative to the face. Never add (crush/dt) — that rockets in slomo.
      if (vn < 0) m.vel.addScaledVector(inward, -vn * (1 - Math.pow(1 - Math.min(1, fall * 0.85 + gate * 0.15), slice)));
    }
    return Math.max(0, closing - eaten);
  }

  applyImpact(localPoint: THREE.Vector3, localInward: THREE.Vector3, impulse: number): void {
    this.impactLocal.copy(localPoint);
    this.impactInward.copy(localInward).normalize();
    const clamped = THREE.MathUtils.clamp(impulse, 4, 70);
    if (this.hitSpeed < 0) this.hitSpeed = clamped;
    this.impulse = clamped;
    this.crushing = true;
    this.dirty = true;
  }
}
