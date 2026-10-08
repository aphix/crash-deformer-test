import { hypot2 } from "../kernel/physics-core.js";
import * as THREE from "three";
import { CAR_HALF, type DeformableCar } from "../vehicle/car.ts";
import type { PropCollider } from "../world/placements.ts";
import { type ContactBox, makeBox, partContact, solidFace } from "./external-contact.ts";
import { HIT_AHEAD, impulseCar, markApproach, wallBounce, WALL_CRUSH, WALL_HALF_L, WALL_PROBES } from "./pair-contact.ts";

/** The car's footprint on the ground for wall and prop contact: the rectangle the wall probes span (half width, half length; m). */
const [FOOT_W, FOOT_L] = WALL_PROBES[1]!;

/**
 * A prop's or a wall piece's plan shape (`PropCollider`): a circle of radius `r`, or a box of half extents `hx` (local x) and
 * `hz` (local z) yawed by `yaw`, its `ends` bits the ends that are faces (a cleared one is the joint to the next wall piece).
 */
type Solid = { kind: "circle" | "box"; x: number; z: number; yaw: number; r: number; hx: number; hz: number; ends: number };

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

/** The footprint's corners in a box's frame (`jointOverlap`), in order round it: (+r +f), (+r −f), (−r −f), (−r +f). */
const CORNER_R = [1, 1, -1, -1];
const CORNER_F = [1, -1, -1, 1];
const _cu = new Float64Array(4);
const _cw = new Float64Array(4);

/**
 * The footprint against a wall piece whose end on the car's side is a joint (the wall goes on past it): the piece is met
 * only across it, by the part of the footprint over its own length (|w| ≤ hz), moved along its across axis until that part
 * is on the side of the car's centre; (cx, cz) the point of that part deepest in. Separating along the piece's length or
 * the car's own axes there would shove the car along the wall at every joint, and the piece's face taken on past its end
 * would stand out of a bend's inner wall into the road. `c`, `n`: cos and sin of the piece's yaw; (`du`, `dw`), (`ru`,
 * `rw`), (`fu`, `fw`): the car's centre (from the piece's), right and forward in the piece's frame (u across, w along).
 */
function jointOverlap(s: Solid, c: number, n: number, du: number, dw: number, ru: number, rw: number, fu: number, fw: number, out: Overlap): boolean {
  for (let q = 0; q < 4; q++) {
    _cu[q] = du + CORNER_R[q]! * FOOT_W * ru + CORNER_F[q]! * FOOT_L * fu;
    _cw[q] = dw + CORNER_R[q]! * FOOT_W * rw + CORNER_F[q]! * FOOT_L * fw;
  }
  const side = sign(du);
  // The footprint over the piece's length, as its corners there and the points where its edges cross the piece's ends:
  // the one furthest toward the far face (least `side · u`).
  let deep = Infinity;
  let ud = 0;
  let wd = 0;
  for (let q = 0; q < 4; q++) {
    const u = _cu[q]!;
    const w = _cw[q]!;
    if (Math.abs(w) <= s.hz && side * u < deep) {
      deep = side * u;
      ud = u;
      wd = w;
    }
    const u2 = _cu[(q + 1) & 3]!;
    const w2 = _cw[(q + 1) & 3]!;
    for (let e = -1; e <= 1; e += 2) {
      const end = e * s.hz;
      if ((w - end) * (w2 - end) >= 0) continue;
      const at = u + ((end - w) / (w2 - w)) * (u2 - u);
      if (side * at < deep) {
        deep = side * at;
        ud = at;
        wd = end;
      }
    }
  }
  const pen = s.hx - deep;
  if (pen <= 0) return false;
  out.pen = pen;
  out.nx = side * c;
  out.nz = -side * n;
  out.cx = s.x + ud * c + wd * n;
  out.cz = s.z - ud * n + wd * c;
  const f = out.face;
  f.nx = out.nx;
  f.nz = out.nz;
  f.x = s.x + f.nx * s.hx;
  f.z = s.z + f.nz * s.hx;
  f.w = s.hz;
  f.d = s.hx;
  return true;
}

