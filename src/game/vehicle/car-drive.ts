import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { blankIntent, readIntent, shapeDrive, type DriveFeel } from "./drive-input.ts";
import type { PadState } from "./gamepad.ts";
import { NO_FLOOR } from "../world/ground.ts";
import { floorUnder, gripUnder, hypot2 } from "../deform/physics-util.ts";
import { assists, carClass, carDrivability, CLASSES, HANDLING, type Assists, type Drivability } from "./vehicle-classes.ts";

/** Shared by derby AI and the player seat. */
export type DriveInput = {
  throttle: number;
  /** Yaw command: +1 swings the nose LEFT (CCW from above) whichever way the car rolls. */
  steer: number;
  brake: number;
  ebrake: boolean;
  boost: boolean;
};

const SEDAN = CLASSES.sedan;

/** Sedan figures (each class has its own in `CLASSES`) and the feel every class shares. */
export const DRIVE = {
  maxFwd: SEDAN.topSpeed,
  maxRev: SEDAN.revSpeed,
  brake: SEDAN.brake,
  turn: SEDAN.turn,
  /** Full-lock yaw with the handbrake up (× class turn). */
  ebrakeTurn: 1.8,
  /** Handbrake rolling drag (1/s). */
  ebrakeDrag: 0.22,
  /** Lift-off engine braking (× class brake). */
  coast: 0.45,
  /** Axle offset from the car origin (m) where each axle reads the ground's grip. */
  axle: 1.34,
  /** No slide starts below this forward speed (m/s). */
  slideSpeed: 6,
  /** A boost at full lock kicks a tail-happy class out above this forward speed (m/s): 0.55 × the old 18 m/s top. */
  boostSlideSpeed: 10,
  /** Extra yaw in a full unassisted slide (× steer yaw). */
  slideYaw: 0.75,
  /** Lateral grip kept in a full slide: arcade end, realistic end. */
  slideGrip: [0.75, 0.3] as const,
  /** Drift assist: how fast (1/s) the body angle chases its target in a slide. */
  slipGain: 6,
};

const _zero: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };

export function idleDrive(): DriveInput {
  return { ..._zero };
}

/** No input: zero `out` in place and return it (an AI driver's scratch input before it decides). */
export function clearDrive(out: DriveInput): DriveInput {
  out.throttle = 0;
  out.steer = 0;
  out.brake = 0;
  out.ebrake = false;
  out.boost = false;
  return out;
}

const _assist: Assists = { grip: 1, slipCap: 0, catchRate: 0, scrub: 0, selfRight: 0 };
const _dmg: Drivability = { stage: "healthy", power: 1, top: 1, pull: 0 };
/** applyDrive's ground: [0] the floor under the car, [1] front and [2] rear axle grip (`floorUnder`). */
const _ground = new Float64Array(3);
const _axle = new THREE.Vector3();
/** driveMasses' turn (cos, sin) and Δv (x, z): passed as doubles, all four were boxed per call. */
const _turn = new Float64Array(4);
/** [0]: the realism `_assist` was last filled for (NaN: never). */
const _assistFor = new Float64Array([NaN]);
/**
 * `pedals` in/out: in [0] throttle, [1] brake, [2] along, [3] muF, [4] muR, [5] top-speed scale, [6] dt; out [7] top,
 * [8] speed, [9] want, [10] spin, [11] lock. Doubles in a typed array: passed or returned out of line they boxed.
 */
const _pedal = new Float64Array(12);

/** No floor or no drivetrain: the pedals and tyre FX go idle (the drift state stays). */
function idleDriveState(d: DeformableCar["drive"]): void {
  d.throttle = 0;
  d.steer = 0;
  d.brake = 0;
  d.ebrake = false;
  d.spin = 0;
  d.lock = 0;
  d.slide = 0;
  d.boost = false;
}

