import { FLIGHT, type DeformableCar } from "../vehicle/car.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import {
  HighlightLedger,
  impactEnergy,
  FINE_PEDALS,
  INPUT_BYTES,
  MEMORY,
  PAIR_MIN,
  PRE_ROLL,
  countsAsImpact,
  TOP,
  WALL_MIN,
  type CrashCluster,
  type ClipEjection,
  type HighlightClip,
  type ReelCar,
} from "../match/highlights.ts";
import { ensureFrames, makeSnapshot, readSnapshot, Reader, snapshotMaxBytes, writeSnapshot, Writer, type NetLayout, type Snapshot } from "../net/codec.ts";
import { carLayout, readCarPose } from "../net/car-pose.ts";
import { REEL_BUDGET } from "../net/reel-codec.ts";

/**
 * Ring depth in steps. A race steps at 240–300 Hz (`physicsSlice` caps a step at 7 cm of travel, and a frame's
 * remainder is one more step), so this is ≥ 17 s: a clip is at most PRE_ROLL + MAX_SPAN + POST_ROLL = 12 s plus
 * up to one keyframe interval back to its keyframe.
 */
const RING = 5120;
/**
 * Keyframe interval (s). A wreck's solver state rides every keyframe a clip keeps before its first impact: about 70 % of
 * a pile-up clip's bytes, and a reel budgets `REEL_BUDGET` of them. Restoring the shape clusters' fit state
 * (`simState`) cut a restored wreck's drift enough for 1 s (it was 0.5 s: a wreck restored without it drifted so far
 * that at 1 s the first impact came 0.35 s early, at 0.5 s 0.16 s). At 1 s a stunt race's top clips are 303 KB where
 * 0.5 s made them 481 KB (3 clips fit a reel instead of 2), and engine-replay.test.ts (city seeds 1-8) keeps its
 * 0.2 s / 1.5 m bounds.
 */
const KEY_EVERY = 1;
/** Clip seconds after its first impact that the involved cars' exact pedals are kept (`fine`). */
const FINE_S = 2;
/** Keyframes kept: the ring's span and then some. */
const KEY_SLOTS = 40;
/** Ejections remembered for the clips (a race has a handful; the oldest drop out of a pathological one). */
const MAX_EJECTED = 64;

/**
 * A clip also takes cars within this many metres of its hit (`bystanders`): a camera sees them, and a car left out of
 * a clip is hidden for the whole replay. The longest sight line of a replay camera (the dutch cams' `DUTCH.range`) is
 * 90 m.
 */
const BYSTANDER_R = 80;
/**
 * The size (estimated bytes, `bystanders`) a clip may grow to by bystanders: its share of a reel's budget, `REEL_BUDGET`
 * over the `TOP` clips of a reel, at 3.3 estimated bytes per deflated byte (measured over 23 recorded clips). A clip
 * that a pile-up already fills takes none.
 */
const CLIP_SHARE = (REEL_BUDGET / TOP) * 3.3;
/**
 * A clip's deflated bytes as a share of its raw ones, by part (measured on city and stunt clips: the keyframes 0.39 to
 * 0.43, the inputs 0.24, the pedal digits 0.67; the step schedule 0.011 over 232 city clips, rounded up to 0.02), and the
 * most a clip is allowed (estimated): three clips fit a reel message.
 */
const DEFLATED_KEYS = 0.42;
const DEFLATED_INPUTS = 0.25;
const DEFLATED_FINE = 0.67;
const DEFLATED_SHAPE = 0.02;
const CLIP_BUDGET = REEL_BUDGET / 3;

/**
 * What the course (the race's walls and props) remembers between steps, which a keyframe carries so a replay starts
 * from it rather than from a scene that forgot: per car its `MEMORY` doubles (the wall contact memory and the road
 * projection hint), and per placed prop whether a car has knocked it off its spot.
 */
interface CourseMemory {
  /** Car `i`'s `MEMORY` doubles into `out`. */
  recall(i: number, out: Float64Array): void;
  /** One flag per placed prop: 1 knocked off its spot (the live array, not a copy). */
  knocks(): Uint8Array;
}
/** A car with no wall history on no road segment, as a placement leaves one (and what a recorder with no course writes). */
const NO_MEMORY = [Infinity, 0, 0, -1];

