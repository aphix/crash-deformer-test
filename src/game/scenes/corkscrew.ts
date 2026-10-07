import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { Ground, STEP_UP } from "../world/ground.ts";

/**
 * The corkscrew scene's channel (owner's Hot Wheels sketch): a floor between two walls that rises along +z from a
 * flat mouth and twists about its own centreline at a constant rate. While the scene is up this is the ground: the
 * pad, plus the floor where it is under a body. A car rides the floor through the normal sim (the floor's slope
 * pulls it back down the run, its bank pulls it to the low wall), and leaving the lip it carries the floor's roll
 * rate into the air: its speed decides how far it turns before it comes down on the pad.
 */
export const CORKSCREW = {
  /** World z of the mouth (x = 0, the channel heads +z). */
  mouthZ: -34,
  /** Floor length along the centreline (m). */
  len: 12,
  /** Exit climb (rad, ~32°), reached at `rise` and held to the lip (no pitch rate there). */
  climb: 0.55,
  rise: 7,
  /** The bank starts at `twistFrom`, its rate easing up over `twistEase`, then turns at a constant rate to `bank`
   *  (rad, ~43°) at the lip: the floor stays a height field a car can ride (u = x / cos bank across it). A car leaves
   *  the lip with the floor's roll rate (0.094 rad/m of run): at 22 m/s it lands back on its wheels after a turn, at
   *  27 m/s on its roof after a turn and a half (with its tyres on the floor; 63° spun a 22 m/s car 1.6 turns). */
  twistFrom: 3,
  twistEase: 2,
  bank: 0.75,
  /** Half the floor's width between the walls, and the walls' height off the floor (m). */
  halfW: 1.7,
  wallH: 0.9,
} as const;

const STEP = 0.05;
const N_SAMPLES = Math.round(CORKSCREW.len / STEP) + 1;
const TWIST_RATE = CORKSCREW.bank / (CORKSCREW.len - CORKSCREW.twistFrom - CORKSCREW.twistEase / 2);
/** Car-local side points the walls hold in: the body's four corners at mid height. */
const SIDES: readonly (readonly [number, number, number])[] = [-1, 1].flatMap((sx) =>
  [-1, 1].map((sz): [number, number, number] => [sx * CAR_HALF.x, CAR_HALF.y, sz * CAR_HALF.z]),
);

/** Centreline height and run (local z) at each `STEP` of floor, from the climb's profile. */
const PROFILE_Y = new Float64Array(N_SAMPLES);
const PROFILE_Z = new Float64Array(N_SAMPLES);
for (let i = 1; i < N_SAMPLES; i++) {
  const th = climbAt((i - 0.5) * STEP);
  PROFILE_Y[i] = PROFILE_Y[i - 1]! + Math.sin(th) * STEP;
  PROFILE_Z[i] = PROFILE_Z[i - 1]! + Math.cos(th) * STEP;
}

function climbAt(s: number): number {
  const t = Math.max(0, Math.min(1, s / CORKSCREW.rise));
  return CORKSCREW.climb * t * t * (3 - 2 * t);
}

function bankAt(s: number): number {
  const a = s - CORKSCREW.twistFrom;
  const e = CORKSCREW.twistEase;
  if (a <= 0) return 0;
  return Math.min(CORKSCREW.bank, a < e ? (TWIST_RATE * a * a) / (2 * e) : TWIST_RATE * (a - e / 2));
}

/** World centreline point at floor distance `s`; before the mouth the flat pad, past the lip the lip's line. */
function centre(s: number, out: THREE.Vector3): THREE.Vector3 {
  const last = N_SAMPLES - 1;
  const f = Math.max(0, Math.min(last, s / STEP));
  const i = Math.min(last - 1, Math.floor(f));
  const t = f - i;
  out.set(0, PROFILE_Y[i]! + (PROFILE_Y[i + 1]! - PROFILE_Y[i]!) * t, CORKSCREW.mouthZ + PROFILE_Z[i]! + (PROFILE_Z[i + 1]! - PROFILE_Z[i]!) * t);
  if (s < 0) out.z += s;
  else if (s > CORKSCREW.len) {
    const k = s - CORKSCREW.len;
    out.y += Math.sin(CORKSCREW.climb) * k;
    out.z += Math.cos(CORKSCREW.climb) * k;
  }
  return out;
}

