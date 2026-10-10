import { hypot2 } from "../kernel/physics-core.js";
import { ENTRY_WINDOW, SOLID_AT_REST } from "./constants.ts";

/**
 * The geometry of a prism, the one shape every static solid is (docs/UNIFIED_CONTACT.md Stage 2): a plan shape (a box of half
 * extents `hx` across and `hz` along, turned by its yaw, or a circle of radius `r`) times a vertical range from `base` up to a
 * top that is flat or a plane tilted by `gu` across and `gw` along (a ramp's face). A prop, a race wall piece, a ramp, the jersey
 * slab, a lamp post, a ball, a press plate and a room wall are all prisms; a roof, a ramp's face and a wall differ only in which
 * face a body enters.
 *
 * A prism is one row of a `Surface`'s patch numbers (`Surface.addPrism`); these are its slots, kind PRISM only (the numbers of the
 * other kinds' slots are not used there). Its plan box and reach live in the slots every kind shares (`P_MINX` .. `P_MAXZ`,
 * `P_REACH`, `P_GRIP`).
 */
export const PR_X = 0;
export const PR_BASE = 1;
export const PR_Z = 2;
/** Cosine and sine of the yaw: local x across is (cos, −sin), local z along is (sin, cos), as a `PropCollider`'s. */
export const PR_COS = 3;
export const PR_SIN = 4;
export const PR_HX = 5;
export const PR_HZ = 6;
/** Radius of a circle prism (m); 0 for a box. */
export const PR_R = 7;
/** Height (m, world) of the top over the prism's middle, and its rise per metre across (`gu`) and along (`gw`). */
export const PR_TOP = 8;
export const PR_GU = 9;
export const PR_GW = 10;
/** Share of a hit's crush energy the struck car takes (1 a rigid solid, less where the solid gives). */
export const PR_HARD = 11;
/** Which ends of a box are faces: bit 0 its −z end, bit 1 its +z end; a cleared bit is the joint to the next wall piece. */
export const PR_ENDS = 12;
/** The prism's collider index (a wall piece: its place in the wall, a prop: its placement). */
export const PR_ID = 13;
/** 1: a piece of a course wall; 2: a prop that is knocked off its spot by a hit (it is no floor and no wall to a tyre). */
export const PR_WALL = 14;
/** `PR_WALL` of a race wall's piece (`WALL` in `surfaces.ts`, which imports this file). */
const ROLE_WALL = 1;
/** Velocity (m/s, plan) of a prism that moves: a press plate, the slab. */
export const PR_VX = 23;
export const PR_VZ = 24;
/** The yaw (rad) the shape is turned by: the cosine and sine above are read by the queries, this by the response (a door against the prism, a face's heading). */
export const PR_YAW = 25;

/** Cosine of the angle (about 2.5°) within which a body axis counts as lying along a prism's axis. */
const PARALLEL = 0.999;
/** A knockable prop's mass (kg): what a car loses of its speed knocking it. */
export const PR_MASS = 26;
/** A knockable prop's knock speed (m/s): a body closing on it slower than this meets it as a solid (a lamp post's fold speed); 0: any touch knocks it. */
export const PR_KNOCK_V = 27;

/** `exitFace`'s output row: depth (m) the point is inside, the face's outward unit normal (plan). */
export const F_DEPTH = 0;
export const F_NX = 1;
export const F_NZ = 2;
export const F_SIZE = 3;

/** The rate at which a point closes on a face (m/s) under which it is not closing at all. */
const NOT_CLOSING = 1e-6;

/** The height of prism `o`'s top over local (`u`, `w`). */
export function topAt(P: Float64Array, o: number, u: number, w: number): number {
  return P[o + PR_TOP]! + P[o + PR_GU]! * u + P[o + PR_GW]! * w;
}

/** `roundedEntry`'s output: the depth along the entered normal and the normal (`F_*`; the normal points from the rectangle toward the circle's middle). */
const _entry = new Float64Array(F_SIZE);