/**
 * Race highlight recorder (docs/HIGHLIGHTS.md), host or offline only. Per fixed step every car's drive output
 * goes into a typed-array ring (`INPUT_BYTES`), with the step's dt, and every car's pose is read into a scratch
 * snapshot. Every `KEY_EVERY` s that snapshot, with each wreck's deform and parts (the netplay wreck section), is
 * encoded into a keyframe ring (`writeSnapshot`), then per car its drift state, its flight block and, for a wreck,
 * its solver state (`simState`); a cluster's first impact encodes them once more. Impacts feed the ledger; when a
 * cluster's post-roll is over and it ranks, its slice is copied out of the rings into a clip (the only allocation,
 * a few times a race). Steady state allocates nothing.
 */
export class CrashRecorder {
  /** Recording (a race is running on this browser's sim). */
  on = false;
  readonly ledger = new HighlightLedger<HighlightClip>();
  private time = 0;
  /** The recorder's clock (s, from 0 at the race's start): what the open clusters' `first` / `last` are on. */
  get now(): number {
    return this.time;
  }
  private step = 0;
  private nextKey = 0;
  private keyCount = 0;
  private trackId = "";
  private realism = 0;
  private bleed = false;
  private look = 0;
  private names: (i: number) => string = (i) => `Car ${i}`;
  /** Cars below this index are racers; the rest are traffic and police, which score only against a racer. */
  private racers = 0;
  private cars: readonly DeformableCar[] = [];
  private layout: NetLayout | null = null;
  private readonly h = new Float32Array(RING);
  /** Recorder clock at each step's start. */
  private readonly at = new Float64Array(RING);
  private readonly inputs = new Uint8Array(RING * MAX_CARS * INPUT_BYTES);
  /** Per ring step × car: the pedals exactly as the sim ran them (`FINE_PEDALS` doubles: throttle, steer, brake). */
  private readonly fine = new Float64Array(RING * MAX_CARS * FINE_PEDALS);
  /** Per ring step: the world's schedule for it (`World.shape`). */
  private readonly shapes = new Uint32Array(RING);
  /** Every car at the start of the current step (wreck sections only on a keyframe step). */
  private readonly pre: Snapshot = makeSnapshot();
  /** Scratch for one car's flight block (and its bytes) and one wreck's solver state (sized at the first race: `simState`). */
  private readonly fly = new Float64Array(FLIGHT);
  private readonly flyBytes = new Uint8Array(this.fly.buffer);
  private sim = new Float64Array(0);
  private simBytes = new Uint8Array(0);
  /** The course's memory (null: a race on a flat field), and the bytes of knock flags one keyframe holds for its props. */
  private readonly course: CourseMemory | null;
  private knockBytes = 0;
  /** Scratch for one car's course memory (and its bytes). */
  private readonly mem = new Float64Array(MEMORY);
  private readonly memBytes = new Uint8Array(this.mem.buffer);
  /** Encoded keyframes (allocated at the first race), their lengths and the global step each was taken at. */
  private keys: Writer[] = [];
  private readonly keyStep = new Float64Array(KEY_SLOTS);
  private readonly alive = new Uint8Array(MAX_CARS);
  /** Per car: drafting this step (`drafting`), read into its input byte at the step's end. */
  private readonly draft = new Uint8Array(MAX_CARS);
  /** Last contact time per car pair (a·MAX_CARS + b) and per car against walls and props: a contact out of a quiet spell is an impact. */
  private readonly pairAt = new Float64Array(MAX_CARS * MAX_CARS);
  /** Last time a door, mirror or panel of one car of the pair met the other (`touch`), per pair like `pairAt`. */
  private readonly touchAt = new Float64Array(MAX_CARS * MAX_CARS);
  private readonly wallAt = new Float64Array(MAX_CARS);
  /** Per car: the recorder time it was last placed (`DeformableCar.placements` moved), not driven. */
  private readonly jumpAt = new Float64Array(MAX_CARS);
  /** Per car: its `placements` at the last step's start. */
  private readonly placed = new Uint32Array(MAX_CARS);
  /** Every car's (x, z) at the current step's start, and as of each kept keyframe (with that keyframe's car count), for `file`'s bystander pass. */
  private readonly lastPos = new Float32Array(MAX_CARS * 2);
  private readonly keyPos = new Float32Array(KEY_SLOTS * MAX_CARS * 2);
  private readonly keyN = new Uint8Array(KEY_SLOTS);
  /** Per kept keyframe: the cars that carry a wreck (a solver state) in it. */
  private readonly keyWreck = new Uint32Array(KEY_SLOTS);
  /** `bystanders`' scratch: each car's least squared distance to the hit. */
  private readonly near = new Float64Array(MAX_CARS);
  /**
   * Each open cluster's impact keyframe: every car as it stands at the start of the step after its first impact came
   * in (pose and wreck read together; mid-step a wreck's particles have moved on from the step-start pose).
   */
  private readonly impactKeys = new Map<CrashCluster, { step: number; bytes: Uint8Array | null }>();
  /** Clusters opened this step: their impact keyframe is encoded at the next step's start. */
  private readonly opening: CrashCluster[] = [];
  /** Every driver thrown out this race (`eject`): the step he left in, and the event; a clip takes those of its steps and cars. */
  private readonly ejected: { step: number; e: Ejection }[] = [];

