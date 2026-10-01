import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { blankIntent, readIntent, shapeDrive, type DriveFeel } from "./drive-input.ts";
import type { PadState } from "./gamepad.ts";

/** Shared by derby AI and the player seat. */
export type DriveInput = {
  throttle: number;
  /** Yaw command: +1 swings the nose LEFT (CCW from above) whichever way the car rolls. */
  steer: number;
  brake: number;
  ebrake: boolean;
  boost: boolean;
};

export const DRIVE = {
  maxFwd: 18,
  maxRev: 11,
  accel: 16,
  brake: 28,
  coast: 0.55,
  turn: 1.55,
  ebrakeTurn: 2.8,
  ebrakeDrag: 0.22,
  /** Lateral tire grip (m/s²) once crashed; the kinematic car has perfect grip. Full lock at top speed needs ~28. */
  grip: 20,
  /** A quiet wreck zeroes masses under ~0.28 m/s; a powered wheel breaks away past that (~30 ms of accel). */
  launch: 0.45,
};

const _zero: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };

export function idleDrive(): DriveInput {
  return { ..._zero };
}

/**
 * Bicycle-ish drive. A = steer +1 must increase yaw with this car's +Z forward
 * (chase-cam left). Used kinematic until the engine dies.
 */
export function applyDrive(car: DeformableCar, input: DriveInput, dt: number): void {
  if (dt <= 0) return;
  if (!car.deform.drivetrainAlive) {
    car.drive.throttle = 0;
    car.drive.steer = 0;
    car.drive.brake = 0;
    car.drive.ebrake = false;
    return;
  }
  const throttle = THREE.MathUtils.clamp(input.throttle, -1, 1);
  const steer = THREE.MathUtils.clamp(input.steer, -1, 1);
  const brake = THREE.MathUtils.clamp(input.brake, 0, 1);
  const boosting = !!input.boost && throttle > 0;
  car.drive.throttle = throttle;
  car.drive.steer = steer;
  car.drive.brake = brake;
  car.drive.ebrake = input.ebrake;

  car.refreshBasis();
  const along = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
  const max = (throttle < 0 ? DRIVE.maxRev : DRIVE.maxFwd) * (boosting ? 1.42 : 1);
  let speed = along;
  let want = 0;
  if (input.ebrake || brake > 0) {
    let s = Math.abs(speed);
    if (input.ebrake) s *= Math.exp(-DRIVE.ebrakeDrag * dt);
    // Brake force is near constant: a linear stop, never weaker than lifting off.
    if (brake > 0) s = Math.max(0, s - DRIVE.brake * Math.max(0.45, brake) * dt);
    speed = s < 0.4 ? 0 : Math.sign(speed) * s;
  } else {
    want = throttle * max;
    const rate = (Math.abs(want) > Math.abs(speed) ? DRIVE.accel : DRIVE.brake * 0.45) * (boosting ? 1.55 : 1);
    if (speed < want) speed = Math.min(want, speed + rate * dt);
    else speed = Math.max(want, speed - rate * dt);
  }

  const turn = (input.ebrake ? DRIVE.ebrakeTurn : DRIVE.turn) * (0.35 + Math.min(1, Math.abs(speed) / 8) * 0.65);
  const dyaw = steer * turn * dt;
  if (!car.deform.massActive) {
    car.yaw += dyaw;
    car.group.rotation.set(0, car.yaw, 0, "YXZ");
    car.refreshBasis();
    car.velocity.set(car.fwdFlat.x * speed, 0, car.fwdFlat.z * speed);
    car.speed = Math.abs(speed);
    car.angular.set(0, steer * turn, 0);
    return;
  }

  // Crashed: the masses carry the pose and followGroup re-measures yaw and
  // velocity from them, so writing angular.y alone never turned a wreck.
  // Yaw the body and push every mass: a cabin-only kick (kickCore) gets
  // averaged away by the unkicked crumple masses on a quiet wreck, and the
  // settle clamp then parks the car for good.
  const c = Math.cos(dyaw);
  const s = Math.sin(dyaw);
  const fx = car.fwdFlat.x * c + car.fwdFlat.z * s;
  const fz = -car.fwdFlat.x * s + car.fwdFlat.z * c;
  if (Math.abs(want) >= DRIVE.launch && Math.abs(speed) < DRIVE.launch) speed = Math.sign(want) * DRIVE.launch;
  const dv = speed - (car.velocity.x * fx + car.velocity.z * fz);
  const lat = car.velocity.x * fz - car.velocity.z * fx;
  const grip = -Math.sign(lat) * Math.min(Math.abs(lat), DRIVE.grip * dt);
  const ax = fx * dv + fz * grip;
  const az = fz * dv - fx * grip;
  driveMasses(car.deform.masses, c, s, ax, az);
  car.velocity.x += ax;
  car.velocity.z += az;
  car.angular.y = steer * turn;
  car.speed = car.velocity.length();
}

type DriveMass = {
  dynamic: boolean;
  mass: number;
  readonly world: { x: number; z: number };
  readonly vel: { x: number; z: number };
};

/** Rigid yaw (cos c, sin s) of every dynamic mass about their centre of mass, plus a shared Δv. */
function driveMasses(masses: readonly DriveMass[], c: number, s: number, ax: number, az: number): void {
  let cx = 0;
  let cz = 0;
  let m = 0;
  for (const n of masses) {
    if (!n.dynamic) continue;
    cx += n.world.x * n.mass;
    cz += n.world.z * n.mass;
    m += n.mass;
  }
  if (m <= 1e-8) return;
  cx /= m;
  cz /= m;
  for (const n of masses) {
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

export type SeatMode = "global" | "follow" | "drive";
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
