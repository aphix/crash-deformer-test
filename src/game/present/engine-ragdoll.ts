/*
 * Thrown-driver ragdolls: a cosmetic crash-test dummy flung out through the windshield or a front side window
 * when one hit disables a car (`EjectionWatch`). Its own Rapier world (@dimforge/rapier3d-simd, Apache-2.0):
 * ground and walls are fixed colliders around the throw, every car near a dummy (`near`; and the sandbox's
 * jersey barrier) a kinematic box that follows its pose, so cars push dummies and nothing pushes back; no dummy state reaches the sim or the
 * netplay snapshots. The camera may ride along with the latest dummy's head (`follow`, `frameCamera`).
 *
 * The jointed body (ten boxes on spherical joints: head, torso, upper and lower arms, thighs, shins) follows the
 * approach of Matthias von Bargen's rapierjs-ragdoll (https://github.com/mattvb91/rapierjs-ragdoll, MIT License,
 * Copyright (c) Matthias von Bargen), rewritten for this engine: one instanced mesh, pooled bodies, no model.
 * The MIT License: Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following
 * conditions: The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import * as THREE from "three";
import type { Collider, World } from "@dimforge/rapier3d-simd";
import type { DeformableCar } from "../vehicle/car.ts";
import { activeGround, type Ground } from "../world/ground.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import type { Track } from "../world/track.ts";
import type { Placed } from "../world/placements.ts";
import { ejectionVelocity, type Ejection } from "../vehicle/ejection.ts";
import { disable, loadRapier, type Rapier } from "../kernel/rapier.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { type DriverLook, driverLook, pickedLook } from "./driver-look.ts";
import type { PersonPick } from "../match/look-data.ts";
import type { SprayBitmap } from "./spray.ts";
import { Purses } from "./ragdoll-purse.ts";
import { CAR_BOX, type PropDraw, PropBodies } from "./ragdoll-props.ts";
import { CarProxies, DOLL_REACH, NEAR_HOLD, NEAR_MARGIN, PROP_BAND_HIGH, PROP_BAND_LOW, PURSE_REACH } from "./ragdoll-cars.ts";
import type { RagCar } from "./ragdoll-car-view.ts";
import { dollGroups, FIXED_GROUPS, knockedGroups, MAX_ACC, propGroups, SLOTS, STEP, thrownGroups } from "./ragdoll-config.ts";
import { RagdollDebug } from "./ragdoll-debug.ts";
import { RagdollRemote } from "./ragdoll-remote.ts";
import { RideAlong } from "./ragdoll-ride.ts";
import type { RideFrame } from "./ride-cam.ts";
import type { Sight } from "./spectate-cam.ts";
import { AIR_ANGULAR, AIR_LINEAR, ARM, blendPose, CALM_FOR, type Doll, GROUND_ANGULAR, GROUND_LINEAR, give, isCalm, JOINTS, limit, PARTS, readPose, SETTLE_AFTER, SETTLE_ANGULAR, SETTLE_LINEAR, SHOULDER_Y } from "./ragdoll-body.ts";
import { joinUp } from "./ragdoll-joints.ts";
import { groundColliders, PATCH_AHEAD, PATCH_HALF, type Pole } from "./ragdoll-ground.ts";
import { courseSolids, type Solid } from "./ragdoll-solids.ts";
import { hypot2, hypot3 } from "../kernel/physics-core.js";
import { GRAVITY } from "../kernel/constants.ts";
import { DOLL_CAR, DOLL_FLOATS, DOLL_HEADER, DOLL_LIVE, DOLL_RIDES, DOLL_SETTLED, DOLL_STILL, DOLL_VELOCITY, FIT_AHEAD, PROP_FLOATS, type ResultMessage } from "./ragdoll-wire.ts";

/** Seconds a dummy lies about before it goes. */
const LIFE = 10;
/** Seconds after the throw the dummy ignores its own car and the other dummies (`thrownGroups`): it starts inside its own cabin, over its own lower box. */
const GRACE = 0.35;
/** Dummy friction against anything (the lower of the pair counts): low, so it slides a good way (owner, 2026-10-02). */
const SLIDE = 0.12;
/** Torso speed (m/s) under which a dummy counts as lying still. */
const REST_SPEED = 0.4;
/**
 * Sim seconds a throw judged before Rapier is in may wait for it; later it is dropped (a dummy out of a car that
 * stopped a second ago reads as a glitch). Rapier lands 0.45 s after `ready` in a production build, a fleet's
 * first hit 1–2 s after it.
 */
const PENDING_MAX = 1;
/** The step (sim s) while knocked props alone are out and none moves fast: rigid shapes with no joints to tear, with CCD (`PropBodies`) for the walls a coarser step would get wrong. */
const PROP_STEP = 1 / 120;
/**
 * A knocked prop any point of whose shape moves faster than this (m/s: its middle's speed plus its turn times its reach)
 * keeps the world at `STEP`: at 1/120 a spinning cone flung at 31 m/s landed with its tip 110 mm in the ground. Deepest
 * lowest point over 80 run-overs of a lying cone at 10-40 m/s: 110.8 mm at 1/120, 50.4 with this at 12 m/s, 22.8 at 8,
 * 23.0 at 1/480 throughout.
 */
const PROP_FAST = 8;
/** The skin's hits, the spin limit and the purses are judged at this interval (sim s) whatever `STEP` is: `HIT_DV` is a speed change per interval. */
const WATCH = 1 / 120;
const WATCH_EVERY = Math.round(WATCH / STEP);
/** A car moving faster than this (m/s) and this near (m) to a dummy that lies asleep keeps the world stepping (a car moves 1.2 m a frame at 70 m/s; a wreck lying beside him does not); the barrier's reach is its half diagonal. A sleeping knocked prop is stirred only by such a car that can touch it this frame (`PropBodies.touches`). */
const WAKE_SPEED = 0.5;
const WAKE_NEAR = 10;
const BARRIER_REACH = hypot2(BARRIER_HALF.x, BARRIER_HALF.z);
/** Rapier's solver iterations (default 4); no CCD on the parts (it tears the joints: 11–28 cm apart vs 0.9 cm at 8 iterations of 1/120). At 1/960 four hold a joint to 0.1 cm; two kicked one to 125 rad/s. */
const ITERATIONS = 4;
/** Rapier's internal solver passes per iteration (default 1): at the first touch of a 29 m/s throw one pass rose energy 75–325 J in a frame at 1/120 and 26–30 J (1 of 5 runs) at 1/480 and 1/960; two at most 0.6 J over 60 runs (60/144/240 Hz). */
const INTERNAL_PASSES = 2;

