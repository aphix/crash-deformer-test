import * as THREE from "three";
import type { Collider, ColliderDesc, RigidBody, World } from "@dimforge/rapier3d";
import type { Rapier } from "../kernel/rapier.ts";
import { PREFABS } from "../world/catalog.ts";
import { propColliders, type Placed, type PropCollider } from "../world/placements.ts";
import { AIR_ANGULAR, AIR_LINEAR, blendPose, readPose } from "./ragdoll-body.ts";
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
/**
 * A knocked prop's ground patch (`patch`): its half side (m), and how far (m) down the knock it is centred. A prop this
 * far (m) inside its patch's edge has its ground and walls; past it, it moves to a patch that covers it. 32 m across: a
 * knock by a car at 10 m/s comes to rest 12-13 m on, inside the one patch; Rapier's broad phase grows with the static
 * colliders (City, 32 cars: 555 in the world against 1129 with a dummy's 96 m, 0.041 ms a step's broad phase against 0.073).
 */
const PATCH_HALF = 16;
const PATCH_AHEAD = 7;
const PATCH_EDGE = 8;
const COVER = PATCH_HALF - PATCH_EDGE;
/** Friction of a knocked prop's own shape. */
const FRICTION = 0.8;
/**
 * A knocked prop has CCD (its step stops at its first hit, so a fast one meets a wall it would cross in a step) and soft
 * CCD this far ahead (m): contacts it comes within in a step's travel up to this push back before it gets there, so a
 * landing at the props' own 1/120 tips it as one at 1/480 does. Measured, the props alone (headless, square course):
 * - 192 knocks by the race's rule (4 props, cars at 5-60 m/s, 8 headings), tipped past 45 deg: 159 (1/480 without
 *   either: 160; 1/120 without: 129, the crate, cone and hay bale of the tumble tests sliding flat).
 * - 48 knocks at a road wall (30-70 m/s, 0-40 deg off square-on): through it 0 (1/120 without: 9, a cone 0.31 m past the
 *   face at 60 m/s; 1/480 without: 1), over its top 2. A reach of 0.3 sent 14 over it, 1 m a 60 m/s tyre stack 93 m on.
 */
const SOFT_CCD = 0.1;
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
/**
 * A knocked prop a car's lower box pushes against a static box (a wall or a box solid; the ground is a heightfield) is
 * squeezed when the two pushes oppose: the cosine between them is under `SQUEEZE`. Each push is read from the boxes'
 * geometry, not Rapier's contacts (its callbacks allocate): the way out of that box to the prop's middle, the box within
 * the prop's reach of it. The box has no mass to give, so the prop would go into the static; it lets that car by
 * (`press`) instead. Measured on contact normals, a car's box and a static both touching a knocked cone: 80 run-overs on
 * open ground never under -0.04 (the ground and a box), 75 wall scrapes (a car at 10-30 m/s sweeping a cone lying at a
 * wall's foot) down to -1; at 0, 65 of the 80 run-overs let the car by on the ground's noise.
 */
const SQUEEZE = -0.1;
/** A static box in a patch's `patchBoxes`: centre (3), rotation (4), half extents (3). */
const BOX = 10;
/** Floats per car in `press`'s car boxes: the lower box's centre height and forward offset in the car's frame, half extents (3). */
export const CAR_BOX = 5;

const _q = new THREE.Quaternion();
const _f = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
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

/**
 * `press`'s scratch, typed arrays so no double crosses a call or lands in an object's field (either can box it): a point
 * (`_in`), a rotation (`_turn`, xyzw), a box's half extents and the prop's reach (`_box`), and the answers (`_rotated`,
 * `_way`).
 */
const _in = new Float64Array(3);
const _turn = new Float64Array(4);
const _box = new Float64Array(4);
const _rotated = new Float64Array(3);
const _way = new Float64Array(3);

/**
 * Is `_rotated`, a point in a box's frame, within the reach `_box[3]` of the box (half extents `_box[0..2]`)? Then `_way`
 * holds the unit way out of the box to it: straight from the box's nearest point, or through its nearest face from inside.
 */
