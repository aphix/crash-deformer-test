import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import type { DriveInput } from "../vehicle/car-drive.ts";
import type { AiCar } from "./derby-ai.ts";
import { clamp, wrapPi } from "../kernel/scalar.ts";
import type { PropCollider } from "../world/placements.ts";
import type { SurvivalSpec } from "../world/track-schema.ts";
import type { Track } from "../world/track.ts";
import { ATTACK, attackTarget, CATCH_UP, CopBrain, HEAD_ON, PULL_OUT, pursuitSteer, RAM_TIME, TAIL_LANE, WAIT_BEHIND, type HunterWorld } from "./cop-brain.ts";

/** Survival's pack (docs/SURVIVAL.md): how many cops, how fast more come, where a cop that is lost or wrecked is put back. */
export const HUNT = {
  /** Seconds between one more cop wanted. */
  every: 12,
  /** Most cops hunting at once. */
  cap: 12,
  /** Cars built for the pack: the cap, and a few wrecks that lie until nobody can see them go. */
  units: 16,
  /** A wrecked cop lies this long (s) before it may be put away, once nobody can see it go. */
  wreckStore: 6,
  /** A cop farther than `far` m from the player and out of sight for `farTime` s is put away, and dropped in again. */
  far: 140,
  farTime: 5,
  /** Seconds between two drop-ins. */
  gap: 1.5,
  /** A cop drops in this far (m) from the player: at least, at most. */
  dropMin: 70,
  dropMax: 120,
  /**
   * Seconds a placed cop waits to show, the player driving on: the beat runs inside a physics step, the cop shows when the frame that step is
   * in ends, and a frame runs at most 8 steps (`SimPacer`'s MAX_STEPS) of at most `physicsSlice` at the engine's slowest slice speed (8 m/s): 8 × 0.07 / 8 s.
   * A spot keeps `dropMin` from the player's whole path over it.
   */
  lag: 0.07,
  /** Metres between the candidate drop-in spots along the roads, and the room a spot keeps from every car. */
  spacing: 6,
  clear: 12,
  /** Most `hidden` tests a drop-in beat spends (each may sight-line the camera against the course's solids). */
  tests: 16,
  /**
   * Cops (the formation, the cap and the units built) added per human beyond the first, as a share of one human's pack: a hosted run
   * with several humans hunts them in proportion (`packScale`). Measured (docs/SURVIVAL.md, Co-op): 1 holds two humans' median fall at the lone
   * player's (16.0 s against 17.2 s), 0.5 does not (19.7 s), and more than 1 adds nothing (drop-ins are one per `gap`).
   */
  perHuman: 1,
} as const;

/**
 * The pack a run grows for `humans` free humans: `perHuman` more of everything (the cops wanted, the cap, the units built) for each human
 * beyond the first, so a team of any size is pressed per head as one human is.
 */
function packScale(humans: number): number {
  return 1 + HUNT.perHuman * Math.max(0, humans - 1);
}

/** Units built for a run that starts with `humans` humans, in a car list with `room` cars free for them: a pack never needs more cars than the room has. */
export function huntUnits(humans: number, room: number): number {
  return Math.min(room, Math.ceil(HUNT.units * packScale(humans)));
}

/** The most cops hunting at once with `humans` free humans and `units` units built: the cap scaled, the wrecks' share of the units kept. */
export function huntCap(humans: number, units: number): number {
  return Math.min(units - (HUNT.units - HUNT.cap), Math.ceil(HUNT.cap * packScale(humans)));
}

/** The cops the run wants `time` s after the green for `humans` free humans (`units` built), from the `formation` at the start: one more every `HUNT.every` s up to the cap. */
export function copsWanted(time: number, formation: number, humans = 1, units: number = HUNT.units): number {
  return Math.min(huntCap(humans, units), Math.ceil((formation + Math.floor(Math.max(0, time) / HUNT.every)) * packScale(humans)));
}

const STORED = 0;
const HUNTING = 1;
const DOWN = 2;

