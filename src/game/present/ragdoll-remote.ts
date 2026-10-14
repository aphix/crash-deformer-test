import * as THREE from "three";
import { MAX_CARS } from "../scenes/fleet.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { GLASS_NAMES } from "../vehicle/car-glass.ts";
import { CLASS_LIFT } from "../vehicle/constants.ts";
import { carClass, classStats } from "../vehicle/vehicle-classes.ts";
import type { TrackJson } from "../world/track-schema.ts";
import type { Throw } from "./engine-ragdoll.ts";
import {
  CAR_FLAGS,
  CAR_FLOATS,
  CAR_GLASS,
  CAR_LIFT_POSITION,
  CAR_LIFT_QUATERNION,
  CAR_POSITION,
  CAR_QUATERNION,
  CAR_SPEED,
  CAR_VELOCITY,
  FLAG_FALLING,
  FLAG_LIFT,
  FLAG_VAPORIZED,
  LAG,
  type FromWorker,
  type ResultMessage,
  type ToWorker,
} from "./ragdoll-wire.ts";

/** Cars within this many metres of a throw get their cages sent with it: the world's own answer about what is near comes `LAG` frames later. */
const THROW_REACH = 12;
/** Wall ms the sim may wait for the worker's answer (`behind`) before the worker counts as failed. */
const STALL_MS = 1500;

/** The dummies' world in a Web Worker (`ragdoll-worker.ts`), as the main thread talks to it. */
export class RagdollRemote {
  /** The worker has loaded Rapier and answers. */
  ready = false;
  private readonly worker: Worker;
  private readonly onFail: (err: Error) => void;
  private failed = false;
  /** Frames posted, and the newest answer's frame: the sim runs a frame only while the answer to frame `posted + 1 - LAG` is in. */
  private posted = 0;
  private replied = 0;
  /** Bumped by `reset`: an answer of an earlier epoch is dropped. */
  private epoch = 0;
  private throws = 0;
  /** Answers not yet heard of by the sim (`LAG` frames old at most), and not yet drawn. */
  private readonly lagged: ResultMessage[] = [];
  private readonly undrawn: ResultMessage[] = [];
  /** What the last answer the sim heard said: its frame, whether anything was out, the cars it wanted cages of. */
  private heardFrame = 0;
  private heardActive = false;
  private readonly wanted = new Uint8Array(MAX_CARS);
  /** A throw or knock was sent since the last frame; the frame it went with (the world answers to it that it is active). */
  private commanded = false;
  private commandFrame = 0;
  /** Cars near a throw: their cages go with the next frames whatever the world has said. */
  private readonly forced = new Uint8Array(MAX_CARS);
  private forcedUntil = 0;
  /** Per slot, the car, cage fields, cage serial and class lift last sent. */
  private readonly sent = Array.from({ length: MAX_CARS }, () => ({ car: null as DeformableCar | null, fields: null as object | null, serial: -1, lift: NaN }));
  private readonly carIds = new WeakMap<DeformableCar, number>();
  private carCount = 0;
  private readonly liftBodies = new WeakMap<DeformableCar, THREE.Object3D | null>();
  private stalledSince = 0;

  private constructor(worker: Worker, onFail: (err: Error) => void) {
    this.worker = worker;
    this.onFail = onFail;
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.hear(event.data);
    worker.onerror = (event) => this.fail(new Error(event.message || "worker error"));
    worker.onmessageerror = () => this.fail(new Error("worker message could not be read"));
  }

  /** The worker, or null where the browser has none (or it would not start: logged). */
  static open(onFail: (err: Error) => void): RagdollRemote | null {
    if (typeof Worker === "undefined") return null;
    try {
      return new RagdollRemote(new Worker(new URL("./ragdoll-worker.ts", import.meta.url), { type: "module" }), onFail);
    } catch (err) {
      console.error("Crush Stream ragdoll worker did not start", err);
      return null;
    }
  }