/**
 * Where a circle of radius `r` whose middle is at (`cx`, `cz`) in a rectangle's frame (half extents `hw`, `hl`; none for a point)
 * entered the rectangle's neighbourhood (the rectangle grown by `r`, its corners rounded): its middle walked back along (`vx`, `vz`),
 * the rectangle's velocity relative to it, leaves that shape through a flat side or a corner's arc. The normal there (`F_NX`, `F_NZ`,
 * from the rectangle to the circle) and `F_DEPTH`, how far the rectangle's support point is inside the circle along it.
 * The face entered does not change with how far along a step the touch is found, which the nearest face of the overlap does.
 */
function roundedEntry(cx: number, cz: number, vx: number, vz: number, hw: number, hl: number, r: number, out: Float64Array): void {
  const speed = hypot2(vx, vz);
  const gx = vx / speed;
  const gz = vz / speed;
  const tx = gx > 0 ? (hw + r - cx) / gx : gx < 0 ? (-hw - r - cx) / gx : Infinity;
  const tz = gz > 0 ? (hl + r - cz) / gz : gz < 0 ? (-hl - r - cz) / gz : Infinity;
  const t = Math.min(tx, tz);
  const ex = cx + gx * t;
  const ez = cz + gz * t;
  let nx: number;
  let nz: number;
  if (Math.abs(ex) > hw && Math.abs(ez) > hl) {
    const kx = ex > 0 ? hw : -hw;
    const kz = ez > 0 ? hl : -hl;
    const dx = cx - kx;
    const dz = cz - kz;
    const b = dx * gx + dz * gz;
    // The walk-back from (cx, cz) along g meets the corner's circle where |d + g t| = r: t = −b + √(b² − (|d|² − r²)).
    const arc = -b + Math.sqrt(Math.max(0, b * b - (dx * dx + dz * dz - r * r)));
    nx = (dx + gx * arc) / r;
    nz = (dz + gz * arc) / r;
  } else if (tx <= tz) {
    nx = gx > 0 ? 1 : -1;
    nz = 0;
  } else {
    nx = 0;
    nz = gz > 0 ? 1 : -1;
  }
  out[F_NX] = nx;
  out[F_NZ] = nz;
  out[F_DEPTH] = r - (nx * cx + nz * cz - hw * Math.abs(nx) - hl * Math.abs(nz));
}

/** `exitFace` answers: not inside, inside and leaving through a side (`F_DEPTH`, `F_NX`, `F_NZ`), inside and leaving through the top. */
const IN_NONE = 0;
export const IN_SIDE = 1;
export const IN_TOP = 2;

/**
 * Whether point (`x`, `y`, `z`) is inside prism `o` of `P` (in plan, over its base, under its top), and the face it came in
 * through: of its faces (the sides, and the top) the one its velocity (`vx`, `vy`, `vz`, less the prism's own) closes on that it
 * crossed last, the one with the least `depth / closing`: how long ago it crossed it. That time stays the same as the point
 * goes deeper, so the face does not change with where in a step the point's first touch fell, and a point that came down onto
 * the top is not a point that came in at the side. A point at rest leaves through the nearest face. A side is written to `out`
 * (`F_*`); a box's end that is a joint (`PR_ENDS`) is no face.
 */
