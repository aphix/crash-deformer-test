import * as THREE from "three";
import type { DeformNetState } from "../deform/streamed-deform.ts";
import { applyGroundFriction, CRASH, hypot2 } from "../deform/physics-util.ts";
import { CAR_HALF, DOOR, WHEEL_POS } from "./car-mesh.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { CarParts } from "./car-parts.ts";
import { END_WINDOW, type PartNetState, REARM_QUIET_S, type WorldBounce } from "./car-core.ts";
import { COM_Y, pressing, readContact, stepFree, wreckContact } from "./car-air.ts";
import { bodyLift, Suspension, UNDERSIDE, UPRIGHT_UP_Y } from "./car-suspension.ts";
import { C_GRIP, C_NY, C_OWNER, HIT_SIZE } from "../world/surfaces.ts";
import { carClass, CLASSES } from "./vehicle-classes.ts";
import { clearDents } from "./loose-dent.ts";
import type { CarSurfaces } from "./car-surfaces.ts";
import { LID } from "./constants.ts";

export { CAR_HALF, DOOR, WHEEL_POS };
export type { Hull } from "../deform/hulls.ts";

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _in = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _fallC = new THREE.Vector3();
const _fallV = new THREE.Vector3();
const _fallR = new THREE.Vector3();
const _wantQuaternion = new THREE.Quaternion();
/** Where a `DeformableCar.flight` block holds each part: spin (3), pitch, yaw, roll (3), orientation quaternion (4), velocity (3), position (3), contact-end clocks (2), reach, squeeze flag and drift. */
export const FLIGHT_EULER = 3;
const FLIGHT_QUATERNION = 6;
export const FLIGHT_VELOCITY = 10;
export const FLIGHT_POSITION = 13;
const FLIGHT_END_AGO = 16;
const FLIGHT_END_REACH = 18;
const FLIGHT_END_SQUEEZE = 19;
const FLIGHT_DRIFT = 20;
export const FLIGHT = 21;
/** Rate (1/s) a wreck's body eases onto its ground clearance (`seatBody`), and most (m) it is stood up for its underside (a hollow deeper is a wall). */
const HULL_LIFT_RATE = 12;
const HULL_LIFT_MAX = 0.2;
/** Each wheel's contact standing on level road, as built and at a spawn (`resetContact`): no lift, the normal up, full grip, the world's. */
const STANDING = new Float64Array(4 * HIT_SIZE);
for (let i = 0; i < 4; i++) {
  STANDING[i * HIT_SIZE + C_NY] = 1;
  STANDING[i * HIT_SIZE + C_GRIP] = 1;
  STANDING[i * HIT_SIZE + C_OWNER] = -1;
}

