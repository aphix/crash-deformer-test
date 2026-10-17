import { hypot2, hypot3 } from "../kernel/physics-core.js";
import * as THREE from "three";
import type { Collider, RigidBody, World } from "@dimforge/rapier3d-simd";
import { disable, type Rapier } from "../kernel/rapier.ts";
import { activeGround } from "../world/ground.ts";
import { mulberry32 } from "../world/placements.ts";
import { AIR_ANGULAR, AIR_LINEAR, blendPose, readPose } from "./ragdoll-body.ts";

/**
 * A woman driver's purse (cosmetic, like the dummies: `RagdollSystem` owns the world and steps it). When she is thrown
 * (`launch`) a purse leaves beside her on her heading at `PURSE_SPEED` of her speed; `BURST_AT` sim seconds later 4-7
 * small things (lipstick, phone, keys, coins, compact, pen) fly out of it, on the purse's heading with a small spread at
 * `ITEM_SPEED` of the purse's speed. One pooled set per dummy slot, drawn in one instanced mesh; a set is cleared with
 * its dummy. All randomness is a `mulberry32` stream seeded from the throw, so a replay of the same throw is the same.
 */

/** The purse leaves at this share of her speed, the things out of it at this share of the purse's. */
export const PURSE_SPEED = 0.85;
export const ITEM_SPEED = 0.85;
/** Sim seconds from the throw to the burst: the purse is clear of the car and still in the air. */
export const BURST_AT = 0.15;
/** Sideways offset of the purse from her (m), and the lift. */
const SIDE = 0.55;
const LIFT = 0.1;
/** Radius of the random vector added to the purse's heading (unit vector) to give the things their own: at most atan(SPREAD) ≈ 11°. */
export const SPREAD = 0.2;
export const ITEMS_MIN = 4;
const PURSE_H = [0.15, 0.1, 0.05] as const;
/** The purse's colour, by the throw's roll. */
const PURSE_COLORS = [0xb3202a, 0x0f6b6b, 0x8a5a33, 0x2f5fb3, 0xe58fb0, 0xd8d2c4, 0x6a2d8c];
/** Its handle: an arch of three bars over the top, centre and size (m) in the purse's frame. */
const STRAP = [
  [-0.09, 0.155, 0, 0.02, 0.11, 0.02],
  [0.09, 0.155, 0, 0.02, 0.11, 0.02],
  [0, 0.215, 0, 0.2, 0.02, 0.02],
] as const;
/** What can fall out: half extents (m, the collider; do not change) and colour. Lipstick, phone, sunglasses, a gold coin, compact, keys, a pill bottle. */
const ITEMS = [
  { h: [0.016, 0.05, 0.016], color: 0xc41e3a },
  { h: [0.04, 0.08, 0.008], color: 0x1a1c22 },
  { h: [0.04, 0.05, 0.008], color: 0x20242c },
  { h: [0.025, 0.007, 0.025], color: 0xe8b923 },
  { h: [0.045, 0.012, 0.045], color: 0xe7a0c4 },
  { h: [0.025, 0.007, 0.025], color: 0xc8ccd4 },
  { h: [0.012, 0.075, 0.012], color: 0xf4f7f2 },
] as const;
/** Gold clasp on the strap's top bar. */
const CLASP = 0xd4a84b;
const ITEMS_MAX = ITEMS.length;
/** Bodies per set (the purse, then each item) and drawn pieces per set (the purse, its strap, each item). */
const BODIES = 1 + ITEMS_MAX;
/** Most things one set holds out at once (`Purses.points`). */
export const PURSE_BODIES = BODIES;
const PIECES = 1 + STRAP.length + ITEMS_MAX;
/**
 * Damping (per s) once a body lies on the ground (in the air it is the dummy's: `AIR_LINEAR`, `AIR_ANGULAR`). A light box landing at 15 m/s on the range's sand
 * (friction 3) spun up to 80 rad/s and skipped 30 m past the dummy (headless range probe), so no body turns faster
 * than `SPIN_MAX` rad/s (`advance`).
 */
const GROUND_LINEAR = 4;
const GROUND_ANGULAR = 8;
const SPIN_MAX = 15;
/**
 * A body this near (m) the ground below it (its centre) is on it: more than the purse's longest half extent (0.15), as
 * a purse tumbling on its edge at 18 m/s keeps its centre at 0.18 and never counted as down, so nothing shed its speed
 * before the sand's friction (3) vaulted it 2.5 m up and 10 m past her (range probe, 8 iterations and 2 internal passes).
 */