/** The floor's frame at `s`: tangent `t` (up the run), across `b` (+x side), up `n` (the floor normal). */
function frame(s: number, b: THREE.Vector3, n: THREE.Vector3, t: THREE.Vector3): void {
  const th = climbAt(s);
  const ph = bankAt(s);
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const cp = Math.cos(ph);
  const sp = Math.sin(ph);
  t.set(0, st, ct);
  // Unbanked across (1, 0, 0) and up (0, cos, −sin), turned by the bank about t: the +x side rises.
  b.set(cp, sp * ct, -sp * st);
  n.set(-sp, cp * ct, -cp * st);
}

const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
/** `onFloor`'s answer: floor distance and offset across it (m). */
const _su = new Float64Array(2);

/**
 * The floor point straight under or over world (x, z): its distance `s` along the run and offset `u` across it into
 * `_su`, its frame in `_b`/`_n`/`_t` and its centreline point in `_c`. True when that point is on the floor. A few
 * Newton steps on `s`: z = centre(s).z + u·b.z, with u = x / b.x (the bank stays under 90°).
 */
function onFloor(x: number, z: number, margin = 0): boolean {
  let s = z - CORKSCREW.mouthZ;
  for (let k = 0; k < 4; k++) {
    frame(s, _b, _n, _t);
    centre(s, _c);
    s += (z - _c.z - (x / _b.x) * _b.z) / _t.z;
  }
  frame(s, _b, _n, _t);
  centre(s, _c);
  _su[0] = s;
  _su[1] = x / _b.x;
  return s >= -margin && s <= CORKSCREW.len + margin && Math.abs(_su[1]!) <= CORKSCREW.halfW + margin;
}

/**
 * The channel (floor and both walls) as one triangle mesh, a section every `step` m along the run: what the ragdoll
 * dummies collide with. Sections hold the floor's left and right edge and the top of each wall (4 vertices each).
 */
function corkscrewMesh(step: number): { vertices: Float32Array; indices: Uint32Array } {
  const n = Math.round(CORKSCREW.len / step) + 1;
  const vertices = new Float32Array(n * 12);
  const indices = new Uint32Array((n - 1) * 18);
  for (let i = 0; i < n; i++) {
    const s = Math.min(CORKSCREW.len, i * step);
    frame(s, _b, _n, _t);
    centre(s, _c);
    let o = i * 12;
    for (const side of [-1, 1]) {
      _p.copy(_c).addScaledVector(_b, side * CORKSCREW.halfW);
      vertices.set([_p.x, _p.y, _p.z], o);
      _p.addScaledVector(_n, CORKSCREW.wallH);
      vertices.set([_p.x, _p.y, _p.z], o + 3);
      o += 6;
    }
  }
  // Floor (vertices 0, 2 of a section), then each wall (0, 1 and 2, 3): two triangles per quad.
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4;
    const b = a + 4;
    for (const [p, q] of [[0, 2], [0, 1], [2, 3]] as const) indices.set([a + p, a + q, b + p, b + p, a + q, b + q], (k += 6) - 6);
  }
  return { vertices, indices };
}

/** The floor's plan grid (m): fine enough that the bilinear height is within a millimetre of the analytic floor (its bank twists at ≤ 0.16 rad/m). */
const FLOOR_STEP = 0.05;
/** The grid reaches this far (m) past the floor's edge and ends along the run: the analytic floor continued, so no cell straddles its boundary. */
const FLOOR_MARGIN = 0.1;
/** Section spacing (m) of the channel mesh the ragdoll's world collides with. */
const MESH_STEP = 0.25;

