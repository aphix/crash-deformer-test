import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { RigidBody } from "@dimforge/rapier3d";
import { makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { holdForThrow, impactScale, PRE_IMPACT_LEAD, THROW_ONSET, type PhaseClock } from "../match/phase.ts";
import type { DRIVER_CARS } from "../match/types.ts";
import { JerseyBarrier } from "../scenes/engine-props.ts";
import { RANGE } from "../scenes/range.ts";
import { DeformableCar } from "../vehicle/car.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { paint } from "../vehicle/test-support.ts";
import { armKill, assignClass, HANDLING, killClass } from "../vehicle/vehicle-classes.ts";
import { activeGround, setGround } from "../world/ground.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { PARTS } from "./ragdoll-body.ts";
import { stream } from "./ragdoll-pose.test-util.ts";
import { throwComing } from "./ragdoll-trigger.ts";

/** One car type of the setup menu (`DRIVER_CARS`): a class on its body. */
export type DriverCar = (typeof DRIVER_CARS)[number];

/** The thrown dummy after one engine frame: every part's centre, rotation, linear and angular velocity (world), torso first. */
export type Frame = {
  /** Sim seconds since release (`Doll.age`) and wall seconds since release. */
  age: number;
  wall: number;
  p: Float64Array;
  q: Float64Array;
  v: Float64Array;
  w: Float64Array;
  /** Contacts (within `TOUCH` m) of his parts with the terrain's colliders, and with anything else but his own parts (a car's or the barrier's proxy, a floor nobody built). */
  ground: number;
  foreign: number;
};

/** A vector in the run-up's frame: along the car's pre-impact travel, up, and to its side (run-up × up, so +x travel has +z side). */
export type Carry = { fwd: number; up: number; side: number };

export type RangeThrow = {
  /** Ejection events the sim raised (each launches a dummy), and the most dummies out at once: one throw is 1 and 1. */
  ejections: number;
  peakLive: number;
  /** The run-up: the car's flat travel direction (unit, world) before the crash. What "forward" means. The crash may yaw the car; `heading` is its heading as the throw was judged. */
  runUp: THREE.Vector3;
  heading: THREE.Vector3;
  /** The torso centre the instant the dummy was released, and its velocity then and after the first Rapier step. */
  exit: THREE.Vector3;
  release: THREE.Vector3;
  first: THREE.Vector3 | null;
  /** Every engine frame the (first) dummy was live. */
  frames: Frame[];
  /** The car's engine health at the end. */
  health: number;
  /** Sim seconds the dummy lived before the engine took him away (`LIFE`), null while he was still there at the end. */
  gone: number | null;
};

/** A deliberate fault, so a test can show its property able to fail. */
export type Control = {
  /** Edits a throw's event before the dummy is made from it. */
  event?: (e: Ejection, runUp: THREE.Vector3) => void;
  /** Runs once right after the (first) dummy is released, with the car and the event that threw him. */
  released?: (sys: RagdollSystem, car: DeformableCar, e: Ejection) => void;
  /** Runs after every engine frame the dummy is live. */
  frame?: (sys: RagdollSystem, bodies: readonly RigidBody[]) => void;
};

/** Wall seconds a run may last; wall seconds after the hit with nobody thrown before it is called a no-throw. */
const WALL_MAX = 60;
const NO_THROW_AFTER = 8;
/** A part within this (m) of a collider touches it. */
const TOUCH = 0.02;

/**
 * A display's frame times (s): `hz` steady, or with a `seed` each frame 0.5–1.5× as long (the browser's jitter), and
 * with `hitches` one frame in 50 a further 4× (a stall: the owner's 240 Hz display, one such run once landed 58 m out).
 */
export function displayFrames(hz: number, seed = 0, hitches = false): () => number {
  const rand = stream(seed);
  return seed === 0 ? () => 1 / hz : () => (0.5 + rand() + (hitches && rand() < 0.02 ? 4 : 0)) / hz;
}

/** The engine's `buildCar(0)` and `dressCar` for car type `type` at the HUD's defaults: slot 0 of the range, its kill limits armed for the default realism. */
export function rangeCar(type: DriverCar): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, type.style);
  assignClass(car, type.cls);
  car.group.userData.carIndex = 0;
  car.deform.squash = INITIAL_HUD.squash;
  car.deform.buckle = INITIAL_HUD.buckle;
  car.deform.setMode(INITIAL_HUD.deformMode);
  armKill(car.deform, killClass(car), HANDLING.realism, "default");
  return car;
}