/**
 * Whether the car's footprint rectangle overlaps `s`, and the smallest move that clears it, into `out`.
 *
 * The whole rectangle meets the prop, not six points on it: a 0.6 m wall end, a palm or a lamp post between the probes
 * went through the middle of a car. A box clears along the least of the four separating axes (its own two and the car's
 * two), pushed to the side the car's centre is on: a probe past a thin wall's middle plane used to read the far face as
 * nearest and shove the car out through the wall, and one at the end of a panel left through the end of it, which is
 * the joint to the next panel, so the wall never pushed back. A course wall's piece is met across only where its end is
 * such a joint (`jointOverlap`).
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
    if ((s.ends & (dw < 0 ? 1 : 2)) === 0) return jointOverlap(s, c, n, du, dw, ru, rw, fu, fw, out);
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
/** The collider the car's doors are meeting this slice (`solidBox`), reused. */
const _solid = makeBox();

/**
 * The car this slice, as every solid meets it (`measure`): its body box's lowest and highest points (m), how far past a
 * solid's reach a hard-driving car is still asked about (`markApproach`), and the plane of the wall piece whose hold face
 * it was last held on (`braked`, the face's unit normal and its offset): the pieces of one wall hold a car once.
 */
const _span = { low: 0, high: 0, ahead: 0, braked: false, nx: 0, nz: 0, off: 0 };

/** Two wall faces are one wall's: normals within 5° (cos), planes within this many metres of each other. */
const SAME_WALL_COS = 0.996;
const SAME_WALL_GAP = 0.25;
/** How far (m) a wall piece's hold face goes on past a joint: a car's length (its footprint's, from the middle of a car whose end is on the piece). */
const JOINT_REACH = 2 * FOOT_L;

function measure(car: DeformableCar): void {
  const v = car.velocity;
  const q = car.group.quaternion;
  _span.low = lowestY(car);
  _span.high = 2 * (car.group.position.y + (1 - 2 * (q.x * q.x + q.z * q.z)) * CAR_HALF.y) - _span.low;
  _span.ahead = v.x * v.x + v.z * v.z > WALL_CRUSH * WALL_CRUSH ? hypot2(v.x, v.z) * HIT_AHEAD : 0;
  _span.braked = false;
}

/** Whether wall piece `b` continues piece `a`'s face: its plane is within `SAME_WALL_GAP` (centres across `a`'s axis) and `SAME_WALL_COS` of it. */
function coplanar(a: PropCollider, b: PropCollider): boolean {
  const c = Math.cos(a.yaw);
  const n = Math.sin(a.yaw);
  return Math.abs(Math.cos(a.yaw - b.yaw)) >= SAME_WALL_COS && Math.abs((b.x - a.x) * c - (b.z - a.z) * n) <= SAME_WALL_GAP;
}

/**
 * Course wall piece `col`'s hold face (`solidFace` into `_face`, where the car meets it at `face`): over each joint end it
 * goes on across the pieces that continue it in one plane, up to `JOINT_REACH`, so a car over a joint is held on the wall's
 * one face. Each piece holding only its own half left the other half's masses out in front of it, and the crush hulls that
 * follow the masses read that as a hit deep in the face (the car was shoved back by it, a different crush each way it met the grid).
 */
function jointFace(walls: readonly PropCollider[], col: PropCollider, face: PropFace): ContactBox {
  let lo = 0;
  for (let k = col.index; lo < JOINT_REACH && (walls[k]!.ends & 1) === 0 && coplanar(col, walls[k - 1]!); k--) lo += 2 * walls[k - 1]!.hz;
  let hi = 0;
  for (let k = col.index; hi < JOINT_REACH && (walls[k]!.ends & 2) === 0 && coplanar(col, walls[k + 1]!); k++) hi += 2 * walls[k + 1]!.hz;
  lo = Math.min(lo, JOINT_REACH);
  hi = Math.min(hi, JOINT_REACH);
  // Along the piece (its local z) the face's middle moves by half the difference of the two reaches.
  const s = (hi - lo) / 2;
  return solidFace(_face, face.nx, face.nz, face.x, face.z, face.x + Math.sin(col.yaw) * s, face.z + Math.cos(col.yaw) * s, face.w + (lo + hi) / 2, face.d);
}

/**
 * A hard-driving car `d` m from solid `col`'s centre (`dx`, `dz` from it) is asked whether it is about to land a hard hit
 * (`markApproach`): a circle by its gap along the line of centres; a box by its gap along the box's own axis it is
 * furthest out on (the footprint's extent included), closing along that axis. A wall piece whose end on the car's side is a
 * joint is approached only across: along the wall the next piece goes on.
 */