/** applyDrive's pedals: speed along the nose (`_pedal` layout above). */
function pedals(k: (typeof CLASSES)[keyof typeof CLASSES], dmg: Drivability, input: DriveInput, boosting: boolean, io: Float64Array): void {
  const throttle = io[0]!;
  const brake = io[1]!;
  const along = io[2]!;
  const muF = io[3]!;
  const muR = io[4]!;
  const realism = HANDLING.realism;
  const dt = io[6]!;
  const top = throttle < 0 ? k.revSpeed : k.topSpeed * dmg.top * (boosting ? k.boostTop : 1) * io[5]!;
  let speed = along;
  let want = 0;
  let spin = 0;
  let lock = 0;
  if (input.ebrake || brake > 0) {
    let s = Math.abs(speed);
    if (input.ebrake) s *= Math.exp(-DRIVE.ebrakeDrag * dt);
    // Brake force is near constant: a linear stop, never weaker than lifting off.
    if (brake > 0) s = Math.max(0, s - k.brake * (0.55 + 0.45 * Math.min(muF, muR)) * Math.max(0.45, brake) * dt);
    speed = s < 0.4 ? 0 : Math.sign(speed) * s;
    // ABS hides most of the lock-up at the arcade end.
    if (brake > 0.7 && s > 3) lock = ((brake - 0.7) / 0.3) * ((1 - realism) * 0.45 + realism) * Math.min(1, s / 10);
  } else {
    want = throttle * top;
    const v = Math.abs(speed);
    let rate = k.brake * DRIVE.coast;
    if (Math.abs(want) > v) {
      // The gear this speed sits in; past the top gear's end (a boost) it keeps pulling in top. Its thrust runs
      // from the arcade punch to the sourced figures along the realism slider.
      let g = 0;
      while (g < k.gears.length - 1 && v >= k.gears[g]![0] * k.topSpeed) g++;
      const gear = k.gears[g]!;
      rate = (gear[1] + (gear[2] - gear[1]) * realism) * dmg.power * (boosting ? k.boostAccel : 1) * (0.4 + 0.6 * muR);
      if (throttle > 0.5 && along > -0.5) {
        spin = Math.max(v < 7 ? (1 - v / 7) * throttle * (0.35 + 0.65 * k.torque) * (boosting ? 1 : 0.7) : 0, (1 - muR) * throttle * 0.6);
      }
    }
    if (speed < want) speed = Math.min(want, speed + rate * dt);
    else speed = Math.max(want, speed - rate * dt);
  }
  io[7] = top;
  io[8] = speed;
  io[9] = want;
  io[10] = spin;
  io[11] = lock;
}

/**
 * Arcade drive, per class. Steer +1 swings the nose LEFT (+yaw with this
 * car's +Z forward) whichever way it rolls. The car's lateral grip is finite,
 * so a handbrake flick or full-throttle lock on a tail-happy class kicks the
 * tail out; the drift assist then holds the body angle while the gas and any
 * lock short of a hard counter-steer stay on, and catches it when released.
 * `HANDLING.realism` thins grip and assists and sharpens damage. Kinematic
 * until the first crash, then the same velocity change is pushed into every mass.
 * `topScale` raises the forward top speed (a race car drafting another, `DRAFT.top`).
 */
