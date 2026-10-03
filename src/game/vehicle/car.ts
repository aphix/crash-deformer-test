import * as THREE from "three";
import type { DeformNetState } from "../deform/streamed-deform.ts";
import { applyGroundFriction, CRASH, hypot2, round4 } from "../deform/physics-util.ts";
import { CAR_HALF, DOOR, WHEEL_POS } from "./car-mesh.ts";
import { getCrackMap } from "./car-materials.ts";
 import { activeGround, DISC_GROUND, FLAT_GROUND, NO_FLOOR } from "../world/ground.ts";
import { CarParts } from "./car-parts.ts";
import { END_WINDOW, type PartNetState, REARM_QUIET_S, type WorldBounce } from "./car-core.ts";
import { COM_Y, hullClear, stepAir, SUPPORT } from "./car-air.ts";
import { droop, Suspension } from "./car-suspension.ts";
import { carClass, CLASSES } from "./vehicle-classes.ts";
import { clearDents } from "./loose-dent.ts";

export { CAR_HALF, DOOR, WHEEL_POS };
export type { Hull } from "../deform/hulls.ts";

const _qSpin = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _in = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _gn = new THREE.Vector3();
const _fallC = new THREE.Vector3();
const _fallV = new THREE.Vector3();
const _fallR = new THREE.Vector3();
const G = 9.6;
/** The axle chord lifts a driven body off its centre's ground beyond this (m): a hollow under it (a ramp's foot). */
const CHORD_LIFT = 0.005;
/** The axles' half spread along the body (m). */
const AXLE = WHEEL_POS[0]![2];
/** Numbers in a `DeformableCar.flight` block. */
export const FLIGHT = 8;
const _q0 = new THREE.Quaternion();