const GROUND_REACH = 0.22;
/** The share of its speed a body keeps at its first touchdown. */
const TOUCH_KEEP = 0.5;
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _o = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();

/** The purses' one instanced draw: `PIECES` per slot. */
class PropMesh extends THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  constructor(sets: number) {
    const geo = pieces();
    super(geo, new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.12, vertexColors: true }), sets * PIECES);
    const shapes = new Float32Array(sets * PIECES);
    for (let s = 0; s < sets; s++) {
      const base = s * PIECES;
      shapes[base] = 0;
      for (let k = 0; k < STRAP.length; k++) shapes[base + 1 + k] = 1;
      for (let j = 0; j < ITEMS_MAX; j++) shapes[base + 1 + STRAP.length + j] = 2 + j;
    }
    geo.setAttribute("instanceShape", new THREE.InstancedBufferAttribute(shapes, 1));
    const pick = (shader: { vertexShader: string }) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float shapeId;\nattribute float instanceShape;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nif (abs(shapeId - instanceShape) > 0.5) transformed = vec3(0.0);");
    };
    this.material.onBeforeCompile = (shader) => pick(shader);
    this.material.customProgramCacheKey = () => "purse-shapes";
    this.customDepthMaterial = new THREE.MeshDepthMaterial();
    this.customDepthMaterial.onBeforeCompile = (shader) => pick(shader);
    this.customDepthMaterial.customProgramCacheKey = () => "purse-shapes-depth";
    for (let i = 0; i < this.count; i++) {
      this.setMatrixAt(i, HIDDEN);
      this.setColorAt(i, _c.setHex(0xffffff));
    }
    this.count = 0;
    this.castShadow = true;
    this.frustumCulled = false;
    this.visible = false;
    this.receiveShadow = true;
    this.name = "ragdoll-props";
  }

  colorAt(i: number, hex: number, scale = 1): void {
    this.setColorAt(i, _c.setHex(hex).multiplyScalar(scale));
    this.instanceColor!.needsUpdate = true;
  }

  hide(i: number): void {
    this.setMatrixAt(i, HIDDEN);
    this.instanceMatrix.needsUpdate = true;
  }
}

/** What a throw rolls first: its random stream (past these two draws), the side the purse leaves on and its colour. */
function rollPurse(seed: number, car: number): { rand: () => number; side: number; color: number } {
  const rand = mulberry32(Math.imul(seed ^ 0x51ed270b, 0x9e3779b1) ^ Math.imul(car + 1, 0x85ebca6b));
  const side = rand() < 0.5 ? -1 : 1;
  const color = PURSE_COLORS[Math.floor(rand() * PURSE_COLORS.length)]!;
  return { rand, side, color };
}

/** Floats per set in `exportPoses`: the bodies in use as a bit mask, then every body's pose before the last step and after it. */
export const PURSE_BLOCK = 1 + 2 * BODIES * 7;

export class Purses {
  readonly mesh: PropMesh;
  /** Per set: the purse then each item, disabled until used. */
  private readonly bodies: RigidBody[][] = [];
  private readonly colliders: Collider[][] = [];
  /** Per set: the bodies in use (bit 0 the purse, bit 1 + j item j), the ones lying on the ground, sim seconds since the launch, the car it left, the throw's random stream. */
  private readonly on: Uint16Array;
  private readonly down: Uint16Array;
  private readonly age: Float32Array;
  private readonly car: Int16Array;
  private readonly burstAt: Uint8Array;
  private readonly rand: (() => number)[] = [];
  /** The same for each body: pose after the step before the last and after the last, 7 numbers. */
  private readonly prev: Float32Array;
  private readonly cur: Float32Array;
  private readonly sets: number;
  private readonly groups: (car: number) => number;
  private readonly grace: number;

