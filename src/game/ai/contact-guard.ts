import type { DriveInput } from "../vehicle/car-drive.ts";
import { DERBY_RULES, type AiCar } from "./derby-ai.ts";
import { clamp } from "../kernel/scalar.ts";

/** Seconds ahead the guard looks for a contact, in steps of `STEP`. */
const HORIZON = 1.5;
const STEP = 0.1;
/** Half-axes (m) of the contact zone around a car, in its own frame (a car is 1.9 × 4.6 m: the zone is the car plus 0.5 m at the sides and 1.4 m at the ends). */
const LAT = 2.4;
const LON = 6;
/** Closing speed (m/s) at a contact that is a nudge, not a hit (3/4 of the derby's own hit threshold): a car edging round a stopped one is not held in front of it. */
const TAP = DERBY_RULES.hitSpeed * 0.75;
/** Sideways acceleration (m/s²) a car can steer away with. */
const STEER_ACC = 6;
/** The most the guard moves the wheel (of full lock): a nudge to clear a side-swipe, never a swerve off the road or the route. */
const STEER_CAP = 0.35;
/** A yaw rate (rad/s) under this is a straight line. */
const STRAIGHT = 1e-3;

/**
 * The look-ahead's sample times: 0 to `HORIZON` in steps of `STEP`, accumulated as the first version of the guard did. The last,
 * 1.5000000000000002 s, is not under `HORIZON`, so a contact first met there is not acted on: the guard acts on contacts within 1.4 s.
 */
const TIMES = sampleTimes();
const STEPS = TIMES.length;
/** Where the guarded car is (`DX`, `DZ`: its displacement), which way it points (`GX`, `GZ`) and how it moves (`VX`, `VZ`) at each sample time, filled once per call. */
const DX = new Float64Array(STEPS);
const DZ = new Float64Array(STEPS);
const GX = new Float64Array(STEPS);
const GZ = new Float64Array(STEPS);
const VX = new Float64Array(STEPS);
const VZ = new Float64Array(STEPS);

function sampleTimes(): Float64Array {
  const times: number[] = [];
  for (let t = 0; t <= HORIZON + 1e-9; t += STEP) times.push(t);
  return Float64Array.from(times);
}

/**
 * The last rule of every racing drive: do not drive into a car you are closing on. The guarded car is followed at its
 * speed round the arc its steer asks for (`turn`: yaw rate at full lock, rad/s), each car of `cars` (ids below `count`) that
 * is not `spare[id]` (the ones the driver means to hit) in the line it is driving, shedding speed at `lead` (m/s²: a driver
 * brakes for what it sees up the road, at the racing plan's own braking budget); `HORIZON` s on, the first moment the
 * guarded car and the other overlap, each wearing the contact zone, is the contact. The soonest contact is steered clear of
 * (by its off-centre share, or in full while there is time to move sideways out of the zone: `STEER_ACC`) and every contact
 * ahead that steering cannot clear is braked for, at the deceleration that takes the closing speed off, down to a `TAP`,
 * in the time left (`brake`, m/s²). A pair already touching and moving apart is left to the physics. No allocation.
 *
 * Cost: the guarded car's own arc is worked out once, and only when some other car is near enough to reach it: a pair
 * whose centres are further apart than the zone plus what the two cars can close in `HORIZON` s (their speeds added) cannot touch.
 */
