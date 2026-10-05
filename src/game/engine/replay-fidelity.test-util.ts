import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { armKill, assignClass, carClass, HANDLING, killClass } from "../vehicle/vehicle-classes.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { FRAME, frame, type World } from "../world/race-world.test-util.ts";
import { type HighlightClip } from "../match/highlights.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import { CrashRecorder } from "./engine-record.ts";
import { ClipSim, type ReplayScene } from "./engine-replay.ts";
import { carLayout } from "../net/car-pose.ts";
import { clipBytes, readClip, writeClip } from "../net/reel-codec.ts";
import { Reader, Writer } from "../net/codec.ts";
import type { RaceOptions } from "../match/types.ts";

/**
 * Live vs replay (docs/HIGHLIGHTS.md): a crash recorded by the real recorder, then its clip re-simulated by `ClipSim`,
 * step for step against what the live sim did. Not a test file itself.
 */

/** Numbers per car in a trace: x, y, z, vx, vy, vz, crush, wreck flag, and how many times the car was put on a spot (`DeformableCar.placements`). */
const STATE = 9;

/** A crash recorded: the clip, the world's cars, and every car's state at the start of every recorder step. */
export interface Recording {
  clip: HighlightClip;
  cars: DeformableCar[];
  /** The scene a replay of it needs. */
  scene: ReplayScene;
  /** Recorder step -> `STATE` numbers per car slot, as the step began (the previous step's `settleStep` included). */
  trace: Float64Array[];
  /** The trace step the clip's step 0 is. */
  s0: number;
  /** Recorder steps that ended a rendered frame: the engine skins its cars (`updateSkin`) right after them. */
  frameEnd: boolean[];
}

/** Total crush (m): how far every mass of the car sits from its rest place, summed. */
function crush(car: DeformableCar): number {
  let sum = 0;
  for (const m of car.deform.masses) sum += m.local.distanceTo(m.rest);
  return sum;
}

/** Every car's state into `out` (`STATE` numbers each). */
function capture(cars: readonly DeformableCar[], out: Float64Array): void {
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]!;
    const o = i * STATE;
    out[o] = c.group.position.x;
    out[o + 1] = c.group.position.y;
    out[o + 2] = c.group.position.z;
    out[o + 3] = c.velocity.x;
    out[o + 4] = c.velocity.y;
    out[o + 5] = c.velocity.z;
    out[o + 6] = crush(c);
    out[o + 7] = c.deform.massActive ? 1 : 0;
    out[o + 8] = c.placements;
  }
}

/** The trace step of the clip's step 0: the recorder clock (`times`) nearest the clip's `t0`. */
function clipStart(clip: HighlightClip, times: Map<number, number>): number {
  let best = -1;
  let gap = Infinity;
  for (const [step, t] of times) {
    const g = Math.abs(t - clip.t0);
    if (g < gap) {
      gap = g;
      best = step;
    }
  }
  return best;
}

/** One car of a flat-field crash: where it starts, which way it heads (yaw: heading is (sin, cos)), how fast, and its pedals. */
export interface Spawn {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  throttle?: number;
  steer?: number;
}

/** `dress` as the engine's `dressCar` does it for a sandbox or a derby (the killing context differs). */
function dresser(derby: boolean): (car: DeformableCar) => void {
  return (car) => {
    car.deform.squash = INITIAL_HUD.squash;
    car.deform.buckle = INITIAL_HUD.buckle;
    car.deform.setMode(INITIAL_HUD.deformMode);
    assignClass(car, carClass(car));
    armKill(car.deform, killClass(car), HANDLING.realism, derby ? "derby" : "default");
  };
}

/**
 * A crash on a flat field with no walls (the derby's rules: `derby` arms the wear kill), the recorder fed as the engine
 * does: frames of 1/60 s cut into `physicsSlice` steps, every car on its own pedals, the clip the best the ledger kept.
 */