export class Corkscrew extends Ground {
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    super();
    this.build();
    this.bake();
    this.group.visible = false;
    scene.add(this.group);
  }

  /**
   * The ground: the flat pad everywhere (y = 0) and the floor's plan grid over it, answering where it is under a body (at most
   * `STEP_UP` above it). Nodes off the floor are NaN: a cell with one answers nothing and the pad holds.
   */
  private bake(): void {
    const x0 = -CORKSCREW.halfW - FLOOR_MARGIN - FLOOR_STEP;
    const z0 = CORKSCREW.mouthZ - FLOOR_MARGIN - FLOOR_STEP;
    const nu = Math.ceil((2 * (CORKSCREW.halfW + FLOOR_MARGIN + FLOOR_STEP)) / FLOOR_STEP) + 1;
    const nv = Math.ceil((CORKSCREW.len + 2 * FLOOR_MARGIN + 2 * FLOOR_STEP) / FLOOR_STEP) + 1;
    const heights = new Float32Array(nu * nv).fill(NaN);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const x = x0 + i * FLOOR_STEP;
        const z = z0 + j * FLOOR_STEP;
        if (!onFloor(x, z, FLOOR_MARGIN)) continue;
        heights[j * nu + i] = _c.y + _su[1]! * _b.y;
      }
    }
    this.addPlane(0, -1e7, 1e7, -1e7, 1e7, Infinity);
    this.setSolid(this.addGrid({ nu, nv, step: FLOOR_STEP, stepV: FLOOR_STEP, u0: 0, v0: 0, heights, ox: x0, oy: 0, oz: z0, reach: STEP_UP }), false);
    this.meshes.push(corkscrewMesh(MESH_STEP));
  }

  /**
   * The walls against a car on the floor: each body corner past a wall (across the floor at its own distance along
   * the run, below the wall's top) pushes the car back across the floor, and its speed into that wall is taken out.
   */
  contact(car: DeformableCar): void {
    const pos = car.group.position;
    if (!onFloor(pos.x, pos.z) || pos.y > _c.y + _su[1]! * _b.y + CORKSCREW.wallH) return;
    const s0 = _su[0]!;
    const ty = _t.y;
    const tz = _t.z;
    const q = car.group.quaternion;
    let push = 0;
    let side = 0;
    for (const [x, y, z] of SIDES) {
      _p.set(x, y, z).applyQuaternion(q).add(pos);
      // The corner's own floor distance: the car's, plus its reach along the run.
      const s = s0 + (_p.z - pos.z) * tz + (_p.y - pos.y) * ty;
      if (s < 0 || s > CORKSCREW.len) continue;
      frame(s, _b, _n, _t);
      centre(s, _c);
      _p.sub(_c);
      if (_p.dot(_n) > CORKSCREW.wallH) continue;
      const u = _p.dot(_b);
      const over = Math.abs(u) - CORKSCREW.halfW;
      if (over > push) {
        push = over;
        side = Math.sign(u);
      }
    }
    if (push <= 0) return;
    frame(s0, _b, _n, _t);
    pos.addScaledVector(_b, -side * push);
    const into = car.velocity.dot(_b) * side;
    if (into > 0) car.velocity.addScaledVector(_b, -side * into);
  }

  /** Floor, walls and the timber support under them, one strip each along the run. */
  private build(): void {
    const n = N_SAMPLES;
    const floor: number[] = [];
    const walls: number[] = [];
    const support: number[] = [];
    const w = CORKSCREW.halfW;
    for (let i = 0; i < n; i++) {
      const s = i * STEP;
      frame(s, _b, _n, _t);
      centre(s, _c);
      for (const side of [-1, 1]) {
        _p.copy(_c).addScaledVector(_b, side * w);
        floor.push(_p.x, _p.y, _p.z);
        walls.push(_p.x, _p.y, _p.z, _p.x + _n.x * CORKSCREW.wallH, _p.y + _n.y * CORKSCREW.wallH, _p.z + _n.z * CORKSCREW.wallH);
        support.push(_p.x, _p.y, _p.z, _p.x, 0, _p.z);
      }
    }
    const red = new THREE.MeshStandardMaterial({ color: 0xb8402e, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const wood = new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.9, side: THREE.DoubleSide });
    // Floor: one quad per step across (left, right); walls and support: one quad per step per side (edge, far edge).
    this.strip(floor, n, 2, [[0, 1]], red);
    this.strip(walls, n, 4, [[0, 1], [2, 3]], red);
    this.strip(support, n, 4, [[0, 1], [2, 3]], wood);
  }

  /** Quads between consecutive samples: `per` vertices per sample, `pairs` the vertex pairs that span each quad. */
  private strip(verts: number[], n: number, per: number, pairs: readonly (readonly [number, number])[], mat: THREE.Material): void {
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      for (const [a, b] of pairs) {
        const a0 = i * per + a;
        const b0 = i * per + b;
        index.push(a0, b0, a0 + per, b0, b0 + per, a0 + per);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }
}
