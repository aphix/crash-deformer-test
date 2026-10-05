import * as THREE from "three";
import { beginFakeFall, FLIGHT, FLIGHT_POSE, type DeformableCar } from "../vehicle/car.ts";
import { EXIT_PANES, type WorldBounce } from "../vehicle/car-core.ts";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { HANDLING } from "../vehicle/vehicle-classes.ts";
import { countsAsImpact, FINE_PEDALS, INPUT_BYTES, PAIR_MIN, WALL_MIN, type HighlightClip } from "../match/highlights.ts";
import { DRAFT } from "../match/session.ts";
import { makeSnapshot, readSnapshot, Reader, type Snapshot } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { foldHeading } from "../present/shot-cam.ts";
import { newWorld, settleStep, stepWorld, type World } from "./world-step.ts";
import type { Ejection } from "../vehicle/ejection.ts";

/**
 * What a replay needs from its scene: dress a respawned car, the course's walls and props for car `slot`, and (a scene
 * with a course) `placed`: car `slot` was put on a keyframe's spot, so what the course remembers of where it last stood
 * (`RaceDirector.relocated`: the projection hint a live respawn clears too) is stale.
 */
export type ReplayScene = {
  dress(car: DeformableCar): void;
  collide(car: DeformableCar, slot: number, h: number): void;
  placed?(slot: number): void;
  bounce: WorldBounce | undefined;
};

const _q = new THREE.Quaternion();
const _from = new THREE.Quaternion();
const _o = new THREE.Quaternion();
const _p = new THREE.Quaternion();
const IDENTITY = new THREE.Quaternion();
const NO_EJECTIONS: readonly Ejection[] = [];
/** A car that moved further than this (m) in one step was placed (a keyframe's respawn), not driven: `present` draws it where it landed. */
const TELEPORT = 5;
/**
 * A keyframe moves a car by the replay's drift (measured: a car's median 3–25 cm, a few cases 1–2 m, at every 0.5 s
 * keyframe before the hit): `present` draws that move as an offset that decays by this time constant (clip s) instead
 * of a pop. The sim itself takes the keyframe's pose whole.
 */
const POP_TAU = 0.2;

/**
 * One highlight clip re-run through the real sim (docs/HIGHLIGHTS.md): its cars respawned from keyframe 0 (a wreck
 * with its netplay wreck section: dents, lost parts, lamps, glass, then its solver state; style and class are the
 * caller's, `cars[j]` is `clip.cars[j]`), then each recorded step's dt and drive outputs fed through `applyDrive` +
 * `stepWorld` + `settleStep`. Up to and including the first impact's step, every keyframe snaps its cars back onto
 * the record (drift correction); after it the crash plays out on its own. The sim only has the whole steps' states
 * (1/240–1/114 s of clip time each; the reel plays the hit at about 1/30 of that), so a frame mostly lands inside a
 * step: `present` draws the cars between the last step's before and after.
 */