function wayOut(): boolean {
  const px = _rotated[0]!;
  const py = _rotated[1]!;
  const pz = _rotated[2]!;
  const ex = Math.abs(px) - _box[0]!;
  const ey = Math.abs(py) - _box[1]!;
  const ez = Math.abs(pz) - _box[2]!;
  const ox = ex > 0 ? ex : 0;
  const oy = ey > 0 ? ey : 0;
  const oz = ez > 0 ? ez : 0;
  const d2 = ox * ox + oy * oy + oz * oz;
  const r = _box[3]!;
  if (d2 > r * r) return false;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    _way[0] = px < 0 ? -ox / d : ox / d;
    _way[1] = py < 0 ? -oy / d : oy / d;
    _way[2] = pz < 0 ? -oz / d : oz / d;
    return true;
  }
  const inX = ex >= ey && ex >= ez;
  const inY = !inX && ey >= ez;
  _way[0] = inX ? (px < 0 ? -1 : 1) : 0;
  _way[1] = inY ? (py < 0 ? -1 : 1) : 0;
  _way[2] = !inX && !inY ? (pz < 0 ? -1 : 1) : 0;
  return true;
}

/** `_in` turned by `_turn` (`inverse`: by its inverse), into `_rotated`. */
function rotate(inverse: boolean): void {
  const qx = inverse ? -_turn[0]! : _turn[0]!;
  const qy = inverse ? -_turn[1]! : _turn[1]!;
  const qz = inverse ? -_turn[2]! : _turn[2]!;
  const qw = _turn[3]!;
  const x = _in[0]!;
  const y = _in[1]!;
  const z = _in[2]!;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  _rotated[0] = x + qw * tx + (qy * tz - qz * ty);
  _rotated[1] = y + qw * ty + (qz * tx - qx * tz);
  _rotated[2] = z + qw * tz + (qx * ty - qy * tx);
}

