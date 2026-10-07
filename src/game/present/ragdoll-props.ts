import * as THREE from "three";
import type { Collider, ColliderDesc, RigidBody, World } from "@dimforge/rapier3d";
import type { Rapier } from "../kernel/rapier.ts";
import { PREFABS } from "../world/catalog.ts";
import { propColliders, type Placed, type PropCollider } from "../world/placements.ts";
import { AIR_ANGULAR, AIR_LINEAR, blendPose, readPose } from "./ragdoll-body.ts";
import { PATCH_AHEAD, PATCH_HALF } from "./ragdoll-ground.ts";
import type { PropTumble } from "./prop-tumble.ts";

/**
 * The knockable props (cones, crates, tyre stacks, hay bales) as bodies in the dummies' world (cosmetic, like the purses:
 * `RagdollSystem` owns the world and steps it). A standing one is a fixed body on its spot whose collider is the footprint
 * a car meets (`propColliders`), so a dummy meets it as a car does. Knocked (`knock`), it turns dynamic in its own shape,
 * flies off at the knock's velocity, tumbles, lands and comes to rest on a ground patch under it (`patch`, shared by the
 * props it covers), and is drawn where it is (`PropTumble.place`). A knock before Rapier is in, or while the props' ground
 * is not the active one, waits and flies once it is (`here`). Its standing bodies are built on the first step on their
 * ground and go when the ground does.
 */

/** Per placement: standing on its spot, knocked but not flying yet (no world, or not here), flying or lying where it fell. */
const STAND = 0;
const DUE = 1;
const OUT = 2;
/** A prop this far (m) inside its patch's edge has its ground and walls; past it, it moves to a patch that covers it. */
const PATCH_EDGE = 8;
const COVER = PATCH_HALF - PATCH_EDGE;
/** Friction of a knocked prop's own shape. */
const FRICTION = 0.8;
/** A collider that meets nothing (a standing prop's own shape, a flying prop's footprint). */
const NONE = 0;
/**
 * A knocked prop whose middle has moved under `REST_SPEED` m/s and turned under `REST_SPIN` rad/s over each last step for
 * `REST_FOR` sim s goes to sleep (Rapier's own rule waits 2 s under its thresholds, which JS cannot set). Measured over 192
 * knocks (4 props, cars at 5–60 m/s, 8 headings): the longest such spell after which a prop still fell (balanced on an edge)
 * was 0.117 s; from 0.15 s none sleeps over 1.3 mm above where it comes to rest. A knock is awake 5.45 s instead of 6.91.
 */
const REST_SPEED = 0.1;
const REST_SPIN = 0.1;
const REST_FOR = 0.25;

const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _b = new THREE.Vector3();
const _v = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };
const Y = new THREE.Vector3(0, 1, 0);

/** A knockable prop's own shape about its middle (the middle of its size box), and the shape's volume (m³). Sizes are its prefab's art (`prefabs.ts`). */
function shapes(R: Rapier, p: Placed): { descs: ColliderDesc[]; volume: number } {
  const [w, h, d] = PREFABS[p.prefab].size;
  const hy = (h * p.sy) / 2;
  if (p.prefab === "cone") {
    // A 0.4 m square base plate 4 cm thick, then the cone (r 0.165) up to 0.7 m.
    const plate = [0.2 * p.sx, 0.02 * p.sy, 0.2 * p.sz] as const;
    const cone = [0.33 * p.sy, 0.165 * Math.max(p.sx, p.sz)] as const;
    return {
      descs: [R.ColliderDesc.cuboid(...plate).setTranslation(0, 0.02 * p.sy - hy, 0), R.ColliderDesc.cone(...cone).setTranslation(0, 0.37 * p.sy - hy, 0)],
      volume: 8 * plate[0] * plate[1] * plate[2] + (2 * Math.PI * cone[1] * cone[1] * cone[0]) / 3,
    };
  }
  if (p.prefab === "tyre-stack") {
    const r = (w / 2) * Math.max(p.sx, p.sz);
    return { descs: [R.ColliderDesc.cylinder(hy, r)], volume: 2 * Math.PI * r * r * hy };
  }
  return { descs: [R.ColliderDesc.cuboid((w * p.sx) / 2, hy, (d * p.sz) / 2)], volume: w * p.sx * h * p.sy * d * p.sz };
}

