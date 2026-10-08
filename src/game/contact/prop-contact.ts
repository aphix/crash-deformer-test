import { hypot2 } from "../kernel/physics-core.js";
import * as THREE from "three";
import { CAR_HALF, type DeformableCar } from "../vehicle/car.ts";
import type { PropCollider } from "../world/placements.ts";
import { makeBox, solidFace } from "./external-contact.ts";
import { HIT_AHEAD, impulseCar, markApproach, wallBounce, WALL_CRUSH, WALL_HALF_L, WALL_PROBES } from "./pair-contact.ts";

/** The car's footprint on the ground for wall and prop contact: the rectangle the wall probes span (half width, half length; m). */
const [FOOT_W, FOOT_L] = WALL_PROBES[1]!;

/** A prop's plan shape (`PropCollider`): a circle of radius `r`, or a box of half extents `hx` (local x) and `hz` (local z) yawed by `yaw`. */
type Solid = { kind: "circle" | "box"; x: number; z: number; yaw: number; r: number; hx: number; hz: number };

/**
 * The side of a prop the car met, not the footprint's own separating axis: the unit normal (nx, nz) out of it toward the car,
 * the middle of the face (x, z), and its half extents (m) across it (`w`) and behind it (`d`). A hard hit meets this face as a
 * solid (`solidFace`), so the car is held on the prop's own side wherever the footprint's axis fell.
 */
type PropFace = { nx: number; nz: number; x: number; z: number; w: number; d: number };

/** Where the footprint overlaps a prop: move the car `pen` along (nx, nz), out of the prop; (cx, cz) is its deepest point in. */
type Overlap = { pen: number; nx: number; nz: number; cx: number; cz: number; face: PropFace };

/** −1 or 1, never 0: the side of an axis a centre is on (0 sits on the positive side). */
const sign = (v: number): number => (v < 0 ? -1 : 1);

/**
 * Whether the car's footprint rectangle overlaps `s`, and the smallest move that clears it, into `out`.
 *
 * The whole rectangle meets the prop, not six points on it: a 0.6 m wall end, a palm or a lamp post between the probes
 * went through the middle of a car. A box clears along the least of the four separating axes (its own two and the car's
 * two), pushed to the side the car's centre is on: a probe past a thin wall's middle plane used to read the far face as
 * nearest and shove the car out through the wall, and one at the end of a panel left through the end of it, which is
 * the joint to the next panel, so the wall never pushed back.
 */
