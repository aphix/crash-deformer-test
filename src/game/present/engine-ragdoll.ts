/*
 * Thrown-driver ragdolls: a cosmetic crash-test dummy flung out through the windshield or a front side window
 * when one hit disables a car (`EjectionWatch`). Its own Rapier world (@dimforge/rapier3d, Apache-2.0):
 * ground and walls are fixed colliders around the throw, every car (and the sandbox's jersey barrier) a kinematic
 * box that follows its pose, so cars push dummies and nothing pushes back; no dummy state reaches the sim or the
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
import type { Collider, RigidBody, World } from "@dimforge/rapier3d";
import type { DeformableCar } from "../vehicle/car.ts";
import { activeGround } from "../world/ground.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import type { Track } from "../world/track.ts";
import type { Placed } from "../world/placements.ts";
import { ejectionVelocity, type Ejection } from "../vehicle/ejection.ts";
import { loadRapier, type Rapier } from "../kernel/rapier.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { driverLook } from "./driver-look.ts";
import { Purses } from "./ragdoll-purse.ts";
import { RagdollDebug } from "./ragdoll-debug.ts";
import { RideCam, type RideFrame } from "./ride-cam.ts";
import type { Sight } from "./spectate-cam.ts";
import { AIR_ANGULAR, AIR_LINEAR, ARM, CALM_FOR, GROUND_ANGULAR, GROUND_LINEAR, give, isCalm, JOINTS, limit, PARTS, SETTLE_AFTER, SETTLE_ANGULAR, SETTLE_LINEAR, SHOULDER_Y } from "./ragdoll-body.ts";
import { joinUp } from "./ragdoll-joints.ts";
import { groundColliders, type Pole } from "./ragdoll-ground.ts";
import { courseSolids, type Solid } from "./ragdoll-solids.ts";

/** Live dummies at once; a fifth throw recycles the oldest. */
const SLOTS = 4;
/** Seconds a dummy lies about before it goes. */
const LIFE = 10;
/** Seconds after the throw the dummy ignores its own car and the other dummies (the collision groups below): it
 *  starts inside its own cabin, over its own lower box. */
const GRACE = 0.35;
/** Metres down the throw that a course ground patch (`groundColliders`) is centred. */
const PATCH_AHEAD = 24;
const GRAVITY = 9.6;
/** Dummy friction against anything (the lower of the pair counts): low, so it slides a good way (owner, 2026-10-02). */
const SLIDE = 0.12;
/** Jersey barrier height (m): the barrier-block prefab's art. */
const BARRIER_H = 0.81;
/** Ride-along camera: seconds a dummy lies still before it lets go (`RideCam` places the shots). */
const CAM_STILL = 1.5;
/**
 * Ride-along framing: the dummies within this (m) of the primary one share its shot. At the widest it pulls back
 * to about 15 m, where a 1.7 m dummy still fills about 1/8 of the 50° frame's height.
 */
const CAM_NEAR = 6;
/** Torso speed (m/s) by which the watched car's driver wins the pick of the primary dummy. */
const CAM_TIE = 1;
/** Torso speed (m/s) under which a dummy counts as lying still. */
const REST_SPEED = 0.4;
/**
 * Sim seconds a throw judged before Rapier is in may wait for it; later it is dropped (a dummy out of a car that
 * stopped a second ago reads as a glitch). Rapier lands 0.45 s after `ready` in a production build, a fleet's
 * first hit 1–2 s after it.
 */
const PENDING_MAX = 1;
/**
 * Rapier's step (sim s), the same at any display rate: `update` steps whole `STEP`s out of an accumulator and the draw
 * blends the last two. It used to step once per frame with that frame's dt, and Rapier warm-starts each contact and
 * joint with the last step's impulse, which is wrong once dt changes. Lane ragdoll-6's range probe, frames that
 * varied: landings of 25.6–58.1 m, a joint 43 cm apart and one step gaining 8.4 kJ.
 */
