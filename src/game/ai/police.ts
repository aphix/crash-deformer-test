import type { DriveInput } from "../vehicle/car-drive.ts";
import type { ClassStats } from "../vehicle/vehicle-classes.ts";
import type { AiCar } from "./derby-ai.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { wrapPi } from "../kernel/scalar.ts";
import type { RaceBrain } from "./race-ai.ts";
import { blankPoint, blankProjection, projectPath, type Track } from "../world/track.ts";
import { ATTACK, attackTarget, BEHIND, CATCH_UP, CopBrain, HEAD_ON, PULL_OUT, pursuitSteer, RAM_TIME, WAIT_BEHIND, type PoliceWorld } from "./cop-brain.ts";

/**
 * Most police cars in one race (all packs together; fewer when the field and traffic leave fewer car
 * slots): a full pack, or a pack of 4 and a stakeout. 8 cost city 3.7 ms more per tick in the browser and 66 frames
 * in 1628 over 33 ms (Watch, 7 AI + one car, 30 s windows with 3 or more police out).
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
/**
 * A parked unit wakes once a racer's road progress is past its spot by up to `PASSED` m (a patrol beat at top
 * speed covers ~14 m); so does a knock that leaves it moving faster than `KNOCK` m/s.
 */
const PASSED = 30;
const KNOCK = 2;
/** Metres a racer may be past the road's run-off and still be on its corridor (`projectPath`'s own margin): beyond it the racer is not on this road. */
const CORRIDOR = 8;
/**
 * A woken unit leads in for `LEAD_IN` s: full throttle at the road the target is driving, `LEAD_AHEAD` s (at least
 * `LEAD_MIN` m) ahead of the unit but never past where the target will be in `LEAD_AHEAD` s, its aim blended from
 * its own heading over the first half; then it pursues.
 */
const LEAD_IN = 2;
const LEAD_AHEAD = 1;
const LEAD_MIN = 20;
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

type UnitState = "stored" | "parked" | "pursuit" | "down";

/** The racing line's rules state for a unit driving it: main loop only, never a shortcut. */
const LINE_STATE = { next: -1, lap: 0 };

/**
 * Police chase (race option, NFS Hot Pursuit style): cars `first … first + count − 1`, after the
 * racers and traffic. From a third of the first lap on, stakeouts park a pack of `PACK_START` on the
 * run-off ahead of a racer (out of view, either side, never on the racing line; the second car faces
 * the oncoming racers). Each unit stays parked until a racer passes its spot on the road; then it leads in
 * for `LEAD_IN` s, full throttle along the road toward where that racer is heading (never across at its side), and chases it, driving the racing
 * line (`RaceBrain` at aggression 1, boosting to catch up) and within `ATTACK` m attacking by its
 * place in the pack — PIT from the rear quarter, getting ahead to block and brake-check, door slams
 * from either side; ahead of the racer it pulls out into its path, and one facing it rams it head-on.
 * A sustained pursuit calls a reinforcement every `REINFORCE_EVERY` s up to `PACK_MAX`. A pack whose
 * target finishes, dies or escapes picks another racer near it or gives up, as it does after
 * `PURSUIT_MAX` s; units knocked out (or given up) are stored again. Sirens run while a unit chases.
 * Police are never entrants: the rules and standings never see them.
 * Deterministic (seeded dice, no clock); no allocation per call.
 */
export class PoliceBrain extends CopBrain {
  /** This race: stakeouts parked, pursuits started (stakeouts woken), the largest pack in pursuit, units knocked out. */
  readonly stats = { stakeouts: 0, pursuits: 0, maxPack: 0, disabled: 0 };
  private readonly track: Track;
  private readonly line: RaceBrain;
  /** Driving, so a slow one may be pulling out (not parked at a stakeout, knocked out or stored: those are stopped obstacles). */
  protected readonly pullsOut = (u: number): boolean => this.state[u] === "pursuit";
  private readonly state: UnitState[] = [];
  /** Per unit: its pack (−1 none: stored, or giving up). */
  private readonly pack: Int16Array;
  /** Per unit: seconds of lead-in left, and its parking spot's road arc (m). */
  private readonly leadIn: Float64Array;
  private readonly parkS: Float64Array;
  /** Per pack slot: in use, its target (−1: a stakeout still waiting), sustained, lost and pursuit seconds. */
  private readonly packLive: Uint8Array;
  private readonly target: Int16Array;
  private readonly sustain: Float64Array;
  private readonly lost: Float64Array;
  private readonly age: Float64Array;
  /** Per car id: projection hint, race time a respawned racer is left alone until. */
  private readonly seg = new Int32Array(MAX_CARS).fill(-1);
  private readonly immune = new Float64Array(MAX_CARS);
  private readonly proj = blankProjection();
  private readonly pt = blankPoint();
  private armed = false;
  private nextAt = 0;
  /** Scratch: the last `nearest` call's distance and the last `spot` found. */
  private nearD = Infinity;
  private readonly spotAt = { x: 0, y: 0, z: 0, yaw: 0, s: 0 };