function approach(car: DeformableCar, col: PropCollider, dx: number, dz: number, d: number): void {
  const v = car.velocity;
  if (col.kind === "circle") {
    markApproach(car, d - col.r - WALL_HALF_L, -(v.x * dx + v.z * dz) / d);
    return;
  }
  const c = Math.cos(col.yaw);
  const n = Math.sin(col.yaw);
  const rx = car.rightFlat.x;
  const rz = car.rightFlat.z;
  const fx = car.fwdFlat.x;
  const fz = car.fwdFlat.z;
  const du = dx * c - dz * n;
  const dw = dx * n + dz * c;
  const gapU = Math.abs(du) - col.hx - FOOT_W * Math.abs(rx * c - rz * n) - FOOT_L * Math.abs(fx * c - fz * n);
  const gapW = Math.abs(dw) - col.hz - FOOT_W * Math.abs(rx * n + rz * c) - FOOT_L * Math.abs(fx * n + fz * c);
  const across = (col.ends & (dw < 0 ? 1 : 2)) === 0 || gapU >= gapW;
  if (across) markApproach(car, gapU, -sign(du) * (v.x * c - v.z * n));
  else markApproach(car, gapW, -sign(dw) * (v.x * n + v.z * c));
}

/** `out` as the fixed solid `col` for `partContact`: its plan shape exact (a circle of radius `r`, or a box), its heights the box's. */
function solidBox(out: ContactBox, col: PropCollider): ContactBox {
  out.x = col.x;
  out.z = col.z;
  out.y = (col.base + col.top) / 2;
  out.hy = (col.top - col.base) / 2;
  out.yaw = col.yaw;
  out.round = col.kind === "circle";
  out.hx = out.round ? col.r : col.hx;
  out.hz = out.round ? col.r : col.hz;
  out.fixed = true;
  return out;
}

/** Car `i` against one collider over a slice of `dt` s (`propContact`), the car as `measure` left it; `walls` are the course's wall pieces (`col` is one if `walls[col.index]` is it). */
function solidContact(car: DeformableCar, i: number, col: PropCollider, walls: readonly PropCollider[], knocked: Uint8Array, hits: PropHits, dt: number): void {
  if ((col.body === "knock" && knocked[col.index] === 1) || _span.low >= col.top || _span.high <= col.base) return;
  const pos = car.group.position;
  const v = car.velocity;
  const ahead = _span.ahead;
  const reach = col.r + WALL_HALF_L + 0.3;
  const dx = pos.x - col.x;
  const dz = pos.z - col.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > (reach + ahead) * (reach + ahead)) return;
  if (ahead > 0 && col.body === "solid" && d2 > 0) approach(car, col, dx, dz, Math.sqrt(d2));
  if (d2 > reach * reach) return;
  if (col.body === "solid") partContact(car, solidBox(_solid, col), dt);
  // The car's footprint against the collider; the normal points out of it.
  if (!footprintOverlap(car, col, _o)) return;
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
    return;
  }
  if (walls[col.index] !== col) {
    wallBounce(car, solidFace(_face, face.nx, face.nz, face.x, face.z, face.x, face.z, face.w, face.d), nx, nz, pen, dt, false);
    if (closing > 1.5) hits.fx(_c, _n, closing);
    hits.wall(col.index, i, closing, cx, cz, nx, nz);
    return;
  }
  // A wall piece: held on the wall's face, which the wall's other pieces in this plane share, so once a slice.
  const off = face.nx * face.x + face.nz * face.z;
  const again = _span.braked && face.nx * _span.nx + face.nz * _span.nz >= SAME_WALL_COS && Math.abs(off - _span.off) <= SAME_WALL_GAP;
  wallBounce(car, jointFace(walls, col, face), nx, nz, pen, dt, again);
  if (again) return;
  _span.braked = true;
  _span.nx = face.nx;
  _span.nz = face.nz;
  _span.off = off;
  if (closing > 1.5) hits.fx(_c, _n, closing);
  hits.wall(col.index, i, closing, cx, cz, nx, nz);
}

/** The Lab's solids have no course wall pieces. */
const NO_WALLS: readonly PropCollider[] = [];

/**
 * Car `i` against `colliders` over a slice of `dt` s: solid props push the car out (and crumple it on a hard hit); knockable
 * ones not yet `knocked` fly off. A prop touches only a car whose body box (`lowestY`) spans part of its height: a car flying
 * over it, or passing under it on a road beneath its deck, clears it. The race's props and walls (`courseContact`) and the Lab's share it.
 */