/** Half width (m) of the swath a hunter keeps clear of solids, and the room a probe keeps from a solid's face. */
const SWATH = 1.6;
/** Metres between the probes along a heading (a palm is 3.8 m across with the swath), and the headings tried off the straight one, in turn, to either side. */
const PROBE_STEP = 2;
const TURNS = [0.3, 0.6, 0.9, 1.25, 1.6, 2.2, Math.PI] as const;
/** A quarry slower than this (m/s) is not blocked from ahead (a unit braking in front of a stopped player waits for ever); it is rammed. */
const BLOCKABLE = 6;
/** A unit this close (m) to a quarry that has stopped eases to a creep (m/s): the bust needs the quarry slow, and a ram makes it fast. */
const SETTLE = 12;
const CREEP = 3;
/** Above this speed (m/s) a unit lifts when a solid is close ahead; below it, easing off only wedges it. */
const DODGE_SPEED = 8;
/** With no heading clear for the whole stretch, a bend of one radian is worth this many metres of clear run. */
const TURN_COST = 6;
/** Metres of road behind a target that a queue lane must keep clear of solids. */
const QUEUE = 30;
/** Obstacle grid cell (m). */
const CELL = 16;
/** A piece of a prop that starts higher than this (m) over the prop's foot is driven under (a tree's crown, a billboard's panel): a car's roofline is 1.36 m. */
const CLEARANCE = 1.38;

/** The course's solid props (`body: "solid"`) on a grid, the pieces of them a car meets (not a crown over its roof): is a point inside one, grown by the swath. */
export class Obstacles {
  private readonly cells = new Map<number, number[]>();
  private readonly x: Float64Array;
  private readonly z: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly hx: Float64Array;
  private readonly hz: Float64Array;
  private readonly circle: Uint8Array;