  constructor(course: CourseMemory | null = null) {
    this.course = course;
  }

  /**
   * A race starts: clear everything. Cars below `racers` are the field (the rest, traffic and police, make a moment
   * only by hitting or being hit by a racer); `names(i)` labels car i in the clips; `bleed`: the engine's wreck-slide
   * rule is on.
   */
  begin(trackId: string, realism: number, bleed: boolean, racers: number, names: (i: number) => string, look: number): void {
    this.on = true;
    this.time = 0;
    this.step = 0;
    this.nextKey = 0;
    this.keyCount = 0;
    this.trackId = trackId;
    this.realism = realism;
    this.bleed = bleed;
    this.look = look;
    this.names = names;
    this.racers = racers;
    this.ledger.clear();
    this.impactKeys.clear();
    this.opening.length = 0;
    this.ejected.length = 0;
    this.alive.fill(1);
    this.pairAt.fill(-Infinity);
    this.touchAt.fill(-Infinity);
    this.wallAt.fill(-Infinity);
    this.jumpAt.fill(-Infinity);
    this.pre.count = 0;
  }

  /** Recording stops; open clusters are cut at the current step and filed if they rank. */
  end(): void {
    if (!this.on) return;
    for (let c = this.ledger.due(this.time, true); c; c = this.ledger.due(this.time, true)) this.file(c);
    this.on = false;
  }

  /** Start of a fixed step, before any drive: every car's pose, and the keyframe when due. */
  startStep(cars: readonly DeformableCar[]): void {
    if (!this.on || cars.length === 0) return;
    this.cars = cars;
    const n = Math.min(cars.length, MAX_CARS);
    const knockBytes = this.course ? (this.course.knocks().length + 7) >> 3 : 0;
    let L = this.layout;
    if (!L || knockBytes > this.knockBytes) {
      const lay = carLayout(cars[0]!);
      this.sim = new Float64Array(cars[0]!.deform.simSize());
      this.simBytes = new Uint8Array(this.sim.buffer);
      this.knockBytes = knockBytes;
      L = this.layout = lay;
      this.keys = Array.from({ length: KEY_SLOTS }, () => new Writer(this.keyBytes(MAX_CARS)));
    }
    const s = this.pre;
    const prev = s.count;
    ensureFrames(s, n, L);
    s.count = n;
    s.time = this.time;
    let jumped = false;
    for (let i = 0; i < n; i++) {
      const f = s.cars[i]!;
      const car = cars[i]!;
      readCarPose(car, f);
      // Placed (a respawn, a wake, a start, wherever it landed): the replay cannot drive there, so a keyframe is taken at once.
      if (i < prev && car.placements !== this.placed[i]) {
        jumped = true;
        this.jumpAt[i] = this.time;
      }
      this.placed[i] = car.placements;
      this.lastPos[2 * i] = f.x;
      this.lastPos[2 * i + 1] = f.z;
    }
    if (this.opening.length > 0) {
      const bytes = this.encodeKey(new Writer(this.keyBytes(n))).done().slice();
      for (const c of this.opening) {
        const key = this.impactKeys.get(c);
        if (key) key.bytes = bytes;
      }
      this.opening.length = 0;
    }
    if (this.time < this.nextKey && !jumped) return;
    this.nextKey = this.time + KEY_EVERY;
    const slot = this.keyCount++ % KEY_SLOTS;
    this.encodeKey(this.keys[slot]!);
    this.keyStep[slot] = this.step;
    this.keyPos.set(this.lastPos, slot * MAX_CARS * 2);
    this.keyN[slot] = n;
    let wrecks = 0;
    for (let i = 0; i < n; i++) if (s.cars[i]!.wreck) wrecks |= 1 << i;
    this.keyWreck[slot] = wrecks >>> 0;
  }

