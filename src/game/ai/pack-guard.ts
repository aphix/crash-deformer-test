import type { DriveInput } from "../vehicle/car-drive.ts";
import type { AiCar } from "./derby-ai.ts";
import { clamp } from "../kernel/scalar.ts";
import { classStats } from "../vehicle/vehicle-classes.ts";

/** Seconds ahead a police car looks for a pack-mate on its path; the guard has the wheel from half of it on. */
const HORIZON = 3;
/** Seconds from the hit within which the guard also brakes. */
const BRAKE_TIME = 1.5;
/** Metres between two cars' centres at their closest approach: under `CLEAR` the guard acts in full, between `CLEAR` and `SOFT` it fades out. A car is 1.9 × 4.6 m (broadside they touch at 3.3 m); the pursuit steer pulls a car back toward its mate, so it settles near the middle. */
const CLEAR = 4.6;
const SOFT = 5.2;
/** A mate that may pull out (just woken, not yet up to speed) is read as moving at least this fast (m/s) along its nose when slower: a stopped one may be pulling out (a woken stakeout is at 8 m/s within a second). */
const MOVING = 8;
/** Seconds a steer already on the wheel is read as held, to see whether it carries the car clear of a mate (a driver re-decides every frame; this is only how far ahead its present steer is believed). */
const STEER_HOLD = 0.5;
/** A mate slower than this (m/s) is stopped. */
const STOPPED = 1;
const SEDAN = classStats("sedan");

/**
 * The one rule every police drive (lead-in, attack, open-ground hunt) ends with: do not drive into a pack-mate. Every unit
 * `first … first + count − 1` is read as it moves, except that one `pullsOut(unit)` says is driving and slow (just woken, not yet
 * up to speed: it is read as moving at 8 m/s along its nose) — a unit parked at a stakeout, knocked out or stored cannot pull out
 * until something wakes it, so it is read as the stopped obstacle it is (read as a phantom car coming at 8 m/s it bent a lead-in
 * that was clear; not read at all, a lead-in drove into one 12 m ahead at 16 m/s). The mate `self` would reach soonest within
 * `HORIZON` s (relative motion; closest approach under `SOFT` m), a mate ahead of it before any other (one grazing alongside or
 * behind took the steer straight into the one ahead), is steered away from, to the side that mate passes on (a dead-centre
 * meeting turns both cars the same way, so they pass), the sooner and squarer the harder, and within `BRAKE_TIME` s of the hit,
 * when it is ahead, braked for, the boost dropped. A mate the steer already on the wheel (held `STEER_HOLD` s) takes the car clear of
 * is not read. A car that is stopped or reversing is left alone; a braking one still rolling forward is not. No allocation.
 */
