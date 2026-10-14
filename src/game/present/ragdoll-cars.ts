import * as THREE from "three";
import type { Collider, RigidBody, World } from "@dimforge/rapier3d-simd";
import type { CageView, RagCar } from "./ragdoll-car-view.ts";
import { CLASS_LIFT } from "../vehicle/constants.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { GLASS_NAMES, glassCorners } from "../vehicle/car-glass.ts";
import { carClass, classStats } from "../vehicle/vehicle-classes.ts";
import { disable, type Rapier } from "../kernel/rapier.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import { hypot3 } from "../kernel/physics-core.js";
import { PURSE_BODIES, type Purses } from "./ragdoll-purse.ts";
import { CAR_BOX } from "./ragdoll-props.ts";
import { BOX_FLOATS, PANE_GONE, PANES, PROXY_BOXES, ProxyFitter, UNDER } from "./ragdoll-proxy.ts";
import type { Doll } from "./ragdoll-body.ts";
import { carGroups, FIXED_GROUPS, MAX_ACC, SLOTS, STEP } from "./ragdoll-config.ts";

/** Jersey barrier height (m): the barrier-block prefab's art. */
const BARRIER_H = 0.81;
/**
 * A car's proxy is in the world only while a dummy's torso is within `DOLL_REACH` (torso centre to the tip of a limb, m) plus
 * `NEAR_MARGIN` (m) of the car's box, or a purse thing within `PURSE_REACH` (m) of its reach, and `NEAR_HOLD` (m) more once it is in:
 * every collider in Rapier's world costs every step (`addCuboid`).
 */
export const DOLL_REACH = 1.5;
export const PURSE_REACH = 0.5;
export const NEAR_MARGIN = 0.5;
export const NEAR_HOLD = 0.5;
/**
 * The band of a car (m, car-local, origin on the ground) a standing prop meets: its bumper band, 5 cm up to the bonnet line.
 * The props' squeeze (`PropBodies.press`) takes the car as a box of the cage's plan this high (and `UNDER` under the ground).
 */
export const PROP_BAND_LOW = 0.05;
export const PROP_BAND_HIGH = 0.85;
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

const _cq = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const _c = new THREE.Vector3();
const _v = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The cars as the dummies' world sees them: kinematic proxies (`carBodies`, moved a step at a time by `move`) carrying the leaves and
 * pane slabs fitted to each car's drawn body (`ProxyFitter`), only those a dummy, purse thing or knocked prop is near.
 */
export class CarProxies {
  /** Each car's lower box for the props' squeeze as last fitted, `CAR_BOX` floats (`PropBodies.press`): centre height and forward offset, half extents. */
  readonly boxes = new Float64Array(MAX_CARS * CAR_BOX);
  /** Each car proxy's reach (m): the farthest point of its plan and height from the car's origin (`shape`; `FIRST_REACH` until it is first fitted). */
  readonly reach = new Float32Array(MAX_CARS).fill(FIRST_REACH);
  /** Whether a knocked prop or purse thing is near each car, so `cull` puts all of its leaves in the world (set by `RagdollSystem.near`). */
  readonly whole = new Uint8Array(MAX_CARS);
  /** Each slot's drawn body (`frame`): the car's class body, null for none, and its frame in the world, which the proxy follows. */
  readonly frames = Array.from({ length: MAX_CARS }, () => new THREE.Object3D());
  /** The purses (`cull` keeps leaves near their things); set by `RagdollSystem.preload`. */
  purses: Purses | null = null;
  /** Each car's kinematic proxy, and the sandbox's jersey barrier's (`load`). */
  readonly carBodies: RigidBody[] = [];
  private barrierBody: RigidBody | null = null;
  /** The proxies (cars, then the barrier): last frame's pose then this frame's, 7 numbers each (position, rotation); which are on. */
  private readonly aim = new Float32Array((MAX_CARS + 1) * 14);
  readonly on = new Uint8Array(MAX_CARS + 1).fill(1);
  /** The proxies sat still while no dummy was out: jump them to the cars before the next step. */
  teleport = false;
  private R: Rapier | null = null;
  private world: World | null = null;
  /** Each car's leaves, `PROXY_BOXES` per car, and how many are fitted: its lower box, columns and slabs (`ProxyFitter`). */
  private readonly shapes: (Collider | null)[] = Array.from({ length: MAX_CARS * PROXY_BOXES }, () => null);
  private readonly shapeN = new Uint8Array(MAX_CARS);
  /** Each car's pane slabs, `PANES` per car, in `GLASS_NAMES` order. */
  private readonly panes: (Collider | null)[] = Array.from({ length: MAX_CARS * PANES }, () => null);
  private readonly fitter = new ProxyFitter();
  /** Each car's fitted leaves and pane slabs (`BOX_FLOATS` each), kept for `cull`, which puts those near a dummy in the world. */
  private readonly leafFits = new Float64Array(MAX_CARS * PROXY_BOXES * BOX_FLOATS);
  private readonly paneFits = new Float64Array(MAX_CARS * PANES * BOX_FLOATS);
  /** `cull`'s dummy points in a car's frame: x, y, z and the distance (m) a leaf's sphere must be within, 4 per dummy. */
  private readonly pts = new Float64Array(4 * SLOTS * (1 + PURSE_BODIES));
  /** The car each slot's proxy was last fitted to (`fitProxy`), its glass corners, its body lift (m), the cage fit it was fitted from (`CarCage.serial`), and its glass state as the slabs show it (`glassBits`, -1: refit). */
  private readonly fitted: (RagCar | null)[] = Array.from({ length: MAX_CARS }, () => null);
  private readonly glass: Float32Array[] = Array.from({ length: MAX_CARS }, () => new Float32Array(0));
  private readonly drawn: (THREE.Object3D | null)[] = Array.from({ length: MAX_CARS }, () => null);
  private readonly lift = new Float64Array(MAX_CARS);
  private readonly serial = new Int32Array(MAX_CARS);
  private readonly paneBits = new Int32Array(MAX_CARS).fill(-1);
  /** Per dummy slot, the cars whose panes his torso may reach this frame (`glassNear`) and how many; per slot and car, the panes he is touching (bits). */
  private readonly nearCars = new Uint8Array(SLOTS * MAX_CARS);
  private readonly nearN = new Uint8Array(SLOTS);
  private readonly touching = new Uint8Array(SLOTS * MAX_CARS);

