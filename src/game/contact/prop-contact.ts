import type { DeformableCar } from "../vehicle/car.ts";
import { WALL_PROBES } from "./pair-contact.ts";

/** The car's footprint on the ground for wall and prop contact: the rectangle the wall probes span (half width, half length; m). */
const [FOOT_W, FOOT_L] = WALL_PROBES[1]!;

/** A prop's plan shape (`PropCollider`): a circle of radius `r`, or a box of half extents `hx` (local x) and `hz` (local z) yawed by `yaw`. */
type Solid = { kind: "circle" | "box"; x: number; z: number; yaw: number; r: number; hx: number; hz: number };

/** Where the footprint overlaps a prop: move the car `pen` along (nx, nz), out of the prop; (cx, cz) is its deepest point in. */
export type Overlap = { pen: number; nx: number; nz: number; cx: number; cz: number };

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
export function footprintOverlap(car: DeformableCar, s: Solid, out: Overlap): boolean {
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
    const d = Math.hypot(ex, ez);
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
  }
  out.pen = pen;
  out.nx = nx;
  out.nz = nz;
  // The footprint's deepest point into the prop: its support point against the normal (an edge's middle when it lies flat on it).
  const sr = -Math.sign(nx * rx + nz * rz) * FOOT_W;
  const sf = -Math.sign(nx * fx + nz * fz) * FOOT_L;
  out.cx = p.x + sr * rx + sf * fx;
  out.cz = p.z + sr * rz + sf * fz;
  return true;
}
