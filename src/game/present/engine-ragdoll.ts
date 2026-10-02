/*
 * Thrown-driver ragdolls: a cosmetic crash-test dummy flung out through the windshield or a front side window
 * when one hit disables a car (`EjectionWatch`). Its own Rapier world (@dimforge/rapier3d, Apache-2.0):
 * ground and walls are fixed colliders around the throw, every car (and the sandbox's jersey barrier) a kinematic
 * box that follows its pose, so cars push dummies and nothing pushes back; no dummy state reaches the sim or the
 * netplay snapshots. The camera may ride along with the latest dummy's head (`follow`, `frameCamera`).
 *
 * The jointed body (ten boxes on spherical joints: head, torso, upper and lower arms, thighs, shins) follows the
 * approach of Matthias von Bargen's rapierjs-ragdoll (https://github.com/mattvb91/rapierjs-ragdoll, MIT License,
 * Copyright (c) Matthias von Bargen), rewritten for this engine: one instanced box mesh, pooled bodies, no model.
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
import type { Collider, ColliderDesc, RigidBody, World } from "@dimforge/rapier3d";
import type { DeformableCar } from "../vehicle/car.ts";
import { activeGround, DISC_GROUND, DISC_RADIUS, FLAT_GROUND } from "../world/ground.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import type { Track } from "../world/track.ts";
import { EjectionWatch, type ExitPane } from "./ragdoll-trigger.ts";
import { loadRapier, type Rapier } from "../kernel/rapier.ts";

/** Live dummies at once; a fifth throw recycles the oldest. */
const SLOTS = 4;
/** Seconds a dummy lies about before it goes. */
const LIFE = 10;
/** Seconds after the throw before the dummy touches any car: it starts inside its own cabin, and a crushed pair's
 *  rest-size proxies overlap the other car's too. */
const GRACE = 0.35;
/** Course ground patch around a throw: cells per side and cell size (m), 96 m across, centred `PATCH_AHEAD` m down the throw. */
const PATCH_N = 48;
const PATCH_CELL = 2;
const PATCH_AHEAD = 24;
/** Half-size (m) of the sandbox's flat pad collider: past any spot a car reaches. */
const FLAT_HALF = 1000;
/** Throw on top of the car's pre-hit velocity (m/s): out through the pane, and up. Arcade, set by eye. */
const THROW_OUT = 3;
const THROW_UP = 3.5;
const TUMBLE = 3;
const GRAVITY = 9.6;
/** Dummy friction against anything (the lower of the pair counts): low, so it slides a good way (owner, 2026-10-02). */
const SLIDE = 0.12;
/** Derby bowl wall: `derby-arena.ts`'s 28 slabs, 1.15 m high, 0.42 m thick at the 16.4 m bowl. */
const BOWL_SEGMENTS = 28;
const BOWL_H = 1.15;
const BOWL_T = 0.42;
const BOWL_R0 = 16.4;
/** Jersey barrier height (m): the barrier-block prefab's art. */
const BARRIER_H = 0.81;
/** Ride-along camera: metres ahead of or behind the head, out to the side and up; seconds still before it lets go. */
const CAM_BACK = 4.5;
const CAM_SIDE = 1.8;
const CAM_UP = 1.3;
const CAM_STILL = 1.5;

/**
 * Dummy parts standing (feet at y = 0): centre, half extents (m), shade. Torso first: the throw places it.
 * A 1.62 m crash-test dummy, about 100 kg at water's density.
 */
