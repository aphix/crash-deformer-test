import * as THREE from "three";
import type { DeformNetState } from "../deform/streamed-deform.ts";
import { applyGroundFriction, CRASH, hypot2 } from "../deform/physics-util.ts";
import { CAR_HALF, DOOR, WHEEL_POS } from "./car-mesh.ts";
 import { activeGround, DISC_GROUND, FLAT_GROUND, NO_FLOOR } from "../world/ground.ts";
import { CarParts } from "./car-parts.ts";
import { END_WINDOW, type PartNetState, REARM_QUIET_S, type WorldBounce } from "./car-core.ts";
import { COM_Y, hullClear, stepAir, SUPPORT } from "./car-air.ts";
import { droop, Suspension, UNDERSIDE } from "./car-suspension.ts";
import { AXLE, axleGround, landPose, settle, support, tilt, type Support } from "./car-support.ts";
import { carClass, CLASSES } from "./vehicle-classes.ts";
import { clearDents } from "./loose-dent.ts";
import type { CarSurfaces } from "./car-surfaces.ts";

export { CAR_HALF, DOOR, WHEEL_POS };
export type { Hull } from "../deform/hulls.ts";

const _qSpin = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _in = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _gn = new THREE.Vector3();
const _gnBack = new THREE.Vector3();
const _rest = { y: 0 };
const _fallC = new THREE.Vector3();
const _fallV = new THREE.Vector3();
const _fallR = new THREE.Vector3();
const G = 9.6;
const _sup: Support = { y: 0, grade: NaN };
/** Doubles in a `DeformableCar.flight` block; from `FLIGHT_POSE` its pitch, yaw, roll, velocity and position. */
export const FLIGHT = 22;
export const FLIGHT_POSE = 8;
/** Rate (1/s) a wreck's body eases onto its ground clearance (`seatBody`), and most (m) it is stood up for its underside (a hollow deeper is a wall). */
const HULL_LIFT_RATE = 12;
const HULL_LIFT_MAX = 0.2;
const _q0 = new THREE.Quaternion();

export class DeformableCar extends CarParts {
  /** No wheel on the ground: a rigid body in flight or tumbling (`stepAir`); drive and grip are off. */
  airborne = false;
  /** The world's other-car tops this body can stand on in flight (`stepWorld` sets it; null: the world's ground alone). */
  surfaces: CarSurfaces | null = null;
  /** While airborne: the car whose top carries this one (`CarSurfaces.commit`), whose plan the SAT must not shove it off. */
  restsOn: DeformableCar | null = null;
  /** While airborne: a face of this body (or of the car under it) is yielding to its load this slice (`CarSurfaces.commit`). */
  yielding = false;
  /** While airborne: some hull point is on the ground this slice. */
  airContact = false;
  /** A hard hit is about to land: this car is closing on a fixed solid (the course's collide pass) or on another car (`markApproaches`), within a step or two of travel of it, or driving into it. Not state: derived again every step, read by `stepWorld` to cut the step. */
  nearHit = false;
  /** The body's turn (world rad/s) over its last grounded slice, carried into the air at a takeoff. */
  private readonly groundSpin = new THREE.Vector3();
  /** The slice (s) `stepAir` moved this body in the slice under way; 0 once that slice's masses have stepped (`afterContacts`). */
  private flewDt = 0;
  /** The body's springs over its wheels (drawn only: the physics frame stays on the ground pose). */
  readonly suspension = new Suspension();
  /** A wreck's drawn body stood up off its frame (m) so its underside clears the ground (`seatBody`); 0 on any other car. */
  private hullLift = 0;
  private classBody: THREE.Object3D | null = null;

  spawn(x: number, z: number, speed: number): void {
    this.resetVisual();
    this.group.position.set(x, 0, z);
    this.group.lookAt(0, 0, 0);
    this.refreshBasis();
    this.placeAt(x, z, Math.atan2(this.forward.x, this.forward.z), speed, this.forward);
  }

  spawnFacing(x: number, z: number, yaw: number, speed: number): void {
    this.resetVisual();
    this.placeAt(x, z, yaw, speed, this.fwdFlat);
  }

  /** Upright at (x, z) facing `yaw`, moving at `speed` along `dir` (`forward` or `fwdFlat`, read after the basis refresh). */
  private placeAt(x: number, z: number, yaw: number, speed: number, dir: THREE.Vector3): void {
    this.placements++;
    this.yaw = yaw;
    this.group.position.set(x, 0, z);
    this.group.rotation.set(0, yaw, 0, "YXZ");
    this.roll = 0;
    this.pitch = 0;
    this.speed = speed;
    this.spawnSpeed = speed;
    this.crashed = false;
    this.airborne = false;
    if (this.classBody) this.classBody.position.y -= this.hullLift;
    this.hullLift = 0;
    this.suspension.reset();
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(dir).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
    this.settleCasters();
  }