export function applyDrive(car: DeformableCar, input: DriveInput, dt: number, topScale = 1): void {
  if (dt <= 0) return;
  const d = car.drive;
  const p = car.group.position;
  // Off the fleet disc's rim nothing is under the tyres: the car keeps its ballistic velocity.
  const alive = car.deform.drivetrainAlive;
  if (alive) floorUnder(p, _ground, 0);
  if (!alive || _ground[0] === NO_FLOOR) return idleDriveState(d);
  const k = CLASSES[carClass(car)];
  const realism = HANDLING.realism;
  // assists() reads only realism, so it reruns when that changes: called out of line, it boxed realism per step.
  if (realism !== _assistFor[0]) {
    assists(realism, _assist);
    _assistFor[0] = realism;
  }
  const a = _assist;
  const dmg = carDrivability(car, realism, _dmg);
  // Math.max/min, not THREE's clamp and lerp (the same arithmetic): those calls spent TurboFan's inlining
  // budget here, and the ones it left out boxed their doubles.
  const throttle = Math.max(-1, Math.min(1, input.throttle));
  const steer = Math.max(-1, Math.min(1, input.steer));
  const brake = Math.max(0, Math.min(1, input.brake));
  const boosting = !!input.boost && throttle > 0;
  d.throttle = throttle;
  d.steer = steer;
  d.brake = brake;
  d.ebrake = input.ebrake;
  d.boost = boosting;

  car.refreshBasis();
  const fx0 = car.fwdFlat.x;
  const fz0 = car.fwdFlat.z;
  const vx = car.velocity.x;
  const vz = car.velocity.z;
  const along = vx * fx0 + vz * fz0;
  const lat0 = vx * fz0 - vz * fx0;
  const px = car.group.position.x;
  const pz = car.group.position.z;
  _axle.y = car.group.position.y;
  _axle.x = px + fx0 * DRIVE.axle;
  _axle.z = pz + fz0 * DRIVE.axle;
  gripUnder(_axle, _ground, 1);
  _axle.x = px - fx0 * DRIVE.axle;
  _axle.z = pz - fz0 * DRIVE.axle;
  gripUnder(_axle, _ground, 2);
  const muF = _ground[1]!;
  const muR = _ground[2]!;

  // Pedals: speed along the nose.
  _pedal[0] = throttle;
  _pedal[1] = brake;
  _pedal[2] = along;
  _pedal[3] = muF;
  _pedal[4] = muR;
  _pedal[5] = topScale;
  _pedal[6] = dt;
  pedals(k, dmg, input, boosting, _pedal);
  const top = _pedal[7]!;
  const speed = _pedal[8]!;
  const want = _pedal[9]!;
  const spin = _pedal[10]!;
  const lock = _pedal[11]!;

  // Wheel: yaw rate, slide state, damage pull.
  const v = Math.abs(speed);
  const grip = k.grip * a.grip * 0.5 * (muF + muR);
  let yawRate =
    steer * k.turn * (input.ebrake ? DRIVE.ebrakeTurn : 1) * (0.35 + Math.min(1, v / 8) * 0.65) * (0.45 + 0.55 * muF);
  // Body angle to the velocity, + = nose left of the path.
  const beta = Math.atan2(-lat0, Math.max(1, Math.abs(along)));
  const dir = beta > 0.02 ? 1 : beta < -0.02 ? -1 : Math.sign(steer);
  let target = 0;
  if (along > DRIVE.slideSpeed) {
    if (input.ebrake && Math.abs(steer) > 0.15) target = 1;
    // Boost dumps torque on the rear: tail-happy classes step out under it at full lock.
    else if (boosting && throttle > 0.7 && Math.abs(steer) > 0.6 && along > DRIVE.boostSlideSpeed) target = k.drift;
    // Held on the gas with lock either way short of a hard counter-steer.
    if (d.drift > 0.05 && throttle > 0.25 && Math.abs(steer) > 0.1 && steer * dir > -0.6) target = Math.max(target, d.drift);
  }
  // Loose classes (high `drift`) let a slide run on longer before it catches.
  const catchRate = a.catchRate * (1.25 - 0.5 * k.drift) * (steer * dir < -0.6 ? 2 : 1);
  if (target > d.drift) d.drift = Math.min(target, d.drift + 6 * dt);
  else d.drift = Math.max(target, d.drift - catchRate * dt);
  const drift = d.drift;
  const slideBite = grip * ((1 - realism) * DRIVE.slideGrip[0] + realism * DRIVE.slideGrip[1]);
  if (drift < 0.05 && v > 1) {
    // Gripping: the tyres cap the yaw rate (understeer at the realistic end).
    const cap = (grip * 1.05) / v;
    yawRate = Math.max(-cap, Math.min(cap, yawRate));
  } else if (drift >= 0.05) {
    yawRate *= 1 + DRIVE.slideYaw * drift;
    // Drift assist: steer sets the body angle (into the turn = deeper, counter = shallower), the yaw follows it.
    const aim = dir * a.slipCap * Math.max(0.1, Math.min(1, 0.55 + 0.45 * steer * dir)) * drift;
    const assisted = (dir * slideBite) / Math.max(v, 4) + (aim - beta) * DRIVE.slipGain;
    const most = k.turn * DRIVE.ebrakeTurn * (1 + DRIVE.slideYaw);
    const t = (1 - realism) * Math.min(1, drift * 2);
    yawRate = (1 - t) * yawRate + t * Math.max(-most, Math.min(most, assisted));
  }
  yawRate += dmg.pull * Math.min(1, v / 10);
  const dyaw = yawRate * dt;

  // New heading; velocity split along it.
  const c = Math.cos(dyaw);
  const s = Math.sin(dyaw);
  const fx = fx0 * c + fz0 * s;
  const fz = -fx0 * s + fz0 * c;
  let lon = vx * fx + vz * fz + (speed - along);
  const lat = vx * fz - vz * fx;
  const bite = (1 - drift) * grip + drift * slideBite;
  const latOut = lat - Math.sign(lat) * Math.min(Math.abs(lat), bite * dt);
  // In a drift the arcade end hands most of the bitten-off sideways speed back to the nose, so slides
  // keep their pace (never past top speed). Sideways speed from a shove is only scrubbed, never turned into a launch.
  if (drift > 0.05 && lon > 0.5 && Math.abs(beta) < a.slipCap + 0.2) {
    lon = Math.min(Math.max(lon, top), Math.sqrt(lon * lon + (1 - a.scrub) * (lat * lat - latOut * latOut)));
  }
  const nvx = fx * lon + fz * latOut;
  const nvz = fz * lon - fx * latOut;

  d.spin = spin;
  d.lock = lock;
  d.slide = Math.max(drift, Math.min(1, (3 * Math.abs(lat)) / Math.max(1, Math.abs(lon) + Math.abs(lat))));

  if (!car.deform.massActive) {
    car.yaw += dyaw;
    // Keep integrate's ground tilt: levelling here flattened a car on every slice above the ground (crest, lip, bank edge).
    car.group.rotation.set(car.pitch, car.yaw, car.roll, "YXZ");
    car.refreshBasis();
    // Vertical speed is the world's (ramps, jumps): drive only steers the ground-plane velocity.
    car.velocity.set(nvx, car.velocity.y, nvz);
    car.speed = hypot2(nvx, nvz);
    car.angular.set(0, yawRate, 0);
    return;
  }

  // Crashed: the masses carry the pose and followGroup re-measures yaw and
  // velocity from them, so writing angular.y alone never turned a wreck.
  // Yaw the body and push every mass: a cabin-only kick (kickCore) gets
  // averaged away by the unkicked crumple masses on a quiet wreck, and the
  // settle clamp then parks the car for good.
  if (want !== 0) car.deform.notifyPower();
  _turn[0] = c;
  _turn[1] = s;
  _turn[2] = nvx - vx;
  _turn[3] = nvz - vz;
  driveMasses(car.deform.masses, _turn);
  car.velocity.x = nvx;
  car.velocity.z = nvz;
  car.angular.y = yawRate;
  car.speed = car.velocity.length();
}