export class DeformableCar extends CarParts {
  /** Derived each slice from the contacts: no wheel within its springs' reach of a surface and no hull point in one (flight); a body on its masses is in the air while they are (`aloft`). Drive and grip follow the wheels (`wheelsDown`), not this. */
  airborne = false;
  /** A parked car's tyres grip the ground both ways (their wheels do not turn): set where a scene stands a car, cleared by any drive input. */
  parked = false;
  /** Moved by the rigid contact solve (`stepFree`), not by its crush masses: derived, never stored. `velocity` is then its centre of mass's. */
  get rigid(): boolean {
    return !this.deform.massActive;
  }
  /** The world's other-car tops this body can stand on (`stepWorld` sets it; null: the world's ground alone). */
  surfaces: CarSurfaces | null = null;
  /** This car's slot in the world's `cars` (`stepWorld` sets it; -1 in no world): its own roof is not under it. */
  slot = -1;
  /** The car whose top carries this one (`CarSurfaces.commit`), whose plan the SAT must not shove it off. */
  restsOn: DeformableCar | null = null;
  /** A face of this body (or of the car under it) is yielding to its load this slice (`CarSurfaces.commit`). */
  yielding = false;
  /** The last slice left a hard contact held or about to be: a hull point, a belly or a roof in a surface, or a tyre at its spring stop or closing through what is left of its travel within a slice. Derived each slice (`stepFree`); read by `contactHz` to cut the step. */
  hardTouch = false;
  /** A hard hit is about to land: this car is closing on a fixed solid (the course's collide pass) or on another car (`markApproaches`), within a step or two of travel of it, or driving into it. Not state: derived again every step, read by `stepWorld` to cut the step. */
  nearHit = false;
  /** Each wheel's last contact (`wheelContact`, `HIT_SIZE` doubles per wheel, `WHEEL_POS` order): the lift it needs, normal, grip, surface and owner. */
  readonly wheelHit = STANDING.slice();
  /** The wheels within their springs' reach of a surface, bit i: wheel i (`WHEEL_POS` order). Drive and traction follow them. */
  wheelsDown = 15;
  /** The slice (s) `stepFree` moved this body in the slice under way; 0 once that slice's masses have stepped (`afterContacts`). */
  private flewDt = 0;
  /** The drawn body's load transfer over the physics body, and its wheels' seats (drawn only). */
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
    this.parked = false;
    this.crashed = false;
    this.resetContact();
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
    const rigid = this.rigid;
    if (rigid) {
      // A rigid body (`stepFree`) takes the hit on its masses: its centre's velocity carried to the group's origin, as
      // `land` does, and a wreck's masses keep their dents. Its masses fly it on (`syncPose`) and hand it back to
      // `stepFree` once their contact window closes; left rigid, nothing ever landed it and its drive stayed idled
      // (8 s, stopped, on the stunt course).
      this.velocity.sub(_v.crossVectors(this.angular, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion)));
      if (this.crashed) {
        this.deform.armMasses(this.group, this.velocity, this.angular);
        this.deform.unstep(this.flewDt);
        this.deform.aloft = this.airborne;
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
      if (rigid) {
        this.deform.unstep(this.flewDt);
        this.deform.aloft = this.airborne;
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
    // On its masses a body touches what its hubs do and is in the air while they are (`wreckContact`): struck in flight it kept
    // the flag the hit found and, landed and stopped, still read as flying with its drive idled.
    wreckContact(this);
    // A wreck whose middle is off the ground (`aloft`) and whose hull is clear of it flies as a rigid body
    // (`stepFree`) once its contact window closes, fitted to its masses' motion; until then its masses fly it (a hit
    // in flight still crumples, a wreck over a lip pivots on its last wheels and one coming down lands on them).
    if (dt > 0 && this.deform.aloft && !this.deform.live() && !pressing(this)) {
      fitMasses(this, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion).add(this.group.position), this.angular);
      this.deform.massActive = false;
    }
    this.refreshBasis();
  }

  /**
   * Highlight keyframes (docs/HIGHLIGHTS.md): what a netplay pose rounds or leaves out, `FLIGHT` doubles into `buf` at `o`,
   * or with `write` from it: the spins, the Euler angles the drive turns and the quaternion the rigid step turns (each is the
   * other's derived copy only up to rounding, and the drive reads the heading off the quaternion before it sets it from the
   * Euler), velocity and position whole (the wire rounds them: a first impact 0.5 m/s off), the squeeze clocks and the drift
   * state. What the body touches is read again (`restoreContact`).
   */
  flight(buf: Float64Array, o: number, write: boolean): void {
    if (write) {
      this.angular.fromArray(buf, o);
      this.pitch = buf[o + FLIGHT_EULER]!;
      this.yaw = buf[o + FLIGHT_EULER + 1]!;
      this.roll = buf[o + FLIGHT_EULER + 2]!;
      this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
      // The rigid step moved the quaternion after the drive set it from the Euler angles: the angles are then its derived copy.
      if (!this.group.quaternion.equals(_wantQuaternion.fromArray(buf, o + FLIGHT_QUATERNION))) this.group.quaternion.copy(_wantQuaternion);
      this.velocity.fromArray(buf, o + FLIGHT_VELOCITY);
      this.group.position.fromArray(buf, o + FLIGHT_POSITION);
      this.endAgo.set(buf.subarray(o + FLIGHT_END_AGO, o + FLIGHT_END_AGO + 2));
      this.endReach = buf[o + FLIGHT_END_REACH]!;
      this.endSqueeze = buf[o + FLIGHT_END_SQUEEZE] !== 0;
      this.drive.drift = buf[o + FLIGHT_DRIFT]!;
      this.restoreContact();
      return;
    }
    this.angular.toArray(buf, o);
    buf[o + FLIGHT_EULER] = this.pitch;
    buf[o + FLIGHT_EULER + 1] = this.yaw;
    buf[o + FLIGHT_EULER + 2] = this.roll;
    this.group.quaternion.toArray(buf, o + FLIGHT_QUATERNION);
    this.velocity.toArray(buf, o + FLIGHT_VELOCITY);
    this.group.position.toArray(buf, o + FLIGHT_POSITION);
    buf.set(this.endAgo, o + FLIGHT_END_AGO);
    buf[o + FLIGHT_END_REACH] = this.endReach;
    buf[o + FLIGHT_END_SQUEEZE] = this.endSqueeze ? 1 : 0;
    buf[o + FLIGHT_DRIFT] = this.drive.drift;
  }