export class ClipSim {
  readonly clip: HighlightClip;
  readonly cars: readonly DeformableCar[];
  /** Next step to run. */
  step = 0;
  /** Clip seconds simulated so far. */
  time = 0;
  /** The replay's own first impact at or after `watchFrom` (clip s; −1 none yet). */
  firstHit = -1;
  watchFrom = 0;
  /** Every car's position at the first impact's step, before its keyframe corrects it: the replay's drift there. */
  readonly preSnap: Float32Array;
  /** Step of the recorded first impact's keyframe: the last one that corrects. */
  readonly impactStep: number;
  /** False skips that keyframe (how the earlier keyframes alone carry the replay to the impact). */
  useImpactKey = true;
  /** Clip second the last run step began at (`present`'s interpolation starts there, at `from`). */
  private stepAt = 0;
  /** Per car, before the last step: position (3) and rotation as a quaternion (4). */
  private readonly from: Float64Array;
  /** Per car, the sim's true pose `present` replaced: position (3), rotation as a quaternion (4) and Euler (3). */
  private readonly kept: Float64Array;
  private presented = false;
  /**
   * Per car, a keyframe's last moves: the offset `present` adds to the true position (x, y, z) and the rotation it
   * puts over the true one (a quaternion), both decaying by `POP_TAU`.
   */
  private readonly pop: Float64Array;
  private readonly popQ: Float64Array;
  private popping = false;
  /**
   * The focus car's travel direction (flat, unit: its velocity, its body's heading when nearly still), low-passed per
   * step by `foldHeading`: a wreck's own velocity swings 4° and more between frames, which a camera behind it must not copy.
   */
  readonly heading = new THREE.Vector2();
  /** Clip seconds the recording runs. */
  readonly length: number;
  private key = 0;
  private readonly keys: Snapshot[];
  /** Per keyframe: every car's flight block (`DeformableCar.flight`), and each wreck's solver state (`simState`). */
  private readonly flight: Float64Array[] = [];
  private readonly sim: (Float64Array | null)[][] = [];
  /** The replay's own world: `strongest` holds the last step's hardest contact. */
  readonly world: World;
  private readonly dress: (car: DeformableCar) => void;
  private readonly placed: ((slot: number) => void) | undefined;
  private readonly input: DriveInput = idleDrive();
  /** The first impact's car still had a running engine after the last step (a kill-opened cluster's impact is its death). */
  private aliveA = true;
  /** Next of `clip.ejections` to fire, and the throws fired since `take`. */
  private ejectAt = 0;
  private fired: Ejection[] = [];
  /**
   * Clip time each car pair (a·n + b, a < b) and each car against the walls last touched: a contact marks the first hit
   * only after a quiet spell and hard enough, the recorder's own rule (`countsAsImpact`).
   */
  private readonly pairAt: Float64Array;
  private readonly wallAt: Float64Array;

  constructor(clip: HighlightClip, cars: readonly DeformableCar[], scene: ReplayScene) {
    this.clip = clip;
    this.cars = cars;
    this.pairAt = new Float64Array(cars.length * cars.length);
    this.wallAt = new Float64Array(cars.length);
    this.impactStep = clip.firstStep;
    this.length = clip.h.reduce((a, h) => a + h, 0);
    this.preSnap = new Float32Array(cars.length * 3);
    this.from = new Float64Array(cars.length * 7);
    this.kept = new Float64Array(cars.length * 10);
    this.pop = new Float64Array(cars.length * 3);
    this.popQ = new Float64Array(cars.length * 4);
    this.clearPop();
    const L = carLayout(cars[0]!);
    const r = new Reader();
    // Per car: its solver state's words in the previous keyframe; a keyframe's are XORed on them (`CrashRecorder.file`).
    const prev: (Uint32Array | null)[] = cars.map(() => null);
    this.keys = clip.keys.map((bytes) => {
      const snap = makeSnapshot();
      readSnapshot(r.reset(bytes), snap, L);
      const fl = new Float64Array(cars.length * FLIGHT);
      const sims: (Float64Array | null)[] = [];
      for (let j = 0; j < cars.length; j++) {
        for (let i = 0; i < FLIGHT; i++) fl[j * FLIGHT + i] = r.f64();
        // The snapshot's pose is the netplay wire's (1e-4 rad, 1 cm/s, float32 metres); the block's is the car's own.
        const f = snap.cars[j]!;
        const o = j * FLIGHT + FLIGHT_POSE;
        f.pitch = fl[o]!;
        f.yaw = fl[o + 1]!;
        f.roll = fl[o + 2]!;
        f.vx = fl[o + 3]!;
        f.vy = fl[o + 4]!;
        f.vz = fl[o + 5]!;
        f.x = fl[o + 6]!;
        f.y = fl[o + 7]!;
        f.z = fl[o + 8]!;
        const n = r.u16();
        if (n > 0 && n !== cars[j]!.deform.simSize()) throw new RangeError("a keyframe's solver state is another build's");
        const words = new Uint32Array(2 * n);
        const p = prev[j];
        for (let i = 0; i < words.length; i++) words[i] = r.u32() ^ (p && p.length === words.length ? p[i]! : 0);
        prev[j] = n > 0 ? words : null;
        sims.push(n > 0 ? new Float64Array(words.buffer) : null);
      }
      this.flight.push(fl);
      this.sim.push(sims);
      return snap;
    });
    const w = newWorld(cars);
    const slots = clip.cars.map((c) => c.slot);
    w.collide = (car, k, h) => scene.collide(car, slots[k]!, h);
    w.bounce = scene.bounce;
    w.pairHit = (a, b, hit, first) => this.noteHit(a, b, hit.impulse, first);
    this.world = w;
    this.dress = scene.dress;
    this.placed = scene.placed;
  }

