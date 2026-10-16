import * as THREE from "three";
import {
  leftoverCrumple,
  clampSpeed,
  crushGate,
  closingKeScale,
  crushStroke,
  hypot2,
} from "./physics-util.ts";
import { DeformState, ENGINE_PACK_GAP, PLANT_QUIET, TYRE_R } from "./deform-state.ts";
import { BodyFit } from "./body-fit.ts";
import { detSin, detCos, detAtan2, sinCosAt } from "../kernel/physics-core.js";
import { CONTACT_REF_SLICE, MIN_IMPACT_ZONE, MIN_INERTIA, MIN_MASS_SUM, SQUASH_REACH } from "./constants.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

/** Engine slack (m) a hit too slow to pack the nose still allows (mounts, not crush).
 *  This replaces the old first-hit ENGINE_LIGHT_CAP: the block's reach now
 *  follows the hit's own stroke, so car-car at 25 km/h each cannot grind it. */
export const ENGINE_SLACK = 0.04;
/** `stepStructure`'s frame when its caller gives none: level. */
const LEVEL = new THREE.Quaternion();
export const TYRE_HALF_W = 0.11;
/** Fastest (m/s) a wreck's body follows its cell's drift off its seat (`followGroup`): the nose's springback against a wall in 0.4 s, no faster than the pair pass's pushes. */
export const SEAT_SPEED = 1;
/** A mass this close (m) to a rigid face still counts as resting on it. */
const FACE_SKIN = 0.02;
/** A rear hit's stroke over the front's, beyond the cages' chassisRear / chassisFront ratio: 50 km/h reverse into the wall crushes the tail 0.6–1.0× the nose's 50 km/h front hit (barrier.test.ts), 0.57× at the bare 0.69 ratio. */
const REAR_STROKE_GAIN = 1.08;
/** Numbers per contact row of `faceHits`: x, z, nx, nz, depth. */
export const FACE_ROW = 5;

const _a = new THREE.Vector3();
/** followGroup's world→local: one invert per call, not one per mass (Object3D.worldToLocal). */
const _toLocal = new THREE.Matrix4();
/** Sim seconds the frame's tilt takes to level out on planting, or to come back on a new hit (followGroup):
 *  0.1 s, CR8's eased level-out (64 km/h head-on roof 0.61× its per-slice 3·v·h + 5 cm limit). */
const LEVEL_TIME = 0.1;
/** The masses' spin sums (`followGroup` resets and fills them). */
const _fit = new BodyFit();
/** `measurePose`'s angles in [pitch, _, roll, _, yaw, _], their [sin, cos] pairs out (`sinCosAt`: no boxed argument or result). */
const _sc = new Float64Array(6);
/** `moveRelative`'s per-mass mark: 1 for a mass that is not moving relative to the body this step (static, or settled to rest). */
const _settled = { mark: new Uint8Array(64) };
/** `markMotion`'s mass motion (x, y, z, spin) and `takeMotion`'s: a mark is always taken on the same car before another car's mark. */
const _marked = new Float64Array(4);
const _motionNow = new Float64Array(4);

/**
 * Contact: pair collision, the structure step, following the group, pose measurement, stroke, pushes and the impact entry.
 */
export abstract class DeformContact extends DeformState {
  /** Defined by a later layer. */
  protected abstract clampLocal(group: THREE.Object3D): void;
  abstract holdTurn(): void;
  protected abstract stepMassSlice(dt: number): void;
  abstract undoTurn(): void;
  protected abstract yawMomentum(slot: number, restore: boolean): void;