  /** End of a fixed step of `h` s whose world ran the schedule `shape` (`World.shape`): the drive outputs it ran on, engine kills, and any cluster now due. */
  endStep(cars: readonly DeformableCar[], h: number, shape: number): void {
    if (!this.on) return;
    const n = Math.min(cars.length, MAX_CARS);
    const s = this.step % RING;
    this.h[s] = h;
    this.shapes[s] = shape;
    this.at[s] = this.time;
    const inp = this.inputs;
    for (let i = 0; i < n; i++) {
      const c = cars[i]!;
      const d = c.drive;
      const o = (s * MAX_CARS + i) * INPUT_BYTES;
      const tx = d.throttle * 127;
      const sx = d.steer * 127;
      const bx = d.brake * 255;
      const f = (s * MAX_CARS + i) * FINE_PEDALS;
      inp[o] = Math.round(tx) & 255;
      inp[o + 1] = Math.round(sx) & 255;
      inp[o + 2] = Math.round(bx);
      inp[o + 3] = (d.ebrake ? 1 : 0) | (d.boost ? 2 : 0) | (this.draft[i] ? 4 : 0) | (d.neutral ? 8 : 0);
      this.fine[f] = d.throttle;
      this.fine[f + 1] = d.steer;
      this.fine[f + 2] = d.brake;
      this.draft[i] = 0;
      const alive = c.deform.drivetrainAlive ? 1 : 0;
      // A traffic or police car's death counts only inside a cluster a racer's hit opened.
      if (this.alive[i] && !alive && (i < this.racers || this.ledger.open.some((k) => (k.cars >>> i) & 1))) {
        this.opened(this.ledger.kill(this.time, i, c.group.position.x, c.group.position.z));
      }
      this.alive[i] = alive;
    }
    this.time += h;
    this.step++;
    for (let c = this.ledger.due(this.time); c; c = this.ledger.due(this.time)) this.file(c);
  }

  /** Car `i` drives this step at the race draft's top speed (`DRAFT.top`): the replay must too. */
  drafting(i: number): void {
    if (i < MAX_CARS) this.draft[i] = 1;
  }

  /** `World.pairHit`: a car–car SAT contact; the slice's first pass only (the contact the cars came in with). */
  pairHit(a: number, b: number, hit: ContactHit, first: boolean): void {
    const n = this.pre.count;
    if (!this.on || !first || a >= n || b >= n) return;
    const k = a * MAX_CARS + b;
    const counts = countsAsImpact(this.time - this.pairAt[k]!, hit.impulse, PAIR_MIN);
    this.pairAt[k] = this.time;
    // Traffic and police make a moment only against a racer (`begin`).
    if (!counts || (a >= this.racers && b >= this.racers)) return;
    const e = impactEnergy(hit.impulse, CLASSES[carClass(this.cars[a]!)].mass, CLASSES[carClass(this.cars[b]!)].mass);
    this.opened(this.ledger.impact(this.time, a, b, hit.impulse, e, hit.contact.x, hit.contact.z));
  }

  /**
   * `World.partTouch`: a door, mirror or panel of one car met the other, or their masses overlapped, with no SAT contact
   * (a sideswipe, a wreck's parts pressed on a car). It is no impact, but the struck car's parts tear and the striker
   * slows, so a clip that left the striker out replays the struck car differently (a passing car 1.8 m off two wedged
   * wrecks left them 61 cm out at the first impact; seed 25 of engine-replay.test.ts: a car left out of the clip pressed its masses on a clip car's, 1.4 m off by the impact).
   */
  touch(a: number, b: number): void {
    if (this.on && a < this.pre.count && b < this.pre.count) this.touchAt[a * MAX_CARS + b] = this.time;
  }

  /** A wall or prop touched car `i`, closing at `closing` m/s at (x, z). */
  wallHit(i: number, closing: number, x: number, z: number): void {
    if (!this.on || i >= this.pre.count) return;
    const counts = countsAsImpact(this.time - this.wallAt[i]!, closing, WALL_MIN);
    this.wallAt[i] = this.time;
    if (!counts || i >= this.racers) return;
    const e = impactEnergy(closing, CLASSES[carClass(this.cars[i]!)].mass, Infinity);
    this.opened(this.ledger.impact(this.time, i, -1, closing, e, x, z));
  }

