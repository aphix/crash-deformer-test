import { beginFakeFall, FLIGHT, type DeformableCar } from "../vehicle/car.ts";
import type { WorldBounce } from "../vehicle/car-core.ts";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { HANDLING } from "../vehicle/vehicle-classes.ts";
import { INPUT_BYTES, type HighlightClip } from "../match/highlights.ts";
import { DRAFT } from "../match/session.ts";
import { makeSnapshot, Q, readSnapshot, Reader, type Snapshot } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { newWorld, settleStep, stepWorld, type World } from "./world-step.ts";

/** What a replay needs from its scene: dress a respawned car, and the course's walls and props for car `slot`. */
export type ReplayScene = {
  dress(car: DeformableCar): void;
  collide(car: DeformableCar, slot: number): void;
  bounce: WorldBounce | undefined;
};

/**
 * One highlight clip re-run through the real sim (docs/HIGHLIGHTS.md): its cars respawned from keyframe 0 (a wreck
 * with its netplay wreck section: dents, lost parts, lamps, glass, then its solver state; style and class are the
 * caller's, `cars[j]` is `clip.cars[j]`), then each recorded step's dt and drive outputs fed through `applyDrive` +
 * `stepWorld` + `settleStep`. Up to and including the first impact's step, every keyframe snaps its cars back onto
 * the record (drift correction); after it the crash plays out on its own.
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
  /** Clip seconds the recording runs. */
  readonly length: number;
  private key = 0;
  private readonly keys: Snapshot[];
  private readonly drift: Float32Array[];
  /** Per keyframe: every car's flight block (`DeformableCar.flight`), and each wreck's solver state (`simState`). */
  private readonly flight: Float32Array[] = [];
  private readonly sim: (Float32Array | null)[][] = [];
  /** The replay's own world: `strongest` holds the last step's hardest contact. */
  readonly world: World;
  private readonly dress: (car: DeformableCar) => void;
  private readonly input: DriveInput = idleDrive();
  /** The first impact's car still had a running engine after the last step (a kill-opened cluster's impact is its death). */
  private aliveA = true;

  constructor(clip: HighlightClip, cars: readonly DeformableCar[], scene: ReplayScene) {
    this.clip = clip;
    this.cars = cars;
    this.impactStep = clip.firstStep;
    this.length = clip.h.reduce((a, h) => a + h, 0);
    this.preSnap = new Float32Array(cars.length * 3);
    const L = carLayout(cars[0]!);
    const r = new Reader();
    this.keys = [];
    this.drift = clip.keys.map((bytes) => {
      const snap = makeSnapshot();
      readSnapshot(r.reset(bytes), snap, L);
      this.keys.push(snap);
      const d = new Float32Array(cars.length);
      for (let j = 0; j < d.length; j++) d[j] = r.q16(Q.fine);
      const fl = new Float32Array(cars.length * FLIGHT);
      const sims: (Float32Array | null)[] = [];
      for (let j = 0; j < cars.length; j++) {
        for (let i = 0; i < FLIGHT; i++) fl[j * FLIGHT + i] = r.f32();
        const n = r.u16();
        if (n > 0 && n !== cars[j]!.deform.simSize()) throw new RangeError("a keyframe's solver state is another build's");
        const s = n > 0 ? new Float32Array(n) : null;
        for (let i = 0; i < n; i++) s![i] = r.f32();
        sims.push(s);
      }
      this.flight.push(fl);
      this.sim.push(sims);
      return d;
    });
    const w = newWorld(cars);
    const slots = clip.cars.map((c) => c.slot);
    w.collide = (car, k) => scene.collide(car, slots[k]!);
    w.bounce = scene.bounce;
    w.pairHit = (a, b, _hit, first) => this.noteHit(a, b, first);
    this.world = w;
    this.dress = scene.dress;
  }

  get done(): boolean {
    return this.step >= this.clip.h.length;
  }

  /** Respawn every car in its keyframe-0 state, at the clip's start. */
  restart(): void {
    this.step = 0;
    this.time = 0;
    this.firstHit = -1;
    for (let j = 0; j < this.cars.length; j++) this.spawn(j, 0);
    this.aliveA = this.cars[this.clip.firstA]!.deform.drivetrainAlive;
    this.key = 1;
  }

  /**
   * Run recorded steps until `time` would pass `until` (clip s) or the clip ends; with `deadline` (a
   * `performance.now()` ms), also stop once it passes after at least one step, to resume next call.
   */
  advanceTo(until: number, deadline = Infinity): void {
    const { clip, cars } = this;
    const nc = cars.length;
    const saved = HANDLING.realism;
    HANDLING.realism = clip.realism;
    const s0 = this.step;
    while (this.step < clip.h.length && this.time + clip.h[this.step]! <= until + 1e-9 && (this.step === s0 || performance.now() < deadline)) {
      const s = this.step;
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
        if (at === s && s <= this.impactStep && (this.useImpactKey || at !== this.impactStep)) for (let j = 0; j < nc; j++) this.snap(j, this.key);
        this.key++;
      }
      const h = clip.h[s]!;
      const inp = clip.inputs;
      const d = this.input;
      for (let j = 0; j < nc; j++) {
        const o = (s * nc + j) * INPUT_BYTES;
        d.throttle = ((inp[o]! << 24) >> 24) / 127;
        d.steer = ((inp[o + 1]! << 24) >> 24) / 127;
        d.brake = inp[o + 2]! / 255;
        d.ebrake = (inp[o + 3]! & 1) !== 0;
        d.boost = (inp[o + 3]! & 2) !== 0;
        applyDrive(cars[j]!, d, h, inp[o + 3]! & 4 ? DRAFT.top : 1);
      }
      stepWorld(this.world, h);
      settleStep(cars, h, clip.bleed);
      // A cluster opened by a kill: the struck car's drivetrain dying is the impact.
      const a = cars[clip.firstA]!;
      if (clip.firstB < 0 && this.aliveA && !a.deform.drivetrainAlive) this.markHit();
      this.aliveA = a.deform.drivetrainAlive;
      this.time += h;
      this.step++;
    }
    HANDLING.realism = saved;
  }

  /** The course's wall or a prop touched the clip's car in race slot `slot` (`RaceField.onWallHit`). */
  noteWall(slot: number): void {
    const c = this.clip;
    if (c.firstB < 0 && c.cars[c.firstA]!.slot === slot) this.markHit();
  }

  /** The recorded first impact's pair touched (first SAT pass: the contact they came in with). */
  private noteHit(a: number, b: number, first: boolean): void {
    const { firstA, firstB } = this.clip;
    if (first && ((a === firstA && b === firstB) || (a === firstB && b === firstA))) this.markHit();
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

  /** Kinematic pose, motion and flight state from keyframe `k`'s frame of car `j`. */
  private pose(j: number, k: number): void {
    const car = this.cars[j]!;
    const f = this.keys[k]!.cars[j]!;
    const g = car.group;
    g.position.set(f.x, f.y, f.z);
    g.rotation.set(f.pitch, f.yaw, f.roll, "YXZ");
    car.pitch = f.pitch;
    car.yaw = f.yaw;
    car.roll = f.roll;
    car.velocity.set(f.vx, f.vy, f.vz);
    car.flight(this.flight[k]!, j * FLIGHT, true);
    car.speed = Math.hypot(f.vx, f.vz);
    car.drive.drift = this.drift[k]![j]!;
    car.refreshBasis();
    car.deform.bindKinematic(g, car.velocity, car.angular);
  }
}