const PARTS = [
  { c: [0, 1.11, 0], h: [0.18, 0.27, 0.11], yellow: true },
  { c: [0, 1.51, 0], h: [0.1, 0.11, 0.11], yellow: true },
  { c: [-0.24, 1.21, 0], h: [0.05, 0.14, 0.05], yellow: true },
  { c: [-0.24, 0.93, 0], h: [0.05, 0.14, 0.05], yellow: false },
  { c: [0.24, 1.21, 0], h: [0.05, 0.14, 0.05], yellow: true },
  { c: [0.24, 0.93, 0], h: [0.05, 0.14, 0.05], yellow: false },
  { c: [-0.09, 0.63, 0], h: [0.075, 0.21, 0.075], yellow: true },
  { c: [-0.09, 0.21, 0], h: [0.075, 0.21, 0.075], yellow: false },
  { c: [0.09, 0.63, 0], h: [0.075, 0.21, 0.075], yellow: true },
  { c: [0.09, 0.21, 0], h: [0.075, 0.21, 0.075], yellow: false },
] as const;
/** Arms (parts 2–5) start raised over the head: the superman dive out of the car. */
const ARM = (k: number) => k >= 2 && k <= 5;
const SHOULDER_Y = 1.35;
/** Spherical joints: parent, child, the joint point standing. Neck, shoulders, elbows, hips, knees. */
const JOINTS = [
  [0, 1, 0, 1.39, 0],
  [0, 2, -0.24, SHOULDER_Y, 0],
  [2, 3, -0.24, 1.07, 0],
  [0, 4, 0.24, SHOULDER_Y, 0],
  [4, 5, 0.24, 1.07, 0],
  [0, 6, -0.09, 0.84, 0],
  [6, 7, -0.09, 0.42, 0],
  [0, 8, 0.09, 0.84, 0],
  [8, 9, 0.09, 0.42, 0],
] as const;
/** Head centre above the torso's: the throw puts the head at the pane. */
const HEAD_UP = 0.4;

/** Collision groups (membership << 16 | filter): the world, dummies, and cars in 14 buckets of car index. */
const G_STATIC = 1;
const G_DOLL = 2;
const G_CARS = 0xfffc;
const carBit = (i: number) => 4 << i % 14;
const DOLL_GROUPS = (G_DOLL << 16) | G_STATIC | G_CARS;
const FIXED_GROUPS = (G_STATIC << 16) | G_DOLL;

type Doll = {
  bodies: RigidBody[];
  live: boolean;
  age: number;
  patch: Collider[];
};

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const _arm = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3();
const _out = new THREE.Vector3();
const _w = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

export class RagdollSystem {
  /** The race course whose walls a throw collides with, while its ground is the active one (set by the engine). */
  course: Track | null = null;
  private readonly watch = new EjectionWatch();
  private readonly mesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly onThrow: (car: number) => void;
  private R: Rapier | null = null;
  private world: World | null = null;
  private readonly dolls: Doll[] = [];
  private readonly carBodies: RigidBody[] = [];
  private barrierBody: RigidBody | null = null;
  private live = 0;
  /**
   * Fixed colliders every dummy shares off a course (the pad or the disc, the derby bowl wall), built at the run's
   * first throw. Rapier's step allocates per collider (RapierEval: 0.31 KB each), so they are not built per dummy.
   */
  private readonly statics: Collider[] = [];
  private disposed = false;
  private cars: readonly DeformableCar[] = [];
  private authority = true;
  private bowlR = 0;
  /** Neither a race nor a derby: only here does `onThrow` fire. */
  private sandbox = true;
  /** The car proxies sat still while no dummy was out: jump them to the cars before the next step. */
  private teleport = false;
  private lastSlot = 0;
  /** Ride-along camera: the dummy's slot (-1 off), ahead (1) or behind (-1), seconds it has lain still. */
  private cam = -1;
  private camSide = -1;
  private camStill = 0;
  private camFresh = false;
  private readonly camDir = new THREE.Vector3(0, 0, 1);
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();

