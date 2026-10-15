import * as THREE from "three";
import type { DeformNetState } from "../deform/streamed-deform.ts";
import { applyGroundFriction, CRASH, FRICTION_G, hypot2 } from "../deform/physics-util.ts";
import { CAR_HALF, DOOR, WHEEL_POS } from "./car-mesh.ts";
import { activeGround } from "../world/ground.ts";
import { CarParts } from "./car-parts.ts";
import { END_WINDOW, type PartNetState, REARM_QUIET_S } from "./car-core.ts";
import { COM_Y, REST_SPEED } from "./car-air-body.ts";
import { readContact } from "./car-air-points.ts";
import { stepFree, wreckCentre, wreckInvI } from "./car-air.ts";
import { bodyLift, Suspension, UPRIGHT_UP_Y } from "./car-suspension.ts";
import { C_GRIP, C_NY, C_OWNER, HIT_SIZE, stirNear } from "../world/surfaces.ts";
import { carClass, CLASSES } from "./vehicle-classes.ts";
import { clearDents } from "./loose-dent.ts";
import { REACH, type CarSurfaces } from "./car-surfaces.ts";
import type { CarCage } from "./car-cage.ts";
import { CageRig } from "./car-cage-rig.ts";
import { CLASS_HUBS, CLASS_LIFT, LID, FUEL_CUTOFF_G, SIDE_HIT_X, STALL_S } from "./constants.ts";

export { CAR_HALF, DOOR, WHEEL_POS };