/** `CrashEngine.maybePreSlowmo` for the range's one car: a coming throw holds the slow-mo back for the exit (`THROW_ONSET`), any other hit slows at once. */
function preSlowmo(c: PhaseClock, car: DeformableCar, barrier: JerseyBarrier, wallDt: number): void {
  const scale = impactScale(c);
  if (c.userTimeScale != null || c.phase !== "approach" || c.timeScale <= scale * 1.2 || c.slomoAt > 0) return;
  car.refreshBasis();
  const eta = barrier.contactEta([car], Number.POSITIVE_INFINITY);
  if (!Number.isFinite(eta) || eta > Math.max(PRE_IMPACT_LEAD, wallDt + 1 / 60)) return;
  if (throwComing([car], barrier)) {
    c.slomoAt = THROW_ONSET;
    return;
  }
  c.timeScale = scale;
  c.targetScale = scale;
}

type Doll = RagdollSystem["dolls"][number];

/** How many contacts his parts have with the terrain's colliders (`statics`, his own `patch`), and with anything else but themselves. */
function contacts(sys: RagdollSystem, d: Doll): { ground: number; foreign: number } {
  const world = sys["world"]!;
  const terrain = new Set([...sys["statics"], ...d.patch].map((c) => c.handle));
  const own = new Set(d.bodies.map((b) => b.collider(0).handle));
  const n = { ground: 0, foreign: 0 };
  for (const b of d.bodies) {
    const c = b.collider(0);
    world.contactPairsWith(c, (other) => {
      if (own.has(other.handle)) return;
      world.contactPair(c, other, (m) => {
        for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < TOUCH) n[terrain.has(other.handle) ? "ground" : "foreign"]++;
      });
    });
  }
  return n;
}

function sample(sys: RagdollSystem, d: Doll, wall: number): Frame {
  const n = PARTS.length;
  const f: Frame = { age: d.age, wall, p: new Float64Array(n * 3), q: new Float64Array(n * 4), v: new Float64Array(n * 3), w: new Float64Array(n * 3), ...contacts(sys, d) };
  for (const [k, b] of d.bodies.entries()) {
    const t = b.translation();
    const r = b.rotation();
    const v = b.linvel();
    const w = b.angvel();
    f.p.set([t.x, t.y, t.z], k * 3);
    f.q.set([r.x, r.y, r.z, r.w], k * 4);
    f.v.set([v.x, v.y, v.z], k * 3);
    f.w.set([w.x, w.y, w.z], k * 3);
  }
  return f;
}

/**
 * The ejection range as the engine runs it at its defaults (`spawnRange`): a car of `type` at `RANGE.kph`, `RANGE.run` m
 * back from the real jersey barrier (free to slide), the HUD's squash, buckle, shape mode and default realism, on the
 * range's flat ground and sand. One engine frame (`frameDt` wall seconds) is the step the engine takes (`tickWorld`:
 * slices, pair contact, the phase clock, `EjectionWatch`), the barrier's own step, then the ragdolls' update, with the
 * auto slow-mo (`maybePreSlowmo`, `holdForThrow`). Every ejection event launches its dummy (`RagdollSystem.launch`);
 * what is read is the Rapier bodies of the first. Runs on until he is gone (`LIFE`), or `NO_THROW_AFTER` wall seconds
 * after a hit that threw nobody. The camera and the cinematic time warp feed nothing back into the sim, so they are
 * left out.
 */
