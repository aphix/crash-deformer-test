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
import type { Collider, RigidBody, World } from "@dimforge/rapier3d-simd";
import type { DeformableCar } from "../vehicle/car.ts";
import { CLASS_LIFT } from "../vehicle/constants.ts";
import type { CarCage } from "../vehicle/car-cage.ts";
import { activeGround, type Ground } from "../world/ground.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import type { Track } from "../world/track.ts";
import type { Placed } from "../world/placements.ts";
import { ejectionVelocity, type Ejection } from "../vehicle/ejection.ts";
import { GLASS_NAMES, glassCorners } from "../vehicle/car-glass.ts";
import { carClass, classStats } from "../vehicle/vehicle-classes.ts";
import { disable, loadRapier, type Rapier } from "../kernel/rapier.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { driverLook, pickedLook } from "./driver-look.ts";
import type { PersonPick } from "../match/look-data.ts";
import type { SprayBitmap } from "./spray.ts";
import { Purses, PURSE_BODIES } from "./ragdoll-purse.ts";
import { CAR_BOX, PropBodies } from "./ragdoll-props.ts";
import { BOX_FLOATS, PANE_GONE, PANE_HALF, PANES, PROXY_BOXES, ProxyFitter, UNDER } from "./ragdoll-proxy.ts";
import type { PropTumble } from "./prop-tumble.ts";
import { RagdollDebug } from "./ragdoll-debug.ts";
import { RideCam, type RideFrame } from "./ride-cam.ts";
import type { Sight } from "./spectate-cam.ts";
import { AIR_ANGULAR, AIR_LINEAR, ARM, blendPose, CALM_FOR, GROUND_ANGULAR, GROUND_LINEAR, give, isCalm, JOINTS, limit, PARTS, readPose, SETTLE_AFTER, SETTLE_ANGULAR, SETTLE_LINEAR, SHOULDER_Y } from "./ragdoll-body.ts";
import { joinUp } from "./ragdoll-joints.ts";
import { groundColliders, PATCH_AHEAD, PATCH_HALF, type Pole } from "./ragdoll-ground.ts";
import { courseSolids, type Solid } from "./ragdoll-solids.ts";
import { hypot2, hypot3 } from "../kernel/physics-core.js";

/** Live dummies at once; a fifth throw recycles the oldest. */
const SLOTS = 4;
/** Seconds a dummy lies about before it goes. */
const LIFE = 10;
/** Seconds after the throw the dummy ignores its own car and the other dummies (the collision groups below): it
 *  starts inside its own cabin, over its own lower box. */