export function propContact(car: DeformableCar, i: number, colliders: readonly PropCollider[], knocked: Uint8Array, hits: PropHits, dt: number): void {
  measure(car);
  for (let k = 0; k < colliders.length; k++) solidContact(car, i, colliders[k]!, NO_WALLS, knocked, hits, dt);
}

/** Side (m) of a course's solid grid cell (`SolidGrid`). */
const GRID_CELL = 8;
/** Look-ahead (m) a cell's list covers past each collider's reach: `HIT_AHEAD` of travel at 120 m/s, past any car's top speed. */
const AHEAD_MAX = 2;

/**
 * A course's solids by `GRID_CELL` m cell: cell `iz · cols + ix` (its corner at `x0 + ix · GRID_CELL`, `z0 + iz · GRID_CELL`)
 * lists in `items[start[cell] .. start[cell + 1])` every collider whose reach (`propContact`'s, plus `AHEAD_MAX`) covers
 * part of it: wall pieces first (−1 − their index), then props (their index). A car meets those of the cell it stands in.
 */
export type SolidGrid = { x0: number; z0: number; cols: number; rows: number; start: Int32Array; items: Int32Array };

/** The grid (`SolidGrid`) over a course's wall pieces (`wallColliders`) and props (`propColliders`). */
export function solidGrid(walls: readonly PropCollider[], props: readonly PropCollider[]): SolidGrid {
  const all = [...walls, ...props];
  const reach = (c: PropCollider): number => c.r + WALL_HALF_L + 0.3 + AHEAD_MAX;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const c of all) {
    x0 = Math.min(x0, c.x - reach(c));
    z0 = Math.min(z0, c.z - reach(c));
    x1 = Math.max(x1, c.x + reach(c));
    z1 = Math.max(z1, c.z + reach(c));
  }
  if (all.length === 0) return { x0: 0, z0: 0, cols: 0, rows: 0, start: new Int32Array(1), items: new Int32Array(0) };
  const cols = Math.floor((x1 - x0) / GRID_CELL) + 1;
  const rows = Math.floor((z1 - z0) / GRID_CELL) + 1;
  const start = new Int32Array(cols * rows + 1);
  // Two passes: count each cell's colliders, then lay them out in collider order behind each cell's running offset.
  const visit = (each: (cell: number, item: number) => void): void => {
    for (const [j, c] of all.entries()) {
      const item = j < walls.length ? -1 - j : j - walls.length;
      const r = reach(c);
      const ix1 = Math.floor((c.x + r - x0) / GRID_CELL);
      const iz1 = Math.floor((c.z + r - z0) / GRID_CELL);
      for (let iz = Math.floor((c.z - r - z0) / GRID_CELL); iz <= iz1; iz++) {
        for (let ix = Math.floor((c.x - r - x0) / GRID_CELL); ix <= ix1; ix++) each(iz * cols + ix, item);
      }
    }
  };
  visit((cell) => start[cell + 1]!++);
  for (let k = 0; k < cols * rows; k++) start[k + 1]! += start[k]!;
  const items = new Int32Array(start[cols * rows]!);
  const fill = start.slice(0, cols * rows);
  visit((cell, item) => (items[fill[cell]!++] = item));
  return { x0, z0, cols, rows, start, items };
}

/** Car `i` against the course's wall pieces and props near it (`grid`, built over `walls` and `props`) over a slice of `dt` s: `propContact`'s rule for each. */
export function courseContact(car: DeformableCar, i: number, grid: SolidGrid, walls: readonly PropCollider[], props: readonly PropCollider[], knocked: Uint8Array, hits: PropHits, dt: number): void {
  const p = car.group.position;
  const ix = Math.floor((p.x - grid.x0) / GRID_CELL);
  const iz = Math.floor((p.z - grid.z0) / GRID_CELL);
  if (ix < 0 || iz < 0 || ix >= grid.cols || iz >= grid.rows) return;
  const cell = iz * grid.cols + ix;
  measure(car);
  for (let q = grid.start[cell]!; q < grid.start[cell + 1]!; q++) {
    const item = grid.items[q]!;
    solidContact(car, i, item < 0 ? walls[-1 - item]! : props[item]!, walls, knocked, hits, dt);
  }
}