export function exitFace(P: Float64Array, o: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, out: Float64Array): number {
  const dx = x - P[o + PR_X]!;
  const dz = z - P[o + PR_Z]!;
  const rvx = vx - P[o + PR_VX]!;
  const rvz = vz - P[o + PR_VZ]!;
  const r = P[o + PR_R]!;
  const c = P[o + PR_COS]!;
  const s = P[o + PR_SIN]!;
  const u = dx * c - dz * s;
  const w = dx * s + dz * c;
  const moving = rvx * rvx + vy * vy + rvz * rvz > SOLID_AT_REST * SOLID_AT_REST;
  let depth = Infinity;
  let time = Infinity;
  let nx = 0;
  let nz = 0;
  if (r > 0) {
    const d = hypot2(dx, dz);
    if (d >= r) return IN_NONE;
    let entered = false;
    if (hypot2(rvx, rvz) > SOLID_AT_REST) {
      // The face it entered by: the circle's boundary where the point, walked back along its motion, left it.
      roundedEntry(-dx, -dz, rvx, rvz, 0, 0, r, _entry);
      depth = _entry[F_DEPTH]!;
      nx = -_entry[F_NX]!;
      nz = -_entry[F_NZ]!;
      time = depth / Math.max(NOT_CLOSING, -(rvx * nx + rvz * nz));
      entered = time <= ENTRY_WINDOW;
    }
    if (!entered) {
      time = Infinity;
      depth = r - d;
      nx = d > 1e-9 ? dx / d : 1;
      nz = d > 1e-9 ? dz / d : 0;
    }
  } else {
    const hx = P[o + PR_HX]!;
    const hz = P[o + PR_HZ]!;
    if (Math.abs(u) >= hx || Math.abs(w) >= hz) return IN_NONE;
    const ends = P[o + PR_ENDS]!;
    let nearDepth = Infinity;
    let nearFace = -1;
    let timeFace = -1;
    for (let face = 0; face < 4; face++) {
      if (face === 2 && (ends & 2) === 0) continue;
      if (face === 3 && (ends & 1) === 0) continue;
      const faceDepth = face === 0 ? hx - u : face === 1 ? hx + u : face === 2 ? hz - w : hz + w;
      if (faceDepth < nearDepth) {
        nearDepth = faceDepth;
        nearFace = face;
      }
      const fnx = face === 0 ? c : face === 1 ? -c : face === 2 ? s : -s;
      const fnz = face === 0 ? -s : face === 1 ? s : face === 2 ? c : -c;
      const closing = -(rvx * fnx + rvz * fnz);
      if (closing > NOT_CLOSING && faceDepth / closing < time && faceDepth / closing <= ENTRY_WINDOW) {
        time = faceDepth / closing;
        timeFace = face;
      }
    }
    const face = moving && timeFace >= 0 ? timeFace : nearFace;
    if (face < 0) return IN_NONE;
    depth = face === 0 ? hx - u : face === 1 ? hx + u : face === 2 ? hz - w : hz + w;
    nx = face === 0 ? c : face === 1 ? -c : face === 2 ? s : -s;
    nz = face === 0 ? -s : face === 1 ? s : face === 2 ? c : -c;
    if (face !== timeFace) time = Infinity;
  }
  const topDepth = topAt(P, o, u, w) - y;
  const falling = -vy > NOT_CLOSING && moving;
  // The top is the face it came in through when it was crossed more recently than every side (or, at rest, is the nearest).
  const top = moving ? falling && topDepth / -vy < time : topDepth < depth;
  if (top) return IN_TOP;
  out[F_DEPTH] = depth;
  out[F_NX] = nx;
  out[F_NZ] = nz;
  return IN_SIDE;
}

/** A body's plan footprint for `footFace`: its middle (x, z), its right and forward axes (plan unit vectors), and its half width and half length (m). */
export const FOOT_X = 0;
export const FOOT_Z = 1;
export const FOOT_RX = 2;
export const FOOT_RZ = 3;
export const FOOT_FX = 4;
export const FOOT_FZ = 5;
export const FOOT_HW = 6;
export const FOOT_HL = 7;
export const FOOT_SIZE = 8;

/**
 * `footFace`'s output row. A hit: the overlap `FF_PEN` (m) along the unit normal (`FF_NX`, `FF_NZ`, out of the prism toward
 * the footprint), the footprint's deepest point (`FF_CX`, `FF_CZ`), and the prism's own face the body met: its unit normal
 * (`FF_FNX`, `FF_FNZ`), the middle of the face (`FF_FX`, `FF_FZ`), its half width across (`FF_FW`) and the depth behind it
 * (`FF_FD`). No hit: the gap (`FF_GAP`, m, along the prism's axis the footprint is furthest out on) and the speed it is closed
 * at (`FF_CLOSING`, m/s along it; negative when parting).
 */