const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _in = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _wantQuaternion = new THREE.Quaternion();
/** Where a `DeformableCar.flight` block holds each part: spin (3), pitch, yaw, roll (3), orientation quaternion (4), velocity (3), position (3), contact-end clocks (2), reach, squeeze flag, drift, the seconds the engine stays cut (`stalledS`), the weight borne on it by cars that stepped after it (6: `CarSurfaces.borneState`), what its wheels touch (`FLIGHT_CONTACT`: each wheel's contact, the wheels down, airborne, hard touch, yielding), a wreck's hub rise (`hubRise`, 5), its yaw inverse inertia (`invYaw`) and its rest timer (`restS`: at `WRECK_REST_S` it sleeps), the handbrake's grip and whether the boost was on (`drive.ebrakeK`, `drive.boostK`). */
export const FLIGHT_EULER = 3;
const FLIGHT_QUATERNION = 6;
export const FLIGHT_VELOCITY = 10;
export const FLIGHT_POSITION = 13;
const FLIGHT_END_AGO = 16;
const FLIGHT_END_REACH = 18;
const FLIGHT_END_SQUEEZE = 19;
const FLIGHT_DRIFT = 20;
const FLIGHT_STALL = 21;
const FLIGHT_BORNE = 22;
const FLIGHT_CONTACT = 28;
const FLIGHT_DOWN = FLIGHT_CONTACT + 4 * HIT_SIZE;
const FLIGHT_INV_YAW = FLIGHT_DOWN + 4;
const FLIGHT_REST = FLIGHT_INV_YAW + 1;
const FLIGHT_RAMPS = FLIGHT_REST + 1;
export const FLIGHT = FLIGHT_RAMPS + 2;
/** A wreck rests this long (s) before it sleeps: a toppling pile pauses on the way over, and a monster settling on a bank creeps to its pose for most of a second after it first slows under `REST_SPEED`. */
const WRECK_REST_S = 1;
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
  /** Seconds the engine stays cut after a side hit (`stallOnSideHit`): `applyDrive` counts it down and gives no drive meanwhile. */
  stalledS = 0;
  /** Moved by the rigid contact solve (`stepFree`), not by its crush masses: derived, never stored. `velocity` is then its centre of mass's. */
  get rigid(): boolean {
    return !this.deform.massActive;
  }
  /** Faster than rest (`REST_SPEED`, m/s or rad/s) in translation or spin: what wakes a neighbour (`wakePair`) and what a sleeper's `stirNear` sees of a car top. */
  get moving(): boolean {
    const v = this.velocity;
    const w = this.angular;
    const r2 = REST_SPEED * REST_SPEED;
    return v.x * v.x + v.y * v.y + v.z * v.z >= r2 || w.x * w.x + w.y * w.y + w.z * w.z >= r2;
  }
  private cageRig: CageRig | null = null;
  /** The car's contact shape: its drawn body (`CarCage`), fitted by `refitCage`. */
  get cage(): CarCage {
    return (this.cageRig ??= new CageRig(this)).cage;
  }
  /** The cage's fields changed since a caller last asked (`refitCage`). */
  private cageChanged = false;
  /** Fits the cage to the body as the sim last baked its skin (`stepBreakage`: every step of a crush window); a car never baked, or just reset or restored from the net, gets its style's shared shape.
   *  Answers whether its fields changed since the last answer (`CarCage.refit`: not for a mass within `REFIT_EPSILON` of the last raster). Never solves the skin: drawing cannot reach the cage. */
  refitCage(): boolean {
    if (this.deform.cageDue) this.fitCage();
    const changed = this.cageChanged;
    this.cageChanged = false;
    return changed;
  }
  /** The cage fitted to the last bake (or to rest: never baked, the masses sit at rest and the skin tables are empty, so the body is its style's shared shape). */
  private fitCage(): void {
    const rig = (this.cageRig ??= new CageRig(this));
    this.deform.cageDue = false;
    const exact = this.deform.cageExact;
    this.deform.cageExact = false;
    if (this.deform.skinBaked ? rig.refit(exact) : rig.cage.reset()) this.cageChanged = true;
  }
  /** Numbers in a keyframe's solver state of this car: the deform's (`StreamedDeformation.simSize`) and its cage's fit history (`CarCage.stateSize`). */
  solverSize(): number {
    return this.deform.simSize() + (this.cageRig ??= new CageRig(this)).cage.stateSize();
  }
  /** The car's solver state into `buf` (`solverSize()` numbers), or with `write` restored from it: the deform's, then the cage's refit history (a restored car's cage is the recorded one, bit for bit). */
  solverState(buf: Float64Array, write: boolean): void {
    const rig = (this.cageRig ??= new CageRig(this));
    const n = this.deform.simSize();
    this.deform.simState(buf, write);
    const own = buf.subarray(n, n + rig.cage.stateSize());
    if (write) {
      rig.cage.readState(own);
      this.cageChanged = true;
    } else rig.cage.writeState(own);
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
  /** The yaw inverse inertia per unit mass (`wreckInvI`) the last wreck step had; 0 off the masses. */
  private invYaw = 0;
  /** The drawn body's load transfer over the physics body, and its wheels' seats (drawn only). */
  readonly suspension = new Suspension();
  private classBody: THREE.Object3D | null = null;

  spawn(x: number, z: number, speed: number): void {
    this.resetVisual();
    this.group.position.set(x, 0, z);
    this.group.lookAt(0, 0, 0);
    this.refreshBasis();
    this.placeAt(x, z, Math.atan2(this.forward.x, this.forward.z), speed, this.forward);
  }

  /** `keepTorn`: the parts and wheels already off the car stay in the world where they lie (a held reset), not back on it (`resetVisual`). */
  spawnFacing(x: number, z: number, yaw: number, speed: number, keepTorn = false): void {
    this.resetVisual(keepTorn);
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
    this.stalledS = 0;
    this.crashed = false;
    this.resetContact();
    this.suspension.reset();
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(dir).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
    this.settleCasters();
  }

  resetVisual(keepTorn = false): void {
    this.wake();
    this.vaporized = false;
    this.falling = false;
    this.driverOut = null;
    this.group.scale.setScalar(1);
    this.deform.reset();
    // Before the rest restores below: a dent's saved copy may be a crumpled skin the rest restore then overwrites.
    for (const p of this.parts) if (!keepTorn || !p.detached) clearDents(p.dent);
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
      if (keepTorn && loose.loose) continue;
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
      if (keepTorn && p.detached) continue;
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
  /** `impulse` is the closing speed (FX, glass); `ebs` the equivalent barrier speed that sizes the crush. The first hit starts the crash; on a wreck a fresh, hard enough contact re-arms a new hit (`rearmHit`). Returns whether the hit armed. */
  applyImpact(worldPoint: THREE.Vector3, worldInward: THREE.Vector3, impulse: number, ebs: number): boolean {
    const rigid = this.rigid;
    if (rigid) {
      // A rigid body (`stepFree`) takes the hit on its masses: its centre's velocity carried to the group's origin, as `land` does, and a wreck's masses keep their dents. Its masses fly it on (`syncPose`)
      // and hand it back to `stepFree` once their contact window closes; left rigid, nothing ever landed it and its drive stayed idled (8 s, stopped, on the stunt course).
      this.velocity.sub(_v.crossVectors(this.angular, _p.set(0, COM_Y, 0).applyQuaternion(this.group.quaternion)));
      if (this.crashed) {
        this.deform.armMasses(this.group, this.velocity, this.angular);
        this.deform.unstep(this.flewDt);
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
      if (!this.deform.rearmHit(localP, localN, impulse, ebs)) return false;
      this.bodyMat.roughness = Math.max(this.bodyMat.roughness, rough);
    } else {
      this.crashed = true;
      this.ride(0);
      this.deform.beginCrush(localP, localN, impulse, ebs, this.group, this.velocity, this.angular);
      if (rigid) {
        this.deform.unstep(this.flewDt);
      }
      this.bodyMat.roughness = rough;
    }
    this.stallOnSideHit(localN, ebs);
    this.deform.markMotion();
    this.deform.impulseAt(worldPoint, _in, impulse);
    this.deform.takeMotion(this.velocity, this.angular);
    return true;
  }

  /** A side hit past the crash sensor's average deceleration (`FUEL_CUTOFF_G`) cuts the fuel for `STALL_S` seconds (`applyDrive` gives no drive until then); a hit already on the books does not extend it. */
  private stallOnSideHit(localInward: THREE.Vector3, ebs: number): void {
    if (Math.abs(localInward.x) < SIDE_HIT_X) return;
    const decel = (ebs * ebs) / (2 * Math.max(0.05, this.deform.hitStroke()));
    if (decel >= FUEL_CUTOFF_G * FRICTION_G && this.stalledS <= 0) this.stalledS = STALL_S;
  }

  syncPose(dt: number): void {
    this.deform.followGroup(this.group, this.velocity, this.angular, dt);
    this.yaw = this.group.rotation.y;
    this.roll = this.group.rotation.z;
    this.pitch = this.group.rotation.x;
    this.refreshBasis();
  }

  /**
   * What a netplay pose rounds or leaves out, `FLIGHT` doubles into `buf` at `o`, or with `write` from it: the spins, the Euler angles the drive turns and the quaternion the rigid step turns (each the other's derived copy only up to rounding; the drive reads the heading off the quaternion before it sets it from the Euler), velocity and position whole (the wire rounds them: a first impact 0.5 m/s off), the squeeze clocks, the drift state, the weight a rider that stepped after this car left has borne on it (the step's input as much as the velocity is) and a wreck's rest timer (set last: a wreck that was asleep sleeps again where it lies). What the body touches is read again (`restoreContact`).
   */
  flight(buf: Float64Array, o: number, write: boolean): void {
    if (write) {
      this.wake();
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
      this.stalledS = buf[o + FLIGHT_STALL]!;
      this.drive.ebrakeK = buf[o + FLIGHT_RAMPS]!;
      this.drive.boostK = buf[o + FLIGHT_RAMPS + 1]!;
      this.surfaces?.borneState(this.slot, buf, o + FLIGHT_BORNE, true);
      this.restoreContact();
      this.contact(buf, o, true);
      this.invYaw = buf[o + FLIGHT_INV_YAW]!;
      this.restS = buf[o + FLIGHT_REST]!;
      if (this.restS >= WRECK_REST_S) {
        this.asleep = true;
        this.sleepX = this.group.position.x;
        this.sleepZ = this.group.position.z;
      }
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
    buf[o + FLIGHT_STALL] = this.stalledS;
    if (this.surfaces) this.surfaces.borneState(this.slot, buf, o + FLIGHT_BORNE, false);
    else buf.fill(0, o + FLIGHT_BORNE, o + FLIGHT_BORNE + 6);
    this.contact(buf, o, false);
    buf[o + FLIGHT_INV_YAW] = this.invYaw;
    buf[o + FLIGHT_REST] = this.restS;
    buf[o + FLIGHT_RAMPS] = this.drive.ebrakeK;
    buf[o + FLIGHT_RAMPS + 1] = this.drive.boostK;
  }

  /**
   * The wheel contacts the last rigid slice left (`wheelHit`, shifted by that slice's lift, and what was derived from them) as the
   * flight block holds them, or with `write` put back from it. The drive of the next step reads them (the wheels it grips with), and
   * a fresh read of the pose (`restoreContact`) is not them: a car on another's roof had one wheel less.
   */
  contact(buf: Float64Array, o: number, write: boolean): void {
    const at = o + FLIGHT_CONTACT;
    const down = o + FLIGHT_DOWN;
    if (!write) {
      buf.set(this.wheelHit, at);
      buf[down] = this.wheelsDown;
      buf[down + 1] = this.airborne ? 1 : 0;
      buf[down + 2] = this.hardTouch ? 1 : 0;
      buf[down + 3] = this.yielding ? 1 : 0;
      return;
    }
    this.wheelHit.set(buf.subarray(at, at + 4 * HIT_SIZE));
    this.wheelsDown = buf[down]!;
    this.airborne = buf[down + 1] !== 0;
    this.hardTouch = buf[down + 2] !== 0;
    this.yielding = buf[down + 3] !== 0;
  }

  /** A wreck flying as a rigid body (`stepFree`) with three wheels on the world goes back to its masses (`armed`), taking its centre's velocity less the spin's carry (a body crushed only by a load has no masses and stands on its wheels). */
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

  afterContacts(dt: number): void {
    this.flewDt = 0;
    this.endAgo[0] += dt;
    this.endAgo[1] += dt;
    const d = this.deform;
    if (this.endSqueeze && Math.max(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) {
      this.endSqueeze = false;
      d.bidirectional = false;
      d.deepCrush = false;
    }
    if (this.endReach < Infinity && d.quietTime() > REARM_QUIET_S && Math.min(this.endAgo[0]!, this.endAgo[1]!) > END_WINDOW) this.endReach = Infinity;
    if (!this.doorParts[0]!.swing!.latched || !this.doorParts[1]!.swing!.latched) this.swingDoors(dt);
    else this.sampleMotion();
  }

  /** Shared crash rule for every contact path (car-car, press, pistons): `end` (+1 front, −1 rear) is being struck, the striker's face `reach` m from the car's centre along its length.
   *  Both ends struck within `END_WINDOW` is a squeeze: both become crumple zones (`bidirectional`), and a face inboard of the wheel centres lets the cage yield (`deepCrush`). Both clear after `REARM_QUIET_S` of quiet. */
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

  /**
   * A wreck is the rigid body's (`stepFree`): the masses' motion relative to the body is the crush (`moveRelative`), the body steps, and the masses are carried to where it put them. Its wheels, ride and loose parts step once per slice, here.
   * A wreck at rest (`asleep`) skips the rigid step until it is moved (`wake`, or a velocity written to it) or something that moves comes within `REACH` of where it lies (`stirNear`); its drawn ride goes on settling.
   */
  private integrateWreck(dt: number): void {
    if (this.asleep) {
      const v = this.velocity;
      const w = this.angular;
      if (v.x * v.x + v.y * v.y + v.z * v.z + w.x * w.x + w.y * w.y + w.z * w.z === 0 && !stirNear(this.sleepX, this.sleepZ, REACH, this.slot, this.surfaces?.cars ?? null)) {
        this.nudgeWheels(dt);
        this.ride(dt);
        this.stepLooseParts(dt, this.slot);
        return;
      }
      this.wake();
    }
    const g = this.group;
    const ms = this.deform.masses;
    g.updateWorldMatrix(false, false);
    _c.copy(wreckCentre(this)).applyMatrix4(g.matrixWorld);
    this.deform.moveRelative(dt, this.velocity, this.angular, _c);
    const toLocal = _m.copy(g.matrixWorld).invert();
    for (const m of ms) m.local.copy(m.world).applyMatrix4(toLocal);
    const centre = wreckCentre(this);
    _c.copy(centre).applyMatrix4(g.matrixWorld);
    for (const m of ms) {
      _r.copy(m.world).sub(_c);
      m.vel.sub(this.velocity).sub(_v.crossVectors(this.angular, _r));
    }
    // Crush moves the masses in or out, so the wreck's yaw inertia changes: its spin keeps the angular momentum.
    if (this.invYaw > 0 && wreckInvI.y > 0) this.angular.y *= wreckInvI.y / this.invYaw;
    this.invYaw = wreckInvI.y;
    this.flewDt = dt;
    stepFree(this, dt);
    const rest = !this.moving;
    if (!this.deform.crushing && this.contacts >= 3 && rest) {
      if ((this.restS += dt) >= WRECK_REST_S) {
        this.velocity.set(0, 0, 0);
        this.angular.set(0, 0, 0);
        this.asleep = true;
        this.sleepX = g.position.x;
        this.sleepZ = g.position.z;
      }
    } else this.restS = 0;
    this.yaw = g.rotation.y;
    this.pitch = g.rotation.x;
    this.roll = g.rotation.z;
    g.updateWorldMatrix(false, false);
    _c.copy(centre).applyMatrix4(g.matrixWorld);
    for (const m of ms) {
      m.world.copy(m.local).applyMatrix4(g.matrixWorld);
      _r.copy(m.world).sub(_c);
      m.vel.add(this.velocity).add(_v.crossVectors(this.angular, _r));
    }
    this.refreshBasis();
    this.nudgeWheels(dt);
    this.ride(dt);
    this.stepLooseParts(dt, this.slot);
  }

  /** One step of the rigid body, its wheels' and its loose parts' flight (`stepLooseParts`, on every path it takes). */
  integrate(dt: number): void {
    if (this.vaporized) return;
    if (this.deform.massActive) {
      this.integrateWreck(dt);
      return;
    }
    this.invYaw = 0;
    if (!this.falling) this.spinWheels(dt, !this.airborne);
    this.flewDt = dt;
    const landed = stepFree(this, dt);
    if (this.falling) {
      this.stepLooseParts(dt, this.slot);
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
    this.stepLooseParts(dt, this.slot);
  }

  /** One fixed step of what the crash does to the car's parts (`settleStep`): sensors follow the masses, hinges move, parts tear off, lamps break, glass cracks.
   *  Drawing never decides any of it: at 60, 144 or 240 Hz the same crash tears the same parts at the same step, and a replay re-running the steps does too. */
  stepBreakage(dt: number): void {
    if (this.vaporized || this.falling) return;
    this.deform.stepCrush(dt);
    if (this.crashed) {
      this.syncAttachedParts(dt);
      this.evaluateBreakage(this.deform.impulseValue, dt);
    }
    // The cage takes the bake of this step with the parts as this step left them: a pure function of the sim's state.
    if (this.deform.cageDue && this.deform.skinBaked) this.fitCage();
  }

  /** Between two slices of one `stepWorld` step: a crushing car's sensors read and skin bake (`stepCrushSlice`), then its cage is fitted from the bake, as `stepBreakage` does when the step ends. */
  bakeBetweenSlices(h: number): void {
    if (this.vaporized || this.falling || !this.deform.massActive) return;
    if (this.deform.stepCrushSlice(h)) this.fitCage();
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
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      if (this.looseWheels[i]!.loose) continue;
      const rest = WHEEL_POS[i]!;
      if (!this.deform.massActive) {
        w.position.set(rest[0], rest[1], rest[2]);
        continue;
      }
      const hub = this.deform.massLocal(hubs[i]!);
      if (!this.deform.hubPopped(hubs[i]!)) {
        // Follows its hub along the car (a face's shove, or a squeeze past the hubs, moves it off rest) at the rest ride's height, where
        // the body's tyre rows hold it (`stepFree`).
        w.position.set(hub.x, rest[1], hub.z);
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

  /** The meshes the crush skin writes (`updateSkin`): the body, the lids, the light bar and the skinned panes. */
  skinGeometries(): THREE.BufferGeometry[] {
    const geometries = [this.body.geometry, this.hood.geometry, this.trunk.geometry];
    if (this.lightBar) geometries.push(this.lightBar.geometry);
    for (const pane of this.glassPanes) if (pane.skin) geometries.push(pane.mesh.geometry);
    return geometries;
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
        // The host tore it off: this client throws its own copy (debris is per player; the host's pose is not sent).
        if (loose) {
          if (p.region) this.shellPose(p);
          this.detachPart(p, 0);
        } else {
          p.object.removeFromParent();
          if (p.region) this.closePanel(p);
          else if (p.name === "mirrorL") this.doorL.add(p.object);
          else if (p.name === "mirrorR") this.doorR.add(p.object);
          else this.group.add(p.object);
          p.detached = false;
        }
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
        else (this.group.getObjectByName(CLASS_HUBS) ?? this.group).add(w);
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

  /** Netplay client, every frame: wheels spin and ride their hubs as `afterContacts` does on the host; the torn parts fly in the client's own world (the wheels' poses come on the wire). */
  netFrame(dt: number): void {
    this.nudgeWheels(dt, false);
    this.ride(dt);
    this.flutterParts(dt);
    this.stepLooseParts(dt, this.slot, false);
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
    this.suspension.step(this.group, this.wheels, cls, lift, !this.crashed || this.deform.massActive, air, gone, this.wheelHit, dt, this.deform.massActive, this.drive.slide);
  }

  /** The class body the ride moves (`null` for a car with no class), found once. */
  private classBodyObject(): THREE.Object3D | null {
    return (this.classBody ??= this.group.getObjectByName(CLASS_LIFT) ?? null);
  }

  /**
   * Into `out` from index `n` on: the objects the ride writes every slice while they are on the car, its class body (heave, pitch and
   * roll from the load transfer, `Suspension.pose`) and the four wheels still on it (`seatWheels`). Returns the count past the last.
   */
  rideObjects(out: THREE.Object3D[], n: number): number {
    const body = this.classBodyObject();
    if (body) out[n++] = body;
    for (let i = 0; i < this.wheels.length; i++) if (!this.looseWheels[i]!.loose) out[n++] = this.wheels[i]!;
    return n;
  }

}

/**
 * Start the fake fall: the soft body stops (`massActive` off; its state is left as it is) and the car flies on as the rigid step
 * flies every body, off the world's ground, with the `angular` it has and the `velocity` it has at its own centre (`COM_Y`; a wreck's body
 * turned about its masses' centroid, so the spin carries the difference). `keepMotion`: a replay or netplay client has set the pose,
 * `velocity` and `angular` already.
 */
export function beginFakeFall(car: DeformableCar, keepMotion = false): void {
  if (car.deform.massActive && !keepMotion) {
    car.group.updateMatrixWorld(false);
    _p.copy(wreckCentre(car)).applyMatrix4(car.group.matrixWorld);
    _c.set(0, COM_Y, 0).applyQuaternion(car.group.quaternion).add(car.group.position);
    car.velocity.add(_v.crossVectors(car.angular, _c.sub(_p)));
  }
  car.deform.massActive = false;
  car.falling = true;
}

/**
 * A massless crashed car's slide after the hit (`CrashEngine.tickInner`): tyre-style friction on the group. A wreck on its masses
 * slides on the friction of its tyre rows and belly (`stepFree`). A driven car does not slide: its tyres are applyDrive's.
 */
export function bleedAfterSlide(car: DeformableCar, dt: number): void {
  if (!car.crashed || car.deform.massActive || ((car.drive.throttle !== 0 || car.drive.neutral) && car.deform.drivetrainAlive)) return;
  const q = car.deform.quietTime();
  const p = car.group.position;
  // × the course surface's friction where the wreck slides (1 on the flat sandbox ground).
  const mu = (q < 0.15 ? CRASH.muScuff : CRASH.muSlide * (1 + Math.min(1.4, q))) * activeGround().frictionAt(p.x, p.z, p.y);
  applyGroundFriction(car.velocity, dt, mu, true);
}
