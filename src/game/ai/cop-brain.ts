import { hypot2 } from "../kernel/physics-core.js";
import { guardMates } from "./pack-guard.ts";
import { idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { classStats, type ClassStats } from "../vehicle/vehicle-classes.ts";
import type { AiCar } from "./derby-ai.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { clamp, hash01, wrapPi } from "../kernel/scalar.ts";

/** Closer than this (m), on the same stretch of road, a unit attacks; beyond it it drives the racing line. */
export const ATTACK = 35;
/** A unit ahead of its target attacks (pulls out into its path) once the target is this many seconds off, if that is farther than `ATTACK`. */
export const PULL_OUT = 1.6;
/** A unit ahead of its target and facing it (the target within acos(`HEAD_ON`) of its nose) rams it head-on from `RAM_TIME` s off. */
export const HEAD_ON = 0.7;
export const RAM_TIME = 3;
/** Driving the line more than this far (m) behind its target, a unit boosts (police have no meter). */
export const CATCH_UP = 20;
/** Its target this far (m) behind along the road, a unit ahead of it crawls until it comes up. */
export const WAIT_BEHIND = 5;
/** Attack geometry (m, in the target's frame): the rear quarter a PIT starts from, how far alongside a door slam lines up, the gap ahead of a block. */
const PIT_BACK = 2;
const PIT_SIDE = 1.7;
const SLAM_SIDE = 2.8;
/**
 * A target faster than `PIT_MAX` (m/s) is not PIT'd or slammed: a turn-in at that speed wrecks both cars. Measured on Havana, the
 * pack's slam lines shoved a player holding the boulevard at 40 m/s into the palms, and the pack lost 25 m/s there. Its units queue
 * behind it instead (`attackTarget`): `TAIL` m back in the first row, a row every `ROW` m (a car and a gap), in a lane `TAIL_LANE` m
 * either side of its line, aiming `LOOK` m ahead along the lane (pure pursuit, so a unit merging into its lane does not overshoot).
 */
const PIT_MAX = 20;
const TAIL = 6;
const ROW = 8;
export const TAIL_LANE = 2.6;
const LOOK = 14;
/**
 * Closing on its target at more than 6 m/s, and with that speed squared over `OVERRUN` × the distance, a unit cannot brake to it (a
 * car's brake is about `OVERRUN` / 2 m/s²): it cannot turn into a PIT, a block or a ram either, so it goes straight on, braking hard
 * only while it is within `IN_PATH` m of the line it would hit.
 */
const OVERRUN = 16;
const IN_PATH = 2.2;
const BLOCK_AHEAD = 10;
/** A unit this far ahead of its target (m) blocks; alongside within `BESIDE` m it turns into it. */
const AHEAD_OF = 3.5;
const BESIDE_BACK = -4.5;
const BESIDE = 3.4;
/** A block holds this share of its target's speed, and brakes hard when the target closes within `CHECK` m. */
const BLOCK_PACE = 0.8;
const CHECK = 9;
/** Seconds of throttle without progress before a unit backs off for another run, how long it backs off, and the metres that count as progress. */
const STUCK_FOR = 1.2;
const BACK_FOR = 0.9;
const PROGRESS = 1.5;

/** An aim past this angle (rad) off the nose is behind the shoulder (`pursuitSteer`, `PoliceBrain.lead`). */
export const BEHIND = 1.5;

/**
 * The one steering rule of every police drive (lead-in, attack, open-ground hunt): pure pursuit. Lock for the heading error
 * `alpha` to an aim `reach` m ahead at `speed`, on a class whose full-lock yaw rate is `turn`.
 */
export function pursuitSteer(alpha: number, reach: number, speed: number, turn: number): number {
  // An aim behind the shoulder: sin(alpha) fades to nothing as it nears dead astern, which drove a unit straight away from it. Full lock toward it.
  if (Math.abs(alpha) > BEHIND) return Math.sign(alpha);
  const turnMax = turn * (0.35 + 0.65 * Math.min(1, speed / 8));
  return clamp((2 * Math.max(speed, 4) * Math.sin(alpha)) / Math.max(4, reach) / Math.max(0.2, turnMax), -1, 1);
}

/** Wedge recovery of every police drive: throttle held without progress for `STUCK_FOR` s backs a unit off for `BACK_FOR` s, steering the other way. */
class Backoff {
  private readonly stuck: Float64Array;
  private readonly back: Float64Array;
  private readonly backSteer: Float64Array;
  /** Per unit: where its current stretch of throttle began (it has moved on once it is `PROGRESS` m from here). */
  private readonly anchorX: Float64Array;
  private readonly anchorZ: Float64Array;

  constructor(count: number) {
    this.stuck = new Float64Array(count);
    this.back = new Float64Array(count);
    this.backSteer = new Float64Array(count);
    this.anchorX = new Float64Array(count).fill(Infinity);
    this.anchorZ = new Float64Array(count).fill(Infinity);
  }

  reset(u: number): void {
    this.stuck[u] = 0;
    this.back[u] = 0;
    this.anchorX[u] = Infinity;
  }

  /** True (with `out` set to reverse) while unit `u` backs off. */
  backing(u: number, dt: number, out: DriveInput): boolean {
    if (this.back[u]! <= 0) return false;
    this.back[u]! -= dt;
    out.throttle = -0.9;
    out.steer = this.backSteer[u]!;
    return true;
  }

  /**
   * Count unit `u`'s wedged seconds from the `out` it just got at (`x`, `z`); a wedge of `STUCK_FOR` s starts a back-off. Wedged is no
   * progress under throttle, not low speed: a car pushing a wall corner reads 1–3 m/s from its velocity (the contact takes the step
   * back), and sat there for 10 s on Havana.
   */
  watch(u: number, x: number, z: number, dt: number, out: DriveInput): void {
    if (Math.hypot(x - this.anchorX[u]!, z - this.anchorZ[u]!) > PROGRESS) {
      this.anchorX[u] = x;
      this.anchorZ[u] = z;
      this.stuck[u] = 0;
    } else if (out.throttle > 0.35) this.stuck[u]! += dt;
    else this.stuck[u] = Math.max(0, this.stuck[u]! - dt * 2);
    if (this.stuck[u]! > STUCK_FOR) {
      this.stuck[u] = 0;
      this.back[u] = BACK_FOR;
      this.backSteer[u] = -out.steer || 1;
    }
  }
}

/**
 * Within `ATTACK` m of its target: ram head-on or block from ahead, PIT or slam from alongside, line up by `role` (its
 * place in the pack) from behind; queue behind a target too fast for any of that (`PIT_MAX`) in the `lane` and `row` the caller
 * gives (by `role` by default); go straight on when it closes faster than it can brake (`OVERRUN`). The one attack geometry of every
 * police drive; `turn` is the class's full-lock yaw rate. `block` false drops the getting-ahead-and-braking part: a quarry that has
 * stopped is not worth blocking.
 */
export function attackTarget(self: AiCar, tg: AiCar, role: number, turn: number, speed: number, dist: number, headOn: boolean, out: DriveInput, block = true, lane = (role % 3) - 1, row = role % 5): void {
  const tfx = Math.sin(tg.yaw);
  const tfz = Math.cos(tg.yaw);
  // Left of the target's travel = (fz, −fx).
  const tlx = tfz;
  const tlz = -tfx;
  const rx = self.x - tg.x;
  const rz = self.z - tg.z;
  const along = rx * tfx + rz * tfz;
  const side = rx * tlx + rz * tlz;
  const sideSign = side >= 0 ? 1 : -1;
  const tv = hypot2(tg.vx, tg.vz);
  let lead = clamp(dist / Math.max(4, speed), 0, 0.5);
  let fwd: number;
  let lat: number;
  let want = tv + 8;
  let brakeCheck = false;
  let queue = false;
  let straight = false;
  if (headOn) {
    // Facing it from ahead: flat out at where it will be when they meet.
    fwd = 0;
    lat = 0;
    lead = clamp(dist / Math.max(4, tv + speed), 0, 1.5);
    want = Infinity;
  } else if (speed - tv > 6 && (speed - tv) ** 2 > OVERRUN * dist) {
    // Closing on its target faster than it can brake to it: it cannot turn into a PIT, a block or a ram. Past it, or beside it, straight on at speed; behind it and in its path, straight on braking hard.
    straight = true;
    fwd = 0;
    lat = 0;
    want = Infinity;
    brakeCheck = along < 0 && Math.abs(side) < IN_PATH;
  } else if (block && along > AHEAD_OF) {
    // Ahead: onto its line in front of it, a little slower; brake-check when it closes.
    fwd = along + BLOCK_AHEAD;
    lat = 0;
    want = tv * BLOCK_PACE;
    brakeCheck = along < CHECK && tv > speed;
  } else if (tv > PIT_MAX) {
    // Too fast to PIT or slam: queue behind it, closing up to its row but not into it.
    queue = true;
    lead = 0;
    fwd = along + Math.max(LOOK, speed * 0.5);
    lat = lane * TAIL_LANE;
  } else if (along > BESIDE_BACK && Math.abs(side) < BESIDE) {
    // Alongside: at its rear quarter a PIT (nose across its tail), level with it a door slam.
    fwd = along < -0.8 ? 1 : 1.5;
    lat = -sideSign * (along < -0.8 ? 0.5 : 1.5);
  } else if (role % 3 === 0) {
    // Behind: line up by place in the pack.
    fwd = -PIT_BACK;
    lat = sideSign * PIT_SIDE;
  } else if (role % 3 === 1) {
    fwd = BLOCK_AHEAD * 0.6;
    lat = sideSign * SLAM_SIDE;
  } else {
    fwd = 0;
    lat = (role % 2 === 0 ? 1 : -1) * SLAM_SIDE;
  }
  const ax = tg.x + tg.vx * lead + tfx * fwd + tlx * lat;
  const az = tg.z + tg.vz * lead + tfz * fwd + tlz * lat;
  if (queue) want = tv + clamp(-(TAIL + ROW * row) - along, -tv, 8);
  const alpha = wrapPi(Math.atan2(ax - self.x, az - self.z) - self.yaw);
  out.steer = straight ? 0 : pursuitSteer(alpha, hypot2(ax - self.x, az - self.z), speed, turn);
  if (brakeCheck) {
    out.brake = 1;
    return;
  }
  if (speed > want + (queue ? 0 : 2)) out.brake = 0.4;
  else out.throttle = 1;
  out.boost = out.throttle > 0 && (queue ? want > tv + 7 : along < -6 || headOn) && Math.abs(alpha) < 0.35;
}

/** What the police need from the race director. */
export interface PoliceWorld {
  /** Bring car `id` out of storage, parked at (x, z) facing `yaw`, on the ground layer nearest `y`. */
  park(id: number, x: number, y: number, z: number, yaw: number): void;
  /** Put car `id` away: hidden, still, off the course. */
  store(id: number): void;
  /** (x, z) is in the local camera's view (nothing pops in there). */
  seen(x: number, z: number): boolean;
  /** Car `id` is knocked out: drivetrain dead or upside down too long. */
  down(id: number): boolean;
  /** Car `id`'s sirens on or off. */
  sirens(id: number, on: boolean): void;
}

/** What Survival's hunters need besides the police's: whether a spot can be seen from the local camera at all (outside its view, or behind a solid). */
export interface HunterWorld extends PoliceWorld {
  hidden(x: number, z: number): boolean;
}

/**
 * A police brain the race director drives: the road-bound chase (`PoliceBrain`) and Survival's open-ground hunt (`HunterBrain`). Both
 * share their unit ids, the seeded dice, each unit's attack role, state clock and wedge back-off, each car's class steering, the scratch
 * drive output and the pack-mate guard over it, the chaser list, and putting a unit away or finding one in storage.
 */
export abstract class CopBrain {
  readonly first: number;
  readonly count: number;
  protected readonly out: DriveInput = idleDrive();
  /** Per unit: its place in the attack (`attackTarget`'s role), seconds in its state, its wedged back-off. */
  protected readonly role: Uint8Array;
  protected readonly since: Float64Array;
  protected readonly wedge: Backoff;
  /** Per car id: a class's full-lock yaw rate and grip. */
  protected readonly turn = new Float64Array(MAX_CARS).fill(1.5);
  protected readonly grip = new Float64Array(MAX_CARS).fill(classStats("sedan").grip);
  /** The pack-mate guard's view of a unit: driving, so a slow one may be pulling out (bound once: no allocation per call). */
  protected abstract readonly pullsOut: (u: number) => boolean;
  private readonly seed: number;
  private dice = 0;

  constructor(first: number, count: number, seed: number) {
    this.first = first;
    this.count = count;
    this.seed = seed;
    this.role = new Uint8Array(count);
    this.since = new Float64Array(count);
    this.wedge = new Backoff(count);
  }

  /** Unit `id`'s class figures for its own steering. */
  setClass(id: number, s: ClassStats): void {
    this.turn[id] = s.turn;
    this.grip[id] = s.grip;
  }

  /** Racer `id` respawned at race time `time` (a brain that leaves it alone for a while). */
  respawned?(id: number, time: number): void;

  /** The units chasing a racer right now, from `cars` into `out` (cleared first): the rules' `BUST` counts only these. */
  chasers(cars: readonly AiCar[], out: AiCar[]): AiCar[] {
    let n = 0;
    for (let u = 0; u < this.count; u++) if (this.chasing(u)) out[n++] = cars[this.first + u]!;
    out.length = n;
    return out;
  }

  /** How many of the `chasers` are after racer `id` (the HUD's pursuit strip). */
  abstract copsOn(id: number): number;

  /** A unit's input for this physics slice (scratch output: apply it before the next call): its drive, then the pack-mate guard. */
  think(self: AiCar, cars: readonly AiCar[], dt: number): DriveInput {
    const out = this.drive(self, cars, dt);
    guardMates(self, cars, this.first, this.count, out, this.pullsOut, this.turn[self.id]!, this.grip[self.id]!);
    return out;
  }

  /** One patrol pass (the director's bubble beat, `dt` s). `hunt[id]` is 1 for a racer still racing; `lead` is the leader's progress (m). */
  abstract update(time: number, dt: number, cars: readonly AiCar[], hunt: Uint8Array, lead: number, world: HunterWorld): void;

  /** Unit `u` chases a racer right now. */
  protected abstract chasing(u: number): boolean;
  /** Unit `u` waits in storage. */
  protected abstract stored(u: number): boolean;
  /** Unit `self`'s own drive, before the pack-mate guard. */
  protected abstract drive(self: AiCar, cars: readonly AiCar[], dt: number): DriveInput;

  /** Unit `u` is put away: sirens off, the car stored (the subclass marks its state). */
  protected store(u: number, world: PoliceWorld): void {
    world.sirens(this.first + u, false);
    world.store(this.first + u);
  }

  /** A unit in storage (−1 none). */
  protected free(): number {
    for (let u = 0; u < this.count; u++) if (this.stored(u)) return u;
    return -1;
  }

  /** Next seeded die, 0..1. */
  protected roll(): number {
    return hash01(this.seed * 7.13 + 3.1, ++this.dice);
  }
}