  get done(): boolean {
    return this.step >= this.clip.h.length;
  }

  /**
   * The dummies thrown since the last call: the clip's `ejections` as their steps ran, `car` the engine slot of the clip's
   * car (a shared empty array when none). The recording's own numbers, so every replay launches the same throws.
   */
  take(): readonly Ejection[] {
    if (this.fired.length === 0) return NO_EJECTIONS;
    const out = this.fired;
    this.fired = [];
    return out;
  }

  /** Step `s` has run: the drivers the record threw out in it are out of their cars now. */
  private fire(s: number): void {
    const list = this.clip.ejections;
    for (; this.ejectAt < list.length && list[this.ejectAt]!.step <= s; this.ejectAt++) {
      const e = list[this.ejectAt]!.e;
      this.cars[e.car]!.driverOut = e.exit;
      this.fired.push({ ...e, car: this.clip.cars[e.car]!.slot });
    }
  }

  /** Respawn every car in its keyframe-0 state, at the clip's start. */
  restart(): void {
    this.step = 0;
    this.time = 0;
    this.ejectAt = 0;
    this.fired = [];
    this.stepAt = 0;
    this.presented = false;
    this.clearPop();
    this.heading.set(0, 0);
    this.firstHit = -1;
    this.pairAt.fill(-Infinity);
    this.wallAt.fill(-Infinity);
    for (let j = 0; j < this.cars.length; j++) this.spawn(j, 0);
    foldHeading(this.heading, this.cars[this.clip.focus]!, 0);
    this.aliveA = this.cars[this.clip.firstA]!.deform.drivetrainAlive;
    this.key = 1;
  }