const STEP = 1 / 120;
/** Most sim seconds one frame steps: a longer hitch drops the rest instead of spiralling. */
const MAX_ACC = 0.1;
/**
 * Rapier's solver iterations (default 4) and no CCD on the parts: CCD clamps each part to its own time of impact and
 * tears the joints apart (range probe, 3 render rates: joints up to 11–28 cm apart with it, 0.9 cm without, 8
 * iterations; 2–3 cm at 4).
 */
const ITERATIONS = 8;
/**
 * Rapier's internal solver passes per iteration (default 1). The elbows' and knees' hinge limits and the sand's contact
 * fight over a forearm at the first touch of a 29 m/s throw, and one pass left them kicking it to 100 rad/s: energy
 * rose 75–325 J in one frame (range probe, 4 of 4 runs at 1 pass); at 2 passes at most 0.6 J over 60 runs (60/144/240 Hz).
 */
const INTERNAL_PASSES = 2;
/** Each car's lower box (car-local, origin on the ground): half extents and centre height at rest; its ends past the bumpers' masses. */
const LOW_HALF_X = 0.86;
const LOW_HALF_Y = 0.4;
const LOW_HALF_Z = 2.15;
const LOW_Y = 0.45;
const NOSE_PAD = 0.09;

/**
 * Collision groups (membership << 16 | filter), 16 bits: the world; each dummy slot; each car (its lower box, bumper
 * to bonnet line, fitted to its crushed length, and its cabin box), in 10 buckets of car index. Out of the car a
 * dummy hits everything but its own jointed neighbours (`setContactsEnabled(false)`). For `GRACE` s after the throw
 * it ignores its own car (it starts inside it) and the other dummies; every other car it hits from the first frame.
 */
const G_STATIC = 1;
const dollBit = (s: number) => 2 << s;
const G_DOLLS = 0x1e;
const carBit = (i: number) => 0x40 << i % 10;
const G_CARS = 0xffc0;
const dollGroups = (s: number) => (dollBit(s) << 16) | G_STATIC | G_DOLLS | G_CARS;
/** A woman's purse and what falls out of it hit the world, the barrier and every car (not their own for `GRACE` s), never a dummy. */
const G_PROPS = 0x20;
const propGroups = (car: number) => (G_PROPS << 16) | G_STATIC | (car < 0 ? G_CARS : G_CARS & ~carBit(car));
const FIXED_GROUPS = (G_STATIC << 16) | G_DOLLS | G_PROPS;

type Doll = {
  bodies: RigidBody[];
  live: boolean;
  age: number;
  /** Sim seconds the torso has been under `REST_SPEED`. */
  still: number;
  patch: Collider[];
  /** The car he was thrown from. */
  car: number;
  /** Each part's pose (position xyz, rotation xyzw) after the last step and the one before it: the draw blends them. */
  prev: Float32Array;
  cur: Float32Array;
  /** Touched the ground (`touch`): damped harder from then on. */
  ground: boolean;
  /** Lying settled (`calm`): damped harder still. */
  settled: boolean;
  /** Sim seconds he has been under `CALM_ENERGY` (`calm`). */
  calm: number;
};

/** A throw, placed: car, torso point and orientation, linear and angular velocity (world), sim seconds waiting, a police driver. */
type Throw = { car: number; p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; w: THREE.Vector3; age: number; cop: boolean };

const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const _arm = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c = new THREE.Vector3();
const _cq = new THREE.Quaternion();
const _v = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };
const Y = new THREE.Vector3(0, 1, 0);

/** Car-local z (m) of `car`'s mass `name`, along its heading. */
function endZ(car: DeformableCar, name: string): number {
  return _e.copy(car.deform.massWorld(name)).sub(car.group.position).dot(_f);
}

/**
 * A part whose velocity jumps by this much (m/s) in one step has hit something (gravity adds 0.08 per step): the skin
 * gives once at its first step (`hits`). Rapier's contact events say the same, but `drainCollisionEvents` passes a JS
 * closure through the wasm, and Vite's dev server serves the package's glue module twice (the closure's slot is not in
 * the other copy's table): every step then throws "reading 'memory'" and the dummy never lands (measured in the
 * browser; a production build has one copy).
 */