export function recordFlat(spawns: readonly Spawn[], seconds: number, derby: boolean): Recording {
  const scene = new THREE.Scene();
  const dress = dresser(derby);
  const cars = spawns.map((s, i) => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    car.spawnFacing(s.x, s.z, s.yaw, s.speed);
    return car;
  });
  const rec = new CrashRecorder();
  rec.begin("flat", HANDLING.realism, false, cars.length, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit, first) => rec.pairHit(a, b, hit, first);
  world.partTouch = (a, b) => rec.touch(a, b);
  const trace: Float64Array[] = [];
  const times = new Map<number, number>();
  const frameEnd: boolean[] = [];
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  let acc = 0;
  for (let f = 0; f < Math.round(seconds / FRAME); f++) {
    const vmax = sliceSpeed(cars);
    acc = Math.min(0.05, acc + FRAME);
    for (let n = 0; acc > 1e-5 && n < 8; n++) {
      const h = Math.fround(physicsSlice(acc, vmax)); // as the engine's step (`CrashEngine.tickInner`)
      const step = rec["step"];
      trace[step] = new Float64Array(cars.length * STATE);
      capture(cars, trace[step]!);
      times.set(step, rec.now);
      rec.startStep(cars);
      cars.forEach((car, i) => {
        input.throttle = spawns[i]!.throttle ?? 0.6;
        input.steer = spawns[i]!.steer ?? 0;
        applyDrive(car, input, h);
      });
      stepWorld(world, h);
      rec.endStep(cars, h, world.shape);
      settleStep(cars, h, false);
      acc -= h;
    }
    frameEnd[rec["step"] - 1] = true;
    for (const car of cars) car.updateSkin();
  }
  rec.end();
  const clip = rec.ledger.kept[0];
  if (!clip) throw new Error("the crash did not rank as a highlight");
  return { clip, cars, scene: { dress, collide: () => {}, bounce: undefined }, trace, s0: clipStart(clip, times), frameEnd };
}

/** The race of `race-eject-reel.test.ts` (oval, `ai` AI drivers besides the player's car, which the AI drives too; seed 1) a second in; `place` puts the crash's cars on the road. */
export function recordRace(w: World, place: () => void, seconds: number, ai: number): Recording {
  const r = w.race;
  r.command({ type: "quit" });
  r.command({ type: "options", options: { trackId: "oval", laps: 3, aiCount: ai, noReset: false, aggression: 0.35 } });
  r.reseed(1);
  w.ejections.length = 0;
  r.command({ type: "start" });
  w.seat.mode = "follow";
  const trace: Float64Array[] = [];
  const times = new Map<number, number>();
  const frameEnd: boolean[] = [];
  const rec = r.recorder;
  const startStep = rec.startStep.bind(rec);
  rec.startStep = (cars) => {
    const step = rec["step"];
    trace[step] = new Float64Array(cars.length * STATE);
    capture(cars, trace[step]!);
    times.set(step, rec.now);
    startStep(cars);
  };
  const state = { acc: 0 };
  try {
    for (let n = 0; r.time < 1 && n < 900; n++) frame(w, state);
    place();
    for (let n = 0; n < Math.round(seconds / FRAME); n++) {
      frame(w, state);
      frameEnd[rec["step"] - 1] = true;
    }
    rec.end();
  } finally {
    rec.startStep = startStep;
  }
  const clip = rec.ledger.kept[0];
  if (!clip) throw new Error("the crash did not rank as a highlight");
  const scene: ReplayScene = { dress: w.dress, collide: (car, slot, h) => r.courseHit(car, slot, h), restore: (slot, mem, at) => r.remember(slot, mem, at), knocks: (bits) => r.knockTo(bits), bounce: undefined };
  return { clip, cars: w.cars, scene, trace, s0: clipStart(clip, times), frameEnd };
}

/** An error's spread over the steps and cars of a clip: its 95th percentile and its worst. */
export interface Spread {
  p95: number;
  max: number;
}

/** How far a replay strays from the sim that recorded it: every car of the clip, every step of it. */
export interface Agreement {
  /** Steps compared. */
  steps: number;
  /** Position (m), velocity (m/s) and total crush (m) errors. */
  pose: Spread;
  vel: Spread;
  crush: Spread;
  /** Car-steps with a wreck state the replay's lacks, or the other way about. */
  wreckMismatch: number;
}

function spread(errors: number[]): Spread {
  errors.sort((a, b) => a - b);
  return { p95: errors[Math.floor(0.95 * (errors.length - 1))] ?? 0, max: errors[errors.length - 1] ?? 0 };
}

/**
 * `rec`'s clip re-simulated as the reel plays it at 1x (the engine skins its cars once per frame, after the same steps
 * the live sim's frames ended on: `updateSkin`), each step's end state against the live sim's state at the next step's
 * start. A car put on a spot at that boundary (a respawn, a police wake: the clip's later keyframes, or past the clip's
 * end) is skipped there: the live state read is already the placed one, and its next step is compared. `resetProps` clears the scene's props first.
 */
