import type { DeformableCar } from "../vehicle/car.ts";
import { CLASSES, carClass } from "../vehicle/vehicle-classes.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import {
  HighlightLedger,
  impactEnergy,
  INPUT_BYTES,
  PAIR_MIN,
  PRE_ROLL,
  REHIT_S,
  WALL_MIN,
  type CrashCluster,
  type HighlightClip,
  type ReelCar,
} from "../match/highlights.ts";
import { ensureFrames, makeSnapshot, Q, Q_PER, readSnapshot, Reader, snapshotMaxBytes, writeSnapshot, Writer, type NetLayout, type Snapshot } from "../net/codec.ts";
import { carLayout, readCarPose } from "../net/car-pose.ts";

/**
 * Ring depth in steps. A race steps at 240–300 Hz (`physicsSlice` caps a step at 7 cm of travel, and a frame's
 * remainder is one more step), so this is ≥ 17 s: a clip is at most PRE_ROLL + MAX_SPAN + POST_ROLL = 12 s plus
 * up to one keyframe interval back to its keyframe.
 */
const RING = 5120;
/**
 * Keyframe interval (s). At 1 s a restored wreck drifted far enough that a recorded first impact came 0.35 s early
 * in the replay (engine-replay.test.ts, city seed 5, 4th clip); at 0.5 s, 0.16 s.
 */
const KEY_EVERY = 0.5;
/**
 * A car that moved further than this (m, |dx| + |dz|) in one step was placed, not driven (a respawn, a parked or
 * stored police unit, a traffic recycle): a step travels at most centimetres (`physicsSlice`). The replay cannot drive
 * there, so a keyframe is taken at once (engine-replay.test.ts: one car 5.7 km off its record without it).
 */
const JUMP = 5;
/** Keyframes kept: the ring's span and then some. */
const KEY_SLOTS = 40;

/**
 * Race highlight recorder (docs/HIGHLIGHTS.md), host or offline only. Per fixed step every car's drive output
 * goes into a typed-array ring (`INPUT_BYTES`), with the step's dt, and every car's pose is read into a scratch
 * snapshot. Every `KEY_EVERY` s that snapshot, with each wreck's deform and parts (the netplay wreck section), is
 * encoded into a keyframe ring (`writeSnapshot`); a cluster's first impact encodes the poses once more. Impacts
 * feed the ledger; when a cluster's post-roll is over and it ranks, its slice is copied out of the rings into a
 * clip (the only allocation, a few times a race). Steady state allocates nothing.
 */
export class CrashRecorder {
  /** Recording (a race is running on this browser's sim). */
  on = false;
  readonly ledger = new HighlightLedger<HighlightClip>();
  private time = 0;
  private step = 0;
  private nextKey = 0;
  private keyCount = 0;
  private trackId = "";
  private realism = 0;
  private bleed = false;
  private names: (i: number) => string = (i) => `Car ${i}`;
  private cars: readonly DeformableCar[] = [];
  private layout: NetLayout | null = null;
  private readonly h = new Float32Array(RING);
  /** Recorder clock at each step's start. */
  private readonly at = new Float64Array(RING);
  private readonly inputs = new Uint8Array(RING * MAX_CARS * INPUT_BYTES);
  /** Every car at the start of the current step (wreck sections only on a keyframe step), and its drift state. */
  private readonly pre: Snapshot = makeSnapshot();
  private readonly drift = new Float32Array(MAX_CARS);
  /** Encoded keyframes (allocated at the first race), their lengths and the global step each was taken at. */
  private keys: Writer[] = [];
  private readonly keyStep = new Float64Array(KEY_SLOTS);
  private readonly alive = new Uint8Array(MAX_CARS);
  /** Per car: drafting this step (`drafting`), read into its input byte at the step's end. */
  private readonly draft = new Uint8Array(MAX_CARS);
  /** Last contact time per car pair (a·MAX_CARS + b) and per car against walls and props: a contact out of a quiet spell is an impact. */
  private readonly pairAt = new Float64Array(MAX_CARS * MAX_CARS);
  private readonly wallAt = new Float64Array(MAX_CARS);
  /**
   * Each open cluster's impact keyframe: every car as it stands at the start of the step after its first impact came
   * in (pose and wreck read together; mid-step a wreck's particles have moved on from the step-start pose).
   */
  private readonly impactKeys = new Map<CrashCluster, { step: number; bytes: Uint8Array | null }>();
  /** Clusters opened this step: their impact keyframe is encoded at the next step's start. */
  private readonly opening: CrashCluster[] = [];