  private readonly dolls: readonly Doll[];

  constructor(dolls: readonly Doll[]) {
    this.dolls = dolls;
  }

  /** The kinematic bodies, parked under the world: one per car and the sandbox's jersey barrier. */
  load(R: Rapier, world: World): void {
    this.R = R;
    this.world = world;
    for (let i = 0; i < MAX_CARS; i++) this.carBodies.push(world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, i * 10)));
    this.barrierBody = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, -10));
    world.createCollider(R.ColliderDesc.cuboid(BARRIER_HALF.x, BARRIER_H / 2, BARRIER_HALF.z).setTranslation(0, BARRIER_H / 2, 0).setCollisionGroups(FIXED_GROUPS), this.barrierBody);
  }

  /** Slot `s`'s dummy was just thrown: no pane is touched or near yet. */
  release(s: number): void {
    this.touching.fill(0, s * MAX_CARS, (s + 1) * MAX_CARS);
    this.nearN[s] = 0;
  }

  /**
   * Kinematic proxy `i` (the barrier is `MAX_CARS`) onto `obj`'s pose, which `move` walks it to a step at a time (disabled without
   * one, so it costs the step nothing); a jump teleports instead of flinging dummies.
   */
  follow(i: number, obj: THREE.Object3D | null): void {
    const body = i < MAX_CARS ? this.carBodies[i]! : this.barrierBody!;
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

  /** Every kinematic proxy `f` of the way along its frame's path (position lerped, rotation slerped). */
  move(f: number): void {
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
   * Slot i's frame onto the drawn body of `car`: its class body (`classLift`, lifted and swayed on its springs) in the world, or
   * the whole car's when it has none. The proxy's colliders lie in the body mesh's own frame, the cage's.
   */
  frame(i: number, car: RagCar): void {
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
  fitProxy(i: number, car: RagCar): void {
    const lift = car.classLift ?? classStats(carClass(car)).lift;
    car.refitCage();
    const cage = car.cage;
    if (cage === null) return;
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
  drop(i: number): void {
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
  cull(i: number, cars: readonly RagCar[], all: boolean, dt: number): void {
    const everything = all || this.whole[i] === 1;
    let m = 0;
    if (!everything) {
      const frame = this.frames[i]!;
      _cq.copy(frame.quaternion).invert();
      const speed = cars[i]!.velocity.length();
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
  private shape(i: number, cage: CageView, lift: number, paneBits: number): void {
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
  glassNear(cars: readonly RagCar[], dt: number): void {
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
   * The pane asks (`normal2` is then the torso's exterior normal) because the torso-first query trips Rapier's
   * `unreachable` on a fresh torso collider.
   */
  glassTouch(cars: readonly RagCar[], authority: boolean): void {
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
          const c = pane ? pane.contactCollider(torso, GLASS_SEE) : null;
          const held = (this.touching[t]! & bit) !== 0;
          if (c === null || (held && c.distance > GLASS_SEP)) {
            this.touching[t] = this.touching[t]! & ~bit;
            continue;
          }
          if (held) continue;
          const v = d.bodies[0]!.linvel();
          const cv = cars[i]!.velocity;
          const closing = (v.x - cv.x) * c.normal2.x + (v.y - cv.y) * c.normal2.y + (v.z - cv.z) * c.normal2.z;
          // Not on the pane within this step yet.
          if (c.distance > Math.max(0, closing) * STEP + GLASS_SKIN) continue;
          this.touching[t] = this.touching[t]! | bit;
          if (closing < GLASS_FLOOR || !authority) continue;
          const car = cars[i]!;
          car.hitGlass(GLASS_NAMES[p]!);
          this.fitProxy(i, car);
        }
      }
    }
  }
}