export function agreement(rec: Recording, resetProps: () => void = () => {}): Agreement {
  const { clip } = rec;
  const cars = clip.cars.map((c) => rec.cars[c.slot]!);
  const sim = new ClipSim(clip, cars, rec.scene);
  resetProps();
  sim.restart();
  let steps = 0;
  let wreckMismatch = 0;
  const pose: number[] = [];
  const vel: number[] = [];
  const crushes: number[] = [];
  const replay = new Float64Array(rec.cars.length * STATE);
  while (!sim.done) {
    sim.advanceTo(sim.time + 1e-6);
    if (rec.frameEnd[rec.s0 + sim.step - 1]) for (const car of cars) car.updateSkin();
    const live = rec.trace[rec.s0 + sim.step];
    if (!live) break;
    capture(rec.cars, replay);
    steps++;
    const before = rec.trace[rec.s0 + sim.step - 1]!;
    for (const { slot } of clip.cars) {
      const o = slot * STATE;
      if (live[o + 8] !== before[o + 8]) continue;
      pose.push(Math.hypot(replay[o]! - live[o]!, replay[o + 1]! - live[o + 1]!, replay[o + 2]! - live[o + 2]!));
      vel.push(Math.hypot(replay[o + 3]! - live[o + 3]!, replay[o + 4]! - live[o + 4]!, replay[o + 5]! - live[o + 5]!));
      crushes.push(Math.abs(replay[o + 6]! - live[o + 6]!));
      if (replay[o + 7] !== live[o + 7]) wreckMismatch++;
    }
  }
  return { steps, wreckMismatch, pose: spread(pose), vel: spread(vel), crush: spread(crushes) };
}

/** A seeded race to record as the engine runs it (`recordField`). */
export interface Field {
  options: Partial<RaceOptions>;
  seed: number;
  /** Runs ahead of each rendered frame `n` (the race's script: a human at the wheel, a car put on a spot). */
  before?: (n: number) => void;
  /** The race stops being run once this holds (checked ahead of each frame), or after `maxFrames`. */
  done: () => boolean;
  maxFrames: number;
}

/**
 * A seeded race run frame by frame, and every clip its recorder kept, each through the codec (what a peer or a saved copy
 * replays) and set against the one live trace: a `Recording` per clip, best first.
 */
export function recordField(w: World, f: Field): Recording[] {
  const r = w.race;
  r.command({ type: "quit" });
  r.command({ type: "options", options: f.options });
  r.reseed(f.seed);
  w.ejections.length = 0;
  r.command({ type: "start" });
  w.seat.mode = "follow";
  const trace: Float64Array[] = [];
  const times = new Map<number, number>();
  const frameEnd: boolean[] = [];
  const rec = r.recorder;
  const startStep = rec.startStep.bind(rec);
  rec.startStep = (cars) => {
    const step = rec["step"];
    // The recorder stops counting at the race's finish, but the frame's remaining steps still run: the first capture of an index is the state the clip's last step left.
    if (trace[step]) return startStep(cars);
    trace[step] = new Float64Array(cars.length * STATE);
    capture(cars, trace[step]!);
    times.set(step, rec.now);
    startStep(cars);
  };
  const state = { acc: 0 };
  try {
    for (let n = 0; n < f.maxFrames && !f.done() && r.phase !== "finished"; n++) {
      f.before?.(n);
      frame(w, state);
      frameEnd[rec["step"] - 1] = true;
    }
    rec.end();
  } finally {
    rec.startStep = startStep;
  }
  const L = carLayout(w.cars[0]!);
  const scene: ReplayScene = { dress: w.dress, collide: (car, slot, h) => r.courseHit(car, slot, h), restore: (slot, mem, at) => r.remember(slot, mem, at), knocks: (bits) => r.knockTo(bits), bounce: undefined };
  return rec.ledger.kept.map((kept) => {
    const wr = new Writer(clipBytes(kept));
    writeClip(wr, kept);
    assert.equal(wr.off, clipBytes(kept), "clipBytes is the exact size");
    const clip = readClip(new Reader().reset(wr.done()), L);
    return { clip, cars: w.cars, scene, trace, s0: clipStart(clip, times), frameEnd };
  });
}
