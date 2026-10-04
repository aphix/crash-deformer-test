import type { DriveInput } from "../vehicle/car-drive.ts";
import type { AiCar } from "./derby-ai.ts";
import { clamp } from "../kernel/scalar.ts";

/** Seconds ahead a police car looks for a pack-mate on its path; the guard has the wheel from half of it on. */
const HORIZON = 3;
/** Seconds from the hit within which the guard also brakes. */
const BRAKE_TIME = 1.5;
/** Metres between two cars' centres at their closest approach: under `CLEAR` the guard acts in full, between `CLEAR` and `SOFT` it fades out. A car is 1.9 × 4.6 m (broadside they touch at 3.3 m); the pursuit steer pulls a car back toward its mate, so it settles near the middle. */
const CLEAR = 4.6;
const SOFT = 5.2;
/** A mate that is driving is read as moving at least this fast (m/s) along its nose: a stopped one may be pulling out (a woken stakeout is at 8 m/s within a second). */
const MOVING = 8;

/**
 * The one rule every police drive (lead-in, attack, open-ground hunt) ends with: do not drive into a pack-mate. Of the units
 * `first … first + count − 1` that `onRoad(unit)` says are out on the road (not parked at a stakeout or stored out of view: those
 * cannot pull out until something wakes them, and read as a phantom car coming at 8 m/s), the one `self` reaches soonest within
 * `HORIZON` s (relative motion; closest approach under `SOFT` m)
 * is steered away from, to the side it passes on (a dead-centre meeting turns both cars the same way, so they pass), and within
 * `BRAKE_TIME` s of the hit, when it is ahead, braked for. A car that is not driving forward (stopped, reversing, braking) is
 * left alone. No allocation.
 */
export function guardMates(self: AiCar, cars: readonly AiCar[], first: number, count: number, out: DriveInput, onRoad: (unit: number) => boolean): void {
  if (out.throttle <= 0) return;
  const fx = Math.sin(self.yaw);
  const fz = Math.cos(self.yaw);
  const speed = Math.hypot(self.vx, self.vz);
  const vx = speed < MOVING ? fx * MOVING : self.vx;
  const vz = speed < MOVING ? fz * MOVING : self.vz;
  let soonest = HORIZON;
  let lateral = 0;
  let miss = 0;
  let ahead = false;
  for (let k = 0; k < count; k++) {
    const m = cars[first + k]!;
    if (m.id === self.id || !onRoad(k)) continue;
    const rx = m.x - self.x;
    const rz = m.z - self.z;
    const slow = Math.hypot(m.vx, m.vz) < MOVING;
    const wx = (slow ? Math.sin(m.yaw) * MOVING : m.vx) - vx;
    const wz = (slow ? Math.cos(m.yaw) * MOVING : m.vz) - vz;
    const dot = rx * wx + rz * wz;
    // Only a mate it is closing on counts: one already touching and moving apart is left to the physics.
    if (dot >= 0) continue;
    const tc = Math.min(HORIZON, -dot / (wx * wx + wz * wz));
    if (tc >= soonest) continue;
    const px = rx + wx * tc;
    const pz = rz + wz * tc;
    const gap = Math.hypot(px, pz);
    if (gap >= SOFT) continue;
    soonest = tc;
    miss = gap;
    // Positive when the mate passes on the side that steer > 0 turns toward.
    lateral = px * fz - pz * fx;
    ahead = rx * fx + rz * fz > 0;
  }
  if (soonest >= HORIZON) return;
  const hard = clamp((SOFT - miss) / (SOFT - CLEAR), 0, 1);
  const u = clamp(2 * (1 - soonest / HORIZON), 0, 1) * hard;
  out.steer = clamp(out.steer * (1 - u) + (lateral >= 0 ? -u : u), -1, 1);
  if (ahead && soonest < BRAKE_TIME) {
    const b = (1 - soonest / BRAKE_TIME) * hard;
    out.throttle *= 1 - b;
    // The drive brakes at 0.45 of full at the lightest touch of the pedal, so only a real stop touches it.
    if (b > 0.5) out.brake = Math.max(out.brake, b);
  }
}