const GRACE = 0.35;
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
 * Rapier's step (sim s) while a dummy is out, the same at any display rate: `update` takes whole steps out of an accumulator and the draw
 * blends the last two (it once stepped per frame, and Rapier warm-starts with the last step's impulse: landings 25.6–58.1 m).
 * 1/960 was 1/120 (lane ragdoll-rate): the slow-mo is 0.032×, so 1/120 was 273 ms of wall time, 3.7 poses a real second
 * drawn as chords, 8.3 sim ms behind the cars that step every frame. 1/480 (owner, 2026-10-06: half the steps, each
 * twice as long, the draw still blending every frame): 65 ms of slow-mo wall time a step, 2.1 sim ms behind the cars.
 * Tables: docs/CINEMATIC.md.
 */
const STEP = 1 / 480;
/**
 * The step (sim s) while knocked props alone are out and none moves fast: rigid shapes with no joints to tear, with CCD
 * (`PropBodies`) for the walls a coarser step would get wrong. Headless City, 32 cars, the props' 32 m patch: 2 steps of
 * 0.079 ms a stepping frame against 8 of 0.047 at 1/480 (Rapier's profiler).
 */
const PROP_STEP = 1 / 120;
/**
 * A knocked prop any point of whose own shape moves faster than this (m/s: its middle's speed plus its turn times its
 * reach) keeps the world at `STEP`: at 1/120, CCD and soft CCD on, a spinning cone flung at 31 m/s landed with its tip
 * 110 mm in the ground. Measured over 80 run-overs of a lying cone at 10-40 m/s (deepest lowest point under the ground):
 * 110.8 mm at 1/120 throughout, 50.4 with this at 12 m/s, 22.8 at 8, 23.0 at 1/480 throughout; the race's knocks (City,
 * 32 cars, seeds 2-4, 17 props) at most 21 mm.
 */
const PROP_FAST = 8;
/** The skin's hits, the spin limit and the purses are judged at this interval (sim s) whatever `STEP` is: `HIT_DV` is a speed change per interval. */
const WATCH = 1 / 120;
const WATCH_EVERY = Math.round(WATCH / STEP);
/** Most sim seconds one frame steps: a longer hitch drops the rest instead of spiralling (the cars drop beyond 0.05 too). */
const MAX_ACC = 0.05;
/** A car moving faster than this (m/s) and this near (m) to a dummy that lies asleep keeps the world stepping (a car moves 1.2 m a frame at 70 m/s; a wreck lying beside him does not); the barrier's reach is its half diagonal. A sleeping knocked prop is stirred only by such a car that can touch it this frame (`PropBodies.touches`). */
const WAKE_SPEED = 0.5;
const WAKE_NEAR = 10;
/**
 * A car's proxy is in the world only while a dummy's torso is within `DOLL_REACH` (torso centre to the tip of a limb, m) plus
 * `NEAR_MARGIN` (m) of the car's box, or a purse thing within `PURSE_REACH` (m) of its reach, and `NEAR_HOLD` (m) more once it is in:
 * every collider in Rapier's world costs every step (`addCuboid`).
 */
const DOLL_REACH = 1.5;
const PURSE_REACH = 0.5;
const NEAR_MARGIN = 0.5;
const NEAR_HOLD = 0.5;
const BARRIER_REACH = hypot2(BARRIER_HALF.x, BARRIER_HALF.z);
/** Rapier's solver iterations (default 4); no CCD on the parts (it tears the joints: 11–28 cm apart vs 0.9 cm at 8 iterations of 1/120). At 1/960 four hold a joint to 0.1 cm; two kicked one to 125 rad/s. */
const ITERATIONS = 4;
/** Rapier's internal solver passes per iteration (default 1): at the first touch of a 29 m/s throw one pass rose energy 75–325 J in a frame at 1/120 and 26–30 J (1 of 5 runs) at 1/480 and 1/960; two at most 0.6 J over 60 runs (60/144/240 Hz). */
const INTERNAL_PASSES = 2;
/**
 * The band of a car (m, car-local, origin on the ground) a standing prop meets: its bumper band, 5 cm up to the bonnet line.
 * The props' squeeze (`PropBodies.press`) takes the car as a box of the cage's plan this high (and `UNDER` under the ground).
 */
const PROP_BAND_LOW = 0.05;
const PROP_BAND_HIGH = 0.85;
/** A car proxy's reach (m) until its first fit (`shape`): over a cage's plan (a sedan's 0.8 × 1.95 m, a hair more) and `UNDER`. */
const FIRST_REACH = hypot3(1, UNDER, 2.2);
/** A pane's bounce (restitution, the higher of the pair counts, so it beats the dummy's 0): a torso that cracks it comes off it. */
const PANE_BOUNCE = 0.3;
/** All six panes shattered (`glassBits`): nothing left for a torso to strike. */
const ALL_GONE = 0xaaa;
/**
 * Glass rule (owner, 2026-10-06): a dummy's torso (never a limb or the head) that touches another car's pane while closing
 * on it at this speed (m/s) or faster strikes it (`hitGlass`): an intact pane cracks and holds, so he bounces off; a cracked
 * one shatters, so he goes through. 4 m/s is the speed change the skin already counts as a hit (`HIT_DV`): a torso slid,
 * rolled or dropped against a pane (under 1 m/s lying, about 3 m/s off a car's roof height) or coming back off a hit's
 * bounce (`PANE_BOUNCE` × the hit) does nothing; every throw into a car (car speed + 3 m/s out) is over it.
 */
const GLASS_FLOOR = 4;
/** Panes are tried for a torso whose centre is this near (m) a car's origin (its farthest pane corner is 2.2 m out), plus both speeds' frame of travel. */
const GLASS_REACH = 3;
/** How far out (m) a pane is looked at for a coming touch, and the gap past which a touch has ended (a new one can strike). */
const GLASS_SEE = 0.15;
const GLASS_SEP = 0.03;
/** A torso this near (m) a pane, past what it closes in one step, is on it: Rapier's contacts start within millimetres. */
const GLASS_SKIN = 0.005;

/**
 * Collision groups (membership << 16 | filter), 16 bits: the world; each dummy slot; each car (its lower box, bumper
 * to bonnet line, fitted to its crushed length, and its cabin's slabs), in 10 buckets of car index; the props. Out of
 * the car a dummy hits everything but its own jointed neighbours (`setContactsEnabled(false)`) and the purses. For
 * `GRACE` s after the throw it ignores its own car (it starts inside it) and the other dummies; every other car it hits
 * from the first frame.
 */
const G_STATIC = 1;
const dollBit = (s: number) => 2 << s;
const G_DOLLS = 0x1e;
/** Car i's bit; a dummy with no car of his own (`place`, car -1) has none, so he hits every car from the first frame. */
const carBit = (i: number) => (i < 0 ? 0 : 0x40 << i % 10);
const G_CARS = 0xffc0;
const G_PROPS = 0x20;
const dollGroups = (s: number) => (dollBit(s) << 16) | G_STATIC | G_DOLLS | G_CARS | G_PROPS;
/** A woman's purse and what falls out of it hit the world, the barrier and every car (not their own for `GRACE` s), never a dummy. */
const propGroups = (car: number) => (G_PROPS << 16) | G_STATIC | (car < 0 ? G_CARS : G_CARS & ~carBit(car));
/** A knocked prop (`PropBodies`) hits the world, the dummies, every car (not the one that knocked it for `GRACE` s, nor one squeezing it while its box covers it) and the other knocked props; a purse lets it by. */
const knockedGroups = (car: number) => (G_PROPS << 16) | G_STATIC | G_DOLLS | G_PROPS | (car < 0 ? G_CARS : G_CARS & ~carBit(car));
const FIXED_GROUPS = (G_STATIC << 16) | G_DOLLS | G_PROPS;
/** Car i's leaves (`ProxyFitter`) and standing panes; a gone pane's slab collides with nothing (Rapier kept a disabled slab on a moving kinematic body in contact). */
const carGroups = (i: number) => (carBit(i) << 16) | G_DOLLS | G_PROPS;

type Doll = {
  bodies: RigidBody[];
  live: boolean;
  age: number;
  /** Sim seconds he lies about before he goes: `LIFE` for a thrown driver, as long as the scene wants for a placed one (`place`). */
  life: number;
  /** Sim seconds the torso has been under `REST_SPEED`. */
  still: number;
  patch: Collider[];
  /** The car he was thrown from. */
  car: number;
  /** The ride-along may frame him (`launch`'s `rides`). */
  rides: boolean;
  /** Each part's pose (position xyz, rotation xyzw) after the last step and the one before it: the draw blends them. */
  prev: Float32Array;
  cur: Float32Array;
  /** Touched the ground (`touch`): damped harder from then on. */
  ground: boolean;
  /** Lying settled (`calm`): damped harder still. */
  settled: boolean;
  /** Sim seconds he has been under `CALM_ENERGY` (`calm`). */
  calm: number;
  /** Torso speed (m/s) at the end of the last frame: how far he may travel toward a pane in the next (`glassNear`). */
  speed: number;
};

/** A throw, placed: car (-1: none, `place`), torso point and orientation, linear and angular velocity (world), sim seconds waiting, a police driver, whether the ride-along may frame him. */
type Throw = { car: number; p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; w: THREE.Vector3; age: number; cop: boolean; rides: boolean };

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
  private readonly dolls: Doll[] = [];
  private readonly carBodies: RigidBody[] = [];
  /** Each car's lower box for the props' squeeze as last fitted, `CAR_BOX` floats (`PropBodies.press`): centre height and forward offset, half extents. */
  private readonly boxes = new Float64Array(MAX_CARS * CAR_BOX);
  /** Each car proxy's reach (m): the farthest point of its plan and height from the car's origin (`shape`; `FIRST_REACH` until it is first fitted). */
  private readonly reach = new Float32Array(MAX_CARS).fill(FIRST_REACH);
  /** Each car's leaves, `PROXY_BOXES` per car, and how many are fitted: its lower box, columns and slabs (`ProxyFitter`). */
  private readonly shapes: (Collider | null)[] = Array.from({ length: MAX_CARS * PROXY_BOXES }, () => null);
  private readonly shapeN = new Uint8Array(MAX_CARS);
  /** Each car's pane slabs, `PANES` per car, in `GLASS_NAMES` order. */
  private readonly panes: (Collider | null)[] = Array.from({ length: MAX_CARS * PANES }, () => null);
  private readonly fitter = new ProxyFitter();
  /** Each car's fitted leaves and pane slabs (`BOX_FLOATS` each), kept for `cull`, which puts those near a dummy in the world; and whether a knocked prop or purse thing is near it (all of them then). */
  private readonly leafFits = new Float64Array(MAX_CARS * PROXY_BOXES * BOX_FLOATS);
  private readonly paneFits = new Float64Array(MAX_CARS * PANES * BOX_FLOATS);
  private readonly whole = new Uint8Array(MAX_CARS);
  /** `cull`'s dummy points in a car's frame: x, y, z and the distance (m) a leaf's sphere must be within, 4 per dummy. */
  private readonly pts = new Float64Array(4 * SLOTS * (1 + PURSE_BODIES));
  /** The car each slot's proxy was last fitted to (`fitProxy`), its glass corners, its body lift (m), the cage fit it was fitted from (`CarCage.serial`), and its glass state as the slabs show it (`glassBits`, -1: refit). */
  private readonly fitted: (DeformableCar | null)[] = Array.from({ length: MAX_CARS }, () => null);
  private readonly glass: Float32Array[] = Array.from({ length: MAX_CARS }, () => new Float32Array(0));
  /** Each slot's drawn body (`frame`): the car's class body, null for none, and its frame in the world, which the proxy follows. */
  private readonly drawn: (THREE.Object3D | null)[] = Array.from({ length: MAX_CARS }, () => null);
  private readonly frames = Array.from({ length: MAX_CARS }, () => new THREE.Object3D());
  private readonly lift = new Float64Array(MAX_CARS);
  private readonly serial = new Int32Array(MAX_CARS);
  private readonly paneBits = new Int32Array(MAX_CARS).fill(-1);
  /** Per dummy slot, the cars whose panes his torso may reach this frame (`glassNear`) and how many; per slot and car, the panes he is touching (bits). */
  private readonly nearCars = new Uint8Array(SLOTS * MAX_CARS);
  private readonly nearN = new Uint8Array(SLOTS);
  private readonly touching = new Uint8Array(SLOTS * MAX_CARS);
  private barrierBody: RigidBody | null = null;
  private live = 0;
  /** Throws judged before Rapier was in (`PENDING_MAX`). */
  private readonly pending: Throw[] = [];
  private readonly next: Throw = { car: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false, rides: true };
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
  /** Sim seconds the world has not stepped yet (under a step after each frame), and how far into the next step the draw is; the step of the frame that last stepped (`STEP` with a dummy out, else `PROP_STEP`). */
  private acc = 0;
  private step = STEP;
  /** Steps since the first dummy out: every `WATCH_EVERY`th one the skin, spin limit and purses are watched. */
  private tick = 0;
  private alpha = 0;
  /** The last frame stepped nothing (`dormant`), so the proxies are where the cars were when it began. */
  private slept = false;
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
  /** The point he left the car from: the windshield eye must see it (`RideCam.begin`). */
  private readonly exitPane = new THREE.Vector3();
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
    for (let i = 0; i < MAX_CARS; i++) this.carBodies.push(world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, i * 10)));
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
      this.dolls.push({ bodies, live: false, age: 0, life: LIFE, still: 0, patch: [], car: -1, rides: false, prev: new Float32Array(PARTS.length * 7), cur: new Float32Array(PARTS.length * 7), ground: false, settled: false, calm: 0, speed: 0 });
    }
    // A child of the dummies' mesh, so the scene root keeps its one `ragdolls` child and the props draw only while a dummy is out.
    this.mesh.add((this.purses = new Purses(R, world, SLOTS, propGroups, GRACE)).mesh);
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
    this.riding = false;
    this.cam.leave(null);
    for (let s = 0; s < this.dolls.length; s++) this.despawn(s);
    this.props.clear();
    for (const c of this.statics) this.world?.removeCollider(c, false);
    this.statics.length = 0;
  }

  /**
   * One frame: step the dummies and the knocked props `dt` sim seconds against the cars' poses (`authority`: this peer
   * owns the glass, so it smashes the exit pane of a throw). `sandbox`: neither a race nor a derby (`onThrow`); `bowlR`:
   * the derby bowl's radius, 0 outside a derby; `barrier`: the sandbox's jersey barrier while it stands, else null. Who
   * is thrown is not decided here (`launch`); a throw launched before Rapier is in waits for it, up to `PENDING_MAX`; a
   * prop knocked before it is in flies once it is.
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
    this.wake();
    this.props.here(this.course !== null && activeGround() === this.course.ground);
    if (this.live === 0 && this.props.count === 0) {
      for (let i = 0; i < MAX_CARS; i++) this.follow3(i, this.carBodies[i]!, null);
      return;
    }
    const dormant = this.dormant(cars, barrier, dt);
    // The proxies stood still while nothing stepped: jump them to where the cars are now instead of flinging dummies.
    this.teleport ||= this.slept;
    this.slept = dormant;
    for (let i = 0; i < MAX_CARS; i++) {
      const car = i < cars.length && !cars[i]!.falling && !cars[i]!.vaporized && this.near(i, cars[i]!, dt) ? cars[i]! : null;
      if (car) this.frame(i, car);
      this.follow3(i, this.carBodies[i]!, car ? this.frames[i]! : null);
      if (car) {
        this.fitProxy(i, car);
        this.cull(i, false, dt);
      }
      // Its lower box where this frame's steps take it: a knocked prop it would squeeze against a wall lets it by.
      if (car) this.props.press(i, car.group.position, car.group.quaternion, this.boxes);
    }
    this.follow3(MAX_CARS, this.barrierBody!, barrier);
    this.teleport = false;
    this.glassNear(dt);
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
      this.moveProxies(Math.min(1, (j * step - lead) / dt));
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
      this.glassTouch();
      world.step();
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
      d.still = d.speed < REST_SPEED ? d.still + dt : 0;
      this.calm(d, dt);
      for (let k = 0; k < PARTS.length; k++) {
        this.blend(d, k, _p, _q);
        this.mesh.pose(s, k, _p, _q);
        if (this.debug.on) this.debug.pose(s, k, _p, _q);
      }
    }
    this.purses?.pose(this.alpha);
    this.props.advance(dt, this.step);
    this.props.pose(this.alpha);
  }

  /**
   * Nothing to step: every dummy, purse thing and knocked prop lies asleep; no car moving over `WAKE_SPEED` nor the
   * barrier is within `WAKE_NEAR` of a dummy, no such car can touch a knocked prop this frame (`touches`), and the
   * barrier is not within `WAKE_NEAR` of one.
   */
  private dormant(cars: readonly DeformableCar[], barrier: THREE.Object3D | null, dt: number): boolean {
    if (this.purses && !this.purses.asleep()) return false;
    if (!this.props.asleep()) return false;
    for (const d of this.dolls) {
      if (!d.live) continue;
      if (!d.bodies[0]!.isSleeping() || this.stirred(_r.set(d.cur[0]!, d.cur[1]!, d.cur[2]!), cars, barrier)) return false;
    }
    if (barrier && this.props.touches(barrier.position, WAKE_NEAR + BARRIER_REACH, 0, 0)) return false;
    for (let i = 0; i < cars.length && i < MAX_CARS; i++) {
      const car = cars[i]!;
      if (!car.falling && !car.vaporized && car.velocity.lengthSq() > WAKE_SPEED ** 2 && this.props.touches(car.group.position, this.reach[i]!, car.velocity.length(), dt)) return false;
    }
    return true;
  }

  /** Is the barrier, or a car moving over `WAKE_SPEED`, within `WAKE_NEAR` of `p`? */
  private stirred(p: THREE.Vector3, cars: readonly DeformableCar[], barrier: THREE.Object3D | null): boolean {
    if (barrier && barrier.position.distanceTo(p) < WAKE_NEAR + BARRIER_REACH) return true;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (!car.falling && !car.vaporized && car.velocity.lengthSq() > WAKE_SPEED ** 2 && car.group.position.distanceTo(p) < WAKE_NEAR) return true;
    }
    return false;
  }

  /**
   * Does car `i` need its proxy in the world: a dummy out (his torso as last stepped) within `DOLL_REACH` (a limb's length) plus
   * `NEAR_MARGIN` and two frames of both their travels of the car's box (`CAR_BOX`, its sphere of `reach` before its first fit), a
   * purse thing within its reach, or a knocked prop it can touch within a frame of `dt` (`touches`: both reaches plus both
   * travels)? A car further out cannot touch them this
   * frame. A proxy already in the world stays until `NEAR_HOLD` m further out (no building and dropping a hundred colliders on
   * a car hovering at the edge). A car that gets in from outside in one frame moved over 4 m, which `follow3` teleports for
   * anyway, so the proxy it gets is the one it had.
   */
  private near(i: number, car: DeformableCar, dt: number): boolean {
    const p = car.group.position;
    // The props first, as before any dummy: a car that can touch a knocked prop this frame gets its whole proxy (`cull`).
    const whole = this.props.touches(p, this.reach[i]!, car.velocity.length(), dt);
    this.whole[i] = whole ? 1 : 0;
    if (whole) return true;
    const hold = this.on[i] ? NEAR_HOLD : 0;
    const frame = Math.min(dt, MAX_ACC);
    const speed = car.velocity.length();
    // The car's box as fitted (`CAR_BOX`: its centre height, forward offset and half extents, in the car's frame), else its reach sphere.
    const b = i * CAR_BOX;
    const boxed = this.boxes[b + 2]! > 0;
    if (boxed) _cq.copy(car.group.quaternion).invert();
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      if (!d.live) continue;
      const r = DOLL_REACH + NEAR_MARGIN + hold + 2 * (speed + d.speed) * frame;
      _c.set(d.cur[0]! - p.x, d.cur[1]! - p.y, d.cur[2]! - p.z);
      if (!boxed) {
        const reach = r + this.reach[i]!;
        if (_c.lengthSq() < reach * reach) return true;
        continue;
      }
      _c.applyQuaternion(_cq);
      const ex = Math.max(Math.abs(_c.x) - this.boxes[b + 2]!, 0);
      const ey = Math.max(Math.abs(_c.y - this.boxes[b]!) - this.boxes[b + 3]!, 0);
      const ez = Math.max(Math.abs(_c.z - this.boxes[b + 1]!) - this.boxes[b + 4]!, 0);
      if (ex * ex + ey * ey + ez * ez < r * r) return true;
    }
    return this.purses !== null && this.purses.near(p, this.reach[i]! + PURSE_REACH + NEAR_MARGIN + hold);
  }

  /** Part `k` of `d` as drawn: `alpha` of the way from its pose one step before the last to the last. */
  private blend(d: Doll, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    blendPose(d.prev, d.cur, 7 * k, this.alpha, p, q);
  }

  private capture(d: Doll, into: Float32Array): void {
    for (let k = 0; k < PARTS.length; k++) readPose(d.bodies[k]!, into, 7 * k);
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
    return this.riding;
  }

  /**
   * Ride along with the dummies thrown: the camera opens on the windshield of the car the driver left, then frames
   * one dummy at a time (and any near it), cutting to the next one still moving as each comes to rest, until they all
   * lie still. A driver thrown while it rides, out of its shot (further than `CAM_NEAR` from the heads it frames), is the
   * moment now: it opens again on his windshield, framing him.
   */
  follow(): void {
    const d = this.dolls[this.lastSlot];
    const c = this.cam.framing.c;
    // Drivers thrown in the same frame (a head-on's two) open one ride: a far one counts once the ride has framed.
    const away = this.riding && !this.cam.fresh && d !== undefined && d.live && hypot3(d.cur[0]! - c.x, d.cur[1]! - c.y, d.cur[2]! - c.z) > CAM_NEAR;
    if (!this.riding || away) {
      this.cam.begin(this.cars[this.exitCar] ?? null, this.exitSpeed, this.exitPane);
      this.primary = away ? this.lastSlot : -1;
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

  /** The latest throw lies settled on the ground (`calm`): he has landed. */
  get latestSettled(): boolean {
    const d = this.dolls[this.lastSlot];
    return d !== undefined && d.live && d.settled;
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
        const score = hypot3(v.x, v.y, v.z) + (d.car === watched ? CAM_TIE : 0);
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

  /** Is dummy `d` out and in the ride's shot: one it may frame, still moving, or (`hold`) anywhere out? */
  private framed(d: Doll | undefined, hold: boolean): d is Doll {
    return d !== undefined && d.live && d.rides && (hold || d.still <= CAM_STILL);
  }

  /**
   * Slot i's frame onto the drawn body of `car`: its class body (`classLift`, lifted and swayed on its springs) in the world, or
   * the whole car's when it has none. The proxy's colliders lie in the body mesh's own frame, the cage's.
   */
  private frame(i: number, car: DeformableCar): void {
    if (this.fitted[i] !== car) this.drawn[i] = car.group.getObjectByName(CLASS_LIFT) ?? null;
    const frame = this.frames[i]!;
    const body = this.drawn[i]!;
    if (body === null) {
      frame.position.copy(car.group.position);
      frame.quaternion.copy(car.group.quaternion);
      return;
    }
    frame.position.copy(body.position).applyQuaternion(car.group.quaternion).add(car.group.position);
    frame.quaternion.copy(car.group.quaternion).multiply(body.quaternion);
  }

  /**
   * Car i's proxy onto `car`'s cage (`ProxyFitter`: the lower box and leaves from its fields, a slab at each pane of its glass)
   * when the slot holds another car, its class lift changed, the cage refit (`CarCage.serial`) or a pane's state changed (a
   * standing pane is the surface over its leaves, a gone one leaves the cage's own top), and each pane's slab in the world only
   * while the pane stands (`glassBits`).
   */
  private fitProxy(i: number, car: DeformableCar): void {
    const lift = classStats(carClass(car)).lift;
    car.refitCage();
    const cage = car.cage;
    const bits = car.glassBits();
    if (this.fitted[i] !== car || this.lift[i] !== lift || this.serial[i] !== cage.serial || bits !== this.paneBits[i]) {
      if (this.fitted[i] !== car || this.lift[i] !== lift) this.paneBits[i] = -1;
      if (this.fitted[i] !== car) this.glass[i] = glassCorners(car.style);
      this.fitted[i] = car;
      this.lift[i] = lift;
      this.serial[i] = cage.serial;
      this.shape(i, cage, lift, bits);
    }
    this.paneBits[i] = bits;
  }

  /**
   * The cuboid at float offset `o` of `boxes` (`BOX_FLOATS` each) as a new collider of car `i`'s proxy. The world holds a collider only while it is
   * fitted: each one in it costs every `world.step()`, a parked one with no contact included (measured, 32-car city race with one
   * dummy out: 4 362 colliders, 35 ms a frame; 266 with the leaves removed, 0.8 ms).
   */
  private addCuboid(i: number, boxes: Float64Array, o: number, pane: boolean): Collider {
    const R = this.R!;
    const desc = R.ColliderDesc.cuboid(boxes[o + 3]!, boxes[o + 4]!, boxes[o + 5]!)
      .setTranslation(boxes[o]!, boxes[o + 1]!, boxes[o + 2]!)
      .setRotation({ x: boxes[o + 6]!, y: boxes[o + 7]!, z: boxes[o + 8]!, w: boxes[o + 9]! })
      .setCollisionGroups(carGroups(i));
    if (pane) desc.setRestitution(PANE_BOUNCE).setRestitutionCombineRule(R.CoefficientCombineRule.Max);
    return this.world!.createCollider(desc, this.carBodies[i]!);
  }

  /** Car `i`'s proxy out of the world (its leaves and slabs removed); `fitProxy` builds it again when a dummy or prop comes near. */
  private drop(i: number): void {
    const world = this.world!;
    for (let k = 0; k < this.shapeN[i]!; k++) {
      const c = this.shapes[i * PROXY_BOXES + k];
      if (!c) continue;
      world.removeCollider(c, false);
      this.shapes[i * PROXY_BOXES + k] = null;
    }
    this.shapeN[i] = 0;
    for (let p = 0; p < PANES; p++) {
      const c = this.panes[i * PANES + p];
      if (!c) continue;
      world.removeCollider(c, false);
      this.panes[i * PANES + p] = null;
    }
    this.paneBits[i] = -1;
    this.fitted[i] = null;
  }

  /** The cuboid at float offset `o` of `boxes` (`BOX_FLOATS` each) onto collider `c`: its size, its place and its turn on the car's body. */
  private setCuboid(c: Collider, boxes: Float64Array, o: number): void {
    _v.x = boxes[o + 3]!;
    _v.y = boxes[o + 4]!;
    _v.z = boxes[o + 5]!;
    c.setHalfExtents(_v);
    _v.x = boxes[o]!;
    _v.y = boxes[o + 1]!;
    _v.z = boxes[o + 2]!;
    c.setTranslationWrtParent(_v);
    _rot.x = boxes[o + 6]!;
    _rot.y = boxes[o + 7]!;
    _rot.z = boxes[o + 8]!;
    _rot.w = boxes[o + 9]!;
    c.setRotationWrtParent(_rot);
  }

  /**
   * Car `i`'s leaves and pane slabs in the world: those a dummy's torso may meet within `DOLL_REACH` and `NEAR_MARGIN` and two
   * frames of travel (each leaf's bounding sphere), a purse thing within `PURSE_REACH` and `NEAR_MARGIN`, all of them while a knocked prop is near the car (`whole`)
   * or for `all`. One in the world stays until `NEAR_HOLD` further out. A pane that is gone has no slab.
   */
  private cull(i: number, all: boolean, dt: number): void {
    const everything = all || this.whole[i] === 1;
    let m = 0;
    if (!everything) {
      const frame = this.frames[i]!;
      _cq.copy(frame.quaternion).invert();
      const speed = this.cars[i]!.velocity.length();
      for (let s = 0; s < SLOTS; s++) {
        const d = this.dolls[s]!;
        if (!d.live) continue;
        _c.set(d.cur[0]! - frame.position.x, d.cur[1]! - frame.position.y, d.cur[2]! - frame.position.z).applyQuaternion(_cq);
        this.pts[4 * m] = _c.x;
        this.pts[4 * m + 1] = _c.y;
        this.pts[4 * m + 2] = _c.z;
        this.pts[4 * m + 3] = DOLL_REACH + NEAR_MARGIN + 2 * (speed + d.speed) * Math.min(dt, MAX_ACC);
        m++;
      }
      // Purse things too (their points come in the world's frame).
      const m0 = m;
      if (this.purses) m = this.purses.points(this.pts, m, PURSE_REACH + NEAR_MARGIN);
      for (let j = m0; j < m; j++) {
        _c.set(this.pts[4 * j]! - frame.position.x, this.pts[4 * j + 1]! - frame.position.y, this.pts[4 * j + 2]! - frame.position.z).applyQuaternion(_cq);
        this.pts[4 * j] = _c.x;
        this.pts[4 * j + 1] = _c.y;
        this.pts[4 * j + 2] = _c.z;
      }
    }
    const leafO = i * PROXY_BOXES * BOX_FLOATS;
    for (let k = 0; k < this.shapeN[i]!; k++) {
      const c = this.shapes[i * PROXY_BOXES + k];
      const want = everything || this.reaches(this.leafFits, leafO + k * BOX_FLOATS, m, c ? NEAR_HOLD : 0);
      if (want && !c) this.shapes[i * PROXY_BOXES + k] = this.addCuboid(i, this.leafFits, leafO + k * BOX_FLOATS, false);
      else if (!want && c) {
        this.world!.removeCollider(c, false);
        this.shapes[i * PROXY_BOXES + k] = null;
      }
    }
    const paneO = i * PANES * BOX_FLOATS;
    for (let p = 0; p < PANES; p++) {
      if (((this.paneBits[i]! >> (2 * p)) & 3) === PANE_GONE) continue;
      const c = this.panes[i * PANES + p];
      const want = everything || this.reaches(this.paneFits, paneO + p * BOX_FLOATS, m, c ? NEAR_HOLD : 0);
      if (want && !c) this.panes[i * PANES + p] = this.addCuboid(i, this.paneFits, paneO + p * BOX_FLOATS, true);
      else if (!want && c) {
        this.world!.removeCollider(c, false);
        this.panes[i * PANES + p] = null;
      }
    }
  }

  /** Is the cuboid at float offset `o` of `boxes` (its bounding sphere) within `hold` of any of `cull`'s `m` dummy points (car frame, reach)? */
  private reaches(boxes: Float64Array, o: number, m: number, hold: number): boolean {
    const rad = hypot3(boxes[o + 3]!, boxes[o + 4]!, boxes[o + 5]!);
    for (let j = 0; j < m; j++) {
      if (hypot3(this.pts[4 * j]! - boxes[o]!, this.pts[4 * j + 1]! - boxes[o + 1]!, this.pts[4 * j + 2]! - boxes[o + 2]!) - rad < this.pts[4 * j + 3]! + hold) return true;
    }
    return false;
  }

  /**
   * Car i's colliders fitted to `cage` raised by `lift` (`ProxyFitter`): each leaf and pane slab in its place, the leaves
   * unused (and those they replace) in or out of the world, and what the props' squeeze (`CAR_BOX`) and the reach read of the
   * car: the cage's plan extent, its height and `UNDER`.
   */
  private shape(i: number, cage: CarCage, lift: number, paneBits: number): void {
    const fitter = this.fitter;
    const f = cage.fields;
    const was = this.shapeN[i]!;
    fitter.fit(f, cage.style, cage.planField(), this.glass[i]!, paneBits);
    fitter.fitPanes(f, cage.style, this.glass[i]!);
    // The fit is kept per car: `cull` builds the leaves and slabs a dummy is near from it.
    const leafO = i * PROXY_BOXES * BOX_FLOATS;
    for (let n = 0; n < fitter.count * BOX_FLOATS; n++) this.leafFits[leafO + n] = fitter.boxes[n]!;
    const paneO = i * PANES * BOX_FLOATS;
    for (let n = 0; n < PANES * BOX_FLOATS; n++) this.paneFits[paneO + n] = fitter.panes[n]!;
    this.shapeN[i] = fitter.count;
    // Those in the world now: refitted, or out of it past the fitted count (and a pane that is gone).
    for (let k = 0; k < was; k++) {
      const c = this.shapes[i * PROXY_BOXES + k];
      if (!c) continue;
      if (k < fitter.count) this.setCuboid(c, this.leafFits, leafO + k * BOX_FLOATS);
      else {
        this.world!.removeCollider(c, false);
        this.shapes[i * PROXY_BOXES + k] = null;
      }
    }
    for (let p = 0; p < PANES; p++) {
      const c = this.panes[i * PANES + p];
      if (!c) continue;
      if (((paneBits >> (2 * p)) & 3) === PANE_GONE) {
        this.world!.removeCollider(c, false);
        this.panes[i * PANES + p] = null;
      } else this.setCuboid(c, this.paneFits, paneO + p * BOX_FLOATS);
    }
    const width = Math.max(-f.planBox[0]!, f.planBox[1]!);
    const length = Math.max(-f.planBox[2]!, f.planBox[3]!);
    this.reach[i] = hypot3(width, Math.max(f.heightMax + lift, UNDER), length) + cage.style.step;
    const b = i * CAR_BOX;
    this.boxes[b] = (lift + PROP_BAND_HIGH - UNDER) / 2;
    this.boxes[b + 1] = (f.planBox[2]! + f.planBox[3]!) / 2;
    this.boxes[b + 2] = width;
    this.boxes[b + 3] = (PROP_BAND_HIGH + UNDER) / 2;
    this.boxes[b + 4] = (f.planBox[3]! - f.planBox[2]!) / 2;
  }

  /** Per dummy, the cars (never his own) with a pane standing that his torso may reach within this frame: `glassTouch` tries only those. */
  private glassNear(dt: number): void {
    const cars = this.cars;
    const a = this.aim;
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      let n = 0;
      for (let i = 0; d.live && i < cars.length && i < MAX_CARS; i++) {
        if (i === d.car || !this.on[i] || this.paneBits[i] === ALL_GONE) continue;
        const o = 14 * i + 7;
        const dx = d.cur[0]! - a[o]!;
        const dy = d.cur[1]! - a[o + 1]!;
        const dz = d.cur[2]! - a[o + 2]!;
        const reach = GLASS_REACH + (d.speed + cars[i]!.speed) * dt;
        if (dx * dx + dy * dy + dz * dz < reach * reach) this.nearCars[s * MAX_CARS + n++] = i;
      }
      this.nearN[s] = n;
    }
  }

  /**
   * Before a step: each dummy's torso against the standing panes of the cars near it (`glassNear`). A touch closing at
   * `GLASS_FLOOR` or faster strikes the pane once (`hitGlass`; this peer's glass only, `authority`): a pane it shatters
   * leaves the world before the step, so he goes through; one it cracks stays, so Rapier bounces him off it. A touch lasts
   * until he is `GLASS_SEP` off the pane again. Rapier is read (allocating) only for a torso within `GLASS_SEE` of a pane.
   */
  private glassTouch(): void {
    for (let s = 0; s < SLOTS; s++) {
      const n = this.nearN[s]!;
      if (n === 0) continue;
      const d = this.dolls[s]!;
      const torso = d.bodies[0]!.collider(0);
      for (let m = 0; m < n; m++) {
        const i = this.nearCars[s * MAX_CARS + m]!;
        const t = s * MAX_CARS + i;
        for (let p = 0; p < PANES; p++) {
          if (((this.paneBits[i]! >> (2 * p)) & 3) === 2) continue;
          const bit = 1 << p;
          const pane = this.panes[i * PANES + p];
          const c = pane ? torso.contactCollider(pane, GLASS_SEE) : null;
          const held = (this.touching[t]! & bit) !== 0;
          if (c === null || (held && c.distance > GLASS_SEP)) {
            this.touching[t] = this.touching[t]! & ~bit;
            continue;
          }
          if (held) continue;
          const v = d.bodies[0]!.linvel();
          const cv = this.cars[i]!.velocity;
          const closing = (v.x - cv.x) * c.normal1.x + (v.y - cv.y) * c.normal1.y + (v.z - cv.z) * c.normal1.z;
          // Not on the pane within this step yet.
          if (c.distance > Math.max(0, closing) * STEP + GLASS_SKIN) continue;
          this.touching[t] = this.touching[t]! | bit;
          if (closing < GLASS_FLOOR || !this.authority) continue;
          const car = this.cars[i]!;
          car.hitGlass(GLASS_NAMES[p]!);
          this.fitProxy(i, car);
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
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
   * Kinematic proxy `i` (`body`) onto `obj`'s pose, which `moveProxies` walks it to a step at a time (disabled without
   * one, so it costs the step nothing); a jump teleports instead of flinging dummies.
   */
  private follow3(i: number, body: RigidBody, obj: THREE.Object3D | null): void {
    if (!obj) {
      if (this.on[i]) {
        if (i < MAX_CARS) this.drop(i);
        disable(body);
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
      if (i === MAX_CARS) body.collider(0).setCollisionGroups(FIXED_GROUPS);
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
    if (this.world) this.spawn(t);
    else this.pending.push({ car: t.car, p: t.p.clone(), q: t.q.clone(), v: t.v.clone(), w: t.w.clone(), age: 0, cop: t.cop, rides: t.rides });
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
  private spawn(t: Throw, at = -1, life = LIFE): number {
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
      b.collider(0).setCollisionGroups((dollBit(slot) << 16) | G_STATIC | dollBit(slot) | G_PROPS | (G_CARS & ~carBit(t.car)));
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
    this.touching.fill(0, slot * MAX_CARS, (slot + 1) * MAX_CARS);
    this.nearN[slot] = 0;
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
    if (look.woman && !t.cop) this.purses?.launch(slot, t.car, t.p, t.v, this.lookSeed);
    this.wake();
    this.live++;
    this.lastSlot = slot;
    this.mesh.visible = true;
    this.exitCar = t.car;
    this.exitSpeed = hypot2(t.v.x, t.v.z);
    this.exitPane.copy(t.p);
    if (this.sandbox && t.car >= 0) this.onThrow(t.car);
    return slot;
  }

  /**
   * The course a throw collides with, and its knockable props (`placed`; drawn by `props`, null headless), all back on their
   * spots. Its solids are built at the first throw on it, as recipes: Rapier colliders live only from a throw to its despawn.
   */
  setCourse(track: Track, placed: readonly Placed[], props: PropTumble | null): void {
    this.course = { ground: track.ground(), track, placed };
    this.solids = null;
    this.props.set(placed, props);
  }

  /**
   * A scene's own solids (the Lab's wall, brackets and solid props) a dummy collides with while `ground` is the active one,
   * as a course's are, and its knockable props (`placed`, drawn by `props`), all back on their spots.
   */
  setSolids(ground: Ground, solids: readonly Solid[], placed: readonly Placed[], props: PropTumble | null): void {
    this.course = { ground, track: null, placed };
    this.solids = solids;
    this.props.set(placed, props);
  }

  /**
   * Knockable prop `i` of the course or scene knocked off its spot by car `car` (-1: none) at (vx, vy, vz) m/s: it flies,
   * tumbles and comes to rest in this world (cosmetic: nothing here reaches the sim); knocked before Rapier is in, once it is.
   */
  knockProp(i: number, car: number, vx: number, vy: number, vz: number): void {
    this.wake();
    this.props.knock(i, car, vx, vy, vz);
  }

  /** Knocked prop `i`'s middle after the last step into `p`, and its velocity into `v`; false while it is not out. */
  propAt(i: number, p: THREE.Vector3, v: THREE.Vector3): boolean {
    return this.props.centre(i, p, v);
  }

  /** Nothing was out: the stepping starts afresh (no leftover from an earlier throw shifts the first step) and the proxies jump to the cars. */
  private wake(): void {
    if (this.live > 0 || this.props.count > 0) return;
    this.acc = this.tick = 0;
    this.teleport = true;
  }

  /** The ground under a throw (`groundColliders`): the active surface's solids (pad, disc and ramps, corkscrew) built once, its terrain's heightfield patch per dummy on a course or a scene's solids. */
  private buildPatch(d: Doll, cx: number, cz: number, y: number): void {
    const c = this.course;
    if (c !== null && activeGround() === c.ground) d.patch.push(...this.patchAt(cx, cz, y, PATCH_HALF));
    else if (this.statics.length === 0) this.statics.push(...groundColliders(this.R!, this.world!, FIXED_GROUPS, null, this.sand, this.bowlR, this.poles, cx, cz, y, PATCH_HALF));
  }

  /** The course's or the scene's ground, walls and solids `half` m around (`cx`, `cz`) at height `y` (`groundColliders`): a dummy's patch, or knocked props'. */
  private patchAt(cx: number, cz: number, y: number, half: number): Collider[] {
    const c = this.course!;
    if (c.track) this.solids ??= courseSolids(c.track, c.placed);
    return groundColliders(this.R!, this.world!, FIXED_GROUPS, { track: c.track, solids: this.solids! }, this.sand, this.bowlR, this.poles, cx, cz, y, half);
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