  /**
   * The driver of car `e.car` was thrown out during the step under way (`EjectionWatch`): a moment worth `EJECT_POINTS`,
   * and the event is kept to throw his dummy again in a clip that carries the car. As for an engine kill, a traffic or
   * police car's counts only inside a cluster a racer's hit opened.
   */
  eject(e: Ejection): void {
    const car = this.cars[e.car];
    if (!this.on || !car) return;
    if (this.ejected.length >= MAX_EJECTED) this.ejected.shift();
    this.ejected.push({ step: this.step, e });
    if (e.car >= this.racers && !this.ledger.open.some((k) => (k.cars >>> e.car) & 1)) return;
    this.opened(this.ledger.eject(this.time, e.car, car.group.position.x, car.group.position.z));
  }

  /** A cluster's first impact: its correction keyframe follows at the next step's start (`startStep`). */
  private opened(c: CrashCluster): void {
    if (this.impactKeys.has(c)) return;
    this.impactKeys.set(c, { step: this.step + 1, bytes: null });
    this.opening.push(c);
  }

  /** Most bytes a keyframe of `n` cars takes: the snapshot, the prop flags, then per car its flight block, course memory and solver state. */
  private keyBytes(n: number): number {
    return snapshotMaxBytes(n, this.layout!) + 2 + this.knockBytes + n * (FLIGHT * 8 + MEMORY * 8 + 2 + this.sim.length * 8);
  }

  /**
   * The step-start snapshot (`pre`) with each wreck's deform and parts read now, then the course's knocked props (a u16
   * byte count, one bit per prop), then per car its flight block (`FLIGHT` doubles, native like the sim's bytes), its
   * course memory (`MEMORY` doubles) and its solver state (a u16 count, then that many doubles: `simState` for a wreck, none otherwise).
   */
  private encodeKey(w: Writer): Writer {
    const s = this.pre;
    for (let i = 0; i < s.count; i++) {
      const car = this.cars[i]!;
      const f = s.cars[i]!;
      // As the netplay host: a falling fake or a vaporized car carries no wreck.
      f.wreck = car.crashed && !car.falling && !car.vaporized;
      if (!f.wreck) continue;
      car.deform.readNetState(f.deform);
      car.readPartNetState(f.parts);
    }
    w.off = 0;
    writeSnapshot(w, s, this.layout!);
    const knocks = this.course?.knocks();
    const nb = knocks ? (knocks.length + 7) >> 3 : 0;
    w.u16(nb);
    for (let b = 0; b < nb; b++) {
      let v = 0;
      for (let q = 0; q < 8 && b * 8 + q < knocks!.length; q++) v |= knocks![b * 8 + q]! << q;
      w.u8(v);
    }
    for (let i = 0; i < s.count; i++) {
      const car = this.cars[i]!;
      car.flight(this.fly, 0, false);
      w.bytes.set(this.flyBytes, w.off);
      w.off += this.flyBytes.length;
      if (this.course) this.course.recall(i, this.mem);
      else this.mem.set(NO_MEMORY);
      w.bytes.set(this.memBytes, w.off);
      w.off += this.memBytes.length;
      const n = s.cars[i]!.wreck ? this.sim.length : 0;
      w.u16(n);
      if (n === 0) continue;
      car.deform.simState(this.sim, false);
      // One native byte copy (little-endian like the codec, as every browser's Float64Array): `f64s`, a number at a
      // time in code too rarely run to be optimized, boxed each one (125 KB a keyframe at 11 wrecks).
      w.bytes.set(this.simBytes, w.off);
      w.off += this.simBytes.length;
    }
    return w;
  }

  /** `mask` and, over and over, every car that touched one of them since `t0`. */
  private touched(mask: number, n: number, t0: number): number {
    for (let grew = true; grew; ) {
      grew = false;
      for (let a = 0; a < n; a++) {
        if (!((mask >>> a) & 1)) continue;
        for (let b = 0; b < n; b++) {
          const k = a < b ? a * MAX_CARS + b : b * MAX_CARS + a;
          if ((mask >>> b) & 1 || Math.max(this.pairAt[k]!, this.touchAt[k]!) < t0) continue;
          mask = (mask | (1 << b)) >>> 0;
          grew = true;
        }
      }
    }
    return mask;
  }

