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

/** Stable for ~1.1 s, then a new coin flip. Breaks mirror orbits. */
function roll(id: number, time: number): number {
  const bucket = Math.floor(time / 1.1);
  const x = Math.sin(id * 127.1 + bucket * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Extremely basic derby brain:
 *  - hunt the nearest live rival
 *  - head-on only if we are healthier
 *  - otherwise reverse-ram or e-brake swipe the tail/flank in
 *  - if the choice is a tie, pick one at random instead of mirroring
 *  - otherwise drive at open space until a rear or flank line shows up
 *  - peel off the bowl wall
 */
export function thinkDerby(self: AiCar, others: AiCar[], world: AiWorld): DriveInput {
  const out = idleDrive();
  if (!self.alive) return out;

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

  const r = Math.hypot(self.x, self.z);
  const wall = world.radius - 2.4;
  if (r > wall - 0.5) {
    const inward = Math.atan2(-self.x, -self.z);
    const foeIn = best != null && Math.hypot(best.x, best.z) < r - 2.5;
    if (!foeIn) {
      const noseIn = Math.abs(wrapPi(inward - self.yaw)) < Math.PI * 0.5;
      if (noseIn) {
        out.throttle = 0.95;
        out.steer = steerToward(self.yaw, inward);
      } else {
        out.throttle = -0.9;
        out.steer = steerToward(self.yaw, inward + Math.PI);
      }
      return out;
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
  const coin = roll(self.id, world.time);
  const side = coin < 0.5 ? -1 : 1;
  const close = bestD < 6.2;
  const noseOn = Math.abs(bearing) < 0.65;
  const speed = Math.hypot(self.vx, self.vz);
  const healthyEnough = self.damage + 0.12 < best.damage;

  if (speed < 4 || (bestD < 8 && speed < 7 && !healthyEnough)) {
    out.throttle = -1;
    out.steer = side;
    out.brake = 0;
    out.ebrake = false;
    return out;
  }

  // Too fast and not pointed at them: the bowl turn radius is wider than the
  // ring, so a full-throttle orbit never meets. Scrub a little and cut across.
  if (!close && Math.abs(bearing) > 0.4 && speed > 10) {
    out.throttle = 0.55;
    out.brake = 0.25;
    out.ebrake = true;
    out.steer = steerToward(self.yaw, toFoe);
    return out;
  }

  if (healthyEnough) {
    out.throttle = close ? 0.95 : 0.85;
    out.steer = steerToward(self.yaw, toFoe);
    return out;
  }

  if (close && noseOn) {
    out.throttle = -0.95;
    out.steer = steerToward(self.yaw, away + side * 0.55);
    return out;
  }

  if (close && Math.abs(bearing) > 0.9 && Math.abs(bearing) < 2.5) {
    out.throttle = speed < 2.5 ? 0.85 : 0.45;
    out.steer = Math.sign(bearing) || side;
    out.ebrake = true;
    return out;
  }

  // Equal health, not a clean shot. Stay inside the bowl and don't mirror.
  if (coin < 0.28) {
    const flank = toFoe + side * (Math.PI / 2);
    let ox = self.x + Math.sin(flank) * 7;
    let oz = self.z + Math.cos(flank) * 7;
    const cr = Math.hypot(ox, oz) || 1;
    const lim = world.radius - 5;
    if (cr > lim) {
      ox *= lim / cr;
      oz *= lim / cr;
    }
    out.throttle = 0.9;
    out.steer = steerToward(self.yaw, Math.atan2(ox - self.x, oz - self.z));
    return out;
  }

  out.throttle = speed < 2 ? 1 : 0.85;
  out.steer = steerToward(self.yaw, toFoe + side * (bestD > 8 ? 0.22 : 0.55));
  return out;
}