  /** A race starts: clear everything. `names(i)` labels car i in the clips; `bleed`: the engine's wreck-slide rule is on. */
  begin(trackId: string, realism: number, bleed: boolean, names: (i: number) => string): void {
    this.on = true;
    this.time = 0;
    this.step = 0;
    this.nextKey = 0;
    this.keyCount = 0;
    this.trackId = trackId;
    this.realism = realism;
    this.bleed = bleed;
    this.names = names;
    this.ledger.clear();
    this.impactKeys.clear();
    this.opening.length = 0;
    this.alive.fill(1);
    this.pairAt.fill(-Infinity);
    this.wallAt.fill(-Infinity);
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
    let L = this.layout;
    if (!L) {
      const lay = carLayout(cars[0]!);
      this.keys = Array.from({ length: KEY_SLOTS }, () => new Writer(snapshotMaxBytes(MAX_CARS, lay) + MAX_CARS * 2));
      L = this.layout = lay;
    }
    const s = this.pre;
    const prev = s.count;
    ensureFrames(s, n, L);
    s.count = n;
    s.time = this.time;
    let jumped = false;
    for (let i = 0; i < n; i++) {
      const f = s.cars[i]!;
      const x = f.x;
      const z = f.z;
      readCarPose(cars[i]!, f);
      if (i < prev && Math.abs(f.x - x) + Math.abs(f.z - z) > JUMP) jumped = true;
      this.drift[i] = cars[i]!.drive.drift;
    }
    if (this.opening.length > 0) {
      const bytes = this.encodeKey(new Writer(snapshotMaxBytes(n, L) + n * 2)).done().slice();
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
  }

  /** End of a fixed step of `h` s: the drive outputs it ran on, engine kills, and any cluster now due. */
  endStep(cars: readonly DeformableCar[], h: number): void {
    if (!this.on) return;
    const n = Math.min(cars.length, MAX_CARS);
    const s = this.step % RING;
    this.h[s] = h;
    this.at[s] = this.time;
    const inp = this.inputs;
    for (let i = 0; i < n; i++) {
      const c = cars[i]!;
      const d = c.drive;
      const o = (s * MAX_CARS + i) * INPUT_BYTES;
      inp[o] = Math.round(d.throttle * 127) & 255;
      inp[o + 1] = Math.round(d.steer * 127) & 255;
      inp[o + 2] = Math.round(d.brake * 255);
      inp[o + 3] = (d.ebrake ? 1 : 0) | (d.boost ? 2 : 0) | (this.draft[i] ? 4 : 0);
      this.draft[i] = 0;
      const alive = c.deform.drivetrainAlive ? 1 : 0;
      if (this.alive[i] && !alive) this.opened(this.ledger.kill(this.time, i, c.group.position.x, c.group.position.z));
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
    const quiet = this.time - this.pairAt[k]! >= REHIT_S;
    this.pairAt[k] = this.time;
    if (!quiet || hit.impulse < PAIR_MIN) return;
    const e = impactEnergy(hit.impulse, CLASSES[carClass(this.cars[a]!)].mass, CLASSES[carClass(this.cars[b]!)].mass);
    this.opened(this.ledger.impact(this.time, a, b, hit.impulse, e, hit.contact.x, hit.contact.z));
  }

  /** A wall or prop touched car `i`, closing at `closing` m/s at (x, z). */
  wallHit(i: number, closing: number, x: number, z: number): void {
    if (!this.on || i >= this.pre.count) return;
    const quiet = this.time - this.wallAt[i]! >= REHIT_S;
    this.wallAt[i] = this.time;
    if (!quiet || closing < WALL_MIN) return;
    const e = impactEnergy(closing, CLASSES[carClass(this.cars[i]!)].mass, Infinity);
    this.opened(this.ledger.impact(this.time, i, -1, closing, e, x, z));
  }

  /** A cluster's first impact: its correction keyframe follows at the next step's start (`startStep`). */
  private opened(c: CrashCluster): void {
    if (this.impactKeys.has(c)) return;
    this.impactKeys.set(c, { step: this.step + 1, bytes: null });
    this.opening.push(c);
  }

  /** The step-start snapshot (`pre`), each wreck's deform and parts read now, and the drift states, into `w`. */
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
    w.q16s(this.drift, s.count, Q_PER.fine);
    return w;
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
    // The cluster's cars and every car that touched one of them since the clip's start (and so on): a car left out
    // would leave its shoves out of the replay, which then drifts (measured: 1–3 m a second in a pile-up).
    const t0 = this.at[start % RING]!;
    const n = this.pre.count;
    let mask = c.cars;
    for (let grew = true; grew; ) {
      grew = false;
      for (let a = 0; a < n; a++) {
        if (!((mask >>> a) & 1)) continue;
        for (let b = 0; b < n; b++) {
          if ((mask >>> b) & 1 || this.pairAt[a < b ? a * MAX_CARS + b : b * MAX_CARS + a]! < t0) continue;
          mask = (mask | (1 << b)) >>> 0;
          grew = true;
        }
      }
    }
    const slots: number[] = [];
    for (let i = 0; i < n; i++) if ((mask >>> i) & 1) slots.push(i);
    const nc = slots.length;
    const h = new Float32Array(steps);
    const inputs = new Uint8Array(steps * nc * INPUT_BYTES);
    for (let s = 0; s < steps; s++) {
      const r = (start + s) % RING;
      // Whole microseconds: the codec's step clock (`writeClip`), so this clip and its decoded copy run the same steps.
      h[s] = Math.round(this.h[r]! * 1e6) / 1e6;
      for (let j = 0; j < nc; j++) {
        const src = (r * MAX_CARS + slots[j]!) * INPUT_BYTES;
        inputs.set(this.inputs.subarray(src, src + INPUT_BYTES), (s * nc + j) * INPUT_BYTES);
      }
    }
    // Keyframes inside the clip, in step order (the impact keyframe where it falls), each cut down to the clip's cars.
    const src: { step: number; bytes: Uint8Array }[] = [];
    for (let k = 0; k < filled; k++) {
      const st = this.keyStep[k]!;
      if (st >= start && st < this.step) src.push({ step: st, bytes: this.keys[k]!.done() });
    }
    const ib = impact?.bytes;
    if (impact && ib && impact.step > start && impact.step < this.step && !src.some((a) => a.step === impact.step)) src.push({ step: impact.step, bytes: ib });
    src.sort((a, b) => a.step - b.step);
    const all = makeSnapshot();
    const r = new Reader();
    const keys = src.map((k) => {
      r.reset(k.bytes);
      readSnapshot(r, all, L);
      const at = r.off;
      const drift = slots.map((i) => {
        r.off = at + i * 2;
        return r.q16(Q.fine);
      });
      const w = new Writer(snapshotMaxBytes(nc, L) + nc * 2);
      writeSnapshot(w, { ...all, count: nc, cars: slots.map((i) => all.cars[i]!) }, L);
      for (const d of drift) w.q16(d, Q.fine);
      return w.done().slice();
    });
    const cars: ReelCar[] = slots.map((i) => {
      const car = this.cars[i]!;
      return { slot: i, style: car.style.id, cls: carClass(car), name: this.names(i) };
    });
    this.ledger.keep({
      trackId: this.trackId,
      score,
      impacts: c.impacts,
      kills: c.kills,
      peakKph: c.peak * 3.6,
      t0,
      firstImpact: c.first - t0,
      firstStep: impact && impact.step > start ? impact.step - start : 0,
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
      cars,
      h,
      inputs,
      keyStep: Uint32Array.from(src, (k) => k.step - start),
      keys,
    });
  }
}