export async function rangeThrow(type: DriverCar, control: Control = {}, frameDt: () => number = displayFrames(60)): Promise<RangeThrow> {
  setGround(null);
  const car = rangeCar(type);
  car.spawnFacing(-RANGE.run, 0, Math.PI / 2, RANGE.kph / 3.6);
  const barrier = new JerseyBarrier(new THREE.Scene(), new THREE.Group());
  barrier.orient(car.group.position, false);
  const w = makeWorld([car], false, true);
  w.world.barrier = barrier;
  const sys = new RagdollSystem(new THREE.Scene(), () => holdForThrow(w.clock), () => {});
  await sys.preload();
  sys.sand = true;

  const out: RangeThrow = {
    ejections: 0,
    peakLive: 0,
    runUp: new THREE.Vector3(car.velocity.x, 0, car.velocity.z).normalize(),
    heading: new THREE.Vector3(),
    exit: new THREE.Vector3(),
    release: new THREE.Vector3(),
    first: null,
    frames: [],
    health: 1,
    gone: null,
  };
  const dir = new THREE.Vector3();
  let mine = null as Doll | null;
  let wall0 = -1;
  let wall = 0;
  w.onEject = (e) => {
    out.ejections++;
    car.group.getWorldDirection(dir);
    control.event?.(e, out.runUp);
    sys.launch(e, [car]);
    if (mine) return;
    mine = sys["dolls"].find((d) => d.live)!;
    wall0 = wall;
    out.heading.set(dir.x, 0, dir.z).normalize();
    const t = mine.bodies[0]!.translation();
    const v = mine.bodies[0]!.linvel();
    out.exit.set(t.x, t.y, t.z);
    out.release.set(v.x, v.y, v.z);
    // Rapier's first step after the release, read before anything else touches him.
    const world = sys["world"]!;
    const first = mine;
    const step = world.step.bind(world);
    world.step = (...args: Parameters<typeof step>) => {
      step(...args);
      world.step = step;
      const u = first.bodies[0]!.linvel();
      out.first = new THREE.Vector3(u.x, u.y, u.z);
    };
    control.released?.(sys, car, e);
  };

  for (let dt = frameDt(); wall < WALL_MAX; wall += dt, dt = frameDt()) {
    preSlowmo(w.clock, car, barrier, dt);
    tickWorld(w, dt);
    const simDt = dt * w.clock.timeScale;
    barrier.step(simDt);
    sys.update(simDt, [car], true, true, 0, barrier.group);
    out.peakLive = Math.max(out.peakLive, sys["live"]);
    if (!mine || !mine.live) {
      if (mine) {
        out.gone = out.frames.at(-1)?.age ?? 0;
        break;
      }
      if (w.clock.phase !== "approach" && w.clock.wallSinceImpact > NO_THROW_AFTER) break;
      continue;
    }
    control.frame?.(sys, mine.bodies);
    out.frames.push(sample(sys, mine, wall - wall0));
  }
  out.health = car.deform.drivetrainHealth;
  sys.dispose();
  car.dispose();
  return out;
}

/** `v` (world) in the frame of run-up direction `runUp`. */
export function inCar(v: THREE.Vector3Like, runUp: THREE.Vector3): Carry {
  return { fwd: v.x * runUp.x + v.z * runUp.z, up: v.y, side: v.z * runUp.x - v.x * runUp.z };
}

/** What stillness means: part speeds under `v` m/s and `w` rad/s, parts moved less than `x` m and turned less than `r` rad from where the window began, for `window` sim seconds. */
export const STILL = { v: 0.05, w: 0.2, x: 0.02, r: 0.05, window: 1 };

const _a = new THREE.Quaternion();
const _b = new THREE.Quaternion();

/** The whole dummy at frame `f` against frame `g`: the largest part-centre move (m) and part turn (rad). */
function drift(f: Frame, g: Frame): { x: number; r: number } {
  let x = 0;
  let r = 0;
  for (let k = 0; k < PARTS.length; k++) {
    x = Math.max(x, Math.hypot(f.p[3 * k]! - g.p[3 * k]!, f.p[3 * k + 1]! - g.p[3 * k + 1]!, f.p[3 * k + 2]! - g.p[3 * k + 2]!));
    _a.fromArray(f.q, 4 * k);
    _b.fromArray(g.q, 4 * k);
    r = Math.max(r, _a.angleTo(_b));
  }
  return { x, r };
}

/** The fastest part's linear (m/s) and angular (rad/s) speed at frame `f`. */
export function speeds(f: Frame): { v: number; w: number } {
  let v = 0;
  let w = 0;
  for (let k = 0; k < PARTS.length; k++) {
    v = Math.max(v, Math.hypot(f.v[3 * k]!, f.v[3 * k + 1]!, f.v[3 * k + 2]!));
    w = Math.max(w, Math.hypot(f.w[3 * k]!, f.w[3 * k + 1]!, f.w[3 * k + 2]!));
  }
  return { v, w };
}

