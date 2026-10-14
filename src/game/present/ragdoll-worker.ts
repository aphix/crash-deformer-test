import * as THREE from "three";
import { placeProps } from "../world/placements.ts";
import { setGround } from "../world/ground.ts";
import { Track } from "../world/track.ts";
import { RagdollSystem, type Throw } from "./engine-ragdoll.ts";
import { RemoteCar } from "./ragdoll-car-view.ts";
import { SLOTS } from "./ragdoll-config.ts";
import type { PropDraw } from "./ragdoll-props.ts";
import { PURSE_BLOCK } from "./ragdoll-purse.ts";
import { DOLL_FLOATS, type FromWorker, type ResultMessage, type ToWorker } from "./ragdoll-wire.ts";

/**
 * The dummies' world (`RagdollSystem`) in a Web Worker: the main thread posts its frames, throws, knocks and cars' cages
 * (`RagdollRemote`), this answers each frame with the poses to draw, the panes struck, and the cars it wants cages of.
 * It draws nothing itself.
 */

/** The props' draw here: where each knocked prop was placed since the last answer. */
class PropRecorder implements PropDraw {
  private placed: number[] = [];
  /** Every prop went back on its spot since the last answer (the places before it are void). */
  restored = false;

  place(index: number, base: THREE.Vector3, q: THREE.Quaternion): void {
    this.placed.push(index, base.x, base.y, base.z, q.x, q.y, q.z, q.w);
  }

  reset(): void {
    this.restored = true;
    this.placed.length = 0;
  }

  take(): Float32Array {
    const places = Float32Array.from(this.placed);
    this.placed.length = 0;
    return places;
  }
}

const recorder = new PropRecorder();
const spawned: { id: number; slot: number }[] = [];
const cars: RemoteCar[] = [];
const early: ToWorker[] = [];
let system: RagdollSystem | null = null;
let epoch = 0;
let stepsAnswered = 0;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

function answer(world: RagdollSystem, seq: number): void {
  const dolls = new Float32Array(SLOTS * DOLL_FLOATS);
  const purses = new Float32Array(SLOTS * PURSE_BLOCK);
  const lastSlot = world.snapshot(dolls, purses);
  const props = recorder.take();
  const stats = world.stats;
  const stepMs = new Float64Array(stats.steps - stepsAnswered);
  for (let n = stepsAnswered; n < stats.steps; n++) stepMs[n - stepsAnswered] = stats.log[n % stats.log.length]!;
  stepsAnswered = stats.steps;
  const result: ResultMessage = {
    type: "result",
    seq,
    epoch,
    dolls,
    alpha: world.drawAlpha,
    lastSlot,
    purses,
    props,
    propsReset: recorder.restored,
    spawned: [...spawned],
    hits: world.takeStrikes(),
    wanted: world.wanted.slice(),
    active: world.busy,
    stepMs,
    colliders: stats.colliders,
    bodies: stats.bodies,
  };
  spawned.length = 0;
  recorder.restored = false;
  post(result, [dolls.buffer, purses.buffer, props.buffer, result.wanted.buffer, stepMs.buffer]);
}

function throwDummy(world: RagdollSystem, m: Extract<ToWorker, { type: "throw" }>): void {
  const throwing: Throw = {
    car: m.car,
    p: new THREE.Vector3(...m.position),
    q: new THREE.Quaternion(...m.rotation),
    v: new THREE.Vector3(...m.velocity),
    w: new THREE.Vector3(...m.spin),
    age: 0,
    cop: m.cop,
    rides: m.rides,
    purse: m.purse,
  };
  world.lookSeed = m.lookSeed;
  spawned.push({ id: m.id, slot: world.spawn(throwing) });
}

function handle(world: RagdollSystem, m: ToWorker): void {
  if (m.type === "course") {
    const track = new Track(m.json);
    setGround(track.ground());
    world.setCourse(track, placeProps(track), recorder);
  } else if (m.type === "reset") {
    epoch = m.epoch;
    world.reset();
    cars.length = 0;
    spawned.length = 0;
    world.takeStrikes();
  } else if (m.type === "knock") world.knockProp(m.prop, m.car, m.vx, m.vy, m.vz);
  else if (m.type === "throw") throwDummy(world, m);
  else if (m.type === "cage") {
    if (cars[m.slot]?.token !== m.car) cars[m.slot] = new RemoteCar(m.car);
    cars[m.slot]!.setCage(m);
  } else {
    for (let n = 0; n < m.count; n++) (cars[n] ??= new RemoteCar(0)).setFrame(m.cars, n);
    cars.length = m.count;
    world.lookSeed = m.lookSeed;
    world.frameNo = m.seq - 1;
    world.stepWorld(m.dt, cars, m.authority, m.sandbox, null);
    answer(world, m.seq);
  }
}

function hear(m: ToWorker): void {
  if (system === null) {
    early.push(m);
    return;
  }
  try {
    handle(system, m);
  } catch (err) {
    post({ type: "failed", message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => hear(event.data);

try {
  const world = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  world.host();
  await world.preload();
  system = world;
  post({ type: "ready" });
  for (const m of early.splice(0)) hear(m);
} catch (err) {
  post({ type: "failed", message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
}