/** A throw, placed: car (-1: none, `place`), torso point and orientation, linear and angular velocity (world), sim seconds waiting, a police driver, whether the ride-along may frame him, whether his purse flies too (unset: when his look is a woman's). */
export type Throw = { car: number; p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; w: THREE.Vector3; age: number; cop: boolean; rides: boolean; purse?: boolean };

/** What a dummy sent to the worker looks like, applied (`mesh.dress`, `spray`, `Purses.paint`) once the worker says which slot he took. */
type Dressing = { cop: boolean; look: DriverLook; spray: SprayBitmap | null; purse: boolean; car: number; seed: number };

const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const _arm = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c = new THREE.Vector3();
const _cq = new THREE.Quaternion();
const _v = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };
const Y = new THREE.Vector3(0, 1, 0);
const _w = new THREE.Vector3();

/**
 * A part whose velocity jumps by this much (m/s) in one step has hit something (gravity adds 0.08 per step): the skin
 * gives once at its first step (`hits`). Rapier's contact events say the same, but `drainCollisionEvents` passes a JS
 * closure through the wasm, and Vite's dev server serves the package's glue module twice (the closure's slot is not in
 * the other copy's table): every step then throws "reading 'memory'" and the dummy never lands (measured in the
 * browser; a production build has one copy).
 */
export const HIT_DV = 4;
/** His torso centre this near (m) the ground: he has touched down (lying, it rests at 0.1–0.3 m; thrown, it is over 0.5 m). */
export const GROUND_REACH = 0.45;

/** `world.step()` timings kept (the newest): a 30 s window steps the world at most a few thousand times. */
const STEP_LOG = 8192;

/** The cosmetic world's cost so far: `world.step()` calls, the ring of their wall ms (the call `n` is at `log[n % log.length]`), the world's size. */
export interface RagdollStats {
  steps: number;
  log: Float64Array;
  colliders: number;
  bodies: number;
}

export class RagdollSystem {
  /** The sandbox's lamp posts: the standing ones are fixed colliders in the run's statics (set by the engine). */
  poles: readonly Pole[] = [];
  /**
   * The solids a throw collides with while `ground` is the active one: a race course's walls and solids (`setCourse`), or a
   * scene's own (`setSolids`, no track).
   */
  private course: { ground: Ground; track: Track | null; placed: readonly Placed[] } | null = null;
  /** The course's `courseSolids` (built at its first throw), or the scene's own. */
  private solids: readonly Solid[] | null = null;
  /** The flat ground is the range's sand pit (`SAND`), read when a run's first throw builds it (set by the engine). */
  sand = false;
  private readonly mesh: DummyMesh;
  /** The HUD's Rig and Particles views of the dummies (`set`). */
  readonly debug: RagdollDebug;
  private readonly onThrow: (car: number) => void;
  /** The look seed (`driverLook`) the engine sets each frame: a driver keeps his tee and hair through a race. */
  lookSeed = 0;
  /** A player's own driver for car `car` (the engine's looks: this browser's, or a netplay peer's), null for a drawn one. */
  lookOf: (car: number) => { person: PersonPick; personSpray: SprayBitmap } | null = () => null;
  private purses: Purses | null = null;
  /** The course's or the scene's knockable props: standing fixed on their spots, knocked ones tumbling (`knockProp`); a car's front meets one over its lower box's height. */
  private readonly props = new PropBodies(knockedGroups, FIXED_GROUPS, GRACE, PROP_BAND_LOW, PROP_BAND_HIGH, (cx, cz, y, half) => this.patchAt(cx, cz, y, half));
  private readonly onExit: (at: THREE.Vector3, frame: THREE.Quaternion, inherit: THREE.Vector3) => void;
  private R: Rapier | null = null;
  private world: World | null = null;
  /** `world.step()` calls so far and the wall ms of the latest `STEP_LOG` of them (`stats`): what the bench reads, nothing else does. In the worker's world they are the worker's, as it reports them. */
  private steps = 0;
  private readonly stepMs = new Float64Array(STEP_LOG);
  private readonly remoteSize = { colliders: 0, bodies: 0 };
  /** The Rapier world's cost so far (`RagdollStats`): steps run, their ms ring, and how many colliders and bodies the world holds. */
  get stats(): RagdollStats {
    if (this.mode === "remote") return { steps: this.steps, log: this.stepMs, ...this.remoteSize };
    return { steps: this.steps, log: this.stepMs, colliders: this.world?.colliders.len() ?? 0, bodies: this.world?.bodies.len() ?? 0 };
  }
  private readonly dolls: Doll[] = [];
  private live = 0;
  /** Throws judged before Rapier was in (`PENDING_MAX`). */
  private readonly pending: Throw[] = [];
  private readonly next: Throw = { car: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false, rides: true };
  /** Fixed colliders every dummy shares off a course (pad or disc with its ramps, corkscrew, poles), built at the run's first throw: Rapier's step allocates per collider (0.31 KB, RapierEval). */
  private readonly statics: Collider[] = [];
  private disposed = false;
  /** The world's worker (null: none, or it failed). */
  private remote: RagdollRemote | null = null;
  /** Where this run's dummies are, chosen at its first throw or knock (`pick`): this thread's world or the worker's. Null: not yet. */
  private mode: "inline" | "remote" | null = null;
  /** The course's props as drawn (`setCourse`): where the worker's world has them, `adopt` places them. */
  private tumble: PropDraw | null = null;
  /** How each throw sent to the worker is dressed, until the worker says which slot it took (`adopt`). */
  private readonly dressing = new Map<number, Dressing>();
  /** This system is the world's worker's (`host`): it draws nothing and reports the cars it `wanted` cages of. */
  private hosted = false;
  /** Per car, 1 when a dummy, purse thing or knocked prop may reach it within `FIT_AHEAD` frames (set by `stepWorld` while hosted). */
  readonly wanted = new Uint8Array(MAX_CARS);
  private cars: readonly DeformableCar[] = [];
  private authority = true;
  /** Neither a race nor a derby: only here does `onThrow` fire. */
  private sandbox = true;
  /** Sim seconds the world has not stepped yet (under a step after each frame), and how far into the next step the draw is; the step of the frame that last stepped (`STEP` with a dummy out, else `PROP_STEP`). */
  private acc = 0;
  private step = STEP;
  /** Steps since the first dummy out: every `WATCH_EVERY`th one the skin, spin limit and purses are watched. */
  private tick = 0;
  private alpha = 0;
  /** The last frame stepped nothing (`dormant`), so the proxies are where the cars were when it began. */
  private slept = false;
  /** Each part's velocity at the end of the last step, and a flag (0 none, 1 hit last step, 3 just spawned), 4 numbers per part per slot: `hits`. */
  private readonly vel = new Float32Array(SLOTS * PARTS.length * 4);
  private lastSlot = 0;
  /** The cars' proxies in the dummies' world. */
  private readonly proxies = new CarProxies(this.dolls);
  /** The ride-along camera over the dummies (`follow`, `frameCamera`). */
  private readonly ride = new RideAlong();