/** Part `k`'s lowest point at frame `f` above the terrain's height under it (m): its centre less the box's reach down through its rotation. */
function partLow(f: Frame, k: number): number {
  const x = f.q[4 * k]!;
  const y = f.q[4 * k + 1]!;
  const z = f.q[4 * k + 2]!;
  const w = f.q[4 * k + 3]!;
  const h = PARTS[k]!.h;
  const low = f.p[3 * k + 1]! - (h[0] * Math.abs(2 * (x * y + w * z)) + h[1] * Math.abs(1 - 2 * (x * x + z * z)) + h[2] * Math.abs(2 * (y * z - w * x)));
  return low - activeGround().heightAt(f.p[3 * k]!, f.p[3 * k + 2]!, f.p[3 * k + 1]!);
}

/** The dummy's lowest body at frame `f`: how far its lowest point is above the terrain there (m; negative is in it). */
export function lowest(f: Frame): number {
  let low = Infinity;
  for (let k = 0; k < PARTS.length; k++) low = Math.min(low, partLow(f, k));
  return low;
}

/** Where a still dummy comes to rest. */
export type Rest = {
  /** Index of the first frame of the first window of `STILL.window` sim s in which every part is still, or -1. */
  at: number;
  /** Largest part speed (m/s, rad/s) and part drift (m, rad) from frame `at` over every frame from there to the end of his life (with no rest: over the longest candidate). */
  v: number;
  w: number;
  x: number;
  r: number;
  /** His lowest body over every frame from `at` on (m above the terrain): the lowest and the highest of them. */
  floor: [number, number];
  /** Over every frame from `at` on: the fewest terrain contacts, and the most contacts with anything else (a car, the barrier). */
  ground: number;
  foreign: number;
};

const blank = (at: number): Rest => ({ at, v: 0, w: 0, x: 0, r: 0, floor: [Infinity, -Infinity], ground: Infinity, foreign: 0 });

/**
 * The first moment from which the whole dummy stays still: from frame `at` to the end of his life, every part under
 * `STILL.v` and `STILL.w` and no part moved more than `STILL.x` / turned more than `STILL.r` from frame `at`, with at
 * least `STILL.window` sim seconds of life left. Rapier reports a sleeping body's velocity as zero, so the drift of the
 * poses is judged too.
 */
export function restOf(frames: readonly Frame[]): Rest {
  for (let i = 0; i < frames.length; i++) {
    const f0 = frames[i]!;
    if (frames.at(-1)!.age - f0.age < STILL.window) break;
    const run = blank(i);
    for (let j = i; j < frames.length; j++) {
      const s = speeds(frames[j]!);
      const d = drift(f0, frames[j]!);
      const low = lowest(frames[j]!);
      run.v = Math.max(run.v, s.v);
      run.w = Math.max(run.w, s.w);
      run.x = Math.max(run.x, d.x);
      run.r = Math.max(run.r, d.r);
      run.floor = [Math.min(run.floor[0], low), Math.max(run.floor[1], low)];
      run.ground = Math.min(run.ground, frames[j]!.ground);
      run.foreign = Math.max(run.foreign, frames[j]!.foreign);
      if (run.v >= STILL.v || run.w >= STILL.w || run.x >= STILL.x || run.r >= STILL.r) break;
      if (j === frames.length - 1) return run;
    }
  }
  return blank(-1);
}

/** Index of the frame at the peak of the torso (the highest his torso centre gets). */
export function apexOf(frames: readonly Frame[]): number {
  let at = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i]!.p[1]! > frames[at]!.p[1]!) at = i;
  return at;
}

/** The torso centre of frame `f` less `from`, in the run-up's frame. */
export function travel(f: Frame, from: THREE.Vector3, runUp: THREE.Vector3): Carry {
  return inCar({ x: f.p[0]! - from.x, y: f.p[1]! - from.y, z: f.p[2]! - from.z }, runUp);
}

/** The lowest any part gets over every frame of the dummy's life (m above the terrain; negative is in it). */
export function deepest(frames: readonly Frame[]): number {
  return frames.reduce((low, f) => Math.min(low, lowest(f)), Infinity);
}