  resetVisual(): void {
    this.vaporized = false;
    this.falling = false;
    this.driverOut = null;
    this.fallSpin.set(0, 0, 0);
    this.group.scale.setScalar(1);
    this.deform.reset();
    // Before the rest restores below: a dent's saved copy may be a crumpled skin the rest restore then overwrites.
    for (const p of this.parts) clearDents(p.dent);
    this.deform.restoreRest(this.body.geometry);
    this.restoreRest(this.hood.geometry, this.hoodRest);
    this.restoreRest(this.trunk.geometry, this.trunkRest);
    this.restoreRest(this.doorMeshL.geometry, this.doorLRest);
    this.restoreRest(this.doorMeshR.geometry, this.doorRRest);
    if (this.lightBar) this.restoreRest(this.lightBar.geometry, this.lightBarRest!);
    this.wheelSpin.fill(0);
    this.wheelRate.fill(0);
    this.airThrottle = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const loose = this.looseWheels[i]!;
      if (loose.loose) {
        this.world.remove(w);
        this.group.add(w);
        loose.loose = false;
        loose.velocity.set(0, 0, 0);
        loose.angular.set(0, 0, 0);
      }
      const rest = WHEEL_POS[i]!;
      w.position.set(rest[0], rest[1], rest[2]);
      w.rotation.set(0, 0, 0);
      w.visible = true;
    }
    this.bodyMat.roughness = 0.42;
    this.group.rotation.set(0, 0, 0);
    this.interior.scale.set(1, 1, 1);
    this.interior.position.set(0, 0, 0);

