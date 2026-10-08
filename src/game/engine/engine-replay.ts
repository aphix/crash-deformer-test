import * as THREE from "three";
import { beginFakeFall, FLIGHT, FLIGHT_EULER, FLIGHT_POSITION, FLIGHT_VELOCITY, type DeformableCar } from "../vehicle/car.ts";
import { PART_STATE } from "../vehicle/part-state.ts";
import { EXIT_PANES, type WorldBounce } from "../vehicle/car-core.ts";
import { applyDrive, BRAKE_STEPS, idleDrive, THROTTLE_STEPS, type DriveInput } from "../vehicle/car-drive.ts";
import { HANDLING } from "../vehicle/vehicle-classes.ts";
import { countsAsImpact, INPUT_BYTES, MEMORY, type HighlightClip } from "../match/highlights.ts";
import { DRAFT } from "../match/session.ts";
import { makeSnapshot, readSnapshot, Reader, type Snapshot } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { foldHeading } from "../present/shot-cam.ts";
import { newWorld, settleStep, stepWorld, type World } from "./world-step.ts";
import type { Ejection } from "../vehicle/ejection.ts";

/**
 * What a replay needs from its scene: dress a respawned car, the course's walls and props for car `slot`, and (a scene
 * with a course) what the course remembers: `restore` car `slot` as a keyframe held it (its `MEMORY` doubles at `at` in
 * `mem`: its road projection hint, `RaceField.remember`), `knocks` the props a keyframe held knocked
 * (a bit each, `RaceField.knockTo`).
 */
export type ReplayScene = {
  dress(car: DeformableCar): void;
  collide(car: DeformableCar, slot: number, h: number): void;
  restore?(slot: number, mem: Float64Array, at: number): void;
  knocks?(bits: Uint8Array): void;
  bounce: WorldBounce | undefined;
};

const _q = new THREE.Quaternion();
const _from = new THREE.Quaternion();
/** A throw the clip fires: the recorded ejection, `car` the engine slot, `own` whether the clip's scope owns it (`ClipEjection.own`). */
type FiredEjection = Ejection & { own: boolean };
const NO_EJECTIONS: readonly FiredEjection[] = [];
/** A car that moved further than this (m) in one step was placed (a keyframe's respawn), not driven: `present` draws it where it landed. */
const TELEPORT = 5;