/** The footprint `c` as a collider about the prop's middle (`hy` over its base `y0`): what a car and a standing-prop throw meet. */
function footprint(R: Rapier, c: PropCollider, y0: number, hy: number): ColliderDesc {
  const half = (c.top - y0) / 2;
  const desc = c.kind === "circle" ? R.ColliderDesc.cylinder(half, c.r) : R.ColliderDesc.cuboid(c.hx, half, c.hz);
  return desc.setTranslation(0, half - hy, 0).setDensity(0);
}

export class PropBodies {
  /** Knocked props flying or lying: `out[0 … count)`, placement indices. */
  count = 0;
  private R: Rapier | null = null;
  private world: World | null = null;
  private placed: readonly Placed[] = [];
  private draw: PropTumble | null = null;
  /** The standing bodies are in the world. */
  private built = false;
  /** Per placement (null: not knockable): its body, its footprint collider, its own shape's colliders. */
  private bodies: (RigidBody | null)[] = [];
  private feet: (Collider | null)[] = [];
  private own: Collider[][] = [];
  /** Per placement: `STAND`/`DUE`/`OUT`, the knock's velocity (3), the car that knocked it (-1: none), sim s since, half its height (m). */
  private state = new Uint8Array(0);
  private kick = new Float32Array(0);
  private by = new Int16Array(0);
  private age = new Float32Array(0);
  private half = new Float32Array(0);
  private out = new Int32Array(0);
  /** Pose (position xyz of the middle, rotation xyzw) after the step before the last and after the last; `drawn`: drawn at rest since it slept. */
  private prev = new Float32Array(0);
  private cur = new Float32Array(0);
  private drawn = new Uint8Array(0);
  /** Per placement: its pose read since it fell asleep (`capture` reads it again once it wakes), m/s its middle moved over the last step (0 asleep), sim s it has been at rest (`REST_FOR`), and its reach: the farthest of its own shape from its middle (m). */
  private settled = new Uint8Array(0);
  private speed = new Float32Array(0);
  private still = new Float32Array(0);
  private reach = new Float32Array(0);
  /** Ground patches, one slot per placement at most: colliders (null: free slot), centre, how many props stand on it; each prop's slot (-1: none). */
  private patches: (Collider[] | null)[] = [];
  private patchX = new Float64Array(0);
  private patchZ = new Float64Array(0);
  private refs = new Uint16Array(0);
  private patchOf = new Int16Array(0);
  private readonly groups: (car: number) => number;
  private readonly footGroups: number;
  private readonly grace: number;
  private readonly step: number;
  private readonly patch: (cx: number, cz: number, y: number) => Collider[];

  /**
   * `groups(car)`: a knocked prop's collision groups, ignoring car `car` (-1: none) for `grace` sim s after its knock (it
   * starts in the car that knocked it); `footGroups`: a standing one's. `step`: the world's step (sim s). `patch(cx, cz, y)`:
   * the ground, walls and solids of the props' scene around (cx, cz) at height `y`.
   */
  constructor(groups: (car: number) => number, footGroups: number, grace: number, step: number, patch: (cx: number, cz: number, y: number) => Collider[]) {
    this.groups = groups;
    this.footGroups = footGroups;
    this.grace = grace;
    this.step = step;
    this.patch = patch;
  }

  /** Rapier is in. */
  load(R: Rapier, world: World): void {
    this.R = R;
    this.world = world;
  }