    this.endAgo.fill(9);
    this.endReach = Infinity;
    this.endSqueeze = false;
    for (const p of this.parts) {
      if (p.detached) {
        this.world.remove(p.object);
        if (p.name === "mirrorL") this.doorL.add(p.object);
        else if (p.name === "mirrorR") this.doorR.add(p.object);
        else if (!p.region) this.group.add(p.object);
      }
      if (p.region) this.closePanel(p);
      p.detached = false;
      p.folding = false;
      p.hingeT = 0;
      p.hingeMax = 1;
      p.fatigue = 0;
      if (p.swing) {
        p.swing.theta = 0;
        p.swing.omega = 0;
        p.swing.latched = true;
        p.swing.load = 0;
        p.swing.mirrorFold = 0;
      }
      p.object.position.copy(p.restPos);
      p.object.quaternion.copy(p.restQuat);
      p.object.rotation.set(0, 0, 0);
      p.object.scale.set(1, 1, 1);
      p.object.visible = true;
      p.velocity.set(0, 0, 0);
      p.angular.set(0, 0, 0);
    }
    this.resetWear();
    for (const g of this.glassPanes) this.resetGlass(g);
    this.resetLamps();
  }
  /**
   * `impulse` is the closing speed (FX, glass); `ebs` the equivalent barrier speed that sizes the crush.
   * The first hit starts the crash; on a wreck a fresh, hard enough contact re-arms a new hit (`rearmHit`).
   */
  applyImpact(worldPoint: THREE.Vector3, worldInward: THREE.Vector3, impulse: number, ebs: number): void {
    const inFlight = this.airborne;
    if (inFlight) {
      // A body in flight (`stepAir`) takes the hit on its masses: its centre's velocity carried to the group's
      // origin, as `land` does, and a wreck's masses keep their dents. Its masses fly it on (`syncPose`) and
      // hand it back to `stepAir` once their contact window closes; left airborne, nothing ever landed it and
      // its drive stayed idled (8 s, stopped, on the stunt course).
      this.airborne = false;
      this.velocity.sub(_v.crossVectors(this.angular, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion)));
      if (this.crashed) {
        this.deform.armMasses(this.group, this.velocity, this.angular);
        this.deform.unstep(this.flewDt);
        this.deform.aloft = true;
      }
    }
    const localP = this.worldToLocalPoint(worldPoint, _p);
    _in.copy(worldInward);
    _in.y = 0;
    _v.copy(this.group.position).sub(worldPoint);
    _v.y = 0;
    if (_v.lengthSq() > 1e-8) {
      _v.normalize();
      if (_in.dot(_v) < 0) _in.negate();
    }
    const localN = this.worldToLocalDir(_in, _n);
    const rough = Math.min(0.82, 0.42 + impulse * 0.012);
    if (this.crashed && this.deform.massActive) {
      if (!this.deform.rearmHit(localP, localN, impulse, ebs)) return;
      this.bodyMat.roughness = Math.max(this.bodyMat.roughness, rough);
    } else {
      this.crashed = true;
      this.ride(0);
      this.deform.beginCrush(localP, localN, impulse, ebs, this.group, this.velocity, this.angular);
      if (inFlight) {
        this.deform.unstep(this.flewDt);
        this.deform.aloft = true;
      }
      this.bodyMat.roughness = rough;
    }
    this.deform.impulseAt(worldPoint, _in, impulse);
  }

  syncPose(dt: number): void {
    this.deform.followGroup(this.group, this.velocity, this.angular, dt);
    this.yaw = this.group.rotation.y;
    this.roll = this.group.rotation.z;
    this.pitch = this.group.rotation.x;
    // A wreck whose middle is off the ground (`aloft`) and whose hull is clear of it flies as a rigid body
    // (`stepAir`) once its contact window closes, fitted to its masses' motion; until then its masses fly it (a hit
    // in flight still crumples, a wreck over a lip pivots on its last wheels and one coming down lands on them).
    if (dt > 0 && this.deform.aloft && !this.deform.live() && hullClear(this)) {
      fitMasses(this, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion).add(this.group.position), this.angular);
      this.deform.massActive = false;
      this.airborne = true;
    }
    this.refreshBasis();
  }

  /**
   * Highlight keyframes (docs/HIGHLIGHTS.md): what a netplay pose rounds or leaves out, `FLIGHT` doubles into `buf` at `o`,
   * or with `write` from it: airborne and a hull point on the ground, the spins, the pose, velocity and position whole (the
   * wire rounds them: a first impact 0.5 m/s off), the squeeze clocks and the drift state. A float32 here moved wrecks.
   */
  flight(buf: Float64Array, o: number, write: boolean): void {
    if (write) {
      this.airborne = buf[o] !== 0;
      this.airContact = buf[o + 1] !== 0;
      this.angular.fromArray(buf, o + 2);
      this.groundSpin.fromArray(buf, o + 5);
      this.pitch = buf[o + FLIGHT_POSE]!;
      this.yaw = buf[o + FLIGHT_POSE + 1]!;
      this.roll = buf[o + FLIGHT_POSE + 2]!;
      this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
      this.velocity.fromArray(buf, o + FLIGHT_POSE + 3);
      this.group.position.fromArray(buf, o + FLIGHT_POSE + 6);
      this.endAgo.set(buf.subarray(o + 17, o + 19));
      this.endReach = buf[o + 19]!;
      this.endSqueeze = buf[o + 20] !== 0;
      this.drive.drift = buf[o + 21]!;
      return;
    }
    buf[o] = this.airborne ? 1 : 0;
    buf[o + 1] = this.airContact ? 1 : 0;
    this.angular.toArray(buf, o + 2);
    this.groundSpin.toArray(buf, o + 5);
    buf[o + FLIGHT_POSE] = this.pitch;
    buf[o + FLIGHT_POSE + 1] = this.yaw;
    buf[o + FLIGHT_POSE + 2] = this.roll;
    this.velocity.toArray(buf, o + FLIGHT_POSE + 3);
    this.group.position.toArray(buf, o + FLIGHT_POSE + 6);
    buf.set(this.endAgo, o + 17);
    buf[o + 19] = this.endReach;
    buf[o + 20] = this.endSqueeze ? 1 : 0;
    buf[o + 21] = this.drive.drift;
  }

  /** No wheel holds the body: it flies (`stepAir`) from its centre of mass, turning as the ground last turned it. */
  private takeOff(): void {
    this.airborne = true;
    if (!this.crashed) this.angular.add(this.groundSpin);
    this.velocity.add(_v.crossVectors(this.angular, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion)));
  }

  /**
   * Back on its wheels, upright (`stepAir`): the ground sim takes the body where and as it is, within its wheels'
   * `droop` of the ground under its middle. Its next slice lays a driven body on its support (the axle chord across
   * a ramp's tail) as it falls the rest of the way: set down on the middle's ground and slope here, it moved 8 cm in
   * one slice and levelled its rear tyres 4.7 cm into a ramp's tail. A wreck goes back to its masses.
   */
  private land(): void {
    this.airborne = false;
    this.velocity.sub(_v.crossVectors(this.angular, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion)));
    this.yaw = this.group.rotation.y;
    if (!this.crashed) landPose(activeGround(), this.group);
    this.pitch = this.group.rotation.x;
    this.roll = this.group.rotation.z;
    this.angular.set(0, this.angular.y, 0);
    this.speed = hypot2(this.velocity.x, this.velocity.z);
    if (this.crashed) {
      this.deform.armMasses(this.group, this.velocity, this.angular);
      // Landing, not aloft: marked aloft its masses handed it straight back to `stepAir` before they took the slice,
      // and a stunt-course wreck hovered on its tyres (vy −5 m/s, its height still) for seconds.
      this.deform.unstep(this.flewDt);
    }
  }

  afterContacts(dt: number, bounce?: WorldBounce): void {
    this.flewDt = 0;
    this.endAgo[0] += dt;
    this.endAgo[1] += dt;
    const d = this.deform;
    // The squeeze lasts while both ends are still being struck; after it a hit is an ordinary
    // one-ended hit again (and may re-arm), and a settled wreck may plant.
    if (this.endSqueeze && Math.max(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) {
      this.endSqueeze = false;
      d.bidirectional = false;
      d.deepCrush = false;
    }
    if (this.endReach < Infinity && d.quietTime() > REARM_QUIET_S && Math.min(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) this.endReach = Infinity;
    if (!this.doorParts[0]!.swing!.latched || !this.doorParts[1]!.swing!.latched) this.swingDoors(dt);
    else this.sampleMotion();
    if (!d.massActive) return;
    this.nudgeWheels(dt);
    this.ride(dt);
    this.stepLooseParts(dt, bounce);
  }

  /**
   * Shared crash rule for every contact path (car-car, press, pistons; docs/CONTACT_PARITY.md):
   * `end` (+1 front, −1 rear) is being struck, the striker's face `reach` m from the car's centre
   * along its length. Both ends struck within `END_WINDOW` is a squeeze: both ends become crumple
   * zones (`bidirectional`), and once a face is inboard of the wheel centres the cage may yield
   * (`deepCrush`). Both clear when the contact has been quiet for `REARM_QUIET_S`.
   */
  noteContactEnd(end: 1 | -1, reach: number): void {
    this.endAgo[end > 0 ? 0 : 1] = 0;
    this.endReach = Math.min(this.endReach, reach);
    if (this.endAgo[0]! < END_WINDOW && this.endAgo[1]! < END_WINDOW) {
      this.endSqueeze = true;
      this.deform.bidirectional = true;
    }
    if (this.endSqueeze && this.endReach < WHEEL_POS[0]![2]) this.deform.deepCrush = true;
  }

  step(dt: number): void {
    this.integrate(dt);
    this.stepBreakage(dt);
    this.updateSkin();
  }

  /** `bounce`: the world's walls, cars and props for this car's loose parts (`stepLooseParts`), on every path it takes. */
  integrate(dt: number, bounce?: WorldBounce): void {
    if (this.vaporized) return;
    if (this.falling) {
      this.velocity.y -= 9.6 * dt;
      this.group.position.addScaledVector(this.velocity, dt);
      const spin = this.fallSpin.length();
      if (spin > 1e-6) this.group.quaternion.premultiply(_qSpin.setFromAxisAngle(_n.copy(this.fallSpin).multiplyScalar(1 / spin), spin * dt));
      this.stepLooseParts(dt, bounce);
      return;
    }
    if (this.deform.massActive) {
      this.syncPose(dt);
      this.nudgeWheels(dt);
      this.ride(dt);
      this.stepLooseParts(dt, bounce);
      return;
    }
    if (this.airborne) {
      this.spinWheels(dt, false);
      this.flewDt = dt;
      if (stepAir(this, dt)) this.land();
      this.refreshBasis();
      this.ride(dt);
      if (!this.crashed) this.deform.bindKinematic(this.group, this.velocity, this.angular);
      this.stepLooseParts(dt, bounce);
      return;
    }
    if (!this.crashed) {
      this.velocity.y -= 9.6 * dt;
      this.group.position.addScaledVector(this.velocity, dt);
      this.spinWheels(dt, true);
      this.deform.bindKinematic(this.group, this.velocity, this.angular);
    } else {
      this.velocity.y -= 9.6 * dt;
      this.velocity.x *= Math.pow(0.28, dt);
      this.velocity.z *= Math.pow(0.28, dt);
      this.angular.multiplyScalar(Math.pow(0.45, dt));
      this.group.position.addScaledVector(this.velocity, dt);
      this.yaw += this.angular.y * dt;
      this.roll = THREE.MathUtils.damp(this.roll, this.angular.z * 0.15, 4, dt);
      this.pitch = THREE.MathUtils.damp(this.pitch, this.angular.x * 0.12, 4, dt);
      this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
      this.spinWheels(dt, true);
    }
    const ground = activeGround();
    const pos = this.group.position;
    if (ground === FLAT_GROUND || ground === DISC_GROUND) {
      // The flat pad; the fleet's disc only inside its rim (y hint: where the car was before this step).
      if (pos.y < 0 && ground.heightAt(pos.x, pos.z, pos.y - this.velocity.y * dt) !== NO_FLOOR) {
        pos.y = 0;
        if (this.velocity.y < 0) this.velocity.y = 0;
      }
    } else {
      // A course's ground: ride it while it holds the car up; where it falls away faster than gravity
      // can follow (a ramp lip, a crest at speed) the car flies, and lands back on whatever is below.
      const y0 = pos.y - this.velocity.y * dt;
      support(ground, pos.x, pos.z, y0, this.yaw, !this.crashed, _sup);
      let { y: gy, grade } = _sup;
      const ax = Math.sin(this.yaw) * AXLE;
      const az = Math.cos(this.yaw) * AXLE;
      const cls = carClass(this);
      const reach = droop(cls);
      if (pos.y > gy + reach) this.takeOff();
      else {
        // The wheels are on the ground (or reach it, within their `droop`, over a crest): the body takes its slope.
        const n = ground.normalAt(pos.x, pos.z, _gn, gy);
        // Unless a crawling or resting body has a tyre hanging beside its partner or the hull under the ground across its
        // middle (a ramp's side edge between the wheels): then it rests on the feature (`settle`).
        const chord = !Number.isNaN(grade);
        const speed = hypot2(this.velocity.x, this.velocity.z);
        const rested = settle(ground, pos.x, pos.z, y0, this.yaw, this.pitch, this.roll, CLASSES[cls].lift, speed, gy, grade, n, _rest);
        if (rested) [gy, grade] = [_rest.y, NaN];
        if (pos.y <= gy) {
          // The support a slice back along the travel (the centre's ground, or the axle chord's, settled as it is) and
          // its own climb rate. Across a step between the two samples (steeper than 45°: onto a fleet ramp past its side
          // or end, a kerb) that rate was a launch (24 m/s for a 0.2 m kerb in one slice), so there the face's.
          const bx = pos.x - this.velocity.x * dt;
          const bz = pos.z - this.velocity.z * dt;
          let was: number;
          let wasGrade = NaN;
          if (chord) {
            const hF = axleGround(ground, bx + ax, bz + az, y0, this.yaw);
            const hR = axleGround(ground, bx - ax, bz - az, y0, this.yaw);
            was = (hF + hR) / 2;
            wasGrade = (hF - hR) / (2 * AXLE);
          } else was = ground.heightAt(bx, bz, y0);
          if (settle(ground, bx, bz, y0, this.yaw, this.pitch, this.roll, CLASSES[cls].lift, speed, was, wasGrade, ground.normalAt(bx, bz, _gnBack, was), _rest)) was = _rest.y;
          const face = Number.isNaN(grade)
            ? -(n.x * this.velocity.x + n.z * this.velocity.z) / n.y
            : grade * (this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw));
          const step = Math.abs(gy - was) > hypot2(this.velocity.x, this.velocity.z) * dt;
          const climb = step ? face : (gy - was) / dt;
          // The ground only pushes up, by at most `SUPPORT`: the body climbs with its support and, where the slice
          // started in its springs, rises out of them no faster than gravity stops it at the top (no hop), as far as
          // that push allows; past it the body sinks into them, down to their stop (their full travel, its tyres'
          // give included). Set onto its support in one slice, a ramp's foot, a dip's floor or a landing kicked the
          // body up at 20–36 g within one frame.
          const sunk = was - y0;
          const want = sunk > 0 ? climb + Math.sqrt(2 * G * sunk) : climb;
          if (sunk <= 0 && want - this.velocity.y <= SUPPORT * dt) {
            pos.y = gy;
            this.velocity.y = climb;
          } else {
            const push = Math.min(Math.max(0, want - this.velocity.y), SUPPORT * dt);
            this.velocity.y += push;
            pos.y += push * dt;
          }
          if (pos.y < gy - 2 * reach && this.velocity.y < climb) {
            // On the stop the body sinks no further: it moves with its support (on a step, at the face's rate) and
            // the push brings it back out. Set back onto the stop, a body in past it (a landing on a ramp's high end)
            // was launched off it.
            this.velocity.y = climb;
            pos.y = y0 + climb * dt;
          }
          // Gravity along the ground (none on the level): it slows a car uphill and speeds it downhill.
          this.velocity.x += G * n.y * n.x * dt;
          this.velocity.z += G * n.y * n.z * dt;
        }
        if (!this.crashed) {
          _q0.copy(this.group.quaternion).invert();
          this.alignToGround(n, grade);
          // The tilt's turn over this slice (world rad/s): what the body carries into the air at a takeoff. Not a rest
          // pose's: a car set down on a kerb takes 7° in one slice there, 14 rad/s no body turns at.
          _q0.premultiply(this.group.quaternion);
          const k = rested ? 0 : (_q0.w < 0 ? -2 : 2) / dt;
          this.groundSpin.set(_q0.x * k, _q0.y * k, _q0.z * k);
        }
      }
    }
    this.refreshBasis();
    this.ride(dt);
    this.stepLooseParts(dt, bounce);
  }

  /**
   * Pitch and roll a driven car onto the ground plane (unit normal `n`) under it (yaw kept); on its axle chord
   * (`grade` its rise per metre ahead, else NaN) the chord sets the pitch.
   */
  private alignToGround(n: THREE.Vector3, grade: number): void {
    tilt(n, grade, this.yaw, this);
    this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
  }

  /**
   * One fixed step of what the crash does to the car's parts (`settleStep`, once per step; docs/HIGHLIGHTS.md): the
   * sensors follow the masses, hinges move, parts tear off, lamps break, glass cracks. Drawing never decides any of it:
   * at 60, 144 or 240 Hz the same crash tears the same parts at the same step, and a replay re-running the steps does too.
   */
  stepBreakage(dt: number): void {
    if (this.vaporized || this.falling) return;
    this.deform.stepCrush(dt, this.glassLeft());
    if (!this.crashed) return;
    this.syncAttachedParts(dt);
    this.evaluateBreakage(this.deform.impulseValue, dt);
  }

  /** Per rendered frame: the mesh follows the solve (skin, lamps, panels, glass, interior); nothing here changes the sim. */
  updateSkin(): void {
    if (this.vaporized || this.falling) return;
    this.deform.update(this.body.geometry);
    if (this.deform.skinnedThisFrame) this.poseLamps();
    if (this.crashed) {
      if (this.deform.skinnedThisFrame) this.skinPanels();
      this.followGlass();
    }
    if (this.deform.massActive) this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
    this.settleCasters();
  }

  /** LoD catch-up once the camera has moved: write a deferred dent before this car is drawn. */
  flushDeferredSkin(): void {
    this.deform.skinDeferred = false;
    if (!this.deform.flushSkin(this.body.geometry)) return;
    this.poseLamps();
    if (this.crashed) this.skinPanels();
  }

  /** Bonnet, boot lid, the police light bar and the skinned glass follow the body skin. */
  private skinPanels(): void {
    let hood = true;
    let trunk = true;
    for (const p of this.parts) {
      if (!p.detached) continue;
      if (p.name === "hood") hood = false;
      else if (p.name === "trunk") trunk = false;
    }
    if (hood) this.deform.skinPanel(this.hood.geometry, this.hoodRest, "bonnet", this.hoodOrigin);
    if (trunk) this.deform.skinPanel(this.trunk.geometry, this.trunkRest, "boot", this.trunkOrigin);
    if (this.lightBar && !this.lightBarPart!.detached) this.deform.skinPanel(this.lightBar.geometry, this.lightBarRest!, "roof", this.lightBarOrigin);
    for (const p of this.parts) if (p.region && p.open && !p.detached) this.shellPose(p);
    for (const g of this.glassPanes) {
      if (!g.skin || !g.restVerts || g.state === "shattered") continue;
      this.deform.skinPanel(g.mesh.geometry, g.restVerts, g.skin, _zero);
    }
  }

  /** `drop`: a popped hub throws its wheel (host); a netplay client takes loose wheels from snapshots. */
  private nudgeWheels(dt: number, drop = true): void {
    this.spinWheels(dt, true);
    const hubs = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
    // The frame's matrix, current: world up in the body frame is its y row (e[1], e[5], e[9]), and a world point's
    // body-frame height its y column (e[4], e[5], e[6]) over the point's offset from the origin.
    this.group.updateWorldMatrix(false, false);
    const e = this.group.matrixWorld.elements;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      if (this.looseWheels[i]!.loose) continue;
      const rest = WHEEL_POS[i]!;
      if (!this.deform.massActive) {
        w.position.set(rest[0], rest[1], rest[2]);
        continue;
      }
      const hub = this.deform.massLocal(hubs[i]!);
      const popped = this.deform.hubPopped(hubs[i]!);
      if (!popped) {
        // Follows its hub along the car too: a face's shove, or a squeeze past the hubs, moves it off rest. Stood up
        // off the hub so the tyre meets the ground the hub floor holds it over, and at the hub's own height: the
        // stored one is clamped within 7 cm of rest (`clampLocal`), and a frame stood on a crest's middle put it
        // 1.7 cm over the hub, the tyre off the road.
        const at = this.deform.massWorld(hubs[i]!);
        const lift = this.deform.wheelLift(at.x, at.y, at.z);
        const y = e[4]! * (at.x - e[12]!) + e[5]! * (at.y - e[13]!) + e[6]! * (at.z - e[14]!);
        w.position.set(hub.x + e[1]! * lift, THREE.MathUtils.clamp(y, 0.16, 0.55) + e[5]! * lift, hub.z + e[9]! * lift);
        w.visible = true;
        continue;
      }
      if (drop) this.dropWheel(i, hubs[i]!);
    }
  }

  setRigVisible(v: boolean): void {
    this.deform.setHelperVisible(v);
    if (this.hullHelper) this.hullHelper.visible = v;
    if (v) this.updateHullHelper();
  }

  dispose(): void {
    this.deform.disposeHelper();
    const free = (obj: THREE.Object3D) => {
      // Meshes, lines and points alike: the hull overlay is a LineSegments, and freeing meshes alone left its buffer for good.
      const drawn = obj as THREE.Mesh | THREE.Line | THREE.Points;
      drawn.geometry?.dispose();
      for (const m of [drawn.material].flat()) if (m && !m.userData.shared) m.dispose();
      if (obj instanceof THREE.Light) obj.dispose();
    };
    // Loose parts live in the world, attached ones in the group: free each part before it leaves either.
    for (const p of this.parts) {
      p.object.traverse(free);
      p.object.removeFromParent();
    }
    this.group.traverse(free);
  }

  /** The meshes a player's look recolours (`car-look.ts`): the body (on the body paint), the lids, the door skins and the glass panes. */
  lookMeshes(): { body: THREE.Mesh; bodyPaint: THREE.MeshPhysicalMaterial; hood: THREE.Mesh; trunk: THREE.Mesh; doors: readonly THREE.Mesh[]; glass: readonly THREE.Mesh[] } {
    return { body: this.body, bodyPaint: this.bodyMat, hood: this.hood, trunk: this.trunk, doors: [this.doorMeshL, this.doorMeshR], glass: this.glassPanes.map((g) => g.mesh) };
  }

  /**
   * Netplay client: take the host's deform and part state with no physics, breakage, launch or FX,
   * so the skin, hulls, parts, lamps and glass match the host's. Set the pose first.
   */
  writeNetState(deform: DeformNetState, parts: PartNetState): void {
    this.deform.writeNetState(deform, this.group, this.body.geometry);
    this.restoreWear();
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      const f = parts.flags[i]!;
      const loose = (f & 1) !== 0;
      p.hingeT = parts.hinge[i * 3]!;
      if (loose !== p.detached) {
        if (p.region && loose) this.tearPanel(p);
        p.object.removeFromParent();
        if (loose) this.world.add(p.object);
        else if (p.region) this.closePanel(p);
        else if (p.name === "mirrorL") this.doorL.add(p.object);
        else if (p.name === "mirrorR") this.doorR.add(p.object);
        else this.group.add(p.object);
        p.detached = loose;
      }
      p.folding = (f & 2) !== 0;
      if (p.swing) {
        p.swing.theta = parts.hinge[i * 3 + 1]!;
        p.swing.mirrorFold = parts.hinge[i * 3 + 2]!;
        p.swing.latched = (f & 4) !== 0;
        p.swing.omega = 0;
      } else {
        p.fatigue = parts.hinge[i * 3 + 1]!;
        p.hingeMax = 1 - parts.hinge[i * 3 + 2]!;
      }
      if (!loose) continue;
      p.object.position.fromArray(parts.pose, i * 7);
      p.object.quaternion.fromArray(parts.pose, i * 7 + 3);
    }
    // Mirrors pose on their door, which shares their swing: every swing is set before any pose.
    for (const p of this.parts) if (!p.detached) this.posePart(p);

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const lw = this.looseWheels[i]!;
      const loose = ((parts.wheelLoose >> i) & 1) !== 0;
      if (loose !== lw.loose) {
        // Back under the class hub group (assignClass), where resetVisual's re-dress puts it.
        if (loose) this.world.add(w);
        else (this.group.getObjectByName("classHubs") ?? this.group).add(w);
        lw.loose = loose;
        lw.velocity.set(0, 0, 0);
        lw.angular.set(0, 0, 0);
      }
      if (!loose) continue;
      w.position.fromArray(parts.wheels, i * 7);
      w.quaternion.fromArray(parts.wheels, i * 7 + 3);
      w.visible = true;
    }

    let relight = false;
    for (let i = 0; i < this.lamps.length; i++) if ((parts.lamps >> i) & 1 && !this.lamps[i]!.intact) relight = true;
    if (relight) this.resetLamps();
    for (let i = 0; i < this.lamps.length; i++) if (!((parts.lamps >> i) & 1) && this.lamps[i]!.intact) this.breakLamp(this.lamps[i]!);

    for (let i = 0; i < this.glassPanes.length; i++) {
      const g = this.glassPanes[i]!;
      const want = (parts.glass >> (i * 2)) & 3;
      const have = g.state === "intact" ? 0 : g.state === "cracked" ? 1 : 2;
      if (want === have) continue;
      if (want < have) this.resetGlass(g);
      if (want >= 1 && g.state === "intact") this.crackGlass(g);
      if (want === 2) {
        g.state = "shattered";
        g.mesh.visible = false;
      }
    }

    if (this.deform.skinnedThisFrame) {
      this.poseLamps();
      this.skinPanels();
    }
    this.followGlass();
    this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
  }

  /** Netplay client, every frame: wheels spin and ride their hubs as `afterContacts` does on the host. */
  netFrame(dt: number): void {
    this.nudgeWheels(dt, false);
    this.ride(dt);
    this.flutterParts(dt);
  }

  /**
   * The body on its springs (`Suspension`) over this slice's ground pose: no input while flying or not upright
   * (tumbling, on the roof); a crashed car's body back on its stock ride.
   */
  private ride(dt: number): void {
    const cls = carClass(this);
    const air = this.airborne && (!this.airContact || this.group.matrixWorld.elements[5]! < 0.5);
    let gone = 0;
    for (let i = 0; i < 4; i++) if (this.looseWheels[i]!.loose) gone |= 1 << i;
    this.suspension.step(this.group, this.wheels, cls, CLASSES[cls].lift, !this.crashed, air, gone, dt);
    if (this.crashed) this.seatBody(CLASSES[cls].lift, dt);
  }

  /**
   * A wreck's drawn body stood up off its frame until its underside (`UNDERSIDE`) clears the ground under it: the plane
   * through the hubs cuts the far side of a hollow (a kicker's foot: the nose 8.5 cm in the road). The wheels stay on
   * their hubs. Eased, so a wreck sliding over a kerb does not hop; drawn only, nothing reads it.
   */
  private seatBody(lift: number, dt: number): void {
    const body = (this.classBody ??= this.group.getObjectByName("classLift") ?? null);
    if (!body) return;
    let margin = Infinity;
    if (this.deform.massActive && !this.deform.aloft) {
      body.updateWorldMatrix(true, false);
      const e = body.matrixWorld.elements;
      const ground = activeGround();
      for (const [x, z, h] of UNDERSIDE) {
        const px = e[0]! * x + e[4]! * h + e[8]! * z + e[12]!;
        const py = e[1]! * x + e[5]! * h + e[9]! * z + e[13]!;
        const pz = e[2]! * x + e[6]! * h + e[10]! * z + e[14]!;
        const g = ground.heightAt(px, pz, py);
        if (g !== NO_FLOOR) margin = Math.min(margin, py - g);
      }
    }
    // Along the body's up (a lift moves a point up by that y of it): the lift that brings the least margin to 0, a clear
    // body easing back to its frame; none on its side or roof.
    const up = body.matrixWorld.elements[5]!;
    const target = Number.isFinite(margin) && up > 0.5 ? Math.min(HULL_LIFT_MAX, Math.max(0, this.hullLift - margin / up)) : 0;
    this.hullLift += (target - this.hullLift) * (1 - Math.exp(-HULL_LIFT_RATE * dt));
    body.position.y = lift + this.suspension.heave + this.hullLift;
  }
}