function footprintOverlap(car: DeformableCar, s: Solid, out: Overlap): boolean {
  const p = car.group.position;
  const rx = car.rightFlat.x;
  const rz = car.rightFlat.z;
  const fx = car.fwdFlat.x;
  const fz = car.fwdFlat.z;
  const dx = p.x - s.x;
  const dz = p.z - s.z;
  let pen: number;
  let nx: number;
  let nz: number;
  if (s.kind === "circle") {
    // The circle's centre in the car's frame, and the footprint point nearest it.
    const lx = -(dx * rx + dz * rz);
    const lz = -(dx * fx + dz * fz);
    const ex = Math.max(-FOOT_W, Math.min(FOOT_W, lx)) - lx;
    const ez = Math.max(-FOOT_L, Math.min(FOOT_L, lz)) - lz;
    const d = hypot2(ex, ez);
    if (d >= s.r) return false;
    if (d > 1e-9) {
      pen = s.r - d;
      nx = (ex * rx + ez * fx) / d;
      nz = (ex * rz + ez * fz) / d;
    } else if (FOOT_W - Math.abs(lx) < FOOT_L - Math.abs(lz)) {
      // Centre inside the footprint: the car leaves through its nearest edge.
      pen = s.r + FOOT_W - Math.abs(lx);
      nx = -sign(lx) * rx;
      nz = -sign(lx) * rz;
    } else {
      pen = s.r + FOOT_L - Math.abs(lz);
      nx = -sign(lz) * fx;
      nz = -sign(lz) * fz;
    }
  } else {
    const c = Math.cos(s.yaw);
    const n = Math.sin(s.yaw);
    // The box's axes u = (c, −n) across and w = (n, c) along, the car's r and f; each of r, f as (u, w) parts.
    const ru = rx * c - rz * n;
    const rw = rx * n + rz * c;
    const fu = fx * c - fz * n;
    const fw = fx * n + fz * c;
    const du = dx * c - dz * n;
    const dw = dx * n + dz * c;
    const dr = dx * rx + dz * rz;
    const df = dx * fx + dz * fz;
    const oU = s.hx + FOOT_W * Math.abs(ru) + FOOT_L * Math.abs(fu) - Math.abs(du);
    const oW = s.hz + FOOT_W * Math.abs(rw) + FOOT_L * Math.abs(fw) - Math.abs(dw);
    const oR = FOOT_W + s.hx * Math.abs(ru) + s.hz * Math.abs(rw) - Math.abs(dr);
    const oF = FOOT_L + s.hx * Math.abs(fu) + s.hz * Math.abs(fw) - Math.abs(df);
    if (oU <= 0 || oW <= 0 || oR <= 0 || oF <= 0) return false;
    pen = Math.min(oU, oW, oR, oF);
    // Toward the car's side of the axis (centre minus the prop's centre).
    if (pen === oU) {
      nx = sign(du) * c;
      nz = -sign(du) * n;
    } else if (pen === oW) {
      nx = sign(dw) * n;
      nz = sign(dw) * c;
    } else if (pen === oR) {
      nx = sign(dr) * rx;
      nz = sign(dr) * rz;
    } else {
      nx = sign(df) * fx;
      nz = sign(df) * fz;
    }
    // The prop's own face: a long thin one (a wall panel) is met on its wide side, never its end, which is the joint to the next
    // panel; otherwise the one of its two axes the footprint is least deep along. Always on the car's side.
    const useU = s.hx * 2 < s.hz ? true : s.hz * 2 < s.hx ? false : oU <= oW;
    const half = useU ? s.hx : s.hz;
    const f = out.face;
    f.nx = useU ? sign(du) * c : sign(dw) * n;
    f.nz = useU ? -sign(du) * n : sign(dw) * c;
    f.x = s.x + f.nx * half;
    f.z = s.z + f.nz * half;
    f.w = useU ? s.hz : s.hx;
    f.d = half;
  }
  out.pen = pen;
  out.nx = nx;
  out.nz = nz;
  if (s.kind === "circle") {
    // A circle's face is its tangent at the footprint's nearest point.
    const f = out.face;
    f.nx = nx;
    f.nz = nz;
    f.x = s.x + nx * s.r;
    f.z = s.z + nz * s.r;
    f.w = s.r;
    f.d = s.r;
  }
  // The footprint's deepest point into the prop: its support point against the normal (an edge's middle when it lies flat on it).
  const sr = -Math.sign(nx * rx + nz * rz) * FOOT_W;
  const sf = -Math.sign(nx * fx + nz * fz) * FOOT_L;
  out.cx = p.x + sr * rx + sf * fx;
  out.cz = p.z + sr * rz + sf * fz;
  return true;
}

/**
 * Height (m) of the lowest point of `car`'s body box (`CAR_HALF` about its ground point), as tilted: the origin's height plus
 * the box middle's rise along up, less the box's extent along up (`|right.y|·hx + |up.y|·hy + |fwd.y|·hz`). Read from the
 * group's own quaternion, never a slice stale. A level car reads its ground point's height, a nose-down one its front corner's.
 */
export function lowestY(car: DeformableCar): number {
  const { x, y, z, w } = car.group.quaternion;
  const up = 1 - 2 * (x * x + z * z);
  const extent = Math.abs(2 * (x * y + w * z)) * CAR_HALF.x + Math.abs(up) * CAR_HALF.y + Math.abs(2 * (y * z - w * x)) * CAR_HALF.z;
  return car.group.position.y + up * CAR_HALF.y - extent;
}