  /** One structure step of `dt`; `frame` is the car body's turn (its group's quaternion), level when not given. */
  stepStructure(dt: number, frame: THREE.Quaternion = LEVEL): void {
    if (!this.massActive) return;
    this.frameUp.set(0, 1, 0).applyQuaternion(frame);
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
      this.levelBounce();
    }
    this.shapeWasLive = this.shapeRan;
    this.updateDrivetrain();
    this.settleDrift(0, at);
  }

  /**
   * The body masses' vertical speeds on one plane over (x, z): the body's own motion, a roll or pitch included (its spin carries
   * `Car.integrateWreck` into every mass), is a plane; what the plane leaves is the masses' bounce against each other.
   */
  private levelBounce(): void {
    let cx = 0;
    let cz = 0;
    let vy = 0;
    let mass = 0;
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic || m.hub) continue;
      cx += m.world.x * m.mass;
      cz += m.world.z * m.mass;
      vy += m.vel.y * m.mass;
      mass += m.mass;
    }
    if (mass <= 0) return;
    cx /= mass;
    cz /= mass;
    vy /= mass;
    let sxx = 0;
    let sxz = 0;
    let szz = 0;
    let sxy = 0;
    let szy = 0;
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (!m.dynamic || m.hub) continue;
      const dx = m.world.x - cx;
      const dz = m.world.z - cz;
      const dy = m.vel.y - vy;
      sxx += m.mass * dx * dx;
      sxz += m.mass * dx * dz;
      szz += m.mass * dz * dz;
      sxy += m.mass * dx * dy;
      szy += m.mass * dz * dy;
    }
    const det = sxx * szz - sxz * sxz;
    const slopeX = det > 1e-12 ? (sxy * szz - szy * sxz) / det : 0;
    const slopeZ = det > 1e-12 ? (szy * sxx - sxy * sxz) / det : 0;
    for (let i = 0; i < this.masses.length; i++) {
      const m = this.masses[i]!;
      if (m.dynamic && !m.hub) m.vel.y = vy + slopeX * (m.world.x - cx) + slopeZ * (m.world.z - cz);
    }
  }

  /**
   * The masses' motion relative to the body (its velocity `v`, spin `w` about the world point `centre`) is the crush: it takes the
   * wreck's damping and moves them; the body's own motion is the rigid step's. The carry (`Car.integrateWreck`) turns each moved mass
   * by the body's turn `w`·`dt` with the body, so the move is turned back by it first: the mass lands where its relative velocity
   * took it, and a spinning wreck's angular momentum is not eaten by `|w|`·`dt`·Σ m|u|² a step.
   */
  moveRelative(dt: number, v: THREE.Vector3, w: THREE.Vector3, centre: THREE.Vector3): void {
    const quiet = this.quietTime();
    const powered = this.elapsed - this.lastPower < 0.1;
    let rate = 0.988;
    if (!this.drivetrainAlive && quiet > 0.12) {
      const t = Math.max(0, Math.min(1, (quiet - 0.12) / 1.8));
      const s = t * t * (3 - 2 * t);
      rate = (1 - s) * 0.96 + s * 0.18;
    }
    const damp = Math.pow(rate, dt);
    const fall = Math.pow(0.12, dt);
    const spin = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    const turn = spin * dt;
    const kx = spin > 1e-12 ? w.x / spin : 0;
    const ky = spin > 1e-12 ? w.y / spin : 0;
    const kz = spin > 1e-12 ? w.z / spin : 0;
    const c = detCos(turn);
    const s = detSin(turn);
    const ms = this.masses;
    if (_settled.mark.length < ms.length) _settled.mark = new Uint8Array(ms.length);
    const settledMark = _settled.mark;
    let free = 0;
    let lx = 0;
    let ly = 0;
    let lz = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]!;
      settledMark[i] = 1;
      if (!m.dynamic) continue;
      const rx = m.world.x - centre.x;
      const ry = m.world.y - centre.y;
      const rz = m.world.z - centre.z;
      const bx = v.x + w.y * rz - w.z * ry;
      const by = v.y + w.z * rx - w.x * rz;
      const bz = v.z + w.x * ry - w.y * rx;
      const x0 = m.vel.x - bx;
      const y0 = m.vel.y - by;
      const z0 = m.vel.z - bz;
      let ux = x0;
      let uy = y0;
      let uz = z0;
      if (uy < 0 && !m.hub) uy *= fall;
      ux *= damp;
      uy *= damp;
      uz *= damp;
      const settled = quiet > 2.4 && !powered && ux * ux + uy * uy + uz * uz < 0.08;
      if (settled) {
        ux = 0;
        uy = 0;
        uz = 0;
      }
      m.vel.set(ux, uy, uz);
      clampSpeed(m.vel);
      m.vel.x += bx;
      m.vel.y += by;
      m.vel.z += bz;
      const kd = kx * ux + ky * uy + kz * uz;
      // A planted hub in a squeeze stands at its pin in plan (`clampLocal`: rest + shove): the faces move it there only by the push it records
      // as shove (`pushMass`), so its own motion here would be undone by the clamp, a slice behind the face.
      const pinned = m.hub && !m.popped && !this.deepCrush && this.bidirectional;
      if (!pinned) m.world.x += (ux * c - (ky * uz - kz * uy) * s + kx * kd * (1 - c)) * dt;
      m.world.y += (uy * c - (kz * ux - kx * uz) * s + ky * kd * (1 - c)) * dt;
      if (!pinned) m.world.z += (uz * c - (kx * uy - ky * ux) * s + kz * kd * (1 - c)) * dt;
      if (!settled) {
        free += m.mass;
        settledMark[i] = 0;
      }
      lx += (ux - x0) * m.mass;
      ly += (uy - y0) * m.mass;
      lz += (uz - z0) * m.mass;
    }
    // The damping is internal: the mean of its change goes back to the masses still moving (a settled one stays at rest on the body), so
    // it never moves the body (`followGroup` reads its velocity off their mean).
    if (free > 0) {
      lx /= free;
      ly /= free;
      lz /= free;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i]!;
        if (settledMark[i] === 1) continue;
        m.vel.x -= lx;
        m.vel.y -= ly;
        m.vel.z -= lz;
        m.world.x -= lx * dt;
        m.world.y -= ly * dt;
        m.world.z -= lz * dt;
      }
    }
  }

  /**
   * The wreck's pose is its rigid body's (`Car.integrate`: `stepFree` on the cage) and the masses are carried by it (`moveRelative`,
   * `Car.integrateWreck`), and its velocity and spin are the body's own: contact impulses land on it (`shiftBody`, `markMotion`/`takeMotion`),
   * never read back off the masses. The masses are re-read into the group's frame (the crush state) and the clamp run. The body seats on
   * its cell no faster than `SEAT_SPEED` (still needed: without it the struck cell's springback leaves the frame off by the cabin's offset,
   * which reds the wall-bump, police-side and IIHS door rows): what the cell drifts from its seat the body follows, slowly.
   */
  followGroup(group: THREE.Object3D, velocityOut: THREE.Vector3, angularOut: THREE.Vector3, dt: number): void {
    this.bodyV = velocityOut;
    this.bodyW = angularOut;
    const cell = this.at.cell;
    this.measurePose();
    group.updateWorldMatrix(false, false);
    _toLocal.copy(group.matrixWorld).invert();
    _a.copy(cell.world).applyMatrix4(_toLocal);
    _a.set(_a.x - cell.rest.x, 0, _a.z - cell.rest.z);
    const off = _a.length();
    if (dt > 0 && off > 1e-9) {
      _a.multiplyScalar(Math.min(1, (dt * SEAT_SPEED) / off)).applyQuaternion(group.quaternion);
      // The seat steps in the body's x-z plane. Upright or on the roof that plane is (near) level and a tilted wreck's small vertical part is
      // its settle onto its cell: trimmed by its tilt's cos² a sedan missing two diagonal wheels crept 1.6 mm/s, cut whole a truck crept
      // 3.5 mm/s. On its side or nose the plane holds the world vertical and the step drove the wreck through the ground. So the vertical
      // part is kept by 1 - sin⁴ of the tilt: 1 - 6e-5 at 5°, nothing on the side, whole on the roof.
      const q = group.quaternion;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      const tilt = 1 - upY * upY;
      _a.y *= 1 - tilt * tilt;
      group.position.add(_a);
      group.updateWorldMatrix(false, false);
      _toLocal.copy(group.matrixWorld).invert();
    }
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      m.local.copy(m.world).applyMatrix4(_toLocal);
      this.hubStand[mi * 2] = m.local.x;
      this.hubStand[mi * 2 + 1] = m.local.z;
    }
    this.driftFrom();
    this.clampLocal(group);
    this.settleDrift(0, this.budgetAt());
    if (dt > 0) { this.keptTurn[3] = this.keptTurn[0]! / dt; this.keptTurn[0] = 0; } // prettier-ignore
    this.prevYaw = group.rotation.y;
  }

  /** The dynamic masses' mean velocity (`out` x, y, z) and the yaw spin their motion carries about their centroid (`out[3]`). */
  motion(out: Float64Array): void {
    const cell = this.at.cell;
    _fit.reset();
    let mx = 0;
    let my = 0;
    let mz = 0;
    let mass = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.dynamic) continue;
      mx += m.vel.x * m.mass;
      my += m.vel.y * m.mass;
      mz += m.vel.z * m.mass;
      mass += m.mass;
      _fit.addSpin(m.mass, m.world.x - cell.world.x, m.world.z - cell.world.z, m.vel.x, m.vel.z);
    }
    if (mass < MIN_MASS_SUM) {
      out.fill(0);
      return;
    }
    out[0] = mx / mass;
    out[1] = my / mass;
    out[2] = mz / mass;
    out[3] = _fit.spin();
  }

  /** Marks the masses' mean motion: `takeMotion` hands the body what contact work on them changed since. */
  markMotion(): void {
    this.motion(_marked);
  }

  /** The change of the masses' mean velocity and yaw spin since `markMotion`, added to the rigid body's `velocity` and `angular`. */
  takeMotion(velocity: THREE.Vector3, angular: THREE.Vector3): void {
    this.motion(_motionNow);
    velocity.x += _motionNow[0]! - _marked[0]!;
    velocity.y += _motionNow[1]! - _marked[1]!;
    velocity.z += _motionNow[2]! - _marked[2]!;
    angular.y += _motionNow[3]! - _marked[3]!;
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
    const pitch = Math.max(-0.2, Math.min(0.22, detAtan2(-fy, Math.max(yawLen, 0.15)))) * this.lean;
    const roll = Math.max(-0.5, Math.min(0.5, (engR.world.y - engL.world.y) * 0.55)) * this.lean;
    const tilt = Number.isFinite(pitch + roll);
    _sc[0] = tilt ? pitch : 0;
    _sc[2] = tilt ? roll : 0;
    sinCosAt(_sc, 0);
    sinCosAt(_sc, 2);
    const sp = _sc[0]!;
    const cp = _sc[1]!;
    const sr = _sc[2]!;
    const cr = _sc[3]!;
    const ax = (engL.local.x + engR.local.x) * 0.5 - axle.local.x;
    const ay = (engL.local.y + engR.local.y) * 0.5 - axle.local.y;
    const az = (engL.local.z + engR.local.z) * 0.5 - axle.local.z;
    const bx = ax * cr - ay * sr;
    const bz = (ax * sr + ay * cr) * sp + az * cp;
    const yaw = yawLen > 0.15 && hypot2(bx, bz) > 0.15 ? detAtan2(fx, fz) - detAtan2(bx, bz) : this.prevYaw;
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
    if (Number.isFinite(yaw)) {
      _sc[4] = yaw;
      sinCosAt(_sc, 4);
      p[1] = detAtan2(_sc[4]!, _sc[5]!);
    } else p[1] = this.prevYaw;
    p[2] = roll;
    p[3] = wx;
    p[4] = wy;
    p[5] = wz;
    p[6] = lx;
    p[7] = lz;
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
    const stroke = Math.min((0.5 + this.squash * SQUASH_REACH) * 1.1, crushStroke(Math.max(0, this.hitSpeed), this.squash));
    const out = this.strokeOut;
    if (Math.abs(ix) > Math.abs(iz)) out[0] = Math.min(this.at.doorL.bands.max, stroke);
    else if (iz <= 0) out[0] = stroke;
    else out[0] = stroke * REAR_STROKE_GAIN * (this.cageByPart.get("chassisRear")!.spec.maxCrush / this.cageByPart.get("chassisFront")!.spec.maxCrush);
  }

  /**
   * A contact's change of the body's motion (`bodyContact`'s increment): the whole body's velocity change (`dvx`, `dvz`) and yaw-rate
   * change `dw` about (`cx`, `cz`) go onto every dynamic mass as one rigid body (v += dv + dw × r). The part along the face's normal
   * (`nx`, `nz`) is carried by the masses still driving into the face, those moving along it slower than the face (`refVn`): a mass
   * held on the face is at rest on it and the face's impulse cannot reach it, so the driving masses carry the whole normal momentum
   * (dv scaled by the mass over their mass) and none is taken past the face's speed. The rigid body (`velocity`, `angular`) takes the
   * momentum and spin the masses took; what is left of them in the masses against it is the crush. Returns the normal momentum taken (N·s).
   */
  shiftBody(velocity: THREE.Vector3, angular: THREE.Vector3, dvx: number, dvz: number, dw: number, cx: number, cz: number, nx: number, nz: number, refVn: number): number {
    if (!this.massActive) return 0;
    let all = 0;
    let driving = 0;
    let inertia = 0;
    let sx = 0;
    let sz = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.dynamic) continue;
      all += m.mass;
      const rx = m.world.x - cx;
      const rz = m.world.z - cz;
      sx += m.mass * rx;
      sz += m.mass * rz;
      inertia += m.mass * (rx * rx + rz * rz);
      if (m.vel.x * nx + m.vel.z * nz < refVn) driving += m.mass;
    }
    const dvn = dvx * nx + dvz * nz;
    const push = driving > 1e-6 ? (dvn * all) / driving : 0;
    const tx = dvx - dvn * nx;
    const tz = dvz - dvn * nz;
    let taken = 0;
    let px = 0;
    let pz = 0;
    let spin = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.dynamic) continue;
      const vn = m.vel.x * nx + m.vel.z * nz;
      const cut = vn >= refVn ? 0 : Math.min(refVn - vn, push);
      const rx = m.world.x - cx;
      const rz = m.world.z - cz;
      const ux = tx + nx * cut + dw * rz;
      const uz = tz + nz * cut - dw * rx;
      m.vel.x += ux;
      m.vel.z += uz;
      taken += cut * m.mass;
      px += ux * m.mass;
      pz += uz * m.mass;
      spin += m.mass * (rz * ux - rx * uz);
    }
    if (all > 1e-6) {
      velocity.x += px / all;
      velocity.z += pz / all;
      inertia -= (sx * sx + sz * sz) / all;
      spin -= (sz * px - sx * pz) / all;
    }
    if (inertia > MIN_INERTIA) angular.y += spin / inertia;
    return taken;
  }

  /**
   * The contact rows of a rigid slab on the masses: every mass whose half-radius sphere is inside the box (centre cx/cz, half extents
   * hx/hz, rotated by yaw) leaves a row [x, z, nx, nz, depth] in `hits` (`FACE_ROW` apart; the mass's world point, the unit normal
   * out of the slab through the nearer of the car-side face or an end face, and the depth along it) and its index in `who`.
   * The slab's response is the caller's (`bodyContact` per row, then `pushMass`). Planted hubs are the world pin and are no row on a
   * one-sided hit (the car moves away from the face); squeezed (`bidirectional`) the car cannot, so the face meets the tyre and
   * shoves the hub (`pushMass`). Without `ends` a mass never leaves round an end face (a fixed wall's end is the joint to the next
   * panel, which would hold it in the wall): only by the car-side face. Returns the number of rows.
   */
  faceHits(cx: number, cz: number, hx: number, hz: number, yaw: number, ends: boolean, hits: Float64Array, who: Int32Array): number {
    if (!this.massActive) return 0;
    const rx = detCos(yaw);
    const rz = -detSin(yaw);
    const fx = detSin(yaw);
    const fz = detCos(yaw);
    const cell = this.at.cell;
    const side = (cell.world.x - cx) * rx + (cell.world.z - cz) * rz >= 0 ? 1 : -1;
    // Group yaw from the last followGroup: keeps `local` (and so crumpleTravelCorner,
    // which the slab clip reads) in step with the projected world positions.
    const gc = detCos(this.prevYaw);
    const gs = detSin(this.prevYaw);
    let n = 0;
    this.faceContacts = 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
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
      if (penX <= 0 || penZ <= 0 || n >= who.length) continue;
      const o = n * FACE_ROW;
      hits[o] = m.world.x;
      hits[o + 1] = m.world.z;
      if (penX <= penZ || !ends) {
        hits[o + 2] = rx * side;
        hits[o + 3] = rz * side;
        hits[o + 4] = penX;
      } else {
        const end = lz >= 0 ? 1 : -1;
        hits[o + 2] = fx * end;
        hits[o + 3] = fz * end;
        hits[o + 4] = penZ;
      }
      who[n++] = mi;
    }
    return n;
  }

  /** Move mass `mi` by (`dx`, `dz`) in the world and in the car's frame; a planted hub the face meets is shoved (`shoveHub`). */
  pushMass(mi: number, dx: number, dz: number): void {
    const m = this.masses[mi]!;
    const gc = detCos(this.prevYaw);
    const gs = detSin(this.prevYaw);
    m.world.x += dx;
    m.world.z += dz;
    m.local.x += dx * gc - dz * gs;
    m.local.z += dx * gs + dz * gc;
    if (m.hub && !m.popped && !this.deepCrush) this.shoveHub(m, dx, dz);
  }

  /**
   * A wreck resting on the face (the slab of `faceHits`, after its rows moved masses): the face moved its bumpers after this
   * call's clamp, so the packed nose shoves the block with it (clampLocal's pack rule, within the hit's reach). Without it a dead
   * wreck sat at 0.476 m nose gap after 52 + 35 km/h. Not while the cell still drives in: the face's transient push reached the
   * block and killed it in single 35–50 km/h hits.
   */
  packEngineBlock(cx: number, cz: number, yaw: number): void {
    const rx = detCos(yaw);
    const rz = -detSin(yaw);
    const cell = this.at.cell;
    const side = (cell.world.x - cx) * rx + (cell.world.z - cz) * rz >= 0 ? 1 : -1;
    const gc = detCos(this.prevYaw);
    const gs = detSin(this.prevYaw);
    const into = -(cell.vel.x * rx + cell.vel.z * rz) * side;
    if (into < 0.3 && !this.bidirectional && this.hitSpeed >= 0 && -this.impactInward.z > Math.abs(this.impactInward.x)) {
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
  }

  /**
   * Hull push (m) along the unit (nx, nz) this car may still take now, out of `amount` (`PushBudget`): one slice's
   * pairs and SAT passes, mass-sphere shifts and wall translations share one cap. `touchSpeed` is this car's own speed.
   */
  takePush(nx: number, nz: number, amount: number, dt: number, touchSpeed: number): number {
    if (touchSpeed > this.sliceTouch) this.sliceTouch = touchSpeed;
    return this.push.take(this.budgetAt(), nx, nz, amount, dt, touchSpeed);
  }

  /** The net translation (m) this slice's position corrections moved the wreck along the unit (nx, nz) so far (`PushBudget`). */
  pushedAlong(nx: number, nz: number): number {
    return this.push.along(this.budgetAt(), nx, nz);
  }

  /**
   * Push the passenger cell out of overlap. Crumple-zone masses stay on the contact plane so the leftover penetration
   * becomes plastic crush — only as far as the push runs into the struck end (impactInward). Across it, e.g. a derby
   * shove on the side of a car whose last hit was frontal, the lagging nose read as a turn of the engine→axle axis and
   * clampLocal turned the whole wreck with it, with no angular momentum (zips 2 → 0 in derby seed 1, 120 s). Positions
   * only: the uneven push changed Σ m r × v of a wreck whose nose and cabin move apart, and the next clamp kept it as
   * spin (derby seed 4 c0: −2.5 rad/s of L/I in 0.6 s of shoving), so the angular momentum is handed back. `dv` (m/s)
   * is the speed the push trades (`pushApart`): the car's mean speed changes by `dv`, so the masses that keep their place
   * (`keep` < 1) take a smaller share of it and the others a larger one, and the pair's momentum is what it was (the weights
   * alone moved `dv` × Σ m·keep / Σ m, up to 8 % of a T-bone's momentum gained in the shove). A push of nothing (the
   * slice's `takePush` budget spent: 87 % of a derby-32's pushes) moves nothing and returns.
   */
  separateAlong(nx: number, ny: number, nz: number, amount: number, dv = 0): void {
    if (!this.massActive || (amount === 0 && dv === 0)) return;
    this.yawMomentum(1, false);
    const gc = detCos(this.prevYaw);
    const gs = detSin(this.prevYaw);
    const into = Math.max(0, (nx * gc - nz * gs) * this.impactInward.x + (nx * gs + nz * gc) * this.impactInward.z);
    let all = 0;
    let kept = 0;
    if (dv !== 0) {
      for (let mi = 0; mi < this.masses.length; mi++) {
        const m = this.masses[mi]!;
        if (!m.dynamic) continue;
        all += m.mass;
        kept += m.mass * (1 - this.crumpleWeight(m) * 0.88 * into);
      }
    }
    const share = kept > 1e-9 ? (dv * all) / kept : 0;
    for (let mi = 0; mi < this.masses.length; mi++) {
      const m = this.masses[mi]!;
      if (!m.dynamic) continue;
      const keep = 1 - this.crumpleWeight(m) * 0.88 * into;
      m.world.x += nx * amount * keep;
      m.world.y += ny * amount * keep;
      m.world.z += nz * amount * keep;
      m.vel.x += nx * share * keep;
      m.vel.z += nz * share * keep;
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
   * to it (its side crushes) rather than the bullet's nose stopping dead against a car that gets no momentum. `whole`: the overlap is
   * all of the crush (a fixed solid no particle reaches, so no particle held on its face takes the rest), not the 0.4 + 0.35·squash share.
   */
  feedOverlap(worldPoint: THREE.Vector3, inward: THREE.Vector3, overlap: number, closing: number, dt = 1 / FRAME_HZ, refVn = 0, whole = false): number {
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
    const crush = Math.min(Math.max(0, overlap) * (whole ? 1 : 0.4 + s * 0.35) * ke, 0.06 + ke * 0.2) * Math.min(1, 0.35 * slice) * live;
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
      if (zone < MIN_IMPACT_ZONE) continue;
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