/**
 * Start the fake fall. Host: the rigid motion that best fits the masses (`fitMasses`), or the kinematic car's
 * own; the soft body then stops (`massActive` off; its state is left as it is). Netplay client: pass the host's
 * `spin` after setting the pose and `velocity`.
 */
export function beginFakeFall(car: DeformableCar, spin?: THREE.Vector3): void {
  const d = car.deform;
  if (spin) car.fallSpin.copy(spin);
  // The fake turns about the group's origin: carry that point's velocity in the fitted rigid motion.
  else if (d.massActive) fitMasses(car, car.group.position, car.fallSpin);
  else car.fallSpin.copy(car.angular);
  d.massActive = false;
  car.falling = true;
}

/**
 * The rigid motion that best fits a wreck's masses: their mean velocity and the spin Σ m r × v / Σ m |r|² about
 * their centre into `spin`, and that motion's velocity at world point `at` into `car.velocity`.
 */
function fitMasses(car: DeformableCar, at: THREE.Vector3, spin: THREE.Vector3): void {
  const d = car.deform;
  let mass = 0;
  _fallC.set(0, 0, 0);
  _fallV.set(0, 0, 0);
  for (const m of d.masses) {
    mass += m.mass;
    _fallC.addScaledVector(m.world, m.mass);
    _fallV.addScaledVector(m.vel, m.mass);
  }
  _fallC.multiplyScalar(1 / mass);
  _fallV.multiplyScalar(1 / mass);
  spin.set(0, 0, 0);
  let inertia = 0;
  for (const m of d.masses) {
    _fallR.subVectors(m.world, _fallC);
    inertia += m.mass * _fallR.lengthSq();
    spin.addScaledVector(_fallR.cross(_v.subVectors(m.vel, _fallV)), m.mass);
  }
  spin.multiplyScalar(1 / Math.max(inertia, 1e-6));
  car.velocity.copy(_fallV).add(_fallR.subVectors(at, _fallC).cross(_v.copy(spin)).negate());
}

