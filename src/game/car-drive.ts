import * as THREE from "three";
import type { DeformableCar } from "./car.ts";

/** Shared by derby AI now and a player seat (WASD / boost). */
export type DriveInput = {
  throttle: number;
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
  if (input.ebrake || brake > 0.2) {
    const drag = input.ebrake ? DRIVE.ebrakeDrag : THREE.MathUtils.lerp(DRIVE.coast, DRIVE.brake, brake);
    speed *= Math.pow(Math.max(0.04, 1 - drag * dt), 1);
    if (Math.abs(speed) < 0.4) speed = 0;
  } else {
    const want = throttle * max;
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
  } else {
    const dv = speed - along;
    car.velocity.x += car.fwdFlat.x * dv;
    car.velocity.z += car.fwdFlat.z * dv;
    car.angular.y = steer * turn;
    if (Math.abs(dv) > 1e-5) car.deform.kickCore(car.fwdFlat.x, 0, car.fwdFlat.z, dv);
    car.speed = car.velocity.length();
  }
}

export const BOOST = { full: 1.6, recharge: 4.5, takedown: 0.4 };

export type SeatMode = "global" | "follow" | "drive";
export type SeatView = "third" | "first";

/** Click follows. WASD promotes follow → drive. Esc steps back one level. */
export class DriverSeat {
  mode: SeatMode = "global";
  view: SeatView = "third";
  carIndex = -1;
  boost = 1;
  mouseIdle = 10;
  camYaw = 0;
  camPitch = 0.22;
  private boostHeld = false;

  focus(index: number): void {
    this.carIndex = index;
    this.mode = "follow";
    this.view = "third";
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

  poke(keys: ReadonlySet<string>): void {
    const drive =
      keys.has("KeyW") || keys.has("KeyA") || keys.has("KeyS") || keys.has("KeyD") || keys.has("Space");
    if (this.mode === "follow" && drive && this.carIndex >= 0) this.mode = "drive";
    this.boostHeld = keys.has("ShiftLeft") || keys.has("ShiftRight");
  }

  toggleView(): void {
    this.view = this.view === "third" ? "first" : "third";
  }

  nudgeLook(dx: number, dy: number): void {
    this.camYaw -= dx * 0.0045;
    this.camPitch = Math.max(-0.55, Math.min(0.85, this.camPitch - dy * 0.003));
    this.mouseIdle = 0;
  }

  step(dt: number): void {
    this.mouseIdle += dt;
    if (this.mode === "drive" && this.boostHeld && this.boost > 0) {
      this.boost = Math.max(0, this.boost - dt / BOOST.full);
    } else {
      this.boost = Math.min(1, this.boost + dt / BOOST.recharge);
    }
    if (this.mouseIdle > 0.35) {
      const k = 1 - Math.exp(-3.4 * dt);
      this.camYaw += -this.camYaw * k;
    }
  }

  addBoost(amount: number): void {
    this.boost = Math.min(1, this.boost + amount);
  }

  input(keys: ReadonlySet<string>): DriveInput {
    const throttle = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
    const steer = (keys.has("KeyA") ? 1 : 0) - (keys.has("KeyD") ? 1 : 0);
    const brake = this.mode === "drive" && keys.has("Space") ? 1 : 0;
    return {
      throttle: this.mode === "drive" ? throttle : 0,
      steer: this.mode === "drive" ? steer : 0,
      brake,
      ebrake: brake > 0 && Math.abs(steer) > 0.2,
      boost: this.mode === "drive" && this.boostHeld && this.boost > 0.02 && throttle > 0,
    };
  }

  clear(): void {
    this.mode = "global";
    this.carIndex = -1;
    this.view = "third";
    this.camYaw = 0;
  }
}