/**
 * One highlight clip re-run through the real sim (docs/HIGHLIGHTS.md): its cars respawned from keyframe 0 (a wreck
 * with its netplay wreck section: dents, lost parts, lamps, glass, then its solver state; style and class are the
 * caller's, `cars[j]` is `clip.cars[j]`), then each recorded step's dt and drive outputs fed through `applyDrive` +
 * `stepWorld` + `settleStep`. A step some of the clip's cars were put on a spot in (a respawn, a police wake or
 * put-away) puts them there again from its keyframe; nothing else corrects the replay, which is the sim that recorded it
 * (the pedals are on the 8-bit grid in the live sim itself). The sim only has the whole steps' states
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
  /** Clip second the last run step began at (`present`'s interpolation starts there, at `from`). */
  private stepAt = 0;
  /** Per car, before the last step: position (3) and rotation as a quaternion (4). */
  private readonly from: Float64Array;
  /** Per car, the sim's true pose `present` replaced: position (3), rotation as a quaternion (4) and Euler (3). */
  private readonly kept: Float64Array;
  private presented = false;
  /**
   * The focus car's travel direction (flat, unit: its velocity, its body's heading when nearly still), low-passed per
   * step by `foldHeading`: a wreck's own velocity swings 4° and more between frames, which a camera behind it must not copy.
   */
  readonly heading = new THREE.Vector2();
  /** Clip seconds the recording runs. */
  readonly length: number;
  private key = 0;
  private readonly keys: Snapshot[];
  /** Per keyframe: every car's flight block (`DeformableCar.flight`), its course memory (`MEMORY` doubles), and each wreck's solver state (`simState`); the knocked props' bits. */
  private readonly flight: Float64Array[] = [];
  private readonly memory: Float64Array[] = [];
  private readonly knocked: Uint8Array[] = [];
  /** Next of `clip.knocks` to apply, and a scratch in the keyframes' bit layout to hand the scene one prop at a time (`knockProp`). */
  private knockAt = 0;
  private readonly knockBits: Uint8Array;
  private readonly sim: (Float64Array | null)[][] = [];
  /** The replay's own world: `strongest` holds the last step's hardest contact. */
  readonly world: World;
  private readonly dress: (car: DeformableCar) => void;
  private readonly restoreCar: ((slot: number, mem: Float64Array, at: number) => void) | undefined;
  private readonly restoreKnocks: ((bits: Uint8Array) => void) | undefined;
  private readonly input: DriveInput = idleDrive();
  /** The first impact's car still had a running engine after the last step (a kill-opened cluster's impact is its death). */
  private aliveA = true;
  /** Next of `clip.ejections` to fire, and the throws fired since `take`. */
  private ejectAt = 0;
  private fired: FiredEjection[] = [];
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
    this.length = clip.h.reduce((a, h) => a + h, 0);
    this.from = new Float64Array(cars.length * 7);
    this.kept = new Float64Array(cars.length * 10);
    const L = carLayout(cars[0]!);
    const r = new Reader();
    this.keys = clip.keys.map((bytes, k) => {
      const snap = makeSnapshot();
      readSnapshot(r.reset(bytes), snap, L);
      const carried = snap.cars.slice(0, snap.count);
      snap.cars.length = 0;
      const bits = new Uint8Array(r.u16());
      for (let i = 0; i < bits.length; i++) bits[i] = r.u8();
      const fl = new Float64Array(cars.length * FLIGHT);
      const mem = new Float64Array(cars.length * MEMORY);
      const sims: (Float64Array | null)[] = cars.map(() => null);
      // The cars the keyframe carries (a later one only those put on a spot): the snapshot's q-th is the clip's q-th set bit of `keyCars`.
      for (let j = 0, q = 0; j < cars.length; j++) {
        if (!((clip.keyCars[k]! >>> j) & 1)) continue;
        const f = carried[q++]!;
        snap.cars[j] = f;
        for (let i = 0; i < FLIGHT; i++) fl[j * FLIGHT + i] = r.f64();
        for (let i = 0; i < MEMORY; i++) mem[j * MEMORY + i] = r.f64();
        // The snapshot's pose is the netplay wire's (1e-4 rad, 1 cm/s, float32 metres); the block's is the car's own.
        const base = j * FLIGHT;
        f.pitch = fl[base + FLIGHT_EULER]!;
        f.yaw = fl[base + FLIGHT_EULER + 1]!;
        f.roll = fl[base + FLIGHT_EULER + 2]!;
        f.vx = fl[base + FLIGHT_VELOCITY]!;
        f.vy = fl[base + FLIGHT_VELOCITY + 1]!;
        f.vz = fl[base + FLIGHT_VELOCITY + 2]!;
        f.x = fl[base + FLIGHT_POSITION]!;
        f.y = fl[base + FLIGHT_POSITION + 1]!;
        f.z = fl[base + FLIGHT_POSITION + 2]!;
        const n = r.u16();
        if (n !== PART_STATE && n !== cars[j]!.deform.simSize() + PART_STATE) throw new RangeError("a keyframe's solver state is another build's");
        const words = new Uint32Array(2 * n);
        for (let i = 0; i < words.length; i++) words[i] = r.u32();
        sims[j] = new Float64Array(words.buffer);
      }
      this.flight.push(fl);
      this.memory.push(mem);
      this.knocked.push(bits);
      this.sim.push(sims);
      return snap;
    });
    this.knockBits = new Uint8Array(this.knocked[0]!.length);
    const w = newWorld(cars);
    const slots = clip.cars.map((c) => c.slot);
    w.collide = (car, k, h) => scene.collide(car, slots[k]!, h);
    w.bounce = scene.bounce;
    w.pairHit = (a, b, hit, first) => this.noteHit(a, b, hit.impulse, first);
    this.world = w;
    this.dress = scene.dress;
    this.restoreCar = scene.restore;
    this.restoreKnocks = scene.knocks;
  }

  get done(): boolean {
    return this.step >= this.clip.h.length;
  }

  /**
   * The dummies thrown since the last call: the clip's `ejections` as their steps ran, `car` the engine slot of the clip's
   * car (a shared empty array when none). The recording's own numbers, so every replay launches the same throws.
   */
  take(): readonly FiredEjection[] {
    if (this.fired.length === 0) return NO_EJECTIONS;
    const out = this.fired;
    this.fired = [];
    return out;
  }

  /** Step `s` has run: the drivers the record threw out in it are out of their cars now. */
  private fire(s: number): void {
    const list = this.clip.ejections;
    for (; this.ejectAt < list.length && list[this.ejectAt]!.step <= s; this.ejectAt++) {
      const x = list[this.ejectAt]!;
      this.cars[x.e.car]!.driverOut = x.e.exit;
      this.fired.push({ ...x.e, car: this.clip.cars[x.e.car]!.slot, own: x.own });
    }
  }

  /** Prop `prop` is knocked off its spot, as `RaceField.knockTo` does for a keyframe's bits (a prop the course does not have is ignored). */
  private knockProp(prop: number): void {
    const bits = this.knockBits;
    if (!this.restoreKnocks || prop >> 3 >= bits.length) return;
    bits[prop >> 3] = 1 << (prop & 7);
    this.restoreKnocks(bits);
    bits[prop >> 3] = 0;
  }

  /** Respawn every car in its keyframe-0 state, at the clip's start. */
  restart(): void {
    this.step = 0;
    this.time = 0;
    this.ejectAt = 0;
    this.knockAt = 0;
    this.fired = [];
    this.stepAt = 0;
    this.presented = false;
    this.heading.set(0, 0);
    this.firstHit = -1;
    this.pairAt.fill(-Infinity);
    this.wallAt.fill(-Infinity);
    for (let j = 0; j < this.cars.length; j++) this.spawn(j, 0);
    this.restoreKnocks?.(this.knocked[0]!);
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
      // The cars the record put on a spot in this step (a respawn, a wake, a put-away) go there: the one thing the replay cannot drive.
      while (this.key < clip.keyStep.length && clip.keyStep[this.key]! <= s) {
        if (clip.keyStep[this.key] === s) for (let j = 0; j < nc; j++) if ((clip.keyCars[this.key]! >>> j) & 1) this.snap(j, this.key);
        this.key++;
      }
      // The props a car the clip leaves out knocked off their spot in this step: gone before the clip's cars reach them, as in the record. (A clip car at one in the same step would have knocked it itself.)
      for (const ks = clip.knocks; this.knockAt < ks.length && ks[this.knockAt]!.step <= s; this.knockAt++) this.knockProp(ks[this.knockAt]!.prop);
      const h = clip.h[s]!;
      const inp = clip.inputs;
      const d = this.input;
      for (let j = 0; j < nc; j++) {
        const o = (s * nc + j) * INPUT_BYTES;
        // The pedals the live sim ran: `applyDrive` puts them on the grid the clip stores them on (`THROTTLE_STEPS`, `BRAKE_STEPS`).
        d.throttle = ((inp[o]! << 24) >> 24) / THROTTLE_STEPS;
        d.steer = ((inp[o + 1]! << 24) >> 24) / THROTTLE_STEPS;
        d.brake = inp[o + 2]! / BRAKE_STEPS;
        d.ebrake = (inp[o + 3]! & 1) !== 0;
        d.boost = (inp[o + 3]! & 2) !== 0;
        d.neutral = (inp[o + 3]! & 8) !== 0;
        applyDrive(cars[j]!, d, h, inp[o + 3]! & 4 ? DRAFT.top : 1);
      }
      // The schedule the live world ran this step on: it depends on every car in it, the clip's or not.
      this.world.plan = clip.shape[s]!;
      stepWorld(this.world, h);
      settleStep(cars, h, clip.bleed);
      this.fire(s);
      // A cluster opened by a kill: the struck car's drivetrain dying is the impact.
      const a = cars[clip.firstA]!;
      if (clip.firstB < 0 && this.aliveA && !a.deform.drivetrainAlive) this.markHit();
      this.aliveA = a.deform.drivetrainAlive;
      this.time += h;
      this.step++;
      foldHeading(this.heading, this.cars[this.clip.focus]!, h);
    }
    HANDLING.realism = saved;
  }

  /**
   * Every car drawn at clip time `until`, inside the last run step (as `advanceTo` leaves it): its pose between the one
   * before that step and the one it left, so a frame inside a step moves the cars on instead of repeating the last
   * step's pose. A car the step placed (> `TELEPORT`) stays where it landed. The next `advanceTo` puts the true state back first: the replay itself never runs from a drawn pose.
   */
  present(until: number): void {
    this.restore();
    const span = this.time - this.stepAt;
    const u = span > 1e-9 ? Math.min(1, Math.max(0, (until - this.stepAt) / span)) : 1;
    if (u >= 1) return;
    this.presented = true;
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
      p.set(f[o]! + (p.x - f[o]!) * u, f[o + 1]! + (p.y - f[o + 1]!) * u, f[o + 2]! + (p.z - f[o + 2]!) * u);
      _from.set(f[o + 3]!, f[o + 4]!, f[o + 5]!, f[o + 6]!);
      q.copy(_from.slerp(_q.set(k[m + 3]!, k[m + 4]!, k[m + 5]!, k[m + 6]!), u));
    }
  }

  /**
   * Undo `present`: every car back on the sim's own pose, exactly. A car on its wheels (`stepPlane`) has its Euler angles read by
   * the sim; a rigid (`stepFree`) or falling one's quaternion is (the Euler is derived from it), and quaternion -> Euler ->
   * quaternion is not exact: write the quaternion, then the Euler only if the car's own differs.
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

  /** The course's wall or a prop touched the clip's car in race slot `slot`, closing at `closing` m/s (`RaceField.onWallHit`). */
  noteWall(slot: number, closing: number): void {
    const c = this.clip;
    const j = c.cars.findIndex((x) => x.slot === slot);
    if (j < 0) return;
    const counts = countsAsImpact(this.time - this.wallAt[j]!, closing);
    this.wallAt[j] = this.time;
    if (counts && c.firstB < 0 && j === c.firstA) this.markHit();
  }

  /** The recorded first impact's pair touched at `closing` m/s (first SAT pass: the contact they came in with). */
  private noteHit(a: number, b: number, closing: number, first: boolean): void {
    if (!first) return;
    const { firstA, firstB } = this.clip;
    const k = a * this.cars.length + b;
    const counts = countsAsImpact(this.time - this.pairAt[k]!, closing);
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
    if (sim) {
      const solver = sim.length - PART_STATE;
      if (solver > 0) car.deform.simState(sim.subarray(0, solver), true);
      car.partState(sim.subarray(solver), true);
    }
    // The net state of a car that is no wreck (one with a part torn off) carries no crumple settings: the recording's again.
    car.deform.squash = this.clip.squash;
    car.deform.buckle = this.clip.buckle;
    car.deform.setMode(this.clip.deformMode);
    // What it touches is read again with its wreck state back (`pose` read it as an intact car): a wreck on its masses touches
    // what its hubs' last slice left, and a crashed one off them is moved by the rigid step.
    car.restoreContact();
    if (f.falling) beginFakeFall(car, true);
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
    this.restoreCar?.(this.clip.cars[j]!.slot, this.memory[k]!, j * MEMORY);
    car.speed = Math.hypot(car.velocity.x, car.velocity.z);
    car.refreshBasis();
    car.deform.bindKinematic(car.group, car.velocity, car.angular);
  }
}