/** What a scene does with a car's prop contacts (`propContact`): the race records and draws them, the Lab reads them back. */
export type PropHits = {
  /** Knockable prop `index` was knocked off its spot by car `car`, flying off at (vx, vy, vz) m/s. */
  knock(index: number, car: number, vx: number, vy: number, vz: number): void;
  /** A contact worth FX at `at`, normal `n` out of the prop, `closing` m/s. */
  fx(at: THREE.Vector3, n: THREE.Vector3, closing: number): void;
  /** Solid prop `index` met by car `i` closing at `closing` m/s at (x, z), its normal (nx, nz) out of the prop. */
  wall(index: number, i: number, closing: number, x: number, z: number, nx: number, nz: number): void;
};

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _o: Overlap = { pen: 0, nx: 0, nz: 0, cx: 0, cz: 0, face: { nx: 0, nz: 0, x: 0, z: 0, w: 0, d: 0 } };
/** The solid face of the prop the car is meeting this slice (`solidFace`), reused. */
const _face = makeBox();

/**
 * Car `i` against `colliders` over a slice of `dt` s: solid props push the car out (and crumple it on a hard hit); knockable
 * ones not yet `knocked` fly off. A prop touches only a car whose lowest point (the tilted body box, `lowestY`) is under the
 * prop's top: a car flying over it clears it. The race's props and the Lab's share it.
 */
export function propContact(car: DeformableCar, i: number, colliders: readonly PropCollider[], knocked: Uint8Array, hits: PropHits, dt: number): void {
  const pos = car.group.position;
  const v = car.velocity;
  const low = lowestY(car);
  // How far past a prop's reach a hard-driving car is still asked about (`markApproach`).
  const ahead = v.x * v.x + v.z * v.z > WALL_CRUSH * WALL_CRUSH ? hypot2(v.x, v.z) * HIT_AHEAD : 0;
  for (let k = 0; k < colliders.length; k++) {
    const col = colliders[k]!;
    if (knocked[col.index] || low >= col.top) continue;
    const reach = col.r + WALL_HALF_L + 0.3;
    const dx = pos.x - col.x;
    const dz = pos.z - col.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > (reach + ahead) * (reach + ahead)) continue;
    if (ahead > 0 && col.body === "solid" && d2 > 0) {
      const d = Math.sqrt(d2);
      markApproach(car, d - col.r - WALL_HALF_L, -(v.x * dx + v.z * dz) / d);
    }
    if (d2 > reach * reach) continue;
    // The car's footprint against the collider; the normal points out of it.
    if (!footprintOverlap(car, col, _o)) continue;
    const { pen, nx, nz, cx, cz, face } = _o;
    const vn = v.x * nx + v.z * nz;
    const closing = Math.max(0, -vn);
    _c.set(cx, 0.5, cz);
    _n.set(nx, 0, nz);
    if (col.body === "knock") {
      knocked[col.index] = 1;
      const speed = hypot2(v.x, v.z);
      hits.knock(col.index, i, v.x * 1.1 - nx * 1.5, 2 + speed * 0.25, v.z * 1.1 - nz * 1.5);
      const keep = 1 - col.mass / (col.mass + 1400);
      if (car.deform.massActive) impulseCar(car, nx, 0, nz, col.mass * closing * 0.5);
      else {
        v.x *= keep;
        v.z *= keep;
      }
      if (closing > 2) hits.fx(_c, _n, closing * 0.4);
      continue;
    }
    wallBounce(car, solidFace(_face, face.nx, face.nz, face.x, face.z, face.x, face.z, face.w, face.d), nx, nz, pen, dt);
    if (closing > 1.5) hits.fx(_c, _n, closing);
    hits.wall(col.index, i, closing, cx, cz, nx, nz);
  }
}
