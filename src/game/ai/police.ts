import { idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { STUCK_SPEED, type AiCar } from "./derby-ai.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { clamp, hash01, wrapPi } from "../kernel/scalar.ts";
import type { RaceBrain } from "./race-ai.ts";
import { blankPoint, blankProjection, projectPath, type Track } from "../world/track.ts";

/**
 * Most police cars in one race (all packs together; fewer when the field and traffic leave fewer car
 * slots): a full pack, or a pack of 4 and a stakeout. 8 cost city 3.7 ms more per tick in the browser and 66 frames
 * in 1628 over 33 ms. Measured frame cost: docs/RACE_DESIGN.md "Police chase".
 */
export const POLICE_CAP = 6;
/** Largest pack; a stakeout parks `PACK_START`, a sustained pursuit calls one more every `REINFORCE_EVERY` s. */
const PACK_MAX = 5;
const PACK_START = 2;
const REINFORCE_EVERY = 5;
/** Stakeouts start once the leader is this share of the first lap in. */
const ARM_AT = 1 / 3;
/** Seconds between stakeouts: `GAP_MIN` plus up to `GAP_SPAN`. */
const GAP_MIN = 6;
const GAP_SPAN = 10;
/** A stakeout parks this far (m) ahead of the racer it waits for, plus up to `AHEAD_SPAN`; reinforcements park `REINF_AHEAD` ahead. */
const AHEAD_MIN = 90;
const AHEAD_SPAN = 50;
const REINF_AHEAD = 70;
/** Units of one stakeout park this far apart (m) along the road. */
const PARK_SPACING = 12;
/** Half width and half length (m) of a car's footprint, for the parking spot. */
const HALF_W = 0.95;
const HALF_L = 2.3;
/** Room (m) a parked car keeps from the run-off's outer edge (the wall). */
const PARK_MARGIN = 0.15;
/** A parked car noses this far (rad) toward the road where the run-off is at least `ANGLED_RUN` m wide. */
const PARK_ANGLE = 0.25;
const ANGLED_RUN = 3;
/** A parking spot keeps this far (m) from every car. */
const PARK_CLEAR = 10;
/** A racer this close (m), or `PULL_OUT` s off at its speed, wakes a parked unit; so does a knock that leaves it moving faster than `KNOCK` m/s. */
const WAKE = 40;
const KNOCK = 2;
/** A unit this close (m) to its target sustains the pursuit; a pack this far off for `LOSE_TIME` s gives up. */
const ENGAGE = 45;
const LOSE = 160;
const LOSE_TIME = 4;
/** A pursuit this old (s) ends: the racer got away, the pack stands down and later stakeouts get its cars. */
const PURSUIT_MAX = 40;
/** Seconds a respawned racer is left alone. */
const IMMUNE = 4;
/** A parked unit nobody came near is stored after `PARK_MAX` s out of view; a knocked-out one after `DOWN_STORE` s; one with no pursuit once out of view and `RETIRE_FAR` m from every racer, or after `RETIRE_MAX` s. */
const PARK_MAX = 45;
const DOWN_STORE = 6;
const RETIRE_FAR = 50;
const RETIRE_MAX = 20;
/** Closer than this (m), on the same stretch of road, a unit attacks; beyond it it drives the racing line. */
const ATTACK = 35;
/** A unit ahead of its target attacks (pulls out into its path) once the target is this many seconds off, if that is farther than `ATTACK`. */
const PULL_OUT = 1.6;
/** A unit ahead of its target and facing it (the target within acos(`HEAD_ON`) of its nose) rams it head-on from `RAM_TIME` s off. */
const HEAD_ON = 0.7;
const RAM_TIME = 3;
/** Driving the line more than this far (m) behind its target, a unit boosts (police have no meter). */
const CATCH_UP = 20;
/** Its target this far (m) behind along the road, a unit ahead of it crawls until it comes up. */
const WAIT_BEHIND = 5;
/** Attack geometry (m, in the target's frame): the rear quarter a PIT starts from, how far alongside a door slam lines up, the gap ahead of a block. */
const PIT_BACK = 2;
const PIT_SIDE = 1.7;
const SLAM_SIDE = 2.8;
const BLOCK_AHEAD = 10;
/** A unit this far ahead of its target (m) blocks; alongside within `BESIDE` m it turns into it. */
const AHEAD_OF = 3.5;
const BESIDE_BACK = -4.5;
const BESIDE = 3.4;
/** A block holds this share of its target's speed, and brakes hard when the target closes within `CHECK` m. */
const BLOCK_PACE = 0.8;
const CHECK = 9;
/** Seconds of throttle without motion before a unit backs off for another run, and how long it backs off. */
const STUCK_FOR = 1.2;
const BACK_FOR = 0.9;

type UnitState = "stored" | "parked" | "pursuit" | "down";

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

/** The racing line's rules state for a unit driving it: main loop only, never a shortcut. */
const LINE_STATE = { next: -1, lap: 0 };

/**
 * Police chase (race option, NFS Hot Pursuit style): cars `first … first + count − 1`, after the
 * racers and traffic. From a third of the first lap on, stakeouts park a pack of `PACK_START` on the
 * run-off ahead of a racer (out of view, either side, never on the racing line; the second car faces
 * the oncoming racers). A racer coming near wakes the pack: it chases that racer, driving the racing
 * line (`RaceBrain` at aggression 1, boosting to catch up) and within `ATTACK` m attacking by its
 * place in the pack — PIT from the rear quarter, getting ahead to block and brake-check, door slams
 * from either side; ahead of the racer it pulls out into its path, and one facing it rams it head-on.
 * A sustained pursuit calls a reinforcement every `REINFORCE_EVERY` s up to `PACK_MAX`. A pack whose
 * target finishes, dies or escapes picks another racer near it or gives up, as it does after
 * `PURSUIT_MAX` s; units knocked out (or given up) are stored again. Sirens run while a unit chases.
 * Police are never entrants: the rules and standings never see them.
 * Deterministic (seeded dice, no clock); no allocation per call.
 */
export class PoliceBrain {
  readonly first: number;
  readonly count: number;
  /** This race: stakeouts parked, pursuits started (stakeouts woken), the largest pack in pursuit, units knocked out. */
  readonly stats = { stakeouts: 0, pursuits: 0, maxPack: 0, disabled: 0 };
  private readonly track: Track;
  private readonly line: RaceBrain;
  private readonly seed: number;
  private readonly out: DriveInput = idleDrive();
  private readonly state: UnitState[] = [];
  /** Per unit: its pack (−1 none: stored, or giving up), its place in the pack, seconds in its state. */
  private readonly pack: Int16Array;
  private readonly role: Uint8Array;
  private readonly since: Float64Array;
  private readonly stuck: Float64Array;
  private readonly back: Float64Array;
  private readonly backSteer: Float64Array;
  /** Per pack slot: in use, its target (−1: a stakeout still waiting), sustained, lost and pursuit seconds. */
  private readonly packLive: Uint8Array;
  private readonly target: Int16Array;
  private readonly sustain: Float64Array;
  private readonly lost: Float64Array;
  private readonly age: Float64Array;
  /** Per car id: projection hint, a class's full-lock yaw rate, race time a respawned racer is left alone until. */
  private readonly seg = new Int32Array(MAX_CARS).fill(-1);
  private readonly turn = new Float64Array(MAX_CARS).fill(1.5);
  private readonly immune = new Float64Array(MAX_CARS);
  private readonly proj = blankProjection();
  private readonly pt = blankPoint();
  private armed = false;
  private nextAt = 0;
  private dice = 0;
  /** Scratch: the last `nearest` call's distance and the last `spot` found. */
  private nearD = Infinity;
  private readonly spotAt = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(track: Track, line: RaceBrain, first: number, count: number, seed: number) {
    this.track = track;
    this.line = line;
    this.first = first;
    this.count = count;
    this.seed = seed;
    this.pack = new Int16Array(count).fill(-1);
    this.role = new Uint8Array(count);
    this.since = new Float64Array(count);
    this.stuck = new Float64Array(count);
    this.back = new Float64Array(count);
    this.backSteer = new Float64Array(count);
    this.packLive = new Uint8Array(count);
    this.target = new Int16Array(count).fill(-1);
    this.sustain = new Float64Array(count);
    this.lost = new Float64Array(count);
    this.age = new Float64Array(count);
    for (let u = 0; u < count; u++) this.state.push("stored");
  }

  /** Unit `id`'s class figures (the line driver's and its own steering). */
  setClass(id: number, s: Parameters<RaceBrain["setClass"]>[1]): void {
    this.line.setClass(id, s);
    this.line.setAggression(id, 1);
    this.turn[id] = s.turn;
  }

  /** Racer `id` respawned at race time `time`: left alone for `IMMUNE` s. */
  respawned(id: number, time: number): void {
    this.immune[id] = time + IMMUNE;
  }

  /** A unit's input for this physics slice (scratch output: apply it before the next call). */
  think(self: AiCar, cars: readonly AiCar[], dt: number): DriveInput {
    const out = this.out;
    out.throttle = 0;
    out.steer = 0;
    out.brake = 1;
    out.ebrake = false;
    out.boost = false;
    const u = self.id - this.first;
    if (u < 0 || u >= this.count || !self.alive || this.state[u] !== "pursuit") return out;
    out.brake = 0;
    const speed = Math.hypot(self.vx, self.vz);
    if (this.back[u]! > 0) {
      this.back[u]! -= dt;
      out.throttle = -0.9;
      out.steer = this.backSteer[u]!;
      return out;
    }
    const p = this.pack[u]!;
    const t = p >= 0 ? this.target[p]! : -1;
    const line = this.line.think(self, cars, LINE_STATE, dt);
    if (t < 0) {
      // No pursuit (giving up, or a reinforcement whose stakeout has not woken): ease along the line.
      out.throttle = Math.min(line.throttle, 0.5);
      out.steer = line.steer;
      out.brake = line.brake;
      return out;
    }
    const tg = cars[t]!;
    const dx = tg.x - self.x;
    const dz = tg.z - self.z;
    const dist = Math.hypot(dx, dz);
    const path = this.track.path;
    const sS = projectPath(path, self.x, self.z, this.seg[self.id]!, this.proj).s;
    this.seg[self.id] = this.proj.k;
    const sT = projectPath(path, tg.x, tg.z, this.seg[t]!, this.proj).s;
    this.seg[t] = this.proj.k;
    const L = this.track.length;
    const arc = sT - sS - L * Math.round((sT - sS) / L);
    // Ahead of its target, a unit pulls out into its path once it is `PULL_OUT` s off (at racing speed a
    // pull-out from `ATTACK` m never reached the line in time: the racer swept past and only clipped its
    // nose); one facing it rams it head-on from `RAM_TIME` s off.
    const headOn = arc < -WAIT_BEHIND && Math.sin(self.yaw) * dx + Math.cos(self.yaw) * dz > dist * HEAD_ON;
    const reach = arc < 0 ? Math.max(ATTACK, Math.hypot(tg.vx, tg.vz) * (headOn ? RAM_TIME : PULL_OUT)) : ATTACK;
    // The road between the two is no longer than the straight line: the same stretch (not across a crossover or under a bridge).
    if (dist > reach || Math.abs(arc) > dist * 1.3 + 6) {
      out.steer = line.steer;
      if (arc < -WAIT_BEHIND) {
        // Ahead of its target: crawl until it comes up.
        out.throttle = speed > 4 ? 0 : 0.3;
        out.brake = speed > 4 ? 0.5 : 0;
        return out;
      }
      out.throttle = line.throttle;
      out.brake = line.brake;
      out.boost = arc > CATCH_UP && line.throttle > 0.5;
      return out;
    }
    this.attack(u, self, tg, speed, dist, headOn, out);
    // Wedged (against its target on a wall, or a car): back off for another run.
    if (out.throttle > 0.35 && speed < STUCK_SPEED) this.stuck[u]! += dt;
    else this.stuck[u] = Math.max(0, this.stuck[u]! - dt * 2);
    if (this.stuck[u]! > STUCK_FOR) {
      this.stuck[u] = 0;
      this.back[u] = BACK_FOR;
      this.backSteer[u] = -out.steer || 1;
    }
    return out;
  }

  /** Within `ATTACK` m: ram head-on or block from ahead, PIT or slam from alongside, line up by pack role from behind. */
  private attack(u: number, self: AiCar, tg: AiCar, speed: number, dist: number, headOn: boolean, out: DriveInput): void {
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
    const tv = Math.hypot(tg.vx, tg.vz);
    let lead = clamp(dist / Math.max(4, speed), 0, 0.5);
    let fwd: number;
    let lat: number;
    let want = tv + 8;
    let brakeCheck = false;
    if (headOn) {
      // Facing it from ahead: flat out at where it will be when they meet.
      fwd = 0;
      lat = 0;
      lead = clamp(dist / Math.max(4, tv + speed), 0, 1.5);
      want = Infinity;
    } else if (along > AHEAD_OF) {
      // Ahead: onto its line in front of it, a little slower; brake-check when it closes.
      fwd = along + BLOCK_AHEAD;
      lat = 0;
      want = tv * BLOCK_PACE;
      brakeCheck = along < CHECK && tv > speed;
    } else if (along > BESIDE_BACK && Math.abs(side) < BESIDE) {
      // Alongside: at its rear quarter a PIT (nose across its tail), level with it a door slam.
      fwd = along < -0.8 ? 1 : 1.5;
      lat = -sideSign * (along < -0.8 ? 0.5 : 1.5);
    } else {
      // Behind: line up by place in the pack.
      const r = this.role[u]!;
      if (r % 3 === 0) {
        fwd = -PIT_BACK;
        lat = sideSign * PIT_SIDE;
      } else if (r % 3 === 1) {
        fwd = BLOCK_AHEAD * 0.6;
        lat = sideSign * SLAM_SIDE;
      } else {
        fwd = 0;
        lat = (r % 2 === 0 ? 1 : -1) * SLAM_SIDE;
      }
    }
    const ax = tg.x + tg.vx * lead + tfx * fwd + tlx * lat;
    const az = tg.z + tg.vz * lead + tfz * fwd + tlz * lat;
    const alpha = wrapPi(Math.atan2(ax - self.x, az - self.z) - self.yaw);
    const reach = Math.max(4, Math.hypot(ax - self.x, az - self.z));
    const turnMax = this.turn[self.id]! * (0.35 + 0.65 * Math.min(1, speed / 8));
    out.steer = clamp((2 * Math.max(speed, 4) * Math.sin(alpha)) / reach / Math.max(0.2, turnMax), -1, 1);
    if (brakeCheck) {
      out.brake = 1;
      return;
    }
    if (speed > want + 2) out.brake = 0.4;
    else out.throttle = 1;
    out.boost = out.throttle > 0 && (along < -6 || headOn) && Math.abs(alpha) < 0.35;
  }

  /**
   * One patrol pass (the director's bubble beat, `dt` s): knock-outs, wake-ups, pursuits kept, lost or
   * reinforced, stakeouts, units stored. `hunt[id]` is 1 for a racer still racing; `lead` is the
   * leader's progress (m).
   */
  update(time: number, dt: number, cars: readonly AiCar[], hunt: Uint8Array, lead: number, world: PoliceWorld): void {
    for (let u = 0; u < this.count; u++) {
      const st = this.state[u]!;
      if (st === "stored") continue;
      const id = this.first + u;
      const car = cars[id]!;
      this.since[u]! += dt;
      if (st === "down") {
        if (this.since[u]! > DOWN_STORE) this.store(u, world);
        continue;
      }
      if (world.down(id)) {
        this.pack[u] = -1;
        this.setState(u, "down");
        world.sirens(id, false);
        this.stats.disabled++;
        continue;
      }
      if (st === "parked") {
        const near = this.nearest(car, cars, hunt, time);
        const wake = near >= 0 ? Math.max(WAKE, Math.hypot(cars[near]!.vx, cars[near]!.vz) * PULL_OUT) : 0;
        if (near >= 0 && (this.nearD < wake || Math.hypot(car.vx, car.vz) > KNOCK)) this.wake(u, near);
        else if (this.since[u]! > PARK_MAX && !world.seen(car.x, car.z)) this.store(u, world);
        continue;
      }
      if (this.pack[u]! < 0) {
        // Giving up: sirens off, gone once nobody sees it go.
        world.sirens(id, false);
        this.nearest(car, cars, hunt, time);
        if (this.since[u]! > RETIRE_MAX || (this.nearD > RETIRE_FAR && !world.seen(car.x, car.z))) this.store(u, world);
      } else world.sirens(id, true);
    }
    for (let p = 0; p < this.count; p++) {
      if (!this.packLive[p]) continue;
      const size = this.sizeOf(p);
      if (size === 0) {
        this.packLive[p] = 0;
        continue;
      }
      const t = this.target[p]!;
      if (t < 0) continue;
      if (!this.huntable(t, hunt, time)) {
        const next = this.nearestTo(p, cars, hunt, time);
        if (next < 0) {
          this.disband(p);
          continue;
        }
        this.target[p] = next;
        this.lost[p] = 0;
      }
      const tg = cars[this.target[p]!]!;
      let near = Infinity;
      let chasing = 0;
      for (let u = 0; u < this.count; u++) {
        if (this.pack[u] !== p || this.state[u] !== "pursuit") continue;
        chasing++;
        near = Math.min(near, Math.hypot(cars[this.first + u]!.x - tg.x, cars[this.first + u]!.z - tg.z));
      }
      this.stats.maxPack = Math.max(this.stats.maxPack, chasing);
      this.age[p]! += dt;
      this.sustain[p] = near < ENGAGE ? this.sustain[p]! + dt : 0;
      this.lost[p] = near > LOSE ? this.lost[p]! + dt : 0;
      if (this.lost[p]! > LOSE_TIME || this.age[p]! > PURSUIT_MAX) {
        this.disband(p);
        continue;
      }
      if (this.sustain[p]! >= REINFORCE_EVERY && size < PACK_MAX) {
        this.sustain[p] = 0;
        const u = this.free();
        const side = this.roll() < 0.5 ? 1 : -1;
        if (u < 0) continue;
        // Parked ahead where nobody sees it; else it comes up from behind, already chasing.
        if (this.spot(tg, REINF_AHEAD, side, 1, cars, world)) this.place(u, p, size, world);
        else if (this.spot(tg, -REINF_AHEAD, side, 1, cars, world)) {
          this.place(u, p, size, world);
          this.setState(u, "pursuit");
        }
      }
    }
    if (!this.armed) {
      if (lead < this.track.length * ARM_AT) return;
      this.armed = true;
      this.nextAt = time;
    }
    if (time < this.nextAt) return;
    this.nextAt = time + GAP_MIN + GAP_SPAN * this.roll();
    this.stakeout(cars, hunt, time, world);
  }

  /** Park a fresh pack of `PACK_START` ahead of a random racer still racing. */
  private stakeout(cars: readonly AiCar[], hunt: Uint8Array, time: number, world: PoliceWorld): void {
    let free = 0;
    for (let u = 0; u < this.count; u++) if (this.state[u] === "stored") free++;
    if (free < PACK_START) return;
    let p = 0;
    while (p < this.count && this.packLive[p]) p++;
    if (p >= this.count) return;
    let racers = 0;
    for (let i = 0; i < this.line.racers; i++) if (this.huntable(i, hunt, time)) racers++;
    if (racers === 0) return;
    let pick = Math.floor(this.roll() * racers);
    let r = 0;
    for (; r < this.line.racers; r++) if (this.huntable(r, hunt, time) && pick-- === 0) break;
    const ahead = AHEAD_MIN + AHEAD_SPAN * this.roll();
    for (let k = 0; k < PACK_START; k++) {
      const u = this.free();
      // The second car of a stakeout parks facing the oncoming racers: a head-on rammer.
      if (u < 0 || !this.spot(cars[r]!, ahead + k * PARK_SPACING, this.roll() < 0.5 ? 1 : -1, k === 1 ? -1 : 1, cars, world)) break;
      this.place(u, p, k, world);
    }
    if (this.packLive[p]) this.stats.stakeouts++;
  }

  /** Park unit `u` at the last `spot` as member `role` of pack `p`. */
  private place(u: number, p: number, role: number, world: PoliceWorld): void {
    const id = this.first + u;
    const s = this.spotAt;
    world.park(id, s.x, s.y, s.z, s.yaw);
    this.line.respawned(id);
    this.seg[id] = -1;
    this.pack[u] = p;
    this.role[u] = role;
    this.stuck[u] = 0;
    this.back[u] = 0;
    this.setState(u, "parked");
    if (!this.packLive[p]) {
      this.packLive[p] = 1;
      this.target[p] = -1;
      this.sustain[p] = 0;
      this.lost[p] = 0;
    }
  }

  /**
   * A parking spot `ahead` m along the road from car `c`, on the run-off on `side` (+1 left of travel),
   * facing with the travel (`facing` 1) or against it (−1), clear of every car and out of view; it scans
   * on along the road past bridge decks. Fills `spotAt`.
   */
  private spot(c: AiCar, ahead: number, side: 1 | -1, facing: 1 | -1, cars: readonly AiCar[], world: PoliceWorld): boolean {
    const path = this.track.path;
    const L = this.track.length;
    let s = projectPath(path, c.x, c.z, this.seg[c.id]!, this.proj).s + ahead;
    this.seg[c.id] = this.proj.k;
    for (let tries = 0; tries < 6; tries++, s += PARK_SPACING * 1.5) {
      const ws = ((s % L) + L) % L;
      const k = Math.min(path.count - 1, Math.floor((ws / L) * path.count));
      if (path.deck[k]) continue;
      const run = side > 0 ? path.runL[k]! : path.runR[k]!;
      const angle = run >= ANGLED_RUN ? PARK_ANGLE : 0;
      const lat = side * (path.half[k]! + run - HALF_W - PARK_MARGIN - HALF_L * Math.sin(angle));
      const pt = this.track.pointAt(ws, this.pt);
      const x = pt.x + pt.tz * lat;
      const z = pt.z - pt.tx * lat;
      if (world.seen(x, z)) continue;
      let clear = true;
      for (const o of cars) if (Math.hypot(o.x - x, o.z - z) < PARK_CLEAR) clear = false;
      if (!clear) continue;
      // Nose toward the road: forward turned by `angle` toward the centreline.
      const fx = facing * pt.tx * Math.cos(angle) - side * pt.tz * Math.sin(angle);
      const fz = facing * pt.tz * Math.cos(angle) + side * pt.tx * Math.sin(angle);
      this.spotAt.x = x;
      this.spotAt.y = pt.y;
      this.spotAt.z = z;
      this.spotAt.yaw = Math.atan2(fx, fz);
      return true;
    }
    return false;
  }

  /** Wake unit `u`: its whole stakeout goes after `racer` (a reinforcement joins its pack's pursuit). */
  private wake(u: number, racer: number): void {
    const p = this.pack[u]!;
    if (this.target[p]! >= 0) {
      this.setState(u, "pursuit");
      return;
    }
    this.target[p] = racer;
    this.sustain[p] = 0;
    this.lost[p] = 0;
    this.age[p] = 0;
    this.stats.pursuits++;
    for (let v = 0; v < this.count; v++) if (this.pack[v] === p && this.state[v] === "parked") this.setState(v, "pursuit");
  }

  /** Pack `p` gives up: its units drive off and are stored out of view. */
  private disband(p: number): void {
    this.packLive[p] = 0;
    this.target[p] = -1;
    for (let u = 0; u < this.count; u++) {
      if (this.pack[u] !== p) continue;
      this.pack[u] = -1;
      if (this.state[u] === "parked") this.setState(u, "pursuit");
      else this.since[u] = 0;
    }
  }

  private store(u: number, world: PoliceWorld): void {
    world.sirens(this.first + u, false);
    world.store(this.first + u);
    this.pack[u] = -1;
    this.setState(u, "stored");
  }

  private setState(u: number, st: UnitState): void {
    this.state[u] = st;
    this.since[u] = 0;
  }

  private free(): number {
    for (let u = 0; u < this.count; u++) if (this.state[u] === "stored") return u;
    return -1;
  }

  private sizeOf(p: number): number {
    let n = 0;
    for (let u = 0; u < this.count; u++) if (this.pack[u] === p) n++;
    return n;
  }

  private huntable(id: number, hunt: Uint8Array, time: number): boolean {
    return hunt[id] === 1 && time >= this.immune[id]!;
  }

  /** The nearest racer still racing and not just respawned (−1 none); its distance in `nearD`. */
  private nearest(c: AiCar, cars: readonly AiCar[], hunt: Uint8Array, time: number): number {
    let best = -1;
    this.nearD = Infinity;
    for (let i = 0; i < this.line.racers; i++) {
      if (!this.huntable(i, hunt, time)) continue;
      const d = Math.hypot(cars[i]!.x - c.x, cars[i]!.z - c.z);
      if (d < this.nearD) {
        this.nearD = d;
        best = i;
      }
    }
    return best;
  }

  /** A new target for pack `p`: the racer nearest any of its units, within `ENGAGE` m (−1 none). */
  private nearestTo(p: number, cars: readonly AiCar[], hunt: Uint8Array, time: number): number {
    let best = -1;
    let bestD = ENGAGE;
    for (let u = 0; u < this.count; u++) {
      if (this.pack[u] !== p || this.state[u] !== "pursuit") continue;
      const r = this.nearest(cars[this.first + u]!, cars, hunt, time);
      if (r >= 0 && this.nearD < bestD) {
        bestD = this.nearD;
        best = r;
      }
    }
    return best;
  }

  /** Next seeded die, 0..1. */
  private roll(): number {
    return hash01(this.seed * 7.13 + 3.1, ++this.dice);
  }
}