  dispose(): void {
    this.failed = true;
    this.worker.terminate();
  }

  setCourse(json: TrackJson): void {
    this.send({ type: "course", json });
  }

  /** A new run: the world's dummies and props go, and what it answers of the old run is dropped. */
  reset(): void {
    this.epoch++;
    this.lagged.length = 0;
    this.undrawn.length = 0;
    this.wanted.fill(0);
    this.forced.fill(0);
    this.heardActive = false;
    this.heardFrame = this.posted;
    this.commanded = false;
    this.commandFrame = 0;
    for (const s of this.sent) s.car = null;
    this.send({ type: "reset", epoch: this.epoch });
  }

  knock(prop: number, car: number, vx: number, vy: number, vz: number): void {
    this.commanded = true;
    this.send({ type: "knock", prop, car, vx, vy, vz });
  }

  /** Throw `t`'s dummy in the world; returns the id its answer names it by. The cars near it get their cages with the next frames. */
  throwDummy(t: Throw, purse: boolean, lookSeed: number, cars: readonly DeformableCar[]): number {
    const id = ++this.throws;
    this.commanded = true;
    this.forcedUntil = this.posted + LAG + 2;
    for (let i = 0; i < cars.length && i < MAX_CARS; i++) if (cars[i]!.group.position.distanceTo(t.p) < THROW_REACH) this.forced[i] = 1;
    this.send({
      type: "throw",
      id,
      car: t.car,
      position: [t.p.x, t.p.y, t.p.z],
      rotation: [t.q.x, t.q.y, t.q.z, t.q.w],
      velocity: [t.v.x, t.v.y, t.v.z],
      spin: [t.w.x, t.w.y, t.w.z],
      cop: t.cop,
      rides: t.rides,
      purse,
      lookSeed,
    });
    return id;
  }

  /**
   * The sim may not run its next frame: the world's answer to frame `posted + 1 - LAG`, which that frame's sim is to hear of
   * (`apply`), is not in. Only a peer that owns the glass waits, and only while the world has something out. A worker that
   * keeps the sim waiting over `STALL_MS` has failed.
   */
  behind(authority: boolean): boolean {
    const due = this.posted + 1 - LAG;
    if (this.failed || !authority || due < 1 || this.replied >= due || !this.active()) {
      this.stalledSince = 0;
      return false;
    }
    const now = performance.now();
    this.stalledSince ||= now;
    if (now - this.stalledSince < STALL_MS) return true;
    this.fail(new Error(`worker silent for ${STALL_MS} ms`));
    return false;
  }

  /**
   * One frame of the world: the answers due (`LAG` frames old) are heard by the sim (`apply`: the panes struck are struck on the
   * cars, the wanted cars set), the cages wanted are sent, and the cars as they stand now are posted. Nothing is posted while
   * the world has nothing out and nothing was thrown or knocked.
   */
  post(dt: number, cars: readonly DeformableCar[], authority: boolean, sandbox: boolean, lookSeed: number): void {
    const due = this.posted + 1 - LAG;
    while (this.lagged.length > 0 && this.lagged[0]!.seq <= due) this.apply(this.lagged.shift()!, cars);
    if (this.failed || !this.active()) return;
    const seq = ++this.posted;
    if (this.commanded) {
      this.commanded = false;
      this.commandFrame = seq;
    }
    if (seq >= this.forcedUntil) this.forced.fill(0);
    const count = Math.min(cars.length, MAX_CARS);
    this.sendCages(cars, count);
    const block = new Float64Array(count * CAR_FLOATS);
    for (let i = 0; i < count; i++) this.record(cars[i]!, block, i * CAR_FLOATS);
    this.send({ type: "frame", seq, epoch: this.epoch, dt, authority, sandbox, lookSeed, count, cars: block }, [block.buffer]);
  }