  constructor(track: Track, line: RaceBrain, first: number, count: number, seed: number) {
    super(first, count, seed);
    this.track = track;
    this.line = line;
    this.pack = new Int16Array(count).fill(-1);
    this.leadIn = new Float64Array(count);
    this.parkS = new Float64Array(count);
    this.packLive = new Uint8Array(count);
    this.target = new Int16Array(count).fill(-1);
    this.sustain = new Float64Array(count);
    this.lost = new Float64Array(count);
    this.age = new Float64Array(count);
    for (let u = 0; u < count; u++) this.state.push("stored");
  }

  /** Unit `id`'s class figures (the line driver's and its own steering). */
  override setClass(id: number, s: ClassStats): void {
    this.line.setClass(id, s);
    this.line.setAggression(id, 1);
    super.setClass(id, s);
  }

  /** Racer `id` respawned at race time `time`: left alone for `IMMUNE` s. */
  override respawned(id: number, time: number): void {
    this.immune[id] = time + IMMUNE;
  }

  copsOn(id: number): number {
    let n = 0;
    for (let u = 0; u < this.count; u++) if (this.state[u] === "pursuit" && this.pack[u]! >= 0 && this.target[this.pack[u]!] === id) n++;
    return n;
  }

  /** In pursuit with a pack, not giving up: never a parked stakeout, a knocked-out wreck or a unit driving off. */
  protected chasing(u: number): boolean {
    return this.state[u] === "pursuit" && this.pack[u]! >= 0;
  }

  protected stored(u: number): boolean {
    return this.state[u] === "stored";
  }

  protected drive(self: AiCar, cars: readonly AiCar[], dt: number): DriveInput {
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
    if (this.wedge.backing(u, dt, out)) return out;
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
    if (this.leadIn[u]! > 0) {
      this.leadIn[u]! -= dt;
      this.lead(u, self, sS, sT + Math.hypot(tg.vx, tg.vz) * LEAD_AHEAD, speed, out);
      return out;
    }
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
    attackTarget(self, tg, this.role[u]!, this.turn[self.id]!, speed, dist, headOn, out);
    // Wedged (against its target on a wall, or a car): back off for another run.
    this.wedge.watch(u, self.x, self.z, dt, out);
    return out;
  }

  /** Lead-in: full throttle along the road toward where the target is heading (`sTo`), never straight at its side. */
  private lead(u: number, self: AiCar, sS: number, sTo: number, speed: number, out: DriveInput): void {
    const L = this.track.length;
    const far = sTo - sS - L * Math.round((sTo - sS) / L);
    const s = sS + Math.max(LEAD_MIN, Math.min(speed * LEAD_AHEAD, far));
    const pt = this.track.pointAt(((s % L) + L) % L, this.pt);
    const blend = Math.min(1, (2 * (LEAD_IN - this.leadIn[u]!)) / LEAD_IN);
    const alpha = blend * wrapPi(Math.atan2(pt.x - self.x, pt.z - self.z) - self.yaw);
    const reach = Math.hypot(pt.x - self.x, pt.z - self.z);
    // An aim behind its shoulder (the stakeout car facing the oncoming racers): full lock, half throttle.
    const behind = Math.abs(alpha) > BEHIND;
    out.steer = behind ? Math.sign(alpha) : pursuitSteer(alpha, reach, speed, this.turn[self.id]!);
    out.throttle = behind ? 0.5 : 1;
    out.boost = Math.abs(alpha) < 0.35;
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
        // Held back until a racer passes its spot (or a knock moves it).
        let r = this.passer(u, cars, hunt, time);
        if (r < 0 && Math.hypot(car.vx, car.vz) > KNOCK) r = this.nearest(car, cars, hunt, time);
        if (r >= 0) this.wake(u, r);
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
          this.disband(p, cars, world);
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
        this.disband(p, cars, world);
        continue;
      }
      if (this.sustain[p]! >= REINFORCE_EVERY && size < PACK_MAX) {
        this.sustain[p] = 0;
        const u = this.free();
        const side = this.roll() < 0.5 ? 1 : -1;
        if (u < 0) continue;
        // Parked ahead where nobody sees it; else it comes up from behind, already chasing.
        if (this.spot(tg, REINF_AHEAD, side, 1, cars, world)) this.place(u, p, size, cars, world);
        else if (this.spot(tg, -REINF_AHEAD, side, 1, cars, world)) {
          this.place(u, p, size, cars, world);
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
      this.place(u, p, k, cars, world);
    }
    if (this.packLive[p]) this.stats.stakeouts++;
  }