  /**
   * `groups(car)`: the collision groups of a prop that ignores car `car` (-1: none ignored); they are held for `grace`
   * sim seconds after a launch (it starts beside its own car).
   */
  constructor(R: Rapier, world: World, sets: number, groups: (car: number) => number, grace: number) {
    this.sets = sets;
    this.groups = groups;
    this.grace = grace;
    this.mesh = new PropMesh(sets);
    this.on = new Uint16Array(sets);
    this.down = new Uint16Array(sets);
    this.age = new Float32Array(sets);
    this.car = new Int16Array(sets).fill(-1);
    this.burstAt = new Uint8Array(sets);
    this.prev = new Float32Array(sets * BODIES * 7);
    this.cur = new Float32Array(sets * BODIES * 7);
    const half = (h: readonly number[], density: number, k: number) => {
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic().setTranslation(0, -300 - k, 0).setLinearDamping(AIR_LINEAR).setAngularDamping(AIR_ANGULAR).setEnabled(false),
      );
      const collider = world.createCollider(
        R.ColliderDesc.cuboid(h[0]!, h[1]!, h[2]!).setDensity(density).setFriction(0.8).setRestitution(0).setRestitutionCombineRule(R.CoefficientCombineRule.Min),
        body,
      );
      return [body, collider] as const;
    };
    for (let s = 0; s < sets; s++) {
      const [pb, pc] = half(PURSE_H, 400, 0);
      this.bodies.push([pb]);
      this.colliders.push([pc]);
      for (const [j, it] of ITEMS.entries()) {
        const [b, c] = half(it.h, 800, 1 + j);
        this.bodies[s]!.push(b);
        this.colliders[s]!.push(c);
      }
    }
  }

  /** Is set `s` out? */
  active(s: number): boolean {
    return this.on[s] !== 0;
  }

  /**
   * She was thrown from car `car` at `p` with velocity `v` (world, the torso's): her purse leaves beside her at
   * `PURSE_SPEED` × `v`, same direction. `seed` rolls its look, tumble and what falls out of it.
   */
  launch(s: number, car: number, p: THREE.Vector3, v: THREE.Vector3, seed: number): void {
    this.clear(s);
    const { rand, side } = rollPurse(seed, car);
    this.rand[s] = rand;
    const run = hypot2(v.x, v.z) || 1;
    const body = this.bodies[s]![0]!;
    body.setEnabled(true);
    body.setTranslation({ x: p.x + (v.z / run) * side * SIDE, y: p.y + LIFT, z: p.z - (v.x / run) * side * SIDE }, false);
    _q.set(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() + 0.5).normalize();
    body.setRotation(_q, false);
    body.setLinvel({ x: v.x * PURSE_SPEED, y: v.y * PURSE_SPEED, z: v.z * PURSE_SPEED }, false);
    body.setAngvel({ x: (rand() - 0.5) * 8, y: (rand() - 0.5) * 8, z: (rand() - 0.5) * 8 }, false);
    body.setLinearDamping(AIR_LINEAR);
    body.setAngularDamping(AIR_ANGULAR);
    body.wakeUp();
    this.colliders[s]![0]!.setCollisionGroups(this.groups(car));
    this.on[s] = 1;
    this.down[s] = 0;
    this.age[s] = 0;
    this.car[s] = car;
    this.burstAt[s] = 0;
    this.keep(s, 0);
    this.paint(s, car, seed);
    this.mesh.visible = true;
  }

  /** Set `s`'s purse and strap coloured as `launch(s, car, …, seed)` rolls them: the draw side of a launch the world's thread makes. */
  paint(s: number, car: number, seed: number): void {
    const { color } = rollPurse(seed, car);
    const base = s * PIECES;
    this.mesh.colorAt(base, color);
    for (let k = 0; k < STRAP.length; k++) this.mesh.colorAt(base + 1 + k, k === STRAP.length - 1 ? CLASP : color, k === STRAP.length - 1 ? 1 : 0.55);
  }

  /** One sim step of `dt` passed: past `BURST_AT` the things fly out of the purse; past `grace` the purse can hit its own car. */
  advance(dt: number): void {
    for (let s = 0; s < this.sets; s++) {
      if (!this.on[s]) continue;
      const before = this.age[s]!;
      this.age[s] = before + dt;
      if (before < this.grace && this.age[s]! >= this.grace) this.regroup(s);
      if (!this.burstAt[s] && this.age[s]! >= BURST_AT) this.burst(s);
      for (let b = 0; b < BODIES; b++) {
        if (!(this.on[s]! & (1 << b))) continue;
        const body = this.bodies[s]![b]!;
        const w = body.angvel();
        const spin = hypot3(w.x, w.y, w.z);
        if (spin > SPIN_MAX) body.setAngvel({ x: (w.x * SPIN_MAX) / spin, y: (w.y * SPIN_MAX) / spin, z: (w.z * SPIN_MAX) / spin }, false);
        this.ground(s, b, body);
      }
    }
  }

  /** Everything of set `s` away (its dummy is gone). */
  clear(s: number): void {
    if (!this.on[s]) return;
    for (const b of this.bodies[s]!) disable(b);
    for (let i = 0; i < PIECES; i++) this.mesh.hide(s * PIECES + i);
    this.on[s] = 0;
    this.car[s] = -1;
    this.setCount();
  }

  /** Is everything out (the purses and their things) asleep? Then a step moves none of it. */
  asleep(): boolean {
    for (let s = 0; s < this.sets; s++) {
      for (let b = 0; b < BODIES; b++) if (this.on[s]! & (1 << b) && !this.bodies[s]![b]!.isSleeping()) return false;
    }
    return true;
  }

  /** Is any thing out (as last stepped) within `r` (m) of `p`? */
  near(p: THREE.Vector3, r: number): boolean {
    for (let s = 0; s < this.sets; s++) {
      for (let b = 0; b < BODIES; b++) {
        if (!(this.on[s]! & (1 << b))) continue;
        const o = (s * BODIES + b) * 7;
        const dx = this.cur[o]! - p.x;
        const dy = this.cur[o + 1]! - p.y;
        const dz = this.cur[o + 2]! - p.z;
        if (dx * dx + dy * dy + dz * dz < r * r) return true;
      }
    }
    return false;
  }

  /** Every thing out (as last stepped) into `out` from point `n` on, 4 floats each: its place (world) and `r`. Returns the new count of points. */
  points(out: Float64Array, n: number, r: number): number {
    for (let s = 0; s < this.sets; s++) {
      for (let b = 0; b < BODIES; b++) {
        if (!(this.on[s]! & (1 << b))) continue;
        const o = (s * BODIES + b) * 7;
        out[4 * n] = this.cur[o]!;
        out[4 * n + 1] = this.cur[o + 1]!;
        out[4 * n + 2] = this.cur[o + 2]!;
        out[4 * n + 3] = r;
        n++;
      }
    }
    return n;
  }

  /** Poses after the last step (`cur`) or the one before it, for `pose`'s blend. */
  capture(cur: boolean): void {
    const into = cur ? this.cur : this.prev;
    for (let s = 0; s < this.sets; s++) {
      for (let b = 0; b < BODIES; b++) if (this.on[s]! & (1 << b)) readPose(this.bodies[s]![b]!, into, (s * BODIES + b) * 7);
    }
  }

  /** Draws every body `alpha` (0–1) of the way from its pose before the last step to its pose after. */
  pose(alpha: number): void {
    for (let s = 0; s < this.sets; s++) {
      if (!this.on[s]) continue;
      for (let b = 0; b < BODIES; b++) {
        if (!(this.on[s]! & (1 << b))) continue;
        blendPose(this.prev, this.cur, (s * BODIES + b) * 7, alpha, _p, _q);

        const base = s * PIECES;
        if (b === 0) {
          this.mesh.setMatrixAt(base, _m.compose(_p, _q, _s.set(1, 1, 1)));
          for (let k = 0; k < STRAP.length; k++) {
            const t = STRAP[k]!;
            _o.set(t[0], t[1], t[2]).applyQuaternion(_q).add(_p);
            this.mesh.setMatrixAt(base + 1 + k, _m.compose(_o, _q, _s.set(t[3], t[4], t[5])));
          }
        } else {
          const h = ITEMS[b - 1]!.h;
          this.mesh.setMatrixAt(base + STRAP.length + b, _m.compose(_p, _q, _s.set(h[0] * 2, h[1] * 2, h[2] * 2)));
        }
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Every set's bodies in use and poses into `out`, `PURSE_BLOCK` floats a set: what the main thread draws (`importPoses`). */
  exportPoses(out: Float32Array): void {
    for (let s = 0; s < this.sets; s++) {
      const o = s * PURSE_BLOCK;
      const first = s * BODIES * 7;
      out[o] = this.on[s]!;
      out.set(this.prev.subarray(first, first + BODIES * 7), o + 1);
      out.set(this.cur.subarray(first, first + BODIES * 7), o + 1 + BODIES * 7);
    }
  }

  /** The sets as the world's thread has them (`exportPoses`): the bodies in use and their poses, for `pose` to draw. A thing newly out is coloured; a set gone is hidden. */
  importPoses(from: Float32Array): void {
    for (let s = 0; s < this.sets; s++) {
      const o = s * PURSE_BLOCK;
      const first = s * BODIES * 7;
      const was = this.on[s]!;
      const now = from[o]!;
      for (let b = 1; b < BODIES; b++) if (now & (1 << b) && !(was & (1 << b))) this.mesh.colorAt(s * PIECES + STRAP.length + b, ITEMS[b - 1]!.color);
      if (was !== 0 && now === 0) for (let i = 0; i < PIECES; i++) this.mesh.hide(s * PIECES + i);
      this.on[s] = now;
      if (now === 0) continue;
      this.prev.set(from.subarray(o + 1, o + 1 + BODIES * 7), first);
      this.cur.set(from.subarray(o + 1 + BODIES * 7, o + PURSE_BLOCK), first);
    }
    this.setCount();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }

  /** The things leave the purse: 4-7 of them from its place on its heading, with a spread, at `ITEM_SPEED` of its speed. */
  private burst(s: number): void {
    this.burstAt[s] = 1;
    const rand = this.rand[s]!;
    const purse = this.bodies[s]![0]!;
    const at = purse.translation();
    const u = purse.linvel();
    const speed = hypot3(u.x, u.y, u.z);
    const n = ITEMS_MIN + Math.floor(rand() * (ITEMS_MAX - ITEMS_MIN + 1));
    const first = Math.floor(rand() * ITEMS_MAX);
    for (let k = 0; k < n; k++) {
      const j = (first + k) % ITEMS_MAX;
      const b = this.bodies[s]![1 + j]!;
      // A random point in the unit ball added to the heading: at most atan(SPREAD) off it.
      do _d.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      while (_d.lengthSq() > 1);
      _d.multiplyScalar(SPREAD).add(_v.set(u.x / speed, u.y / speed, u.z / speed)).normalize().multiplyScalar(speed * ITEM_SPEED);
      b.setEnabled(true);
      b.setTranslation({ x: at.x + (rand() - 0.5) * 0.08, y: at.y + (rand() - 0.5) * 0.08, z: at.z + (rand() - 0.5) * 0.08 }, false);
      b.setRotation(_q.set(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() + 0.5).normalize(), false);
      b.setLinvel(_d, false);
      b.setAngvel({ x: (rand() - 0.5) * 30, y: (rand() - 0.5) * 30, z: (rand() - 0.5) * 30 }, false);
      b.setLinearDamping(AIR_LINEAR);
      b.setAngularDamping(AIR_ANGULAR);
      b.wakeUp();
      this.colliders[s]![1 + j]!.setCollisionGroups(this.age[s]! < this.grace ? this.groups(this.car[s]!) : this.groups(-1));
      this.on[s] = this.on[s]! | (2 << j);
      this.mesh.colorAt(s * PIECES + 1 + STRAP.length + j, ITEMS[j]!.color);
      this.keep(s, 1 + j);
    }
  }

  /** A body just placed: its previous and current pose are where it is, so the first frame does not blend from elsewhere. */
  private keep(s: number, b: number): void {
    const o = (s * BODIES + b) * 7;
    readPose(this.bodies[s]![b]!, this.cur, o);
    for (let i = 0; i < 7; i++) this.prev[o + i] = this.cur[o + i]!;
    this.setCount();
  }

  /** Past `grace`: the set's own car is a car like any other. */
  private regroup(s: number): void {
    const g = this.groups(-1);
    for (let b = 0; b < BODIES; b++) if (this.on[s]! & (1 << b)) this.colliders[s]![b]!.setCollisionGroups(g);
  }

  /**
   * Body `b` of set `s` (after a step) within `GROUND_REACH` of the ground: it touches down once. A box landing at 15 m/s
   * on the sand's friction (3) trips and vaults 2 m up and 15 m on (browser range run), so the touchdown sheds half its
   * speed along the ground and the fall, as the dummy's skin does (`give`), and from then on it is damped hard.
   */
  private ground(s: number, b: number, body: RigidBody): void {
    if (this.down[s]! & (1 << b)) return;
    const t = body.translation();
    const g = activeGround().heightAt(t.x, t.z);
    if (t.y - (Number.isFinite(g) ? g : 0) >= GROUND_REACH) return;
    this.down[s] = this.down[s]! | (1 << b);
    const v = body.linvel();
    body.setLinvel({ x: v.x * TOUCH_KEEP, y: Math.min(v.y, 0) * TOUCH_KEEP, z: v.z * TOUCH_KEEP }, false);
    body.setLinearDamping(GROUND_LINEAR);
    body.setAngularDamping(GROUND_ANGULAR);
  }

  /** The draw ends after the highest set in use. */
  private setCount(): void {
    let top = -1;
    for (let s = 0; s < this.sets; s++) if (this.on[s]) top = s;
    this.mesh.count = (top + 1) * PIECES;
    this.mesh.visible = top >= 0;
  }
}

/** Sides on a piece. Eight reads round at a few metres and stays cheap. */
const PIECE_SIDES = 8;

type Built = { pos: number[]; shape: number[]; index: number[] };

function ring(b: Built, id: number, y: number, rx: number, rz: number, cx = 0, cz = 0): number {
  const at = b.pos.length / 3;
  for (let k = 0; k < PIECE_SIDES; k++) {
    const a = ((k + 0.5) * Math.PI * 2) / PIECE_SIDES;
    b.pos.push(cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz);
    b.shape.push(id);
  }
  return at;
}

function link(b: Built, top: number, bot: number): void {
  for (let k = 0; k < PIECE_SIDES; k++) {
    const n = (k + 1) % PIECE_SIDES;
    b.index.push(top + k, top + n, bot + n, top + k, bot + n, bot + k);
  }
}

function cap(b: Built, id: number, at: number, y: number, cx: number, cz: number, up: boolean): void {
  const pole = b.pos.length / 3;
  b.pos.push(cx, y, cz);
  b.shape.push(id);
  for (let k = 0; k < PIECE_SIDES; k++) {
    const n = (k + 1) % PIECE_SIDES;
    b.index.push(pole, up ? at + n : at + k, up ? at + k : at + n);
  }
}

/** A tube along y, unit-ish, so the instance scale (`h * 2`) makes the real size. */
function tube(b: Built, id: number, y0: number, y1: number, rx: number, rz: number, cx = 0, cz = 0): void {
  const top = ring(b, id, y1, rx, rz, cx, cz);
  const bot = ring(b, id, y0, rx, rz, cx, cz);
  link(b, top, bot);
  cap(b, id, top, y1, cx, cz, true);
  cap(b, id, bot, y0, cx, cz, false);
}

/**
 * Every purse piece in one geometry, tagged with `shapeId`. The bag is real size (the instance scale is 1); the strap bar
 * and the items are unit shapes the existing scales turn into a handle, a lipstick, a phone, sunglasses, a coin, a compact,
 * keys and a pill bottle. One draw; the shader keeps the instance's shape.
 */
function pieces(): THREE.BufferGeometry {
  const b: Built = { pos: [], shape: [], index: [] };
  const top = ring(b, 0, 0.06, 0.11, 0.038);
  const mid = ring(b, 0, -0.01, 0.14, 0.048);
  const foot = ring(b, 0, -0.09, 0.12, 0.04);
  link(b, top, mid);
  link(b, mid, foot);
  cap(b, 0, top, 0.07, 0, 0, true);
  cap(b, 0, foot, -0.09, 0, 0, false);
  const flapA = ring(b, 0, 0.05, 0.09, 0.01, 0, 0.052);
  const flapB = ring(b, 0, -0.03, 0.09, 0.01, 0, 0.052);
  link(b, flapA, flapB);
  cap(b, 0, flapA, 0.05, 0, 0.052, true);
  cap(b, 0, flapB, -0.03, 0, 0.052, false);
  tube(b, 1, -0.5, 0.5, 0.5, 0.5);
  tube(b, 2, -0.5, 0.25, 0.32, 0.32);
  tube(b, 2, 0.25, 0.5, 0.4, 0.4);
  tube(b, 3, -0.48, 0.48, 0.42, 0.28);
  tube(b, 4, -0.15, 0.15, 0.22, 0.22, -0.28, 0);
  tube(b, 4, -0.15, 0.15, 0.22, 0.22, 0.28, 0);
  tube(b, 4, -0.08, 0.08, 0.1, 0.06);
  tube(b, 5, -0.2, 0.2, 0.46, 0.46);
  tube(b, 6, -0.25, 0.25, 0.42, 0.42);
  tube(b, 6, -0.05, 0.08, 0.48, 0.48);
  tube(b, 7, -0.15, 0.15, 0.38, 0.38);
  tube(b, 7, -0.12, 0.12, 0.16, 0.16);
  tube(b, 8, -0.45, 0.2, 0.38, 0.38);
  tube(b, 8, 0.2, 0.48, 0.28, 0.28);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute("shapeId", new THREE.Float32BufferAttribute(b.shape, 1));
  geo.setIndex(b.index);
  geo.computeVertexNormals();
  return geo;
}