type DriveMass = {
  dynamic: boolean;
  mass: number;
  readonly world: { x: number; z: number };
  readonly vel: { x: number; z: number };
};

/** Rigid yaw (cos `turn[0]`, sin `turn[1]`) of every dynamic mass about their centre of mass, plus a shared Δv (`turn[2]`, `turn[3]`). */
function driveMasses(masses: readonly DriveMass[], turn: Float64Array): void {
  const c = turn[0]!;
  const s = turn[1]!;
  const ax = turn[2]!;
  const az = turn[3]!;
  let cx = 0;
  let cz = 0;
  let m = 0;
  for (let ni = 0; ni < masses.length; ni++) {
    const n = masses[ni]!;
    if (!n.dynamic) continue;
    cx += n.world.x * n.mass;
    cz += n.world.z * n.mass;
    m += n.mass;
  }
  if (m <= 1e-8) return;
  cx /= m;
  cz /= m;
  for (let ni = 0; ni < masses.length; ni++) {
    const n = masses[ni]!;
    if (!n.dynamic) continue;
    const dx = n.world.x - cx;
    const dz = n.world.z - cz;
    n.world.x = cx + dx * c + dz * s;
    n.world.z = cz - dx * s + dz * c;
    n.vel.x += ax;
    n.vel.z += az;
  }
}