  constructor(colliders: readonly PropCollider[]) {
    const all = colliders.filter((c) => c.body === "solid");
    // A prop's foot is the lowest base among its pieces (they share an index).
    const foot = new Map<number, number>();
    for (const c of all) foot.set(c.index, Math.min(foot.get(c.index) ?? Infinity, c.base));
    const solid = all.filter((c) => c.base - foot.get(c.index)! < CLEARANCE);
    this.x = Float64Array.from(solid, (c) => c.x);
    this.z = Float64Array.from(solid, (c) => c.z);
    this.cos = Float64Array.from(solid, (c) => detCos(c.yaw));
    this.sin = Float64Array.from(solid, (c) => detSin(c.yaw));
    this.hx = Float64Array.from(solid, (c) => c.hx + SWATH);
    this.hz = Float64Array.from(solid, (c) => c.hz + SWATH);
    this.circle = Uint8Array.from(solid, (c) => (c.kind === "circle" ? 1 : 0));
    for (const [i, c] of solid.entries()) {
      const r = c.r + SWATH;
      for (let gx = Math.floor((c.x - r) / CELL); gx <= Math.floor((c.x + r) / CELL); gx++) {
        for (let gz = Math.floor((c.z - r) / CELL); gz <= Math.floor((c.z + r) / CELL); gz++) {
          const key = cellKey(gx, gz);
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    }
  }

  blocked(x: number, z: number): boolean {
    const list = this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return false;
    for (const i of list) {
      const ex = x - this.x[i]!;
      const ez = z - this.z[i]!;
      if (this.circle[i]) {
        if (ex * ex + ez * ez < this.hx[i]! * this.hx[i]!) return true;
        continue;
      }
      // The prop's frame: local x = (cos, −sin), local z = (sin, cos).
      const lx = ex * this.cos[i]! - ez * this.sin[i]!;
      const lz = ex * this.sin[i]! + ez * this.cos[i]!;
      if (Math.abs(lx) < this.hx[i]! && Math.abs(lz) < this.hz[i]!) return true;
    }
    return false;
  }

  /** Metres from (x, z) along heading `h` to the first solid (`len` when the way is clear that far). */
  run(x: number, z: number, h: number, len: number): number {
    const dx = detSin(h);
    const dz = detCos(h);
    for (let d = PROBE_STEP; d <= len; d += PROBE_STEP) if (this.blocked(x + dx * d, z + dz * d)) return d - PROBE_STEP;
    return len;
  }
}

function cellKey(gx: number, gz: number): number {
  return (gx + 4096) * 8192 + (gz + 4096);
}

/**
 * Survival's cops (Driver 2's mode, docs/SURVIVAL.md): cars `first … first + count − 1` hunt the player over open ground, up
 * the embankment and across the plaza, not along a road: the aim is the player (led by its velocity), the heading is bent to the
 * most open of a few headings when a solid prop stands in the way, and within `ATTACK` m the unit attacks with the police's own
 * geometry (`attackTarget`: PIT, slam, block, head-on ram), steers by their one rule (`pursuitSteer`) and backs off when wedged
 * (`Backoff`). Far behind it boosts to catch up (police have no meter), so a full-throttle player cannot simply outrun the pack.
 *
 * The pack grows (`copsWanted`): the formation at the green, one more every `HUNT.every` s up to `HUNT.cap`. A cop wrecked (`down`)
 * or lost (far and unseen) is put away and a new one dropped in on a road, `HUNT.dropMin`…`dropMax` m from the player, ahead of it
 * first, only where `world.hidden` says the camera cannot see it. Deterministic (seeded dice, no clock); no allocation per call.
 */
export class HunterBrain extends CopBrain {
  /** This run: cops dropped in after the start, put away for being lost, knocked out, and the most hunting at once. */
  readonly stats = { drops: 0, despawns: 0, disabled: 0, peak: 0 };
  private readonly racers: number;
  private readonly formation: SurvivalSpec["formation"];
  private readonly obstacles: Obstacles;
  /** Driving, so a slow one may be pulling out (not waiting in storage). */
  protected readonly pullsOut = (u: number): boolean => this.state[u] !== STORED;
  private readonly state: Uint8Array;
  private readonly lost: Float64Array;
  /** Per unit: the side (+1 / −1) it last bent round a solid, so it keeps to it. */
  private readonly side: Int8Array;
  /** Candidate drop-in spots along every road: position and the road's direction. */
  private readonly spotX: number[] = [];
  private readonly spotZ: number[] = [];
  private readonly spotTx: number[] = [];
  private readonly spotTz: number[] = [];
  /** The free-human flags of the last patrol (`update`), by car id; null before the first. */
  private hunted: Uint8Array | null = null;
  /** Per unit: the car id of the human it is after (the nearest free one; −1 none). */
  private readonly aim: Int16Array;
  /** The distance (m) `nearestHunted` found. */
  private nearGap = Infinity;
  private go = false;
  private nextDrop = 0;
  /** Per unit: the lane it last queued in (−1 / +1; 0 none). Scratch: the queue place `slot` found, and the last drop-in spot found. */
  private readonly queued: Int8Array;
  private lane = 0;
  private row = 0;
  private readonly at = { x: 0, z: 0, yaw: 0 };

  /** `racers` cars (ids 0 …) are hunted; the units follow them from `first`. */
  constructor(track: Track, colliders: readonly PropCollider[], racers: number, first: number, count: number, seed: number) {
    super(first, count, seed);
    const spec = track.survival;
    if (!spec) throw new Error(`${track.id} has no survival anchors`);
    this.racers = racers;
    this.formation = spec.formation;
    this.obstacles = new Obstacles(colliders);
    this.state = new Uint8Array(count);
    this.aim = new Int16Array(count).fill(-1);
    this.lost = new Float64Array(count);
    this.queued = new Int8Array(count);
    this.side = new Int8Array(count).fill(1);
    for (const p of track.paths()) {
      for (let k = 0; k < p.count; k += HUNT.spacing) {
        if (p.deck[k]) continue;
        this.spotX.push(p.x[k]!);
        this.spotZ.push(p.z[k]!);
        this.spotTx.push(p.tx[k]!);
        this.spotTz.push(p.tz[k]!);
      }
    }
  }

  /** Cops hunting now. */
  get hunting(): number {
    let n = 0;
    for (let u = 0; u < this.count; u++) if (this.state[u] === HUNTING) n++;
    return n;
  }

  /** The run starts: the formation takes its slots, held until the green (`update` sees time ≥ 0). */
  launch(world: HunterWorld): void {
    this.go = false;
    this.aim.fill(-1);
    this.nextDrop = 0;
    for (let u = 0; u < this.count; u++) this.state[u] = STORED;
    for (const [k, f] of this.formation.entries()) {
      if (k >= this.count) continue;
      world.park(this.first + k, f.x, 0, f.z, f.yaw);
      this.deploy(k, world);
    }
  }

  /** Cops after racer `id` now: the units hunting that have it as the nearest free human. */
  copsOn(id: number): number {
    let n = 0;
    for (let u = 0; u < this.count; u++) if (this.state[u] === HUNTING && this.aim[u] === id) n++;
    return n;
  }

  protected chasing(u: number): boolean {
    return this.state[u] === HUNTING;
  }

  protected stored(u: number): boolean {
    return this.state[u] === STORED;
  }

  /** Its hunt. */
  protected drive(self: AiCar, cars: readonly AiCar[], dt: number): DriveInput {
    const out = this.out;
    out.throttle = 0;
    out.steer = 0;
    out.brake = 1;
    out.ebrake = false;
    out.boost = false;
    const u = self.id - this.first;
    if (u < 0 || u >= this.count) return out;
    // Each cop hunts the nearest human still free; the one it is after now is its `aim`.
    const target = this.nearestHunted(self.x, self.z, cars);
    this.aim[u] = target;
    if (!self.alive || this.state[u] !== HUNTING || !this.go || target < 0) return out;
    out.brake = 0;
    if (this.wedge.backing(u, dt, out)) return out;
    const speed = hypot2(self.vx, self.vz);
    const tg = cars[target]!;
    const dx = tg.x - self.x;
    const dz = tg.z - self.z;
    const dist = hypot2(dx, dz);
    const tv = hypot2(tg.vx, tg.vz);
    // How far the unit stands ahead of its target along the target's travel (+), and whether it faces it from there.
    const along = -(dx * detSin(tg.yaw) + dz * detCos(tg.yaw));
    const headOn = along > WAIT_BEHIND && detSin(self.yaw) * dx + detCos(self.yaw) * dz > dist * HEAD_ON;
    const reach = along > 0 ? Math.max(ATTACK, tv * (headOn ? RAM_TIME : PULL_OUT)) : ATTACK;
    if (dist <= reach) {
      this.slot(u, self, tg, dist, cars);
      attackTarget(self, tg, this.role[u]!, this.turn[self.id]!, speed, dist, headOn, out, tv > BLOCKABLE, this.lane, this.row);
      this.dodge(u, self, tg, speed, dist, out);
      // A stopped player is boxed in, not rammed: a hit at 8 m/s throws the car over the bust's 20 km/h and restarts its hold.
      if (tv <= BLOCKABLE && dist < SETTLE && speed > CREEP) {
        out.throttle = 0;
        out.brake = 0.5;
        out.boost = false;
      }
    } else this.chase(u, self, tg, speed, dist, out);
    this.wedge.watch(u, self.x, self.z, dt, out);
    return out;
  }

  /**
   * Where unit `u` queues behind a target too fast to PIT: a lane (±`TAIL_LANE` m either side of the target's line, never the line itself:
   * a car right behind a target that brakes has nowhere to go) and its row there. The unit keeps the side it is on, or a side it took
   * before while it is within a metre of the line, and takes the other while a prop stands in the way of its queue (a palm row the
   * target hugs). Its row counts the hunters queued in that lane that are nearer the target, so the queue keeps the order the pack has.
   * Sets `lane`, `row`.
   */
  private slot(u: number, self: AiCar, tg: AiCar, dist: number, cars: readonly AiCar[]): void {
    const lx = detCos(tg.yaw);
    const lz = -detSin(tg.yaw);
    const side = (self.x - tg.x) * lx + (self.z - tg.z) * lz;
    let lane = side > 1 ? 1 : side < -1 ? -1 : this.queued[u] || (side >= 0 ? 1 : -1);
    if (this.obstacles.run(tg.x + lx * lane * TAIL_LANE, tg.z + lz * lane * TAIL_LANE, tg.yaw + Math.PI, QUEUE) < QUEUE) lane = -lane;
    this.queued[u] = lane;
    this.lane = lane;
    this.row = 0;
    for (let v = 0; v < this.count; v++) {
      if (v === u || this.state[v] !== HUNTING || this.queued[v] !== lane || this.aim[v] !== this.aim[u]) continue;
      const c = cars[this.first + v]!;
      if (c.alive && hypot2(c.x - tg.x, c.z - tg.z) < dist) this.row++;
    }
  }

  /** A solid nearer than the target dead ahead of an attacking unit: bend round it (the police's attack geometry knows no walls). */
  private dodge(u: number, self: AiCar, tg: AiCar, speed: number, dist: number, out: DriveInput): void {
    const len = clamp(speed * 0.7 + 4, 6, 20);
    const clear = this.obstacles.run(self.x, self.z, self.yaw, len);
    if (clear >= len || clear >= dist - 3) return;
    const h = this.openHeading(u, self, Math.atan2(tg.x - self.x, tg.z - self.z), speed, dist);
    out.steer = pursuitSteer(wrapPi(h - self.yaw), clamp(speed * 0.8, 8, 24), speed, this.turn[self.id]!);
    if (speed > DODGE_SPEED && clear < speed * 0.35) out.throttle = Math.min(out.throttle, 0.3);
  }

  /** Beyond `ATTACK`: flat out at where the target will be, round any solid in the way, boosting when far behind. */
  private chase(u: number, self: AiCar, tg: AiCar, speed: number, dist: number, out: DriveInput): void {
    const lead = Math.min(2, dist / Math.max(8, speed));
    const ax = tg.x + tg.vx * lead;
    const az = tg.z + tg.vz * lead;
    const aimDist = hypot2(ax - self.x, az - self.z);
    const h = this.openHeading(u, self, Math.atan2(ax - self.x, az - self.z), speed, aimDist);
    const alpha = wrapPi(h - self.yaw);
    // Pure pursuit looks a speed-scaled way ahead, so a heading bent round a solid is followed as sharply as it was asked.
    out.steer = pursuitSteer(alpha, Math.min(aimDist, clamp(speed * 0.8, 8, 24)), speed, this.turn[self.id]!);
    out.throttle = Math.abs(alpha) > 1.3 && speed > 6 ? 0.2 : 1;
    out.boost = out.throttle > 0.5 && dist > CATCH_UP && Math.abs(alpha) < 0.35;
  }

  /** The heading nearest `want` whose way is clear of solids for the next stretch; else the one with the longest clear run, a bend costing `TURN_COST` m per radian. */
  private openHeading(u: number, self: AiCar, want: number, speed: number, aimDist: number): number {
    const len = Math.min(aimDist, clamp(speed * 1.1 + 8, 12, 34));
    let best = want;
    let bestScore = this.obstacles.run(self.x, self.z, want, len);
    if (bestScore >= len) return want;
    const s0 = this.side[u]!;
    for (const t of TURNS) {
      for (let k = 0; k < 2; k++) {
        const s = k === 0 ? s0 : -s0;
        const h = want + s * t;
        const run = this.obstacles.run(self.x, self.z, h, len);
        const score = run >= len ? Infinity : run - t * TURN_COST;
        if (score > bestScore) {
          bestScore = score;
          best = h;
          this.side[u] = s;
          if (run >= len) return h;
        }
      }
    }
    return best;
  }

  update(time: number, dt: number, cars: readonly AiCar[], hunt: Uint8Array, _lead: number, world: HunterWorld): void {
    this.go = time >= 0;
    this.hunted = hunt;
    let humans = 0;
    for (let i = 0; i < this.racers; i++) humans += hunt[i]!;
    let hunting = 0;
    for (let u = 0; u < this.count; u++) {
      const st = this.state[u]!;
      if (st === STORED) continue;
      const id = this.first + u;
      const car = cars[id]!;
      this.since[u]! += dt;
      if (st === DOWN) {
        if (this.since[u]! > HUNT.wreckStore && world.hidden(car.x, car.z)) this.store(u, world);
        continue;
      }
      if (world.down(id)) {
        this.state[u] = DOWN;
        this.since[u] = 0;
        world.sirens(id, false);
        this.stats.disabled++;
        continue;
      }
      // Lost: far from every free human and nobody to see it go.
      const far = this.nearestHunted(car.x, car.z, cars) >= 0 && this.nearGap > HUNT.far;
      this.lost[u] = far && world.hidden(car.x, car.z) ? this.lost[u]! + dt : 0;
      if (this.lost[u]! > HUNT.farTime) {
        this.store(u, world);
        this.stats.despawns++;
        continue;
      }
      hunting++;
    }
    this.stats.peak = Math.max(this.stats.peak, hunting);
    if (!this.go || humans === 0 || time < this.nextDrop || hunting >= copsWanted(time, this.formation.length, humans, this.count)) return;
    const u = this.free();
    const tg = this.dropTarget(cars);
    if (u < 0 || !this.dropSpot(tg, cars, world)) return;
    world.park(this.first + u, this.at.x, 0, this.at.z, this.at.yaw);
    this.deploy(u, world);
    this.stats.drops++;
    this.nextDrop = time + HUNT.gap;
  }

  /** The free human with the fewest cops after it (the lowest car id on a tie): where the next drop-in is aimed. */
  private dropTarget(cars: readonly AiCar[]): AiCar {
    let best = -1;
    let fewest = Infinity;
    for (let i = 0; i < this.racers; i++) {
      if (this.hunted![i] !== 1) continue;
      const n = this.copsOn(i);
      if (n < fewest) {
        fewest = n;
        best = i;
      }
    }
    return cars[best]!;
  }

  /** The nearest free human (`hunt` flags of the last patrol) to (x, z): its car id, −1 when none. Sets `nearGap` to the distance (m). */
  private nearestHunted(x: number, z: number, cars: readonly AiCar[]): number {
    const hunted = this.hunted;
    let best = -1;
    let gap = Infinity;
    if (hunted !== null) {
      for (let i = 0; i < this.racers; i++) {
        if (hunted[i] !== 1) continue;
        const d = hypot2(cars[i]!.x - x, cars[i]!.z - z);
        if (d < gap) {
          gap = d;
          best = i;
        }
      }
    }
    this.nearGap = gap;
    return best;
  }

  /** Unit `u` is parked and starts hunting. */
  private deploy(u: number, world: HunterWorld): void {
    this.state[u] = HUNTING;
    this.since[u] = 0;
    this.lost[u] = 0;
    this.role[u] = u;
    this.queued[u] = 0;
    this.wedge.reset(u);
    world.sirens(this.first + u, true);
  }

  protected override store(u: number, world: HunterWorld): void {
    super.store(u, world);
    this.state[u] = STORED;
  }

  /**
   * A road spot `dropMin … dropMax` m from `tg` (`dropMin` from every point of its path over the next `HUNT.lag` s, going straight on: the cop shows
   * that much later), clear of every car, that the camera cannot see (`world.hidden`), facing along the road toward the player: ahead of the
   * player's travel first, anywhere round it if none is. Fills `at`.
   */
  private dropSpot(tg: AiCar, cars: readonly AiCar[], world: HunterWorld): boolean {
    const n = this.spotX.length;
    const fx = detSin(tg.yaw);
    const fz = detCos(tg.yaw);
    const v2 = tg.vx * tg.vx + tg.vz * tg.vz;
    const moving = hypot2(tg.vx, tg.vz) > 5;
    let tests = 0;
    for (let pass = moving ? 0 : 1; pass < 2; pass++) {
      const ahead = pass === 0;
      const from = Math.floor(this.roll() * n);
      for (let k = 0; k < n; k++) {
        const i = (from + k) % n;
        const dx = this.spotX[i]! - tg.x;
        const dz = this.spotZ[i]! - tg.z;
        const d = hypot2(dx, dz);
        if (d > HUNT.dropMax || (ahead && dx * fx + dz * fz < d * 0.3)) continue;
        const t = v2 > 0 ? clamp((dx * tg.vx + dz * tg.vz) / v2, 0, HUNT.lag) : 0;
        if (hypot2(dx - tg.vx * t, dz - tg.vz * t) < HUNT.dropMin) continue;
        if (this.crowded(this.spotX[i]!, this.spotZ[i]!, cars) || this.nearHuman(this.spotX[i]!, this.spotZ[i]!, tg.id, cars)) continue;
        if (tests++ >= HUNT.tests) return false;
        if (!world.hidden(this.spotX[i]!, this.spotZ[i]!)) continue;
        // Along the road, the way that points at the player.
        const sign = this.spotTx[i]! * -dx + this.spotTz[i]! * -dz >= 0 ? 1 : -1;
        this.at.x = this.spotX[i]!;
        this.at.z = this.spotZ[i]!;
        this.at.yaw = Math.atan2(this.spotTx[i]! * sign, this.spotTz[i]! * sign);
        return true;
      }
    }
    return false;
  }

  private crowded(x: number, z: number, cars: readonly AiCar[]): boolean {
    for (const c of cars) if (hypot2(c.x - x, c.z - z) < HUNT.clear) return true;
    return false;
  }

  /** Whether (x, z) is nearer than `dropMin` to a free human other than `except`: a cop does not drop in on a teammate's side. */
  private nearHuman(x: number, z: number, except: number, cars: readonly AiCar[]): boolean {
    const hunted = this.hunted;
    if (hunted === null) return false;
    for (let i = 0; i < this.racers; i++) if (i !== except && hunted[i] === 1 && hypot2(cars[i]!.x - x, cars[i]!.z - z) < HUNT.dropMin) return true;
    return false;
  }
}