export class DeformableCar extends CarParts {
  /** No wheel on the ground: a rigid body in flight or tumbling (`stepAir`); drive and grip are off. */
  airborne = false;
  /** While airborne: some hull point is on the ground this slice. */
  airContact = false;
  /** The body's turn (world rad/s) over its last grounded slice, carried into the air at a takeoff. */
  private readonly groundSpin = new THREE.Vector3();
  /** The slice (s) `stepAir` moved this body in the slice under way; 0 once that slice's masses have stepped (`afterContacts`). */
  private flewDt = 0;
  /** The body's springs over its wheels (drawn only: the physics frame stays on the ground pose). */
  readonly suspension = new Suspension();

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
    this.yaw = yaw;
    this.group.position.set(x, 0, z);
    this.group.rotation.set(0, yaw, 0, "YXZ");
    this.roll = 0;
    this.pitch = 0;
    this.speed = speed;
    this.spawnSpeed = speed;
    this.crashed = false;
    this.airborne = false;
    this.suspension.reset();
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(dir).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
  }

  resetVisual(): void {
    this.vaporized = false;
    this.falling = false;
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
    this.wheelSpin = 0;
    this.wheelRate = 0;
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
    if (this.crashed) {
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
   * Highlight keyframes (docs/HIGHLIGHTS.md): the flight state a netplay pose leaves out (airborne, a hull point on the
   * ground, the whole spin, the spin a takeoff carries), `FLIGHT` numbers into `buf` at `o`, or with `write` from it.
   */
  flight(buf: Float32Array, o: number, write: boolean): void {
    const a = this.angular;
    const g = this.groundSpin;
    if (write) {
      this.airborne = buf[o] !== 0;
      this.airContact = buf[o + 1] !== 0;
      a.set(buf[o + 2]!, buf[o + 3]!, buf[o + 4]!);
      g.set(buf[o + 5]!, buf[o + 6]!, buf[o + 7]!);
      return;
    }
    buf[o] = this.airborne ? 1 : 0;
    buf[o + 1] = this.airContact ? 1 : 0;
    buf[o + 2] = a.x;
    buf[o + 3] = a.y;
    buf[o + 4] = a.z;
    buf[o + 5] = g.x;
    buf[o + 6] = g.y;
    buf[o + 7] = g.z;
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

  snapshot(): Record<string, unknown> {
    return {
      name: this.paint.name,
      crashed: this.crashed,
      pos: { x: round4(this.group.position.x), y: round4(this.group.position.y), z: round4(this.group.position.z) },
      vel: { x: round4(this.velocity.x), y: round4(this.velocity.y), z: round4(this.velocity.z) },
      speed: round4(this.velocity.length()),
      angular: { x: round4(this.angular.x), y: round4(this.angular.y), z: round4(this.angular.z) },
      yaw: round4(this.yaw),
      pitch: round4(this.pitch),
      roll: round4(this.roll),
      spawnSpeed: round4(this.spawnSpeed),
      deform: this.deform.snapshot(),
      parts: this.parts.map((p) => ({
        name: p.name,
        detached: p.detached,
        folding: p.folding,
        hingeT: round4(p.hingeT),
        pos: { x: round4(p.object.position.x), y: round4(p.object.position.y), z: round4(p.object.position.z) },
        vel: { x: round4(p.velocity.x), y: round4(p.velocity.y), z: round4(p.velocity.z) },
      })),
      lamps: this.lamps.map((l) => ({ kind: l.kind, side: l.side, intact: l.intact })),
      glass: this.glassPanes.map((g) => g.state),
    };
  }

  step(dt: number): void {
    this.integrate(dt);
    this.updateDeform(dt);
  }

  integrate(dt: number): void {
    if (this.vaporized) return;
    if (this.falling) {
      this.velocity.y -= 9.6 * dt;
      this.group.position.addScaledVector(this.velocity, dt);
      const spin = this.fallSpin.length();
      if (spin > 1e-6) this.group.quaternion.premultiply(_qSpin.setFromAxisAngle(_n.copy(this.fallSpin).multiplyScalar(1 / spin), spin * dt));
      this.stepLooseParts(dt);
      return;
    }
    if (this.deform.massActive) {
      this.syncPose(dt);
      this.nudgeWheels(dt);
      this.ride(dt);
      this.stepLooseParts(dt);
      return;
    }
    if (this.airborne) {
      this.spinWheels(dt, false);
      this.flewDt = dt;
      if (stepAir(this, dt)) this.land();
      this.refreshBasis();
      this.ride(dt);
      if (!this.crashed) this.deform.bindKinematic(this.group, this.velocity, this.angular);
      this.stepLooseParts(dt);
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
      let gy = ground.heightAt(pos.x, pos.z, y0);
      // A driven car stands on its axles: across a hollow (a ramp's foot) their chord is above the centre's ground.
      let grade = NaN;
      const ax = Math.sin(this.yaw) * AXLE;
      const az = Math.cos(this.yaw) * AXLE;
      if (!this.crashed) {
        const hF = ground.heightAt(pos.x + ax, pos.z + az, y0);
        const hR = ground.heightAt(pos.x - ax, pos.z - az, y0);
        if ((hF + hR) / 2 > gy + CHORD_LIFT) {
          gy = (hF + hR) / 2;
          grade = (hF - hR) / (2 * AXLE);
        }
      }
      const reach = droop(carClass(this));
      if (pos.y > gy + reach) this.takeOff();
      else {
        // The wheels are on the ground (or reach it, within their `droop`, over a crest): the body takes its slope.
        const n = ground.normalAt(pos.x, pos.z, _gn, gy);
        if (pos.y <= gy) {
          // The support a slice back along the travel (the centre's ground, or the axle chord's) and its own climb
          // rate. Across a step between the two samples (steeper than 45°: onto a fleet ramp past its side or end, a
          // kerb) that rate was a launch (24 m/s for a 0.2 m kerb in one slice), so there the face's (the chord's grade).
          const bx = pos.x - this.velocity.x * dt;
          const bz = pos.z - this.velocity.z * dt;
          const was = Number.isNaN(grade) ? ground.heightAt(bx, bz, y0) : (ground.heightAt(bx + ax, bz + az, y0) + ground.heightAt(bx - ax, bz - az, y0)) / 2;
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
          // The tilt's turn over this slice (world rad/s): what the body carries into the air at a takeoff.
          _q0.premultiply(this.group.quaternion);
          const k = (_q0.w < 0 ? -2 : 2) / dt;
          this.groundSpin.set(_q0.x * k, _q0.y * k, _q0.z * k);
        }
      }
    }
    this.refreshBasis();
    this.ride(dt);
    this.stepLooseParts(dt);
  }

  /**
   * Pitch and roll a driven car onto the ground plane (unit normal `n`) under it (yaw kept); on its axle chord
   * (`grade` its rise per metre ahead, else NaN) the chord sets the pitch.
   */
  private alignToGround(n: THREE.Vector3, grade: number): void {
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    // YXZ takes local up to (−sin r·x̂ + cos r sin p·f̂ + cos r cos p·ŷ), x̂ = (fz, 0, −fx) the local +x:
    // pitch from n·f̂ against n.y, roll from −n·x̂ against the rest. A rise toward +x lifts the +x wheels.
    const nf = n.x * fx + n.z * fz;
    this.pitch = Number.isNaN(grade) ? Math.atan2(nf, n.y) : -Math.atan(grade);
    this.roll = Math.atan2(n.z * fx - n.x * fz, hypot2(nf, n.y));
    this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
  }

  updateDeform(dt: number): void {
    if (this.vaporized || this.falling) return;
    this.deform.update(dt, this.body.geometry);
    // LoD gate lifted (back on screen / large again): catch the mesh up to the cages first.
    if (!this.deform.skinDeferred) this.deform.flushSkin(this.body.geometry);
    if (this.deform.skinnedThisFrame) this.poseLamps();
    if (this.crashed) {
      if (this.deform.skinnedThisFrame) this.skinPanels();
      this.syncAttachedParts(dt);
      this.followGlass();
      this.evaluateBreakage(this.deform.impulseValue, dt);
    }
    if (this.deform.massActive) this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
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
        // Follows its hub along the car too: a face's shove, or a squeeze past the hubs, moves it off rest.
        w.position.set(hub.x, THREE.MathUtils.clamp(hub.y, 0.16, 0.55), hub.z);
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
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) if (!m.userData.shared) m.dispose();
      }
      if (obj instanceof THREE.Light) obj.dispose();
    };
    // Loose parts live in the world, attached ones in the group: free each part before it leaves either.
    for (const p of this.parts) {
      p.object.traverse(free);
      p.object.removeFromParent();
    }
    this.group.traverse(free);
  }

  /**
   * Netplay client: take the host's deform and part state with no physics, breakage, launch or FX,
   * so the skin, hulls, parts, lamps and glass match the host's. Set the pose first.
   */
  writeNetState(deform: DeformNetState, parts: PartNetState): void {
    this.deform.writeNetState(deform, this.group, this.body.geometry);
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
      if (want >= 1 && g.state === "intact") {
        g.state = "cracked";
        g.mat.map = getCrackMap();
        g.mat.opacity = 0.55;
        g.mat.roughness = 0.32;
        g.mat.needsUpdate = true;
      }
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
 * pair pushed long enough lets the bullet drive through the struck car (T-bone, RIG_ANALYSIS §6.6). A driven
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