export function guardMates(self: AiCar, cars: readonly AiCar[], first: number, count: number, out: DriveInput, pullsOut: (unit: number) => boolean, turn = SEDAN.turn, grip = SEDAN.grip): void {
  const fx = Math.sin(self.yaw);
  const fz = Math.cos(self.yaw);
  // A car that is reversing, or stopped (parked, knocked out), is left alone; one that is braking while still rolling forward is not: a lifted
  // throttle or a brake for the target (`attackTarget`) hits a mate as hard as a driven one, and bypassed it hit pack-mates at 11-19 m/s.
  if (out.throttle < 0 || (out.throttle === 0 && self.vx * fx + self.vz * fz <= MOVING)) return;
  const speed = Math.hypot(self.vx, self.vz);
  const vx = speed < MOVING ? fx * MOVING : self.vx;
  const vz = speed < MOVING ? fz * MOVING : self.vz;
  // The car's yaw rate under the steer the drive asked for, as `applyDrive` turns it (full lock at `turn`, less below 8 m/s; tyres cap it at 1.05 grip / v).
  const v = Math.hypot(vx, vz);
  const cap = (1.05 * grip) / v;
  const omega = clamp(out.steer * turn * (0.35 + 0.65 * Math.min(1, v / 8)), -cap, cap);
  // The mate it reaches soonest steers it away; but one passing alongside or behind cannot be braked for, and read alone it hid the
  // mate dead ahead (the steer went away from the graze, straight into the one ahead), so a mate ahead is read first and the
  // soonest of all only when none is ahead.
  let tcAhead = HORIZON;
  let tcAny = HORIZON;
  let uAhead = 0;
  let uAny = 0;
  let awayAhead = 0;
  let awayAny = 0;
  let hardAhead = 0;
  for (let k = 0; k < count; k++) {
    const m = cars[first + k]!;
    if (m.id === self.id) continue;
    const rx = m.x - self.x;
    const rz = m.z - self.z;
    const phantom = Math.hypot(m.vx, m.vz) < MOVING && pullsOut(k);
    const wx = (phantom ? Math.sin(m.yaw) * MOVING : m.vx) - vx;
    const wz = (phantom ? Math.cos(m.yaw) * MOVING : m.vz) - vz;
    const dot = rx * wx + rz * wz;
    // Only a mate it is closing on counts: one already touching and moving apart is left to the physics.
    if (dot >= 0) continue;
    const tc = Math.min(HORIZON, -dot / (wx * wx + wz * wz));
    if (tc >= tcAny && tc >= tcAhead) continue;
    const px = rx + wx * tc;
    const pz = rz + wz * tc;
    const gap = Math.hypot(px, pz);
    if (gap >= SOFT) continue;
    let hard = clamp((SOFT - gap) / (SOFT - CLEAR), 0, 1);
    // Against a mate that is stopped, the steer already on the wheel, held for `STEER_HOLD` s and then straight on, may take the car clear of it by
    // the time it is there: then the guard has nothing to add (read on a straight line, it cancelled a steer that was bending the car back to its road,
    // away from the stakeout parked beside it). Not against a mate that moves: it steers too, usually the same way (a pack aimed at one target), and
    // both then read themselves clear of each other and met.
    if (omega !== 0 && !phantom && Math.hypot(m.vx, m.vz) < STOPPED) {
      const tau = Math.min(tc, STEER_HOLD);
      const a = omega * tau;
      const rest = v * (tc - tau);
      const dn = (v / omega) * (1 - Math.cos(a)) + rest * Math.sin(a);
      const df = (v / omega) * Math.sin(a) - v * tau + rest * (Math.cos(a) - 1);
      hard = Math.min(hard, clamp((SOFT - Math.hypot(px * fx + pz * fz - df, px * fz - pz * fx - dn)) / (SOFT - CLEAR), 0, 1));
    }
    if (hard === 0) continue;
    const u = clamp(2 * (1 - tc / HORIZON), 0, 1) * hard;
    // Away from the side the mate passes on: positive when it passes where steer > 0 turns toward.
    const away = px * fz - pz * fx >= 0 ? -u : u;
    if (tc < tcAny) {
      tcAny = tc;
      uAny = u;
      awayAny = away;
    }
    if (tc < tcAhead && rx * fx + rz * fz > 0) {
      tcAhead = tc;
      uAhead = u;
      awayAhead = away;
      hardAhead = hard;
    }
  }
  if (tcAny >= HORIZON) return;
  const ahead = tcAhead < HORIZON;
  const blend = ahead ? uAhead : uAny;
  out.steer = clamp(out.steer * (1 - blend) + (ahead ? awayAhead : awayAny), -1, 1);
  if (ahead && tcAhead < BRAKE_TIME) {
    const b = (1 - tcAhead / BRAKE_TIME) * hardAhead;
    out.throttle *= 1 - b;
    // The drive brakes at 0.45 of full at the lightest touch of the pedal, so only a real stop touches it.
    if (b > 0.5) out.brake = Math.max(out.brake, b);
    // The boost is dropped for a predicted hit (closest approach under 4.9 m), however far off it is yet: it multiplies the thrust of the
    // throttle left, and a lead-in pair 9 m apart boosted into each other at 15 m/s² while the throttle was only lifted to 0.7. Not for a
    // graze (a pack queued in rows has a mate passing a few metres off in most frames): a boost dropped there left the pack slower than
    // a player at 45 m/s, who ran off the end of the map with no cop near.
    if (hardAhead > 0.5) out.boost = false;
  }
}