export const BOOST = { full: 1.6, recharge: 4.5, takedown: 0.4 };

type SeatMode = "global" | "follow" | "drive";
export type SeatView = "third" | "far" | "first";
const VIEWS: readonly SeatView[] = ["third", "far", "first"];

/** Click (or LB/RB, Q/E) follows; a pedal or the wheel promotes follow → drive; Esc steps back one level. */
export class DriverSeat {
  mode: SeatMode = "global";
  view: SeatView = "third";
  carIndex = -1;
  boost = 1;
  /** This frame's merged keyboard + pad intent. */
  readonly intent = blankIntent();
  private readonly feel: DriveFeel = { wheel: 0, gas: 0, brake: 0 };
  private readonly out = idleDrive();
  private wasActive = false;
  private flippedFor = 0;
  /**
   * Controller-slot gate: when set, a pedal press only takes the wheel of a car it allows
   * (race mode: this browser's player car, never an AI or a remote peer's car).
   */
  drivable: ((index: number) => boolean) | null = null;

  focus(index: number): void {
    this.carIndex = index;
    this.mode = "follow";
  }

  /** Next (+1) / previous (-1) of `count` cars; from the whole field this starts following. */
  cycle(dir: number, count: number): void {
    if (count <= 0) return;
    const from = this.carIndex < 0 ? (dir > 0 ? -1 : 0) : this.carIndex;
    this.carIndex = (((from + dir) % count) + count) % count;
    if (this.mode === "global") this.mode = "follow";
  }

  /**
   * True once the driven car has sat on its roof or side (`upY`, the body's up·world-up, under 0.35), nearly
   * still, for the slider's self-right delay; the caller then rights it. The realistic end leaves it to R.
   */
  selfRight(upY: number, speed: number, dt: number): boolean {
    const wait = assists(HANDLING.realism, _assist).selfRight;
    if (this.mode !== "drive" || upY > 0.35 || speed > 2.5 || wait === Infinity) {
      this.flippedFor = 0;
      return false;
    }
    this.flippedFor += dt;
    if (this.flippedFor < wait) return false;
    this.flippedFor = 0;
    return true;
  }

  esc(): void {
    if (this.mode === "drive") {
      this.mode = "follow";
      return;
    }
    if (this.mode === "follow") {
      this.mode = "global";
      this.carIndex = -1;
    }
  }

  /**
   * Read this frame's keys + pad. True when a fresh pedal / wheel press just took the seat
   * from follow to drive (one still held through Esc or a car switch does not grab it back).
   */
  sample(keys: ReadonlySet<string>, pad: PadState | null): boolean {
    const i = readIntent(keys, pad, this.intent);
    if (this.mode !== "drive") {
      this.feel.wheel = 0;
      this.feel.gas = 0;
      this.feel.brake = 0;
    }
    const active = i.gas >= 0.05 || i.brake >= 0.05 || Math.abs(i.wheel) >= 0.05;
    const fresh = active && !this.wasActive;
    this.wasActive = active;
    if (!fresh || this.mode !== "follow" || this.carIndex < 0) return false;
    if (this.drivable && !this.drivable(this.carIndex)) return false;
    this.mode = "drive";
    return true;
  }

  cycleView(): void {
    this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]!;
  }

  step(dt: number): void {
    if (this.mode === "drive" && this.intent.boost && this.intent.gas > 0.05 && this.boost > 0) {
      this.boost = Math.max(0, this.boost - dt / BOOST.full);
    } else {
      this.boost = Math.min(1, this.boost + dt / BOOST.recharge);
    }
  }

  addBoost(amount: number): void {
    this.boost = Math.min(1, this.boost + amount);
  }

  /** Shaped input for one physics slice of the driven car (pooled: read it before the next call). */
  input(car: Pick<DeformableCar, "velocity" | "fwdFlat">, dt: number): DriveInput {
    const along = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
    shapeDrive(this.intent, this.feel, along, dt, this.out);
    this.out.boost = this.out.boost && this.boost > 0.02;
    return this.out;
  }

  clear(): void {
    this.mode = "global";
    this.carIndex = -1;
  }
}