  /** A scene's placements (`placed`), drawn by `draw` (null headless): every prop stands, none built yet. */
  set(placed: readonly Placed[], draw: PropTumble | null): void {
    this.unbuild();
    this.count = 0;
    const n = placed.length;
    this.placed = placed;
    this.draw = draw;
    draw?.reset();
    this.bodies = Array.from({ length: n }, () => null);
    this.feet = Array.from({ length: n }, () => null);
    this.own = Array.from({ length: n }, () => []);
    this.state = new Uint8Array(n);
    this.kick = new Float32Array(n * 3);
    this.by = new Int16Array(n);
    this.age = new Float32Array(n);
    this.half = new Float32Array(n);
    this.out = new Int32Array(n);
    this.prev = new Float32Array(n * 7);
    this.cur = new Float32Array(n * 7);
    this.drawn = new Uint8Array(n);
    this.settled = new Uint8Array(n);
    this.speed = new Float32Array(n);
    this.still = new Float32Array(n);
    this.reach = new Float32Array(n);
    this.patches = Array.from({ length: n }, () => null);
    this.patchX = new Float64Array(n);
    this.patchZ = new Float64Array(n);
    this.refs = new Uint16Array(n);
    this.patchOf = new Int16Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const p = placed[i]!;
      const [w, h, d] = PREFABS[p.prefab].size;
      const m = Math.max(p.sx, p.sz);
      this.half[i] = (h * p.sy) / 2;
      // Its own shape (`shapes`) lies inside its size box widened to its larger plan scale.
      this.reach[i] = Math.hypot(w * m, h * p.sy, d * m) / 2;
    }
  }

  /** Every prop back standing on its spot (a new run). */
  clear(): void {
    for (let k = 0; k < this.count; k++) this.stand(this.out[k]!);
    this.count = 0;
    this.state.fill(STAND);
    this.freePatches();
    this.draw?.reset();
  }

  /**
   * Whether the props' ground is the active one (each frame, before a step): there, the standing bodies are built and every
   * knock waiting flies; away, the bodies go and every prop stands again.
   */
  here(on: boolean): void {
    if (!on) {
      if (this.built) {
        this.unbuild();
        this.state.fill(STAND);
        this.count = 0;
        this.draw?.reset();
      }
      return;
    }
    if (!this.world || this.built) return;
    this.build();
    for (let i = 0; i < this.placed.length; i++) if (this.state[i] === DUE) this.fly(i);
  }

  /** Knockable prop `i` knocked by car `car` (-1: none) at (vx, vy, vz) m/s: it flies now, or once its world is here; one already out takes the new velocity where it is. */
  knock(i: number, car: number, vx: number, vy: number, vz: number): void {
    if (i < 0 || i >= this.placed.length || PREFABS[this.placed[i]!.prefab].body !== "knock") return;
    this.kick[i * 3] = vx;
    this.kick[i * 3 + 1] = vy;
    this.kick[i * 3 + 2] = vz;
    this.by[i] = car;
    if (this.state[i] === STAND) this.state[i] = DUE;
    if (this.built) this.fly(i);
  }

  /**
   * Grace, rest and patches, once a frame after its steps (`dt` sim s). A prop's motion is its pose over the last step
   * (`prev` to `cur`; Rapier's velocity getters allocate): at rest for `REST_FOR` it goes to sleep.
   */
  advance(dt: number): void {
    const c = this.cur;
    const p = this.prev;
    for (let k = 0; k < this.count; k++) {
      const i = this.out[k]!;
      const before = this.age[i]!;
      this.age[i] = before + dt;
      if (before < this.grace && this.age[i]! >= this.grace) this.regroup(i, -1);
      const body = this.bodies[i]!;
      if (body.isSleeping()) {
        this.speed[i] = 0;
        this.still[i] = 0;
        continue;
      }
      const o = i * 7;
      const vx = (c[o]! - p[o]!) / this.step;
      const vy = (c[o + 1]! - p[o + 1]!) / this.step;
      const vz = (c[o + 2]! - p[o + 2]!) / this.step;
      this.speed[i] = Math.hypot(vx, vy, vz);
      // Its turn over the step: twice the vector part of conj(prev)·cur (the acos of their dot is float32 noise near 1).
      const ex = p[o + 6]! * c[o + 3]! - c[o + 6]! * p[o + 3]! - (p[o + 4]! * c[o + 5]! - p[o + 5]! * c[o + 4]!);
      const ey = p[o + 6]! * c[o + 4]! - c[o + 6]! * p[o + 4]! - (p[o + 5]! * c[o + 3]! - p[o + 3]! * c[o + 5]!);
      const ez = p[o + 6]! * c[o + 5]! - c[o + 6]! * p[o + 5]! - (p[o + 3]! * c[o + 4]! - p[o + 4]! * c[o + 3]!);
      const spin = (2 * Math.hypot(ex, ey, ez)) / this.step;
      this.still[i] = this.speed[i]! < REST_SPEED && spin < REST_SPIN ? this.still[i]! + dt : 0;
      this.cover(i, c[o]!, c[o + 1]!, c[o + 2]!, vx, vz);
      if (this.still[i]! < REST_FOR) continue;
      // `cur` is its pose now: nothing steps between the capture and here.
      body.sleep();
      this.settled[i] = 1;
    }
  }

  /** Is every knocked prop asleep? */
  asleep(): boolean {
    for (let k = 0; k < this.count; k++) if (!this.bodies[this.out[k]!]!.isSleeping()) return false;
    return true;
  }

  /**
   * Can a body at `p`, reaching `r` m from there and moving at `v` m/s, touch a knocked prop within `dt` s? Only nearer
   * than both their reaches plus how far both travel in that time (each prop as last stepped).
   */
  touches(p: THREE.Vector3, r: number, v: number, dt: number): boolean {
    for (let k = 0; k < this.count; k++) {
      const i = this.out[k]!;
      const o = i * 7;
      const dx = this.cur[o]! - p.x;
      const dy = this.cur[o + 1]! - p.y;
      const dz = this.cur[o + 2]! - p.z;
      const reach = r + this.reach[i]! + (v + this.speed[i]!) * dt;
      if (dx * dx + dy * dy + dz * dz < reach * reach) return true;
    }
    return false;
  }

  /** Prop `i`'s middle after the last step into `p`, and its velocity into `v`; false while it is not knocked out. */
  centre(i: number, p: THREE.Vector3, v: THREE.Vector3): boolean {
    if (this.state[i] !== OUT) return false;
    const o = i * 7;
    p.set(this.cur[o]!, this.cur[o + 1]!, this.cur[o + 2]!);
    const u = this.bodies[i]!.linvel();
    v.set(u.x, u.y, u.z);
    return true;
  }

  /** Poses after the last step (`cur`) or the one before it, for `pose`'s blend; a sleeping prop's only until it has been read asleep. */
  capture(cur: boolean): void {
    const into = cur ? this.cur : this.prev;
    for (let k = 0; k < this.count; k++) {
      const i = this.out[k]!;
      const body = this.bodies[i]!;
      const asleep = body.isSleeping();
      if (asleep && this.settled[i]) continue;
      readPose(body, into, i * 7);
      if (cur) this.settled[i] = asleep ? 1 : 0;
    }
  }

  /** Draws every knocked prop `alpha` (0–1) of the way from its pose before the last step to its pose after; one at rest only once. */
  pose(alpha: number): void {
    const draw = this.draw;
    if (!draw) return;
    for (let k = 0; k < this.count; k++) {
      const i = this.out[k]!;
      const asleep = this.bodies[i]!.isSleeping();
      if (asleep && this.drawn[i]) continue;
      this.drawn[i] = asleep ? 1 : 0;
      blendPose(this.prev, this.cur, i * 7, alpha, _p, _q);
      // The art stands on its base: half its height down its own up axis from the middle.
      draw.place(i, _b.copy(Y).applyQuaternion(_q).multiplyScalar(-this.half[i]!).add(_p), _q);
    }
  }

  /** Every body and patch out of the world. */
  dispose(): void {
    this.unbuild();
  }

  /** The standing bodies: each knockable placement fixed on its spot in its footprint, its own shape there but meeting nothing. */
  private build(): void {
    const R = this.R!;
    const world = this.world!;
    for (const c of propColliders(this.placed)) {
      if (c.body !== "knock") continue;
      const i = c.index;
      const p = this.placed[i]!;
      const body = world.createRigidBody(R.RigidBodyDesc.fixed().setLinearDamping(AIR_LINEAR).setAngularDamping(AIR_ANGULAR));
      this.bodies[i] = body;
      this.feet[i] = world.createCollider(footprint(R, c, p.y, this.half[i]!).setCollisionGroups(this.footGroups), body);
      const { descs, volume } = shapes(R, p);
      this.own[i] = descs.map((d) => world.createCollider(d.setDensity(c.mass / volume).setFriction(FRICTION).setRestitution(0).setCollisionGroups(NONE), body));
      this.stand(i);
    }
    this.built = true;
  }

  private unbuild(): void {
    this.freePatches();
    if (!this.built) return;
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (body) this.world!.removeRigidBody(body);
      this.bodies[i] = null;
      this.feet[i] = null;
      this.own[i] = [];
    }
    this.built = false;
  }

  /** Prop `i` fixed on its spot, standing. */
  private stand(i: number): void {
    const body = this.bodies[i];
    if (!body) return;
    const p = this.placed[i]!;
    body.setBodyType(this.R!.RigidBodyType.Fixed, false);
    _v.x = p.x;
    _v.y = p.y + this.half[i]!;
    _v.z = p.z;
    body.setTranslation(_v, false);
    _q.setFromAxisAngle(Y, p.yaw);
    _rot.x = _q.x;
    _rot.y = _q.y;
    _rot.z = _q.z;
    _rot.w = _q.w;
    body.setRotation(_rot, false);
    this.feet[i]!.setCollisionGroups(this.footGroups);
    for (const c of this.own[i]!) c.setCollisionGroups(NONE);
  }

  /** Prop `i` flies from where it is at its knock's velocity (it tumbles off what it meets: the ground drags its base), clear of the car that knocked it for `grace`. */
  private fly(i: number): void {
    const body = this.bodies[i];
    if (!body) return;
    const vx = this.kick[i * 3]!;
    const vy = this.kick[i * 3 + 1]!;
    const vz = this.kick[i * 3 + 2]!;
    if (this.state[i] !== OUT) {
      body.setBodyType(this.R!.RigidBodyType.Dynamic, false);
      this.feet[i]!.setCollisionGroups(NONE);
      this.out[this.count++] = i;
      this.state[i] = OUT;
      readPose(body, this.cur, i * 7);
      this.prev.set(this.cur.subarray(i * 7, i * 7 + 7), i * 7);
      _v.x = _v.y = _v.z = 0;
      body.setAngvel(_v, false);
    }
    _v.x = vx;
    _v.y = vy;
    _v.z = vz;
    body.setLinvel(_v, false);
    body.wakeUp();
    this.age[i] = 0;
    this.drawn[i] = 0;
    this.settled[i] = 0;
    this.still[i] = 0;
    this.speed[i] = Math.hypot(vx, vy, vz);
    this.regroup(i, this.by[i]!);
    const o = i * 7;
    this.cover(i, this.cur[o]!, this.cur[o + 1]!, this.cur[o + 2]!, vx, vz);
  }

  private regroup(i: number, car: number): void {
    const g = this.groups(car);
    for (const c of this.own[i]!) c.setCollisionGroups(g);
  }

  /** Prop `i` at (x, y, z) moving (vx, vz) in plan keeps a patch that covers it: its own, another's, or a new one down its way. */
  private cover(i: number, x: number, y: number, z: number, vx: number, vz: number): void {
    const s = this.patchOf[i]!;
    if (s >= 0 && (x - this.patchX[s]!) ** 2 + (z - this.patchZ[s]!) ** 2 < COVER * COVER) return;
    if (s >= 0) this.unref(s);
    let free = -1;
    for (let k = 0; k < this.patches.length; k++) {
      if (!this.patches[k]) {
        if (free < 0) free = k;
        continue;
      }
      if ((x - this.patchX[k]!) ** 2 + (z - this.patchZ[k]!) ** 2 >= COVER * COVER) continue;
      this.refs[k]!++;
      this.patchOf[i] = k;
      return;
    }
    const speed = Math.hypot(vx, vz);
    const cx = x + (speed > 0.5 ? (vx / speed) * PATCH_AHEAD : 0);
    const cz = z + (speed > 0.5 ? (vz / speed) * PATCH_AHEAD : 0);
    this.patches[free] = this.patch(cx, cz, y);
    this.patchX[free] = cx;
    this.patchZ[free] = cz;
    this.refs[free] = 1;
    this.patchOf[i] = free;
  }

  private unref(s: number): void {
    if (--this.refs[s]! > 0) return;
    for (const c of this.patches[s]!) this.world!.removeCollider(c, false);
    this.patches[s] = null;
  }

  private freePatches(): void {
    for (let s = 0; s < this.patches.length; s++) {
      const cols = this.patches[s];
      if (!cols) continue;
      for (const c of cols) this.world!.removeCollider(c, false);
      this.patches[s] = null;
      this.refs[s] = 0;
    }
    this.patchOf.fill(-1);
  }
}