  /**
   * `onThrow(car)`: a sandbox driver just left car `car` (the engine decides whether the camera follows).
   * `onExit(at, frame, inherit)`: any driver is being thrown; his way out is centred on `at`, `frame`'s z out of the
   * pane, and his car moves at `inherit` (the engine covers it with a burst).
   */
  constructor(scene: THREE.Scene, onThrow: (car: number) => void, onExit: (at: THREE.Vector3, frame: THREE.Quaternion, inherit: THREE.Vector3) => void) {
    this.onThrow = onThrow;
    this.onExit = onExit;
    this.mesh = new DummyMesh(SLOTS);
    this.debug = new RagdollDebug(scene, PARTS, JOINTS, SLOTS);
    this.mesh.name = "ragdolls";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    // Shown only while a dummy is out; the boot warm-up draws hidden meshes too, so its programs link there.
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Start Rapier (`loadRapier`), build the pool and run one step so the first throw only places bodies. The
   * engine calls this once boot is `ready`; until it resolves `update` only judges hits (`pending`). The world's worker
   * (`RagdollRemote`) starts beside it, where the browser has Workers.
   */
  async preload(): Promise<void> {
    if (!this.hosted) this.remote ??= RagdollRemote.open((err) => this.fallBack(err));
    const R = await loadRapier();
    if (this.disposed) return;
    this.R = R;
    const world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world = world;
    world.timestep = STEP;
    world.numSolverIterations = ITERATIONS;
    world.integrationParameters.numInternalPgsIterations = INTERNAL_PASSES;
    this.proxies.load(R, world);
    for (let s = 0; s < SLOTS; s++) {
      const bodies = PARTS.map((p) => {
        const body = world.createRigidBody(
          R.RigidBodyDesc.dynamic().setTranslation(p.c[0], p.c[1] - 200, p.c[2]).setLinearDamping(AIR_LINEAR).setAngularDamping(AIR_ANGULAR).setEnabled(false),
        );
        world.createCollider(
          R.ColliderDesc.cuboid(p.h[0], p.h[1], p.h[2])
            .setDensity(1000)
            .setFriction(SLIDE)
            .setFrictionCombineRule(R.CoefficientCombineRule.Min)
            .setRestitution(0)
            .setRestitutionCombineRule(R.CoefficientCombineRule.Min)
            .setCollisionGroups(dollGroups(s)),
          body,
        );
        return body;
      });
      joinUp(R, world, bodies);
      this.dolls.push({ bodies, live: false, age: 0, life: LIFE, still: 0, patch: [], car: -1, rides: false, prev: new Float32Array(PARTS.length * 7), cur: new Float32Array(PARTS.length * 7), ground: false, settled: false, calm: 0, speed: 0, vel: new Float32Array(3) });
    }
    // A child of the dummies' mesh, so the scene root keeps its one `ragdolls` child and the props draw only while a dummy is out.
    this.mesh.add((this.purses = this.proxies.purses = new Purses(R, world, SLOTS, propGroups, GRACE)).mesh);
    this.props.load(R, world);
    // One step with a dummy out, far below the world: links the step path before a crash needs it.
    const d = this.dolls[0]!;
    for (const b of d.bodies) b.setEnabled(true);
    world.step();
    for (const b of d.bodies) disable(b);
  }

  /** A new run: no dummies out, every car's driver back in, every knocked prop back on its spot. */
  reset(): void {
    this.pending.length = 0;
    this.acc = this.tick = 0;
    this.ride.reset();
    this.mode = null;
    this.dressing.clear();
    this.remote?.reset();
    for (let s = 0; s < this.dolls.length; s++) this.despawn(s);
    this.props.clear();
    this.tumble?.reset();
    for (const c of this.statics) this.world?.removeCollider(c, false);
    this.statics.length = 0;
  }

  /**
   * One frame: step the dummies and the knocked props `dt` sim seconds against the cars' poses (`authority`: this peer
   * owns the glass, so it smashes the exit pane of a throw). `sandbox`: neither a race nor a derby (`onThrow`);
   * `barrier`: the sandbox's jersey barrier while it stands, else null. Who
   * is thrown is not decided here (`launch`); a throw launched before Rapier is in waits for it, up to `PENDING_MAX`; a
   * prop knocked before it is in flies once it is. In the worker's world (`mode` "remote") the frame is posted to it instead
   * and the last answer drawn.
   */
  update(dt: number, cars: readonly DeformableCar[], authority: boolean, sandbox: boolean, barrier: THREE.Object3D | null): void {
    if (dt <= 0) return;
    this.cars = cars;
    this.authority = authority;
    this.sandbox = sandbox;
    if (this.mode === "remote") this.updateRemote(dt, cars);
    else this.stepWorld(dt, cars, authority, sandbox, barrier);
  }

  /** The frame's physics and its draw, here: what `update` does in this thread and the world's worker does for each posted frame. */
  stepWorld(dt: number, cars: readonly RagCar[], authority: boolean, sandbox: boolean, barrier: THREE.Object3D | null): void {
    this.authority = authority;
    this.sandbox = sandbox;
    const world = this.world;
    for (const t of this.pending) t.age += dt;
    if (!world) return;
    for (const t of this.pending) if (t.age <= PENDING_MAX) this.spawn(t);
    this.pending.length = 0;
    this.wake();
    this.props.here(this.course !== null && activeGround() === this.course.ground);
    if (this.live === 0 && this.props.count === 0) {
      for (let i = 0; i < MAX_CARS; i++) this.proxies.follow(i, null);
      if (this.hosted) this.wanted.fill(0);
      return;
    }
    const dormant = this.dormant(cars, barrier, dt);
    // The proxies stood still while nothing stepped: jump them to where the cars are now instead of flinging dummies.
    this.proxies.teleport ||= this.slept;
    this.slept = dormant;
    for (let i = 0; i < MAX_CARS; i++) {
      const alive = i < cars.length && !cars[i]!.falling && !cars[i]!.vaporized;
      if (this.hosted) this.wanted[i] = alive && this.near(i, cars[i]!, dt, FIT_AHEAD) ? 1 : 0;
      // In the worker a car whose cage has not been sent has no proxy yet.
      const car = alive && (!this.hosted || cars[i]!.cage !== null) && this.near(i, cars[i]!, dt) ? cars[i]! : null;
      if (car) this.proxies.frame(i, car);
      this.proxies.follow(i, car ? this.proxies.frames[i]! : null);
      if (car) {
        this.proxies.fitProxy(i, car);
        this.proxies.cull(i, cars, false, dt);
      }
      // Its lower box where this frame's steps take it: a knocked prop it would squeeze against a wall lets it by.
      if (car) this.props.press(i, car.group.position, car.group.quaternion, this.proxies.boxes);
    }
    this.proxies.follow(MAX_CARS, barrier);
    this.proxies.teleport = false;
    this.proxies.glassNear(cars, dt);
    // Whole steps out of the accumulator (`STEP` with a dummy out or a knocked prop moving fast, `PROP_STEP` for knocked
    // props alone), each proxy a step further along its frame's path.
    const step = this.live > 0 || this.props.faster(PROP_FAST) ? STEP : PROP_STEP;
    const lead = this.acc;
    this.acc = dormant ? 0 : Math.min(lead + dt, MAX_ACC);
    const steps = Math.floor(this.acc / step + 1e-6);
    if (steps > 0 && step !== this.step) {
      this.step = step;
      world.timestep = step;
    }
    for (let j = 1; j <= steps; j++) {
      this.proxies.move(Math.min(1, (j * step - lead) / dt));
      // One step this frame: the pose before it is the last frame's last (nothing moves a part between steps but a step).
      if (j === steps) {
        for (const d of this.dolls) {
          if (!d.live) continue;
          if (steps === 1) d.prev.set(d.cur);
          else this.capture(d, d.prev);
        }
      }
      if (j === steps) this.purses?.capture(false);
      if (j === steps) this.props.capture(false);
      this.proxies.glassTouch(cars, authority);
      const stepAt = performance.now();
      world.step();
      this.stepMs[this.steps++ % STEP_LOG] = performance.now() - stepAt;
      if (++this.tick % WATCH_EVERY !== 0) continue;
      this.purses?.advance(WATCH_EVERY * STEP);
      for (let s = 0; s < SLOTS; s++) {
        const d = this.dolls[s]!;
        if (!d.live) continue;
        this.hits(s, d);
        limit(d.bodies);
      }
    }
    this.acc = Math.max(0, this.acc - steps * step);
    this.alpha = dormant ? 1 : Math.min(1, this.acc / step);
    if (steps > 0) for (const d of this.dolls) if (d.live) this.capture(d, d.cur);
    if (steps > 0) this.purses?.capture(true);
    if (steps > 0) this.props.capture(true);
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      if (!d.live) continue;
      const before = d.age;
      d.age += dt;
      if (before < GRACE && d.age >= GRACE) for (const b of d.bodies) b.collider(0).setCollisionGroups(dollGroups(s));
      if (d.age > d.life || d.bodies[0]!.translation().y < -30) {
        this.despawn(s);
        continue;
      }
      const v = d.bodies[0]!.linvel();
      d.speed = hypot3(v.x, v.y, v.z);
      d.vel[0] = v.x;
      d.vel[1] = v.y;
      d.vel[2] = v.z;
      d.still = d.speed < REST_SPEED ? d.still + dt : 0;
      this.calm(d, dt);
      if (this.hosted) continue;
      for (let k = 0; k < PARTS.length; k++) {
        this.blend(d, k, _p, _q);
        this.mesh.pose(s, k, _p, _q);
        if (this.debug.on) this.debug.pose(s, k, _p, _q);
      }
    }
    if (!this.hosted) this.purses?.pose(this.alpha);
    this.props.advance(dt, this.step);
    this.props.pose(this.alpha);
  }