/**
 * A crashed car's slide after the hit (`CrashEngine.tickInner`): tyre-style friction on the group, and
 * the mass ground drag. The drag ramps from the hit, not from the last car contact: a pair grinding
 * together kept resetting the contact timer and slid ~3× as far as one wreck alone, and a frictionless
 * pair pushed long enough lets the bullet drive through the struck car (T-bone). A driven
 * car (under power, drivetrain alive) does not slide: its tyres are applyDrive's (`groundMasses` skips it too).
 * A car whose drivetrain died under power keeps the contact ramp; `dragGround` skips an airborne wreck.
 */
export function bleedAfterSlide(car: DeformableCar, dt: number): void {
  if (!car.crashed || (car.deform.powered && car.deform.drivetrainAlive)) return;
  const q = car.deform.quietTime();
  const p = car.group.position;
  // × the course surface's friction where the wreck slides (1 on the flat sandbox ground).
  const mu = (q < 0.15 ? CRASH.muScuff : CRASH.muSlide * (1 + Math.min(1.4, q))) * activeGround().frictionAt(p.x, p.z, p.y);
  applyGroundFriction(car.velocity, dt, mu, true);
  if (car.deform.massActive) {
    const t = car.deform.powered ? q : car.deform.sinceHit();
    car.deform.dragGround(dt, THREE.MathUtils.clamp((t - 0.08) / 1.1, 0, 1));
  }
}