export const FF_PEN = 0;
export const FF_NX = 1;
export const FF_NZ = 2;
export const FF_CX = 3;
export const FF_CZ = 4;
export const FF_FNX = 5;
export const FF_FNZ = 6;
export const FF_FX = 7;
export const FF_FZ = 8;
export const FF_FW = 9;
export const FF_FD = 10;
export const FF_GAP = 11;
export const FF_CLOSING = 12;
export const FF_SIZE = 13;

/** −1 or 1, never 0: the side of an axis a centre is on (0 sits on the positive side). */
const sign = (v: number): number => (v < 0 ? -1 : 1);

/** The footprint's corners in a box's frame (`jointFace`), in order round it: (+r +f), (+r −f), (−r −f), (−r +f). */
const CORNER_R = [1, 1, -1, -1];
const CORNER_F = [1, -1, -1, 1];
const _cu = new Float64Array(4);
const _cw = new Float64Array(4);
/** The axes `footFace` chooses among: normal (x, z) and overlap of each, and how fast the footprint closes on it. */
const _ax = new Float64Array(4);
const _az = new Float64Array(4);
const _ao = new Float64Array(4);

/**
 * The prism's face a body met, written for the response: a box's wide side, or its end when the box is nearly square, a circle's
 * tangent at the contact. `useWide`: the box is met across (its width `hx` is its face's depth), else along its length.
 */
function setFace(P: Float64Array, o: number, nx: number, nz: number, along: boolean, out: Float64Array): void {
  const half = along ? P[o + PR_HZ]! : P[o + PR_HX]!;
  out[FF_FNX] = nx;
  out[FF_FNZ] = nz;
  out[FF_FX] = P[o + PR_X]! + nx * half;
  out[FF_FZ] = P[o + PR_Z]! + nz * half;
  out[FF_FW] = along ? P[o + PR_HX]! : P[o + PR_HZ]!;
  out[FF_FD] = half;
}

/**
 * The face of prism `o` whose outward normal is nearest (`nx`, `nz`), into the `FF_F*` slots of `out`: a box's side (across or
 * along), a circle's tangent at the normal.
 */
export function sideFace(P: Float64Array, o: number, nx: number, nz: number, out: Float64Array): void {
  const r = P[o + PR_R]!;
  if (r > 0) {
    out[FF_FNX] = nx;
    out[FF_FNZ] = nz;
    out[FF_FX] = P[o + PR_X]! + nx * r;
    out[FF_FZ] = P[o + PR_Z]! + nz * r;
    out[FF_FW] = r;
    out[FF_FD] = r;
    return;
  }
  const along = Math.abs(nx * P[o + PR_SIN]! + nz * P[o + PR_COS]!) > Math.abs(nx * P[o + PR_COS]! - nz * P[o + PR_SIN]!);
  const wx = along ? P[o + PR_SIN]! : P[o + PR_COS]!;
  const wz = along ? P[o + PR_COS]! : -P[o + PR_SIN]!;
  const sgn = nx * wx + nz * wz < 0 ? -1 : 1;
  setFace(P, o, sgn * wx, sgn * wz, along, out);
}

/**
 * The footprint against a wall piece whose end on the body's side is a joint (the wall goes on past it): the piece is met only
 * across it, by the part of the footprint over its own length (|w| ≤ hz), moved along its across axis until that part is on the
 * side of the body's centre; (`FF_CX`, `FF_CZ`) the point of that part deepest in. Separating along the piece's length or the
 * body's own axes there would shove it along the wall at every joint, and the piece's face taken on past its end would stand out
 * of a bend's inner wall into the road.
 */
