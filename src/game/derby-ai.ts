import { leftoverCrumple } from "./physics-util.ts";
import { idleDrive, type DriveInput } from "./car-drive.ts";

export type AiCar = {
  id: number;
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  alive: boolean;
  /** 0 mint … 1 engine dead. */
  damage: number;
};

export type AiWorld = {
  radius: number;
  time: number;
};

/** Engine travel / leftover crumple → 0..1. Dead drivetrain is 1. */
export function engineDamage(alive: boolean, crumpleTravel: number): number {
  if (!alive) return 1;
  const leftover = leftoverCrumple(crumpleTravel);
  return Math.max(0, Math.min(1, 1 - leftover));
}

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function steerToward(yaw: number, desired: number): number {
  return Math.max(-1, Math.min(1, wrapPi(desired - yaw) * 1.35));
}

/**
 * Extremely basic derby brain:
 *  - hunt the nearest live rival
 *  - head-on only if we are healthier
 *  - otherwise reverse-ram or e-brake swipe the tail/flank in
 *  - peel off the bowl wall
 */
export function thinkDerby(self: AiCar, others: AiCar[], world: AiWorld): DriveInput {
  const out = idleDrive();
  if (!self.alive) return out;

  const r = Math.hypot(self.x, self.z);
  const wall = world.radius - 2.4;
  if (r > wall) {
    const inward = Math.atan2(-self.x, -self.z);
    out.steer = steerToward(self.yaw, inward);
    out.throttle = r > wall + 1.2 ? -0.4 : 0.55;
    return out;
  }

  let best: AiCar | null = null;
  let bestD = Infinity;
  for (const o of others) {
    if (!o.alive || o.id === self.id) continue;
    const d = Math.hypot(o.x - self.x, o.z - self.z);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  if (!best) {
    out.throttle = 0.35;
    out.steer = 0.15;
    return out;
  }

  const dx = best.x - self.x;
  const dz = best.z - self.z;
  const toFoe = Math.atan2(dx, dz);
  const away = Math.atan2(-dx, -dz);
  const bearing = wrapPi(toFoe - self.yaw);
  const healthyEnough = self.damage + 0.12 < best.damage;
  const close = bestD < 7.5;

  if (!healthyEnough && close && Math.abs(bearing) < 0.55) {
    // Don't donate the engine — peel and present the tail.
    out.throttle = -0.85;
    out.steer = steerToward(self.yaw, away);
    return out;
  }

  if (!healthyEnough && bestD < 11 && Math.abs(bearing) > 0.7 && Math.abs(bearing) < 2.2) {
    out.throttle = 0.55;
    out.steer = Math.sign(bearing) || 1;
    out.ebrake = true;
    return out;
  }

  if (healthyEnough) {
    out.throttle = close ? 0.95 : 0.8;
    out.steer = steerToward(self.yaw, toFoe);
    return out;
  }

  out.throttle = bestD < 9 ? -0.9 : 0.45;
  out.steer = steerToward(self.yaw, bestD < 9 ? away : toFoe + Math.sign(bearing || 1) * 0.9);
  return out;
}