  /**
   * `mask` (cluster `c`'s cars and their touchers) with the bystanders added: the cars within `BYSTANDER_R` of the hit
   * (`c`'s first impact, mean point or cars) at any keyframe from the clip's `start` step to its end, nearest first,
   * each with the cars that touched it, while the clip's estimated size stays within `CLIP_SHARE`. A bystander too big
   * for what is left is skipped; a smaller one further out may still fit. A car's estimate is its inputs plus its solver
   * state in each keyframe it is a wreck in. Never taken: a car that did not exist for the whole clip (it has no state
   * in the clip's first keyframe) and one placed (`DeformableCar.placements` moved) after the first impact: the replay corrects drift only up
   * to there and cannot place a car.
   */
  private bystanders(c: CrashCluster, mask: number, start: number, n: number, firstStep: number, t0: number): number {
    const d = this.near.fill(Infinity);
    const wreckKeys = new Uint8Array(MAX_CARS);
    let all = n;
    const filled = Math.min(this.keyCount, KEY_SLOTS);
    // Every keyframe from the clip's start, then the current step's start: the clip's last moment.
    for (let k = 0; k <= filled; k++) {
      const last = k === filled;
      if (!last && this.keyStep[k]! < start) continue;
      const pos = last ? this.lastPos : this.keyPos;
      const o = last ? 0 : k * MAX_CARS * 2;
      const cnt = last ? n : this.keyN[k]!;
      all = Math.min(all, cnt);
      for (let i = 0; i < cnt; i++) {
        if (!last && this.keyStep[k]! <= start + firstStep) wreckKeys[i] = wreckKeys[i]! + ((this.keyWreck[k]! >>> i) & 1);
        const x = pos[o + 2 * i]!;
        const z = pos[o + 2 * i + 1]!;
        let m = Math.min((x - c.x0) ** 2 + (z - c.z0) ** 2, (x - c.x) ** 2 + (z - c.z) ** 2);
        for (let a = 0; a < cnt; a++) if ((c.cars >>> a) & 1) m = Math.min(m, (x - pos[o + 2 * a]!) ** 2 + (z - pos[o + 2 * a + 1]!) ** 2);
        d[i] = Math.min(d[i]!, m);
      }
    }
    const bytes = (cars: number): number => {
      let sum = 0;
      for (let j = 0; j < n; j++) if ((cars >>> j) & 1) sum += (this.step - start) * INPUT_BYTES + wreckKeys[j]! * this.sim.length * 8;
      return sum;
    };
    const order: number[] = [];
    for (let i = 0; i < all; i++) if (d[i]! <= BYSTANDER_R * BYSTANDER_R && this.jumpAt[i]! <= c.first) order.push(i);
    order.sort((a, b) => d[a]! - d[b]!);
    let left = CLIP_SHARE - bytes(mask);
    for (const i of order) {
      if ((mask >>> i) & 1) continue;
      const next = this.touched((mask | (1 << i)) >>> 0, n, t0);
      const add = bytes(next ^ mask);
      if (add > left) continue;
      left -= add;
      mask = next;
    }
    return mask;
  }