  /** `onThrow(car)`: a sandbox driver just left car `car` (the engine decides whether the camera follows). */
  constructor(scene: THREE.Scene, onThrow: (car: number) => void) {
    this.onThrow = onThrow;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, SLOTS * PARTS.length);
    this.mesh.name = "ragdolls";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    const yellow = new THREE.Color(0xf2c12e);
    const dark = new THREE.Color(0x24262b);
    for (let i = 0; i < this.mesh.count; i++) {
      this.mesh.setMatrixAt(i, HIDDEN);
      this.mesh.setColorAt(i, PARTS[i % PARTS.length]!.yellow ? yellow : dark);
    }
    // Shown only while a dummy is out; the boot warm-up draws hidden meshes too, so its programs link there.
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Start Rapier (`loadRapier`), build the pool and run one step so the first throw only places bodies. The
   * engine calls this once boot is `ready`; until it resolves `update` does nothing.
   */
  async preload(): Promise<void> {
    const R = await loadRapier();
    if (this.disposed) return;
    this.R = R;
    const world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world = world;
    for (let i = 0; i < MAX_CARS; i++) {
      const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, i * 10));
      const groups = (carBit(i) << 16) | G_DOLL;
      // From 5 cm off the ground to the bonnet line the whole car, so a lying dummy is shoved, not driven over; above
      // it the cabin (car-local, origin on the ground, +z forward).
      world.createCollider(R.ColliderDesc.cuboid(0.86, 0.4, 2.15).setTranslation(0, 0.45, 0).setCollisionGroups(groups), body);
      world.createCollider(R.ColliderDesc.cuboid(0.7, 0.27, 0.68).setTranslation(0, 1.07, -0.07).setCollisionGroups(groups), body);
      this.carBodies.push(body);
    }
    this.barrierBody = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, -10));
    world.createCollider(R.ColliderDesc.cuboid(BARRIER_HALF.x, BARRIER_H / 2, BARRIER_HALF.z).setTranslation(0, BARRIER_H / 2, 0).setCollisionGroups(FIXED_GROUPS), this.barrierBody);
    for (let s = 0; s < SLOTS; s++) {
      const bodies = PARTS.map((p) => {
        const body = world.createRigidBody(
          R.RigidBodyDesc.dynamic().setTranslation(p.c[0], p.c[1] - 200, p.c[2]).setLinearDamping(0.05).setAngularDamping(0.8).setCcdEnabled(true).setEnabled(false),
        );
        world.createCollider(
          R.ColliderDesc.cuboid(p.h[0], p.h[1], p.h[2])
            .setDensity(1000)
            .setFriction(SLIDE)
            .setFrictionCombineRule(R.CoefficientCombineRule.Min)
            .setRestitution(0.1)
            .setCollisionGroups(DOLL_GROUPS),
          body,
        );
        return body;
      });
      for (const [a, b, x, y, z] of JOINTS) {
        const pa = PARTS[a]!.c;
        const pb = PARTS[b]!.c;
        const data = R.JointData.spherical({ x: x - pa[0], y: y - pa[1], z: z - pa[2] }, { x: x - pb[0], y: y - pb[1], z: z - pb[2] });
        world.createImpulseJoint(data, bodies[a]!, bodies[b]!, true);
      }
      this.dolls.push({ bodies, live: false, age: 0, patch: [] });
    }
    // One step with a dummy out, far below the world: links the step path before a crash needs it.
    const d = this.dolls[0]!;
    for (const b of d.bodies) b.setEnabled(true);
    world.step();
    for (const b of d.bodies) b.setEnabled(false);
  }

  /** A new run: no dummies out, every car's driver back in. */
  reset(): void {
    this.watch.reset();
    this.cam = -1;
    for (let s = 0; s < this.dolls.length; s++) this.despawn(s);
    for (const c of this.statics) this.world?.removeCollider(c, false);
    this.statics.length = 0;
  }

  /**
   * One frame: judge disabling hits (`authority`: this peer owns the glass, so it smashes the exit pane) and
   * step the dummies `dt` sim seconds against the cars' poses. `sandbox`: neither a race nor a derby (`onThrow`);
   * `bowlR`: the derby bowl's radius, 0 outside a derby; `barrier`: the sandbox's jersey
   * barrier while it stands, else null.
   */
  update(dt: number, cars: readonly DeformableCar[], authority: boolean, sandbox: boolean, bowlR: number, barrier: THREE.Object3D | null): void {
    const world = this.world;
    if (!world || dt <= 0) return;
    this.cars = cars;
    this.authority = authority;
    this.sandbox = sandbox;
    this.bowlR = bowlR;
    this.watch.update(cars, dt, this.eject);
    if (this.live === 0) return;
    for (let i = 0; i < MAX_CARS; i++) {
      const car = i < cars.length ? cars[i]! : null;
      this.follow3(this.carBodies[i]!, car && !car.falling && !car.vaporized ? car.group : null);
    }
    this.follow3(this.barrierBody!, barrier);
    this.teleport = false;
    const n = Math.max(1, Math.ceil(dt * 60 - 0.01));
    world.timestep = dt / n;
    for (let k = 0; k < n; k++) world.step();
    for (let s = 0; s < SLOTS; s++) {
      const d = this.dolls[s]!;
      if (!d.live) continue;
      const before = d.age;
      d.age += dt;
      if (before < GRACE && d.age >= GRACE) for (const b of d.bodies) b.collider(0).setCollisionGroups(DOLL_GROUPS);
      if (d.age > LIFE || d.bodies[0]!.translation().y < -30) {
        this.despawn(s);
        continue;
      }
      for (let k = 0; k < PARTS.length; k++) {
        const b = d.bodies[k]!;
        const t = b.translation();
        const r = b.rotation();
        const h = PARTS[k]!.h;
        _m.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(h[0] * 2, h[1] * 2, h[2] * 2));
        this.mesh.setMatrixAt(s * PARTS.length + k, _m);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Ride along with the latest throw: the camera holds ahead of or behind its head (alternating) until it lies still. */
  follow(): void {
    this.cam = this.lastSlot;
    this.camSide = -this.camSide;
    this.camStill = 0;
    this.camFresh = true;
  }

  /** Place `camera` on the dummy being followed; false when none is (the engine's own camera runs). */
  frameCamera(camera: THREE.PerspectiveCamera, wallDt: number): boolean {
    if (this.cam < 0) return false;
    const d = this.dolls[this.cam]!;
    if (!d.live) {
      this.cam = -1;
      return false;
    }
    const head = d.bodies[1]!.translation();
    const v = d.bodies[0]!.linvel();
    const speed = Math.hypot(v.x, v.z);
    if (speed > 0.5) this.camDir.set(v.x / speed, 0, v.z / speed);
    this.camStill = Math.hypot(speed, v.y) < 0.4 ? this.camStill + wallDt : 0;
    if (this.camStill > CAM_STILL) {
      this.cam = -1;
      return false;
    }
    const dir = this.camDir;
    _p.set(head.x + dir.x * CAM_BACK * this.camSide - dir.z * CAM_SIDE, head.y + CAM_UP, head.z + dir.z * CAM_BACK * this.camSide + dir.x * CAM_SIDE);
    const ground = activeGround().heightAt(_p.x, _p.z);
    if (Number.isFinite(ground)) _p.y = Math.max(_p.y, ground + 0.6);
    if (this.camFresh) {
      this.camPos.copy(_p);
      this.camLook.set(head.x, head.y, head.z);
      this.camFresh = false;
    } else {
      this.camPos.lerp(_p, 1 - Math.exp(-wallDt * 5));
      this.camLook.lerp(_s.set(head.x, head.y, head.z), 1 - Math.exp(-wallDt * 12));
    }
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.world?.free();
    this.world = null;
  }

  /**
   * Kinematic `body` onto `obj`'s pose (disabled without one, so it costs the step nothing); a jump teleports
   * instead of flinging dummies.
   */
  private follow3(body: RigidBody, obj: THREE.Object3D | null): void {
    if (!obj) {
      if (body.isEnabled()) body.setEnabled(false);
      return;
    }
    if (!body.isEnabled()) {
      body.setEnabled(true);
      this.teleport = true;
    }
    const p = obj.position;
    const q = obj.quaternion;
    _v.x = p.x;
    _v.y = p.y;
    _v.z = p.z;
    _rot.x = q.x;
    _rot.y = q.y;
    _rot.z = q.z;
    _rot.w = q.w;
    const t = body.translation();
    if (this.teleport || Math.abs(t.x - p.x) + Math.abs(t.y - p.y) + Math.abs(t.z - p.z) > 4) {
      body.setTranslation(_v, false);
      body.setRotation(_rot, false);
    } else {
      body.setNextKinematicTranslation(_v);
      body.setNextKinematicRotation(_rot);
    }
  }

  private readonly eject = (i: number, exit: ExitPane, pre: THREE.Vector3): void => {
    const car = this.cars[i]!;
    if (this.authority) car.smashGlass(exit);
    let slot = this.dolls.findIndex((d) => !d.live);
    if (slot < 0) slot = this.dolls.reduce((o, d, s) => (d.age > this.dolls[o]!.age ? s : o), 0);
    this.despawn(slot);
    const d = this.dolls[slot]!;
    const g = car.group;
    // Head first out of the pane, superman style: the dummy's up axis leans 70° from the car's up toward the exit.
    const side = exit === "windshield" ? 0 : exit === "doorL" ? -1 : 1;
    if (side === 0) _qx.setFromAxisAngle(X, (70 * Math.PI) / 180);
    else _qx.setFromAxisAngle(Z, (-side * 70 * Math.PI) / 180);
    _q.copy(g.quaternion).multiply(_qx);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _out.set(side, 0, side === 0 ? 1 : 0).applyQuaternion(g.quaternion);
    car.glassWorld(exit, _p);
    // The driver sits left of centre (−x): a windshield throw leaves on his side of the glass.
    if (side === 0) _p.addScaledVector(_r.set(1, 0, 0).applyQuaternion(g.quaternion), -0.25);
    _p.addScaledVector(_up, -HEAD_UP);
    // Tumble: a somersault over the car's x axis out of the windshield, a roll over its z axis out of a side.
    _w.set(side === 0 ? 1 : 0, 0, side === 0 ? 0 : -side).applyQuaternion(g.quaternion).multiplyScalar(TUMBLE);
    const vx = pre.x + _out.x * THROW_OUT;
    const vy = THROW_UP;
    const vz = pre.z + _out.z * THROW_OUT;
    const t0 = PARTS[0]!.c;
    for (let k = 0; k < PARTS.length; k++) {
      const b = d.bodies[k]!;
      const c = PARTS[k]!.c;
      // A raised arm is the hanging one turned over about its shoulder.
      const y = ARM(k) ? 2 * SHOULDER_Y - c[1] : c[1];
      _r.set(c[0] - t0[0], y - t0[1], c[2] - t0[2]).applyQuaternion(_q);
      _v.x = _p.x + _r.x;
      _v.y = _p.y + _r.y;
      _v.z = _p.z + _r.z;
      b.setTranslation(_v, false);
      _qx.copy(_q);
      if (ARM(k)) _qx.multiply(_arm);
      _rot.x = _qx.x;
      _rot.y = _qx.y;
      _rot.z = _qx.z;
      _rot.w = _qx.w;
      b.setRotation(_rot, false);
      // Rigid motion: v + ω × r.
      _s.copy(_w).cross(_r);
      _v.x = vx + _s.x;
      _v.y = vy + _s.y;
      _v.z = vz + _s.z;
      b.setLinvel(_v, false);
      _v.x = _w.x;
      _v.y = _w.y;
      _v.z = _w.z;
      b.setAngvel(_v, false);
      b.collider(0).setCollisionGroups((G_DOLL << 16) | G_STATIC);
      b.setEnabled(true);
      b.wakeUp();
    }
    const speed = Math.hypot(vx, vz);
    this.buildPatch(d, _p.x + (speed > 0.5 ? (vx / speed) * PATCH_AHEAD : 0), _p.z + (speed > 0.5 ? (vz / speed) * PATCH_AHEAD : 0));
    d.live = true;
    d.age = 0;
    this.teleport ||= this.live === 0;
    this.live++;
    this.lastSlot = slot;
    this.mesh.visible = true;
    if (this.sandbox) this.onThrow(i);
  };

  /** The ground under a throw (the flat pad, the fleet disc, or a course heightfield patch) and the walls on it. */
  private buildPatch(d: Doll, cx: number, cz: number): void {
    const R = this.R!;
    const world = this.world!;
    const ground = activeGround();
    const onCourse = this.course !== null && ground === this.course.ground();
    if (!onCourse && this.statics.length > 0) return;
    const into = onCourse ? d.patch : this.statics;
    const add = (desc: ColliderDesc) => into.push(world.createCollider(desc.setFriction(0.9).setCollisionGroups(FIXED_GROUPS)));
    const size = PATCH_N * PATCH_CELL;
    if (ground === FLAT_GROUND) add(R.ColliderDesc.cuboid(FLAT_HALF, 0.5, FLAT_HALF).setTranslation(0, -0.5, 0));
    else if (ground === DISC_GROUND) add(R.ColliderDesc.cylinder(0.5, DISC_RADIUS).setTranslation(0, -0.5, 0));
    else {
      const n = PATCH_N;
      const heights = new Float32Array((n + 1) * (n + 1));
      for (let ix = 0; ix <= n; ix++) {
        for (let iz = 0; iz <= n; iz++) {
          const y = ground.heightAt(cx - size / 2 + ix * PATCH_CELL, cz - size / 2 + iz * PATCH_CELL);
          // Rapier's heightfield: rows run along z, columns along x.
          heights[iz + ix * (n + 1)] = Number.isFinite(y) ? y : -40;
        }
      }
      add(R.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }).setTranslation(cx, 0, cz));
    }
    // Off a course every wall is built (the bowl's are all within reach of any throw in it); on one, those near it.
    const reach = onCourse ? size / 2 : Infinity;
    const wall = (ax: number, az: number, bx: number, bz: number, h: number, t: number, out: number) => {
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      if (Math.hypot(mx - cx, mz - cz) > reach) return;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) return;
      const y = ground.heightAt(mx, mz);
      const base = Number.isFinite(y) ? y : 0;
      // Box long axis along the segment, its inner face on the line (`out`: the outward normal's sign).
      const nx = ((bz - az) / len) * out;
      const nz = (-(bx - ax) / len) * out;
      _q.setFromAxisAngle(_r.set(0, 1, 0), Math.atan2(bx - ax, bz - az));
      add(
        R.ColliderDesc.cuboid(t / 2, h / 2, len / 2 + 0.05)
          .setTranslation(mx + (nx * t) / 2, base + h / 2, mz + (nz * t) / 2)
          .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
      );
    };
    if (this.bowlR > 0) {
      const scale = this.bowlR / BOWL_R0;
      const r = this.bowlR - (BOWL_T * scale) / 2;
      for (let k = 0; k < BOWL_SEGMENTS; k++) {
        const a0 = (k / BOWL_SEGMENTS) * Math.PI * 2;
        const a1 = ((k + 1) / BOWL_SEGMENTS) * Math.PI * 2;
        wall(Math.sin(a0) * r, Math.cos(a0) * r, Math.sin(a1) * r, Math.cos(a1) * r, BOWL_H, BOWL_T * scale, -1);
      }
    }
    const track = this.course;
    if (track && onCourse) {
      const wallH = track.json.road.wallHeight;
      for (const p of track.paths()) {
        const segs = p.closed ? p.count : p.count - 1;
        for (let k = 0; k < segs; k++) {
          const b = (k + 1) % p.count;
          if (Math.hypot(p.x[k]! - cx, p.z[k]! - cz) > reach + 10) continue;
          // Left of travel = (tz, −tx); a wall stands half + run out on each flagged side.
          for (const side of [1, -1]) {
            if (!(side > 0 ? p.wallL[k] : p.wallR[k])) continue;
            const la = side * (p.half[k]! + (side > 0 ? p.runL[k]! : p.runR[k]!));
            const lb = side * (p.half[b]! + (side > 0 ? p.runL[b]! : p.runR[b]!));
            wall(p.x[k]! + p.tz[k]! * la, p.z[k]! - p.tx[k]! * la, p.x[b]! + p.tz[b]! * lb, p.z[b]! - p.tx[b]! * lb, wallH, 0.4, side);
          }
        }
      }
    }
  }

  private despawn(s: number): void {
    const d = this.dolls[s]!;
    if (d.live) this.live--;
    d.live = false;
    if (this.cam === s) this.cam = -1;
    for (const b of d.bodies) b.setEnabled(false);
    for (const c of d.patch) this.world!.removeCollider(c, false);
    d.patch.length = 0;
    for (let k = 0; k < PARTS.length; k++) this.mesh.setMatrixAt(s * PARTS.length + k, HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.live === 0) this.mesh.visible = false;
  }
}