function jointFace(P: Float64Array, o: number, foot: Float64Array, du: number, dw: number, ru: number, rw: number, fu: number, fw: number, out: Float64Array): boolean {
  const hw = foot[FOOT_HW]!;
  const hl = foot[FOOT_HL]!;
  const hx = P[o + PR_HX]!;
  const hz = P[o + PR_HZ]!;
  for (let q = 0; q < 4; q++) {
    _cu[q] = du + CORNER_R[q]! * hw * ru + CORNER_F[q]! * hl * fu;
    _cw[q] = dw + CORNER_R[q]! * hw * rw + CORNER_F[q]! * hl * fw;
  }
  const side = sign(du);
  let deep = Infinity;
  let ud = 0;
  let wd = 0;
  for (let q = 0; q < 4; q++) {
    const u = _cu[q]!;
    const w = _cw[q]!;
    if (Math.abs(w) <= hz && side * u < deep) {
      deep = side * u;
      ud = u;
      wd = w;
    }
    const u2 = _cu[(q + 1) & 3]!;
    const w2 = _cw[(q + 1) & 3]!;
    for (let e = -1; e <= 1; e += 2) {
      const end = e * hz;
      if ((w - end) * (w2 - end) >= 0) continue;
      const at = u + ((end - w) / (w2 - w)) * (u2 - u);
      if (side * at < deep) {
        deep = side * at;
        ud = at;
        wd = end;
      }
    }
  }
  const pen = hx - deep;
  if (pen <= 0) return false;
  const c = P[o + PR_COS]!;
  const s = P[o + PR_SIN]!;
  out[FF_PEN] = pen;
  out[FF_NX] = side * c;
  out[FF_NZ] = -side * s;
  out[FF_CX] = P[o + PR_X]! + ud * c + wd * s;
  out[FF_CZ] = P[o + PR_Z]! - ud * s + wd * c;
  setFace(P, o, out[FF_NX]!, out[FF_NZ]!, false, out);
  return true;
}

/**
 * Of the `count` axes of `_ax`, `_az` and `_ao` (unit normal toward the footprint, the overlap along it) the one the footprint
 * entered through, by the rule of `exitFace`: of the axes whose overlap is within a step's travel (`slack`, m) of the least,
 * the one closed on that was crossed last (the least overlap / closing speed); where none is closed on, the least overlap.
 * Written alone, it would pick the footprint's own nose axis over a wall it slides along at the wall's length: the slack
 * is what keeps the axes of a graze out.
 */
function enteredAxis(count: number, vx: number, vz: number, slack: number): number {
  let least = Infinity;
  for (let k = 0; k < count; k++) least = Math.min(least, _ao[k]!);
  let best = -1;
  let bestTime = Infinity;
  let nearest = 0;
  for (let k = 0; k < count; k++) {
    if (_ao[k]! < _ao[nearest]!) nearest = k;
    if (_ao[k]! > least + slack) continue;
    const closing = -(vx * _ax[k]! + vz * _az[k]!);
    if (closing > NOT_CLOSING && _ao[k]! / closing < bestTime) {
      bestTime = _ao[k]! / closing;
      best = k;
    }
  }
  return best >= 0 ? best : nearest;
}

/** The footprint's deepest point against the normal (`nx`, `nz`): its support point (an edge's middle when it lies flat on it), into `out`. */
function deepestPoint(foot: Float64Array, nx: number, nz: number, out: Float64Array): void {
  const sr = -Math.sign(nx * foot[FOOT_RX]! + nz * foot[FOOT_RZ]!) * foot[FOOT_HW]!;
  const sf = -Math.sign(nx * foot[FOOT_FX]! + nz * foot[FOOT_FZ]!) * foot[FOOT_HL]!;
  out[FF_CX] = foot[FOOT_X]! + sr * foot[FOOT_RX]! + sf * foot[FOOT_FX]!;
  out[FF_CZ] = foot[FOOT_Z]! + sr * foot[FOOT_RZ]! + sf * foot[FOOT_FZ]!;
}