  /**
   * `src`, a clip's keyframes by step, cut down to the clip's cars `slots` (their snapshot, the course's knocked props,
   * then each car's flight block, course memory and solver state), a wreck's solver state XORed word by word on its
   * previous kept keyframe's (`ClipSim` undoes it):
   * what a wreck keeps between keyframes (its beams' and clusters' rest, offsets, flags) turns to zeros, which deflate
   * drops (measured: the solver state of a 16-car clip deflated 195 KB raw, 72 KB XORed). A clip estimated over
   * `CLIP_BUDGET` deflated (`others`: its inputs, pedal digits and schedule) first loses intermediate keyframes, oldest first, down
   * to the first, the last before the impact and the impact's own: a pile-up of 15 wrecks was 262 KB and fitted no reel.
   */
  private cutKeys(src: { step: number; bytes: Uint8Array }[], slots: number[], others: number): { src: { step: number; bytes: Uint8Array }[]; keys: Uint8Array[] } {
    const L = this.layout!;
    const nc = slots.length;
    const all = makeSnapshot();
    const r = new Reader();
    // Where the knocked props and each car's flight block, course memory and solver state start in every keyframe (`encodeKey`), found by walking them.
    const sections = src.map((k) => {
      r.reset(k.bytes);
      readSnapshot(r, all, L);
      const at = r.off;
      const flags = r.u16();
      r.off += flags;
      const sec = [r.off];
      for (let i = 0; i < all.count; i++) {
        r.off += FLIGHT * 8 + MEMORY * 8;
        const n = r.u16();
        r.off += n * 8;
        sec.push(r.off);
      }
      return { knocks: k.bytes.subarray(at, sec[0]), sec };
    });
    type Section = (typeof sections)[number];
    const size = (s: Section): number => snapshotMaxBytes(nc, L) + s.knocks.length + slots.reduce((n, i) => n + s.sec[i + 1]! - s.sec[i]!, 0);
    let est = others + DEFLATED_KEYS * sections.reduce((n, s) => n + size(s), 0);
    const dropped = src.map(() => false);
    for (let k = 1; est > CLIP_BUDGET && k < src.length - 2; k++) {
      dropped[k] = true;
      est -= DEFLATED_KEYS * size(sections[k]!);
    }
    // Per clip car: its solver state in the clip's previous kept keyframe (raw words), the base its next one is XORed on.
    const prev: (Uint32Array | null)[] = slots.map(() => null);
    const out: { src: { step: number; bytes: Uint8Array }[]; keys: Uint8Array[] } = { src: [], keys: [] };
    src.forEach((k, ki) => {
      if (dropped[ki]) return;
      const { knocks, sec } = sections[ki]!;
      r.reset(k.bytes);
      readSnapshot(r, all, L);
      const w = new Writer(size(sections[ki]!));
      writeSnapshot(w, { ...all, count: nc, cars: slots.map((i) => all.cars[i]!) }, L);
      w.bytes.set(knocks, w.off);
      w.off += knocks.length;
      for (let j = 0; j < nc; j++) {
        const body = k.bytes.subarray(sec[slots[j]!]!, sec[slots[j]! + 1]!);
        const head = FLIGHT * 8 + MEMORY * 8 + 2;
        w.bytes.set(body.subarray(0, head), w.off);
        w.off += head;
        const raw = new Uint32Array(body.slice(head).buffer);
        const xored = raw.slice();
        const p = prev[j];
        if (p && p.length === raw.length) for (let q = 0; q < raw.length; q++) xored[q] = xored[q]! ^ p[q]!;
        prev[j] = raw.length > 0 ? raw : null;
        w.bytes.set(new Uint8Array(xored.buffer), w.off);
        w.off += xored.byteLength;
      }
      out.src.push(k);
      out.keys.push(w.done().slice());
    });
    return out;
  }