export function guardContact(self: AiCar, cars: readonly AiCar[], count: number, spare: Uint8Array, brake: number, lead: number, turn: number, out: DriveInput): void {
  const nose = self.yaw;
  const sx = self.vx;
  const sz = self.vz;
  const speed = Math.hypot(sx, sz);
  // Under a nudge's speed it cannot start a hit, and a crawl is the plan's business (a creeping pair brawled on a wall).
  if (speed <= DERBY_RULES.hitSpeed) return;
  const heading = Math.atan2(sx, sz);
  const omega = out.steer * turn;
  const straight = Math.abs(omega) < STRAIGHT;
  const last = TIMES[STEPS - 1]!;
  let arc = false;
  let soonest = HORIZON;
  let lateral = 0;
  let offset = 0;
  let steerable = false;
  // The hardest braking any car ahead calls for, as a share of `brake`: the deceleration that takes its closing speed off in the time left.
  let need = 0;
  for (let k = 0; k < count; k++) {
    const o = cars[k]!;
    if (o.id === self.id || !o.alive || spare[o.id] === 1) continue;
    const ospeed = Math.hypot(o.vx, o.vz);
    // Out of reach: the two centres are further apart than the zone and the most they can close in `HORIZON` s.
    const gap = Math.hypot(o.x - self.x, o.z - self.z) - (speed + ospeed) * last;
    if (gap >= LON) continue;
    if (!arc) {
      arc = true;
      for (let i = 0; i < STEPS; i++) {
        const t = TIMES[i]!;
        const turned = omega * t;
        DX[i] = straight ? sx * t : (speed / omega) * (Math.cos(heading) - Math.cos(heading + turned));
        DZ[i] = straight ? sz * t : (speed / omega) * (Math.sin(heading + turned) - Math.sin(heading));
        GX[i] = Math.sin(nose + turned);
        GZ[i] = Math.cos(nose + turned);
        VX[i] = straight ? sx : speed * Math.sin(heading + turned);
        VZ[i] = straight ? sz : speed * Math.cos(heading + turned);
      }
    }
    // `prev`: the zone metric at the last step (2 = outside before the first); `tc` < 0 until a contact is found.
    let prev = 2;
    let tc = -1;
    let cn = 0;
    let cl = 0;
    let cw = 0;
    let n0 = 0;
    let l0 = 0;
    const ox = ospeed > 0.1 ? o.vx / ospeed : Math.sin(o.yaw);
    const oz = ospeed > 0.1 ? o.vz / ospeed : Math.cos(o.yaw);
    for (let i = 0; i < STEPS; i++) {
      const t = TIMES[i]!;
      // The other keeps its heading and sheds speed at `lead` (a car ahead braking for what it sees), down to a stop.
      const te = Math.min(t, ospeed / lead);
      const shed = ospeed * te - 0.5 * lead * te * te;
      const rx = o.x + ox * shed - self.x - DX[i]!;
      const rz = o.z + oz * shed - self.z - DZ[i]!;
      const pn = rx * GX[i]! + rz * GZ[i]!;
      const pl = rx * GZ[i]! - rz * GX[i]!;
      // The zone is a car-shaped ellipse around either car: crossing traffic is long across the guarded car's path.
      const qn = -(rx * ox + rz * oz);
      const ql = -(rx * oz - rz * ox);
      const m = Math.min((pl / LAT) ** 2 + (pn / LON) ** 2, (ql / LAT) ** 2 + (qn / LON) ** 2);
      if (i === 0) {
        n0 = pn;
        l0 = pl;
      }
      if (prev < 1) {
        // Inside at t = 0: a contact now if it is still closing a step on, else the physics' business.
        if (m < prev) {
          tc = 0;
          cn = n0;
          cl = l0;
          cw = Math.hypot(ox * ospeed - VX[0]!, oz * ospeed - VZ[0]!);
        }
        break;
      }
      if (i > 0 && m < 1) {
        // The closing speed at the contact: the other's speed then, against the guarded car's.
        const ov = Math.max(0, ospeed - lead * t);
        tc = t;
        cn = pn;
        cl = pl;
        cw = Math.hypot(ox * ov - VX[i]!, oz * ov - VZ[i]!);
        break;
      }
      // Moving apart from outside the zone: nothing further out is a contact.
      if (i > 0 && m > prev) break;
      prev = m;
    }
    if (tc < 0) continue;
    // The sideways room the car can make by then: a contact it can steer clear of is not braked for.
    const room = 0.5 * STEER_ACC * tc * tc;
    const clear = room >= LAT - Math.abs(cl);
    if (cn > 0 && !clear) need = Math.max(need, Math.max(0, cw - TAP) / (2 * Math.max(tc, 0.05) * brake));
    if (tc < soonest) {
      soonest = tc;
      lateral = cl;
      offset = clamp(Math.abs(cl) / LAT, 0, 1);
      steerable = clear;
    }
  }
  if (soonest >= HORIZON) return;
  need = clamp(need, 0, 1);
  // Braking hard is straight-line work (a steered, locked car sheds speed slowly), so the steer-away gives way to it, and a
  // steer toward the car (its side is the sign of `lateral`) is straightened out as the braking gets harder.
  const u = STEER_CAP * clamp(2 * (1 - soonest / HORIZON), 0, 1) * (steerable ? 1 : offset) * (1 - need);
  const toward = lateral >= 0 ? out.steer > 0 : out.steer < 0;
  out.steer = clamp((toward ? out.steer * (1 - need) : out.steer) * (1 - u) + (lateral >= 0 ? -u : u), -1, 1);
  out.throttle *= 1 - need;
  // The drive brakes at 0.45 of full at the lightest touch of the pedal, so only a real stop touches it.
  if (need > 0.5) out.brake = Math.max(out.brake, need);
  if (need > 0.1) out.boost = false;
}