/**
 * Whether the footprint `foot` overlaps prism `o` of `P` in plan, and the move that clears it by the face it entered through
 * (`enteredAxis`), into `out` (`FF_*`). `vx`, `vz` is the footprint's velocity, `dt` the slice: with no overlap `out` carries the
 * gap and closing speed the approach look-ahead reads (`markApproach`).
 *
 * The whole rectangle meets the prism, not six points on it: a 0.6 m wall end, a palm or a lamp post between the probes went
 * through the middle of a car. A box is met along its own two axes and the footprint's two, pushed to the side the footprint's
 * centre is on; a circle at its nearest point to the footprint, and through the footprint's edge it entered by when its middle
 * is inside. A wall piece is met across only where its end on the footprint's side is a joint (`jointFace`).
 */
export function footFace(P: Float64Array, o: number, foot: Float64Array, vx: number, vz: number, dt: number, out: Float64Array): boolean {
  const px = foot[FOOT_X]!;
  const pz = foot[FOOT_Z]!;
  const rx = foot[FOOT_RX]!;
  const rz = foot[FOOT_RZ]!;
  const fx = foot[FOOT_FX]!;
  const fz = foot[FOOT_FZ]!;
  const hw = foot[FOOT_HW]!;
  const hl = foot[FOOT_HL]!;
  const dx = px - P[o + PR_X]!;
  const dz = pz - P[o + PR_Z]!;
  const rvx = vx - P[o + PR_VX]!;
  const rvz = vz - P[o + PR_VZ]!;
  const slack = hypot2(rvx, rvz) * dt;
  out[FF_GAP] = Infinity;
  out[FF_CLOSING] = 0;
  const radius = P[o + PR_R]!;
  if (radius > 0) {
    // The circle's middle in the footprint's frame, and the footprint point nearest it.
    const lx = -(dx * rx + dz * rz);
    const lz = -(dx * fx + dz * fz);
    const ex = Math.max(-hw, Math.min(hw, lx)) - lx;
    const ez = Math.max(-hl, Math.min(hl, lz)) - lz;
    const d = hypot2(ex, ez);
    if (d >= radius) {
      out[FF_GAP] = d - radius;
      out[FF_CLOSING] = -(rvx * (ex * rx + ez * fx) + rvz * (ex * rz + ez * fz)) / d;
      return false;
    }
    let nx = 0;
    let nz = 0;
    let pen = 0;
    // Moving: the face it entered by, where the circle's middle, walked back along the relative motion, left the footprint grown by the
    // radius, if it crossed that face within `ENTRY_WINDOW` (as `exitFace` asks of a point). A wreck drifting off a trunk at 1 m/s walks
    // back through the car's whole length (3.9 m where it stands 0.11 m in) and has been in far longer: it leaves the way it is nearest.
    let entered = false;
    if (hypot2(rvx, rvz) > SOLID_AT_REST) {
      roundedEntry(lx, lz, rvx * rx + rvz * rz, rvx * fx + rvz * fz, hw, hl, radius, _entry);
      pen = _entry[F_DEPTH]!;
      nx = -(_entry[F_NX]! * rx + _entry[F_NZ]! * fx);
      nz = -(_entry[F_NX]! * rz + _entry[F_NZ]! * fz);
      entered = pen / Math.max(NOT_CLOSING, -(rvx * nx + rvz * nz)) <= ENTRY_WINDOW;
    }
    if (!entered) {
      if (d > 1e-9) {
        pen = radius - d;
        nx = (ex * rx + ez * fx) / d;
        nz = (ex * rz + ez * fz) / d;
      } else {
        // Middle inside the footprint: it leaves through the nearest edge.
        const sideways = hw - Math.abs(lx) < hl - Math.abs(lz);
        pen = radius + (sideways ? hw - Math.abs(lx) : hl - Math.abs(lz));
        nx = -sign(sideways ? lx : lz) * (sideways ? rx : fx);
        nz = -sign(sideways ? lx : lz) * (sideways ? rz : fz);
      }
    }
    out[FF_PEN] = pen;
    out[FF_NX] = nx;
    out[FF_NZ] = nz;
    deepestPoint(foot, nx, nz, out);
    out[FF_FNX] = nx;
    out[FF_FNZ] = nz;
    out[FF_FX] = P[o + PR_X]! + nx * radius;
    out[FF_FZ] = P[o + PR_Z]! + nz * radius;
    out[FF_FW] = radius;
    out[FF_FD] = radius;
    return true;
  }
  const c = P[o + PR_COS]!;
  const s = P[o + PR_SIN]!;
  const hx = P[o + PR_HX]!;
  const hz = P[o + PR_HZ]!;
  const ends = P[o + PR_ENDS]!;
  // The box's axes u = (c, −s) across and w = (s, c) along; the footprint's r and f as (u, w) parts.
  const ru = rx * c - rz * s;
  const rw = rx * s + rz * c;
  const fu = fx * c - fz * s;
  const fw = fx * s + fz * c;
  const du = dx * c - dz * s;
  const dw = dx * s + dz * c;
  const dr = dx * rx + dz * rz;
  const df = dx * fx + dz * fz;
  const oU = hx + hw * Math.abs(ru) + hl * Math.abs(fu) - Math.abs(du);
  const oW = hz + hw * Math.abs(rw) + hl * Math.abs(fw) - Math.abs(dw);
  const oR = hw + hx * Math.abs(ru) + hz * Math.abs(rw) - Math.abs(dr);
  const oF = hl + hx * Math.abs(fu) + hz * Math.abs(fw) - Math.abs(df);
  const jointEnd = (ends & (dw < 0 ? 1 : 2)) === 0;
  if (oU <= 0 || oW <= 0 || oR <= 0 || oF <= 0) {
    // Clear: its gap along the axis of the box it is furthest out on, closing along that axis (a joint's end is no axis).
    if (jointEnd || -oU >= -oW) {
      out[FF_GAP] = -oU;
      out[FF_CLOSING] = sign(du) * (rvx * c - rvz * s) * -1;
    } else {
      out[FF_GAP] = -oW;
      out[FF_CLOSING] = sign(dw) * (rvx * s + rvz * c) * -1;
    }
    return false;
  }
  if (jointEnd) return jointFace(P, o, foot, du, dw, ru, rw, fu, fw, out);
  _ax[0] = sign(du) * c;
  _az[0] = -sign(du) * s;
  _ao[0] = oU;
  _ax[1] = sign(dw) * s;
  _az[1] = sign(dw) * c;
  _ao[1] = oW;
  _ax[2] = sign(dr) * rx;
  _az[2] = sign(dr) * rz;
  _ao[2] = oR;
  _ax[3] = sign(df) * fx;
  _az[3] = sign(df) * fz;
  _ao[3] = oF;
  const k = enteredAxis(4, rvx, rvz, slack);
  const nx = _ax[k]!;
  const nz = _az[k]!;
  out[FF_PEN] = _ao[k]!;
  out[FF_NX] = nx;
  out[FF_NZ] = nz;
  deepestPoint(foot, nx, nz, out);
  // The prism's own face. A race wall's panel (a long thin one) is met on its wide side, never its end, which is the joint to the next
  // panel (a wall's start under a car already past the line pushes it along the wall, not back down it). Any other prism is met on the one
  // of its own axes the body entered by, else the one a body axis lies along: a star arm's tip is met on its end, where the car came in,
  // not on the flank beside it (the face's normal then agreed with the push's, and the slab's crush law applied); else the side it is least deep along.
  const alignU = Math.abs(nx * c - nz * s);
  const alignW = Math.abs(nx * s + nz * c);
  const panel = P[o + PR_WALL] === ROLE_WALL;
  const wide = panel && hx * 2 < hz ? true : k < 2 ? k === 0 : Math.max(alignU, alignW) > PARALLEL ? alignU > alignW : hx * 2 < hz ? true : hz * 2 < hx ? false : oU <= oW;
  setFace(P, o, wide ? sign(du) * c : sign(dw) * s, wide ? -sign(du) * s : sign(dw) * c, !wide, out);
  return true;
}