const HIT_DV = 4;
/** His torso centre this near (m) the ground: he has touched down (lying, it rests at 0.1–0.3 m; thrown, it is over 0.5 m). */
const GROUND_REACH = 0.45;

export class RagdollSystem {
  /** The sandbox's lamp posts: the standing ones are fixed colliders in the run's statics (set by the engine). */
  poles: readonly Pole[] = [];
  /** The race course whose walls and solids a throw collides with, while its ground is the active one (`setCourse`). */
  private course: { track: Track; placed: readonly Placed[]; knocked: (prop: number) => boolean } | null = null;
  /** The course's `courseSolids`, built at its first throw. */
  private solids: readonly Solid[] | null = null;
  /** The flat ground is the range's sand pit (`SAND`), read when a run's first throw builds it (set by the engine). */
  sand = false;
  private readonly mesh: DummyMesh;
  /** The HUD's Rig and Particles views of the dummies (`set`). */
  readonly debug: RagdollDebug;
  private readonly onThrow: (car: number) => void;
  /** The look seed (`driverLook`) the engine sets each frame: a driver keeps his tee and hair through a race. */
  lookSeed = 0;
  private purses: Purses | null = null;
  private readonly onExit: (at: THREE.Vector3, frame: THREE.Quaternion, inherit: THREE.Vector3) => void;
  private R: Rapier | null = null;
  private world: World | null = null;
  private readonly dolls: Doll[] = [];
  private readonly carBodies: RigidBody[] = [];
  /** Each car's lower box ends as last fitted (`fitEnds`): front, rear (car-local z). */
  private readonly ends = new Float32Array(MAX_CARS * 2);
  private barrierBody: RigidBody | null = null;
  private live = 0;
  /** Throws judged before Rapier was in (`PENDING_MAX`). */
  private readonly pending: Throw[] = [];
  private readonly next: Throw = { car: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false };
  /** Fixed colliders every dummy shares off a course (pad or disc with its ramps, corkscrew, bowl wall, poles), built at the run's first throw: Rapier's step allocates per collider (0.31 KB, RapierEval). */
  private readonly statics: Collider[] = [];
  private disposed = false;
  private cars: readonly DeformableCar[] = [];
  private authority = true;
  private bowlR = 0;
  /** Neither a race nor a derby: only here does `onThrow` fire. */
  private sandbox = true;
  /** The car proxies sat still while no dummy was out: jump them to the cars before the next step. */
  private teleport = false;
  /** Sim seconds the world has not stepped yet (under `STEP` after each frame), and how far into the next step the draw is. */
  private acc = 0;
  private alpha = 0;
  /** The kinematic proxies (cars, then the barrier): last frame's pose then this frame's, 7 numbers each (position, rotation); which are on. */
  private readonly aim = new Float32Array((MAX_CARS + 1) * 14);
  private readonly on = new Uint8Array(MAX_CARS + 1).fill(1);
  /** Each part's velocity at the end of the last step, and a flag (0 none, 1 hit last step, 3 just spawned), 4 numbers per part per slot: `hits`. */
  private readonly vel = new Float32Array(SLOTS * PARTS.length * 4);
  private lastSlot = 0;
  /** Ride-along camera: on from `follow` until every dummy out lies still. */
  private riding = false;
  /** The car whose driver was thrown last: the ride opens on its windshield. */
  private exitCar = -1;
  /** His flat throw speed (m/s): how far ahead the windshield eye stands. */
  private exitSpeed = 0;
  /** The dummy slot the ride frames (`frameCamera`), -1 before its first pick. */
  private primary = -1;
  /** The framed dummies' heads, this frame. */
  private readonly heads = Array.from({ length: SLOTS }, () => new THREE.Vector3());
  private readonly cam = new RideCam();

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
   * engine calls this once boot is `ready`; until it resolves `update` only judges hits (`pending`).
   */
  async preload(): Promise<void> {
    const R = await loadRapier();
    if (this.disposed) return;
    this.R = R;
    const world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world = world;
    world.timestep = STEP;
    world.numSolverIterations = ITERATIONS;
    world.integrationParameters.numInternalPgsIterations = INTERNAL_PASSES;
    for (let i = 0; i < MAX_CARS; i++) {
      const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, i * 10));
      // From 5 cm off the ground to the bonnet line the whole car, so a lying dummy is shoved, not driven over; above
      // it the cabin (car-local, origin on the ground, +z forward). `fitEnds` follows the lower box's crushed ends.
      world.createCollider(R.ColliderDesc.cuboid(LOW_HALF_X, LOW_HALF_Y, LOW_HALF_Z).setTranslation(0, LOW_Y, 0).setCollisionGroups((carBit(i) << 16) | G_DOLLS | G_PROPS), body);
      world.createCollider(R.ColliderDesc.cuboid(0.7, 0.27, 0.68).setTranslation(0, 1.07, -0.07).setCollisionGroups((carBit(i) << 16) | G_DOLLS | G_PROPS), body);
      this.ends[2 * i] = LOW_HALF_Z;
      this.ends[2 * i + 1] = -LOW_HALF_Z;
      this.carBodies.push(body);
    }
    this.barrierBody = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, -10));
    world.createCollider(R.ColliderDesc.cuboid(BARRIER_HALF.x, BARRIER_H / 2, BARRIER_HALF.z).setTranslation(0, BARRIER_H / 2, 0).setCollisionGroups(FIXED_GROUPS), this.barrierBody);
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
      this.dolls.push({ bodies, live: false, age: 0, still: 0, patch: [], car: -1, prev: new Float32Array(PARTS.length * 7), cur: new Float32Array(PARTS.length * 7), ground: false, settled: false, calm: 0 });
    }
    // A child of the dummies' mesh, so the scene root keeps its one `ragdolls` child and the props draw only while a dummy is out.
    this.mesh.add((this.purses = new Purses(R, world, SLOTS, propGroups, GRACE)).mesh);
    // One step with a dummy out, far below the world: links the step path before a crash needs it.
    const d = this.dolls[0]!;
    for (const b of d.bodies) b.setEnabled(true);
    world.step();
    for (const b of d.bodies) b.setEnabled(false);
  }

  /** A new run: no dummies out, every car's driver back in. */
  reset(): void {
    this.pending.length = 0;
    this.acc = 0;
    this.riding = false;
    this.cam.leave(null);
    for (let s = 0; s < this.dolls.length; s++) this.despawn(s);
    for (const c of this.statics) this.world?.removeCollider(c, false);
    this.statics.length = 0;
  }

  /**
   * One frame: step the dummies `dt` sim seconds against the cars' poses (`authority`: this peer owns the glass, so
   * it smashes the exit pane of a throw). `sandbox`: neither a race nor a derby (`onThrow`); `bowlR`: the derby
   * bowl's radius, 0 outside a derby; `barrier`: the sandbox's jersey barrier while it stands, else null. Who is
   * thrown is not decided here (`launch`); a throw launched before Rapier is in waits for it, up to `PENDING_MAX`.
   */
  update(dt: number, cars: readonly DeformableCar[], authority: boolean, sandbox: boolean, bowlR: number, barrier: THREE.Object3D | null): void {
    if (dt <= 0) return;
    this.cars = cars;
    this.authority = authority;
    this.sandbox = sandbox;
    this.bowlR = bowlR;
    const world = this.world;
    for (const t of this.pending) t.age += dt;
    if (!world) return;
    for (const t of this.pending) if (t.age <= PENDING_MAX) this.spawn(t);
    this.pending.length = 0;
    if (this.live === 0) return;
    for (let i = 0; i < MAX_CARS; i++) {
      const car = i < cars.length && !cars[i]!.falling && !cars[i]!.vaporized ? cars[i]! : null;
      this.follow3(i, this.carBodies[i]!, car?.group ?? null);
      if (car) this.fitEnds(i, car);
    }
    this.follow3(MAX_CARS, this.barrierBody!, barrier);
    this.teleport = false;
    // Whole `STEP`s out of the accumulator, each proxy a step further along its frame's path.
    const lead = this.acc;
    this.acc = Math.min(lead + dt, MAX_ACC);
    const steps = Math.floor(this.acc / STEP + 1e-6);
    for (let j = 1; j <= steps; j++) {
      this.moveProxies(Math.min(1, (j * STEP - lead) / dt));
      if (j === steps) for (const d of this.dolls) if (d.live) this.capture(d, d.prev);
      if (j === steps) this.purses?.capture(false);
      world.step();
      this.purses?.advance(STEP);
      for (let s = 0; s < SLOTS; s++) {
        const d = this.dolls[s]!;
        if (!d.live) continue;
        this.hits(s, d);
        limit(d.bodies);
      }
    }
    this.acc = Math.max(0, this.acc - steps * STEP);
    this.alpha = Math.min(1, this.acc / STEP);
    if (steps > 0) for (const d of this.dolls) if (d.live) this.capture(d, d.cur);
    if (steps > 0) this.purses?.capture(true);
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      if (!d.live) continue;
      const before = d.age;
      d.age += dt;
      if (before < GRACE && d.age >= GRACE) for (const b of d.bodies) b.collider(0).setCollisionGroups(dollGroups(s));
      if (d.age > LIFE || d.bodies[0]!.translation().y < -30) {
        this.despawn(s);
        continue;
      }
      const v = d.bodies[0]!.linvel();
      d.still = Math.hypot(v.x, v.y, v.z) < REST_SPEED ? d.still + dt : 0;
      this.calm(d, dt);
      for (let k = 0; k < PARTS.length; k++) {
        this.blend(d, k, _p, _q);
        this.mesh.pose(s, k, _p, _q);
        if (this.debug.on) this.debug.pose(s, k, _p, _q);
      }
    }
    this.purses?.pose(this.alpha);
  }

  /** Part `k` of `d` as drawn: `alpha` of the way from its pose one step before the last to the last. */
  private blend(d: Doll, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    const a = d.prev;
    const b = d.cur;
    const o = 7 * k;
    const t = this.alpha;
    p.set(a[o]! + (b[o]! - a[o]!) * t, a[o + 1]! + (b[o + 1]! - a[o + 1]!) * t, a[o + 2]! + (b[o + 2]! - a[o + 2]!) * t);
    q.set(a[o + 3]!, a[o + 4]!, a[o + 5]!, a[o + 6]!).slerp(_qb.set(b[o + 3]!, b[o + 4]!, b[o + 5]!, b[o + 6]!), t);
  }

  private capture(d: Doll, into: Float32Array): void {
    for (let k = 0; k < PARTS.length; k++) {
      const t = d.bodies[k]!.translation();
      const r = d.bodies[k]!.rotation();
      const o = 7 * k;
      into[o] = t.x;
      into[o + 1] = t.y;
      into[o + 2] = t.z;
      into[o + 3] = r.x;
      into[o + 4] = r.y;
      into[o + 5] = r.z;
      into[o + 6] = r.w;
    }
  }

  /** Every kinematic proxy `f` of the way along its frame's path (position lerped, rotation slerped). */
  private moveProxies(f: number): void {
    const a = this.aim;
    for (let i = 0; i <= MAX_CARS; i++) {
      if (!this.on[i]) continue;
      const o = 14 * i;
      const body = i < MAX_CARS ? this.carBodies[i]! : this.barrierBody!;
      _v.x = a[o]! + (a[o + 7]! - a[o]!) * f;
      _v.y = a[o + 1]! + (a[o + 8]! - a[o + 1]!) * f;
      _v.z = a[o + 2]! + (a[o + 9]! - a[o + 2]!) * f;
      _qx.set(a[o + 3]!, a[o + 4]!, a[o + 5]!, a[o + 6]!).slerp(_qb.set(a[o + 10]!, a[o + 11]!, a[o + 12]!, a[o + 13]!), f);
      _rot.x = _qx.x;
      _rot.y = _qx.y;
      _rot.z = _qx.z;
      _rot.w = _qx.w;
      body.setNextKinematicTranslation(_v);
      body.setNextKinematicRotation(_rot);
    }
  }

  /**
   * After a step: a part that has just hit something (`HIT_DV`) gives at each of its joints (`give`), once per hit (a hit
   * runs a few steps; only its first counts). His torso touching down for the first time damps him harder from then on.
   * Velocities are recorded after the giving, so its own change is not read as the next hit.
   */
  private hits(s: number, d: Doll): void {
    const o = s * PARTS.length * 4;
    for (let k = 0; k < PARTS.length; k++) {
      const v = d.bodies[k]!.linvel();
      const i = o + 4 * k;
      const fresh = this.vel[i + 3] === 3;
      const jump = !fresh && Math.hypot(v.x - this.vel[i]!, v.y - this.vel[i + 1]!, v.z - this.vel[i + 2]!) > HIT_DV;
      if (jump && this.vel[i + 3] === 0) give(d.bodies, k);
      this.vel[i + 3] = jump ? 1 : 0;
    }
    for (let k = 0; k < PARTS.length; k++) {
      const v = d.bodies[k]!.linvel();
      const i = o + 4 * k;
      this.vel[i] = v.x;
      this.vel[i + 1] = v.y;
      this.vel[i + 2] = v.z;
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
    return this.riding;
  }

  /**
   * Ride along with the dummies thrown: the camera opens on the windshield of the car the driver left, then frames
   * one dummy at a time (and any near it), cutting to the next one still moving as each comes to rest, until they all
   * lie still.
   */
  follow(): void {
    if (!this.riding) {
      const car = this.cars[this.exitCar];
      this.cam.begin(car ?? null, this.exitSpeed);
      this.primary = -1;
    }
    this.riding = true;
  }

  /** The ride's aim, eased toward the dummies' heads (`frameCamera` "held": the orbit looks at it). */
  get rideLook(): THREE.Vector3 {
    return this.cam.look;
  }

  /** Before the engine's own rigs place `camera`: back to the pose they left, under the eased one `fadeRide` drew (`RideCam.unfade`). */
  unfadeRide(camera: THREE.PerspectiveCamera): void {
    this.cam.unfade(camera);
  }

  /** After the engine's own camera has placed `camera` this frame: ease it out of the ride's last pose (`RideCam.fade`). */
  fadeRide(camera: THREE.PerspectiveCamera, wallDt: number, on: boolean): void {
    this.cam.fade(camera, wallDt, on);
  }

  /** The latest throw's torso (world) into `out`, and the sim seconds it has lain still; -1 while it is not out. */
  latest(out: THREE.Vector3): number {
    const d = this.dolls[this.lastSlot];
    if (!d?.live) return -1;
    const t = d.bodies[0]!.translation();
    out.set(t.x, t.y, t.z);
    return d.still;
  }

  /**
   * Place `camera` on the dummies being followed (`RideCam`'s shots): "none" when none is (the engine's own camera
   * runs), "held" when the user's orbit has the camera (`held`; the dummies are still tracked, no cut to another
   * while this one is out). It frames a primary dummy (the fastest still moving; the `watched` car's driver within
   * `CAM_TIE`) with any others within `CAM_NEAR` of it, and cuts to the next one once it lies still: drivers flung
   * far apart are each shown in turn, never all at once from a camera pulled back to fit them. `hold`: keep watching
   * once they lie still, always from behind (the range: its signs read down the throw, and it shows where its driver
   * came to rest). `lens`: the scene's lens (deg); `sight`: the scene's solids (the windshield and trackside eyes
   * stand clear of them).
   */
  frameCamera(camera: THREE.PerspectiveCamera, wallDt: number, hold: boolean, watched: number, held: boolean, lens: number, sight: () => Sight): RideFrame {
    if (!this.riding) return "none";
    const keep = hold || held;
    let cut = false;
    if (!this.framed(this.dolls[this.primary], keep)) {
      // The first pick, or a cut to the next dummy.
      cut = this.primary >= 0;
      let best = -Infinity;
      for (let s = 0; s < this.dolls.length; s++) {
        const d = this.dolls[s]!;
        if (!this.framed(d, keep)) continue;
        const v = d.bodies[0]!.linvel();
        const score = Math.hypot(v.x, v.y, v.z) + (d.car === watched ? CAM_TIE : 0);
        if (score <= best) continue;
        best = score;
        this.primary = s;
      }
      if (best === -Infinity) {
        this.riding = false;
        this.cam.leave(camera);
        return "none";
      }
    }
    this.blend(this.dolls[this.primary]!, 1, _r, _q);
    // The primary and every framed dummy near it: the centre of their heads, pulled back to fit their spread.
    let n = 0;
    let vx = 0;
    let vz = 0;
    const f = this.cam.framing;
    const c = f.c.set(0, 0, 0);
    for (const d of this.dolls) {
      if (!this.framed(d, keep)) continue;
      this.blend(d, 1, this.heads[n]!, _q);
      if (_r.distanceTo(this.heads[n]!) > CAM_NEAR) continue;
      const v = d.bodies[0]!.linvel();
      c.add(this.heads[n]!);
      vx += v.x;
      vz += v.z;
      n++;
    }
    c.multiplyScalar(1 / n);
    let spread = 0;
    for (let k = 0; k < n; k++) spread = Math.max(spread, this.heads[k]!.distanceTo(c));
    f.spread = Math.min(spread, CAM_NEAR);
    f.n = n;
    f.vx = vx;
    f.vz = vz;
    f.hold = hold;
    f.held = held;
    f.cut = cut;
    f.lens = lens;
    f.sight = sight;
    return this.cam.update(camera, wallDt, f);
  }

  /** Is dummy `d` out and in the ride's shot: still moving, or (`hold`) anywhere out? */
  private framed(d: Doll | undefined, hold: boolean): d is Doll {
    return d !== undefined && d.live && (hold || d.still <= CAM_STILL);
  }

  /**
   * Car i's lower box onto its crushed length, bumper to bumper by the end masses, so a thrown dummy meets a crumpled
   * nose where it is. Refit only past 2 cm: each resize hands Rapier a new shape.
   */
  private fitEnds(i: number, car: DeformableCar): void {
    _f.set(0, 0, 1).applyQuaternion(car.group.quaternion);
    const front = Math.max(endZ(car, "bumperFL"), endZ(car, "bumperFR")) + NOSE_PAD;
    const rear = Math.min(endZ(car, "bumperRL"), endZ(car, "bumperRR")) - NOSE_PAD;
    if (Math.abs(front - this.ends[2 * i]!) < 0.02 && Math.abs(rear - this.ends[2 * i + 1]!) < 0.02) return;
    this.ends[2 * i] = front;
    this.ends[2 * i + 1] = rear;
    const box = this.carBodies[i]!.collider(0);
    box.setHalfExtents({ x: LOW_HALF_X, y: LOW_HALF_Y, z: (front - rear) / 2 });
    box.setTranslationWrtParent({ x: 0, y: LOW_Y, z: (front + rear) / 2 });
  }

  dispose(): void {
    this.disposed = true;
    this.debug.dispose();
    this.mesh.removeFromParent();
    this.purses?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.world?.free();
    this.world = null;
  }

  /**
   * Kinematic proxy `i` (`body`) onto `obj`'s pose, which `moveProxies` walks it to a step at a time (disabled without
   * one, so it costs the step nothing); a jump teleports instead of flinging dummies.
   */
  private follow3(i: number, body: RigidBody, obj: THREE.Object3D | null): void {
    if (!obj) {
      if (this.on[i]) {
        body.setEnabled(false);
        this.on[i] = 0;
      }
      return;
    }
    const a = this.aim;
    const o = 14 * i;
    const p = obj.position;
    const q = obj.quaternion;
    const jump = this.teleport || !this.on[i] || Math.abs(a[o + 7]! - p.x) + Math.abs(a[o + 8]! - p.y) + Math.abs(a[o + 9]! - p.z) > 4;
    if (!this.on[i]) {
      body.setEnabled(true);
      this.on[i] = 1;
    }
    if (!jump) a.copyWithin(o, o + 7, o + 14);
    p.toArray(a, o + 7);
    q.toArray(a, o + 10);
    if (!jump) return;
    a.copyWithin(o, o + 7, o + 14);
    body.setTranslation(p, false);
    body.setRotation(q, false);
  }

  /**
   * A driver is thrown out of `cars[e.car]`: the exit pane smashes and the way out gets its cover (`onExit`) now, the
   * dummy flies now or (Rapier still loading) once it is in. The sim's own event (`EjectionWatch`), a netplay host's
   * message or a highlight clip's record: the dummy starts from the event's numbers alone, so the same event is the
   * same throw wherever it is launched.
   */
  launch(e: Ejection, cars: readonly DeformableCar[]): void {
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
    this.onExit(_c, _cq, car.velocity);
    if (this.world) this.spawn(t);
    else this.pending.push({ car: t.car, p: t.p.clone(), q: t.q.clone(), v: t.v.clone(), w: t.w.clone(), age: 0, cop: t.cop });
  }

  /** Throw `t`'s dummy into a free slot (else the oldest one's). */
  private spawn(t: Throw): void {
    let slot = this.dolls.findIndex((d) => !d.live);
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
      b.collider(0).setCollisionGroups((dollBit(slot) << 16) | G_STATIC | dollBit(slot) | (G_CARS & ~carBit(t.car)));
      b.setEnabled(true);
      b.wakeUp();
    }
    const speed = Math.hypot(t.v.x, t.v.z);
    this.buildPatch(d, t.p.x + (speed > 0.5 ? (t.v.x / speed) * PATCH_AHEAD : 0), t.p.z + (speed > 0.5 ? (t.v.z / speed) * PATCH_AHEAD : 0), t.p.y);
    d.live = true;
    d.age = 0;
    d.still = 0;
    d.car = t.car;
    d.calm = 0;
    for (let k = 0; k < PARTS.length; k++) this.vel[(slot * PARTS.length + k) * 4 + 3] = 3;
    if (d.ground) {
      d.ground = false;
      d.settled = false;
      for (const b of d.bodies) {
        b.setLinearDamping(AIR_LINEAR);
        b.setAngularDamping(AIR_ANGULAR);
      }
    }
    this.capture(d, d.prev);
    d.cur.set(d.prev);
    const look = driverLook(this.lookSeed, t.car);
    this.mesh.dress(slot, t.cop, look);
    if (look.woman && !t.cop) this.purses?.launch(slot, t.car, t.p, t.v, this.lookSeed);
    // The first dummy out starts the stepping afresh: no leftover from an earlier throw shifts this one's first step.
    if (this.live === 0) this.acc = 0;
    this.teleport ||= this.live === 0;
    this.live++;
    this.lastSlot = slot;
    this.mesh.visible = true;
    this.exitCar = t.car;
    this.exitSpeed = Math.hypot(t.v.x, t.v.z);
    if (this.sandbox) this.onThrow(t.car);
  }

  /** The course a throw collides with (`knocked(i)`: placed prop `i` is off its spot). Its solids are built at the first throw on it, as recipes: Rapier colliders live only from a throw to its despawn. */
  setCourse(track: Track, placed: readonly Placed[], knocked: (prop: number) => boolean): void {
    this.course = { track, placed, knocked };
    this.solids = null;
  }

  /** The ground under a throw (`groundColliders`): built once for the pad, the disc or the corkscrew, per dummy on a course. */
  private buildPatch(d: Doll, cx: number, cz: number, y: number): void {
    const c = this.course;
    const onCourse = c !== null && activeGround() === c.track.ground();
    if (!onCourse && this.statics.length > 0) return;
    if (c && onCourse) this.solids ??= courseSolids(c.track, c.placed);
    const course = c && onCourse ? { track: c.track, solids: this.solids!, knocked: c.knocked } : null;
    (onCourse ? d.patch : this.statics).push(...groundColliders(this.R!, this.world!, FIXED_GROUPS, course, this.sand, this.bowlR, this.poles, cx, cz, y));
  }

  private despawn(s: number): void {
    const d = this.dolls[s]!;
    if (d.live) this.live--;
    d.live = false;
    for (const b of d.bodies) b.setEnabled(false);
    for (const c of d.patch) this.world!.removeCollider(c, false);
    d.patch.length = 0;
    this.mesh.hide(s);
    this.purses?.clear(s);
    this.debug.hide(s);
    if (this.live === 0) this.mesh.visible = false;
  }
}