  /** Park unit `u` at the last `spot` as member `role` of pack `p`; `cars` takes its new place at once, so the next `spot` of this beat keeps clear of it. */
  private place(u: number, p: number, role: number, cars: readonly AiCar[], world: PoliceWorld): void {
    const id = this.first + u;
    const s = this.spotAt;
    world.park(id, s.x, s.y, s.z, s.yaw);
    cars[id]!.x = s.x;
    cars[id]!.z = s.z;
    this.line.respawned(id);
    this.seg[id] = -1;
    this.pack[u] = p;
    this.role[u] = role;
    this.wedge.reset(u);
    this.parkS[u] = s.s;
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
      this.spotAt.s = ws;
      return true;
    }
    return false;
  }

  /** Wake unit `u` (a racer passed it): it joins its pack's pursuit, or starts one after `racer`. Its pack-mates further on wait for their own pass. */
  private wake(u: number, racer: number): void {
    const p = this.pack[u]!;
    this.setState(u, "pursuit");
    if (this.target[p]! >= 0) return;
    this.target[p] = racer;
    this.sustain[p] = 0;
    this.lost[p] = 0;
    this.age[p] = 0;
    this.stats.pursuits++;
  }

  /**
   * Pack `p` gives up: its chasers drive off and are stored out of view. A unit still parked (no racer passed its
   * spot, so it never woke) has nothing to give up: unseen, it is put away where it stands; in view, it drives off
   * like the rest rather than vanish.
   */
  private disband(p: number, cars: readonly AiCar[], world: PoliceWorld): void {
    this.packLive[p] = 0;
    this.target[p] = -1;
    for (let u = 0; u < this.count; u++) {
      if (this.pack[u] !== p) continue;
      this.pack[u] = -1;
      if (this.state[u] !== "parked") this.since[u] = 0;
      else if (world.seen(cars[this.first + u]!.x, cars[this.first + u]!.z)) this.setState(u, "pursuit");
      else this.store(u, world);
    }
  }

  protected override store(u: number, world: PoliceWorld): void {
    super.store(u, world);
    this.pack[u] = -1;
    this.setState(u, "stored");
  }

  /** Parked → pursuit starts the lead-in. */
  private setState(u: number, st: UnitState): void {
    if (st === "pursuit" && this.state[u] === "parked") this.leadIn[u] = LEAD_IN;
    this.state[u] = st;
    this.since[u] = 0;
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

  /**
   * The racer most recently past unit `u`'s spot along the road, by under `PASSED` m (−1 none). A racer outside the road's corridor (across
   * the field on a shortcut) is not passing anything: its nearest road point slides along the road as it drives, past a spot it never came near.
   */
  private passer(u: number, cars: readonly AiCar[], hunt: Uint8Array, time: number): number {
    const path = this.track.path;
    const L = this.track.length;
    let best = -1;
    let bestD = PASSED;
    for (let i = 0; i < this.line.racers; i++) {
      if (!this.huntable(i, hunt, time)) continue;
      const on = projectPath(path, cars[i]!.x, cars[i]!.z, this.seg[i]!, this.proj);
      this.seg[i] = on.k;
      const reach = path.half[on.k]! + Math.max(path.runL[on.k]!, path.runR[on.k]!) + CORRIDOR;
      if (on.dist2 > reach * reach) continue;
      const d = on.s - this.parkS[u]! - L * Math.round((on.s - this.parkS[u]!) / L);
      if (d >= 0 && d < bestD) {
        bestD = d;
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
}