  /** A cluster is over: if it ranks, copy its slice out of the rings into a clip and file it. */
  private file(c: CrashCluster): void {
    const impact = this.impactKeys.get(c);
    this.impactKeys.delete(c);
    const score = c.score;
    const L = this.layout;
    if (!L || !this.ledger.ranks(score)) return;
    // The clip starts at the last keyframe at or before the pre-roll whose step is still in the ring; failing that, the earliest left.
    const want = c.first - PRE_ROLL;
    const oldest = this.step - RING + 1;
    const filled = Math.min(this.keyCount, KEY_SLOTS);
    let slot = -1;
    let early = -1;
    for (let k = 0; k < filled; k++) {
      const st = this.keyStep[k]!;
      if (st < oldest) continue;
      if (this.at[st % RING]! <= want && (slot < 0 || st > this.keyStep[slot]!)) slot = k;
      if (early < 0 || st < this.keyStep[early]!) early = k;
    }
    if (slot < 0) slot = early;
    if (slot < 0) return;
    const start = this.keyStep[slot]!;
    const steps = this.step - start;
    if (steps <= 0) return;
    // The cluster's cars and what touched them since the clip's start, then the bystanders with what touched them
    // (`bystanders`): a car left out would leave its shoves out of the replay, which then drifts (measured: 1–3 m a
    // second in a pile-up).
    const t0 = this.at[start % RING]!;
    const n = this.pre.count;
    const firstStep = impact && impact.step > start && impact.step < this.step ? impact.step - start : 0;
    const core = this.touched(c.cars, n, t0);
    const mask = this.bystanders(c, core, start, n, firstStep, t0);
    const slots: number[] = [];
    for (let i = 0; i < n; i++) if ((mask >>> i) & 1) slots.push(i);
    const nc = slots.length;
    const h = new Float32Array(steps);
    const shape = new Uint32Array(steps);
    const inputs = new Uint8Array(steps * nc * INPUT_BYTES);
    // The cars the impact involves keep their pedals exactly (doubles) from the last keyframe before it to FINE_S s after it.
    let fineFrom = 0;
    for (let k = 0; k < filled && firstStep > 0; k++) {
      const st = this.keyStep[k]! - start;
      if (st >= 0 && st < firstStep) fineFrom = Math.max(fineFrom, st);
    }
    // ... the cars crash and slide to rest on their pedals' real values for that long.
    let fineTo = steps;
    for (let s = 0, t = 0; s < steps; s++) {
      t += this.h[(start + s) % RING]!;
      if (t >= c.first - t0 + FINE_S) {
        fineTo = s + 1;
        break;
      }
    }
    const fine = new Float64Array(Math.max(0, fineTo - fineFrom) * nc * FINE_PEDALS).fill(NaN);
    for (let s = 0; s < steps; s++) {
      const r = (start + s) % RING;
      // The ring's float32, whole: the codec stores it as is (`writeClip`), so this clip, its decoded copy and the live step agree to 6e-8.
      h[s] = this.h[r]!;
      shape[s] = this.shapes[r]!;
      for (let j = 0; j < nc; j++) {
        const src = (r * MAX_CARS + slots[j]!) * INPUT_BYTES;
        inputs.set(this.inputs.subarray(src, src + INPUT_BYTES), (s * nc + j) * INPUT_BYTES);
        if (s >= fineFrom && s < fineTo && (core >>> slots[j]!) & 1) {
          const f = (r * MAX_CARS + slots[j]!) * FINE_PEDALS;
          fine.set(this.fine.subarray(f, f + FINE_PEDALS), ((s - fineFrom) * nc + j) * FINE_PEDALS);
        }
      }
    }
    // Keyframes from the clip's start to its first impact (the replay corrects drift up to there, never after), in
    // step order with the impact keyframe where it falls, each cut down to the clip's cars.
    const src: { step: number; bytes: Uint8Array }[] = [];
    for (let k = 0; k < filled; k++) {
      const st = this.keyStep[k]!;
      if (st >= start && st <= start + firstStep) src.push({ step: st, bytes: this.keys[k]!.done() });
    }
    const ib = impact?.bytes;
    if (firstStep > 0 && ib && !src.some((a) => a.step === start + firstStep)) src.push({ step: start + firstStep, bytes: ib });
    src.sort((a, b) => a.step - b.step);
    const { src: kept, keys } = this.cutKeys(src, slots, DEFLATED_INPUTS * inputs.length + DEFLATED_FINE * fine.byteLength + DEFLATED_SHAPE * shape.byteLength);
    const cars: ReelCar[] = slots.map((i) => ({ slot: i, style: this.cars[i]!.style.id, cls: carClass(this.cars[i]!), name: this.names(i) }));
    // The drivers thrown out during the clip's steps: their dummies fly again at those steps (car = the clip's own index).
    const ejections: ClipEjection[] = [];
    for (const x of this.ejected) {
      const j = slots.indexOf(x.e.car);
      if (j >= 0 && x.step >= start && x.step < this.step) ejections.push({ step: x.step - start, e: { ...x.e, car: j } });
    }
    this.ledger.keep({
      trackId: this.trackId,
      score,
      impacts: c.impacts,
      kills: c.kills,
      ejects: c.ejects,
      ejections,
      peakKph: c.peak * 3.6,
      t0,
      firstImpact: c.first - t0,
      firstStep,
      lastImpact: c.last - t0,
      x: c.x0,
      z: c.z0,
      focus: Math.max(0, slots.indexOf(c.focus)),
      firstA: Math.max(0, slots.indexOf(c.a0)),
      firstB: c.b0 < 0 ? -1 : slots.indexOf(c.b0),
      realism: this.realism,
      bleed: this.bleed,
      squash: this.cars[c.a0]!.deform.squash,
      buckle: this.cars[c.a0]!.deform.buckle,
      deformMode: this.cars[c.a0]!.deform.mode,
      look: this.look,
      cars,
      h,
      shape,
      inputs,
      fineFrom,
      fine,
      keyStep: Uint32Array.from(kept, (k) => k.step - start),
      keys,
    });
  }
}