  /**
   * A wreck flying as a rigid body (`stepFree`) with three wheels on the world goes back to its masses (`armed`): they take its centre's
   * velocity less the spin's carry (a body crushed only by a load has no masses and stands on its wheels as an intact car does).
   */
  private landWreck(): void {
    this.velocity.sub(_v.crossVectors(this.angular, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion)));
    this.angular.set(0, this.angular.y, 0);
    this.speed = hypot2(this.velocity.x, this.velocity.z);
    this.deform.armMasses(this.group, this.velocity, this.angular);
    // Landing, not aloft: marked aloft its masses handed it straight back to `stepFree` before they took the slice,
    // and a stunt-course wreck hovered on its tyres (vy −5 m/s, its height still) for seconds.
    this.deform.unstep(this.flewDt);
  }

  /** On the road at a spawn: its four wheels stand on it, and none of the last slice's contact state applies. */
  private resetContact(): void {
    this.airborne = false;
    this.wheelsDown = 15;
    this.restsOn = null;
    this.yielding = false;
    this.hardTouch = false;
    this.wheelHit.set(STANDING);
  }

  /** What the body touches, read again where no slice carried it (a keyframe restored): off its pose, or its masses (`readContact`). */
  restoreContact(): void {
    readContact(this);
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
    this.stepLooseParts(dt, this.slot, bounce);
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

  /** `bounce`: the world's rigs for this car's loose parts (`stepLooseParts`), on every path it takes. */
  integrate(dt: number, bounce?: WorldBounce): void {
    if (this.vaporized) return;
    if (this.deform.massActive) {
      this.syncPose(dt);
      this.nudgeWheels(dt);
      this.ride(dt);
      this.stepLooseParts(dt, this.slot, bounce);
      return;
    }
    if (!this.falling) this.spinWheels(dt, !this.airborne);
    this.flewDt = dt;
    const landed = stepFree(this, dt);
    if (this.falling) {
      this.stepLooseParts(dt, this.slot, bounce);
      return;
    }
    // The drive turns the stored pose each slice (`applyDrive`): it is what the rigid body is now, or the turn undoes its tumble.
    this.yaw = this.group.rotation.y;
    this.pitch = this.group.rotation.x;
    this.roll = this.group.rotation.z;
    if (landed && this.crashed && this.deform.armed) this.landWreck();
    this.refreshBasis();
    this.ride(dt);
    if (!this.crashed) this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.stepLooseParts(dt, this.slot, bounce);
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
      if (p.name === LID.hood) hood = false;
      else if (p.name === LID.trunk) trunk = false;
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
    const upY = this.group.matrixWorld.elements[5]!;
    const air = this.airborne || upY < UPRIGHT_UP_Y;
    const lift = bodyLift(CLASSES[cls].lift, upY);
    let gone = 0;
    for (let i = 0; i < 4; i++) if (this.looseWheels[i]!.loose) gone |= 1 << i;
    this.suspension.step(this.group, this.wheels, cls, lift, !this.crashed, air, gone, this.wheelHit, dt);
    if (this.crashed) this.seatBody(lift, dt);
  }

  /**
   * Into `out` from index `n` on: the objects the ride writes every slice while they are on the car, its class body (heave, pitch and
   * roll from the load transfer, `Suspension.pose`) and the four wheels still on it (`seatWheels`). Returns the count past the last.
   */
  rideObjects(out: THREE.Object3D[], n: number): number {
    const body = (this.classBody ??= this.group.getObjectByName("classLift") ?? null);
    if (body) out[n++] = body;
    for (let i = 0; i < this.wheels.length; i++) if (!this.looseWheels[i]!.loose) out[n++] = this.wheels[i]!;
    return n;
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
    const target = Number.isFinite(margin) && up > UPRIGHT_UP_Y ? Math.min(HULL_LIFT_MAX, Math.max(0, this.hullLift - margin / up)) : 0;
    this.hullLift += (target - this.hullLift) * (1 - Math.exp(-HULL_LIFT_RATE * dt));
    body.position.y = lift + this.suspension.heave + this.hullLift;
  }
}

/**
 * Start the fake fall: the soft body stops (`massActive` off; its state is left as it is) and the car flies on as the rigid step
 * flies every body, off the world's ground. Host: a wreck takes the rigid motion that best fits its masses (`fitMasses`), a rigid
 * car keeps its own. `keepMotion`: a replay or netplay client has set the pose, `velocity` and `angular` already.
 */
export function beginFakeFall(car: DeformableCar, keepMotion = false): void {
  const d = car.deform;
  if (d.massActive && !keepMotion) fitMasses(car, _p.set(0, COM_Y, 0).applyQuaternion(car.group.quaternion).add(car.group.position), car.angular);
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