  /**
   * Run recorded steps until `time` reaches `until` (clip s) or the clip ends: the step `until` falls in runs, and
   * `present` draws `until` between the pose before it and the one it left. With `deadline` (a `performance.now()`
   * ms), also stop once it passes after at least one step, to resume next call.
   */
  advanceTo(until: number, deadline = Infinity): void {
    this.restore();
    const { clip, cars } = this;
    const nc = cars.length;
    const saved = HANDLING.realism;
    HANDLING.realism = clip.realism;
    const s0 = this.step;
    while (this.step < clip.h.length && this.time < until - 1e-9 && (this.step === s0 || performance.now() < deadline)) {
      const s = this.step;
      this.stepAt = this.time;
      for (let j = 0; j < nc; j++) {
        const g = cars[j]!.group;
        const o = j * 7;
        this.from[o] = g.position.x;
        this.from[o + 1] = g.position.y;
        this.from[o + 2] = g.position.z;
        this.from[o + 3] = g.quaternion.x;
        this.from[o + 4] = g.quaternion.y;
        this.from[o + 5] = g.quaternion.z;
        this.from[o + 6] = g.quaternion.w;
      }
      if (s === this.impactStep) {
        for (let j = 0; j < nc; j++) {
          const p = cars[j]!.group.position;
          this.preSnap[j * 3] = p.x;
          this.preSnap[j * 3 + 1] = p.y;
          this.preSnap[j * 3 + 2] = p.z;
        }
      }
      while (this.key < clip.keyStep.length && clip.keyStep[this.key]! <= s) {
        const at = clip.keyStep[this.key]!;
        if (at === s && s <= this.impactStep && (this.useImpactKey || at !== this.impactStep)) {
          for (let j = 0; j < nc; j++) this.snap(j, this.key);
          // The cars are on the record again: contacts they made on their own before it are not its history (a pair the
          // replay wedged for a second the record never touched would never count as the recorded first impact), and
          // neither is a first hit the drift made before this correction (seed 6 of engine-replay.test.ts: a pair of
          // cars the record never put together touched 0.25 s before it, between keyframes 0 and 720, and the replay's
          // first hit was marked there). The hit that counts is the one after the last correction before the impact.
          this.pairAt.fill(-Infinity);
          this.wallAt.fill(-Infinity);
          if (at !== this.impactStep) this.firstHit = -1;
          this.popFrom(at !== this.impactStep);
        }
        this.key++;
      }
      const h = clip.h[s]!;
      const inp = clip.inputs;
      const d = this.input;
      const fineTo = clip.fineFrom + clip.fine.length / (nc * FINE_PEDALS);
      for (let j = 0; j < nc; j++) {
        const o = (s * nc + j) * INPUT_BYTES;
        const f = s >= clip.fineFrom && s < fineTo ? ((s - clip.fineFrom) * nc + j) * FINE_PEDALS : -1;
        // The recorded pedals whole where the clip has them (a NaN: none), the 8-bit ones elsewhere.
        const fine = f >= 0 ? clip.fine[f]! : NaN;
        const exact = !Number.isNaN(fine);
        d.throttle = exact ? fine : ((inp[o]! << 24) >> 24) / 127;
        d.steer = exact ? clip.fine[f + 1]! : ((inp[o + 1]! << 24) >> 24) / 127;
        d.brake = exact ? clip.fine[f + 2]! : inp[o + 2]! / 255;
        d.ebrake = (inp[o + 3]! & 1) !== 0;
        d.boost = (inp[o + 3]! & 2) !== 0;
        d.neutral = (inp[o + 3]! & 8) !== 0;
        applyDrive(cars[j]!, d, h, inp[o + 3]! & 4 ? DRAFT.top : 1);
      }
      stepWorld(this.world, h);
      settleStep(cars, h, clip.bleed);
      this.fire(s);
      // A cluster opened by a kill: the struck car's drivetrain dying is the impact.
      const a = cars[clip.firstA]!;
      if (clip.firstB < 0 && this.aliveA && !a.deform.drivetrainAlive) this.markHit();
      this.aliveA = a.deform.drivetrainAlive;
      this.time += h;
      this.step++;
      if (this.popping) this.decay(h);
      foldHeading(this.heading, this.cars[this.clip.focus]!, h);
    }
    HANDLING.realism = saved;
  }

  /**
   * Every car drawn at clip time `until`, inside the last run step (as `advanceTo` leaves it): its pose between the one
   * before that step and the one it left, so a frame inside a step moves the cars on instead of repeating the last
   * step's pose, plus what is left of a keyframe's move (`POP_TAU`). A car the step placed (> `TELEPORT`) stays where
   * it landed. The next `advanceTo` puts the true state back first: the replay itself never runs from a drawn pose.
   */
  present(until: number): void {
    this.restore();
    const span = this.time - this.stepAt;
    const u = span > 1e-9 ? Math.min(1, Math.max(0, (until - this.stepAt) / span)) : 1;
    if (u >= 1 && !this.popping) return;
    this.presented = true;
    // The offset at `until`: it decays over the step from `pop * e(0)` to `pop`.
    const e = Math.exp(((1 - u) * span) / POP_TAU);
    const f = this.from;
    const k = this.kept;
    for (let j = 0; j < this.cars.length; j++) {
      const g = this.cars[j]!.group;
      const o = j * 7;
      const m = j * 10;
      const p = g.position;
      const q = g.quaternion;
      const r = g.rotation;
      k[m] = p.x;
      k[m + 1] = p.y;
      k[m + 2] = p.z;
      k[m + 3] = q.x;
      k[m + 4] = q.y;
      k[m + 5] = q.z;
      k[m + 6] = q.w;
      k[m + 7] = r.x;
      k[m + 8] = r.y;
      k[m + 9] = r.z;
      if (Math.abs(f[o]! - p.x) + Math.abs(f[o + 1]! - p.y) + Math.abs(f[o + 2]! - p.z) > TELEPORT) continue;
      if (u < 1) {
        p.set(f[o]! + (p.x - f[o]!) * u, f[o + 1]! + (p.y - f[o + 1]!) * u, f[o + 2]! + (p.z - f[o + 2]!) * u);
        _from.set(f[o + 3]!, f[o + 4]!, f[o + 5]!, f[o + 6]!);
        q.copy(_from.slerp(_q.set(k[m + 3]!, k[m + 4]!, k[m + 5]!, k[m + 6]!), u));
      }
      if (!this.popping) continue;
      p.set(p.x + this.pop[j * 3]! * e, p.y + this.pop[j * 3 + 1]! * e, p.z + this.pop[j * 3 + 2]! * e);
      const n = j * 4;
      // `e` >= 1 (the offset at the step's start): the slerp runs past its end.
      _o.copy(IDENTITY).slerp(_p.set(this.popQ[n]!, this.popQ[n + 1]!, this.popQ[n + 2]!, this.popQ[n + 3]!), e);
      q.copy(_o.multiply(q));
    }
  }