  /** The answers that came since the last call, for drawing. */
  drain(): ResultMessage[] {
    return this.undrawn.splice(0);
  }

  /** The sim has heard everything the world answered up to frame `heardFrame`; anything is out, or was thrown since. */
  private active(): boolean {
    return this.commanded || this.heardFrame < this.commandFrame || this.heardActive;
  }

  private apply(r: ResultMessage, cars: readonly DeformableCar[]): void {
    this.heardFrame = r.seq;
    this.heardActive = r.active;
    this.wanted.set(r.wanted);
    for (const hit of r.hits) cars[hit.car]?.hitGlass(GLASS_NAMES[hit.pane]!);
  }

  private hear(m: FromWorker): void {
    if (m.type === "ready") this.ready = true;
    else if (m.type === "failed") this.fail(new Error(m.message));
    else if (m.type === "result") {
      this.replied = Math.max(this.replied, m.seq);
      if (m.epoch !== this.epoch) return;
      this.lagged.push(m);
      this.undrawn.push(m);
    }
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.worker.terminate();
    this.onFail(err);
  }

  private send(m: ToWorker, transfer: Transferable[] = []): void {
    if (!this.failed) this.worker.postMessage(m, transfer);
  }

  /** The cages of the cars the world wants (or that a throw is near), when they changed since last sent. A car's cage is brought up to date here, as it is when the world is in this thread. */
  private sendCages(cars: readonly DeformableCar[], count: number): void {
    for (let i = 0; i < count; i++) {
      if (!this.wanted[i] && !this.forced[i]) continue;
      const car = cars[i]!;
      car.refitCage();
      const cage = car.cage;
      const lift = classStats(carClass(car)).lift;
      const sent = this.sent[i]!;
      if (sent.car === car && sent.fields === cage.fields && sent.serial === cage.serial && sent.lift === lift) continue;
      sent.car = car;
      sent.fields = cage.fields;
      sent.serial = cage.serial;
      sent.lift = lift;
      const top = cage.fields.top.slice();
      const covered = cage.fields.covered.slice();
      const plan = cage.planField().slice();
      const planBox = cage.fields.planBox.slice();
      const { nu, nv, u0, v0, step } = cage.style;
      this.send(
        { type: "cage", slot: i, car: this.idOf(car), style: car.style.id, classLift: lift, serial: cage.serial, top, covered, plan, planBox, heightMax: cage.fields.heightMax, nu, nv, u0, v0, step },
        [top.buffer, covered.buffer, plan.buffer, planBox.buffer],
      );
    }
  }

  private idOf(car: DeformableCar): number {
    let id = this.carIds.get(car);
    if (id === undefined) this.carIds.set(car, (id = ++this.carCount));
    return id;
  }

  /** A car's record in a frame (`CAR_FLOATS` floats at `o`). */
  private record(car: DeformableCar, block: Float64Array, o: number): void {
    car.group.position.toArray(block, o + CAR_POSITION);
    car.group.quaternion.toArray(block, o + CAR_QUATERNION);
    car.velocity.toArray(block, o + CAR_VELOCITY);
    let flags = (car.falling ? FLAG_FALLING : 0) | (car.vaporized ? FLAG_VAPORIZED : 0);
    const lift = this.liftOf(car);
    if (lift !== null) {
      flags |= FLAG_LIFT;
      lift.position.toArray(block, o + CAR_LIFT_POSITION);
      lift.quaternion.toArray(block, o + CAR_LIFT_QUATERNION);
    }
    block[o + CAR_SPEED] = car.speed;
    block[o + CAR_FLAGS] = flags;
    block[o + CAR_GLASS] = car.glassBits();
  }

  private liftOf(car: DeformableCar): THREE.Object3D | null {
    let body = this.liftBodies.get(car);
    if (body === undefined) this.liftBodies.set(car, (body = car.group.getObjectByName(CLASS_LIFT) ?? null));
    return body;
  }
}