  /**
   * Nothing to step: every dummy, purse thing and knocked prop lies asleep; no car moving over `WAKE_SPEED` nor the
   * barrier is within `WAKE_NEAR` of a dummy, no such car can touch a knocked prop this frame (`touches`), and the
   * barrier is not within `WAKE_NEAR` of one.
   */
  private dormant(cars: readonly RagCar[], barrier: THREE.Object3D | null, dt: number): boolean {
    if (this.purses && !this.purses.asleep()) return false;
    if (!this.props.asleep()) return false;
    for (const d of this.dolls) {
      if (!d.live) continue;
      if (!d.bodies[0]!.isSleeping() || this.stirred(_r.set(d.cur[0]!, d.cur[1]!, d.cur[2]!), cars, barrier)) return false;
    }
    if (barrier && this.props.touches(barrier.position, WAKE_NEAR + BARRIER_REACH, 0, 0)) return false;
    for (let i = 0; i < cars.length && i < MAX_CARS; i++) {
      const car = cars[i]!;
      if (!car.falling && !car.vaporized && car.velocity.lengthSq() > WAKE_SPEED ** 2 && this.props.touches(car.group.position, this.proxies.reach[i]!, car.velocity.length(), dt)) return false;
    }
    return true;
  }

  /** Is the barrier, or a car moving over `WAKE_SPEED`, within `WAKE_NEAR` of `p`? */
  private stirred(p: THREE.Vector3, cars: readonly RagCar[], barrier: THREE.Object3D | null): boolean {
    if (barrier && barrier.position.distanceTo(p) < WAKE_NEAR + BARRIER_REACH) return true;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (!car.falling && !car.vaporized && car.velocity.lengthSq() > WAKE_SPEED ** 2 && car.group.position.distanceTo(p) < WAKE_NEAR) return true;
    }
    return false;
  }

  /**
   * Does car `i` need its proxy in the world: a dummy out within `DOLL_REACH` plus `NEAR_MARGIN` and two frames of both their travels
   * of the car's box (`CAR_BOX`; its sphere of `reach` before its first fit), a purse thing within its reach, or a knocked prop it can
   * touch within a frame of `dt` (`touches`)? A proxy already in the world stays until `NEAR_HOLD` m further out. A car that gets in
   * from outside in one frame moved over 4 m, which `CarProxies.follow` teleports for anyway, so the proxy it gets is the one it had.
   * `frames` > 1: whether it will within that many frames (the cars the main thread should send cages of, `FIT_AHEAD`).
   */
  private near(i: number, car: RagCar, dt: number, frames = 1): boolean {
    const { boxes, reach: reaches, whole, on } = this.proxies;
    const p = car.group.position;
    // The props first, as before any dummy: a car that can touch a knocked prop this frame gets its whole proxy (`cull`).
    const touched = this.props.touches(p, reaches[i]!, car.velocity.length(), dt * frames);
    if (frames === 1) whole[i] = touched ? 1 : 0;
    if (touched) return true;
    const hold = on[i] ? NEAR_HOLD : 0;
    const frame = Math.min(dt, MAX_ACC) * frames;
    const speed = car.velocity.length();
    // The car's box as fitted (`CAR_BOX`: its centre height, forward offset and half extents, in the car's frame), else its reach sphere.
    const b = i * CAR_BOX;
    const boxed = boxes[b + 2]! > 0;
    if (boxed) _cq.copy(car.group.quaternion).invert();
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      if (!d.live) continue;
      const r = DOLL_REACH + NEAR_MARGIN + hold + 2 * (speed + d.speed) * frame;
      _c.set(d.cur[0]! - p.x, d.cur[1]! - p.y, d.cur[2]! - p.z);
      if (!boxed) {
        const reach = r + reaches[i]!;
        if (_c.lengthSq() < reach * reach) return true;
        continue;
      }
      _c.applyQuaternion(_cq);
      const ex = Math.max(Math.abs(_c.x) - boxes[b + 2]!, 0);
      const ey = Math.max(Math.abs(_c.y - boxes[b]!) - boxes[b + 3]!, 0);
      const ez = Math.max(Math.abs(_c.z - boxes[b + 1]!) - boxes[b + 4]!, 0);
      if (ex * ex + ey * ey + ez * ez < r * r) return true;
    }
    return this.purses !== null && this.purses.near(p, reaches[i]! + PURSE_REACH + NEAR_MARGIN + hold);
  }

  /** Part `k` of `d` as drawn: `alpha` of the way from its pose one step before the last to the last. */
  private blend(d: Doll, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    blendPose(d.prev, d.cur, 7 * k, this.alpha, p, q);
  }

  private capture(d: Doll, into: Float32Array): void {
    for (let k = 0; k < PARTS.length; k++) readPose(d.bodies[k]!, into, 7 * k);
  }

  /**
   * After a step: a part that has just hit something (`HIT_DV`) gives at each of its joints (`give`), once per hit (a hit
   * runs a few steps; only its first counts). His torso touching down for the first time damps him harder from then on.
   * Velocities are recorded after the giving, so its own change is not read as the next hit: read again only when a
   * part gave (each read is a Rapier getter that allocates).
   */
  private hits(s: number, d: Doll): void {
    const o = s * PARTS.length * 4;
    let gave = false;
    for (let k = 0; k < PARTS.length; k++) {
      const v = d.bodies[k]!.linvel();
      const i = o + 4 * k;
      const fresh = this.vel[i + 3] === 3;
      const jump = !fresh && hypot3(v.x - this.vel[i]!, v.y - this.vel[i + 1]!, v.z - this.vel[i + 2]!) > HIT_DV;
      if (jump && this.vel[i + 3] === 0) {
        give(d.bodies, k);
        gave = true;
      }
      this.vel[i] = v.x;
      this.vel[i + 1] = v.y;
      this.vel[i + 2] = v.z;
      this.vel[i + 3] = jump ? 1 : 0;
    }
    if (gave) {
      for (let k = 0; k < PARTS.length; k++) {
        const v = d.bodies[k]!.linvel();
        const i = o + 4 * k;
        this.vel[i] = v.x;
        this.vel[i + 1] = v.y;
        this.vel[i + 2] = v.z;
      }
    }
    if (d.ground) return;
    const t = d.bodies[0]!.translation();
    // At his own height: under a bridge the road is his ground, not the deck over him.
    const g = activeGround().heightAt(t.x, t.z, t.y);
    if (t.y - (Number.isFinite(g) ? g : 0) >= GROUND_REACH) return;
    d.ground = true;
    for (const body of d.bodies) {
      body.setLinearDamping(GROUND_LINEAR);
      body.setAngularDamping(GROUND_ANGULAR);
    }
  }

  /**
   * A dummy on the ground whose torso has lain still damps hard (`SETTLE_*`), then goes to sleep once his whole body
   * is calm (Rapier's own thresholds cannot be set from JS).
   */
  private calm(d: Doll, dt: number): void {
    if (d.ground && !d.settled && d.still >= SETTLE_AFTER) {
      d.settled = true;
      for (const b of d.bodies) {
        b.setLinearDamping(SETTLE_LINEAR);
        b.setAngularDamping(SETTLE_ANGULAR);
      }
    }
    d.calm = d.ground && isCalm(d.bodies) ? d.calm + dt : 0;
    if (d.calm >= CALM_FOR && !d.bodies[0]!.isSleeping()) for (const b of d.bodies) b.sleep();
  }

  /** The ride-along camera is on (`follow` until every dummy out lies still). */
  get rideAlong(): boolean {
    return this.ride.riding;
  }

  /** Ride along with the dummies thrown (`RideAlong.follow`). */
  follow(): void {
    this.ride.follow(this.dolls[this.lastSlot], this.lastSlot, this.cars);
  }

  /** The ride's aim, eased toward the dummies' heads (`frameCamera` "held": the orbit looks at it). */
  get rideLook(): THREE.Vector3 {
    return this.ride.cam.look;
  }

  /** Before the engine's own rigs place `camera`: back to the pose they left, under the eased one `fadeRide` drew (`RideCam.unfade`). */
  unfadeRide(camera: THREE.PerspectiveCamera): void {
    this.ride.cam.unfade(camera);
  }

  /** After the engine's own camera has placed `camera` this frame: ease it out of the ride's last pose (`RideCam.fade`). */
  fadeRide(camera: THREE.PerspectiveCamera, wallDt: number, on: boolean): void {
    this.ride.cam.fade(camera, wallDt, on);
  }

  /** The latest throw's torso (world) into `out`, and the sim seconds it has lain still; -1 while it is not out. */
  latest(out: THREE.Vector3): number {
    const d = this.dolls[this.lastSlot];
    if (!d?.live) return -1;
    out.set(d.cur[0]!, d.cur[1]!, d.cur[2]!);
    return d.still;
  }

  /** The latest throw lies settled on the ground (`calm`): he has landed. */
  get latestSettled(): boolean {
    const d = this.dolls[this.lastSlot];
    return d !== undefined && d.live && d.settled;
  }

  /** Place `camera` on the dummies being followed: "none" when none is (the engine's own camera runs), "held" when the user's orbit has it (`RideAlong.frame`). */
  frameCamera(camera: THREE.PerspectiveCamera, wallDt: number, hold: boolean, watched: number, held: boolean, lens: number, sight: () => Sight): RideFrame {
    return this.ride.frame(this.dolls, this.alpha, camera, wallDt, hold, watched, held, lens, sight);
  }

  dispose(): void {
    this.disposed = true;
    this.remote?.dispose();
    this.remote = null;
    this.debug.dispose();
    this.mesh.removeFromParent();
    this.purses?.dispose();
    this.props.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.world?.free();
    this.world = null;
  }

  /**
   * A driver is thrown out of `cars[e.car]`: the exit pane smashes and the way out gets its cover (`onExit`) now, the
   * dummy flies now or (Rapier still loading) once it is in. The sim's own event (`EjectionWatch`), a netplay host's
   * message or a highlight clip's record: the dummy starts from the event's numbers alone, so the same event is the
   * same throw wherever it is launched. `rides` false: the ride-along never frames him (a reel's throw from another
   * crash than its own, `ownThrow`).
   */
  launch(e: Ejection, cars: readonly DeformableCar[], rides = true): void {
    this.cars = cars;
    const car = cars[e.car]!;
    if (this.authority) car.smashGlass(e.exit);
    const t = this.next;
    // The cover's centre, half a metre out of the pane: over the bonnet, or the door; its frame's z out of the pane.
    const side = e.exit === "windshield" ? 0 : e.exit === "doorL" ? -1 : 1;
    car.glassWorld(e.exit, _c).addScaledVector(e.dir, 0.5);
    _cq.copy(car.group.quaternion).multiply(_qx.setFromAxisAngle(Y, (side * Math.PI) / 2));
    t.p.copy(e.pos);
    t.q.copy(e.quat);
    t.w.copy(e.spin);
    ejectionVelocity(e, t.v);
    t.car = e.car;
    t.age = 0;
    t.cop = e.cop;
    t.rides = rides;
    this.onExit(_c, _cq, car.velocity);
    this.pick();
    if (this.mode === "remote") this.launchRemote(t, cars);
    else if (this.world) this.spawn(t);
    else this.pending.push({ car: t.car, p: t.p.clone(), q: t.q.clone(), v: t.v.clone(), w: t.w.clone(), age: 0, cop: t.cop, rides: t.rides });
  }

  /**
   * Throw `t`'s dummy in the world's worker: it goes now, in whichever slot the worker has free; what its look and purse are
   * is decided here and applied (`dress`) when the worker answers with the slot. The ride-along and the sandbox's follow
   * hook hear of the throw at once, as an inline one's.
   */
  private launchRemote(t: Throw, cars: readonly DeformableCar[]): void {
    const own = t.cop ? null : this.lookOf(t.car);
    const look = own ? pickedLook(driverLook(this.lookSeed, t.car), own.person) : driverLook(this.lookSeed, t.car);
    const purse = look.woman && !t.cop;
    const id = this.remote!.throwDummy(t, purse, this.lookSeed, cars);
    this.dressing.set(id, { cop: t.cop, look, spray: own ? own.personSpray : null, purse, car: t.car, seed: this.lookSeed });
    this.ride.exit(t.car, hypot2(t.v.x, t.v.z), t.p);
    if (this.sandbox && t.car >= 0) this.onThrow(t.car);
  }

  /**
   * A dummy of the scene's own, with no car (the Lab's): torso at `p` turned `q` (standing upright at identity, arms up),
   * moving at `v` and spinning at `w` (world), lying about `life` sim s, in slot `slot` (-1: a free one, else the oldest).
   * Nobody is thrown: no exit, no throw hook, no ride-along. Returns his slot; -1 while Rapier is still loading.
   */
  place(p: THREE.Vector3, q: THREE.Quaternion, v: THREE.Vector3, w: THREE.Vector3, life: number, slot: number): number {
    if (!this.world) return -1;
    const t = this.next;
    t.p.copy(p);
    t.q.copy(q);
    t.v.copy(v);
    t.w.copy(w);
    t.car = -1;
    t.age = 0;
    t.cop = false;
    t.rides = false;
    return this.spawn(t, slot, life);
  }

  /** Slot `s`'s torso centre after the last step into `p`, and its velocity (world) into `v` unless null; false while no dummy is out in it. */
  torso(s: number, p: THREE.Vector3, v: THREE.Vector3 | null): boolean {
    const d = this.dolls[s];
    if (!d?.live) return false;
    p.set(d.cur[0]!, d.cur[1]!, d.cur[2]!);
    if (v) {
      const u = d.bodies[0]!.linvel();
      v.set(u.x, u.y, u.z);
    }
    return true;
  }

  /** Slot `s`'s dummy leaves from where he is, turned as he is, moving at `v` (world) and spinning at none. */
  leave(s: number, v: THREE.Vector3): void {
    const d = this.dolls[s];
    if (!d?.live) return;
    this.place(_p.set(d.cur[0]!, d.cur[1]!, d.cur[2]!), _q.set(d.cur[3]!, d.cur[4]!, d.cur[5]!, d.cur[6]!), v, _w.set(0, 0, 0), Infinity, s);
  }

  /** Throw `t`'s dummy into slot `at` (-1: a free slot, else the oldest one's), to lie about `life` sim s; returns the slot. */
  spawn(t: Throw, at = -1, life = LIFE): number {
    let slot = at >= 0 ? at : this.dolls.findIndex((d) => !d.live);
    if (slot < 0) slot = this.dolls.reduce((o, d, s) => (d.age > this.dolls[o]!.age ? s : o), 0);
    this.despawn(slot);
    const d = this.dolls[slot]!;
    const t0 = PARTS[0]!.c;
    for (let k = 0; k < PARTS.length; k++) {
      const b = d.bodies[k]!;
      const c = PARTS[k]!.c;
      // A raised arm is the hanging one turned over about its shoulder.
      const y = ARM(k) ? 2 * SHOULDER_Y - c[1] : c[1];
      _r.set(c[0] - t0[0], y - t0[1], c[2] - t0[2]).applyQuaternion(t.q);
      _v.x = t.p.x + _r.x;
      _v.y = t.p.y + _r.y;
      _v.z = t.p.z + _r.z;
      b.setTranslation(_v, false);
      _qx.copy(t.q);
      if (ARM(k)) _qx.multiply(_arm);
      b.setRotation(_qx, false);
      // Rigid motion: v + ω × r.
      _s.copy(t.w).cross(_r);
      _v.x = t.v.x + _s.x;
      _v.y = t.v.y + _s.y;
      _v.z = t.v.z + _s.z;
      b.setLinvel(_v, false);
      _v.x = t.w.x;
      _v.y = t.w.y;
      _v.z = t.w.z;
      b.setAngvel(_v, false);
      b.collider(0).setCollisionGroups(thrownGroups(slot, t.car));
      b.setEnabled(true);
      b.wakeUp();
    }
    const speed = hypot2(t.v.x, t.v.z);
    this.buildPatch(d, t.p.x + (speed > 0.5 ? (t.v.x / speed) * PATCH_AHEAD : 0), t.p.z + (speed > 0.5 ? (t.v.z / speed) * PATCH_AHEAD : 0), t.p.y);
    d.live = true;
    d.age = 0;
    d.life = life;
    d.still = 0;
    d.car = t.car;
    d.rides = t.rides;
    d.calm = 0;
    d.speed = hypot3(t.v.x, t.v.y, t.v.z);
    d.vel[0] = t.v.x;
    d.vel[1] = t.v.y;
    d.vel[2] = t.v.z;
    this.proxies.release(slot);
    for (let k = 0; k < PARTS.length; k++) this.vel[(slot * PARTS.length + k) * 4 + 3] = 3;
    if (d.ground) {
      d.ground = false;
      d.settled = false;
      for (const b of d.bodies) {
        b.setLinearDamping(AIR_LINEAR);
        b.setAngularDamping(AIR_ANGULAR);
      }
    }
    // The pose one step before the release, along his launch motion: from the first frame he is drawn moving out of the
    // pane, one step behind the sim as on every later frame, not held at it until his first step (4 frames at 0.03× and
    // 60 Hz, 16 at 240).
    this.capture(d, d.cur);
    const spin = t.w.length();
    _qx.setFromAxisAngle(spin > 0 ? _s.copy(t.w).divideScalar(spin) : Y, -spin * STEP);
    for (let k = 0; k < PARTS.length; k++) {
      const v = d.bodies[k]!.linvel();
      const o = 7 * k;
      d.prev[o] = d.cur[o]! - v.x * STEP;
      d.prev[o + 1] = d.cur[o + 1]! - v.y * STEP;
      d.prev[o + 2] = d.cur[o + 2]! - v.z * STEP;
      _qb.set(d.cur[o + 3]!, d.cur[o + 4]!, d.cur[o + 5]!, d.cur[o + 6]!).premultiply(_qx);
      d.prev[o + 3] = _qb.x;
      d.prev[o + 4] = _qb.y;
      d.prev[o + 5] = _qb.z;
      d.prev[o + 6] = _qb.w;
    }
    const own = t.cop ? null : this.lookOf(t.car);
    const look = own ? pickedLook(driverLook(this.lookSeed, t.car), own.person) : driverLook(this.lookSeed, t.car);
    this.mesh.dress(slot, t.cop, look);
    this.mesh.spray(slot, own ? own.personSpray : null);
    if (t.purse ?? (look.woman && !t.cop)) this.purses?.launch(slot, t.car, t.p, t.v, this.lookSeed);
    this.wake();
    this.live++;
    this.lastSlot = slot;
    this.mesh.visible = true;
    this.ride.exit(t.car, hypot2(t.v.x, t.v.z), t.p);
    if (this.sandbox && t.car >= 0) this.onThrow(t.car);
    return slot;
  }

  /**
   * The course a throw collides with, and its knockable props (`placed`; drawn by `props`, null headless), all back on their
   * spots. Its solids are built at the first throw on it, as recipes: Rapier colliders live only from a throw to its despawn.
   * The world's worker builds the same course from the track's JSON.
   */
  setCourse(track: Track, placed: readonly Placed[], props: PropDraw | null): void {
    this.course = { ground: track.ground(), track, placed };
    this.solids = null;
    this.props.set(placed, props);
    this.tumble = props;
    if (this.live === 0) this.mode = null;
    this.remote?.setCourse(track.json);
  }

  /**
   * A scene's own solids (the Lab's wall, brackets and solid props) a dummy collides with while `ground` is the active one,
   * as a course's are, and its knockable props (`placed`, drawn by `props`), all back on their spots.
   */
  setSolids(ground: Ground, solids: readonly Solid[], placed: readonly Placed[], props: PropDraw | null): void {
    this.course = { ground, track: null, placed };
    this.solids = solids;
    this.props.set(placed, props);
    this.tumble = props;
    if (this.live === 0) this.mode = null;
  }

  /**
   * Knockable prop `i` of the course or scene knocked off its spot by car `car` (-1: none) at (vx, vy, vz) m/s: it flies,
   * tumbles and comes to rest in this world (cosmetic: nothing here reaches the sim); knocked before Rapier is in, once it is.
   */
  knockProp(i: number, car: number, vx: number, vy: number, vz: number): void {
    this.pick();
    if (this.mode === "remote") {
      this.remote!.knock(i, car, vx, vy, vz);
      return;
    }
    this.wake();
    this.props.knock(i, car, vx, vy, vz);
  }

  /** Knocked prop `i`'s middle after the last step into `p`, and its velocity into `v`; false while it is not out. */
  propAt(i: number, p: THREE.Vector3, v: THREE.Vector3): boolean {
    return this.props.centre(i, p, v);
  }

  /**
   * Which world this run's dummies are in, decided at its first throw or knock and kept until `reset`: the worker's when it is up
   * (and this thread's Rapier too, which owns the dummy pool the draw reads) and the course is a track's, which the worker builds
   * from its JSON; else this thread's.
   */
  private pick(): void {
    if (this.mode !== null) return;
    const course = this.course;
    const onTrack = course !== null && course.track !== null && activeGround() === course.ground;
    this.mode = this.remote?.ready && this.world !== null && onTrack ? "remote" : "inline";
  }

  /** The sim must not run its next frame yet: the worker's answer it is to hear of first is not in (`RagdollRemote.behind`). */
  get waiting(): boolean {
    return this.mode === "remote" && this.remote!.behind(this.authority);
  }

  /** This system is the world's worker's: it draws nothing (`snapshot` gives the main thread what to draw), and `wanted` says which cars it wants cages of. */
  host(): void {
    this.hosted = true;
  }

  /** A dummy or a knocked prop is out. */
  get busy(): boolean {
    return this.live > 0 || this.props.count > 0;
  }

  /** How far (0-1) into the next step the last frame's draw is. */
  get drawAlpha(): number {
    return this.alpha;
  }

  /** Every dummy's and purse set's state after the last frame into `dolls` and `purses` (`DOLL_FLOATS` and `PURSE_BLOCK` floats a slot), for the main thread to draw. Returns the latest throw's slot. */
  snapshot(dolls: Float32Array, purses: Float32Array): number {
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      const o = s * DOLL_FLOATS;
      dolls[o + DOLL_LIVE] = d.live ? 1 : 0;
      if (!d.live) continue;
      dolls[o + DOLL_RIDES] = d.rides ? 1 : 0;
      dolls[o + DOLL_CAR] = d.car;
      dolls[o + DOLL_STILL] = d.still;
      dolls[o + DOLL_SETTLED] = d.settled ? 1 : 0;
      dolls.set(d.vel, o + DOLL_VELOCITY);
      dolls.set(d.prev, o + DOLL_HEADER);
      dolls.set(d.cur, o + DOLL_HEADER + PARTS.length * 7);
    }
    this.purses?.exportPoses(purses);
    return this.lastSlot;
  }

  /** A frame in the worker's world: post it, then draw what the worker has answered with since. */
  private updateRemote(dt: number, cars: readonly DeformableCar[]): void {
    const remote = this.remote!;
    remote.post(dt, cars, this.authority, this.sandbox, this.lookSeed);
    for (const result of remote.drain()) this.adopt(result);
  }

  /** The worker's answer on screen: its dummies' and purses' poses, its knocked props placed, the slot of each dummy it just threw dressed. */
  private adopt(r: ResultMessage): void {
    this.alpha = r.alpha;
    this.lastSlot = r.lastSlot;
    for (const { id, slot } of r.spawned) this.dress(id, slot);
    let live = 0;
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      const o = s * DOLL_FLOATS;
      if (r.dolls[o + DOLL_LIVE] !== 1) {
        if (d.live) {
          d.live = false;
          this.mesh.hide(s);
          this.debug.hide(s);
        }
        continue;
      }
      live++;
      d.live = true;
      d.rides = r.dolls[o + DOLL_RIDES] === 1;
      d.car = r.dolls[o + DOLL_CAR]!;
      d.still = r.dolls[o + DOLL_STILL]!;
      d.settled = r.dolls[o + DOLL_SETTLED] === 1;
      d.vel.set(r.dolls.subarray(o + DOLL_VELOCITY, o + DOLL_VELOCITY + 3));
      d.prev.set(r.dolls.subarray(o + DOLL_HEADER, o + DOLL_HEADER + PARTS.length * 7));
      d.cur.set(r.dolls.subarray(o + DOLL_HEADER + PARTS.length * 7, o + DOLL_FLOATS));
      for (let k = 0; k < PARTS.length; k++) {
        this.blend(d, k, _p, _q);
        this.mesh.pose(s, k, _p, _q);
        if (this.debug.on) this.debug.pose(s, k, _p, _q);
      }
    }
    this.live = live;
    this.mesh.visible = live > 0;
    this.purses?.importPoses(r.purses);
    this.purses?.pose(this.alpha);
    if (r.propsReset) this.tumble?.reset();
    for (let k = 0; k < r.props.length; k += PROP_FLOATS) this.tumble?.place(r.props[k]!, _p.fromArray(r.props, k + 1), _q.fromArray(r.props, k + 4));
    for (const ms of r.stepMs) this.stepMs[this.steps++ % STEP_LOG] = ms;
    this.remoteSize.colliders = r.colliders;
    this.remoteSize.bodies = r.bodies;
  }

  /** The dummy sent as throw `id` took slot `slot`: dress it as it was sent. */
  private dress(id: number, slot: number): void {
    const dressing = this.dressing.get(id);
    if (dressing === undefined) return;
    this.dressing.delete(id);
    this.mesh.dress(slot, dressing.cop, dressing.look);
    this.mesh.spray(slot, dressing.spray);
    if (dressing.purse) this.purses?.paint(slot, dressing.car, dressing.seed);
  }

  /** The worker failed: this thread's world takes the next throw, and what the worker had out is gone. */
  private fallBack(err: Error): void {
    console.error("Crush Stream ragdoll worker failed", err);
    this.remote?.dispose();
    this.remote = null;
    if (this.mode === "remote") this.reset();
  }

  /** Nothing was out: the stepping starts afresh (no leftover from an earlier throw shifts the first step) and the proxies jump to the cars. */
  private wake(): void {
    if (this.live > 0 || this.props.count > 0) return;
    this.acc = this.tick = 0;
    this.proxies.teleport = true;
  }

  /** The ground under a throw (`groundColliders`): the active surface's solids (pad, disc and ramps, corkscrew) built once, its terrain's heightfield patch per dummy on a course or a scene's solids. */
  private buildPatch(d: Doll, cx: number, cz: number, y: number): void {
    const c = this.course;
    if (c !== null && activeGround() === c.ground) d.patch.push(...this.patchAt(cx, cz, y, PATCH_HALF));
    else if (this.statics.length === 0) this.statics.push(...groundColliders(this.R!, this.world!, FIXED_GROUPS, null, this.sand, this.poles, cx, cz, y, PATCH_HALF));
  }

  /** The course's or the scene's ground, walls and solids `half` m around (`cx`, `cz`) at height `y` (`groundColliders`): a dummy's patch, or knocked props'. */
  private patchAt(cx: number, cz: number, y: number, half: number): Collider[] {
    const c = this.course!;
    if (c.track) this.solids ??= courseSolids(c.track, c.placed);
    return groundColliders(this.R!, this.world!, FIXED_GROUPS, { track: c.track, solids: this.solids! }, this.sand, this.poles, cx, cz, y, half);
  }

  private despawn(s: number): void {
    const d = this.dolls[s]!;
    if (d.live) this.live--;
    d.live = false;
    for (const b of d.bodies) disable(b);
    for (const c of d.patch) this.world!.removeCollider(c, false);
    d.patch.length = 0;
    this.mesh.hide(s);
    this.purses?.clear(s);
    this.debug.hide(s);
    if (this.live === 0) this.mesh.visible = false;
  }
}