  /**
   * Undo `present`: every car back on the sim's own pose, exactly. A grounded car's Euler angles are what the sim
   * reads; an airborne or falling one's quaternion is (the Euler is derived from it), and quaternion -> Euler -> quaternion
   * is not exact: write the quaternion, then the Euler only if the car's own differs.
   */
  private restore(): void {
    if (!this.presented) return;
    this.presented = false;
    const k = this.kept;
    for (let j = 0; j < this.cars.length; j++) {
      const g = this.cars[j]!.group;
      const m = j * 10;
      g.position.set(k[m]!, k[m + 1]!, k[m + 2]!);
      g.quaternion.set(k[m + 3]!, k[m + 4]!, k[m + 5]!, k[m + 6]!);
      const r = g.rotation;
      if (r.x !== k[m + 7] || r.y !== k[m + 8] || r.z !== k[m + 9]) r.set(k[m + 7]!, k[m + 8]!, k[m + 9]!);
    }
  }

  /**
   * A keyframe just moved every car: `from` restarts at the corrected position, and (`smooth`; not the impact's
   * keyframe, whose drift the hit shows) the move so far becomes a drawn offset. A placement (> `TELEPORT`) is neither.
   */
  private popFrom(smooth: boolean): void {
    for (let j = 0; j < this.cars.length; j++) {
      const g = this.cars[j]!.group;
      const p = g.position;
      const o = j * 7;
      const dx = this.from[o]! - p.x;
      const dy = this.from[o + 1]! - p.y;
      const dz = this.from[o + 2]! - p.z;
      const far = Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > TELEPORT;
      if (smooth && !far) {
        this.pop[j * 3]! += dx;
        this.pop[j * 3 + 1]! += dy;
        this.pop[j * 3 + 2]! += dz;
        // The rotation offset keeps what is drawn: new = old * before * after⁻¹.
        const n = j * 4;
        _o.set(this.popQ[n]!, this.popQ[n + 1]!, this.popQ[n + 2]!, this.popQ[n + 3]!);
        _p.set(this.from[o + 3]!, this.from[o + 4]!, this.from[o + 5]!, this.from[o + 6]!);
        _o.multiply(_p).multiply(_p.copy(g.quaternion).invert()).normalize();
        this.popQ[n] = _o.x;
        this.popQ[n + 1] = _o.y;
        this.popQ[n + 2] = _o.z;
        this.popQ[n + 3] = _o.w;
        this.popping = true;
      }
      if (smooth || far) {
        this.from[o] = p.x;
        this.from[o + 1] = p.y;
        this.from[o + 2] = p.z;
        this.from[o + 3] = g.quaternion.x;
        this.from[o + 4] = g.quaternion.y;
        this.from[o + 5] = g.quaternion.z;
        this.from[o + 6] = g.quaternion.w;
      }
    }
  }