/** The cuboids among `colliders`, `BOX` floats each (centre, rotation, half extents); reading them allocates, once per patch. */
function boxesOf(R: Rapier, colliders: readonly Collider[]): Float64Array {
  let n = 0;
  for (const c of colliders) if (c.shapeType() === R.ShapeType.Cuboid) n++;
  const out = new Float64Array(n * BOX);
  let b = 0;
  for (const c of colliders) {
    if (c.shapeType() !== R.ShapeType.Cuboid) continue;
    const t = c.translation();
    const q = c.rotation();
    const h = c.halfExtents();
    out.set([t.x, t.y, t.z, q.x, q.y, q.z, q.w, h.x, h.y, h.z], b);
    b += BOX;
  }
  return out;
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
  /**
   * Per placement: `STAND`/`DUE`/`OUT`, the knock's velocity (3), the car it lets by (-1: none): the one that knocked it,
   * for `grace` s, or one squeezing it (`press`, `held`) while that car's box still covers it (`covers`, set by `press`
   * each frame and cleared by `advance`); sim s since its knock, half its height (m).
   */
  private state = new Uint8Array(0);
  private kick = new Float32Array(0);
  private by = new Int16Array(0);
  private held = new Uint8Array(0);
  private covers = new Uint8Array(0);
  private age = new Float32Array(0);
  private half = new Float32Array(0);
  private out = new Int32Array(0);
  /** Pose (position xyz of the middle, rotation xyzw) after the step before the last and after the last; `drawn`: drawn at rest since it slept. */
  private prev = new Float32Array(0);
  private cur = new Float32Array(0);
  private drawn = new Uint8Array(0);
  /** Per placement: its pose read since it fell asleep (`capture` reads it again once it wakes), m/s its middle moved over the last step (0 asleep), m/s the farthest of its own shape can move (its middle's speed plus its turn times its reach; 0 asleep), sim s it has been at rest (`REST_FOR`), and its reach: the farthest of its own shape from its middle (m). */
  private settled = new Uint8Array(0);
  private speed = new Float32Array(0);
  private sweep = new Float32Array(0);
  private still = new Float32Array(0);
  private reach = new Float32Array(0);
  /** Ground patches, one slot per placement at most: colliders (null: free slot), their static boxes (`BOX` floats each, read once when built), centre, how many props stand on it; each prop's slot (-1: none). */
  private patches: (Collider[] | null)[] = [];
  private patchBoxes: Float64Array[] = [];
  private patchX = new Float64Array(0);
  private patchZ = new Float64Array(0);
  private refs = new Uint16Array(0);
  private patchOf = new Int16Array(0);
  private readonly groups: (car: number) => number;
  private readonly footGroups: number;
  private readonly grace: number;
  private readonly bumperLo: number;
  private readonly bumperHi: number;
  private readonly patch: (cx: number, cz: number, y: number, half: number) => Collider[];

  /**
   * `groups(car)`: a knocked prop's collision groups, ignoring car `car` (-1: none) for `grace` sim s after its knock (it
   * starts in the car that knocked it) or while a car squeezing it covers it (`press`); `footGroups`: a standing one's.
   * `bumperLo`/`bumperHi`: the band (m above the ground) a car's front meets a prop over. `patch(cx, cz, y, half)`: the
   * ground, walls and solids of the props' scene `half` m around (cx, cz) at height `y`.
   */
  constructor(groups: (car: number) => number, footGroups: number, grace: number, bumperLo: number, bumperHi: number, patch: (cx: number, cz: number, y: number, half: number) => Collider[]) {
    this.groups = groups;
    this.footGroups = footGroups;
    this.grace = grace;
    this.bumperLo = bumperLo;
    this.bumperHi = bumperHi;
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
    this.held = new Uint8Array(n);
    this.covers = new Uint8Array(n);
    this.age = new Float32Array(n);
    this.half = new Float32Array(n);
    this.out = new Int32Array(n);
    this.prev = new Float32Array(n * 7);
    this.cur = new Float32Array(n * 7);
    this.drawn = new Uint8Array(n);
    this.settled = new Uint8Array(n);
    this.speed = new Float32Array(n);
    this.sweep = new Float32Array(n);
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
    this.held[i] = 0;
    if (this.state[i] === STAND) this.state[i] = DUE;
    if (this.built) this.fly(i);
  }

  /**
   * Grace, rest and patches, once a frame after its steps (`dt` sim s; `step`: the world's step between the last two
   * captures). A prop's motion is its pose over the last step (`prev` to `cur`; Rapier's velocity getters allocate): at
   * rest for `REST_FOR` it goes to sleep.
   */
  advance(dt: number, step: number): void {
    const c = this.cur;
    const p = this.prev;
    for (let k = 0; k < this.count; k++) {
      const i = this.out[k]!;
      this.age[i] = this.age[i]! + dt;
      if (this.by[i]! >= 0 && this.age[i]! >= this.grace && !(this.held[i] && this.covers[i])) {
        this.by[i] = -1;
        this.held[i] = 0;
        this.regroup(i, -1);
      }
      this.covers[i] = 0;
      const body = this.bodies[i]!;
      if (body.isSleeping()) {
        this.speed[i] = 0;
        this.sweep[i] = 0;
        this.still[i] = 0;
        continue;
      }
      const o = i * 7;
      const vx = (c[o]! - p[o]!) / step;
      const vy = (c[o + 1]! - p[o + 1]!) / step;
      const vz = (c[o + 2]! - p[o + 2]!) / step;
      this.speed[i] = Math.hypot(vx, vy, vz);
      // Its turn over the step: twice the vector part of conj(prev)·cur (the acos of their dot is float32 noise near 1).
      const ex = p[o + 6]! * c[o + 3]! - c[o + 6]! * p[o + 3]! - (p[o + 4]! * c[o + 5]! - p[o + 5]! * c[o + 4]!);
      const ey = p[o + 6]! * c[o + 4]! - c[o + 6]! * p[o + 4]! - (p[o + 5]! * c[o + 3]! - p[o + 3]! * c[o + 5]!);
      const ez = p[o + 6]! * c[o + 5]! - c[o + 6]! * p[o + 5]! - (p[o + 3]! * c[o + 4]! - p[o + 4]! * c[o + 3]!);
      const spin = (2 * Math.hypot(ex, ey, ez)) / step;
      this.sweep[i] = this.speed[i]! + spin * this.reach[i]!;
      this.still[i] = this.speed[i]! < REST_SPEED && spin < REST_SPIN ? this.still[i]! + dt : 0;
      this.cover(i, c[o]!, c[o + 1]!, c[o + 2]!, vx, vz);
      if (this.still[i]! < REST_FOR) continue;
      // `cur` is its pose now: nothing steps between the capture and here.
      body.sleep();
      this.settled[i] = 1;
    }
  }

  /**
   * Car `car`'s lower box this frame, before its steps (its pose `at`/`turn`; the box from `boxes`, `CAR_BOX` floats per
   * car: its centre's height and its offset forward in the car's frame, then its half extents): a knocked prop within its
   * reach of the box and of a static box of its patch, the ways out of the two opposing (`SQUEEZE`), lets the car by while
   * the box covers it (`held`, `covers`); one that lets the car by already is marked covered. The box is kinematic, so it
   * would drive the prop into the static; the props are cosmetic, so the car is the one that gives and passes over it.
   * Arithmetic on poses already read: no allocation.
   */
  press(car: number, at: THREE.Vector3, turn: THREE.Quaternion, boxes: Float64Array): void {
    const c = this.cur;
    const cb = car * CAR_BOX;
    for (let k = 0; k < this.count; k++) {
      const i = this.out[k]!;
      const o = i * 7;
      _turn[0] = turn.x;
      _turn[1] = turn.y;
      _turn[2] = turn.z;
      _turn[3] = turn.w;
      _in[0] = c[o]! - at.x;
      _in[1] = c[o + 1]! - at.y;
      _in[2] = c[o + 2]! - at.z;
      rotate(true);
      _rotated[1] = _rotated[1]! - boxes[cb]!;
      _rotated[2] = _rotated[2]! - boxes[cb + 1]!;
      _box[0] = boxes[cb + 2]!;
      _box[1] = boxes[cb + 3]!;
      _box[2] = boxes[cb + 4]!;
      _box[3] = this.reach[i]!;
      if (!wayOut()) continue;
      if (this.by[i] === car) {
        this.covers[i] = 1;
        continue;
      }
      const s = this.patchOf[i]!;
      if (s < 0) continue;
      // The car's way out, in the world.
      _in.set(_way);
      rotate(false);
      const cx = _rotated[0]!;
      const cy = _rotated[1]!;
      const cz = _rotated[2]!;
      const statics = this.patchBoxes[s]!;
      for (let b = 0; b < statics.length; b += BOX) {
        _turn[0] = statics[b + 3]!;
        _turn[1] = statics[b + 4]!;
        _turn[2] = statics[b + 5]!;
        _turn[3] = statics[b + 6]!;
        _in[0] = c[o]! - statics[b]!;
        _in[1] = c[o + 1]! - statics[b + 1]!;
        _in[2] = c[o + 2]! - statics[b + 2]!;
        rotate(true);
        _box[0] = statics[b + 7]!;
        _box[1] = statics[b + 8]!;
        _box[2] = statics[b + 9]!;
        if (!wayOut()) continue;
        _in.set(_way);
        rotate(false);
        if (_rotated[0]! * cx + _rotated[1]! * cy + _rotated[2]! * cz >= SQUEEZE) continue;
        this.by[i] = car;
        this.held[i] = 1;
        this.covers[i] = 1;
        this.regroup(i, car);
        break;
      }
    }
  }

  /** Is every knocked prop asleep? */
  asleep(): boolean {
    for (let k = 0; k < this.count; k++) if (!this.bodies[this.out[k]!]!.isSleeping()) return false;
    return true;
  }

  /** Can the farthest point of any knocked prop's own shape move faster than `v` m/s (as last stepped)? */
  faster(v: number): boolean {
    for (let k = 0; k < this.count; k++) if (this.sweep[this.out[k]!]! > v) return true;
    return false;
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
      const body = world.createRigidBody(R.RigidBodyDesc.fixed().setLinearDamping(AIR_LINEAR).setAngularDamping(AIR_ANGULAR).setSoftCcdPrediction(SOFT_CCD).setCcdEnabled(true));
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

  /** Prop `i` flies from where it is at its knock's velocity (as a car's bumper drives it, `spin`), clear of the car that knocked it for `grace`. */
  private fly(i: number): void {
    const body = this.bodies[i];
    if (!body) return;
    let vx = this.kick[i * 3]!;
    const vy = this.kick[i * 3 + 1]!;
    let vz = this.kick[i * 3 + 2]!;
    if (this.state[i] !== OUT) {
      body.setBodyType(this.R!.RigidBodyType.Dynamic, false);
      this.feet[i]!.setCollisionGroups(NONE);
      this.out[this.count++] = i;
      this.state[i] = OUT;
      readPose(body, this.cur, i * 7);
      this.prev.set(this.cur.subarray(i * 7, i * 7 + 7), i * 7);
      _v.x = _v.y = _v.z = 0;
      const keep = this.by[i]! >= 0 ? this.spin(body, i, vx, vy, vz) : 1;
      body.setAngvel(_v, false);
      vx *= keep;
      vz *= keep;
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
    // A knock is rare: its spin is read back from Rapier once (the getter allocates).
    const w = body.angvel();
    this.sweep[i] = this.speed[i]! + Math.hypot(w.x, w.y, w.z) * this.reach[i]!;
    this.regroup(i, this.by[i]!);
    const o = i * 7;
    this.cover(i, this.cur[o]!, this.cur[o + 1]!, this.cur[o + 2]!, vx, vz);
  }

  /**
   * A car's bumper knocking prop `i`, standing on its spot, along (vx, ·, vz) while the knock lifts it at `vy`: into `_v`
   * the spin it sets; returned, the share of that plan speed its centre of mass leaves at. The bumper meets it at the middle
   * of the part of its height the bumper's band spans and drives that point out at the knock's plan speed; its push, at that
   * point's height over the centre of mass, turns the prop through its own inertia. A cone (its centre of mass low) tips
   * forwards; a crate or a tyre stack, met a little under theirs, turns back a little; a hay bale, met at its own, leaves at
   * the full speed and does not turn. The turn swings an edge of its base (the front one, tipping forwards) down into the
   * road, which pushes up on that edge: the two pushes are solved together, so the edge never goes down (the prop leaves
   * the road turning about it, never driven into it). The knock's lift is the whole of its rise: the road's push only takes
   * back turn, so the prop flies no higher than the lift throws it.
   */
  private spin(body: RigidBody, i: number, vx: number, vy: number, vz: number): number {
    const speed = Math.hypot(vx, vz);
    if (speed < 1e-6) return 1;
    const h = 2 * this.half[i]!;
    const at = (Math.min(Math.max(this.bumperLo, 0), h) + Math.min(Math.max(this.bumperHi, 0), h)) / 2;
    const o = i * 7;
    _q.set(this.cur[o + 3]!, this.cur[o + 4]!, this.cur[o + 5]!, this.cur[o + 6]!);
    const c = body.localCom();
    const arm = at - this.half[i]! - _b.set(c.x, c.y, c.z).applyQuaternion(_q).y;
    const dx = vx / speed;
    const dz = vz / speed;
    // How far its base (its own shape's first collider, `shapes`) reaches along d from its middle line: a round base its
    // radius, a box its half extents along d in its own frame.
    const base = this.own[i]![0]!;
    _b.set(dx, 0, dz).applyQuaternion(_f.copy(_q).invert());
    const box = base.shapeType() === this.R!.ShapeType.Cylinder ? null : base.halfExtents();
    const edge = box ? box.x * Math.abs(_b.x) + box.z * Math.abs(_b.z) : base.radius();
    const m = body.mass();
    const f = body.principalInertiaLocalFrame();
    const inertia = body.principalInertia();
    _q.multiply(_f.set(f.x, f.y, f.z, f.w));
    // A unit push along the plan way d at r = (0, arm, 0) from the centre of mass: its turn, I⁻¹(r × d), in the principal frame.
    _p.set(arm * dz, 0, -arm * dx).applyQuaternion(_f.copy(_q).invert());
    _p.set(_p.x / inertia.x, _p.y / inertia.y, _p.z / inertia.z).applyQuaternion(_q);
    // Per unit of turn: the bumper's point moves along d at arm·t, the base's edge it swings down goes down at edge·|t|.
    const t = dz * _p.x - dx * _p.z;
    // The bumper's push alone: its point moves along d at push/m + push·arm·t, `speed`.
    let push = speed / (1 / m + arm * t);
    let turn = push;
    if (push * edge * Math.abs(t) > vy) {
      // That edge would go down faster than the knock lifts the prop: the road's push on it (`edge` out from the middle
      // line, so against the bumper's turn) takes back turn until the edge goes down at just the lift (it stays on the
      // road), and the bumper's push is what then drives its point out at `speed`.
      turn = vy / (edge * Math.abs(t));
      push = m * (speed - turn * arm * t);
    }
    _v.x = _p.x * turn;
    _v.y = _p.y * turn;
    _v.z = _p.z * turn;
    return push / m / speed;
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
    this.patches[free] = this.patch(cx, cz, y, PATCH_HALF);
    this.patchBoxes[free] = boxesOf(this.R!, this.patches[free]!);
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