  /** One step of `h` s later: the drawn offsets shrink; gone when the biggest is under a millimetre (or a milliradian). */
  private decay(h: number): void {
    const k = Math.exp(-h / POP_TAU);
    let big = 0;
    for (let i = 0; i < this.pop.length; i++) {
      this.pop[i]! *= k;
      big = Math.max(big, Math.abs(this.pop[i]!));
    }
    for (let n = 0; n < this.popQ.length; n += 4) {
      _o.set(this.popQ[n]!, this.popQ[n + 1]!, this.popQ[n + 2]!, this.popQ[n + 3]!).slerp(IDENTITY, 1 - k);
      this.popQ[n] = _o.x;
      this.popQ[n + 1] = _o.y;
      this.popQ[n + 2] = _o.z;
      this.popQ[n + 3] = _o.w;
      big = Math.max(big, 2 * (Math.abs(_o.x) + Math.abs(_o.y) + Math.abs(_o.z)));
    }
    if (big < 1e-3) this.clearPop();
  }

  /** No keyframe offsets: every position offset 0, every rotation offset the identity. */
  private clearPop(): void {
    this.pop.fill(0);
    this.popQ.fill(0);
    for (let n = 3; n < this.popQ.length; n += 4) this.popQ[n] = 1;
    this.popping = false;
  }

  /** The course's wall or a prop touched the clip's car in race slot `slot`, closing at `closing` m/s (`RaceField.onWallHit`). */
  noteWall(slot: number, closing: number): void {
    const c = this.clip;
    const j = c.cars.findIndex((x) => x.slot === slot);
    if (j < 0) return;
    const counts = countsAsImpact(this.time - this.wallAt[j]!, closing, WALL_MIN);
    this.wallAt[j] = this.time;
    if (counts && c.firstB < 0 && j === c.firstA) this.markHit();
  }

  /** The recorded first impact's pair touched at `closing` m/s (first SAT pass: the contact they came in with). */
  private noteHit(a: number, b: number, closing: number, first: boolean): void {
    if (!first) return;
    const { firstA, firstB } = this.clip;
    const k = a * this.cars.length + b;
    const counts = countsAsImpact(this.time - this.pairAt[k]!, closing, PAIR_MIN);
    this.pairAt[k] = this.time;
    if (counts && ((a === firstA && b === firstB) || (a === firstB && b === firstA))) this.markHit();
  }

  private markHit(): void {
    if (this.firstHit < 0 && this.time >= this.watchFrom) this.firstHit = this.time;
  }

  /** Car `j` respawned as keyframe `k` has it: pose and motion, then a wreck's dents, parts, lamps, glass and solver state. */
  private spawn(j: number, k: number): void {
    const car = this.cars[j]!;
    const f = this.keys[k]!.cars[j]!;
    car.spawnFacing(f.x, f.z, f.yaw, 0);
    this.dress(car);
    // The recording's crumple settings, not this browser's HUD (a wreck's own come back with its net state).
    car.deform.squash = this.clip.squash;
    car.deform.buckle = this.clip.buckle;
    car.deform.setMode(this.clip.deformMode);
    car.group.visible = true;
    this.pose(j, k);
    car.crashed = f.crashed;
    const sim = this.sim[k]![j];
    if (f.wreck) car.writeNetState(f.deform, f.parts);
    if (f.wreck && sim) car.deform.simState(sim, true);
    if (f.falling) beginFakeFall(car, car.angular);
  }

  /** Keyframe `k` corrects car `j`'s drift: an intact car that is intact in the record takes the pose, any other is respawned as recorded. */
  private snap(j: number, k: number): void {
    const car = this.cars[j]!;
    const f = this.keys[k]!.cars[j]!;
    if (!f.crashed && !f.falling && !car.crashed && !car.falling && !car.deform.massActive) this.pose(j, k);
    else this.spawn(j, k);
  }

  /** Pose, motion, drift and flight state from keyframe `k`'s frame of car `j` (the flight block's doubles, not the wire's). */
  private pose(j: number, k: number): void {
    const car = this.cars[j]!;
    const f = this.keys[k]!.cars[j]!;
    car.driverOut = EXIT_PANES[f.driverOut] ?? null;
    car.flight(this.flight[k]!, j * FLIGHT, true);
    this.placed?.(this.clip.cars[j]!.slot);
    car.speed = Math.hypot(car.velocity.x, car.velocity.z);
    car.refreshBasis();
    car.deform.bindKinematic(car.group, car.velocity, car.angular);
  }
}
