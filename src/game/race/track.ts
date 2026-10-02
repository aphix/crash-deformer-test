import * as THREE from "three";
import { STEP_UP, type Ground } from "../ground.ts";
import { clamp01, wrapPi } from "../scalar.ts";
import { SURFACE_IDS, SURFACES, type SurfaceId } from "./catalog.ts";
import { parseTrack, type TrackJson } from "./track-schema.ts";

/**
 * A track JSON compiled into arc-length samples (≈1 m apart), gates, the start
 * grid, wall clipping and a baked ground. Pure: THREE is used for maths only.
 *
 * Frame: yaw 0 faces +Z, forward = (sin yaw, cos yaw), left = (tz, −tx);
 * `lateral` > 0 is left of the driving direction.
 */

const STEP = 1;
/** Projection search half-window (samples) around a hint. */
const WINDOW = 24;
/** Beyond the wall line the ground eases back to the base terrain over this (m). */
const BLEND = 24;
/** Depth of the wall band (m): only cars within it are clipped, so open ground beyond is left alone. */
const WALL_BAND = 2.5;
const CELL = 1;
/** Deck lookup cell (m). */
const DECK_CELL = 8;
/**
 * A shortcut's gates reach this far (m) beyond its road edge: a designed shortcut usually crosses
 * open ground (the oval's infield), and a car driving the grass beside the dirt is still taking it.
 */
const SHORTCUT_REACH = 8;

function deckKey(i: number, j: number): number {
  return (i + 4096) * 8192 + (j + 4096);
}

/** A gate segment a→b; crossing it along (nx, nz) counts. */
type Gate = { ax: number; az: number; bx: number; bz: number; nx: number; nz: number; s: number };

/** A sampled spline: the main loop or a shortcut path. */
export type TrackPath = {
  closed: boolean;
  count: number;
  length: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** Flat unit tangent. */
  tx: Float64Array;
  tz: Float64Array;
  /** Half road width. */
  half: Float64Array;
  /** Bank (rad), > 0 raises the right edge. */
  bank: Float64Array;
  /** Signed curvature (1/m), > 0 turns left. */
  curv: Float64Array;
  runL: Float64Array;
  runR: Float64Array;
  wallL: Uint8Array;
  wallR: Uint8Array;
  /** Index into `SURFACE_IDS`. */
  surface: Uint8Array;
  runSurface: Uint8Array;
  /** 1 on a bridge span (analytic deck, not in the heightfield). */
  deck: Uint8Array;
  /** 1 under a tunnel roof (art only). */
  tunnel: Uint8Array;
};

type Shortcut = { id: string; from: number; to: number; path: TrackPath; gates: Gate[] };

/** A traffic side street. */
type Route = { id: string; path: TrackPath; count: number; lanes: readonly { offset: number; dir: 1 | -1 }[] };

export type Projection = {
  /** Segment start sample. */
  k: number;
  /** Arc length (m) of the nearest centreline point. */
  s: number;
  lateral: number;
  dist2: number;
  /** Nearest centreline point. */
  cx: number;
  cz: number;
};

export function blankProjection(): Projection {
  return { k: -1, s: 0, lateral: 0, dist2: 0, cx: 0, cz: 0 };
}

export type TrackPoint = { x: number; y: number; z: number; tx: number; tz: number; half: number };

export function blankPoint(): TrackPoint {
  return { x: 0, y: 0, z: 0, tx: 0, tz: 1, half: 0 };
}

/** Segment k → k + 1 of a path (wrapping) and where a point falls along it: f = 0 at k, 1 at k + 1, unclamped. */
type PathSegment = { b: number; ex: number; ez: number; len2: number; f: number };

export function blankSegment(): PathSegment {
  return { b: 0, ex: 0, ez: 0, len2: 0, f: 0 };
}

export function segmentAt(p: TrackPath, k: number, x: number, z: number, out: PathSegment): PathSegment {
  const b = (out.b = (k + 1) % p.count);
  const ex = (out.ex = p.x[b]! - p.x[k]!);
  const ez = (out.ez = p.z[b]! - p.z[k]!);
  out.len2 = ex * ex + ez * ez || 1e-12;
  out.f = ((x - p.x[k]!) * ex + (z - p.z[k]!) * ez) / out.len2;
  return out;
}

export type WallHit = { x: number; z: number; nx: number; nz: number; k: number };

/** A spot on the course: position (y = the path's height there, for picking the ground layer) and heading. */
type Placement = { x: number; y: number; z: number; yaw: number };

type NodeAttrs = {
  y: number[];
  width: number[];
  bank: number[];
  surface: number[];
  runL: number[];
  runR: number[];
  runSurface: number[];
  wallL: number[];
  wallR: number[];
  deck: number[];
  tunnel: number[];
};

/** Resolve inheritance: an omitted field takes the previous node's value; node 0 takes `road`. */
function nodeAttrs(t: TrackJson): NodeAttrs {
  const a: NodeAttrs = { y: [], width: [], bank: [], surface: [], runL: [], runR: [], runSurface: [], wallL: [], wallR: [], deck: [], tunnel: [] };
  let deck = false;
  let tunnel = false;
  let y = 0;
  let width = t.road.width;
  let surface: SurfaceId = t.road.surface;
  let run = t.road.runoff;
  let runSurface: SurfaceId = t.road.runoffSurface;
  let wall = t.road.wall;
  for (const n of t.nodes) {
    y = n.y ?? y;
    width = n.width ?? width;
    surface = n.surface ?? surface;
    run = n.runoff ?? run;
    runSurface = n.runoffSurface ?? runSurface;
    wall = n.wall ?? wall;
    deck = n.deck ?? deck;
    tunnel = n.tunnel ?? tunnel;
    a.y.push(y);
    a.width.push(width);
    a.bank.push((n.bank * Math.PI) / 180);
    a.surface.push(SURFACE_IDS.indexOf(surface));
    a.runL.push(run[0]);
    a.runR.push(run[1]);
    a.runSurface.push(SURFACE_IDS.indexOf(runSurface));
    a.wallL.push(wall[0] ? 1 : 0);
    a.wallR.push(wall[1] ? 1 : 0);
    a.deck.push(deck ? 1 : 0);
    a.tunnel.push(tunnel ? 1 : 0);
  }
  return a;
}

/** Sample a centripetal Catmull-Rom through `pts` every ≈STEP m; per-node scalars are lerped (flags stepped) by segment. */
function samplePath(pts: THREE.Vector3[], closed: boolean, attrs: NodeAttrs): { path: TrackPath; param: Float64Array } {
  const curve = new THREE.CatmullRomCurve3(pts, closed, "centripetal");
  const segs = closed ? pts.length : pts.length - 1;
  curve.arcLengthDivisions = segs * 64;
  const length = curve.getLength();
  const count = Math.max(8, Math.round(length / STEP));
  const n = closed ? count : count + 1;
  const path: TrackPath = {
    closed,
    count: n,
    length,
    x: new Float64Array(n),
    y: new Float64Array(n),
    z: new Float64Array(n),
    tx: new Float64Array(n),
    tz: new Float64Array(n),
    half: new Float64Array(n),
    bank: new Float64Array(n),
    curv: new Float64Array(n),
    runL: new Float64Array(n),
    runR: new Float64Array(n),
    wallL: new Uint8Array(n),
    wallR: new Uint8Array(n),
    surface: new Uint8Array(n),
    runSurface: new Uint8Array(n),
    deck: new Uint8Array(n),
    tunnel: new Uint8Array(n),
  };
  const param = new Float64Array(n);
  const p = new THREE.Vector3();
  const last = attrs.y.length - 1;
  for (let k = 0; k < n; k++) {
    const t = curve.getUtoTmapping(k / count, 0);
    curve.getPoint(t, p);
    path.x[k] = p.x;
    path.y[k] = p.y;
    path.z[k] = p.z;
    param[k] = t * segs;
    const i = Math.min(Math.floor(t * segs), segs - 1);
    const f = t * segs - i;
    const j = closed ? (i + 1) % pts.length : Math.min(i + 1, last);
    const lerp = (arr: number[]) => arr[i]! + (arr[j]! - arr[i]!) * f;
    path.half[k] = lerp(attrs.width) * 0.5;
    path.bank[k] = lerp(attrs.bank);
    path.runL[k] = lerp(attrs.runL);
    path.runR[k] = lerp(attrs.runR);
    path.wallL[k] = attrs.wallL[i]!;
    path.wallR[k] = attrs.wallR[i]!;
    path.surface[k] = attrs.surface[i]!;
    path.runSurface[k] = attrs.runSurface[i]!;
    path.deck[k] = attrs.deck[i]!;
    path.tunnel[k] = attrs.tunnel[i]!;
  }
  for (let k = 0; k < n; k++) {
    const a = closed ? (k - 1 + n) % n : Math.max(0, k - 1);
    const b = closed ? (k + 1) % n : Math.min(n - 1, k + 1);
    const dx = path.x[b]! - path.x[a]!;
    const dz = path.z[b]! - path.z[a]!;
    const len = Math.hypot(dx, dz) || 1;
    path.tx[k] = dx / len;
    path.tz[k] = dz / len;
  }
  const ds = length / count;
  for (let k = 0; k < n; k++) {
    const a = closed ? (k - 1 + n) % n : Math.max(0, k - 1);
    const b = closed ? (k + 1) % n : Math.min(n - 1, k + 1);
    const dh = wrapPi(Math.atan2(path.tx[b]!, path.tz[b]!) - Math.atan2(path.tx[a]!, path.tz[a]!));
    path.curv[k] = b === a ? 0 : dh / (ds * (b > a ? b - a : b + n - a));
  }
  return { path, param };
}

/** Arc length of curve parameter `u` (in node units) by search over the sampled params. */
function sAtParam(path: TrackPath, param: Float64Array, u: number): number {
  const ds = path.length / (path.closed ? path.count : path.count - 1);
  let lo = 0;
  let hi = path.count - 1;
  if (u <= param[0]!) return 0;
  if (u >= param[hi]!) {
    if (!path.closed) return path.length;
    const span = param.length > 1 ? path.x.length : 1;
    const end = param[hi]!;
    return (hi + (u - end) / Math.max(1e-9, span - end)) * ds;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (param[mid]! <= u) lo = mid;
    else hi = mid;
  }
  return (lo + (u - param[lo]!) / Math.max(1e-9, param[hi]! - param[lo]!)) * ds;
}

/** Forward crossing of `g` by the move (x0,z0)→(x1,z1): fraction along the move in [0,1], or −1. */
export function crossGate(g: Gate, x0: number, z0: number, x1: number, z1: number): number {
  const mx = x1 - x0;
  const mz = z1 - z0;
  if (mx * g.nx + mz * g.nz <= 0) return -1;
  const ex = g.bx - g.ax;
  const ez = g.bz - g.az;
  const den = mx * ez - mz * ex;
  if (Math.abs(den) < 1e-12) return -1;
  const wx = g.ax - x0;
  const wz = g.az - z0;
  const t = (wx * ez - wz * ex) / den;
  const u = (wx * mz - wz * mx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

function gateAt(path: TrackPath, s: number, reach: number): Gate {
  const pt = pointOn(path, s, blankPoint());
  const k = sampleIndex(path, s);
  const lx = pt.tz;
  const lz = -pt.tx;
  const left = pt.half + path.runL[k]! + reach;
  const right = pt.half + path.runR[k]! + reach;
  return { ax: pt.x + lx * left, az: pt.z + lz * left, bx: pt.x - lx * right, bz: pt.z - lz * right, nx: pt.tx, nz: pt.tz, s };
}

function sampleIndex(path: TrackPath, s: number): number {
  const segs = path.closed ? path.count : path.count - 1;
  const u = (s / path.length) * segs;
  const k = Math.floor(u);
  return path.closed ? ((k % path.count) + path.count) % path.count : Math.max(0, Math.min(path.count - 1, k));
}

/** Point at arc length `s` on `path` (wrapped on a loop, clamped on an open path). */
export function pointOn(path: TrackPath, s: number, out: TrackPoint): TrackPoint {
  const n = path.count;
  const segs = path.closed ? n : n - 1;
  let u = (s / path.length) * segs;
  if (path.closed) u = ((u % n) + n) % n;
  else u = Math.max(0, Math.min(segs, u));
  let a = Math.floor(u);
  if (!path.closed && a >= n - 1) a = n - 2;
  const f = u - a;
  const b = path.closed ? (a + 1) % n : a + 1;
  out.x = path.x[a]! + (path.x[b]! - path.x[a]!) * f;
  out.y = path.y[a]! + (path.y[b]! - path.y[a]!) * f;
  out.z = path.z[a]! + (path.z[b]! - path.z[a]!) * f;
  const tx = path.tx[a]! + (path.tx[b]! - path.tx[a]!) * f;
  const tz = path.tz[a]! + (path.tz[b]! - path.tz[a]!) * f;
  const len = Math.hypot(tx, tz) || 1;
  out.tx = tx / len;
  out.tz = tz / len;
  out.half = path.half[a]! + (path.half[b]! - path.half[a]!) * f;
  return out;
}

/** Nearest point on segment k→k+1 into `out` if closer than out.dist2. */
function trySegment(path: TrackPath, k: number, x: number, z: number, out: Projection): void {
  const n = path.count;
  const b = path.closed ? (k + 1) % n : k + 1;
  if (b >= n) return;
  const ax = path.x[k]!;
  const az = path.z[k]!;
  const ex = path.x[b]! - ax;
  const ez = path.z[b]! - az;
  const len2 = ex * ex + ez * ez || 1e-12;
  let f = ((x - ax) * ex + (z - az) * ez) / len2;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  const cx = ax + ex * f;
  const cz = az + ez * f;
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= out.dist2) return;
  const segs = path.closed ? n : n - 1;
  out.dist2 = d2;
  out.k = k;
  out.s = ((k + f) / segs) * path.length;
  out.cx = cx;
  out.cz = cz;
  const len = Math.sqrt(len2);
  out.lateral = (dx * ez - dz * ex) / len;
}

/** Nearest centreline point; searches ±WINDOW samples around `hint` (≥ 0), the whole path otherwise or when that lands off the corridor. */
export function projectPath(path: TrackPath, x: number, z: number, hint: number, out: Projection): Projection {
  out.dist2 = Infinity;
  const n = path.count;
  if (hint >= 0 && hint < n) {
    for (let d = -WINDOW; d <= WINDOW; d++) {
      let k = hint + d;
      if (path.closed) k = (k + n) % n;
      else if (k < 0 || k >= n - 1) continue;
      trySegment(path, k, x, z, out);
    }
    const reach = path.half[out.k]! + Math.max(path.runL[out.k]!, path.runR[out.k]!) + 8;
    if (out.dist2 <= reach * reach) return out;
    out.dist2 = Infinity;
  }
  for (let k = 0; k < n; k++) trySegment(path, k, x, z, out);
  return out;
}

/** An unwalled side path (shortcut or traffic street) of one width and surface. */
function sidePath(pts: readonly { x: number; z: number; y?: number }[], width: number, surface: SurfaceId, closed: boolean): { path: TrackPath; param: Float64Array } {
  const n = pts.length;
  const fill = <T>(v: T) => Array.from({ length: n }, () => v);
  const ys = pts.map((p) => p.y ?? 0);
  const sid = SURFACE_IDS.indexOf(surface);
  return samplePath(
    pts.map((p, i) => new THREE.Vector3(p.x, ys[i]!, p.z)),
    closed,
    { y: ys, width: fill(width), bank: fill(0), surface: fill(sid), runL: fill(0), runR: fill(0), runSurface: fill(sid), wallL: fill(0), wallR: fill(0), deck: fill(0), tunnel: fill(0) },
  );
}

/** Distance from (x, z) to gate segment a→b. */
function segDist(g: Gate, x: number, z: number): number {
  const ex = g.bx - g.ax;
  const ez = g.bz - g.az;
  const f = clamp01(((x - g.ax) * ex + (z - g.az) * ez) / (ex * ex + ez * ez || 1));
  return Math.hypot(x - g.ax - ex * f, z - g.az - ez * f);
}

export class Track {
  readonly json: TrackJson;
  readonly id: string;
  readonly name: string;
  readonly path: TrackPath;
  readonly length: number;
  /** Main checkpoint chain in driving order; gates[0] is the start/finish line (s = 0). */
  readonly gates: Gate[];
  readonly shortcuts: Shortcut[];
  /** Arc length (m) of each JSON node on the main loop. */
  readonly nodeS: readonly number[];
  readonly routes: Route[];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private baked: TrackGround | null = null;
  private readonly pt = blankPoint();

  constructor(json: unknown) {
    this.json = parseTrack(json);
    this.id = this.json.id;
    this.name = this.json.name;
    const attrs = nodeAttrs(this.json);
    const pts = this.json.nodes.map((n, i) => new THREE.Vector3(n.x, attrs.y[i]!, n.z));
    const { path, param } = samplePath(pts, true, attrs);
    this.path = path;
    this.length = path.length;
    for (let k = 0; k < path.count; k++) {
      const r = Math.abs(path.curv[k]!);
      const inner = path.curv[k]! > 0 ? path.half[k]! + path.runL[k]! : path.half[k]! + path.runR[k]!;
      if (r > 1e-6 && 1 / r < inner) {
        throw new Error(`${this.id}: turn radius ${(1 / r).toFixed(1)} m at s=${k} is inside its own corridor (${inner.toFixed(1)} m)`);
      }
    }
    this.nodeS = this.json.nodes.map((_, i) => (i === 0 ? 0 : sAtParam(path, param, i)));
    this.gates = this.json.checkpoints.map((c) => gateAt(path, c.node === 0 && c.t === 0 ? 0 : sAtParam(path, param, c.node + c.t), 1.5));
    this.shortcuts = this.json.shortcuts.map((sc) => {
      const sub = sidePath(sc.path, sc.width, sc.surface, false);
      const n = sc.path.length;
      const gates = sc.path.map((_, i) => gateAt(sub.path, i === 0 ? 0 : i === n - 1 ? sub.path.length : sAtParam(sub.path, sub.param, i), SHORTCUT_REACH));
      return { id: sc.id, from: sc.from, to: sc.to, path: sub.path, gates };
    });
    this.routes = (this.json.traffic?.routes ?? []).map((r) => ({
      id: r.id,
      path: sidePath(r.path, r.width, r.surface, r.loop).path,
      count: r.count,
      lanes: r.lanes,
    }));
    this.checkCrossings();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of this.paths()) {
      for (let k = 0; k < p.count; k++) {
        const r = p.half[k]! + Math.max(p.runL[k]!, p.runR[k]!);
        minX = Math.min(minX, p.x[k]! - r);
        maxX = Math.max(maxX, p.x[k]! + r);
        minZ = Math.min(minZ, p.z[k]! - r);
        maxZ = Math.max(maxZ, p.z[k]! + r);
      }
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  /** Every drivable path: the main loop, the shortcuts, the traffic routes. */
  paths(): TrackPath[] {
    return [this.path, ...this.shortcuts.map((s) => s.path), ...this.routes.map((r) => r.path)];
  }

  /**
   * Where the main loop passes over or under itself: no gate may sit there (a car on the other
   * level would cross it), and one of the two levels must be a deck (the heightfield holds one).
   */
  private checkCrossings(): void {
    const p = this.path;
    const n = p.count;
    const L = this.length;
    const ds = L / n;
    for (let a = 0; a < n; a += 2) {
      for (let b = a + 2; b < n; b += 2) {
        const apart = Math.min(b - a, n - (b - a)) * ds;
        if (apart < 40) continue;
        const reach = p.half[a]! + p.half[b]! + 1;
        const dx = p.x[a]! - p.x[b]!;
        const dz = p.z[a]! - p.z[b]!;
        if (dx * dx + dz * dz > reach * reach) continue;
        const dy = Math.abs(p.y[a]! - p.y[b]!);
        if (dy > 1 && !p.deck[a] && !p.deck[b]) {
          throw new Error(`${this.id}: the loop crosses itself ${dy.toFixed(1)} m apart in height near (${p.x[a]!.toFixed(0)}, ${p.z[a]!.toFixed(0)}) without a deck`);
        }
        if (dy > 1 && dy < 4.5) {
          throw new Error(`${this.id}: only ${dy.toFixed(1)} m between the levels near (${p.x[a]!.toFixed(0)}, ${p.z[a]!.toFixed(0)}); a car needs 4.5 m`);
        }
        for (const g of this.gates) {
          for (const k of [a, b]) {
            const sk = k * ds;
            const gap = Math.abs(sk - g.s);
            if (Math.min(gap, L - gap) < 20) continue;
            if (segDist(g, p.x[k]!, p.z[k]!) < p.half[k]! + 3) {
              throw new Error(`${this.id}: checkpoint at s=${g.s.toFixed(0)} sits over another part of the loop`);
            }
          }
        }
      }
    }
  }

  get laps(): number {
    return this.json.laps;
  }

  /** Main-loop point at arc length `s` (wrapped). */
  pointAt(s: number, out: TrackPoint): TrackPoint {
    return pointOn(this.path, s, out);
  }

  project(x: number, z: number, hint: number, out: Projection): Projection {
    return projectPath(this.path, x, z, hint, out);
  }

  /** Arc length of main checkpoint `i`. */
  gateS(i: number): number {
    return this.gates[i]!.s;
  }

  /** Start slot `i` (0 = pole) behind the line, staggered, facing the race direction. */
  gridSlot(i: number): Placement {
    const g = this.json.grid;
    const row = Math.floor(i / g.perRow);
    const col = i % g.perRow;
    const s = this.length - g.back - row * g.spacing - (col * g.spacing) / g.perRow;
    const pt = this.pointAt(s, this.pt);
    const lat = g.perRow === 1 ? 0 : (0.5 - col / (g.perRow - 1)) * 2 * pt.half * 0.55;
    return { x: pt.x + pt.tz * lat, y: pt.y, z: pt.z - pt.tx * lat, yaw: Math.atan2(pt.tx, pt.tz) };
  }

  /**
   * Keep a body of radius `pad` inside the walls. True (and `out` = corrected position plus inward
   * normal) when it was inside a wall band; cars beyond the band (round a wall end) are left alone.
   */
  wallClip(x: number, z: number, pad: number, proj: Projection, out: WallHit): boolean {
    const k = proj.k;
    const p = this.path;
    const left = proj.lateral > 0;
    if (!(left ? p.wallL[k] : p.wallR[k])) return false;
    const limit = p.half[k]! + (left ? p.runL[k]! : p.runR[k]!) - pad;
    const lat = Math.abs(proj.lateral);
    if (lat <= limit || lat > limit + pad + WALL_BAND) return false;
    const n = p.count;
    const b = (k + 1) % n;
    const ex = p.x[b]! - p.x[k]!;
    const ez = p.z[b]! - p.z[k]!;
    const len = Math.hypot(ex, ez) || 1;
    const sx = left ? ez / len : -ez / len;
    const sz = left ? -ex / len : ex / len;
    out.x = proj.cx + sx * limit;
    out.z = proj.cz + sz * limit;
    out.nx = -sx;
    out.nz = -sz;
    out.k = k;
    return true;
  }

  /** The baked ground (built on first use, ≈1 m heightfield over the track bounds). */
  ground(): TrackGround {
    this.baked ??= new TrackGround(this);
    return this.baked;
  }
}

type Stamp = { d2: Float32Array; h: Float32Array; surf: Uint8Array };

/** Heightfield + surface grid baked from a track: road plane (banked), shoulders, eased back to the base terrain. */
export class TrackGround implements Ground {
  readonly minX: number;
  readonly minZ: number;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  readonly surf: Uint8Array;
  private readonly hills: TrackJson["environment"]["hills"];
  private readonly terrain: number;

  constructor(track: Track) {
    const env = track.json.environment;
    this.hills = env.hills;
    this.terrain = SURFACE_IDS.indexOf(env.terrain);
    const m = BLEND + 4;
    this.minX = Math.floor(track.bounds.minX - m);
    this.minZ = Math.floor(track.bounds.minZ - m);
    this.nx = Math.ceil((track.bounds.maxX + m - this.minX) / CELL) + 1;
    this.nz = Math.ceil((track.bounds.maxZ + m - this.minZ) / CELL) + 1;
    const cells = this.nx * this.nz;
    this.heights = new Float32Array(cells);
    this.surf = new Uint8Array(cells).fill(this.terrain);
    const stamp: Stamp = { d2: new Float32Array(cells).fill(Infinity), h: this.heights, surf: this.surf };
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) this.heights[j * this.nx + i] = this.base(this.minX + i * CELL, this.minZ + j * CELL);
    }
    for (const p of track.paths()) this.stampPath(p, stamp);
    this.indexDecks(track.path);
  }

  /** Base terrain: gaussian hills over y = 0. */
  base(x: number, z: number): number {
    let h = 0;
    for (const hl of this.hills) {
      const dx = x - hl.x;
      const dz = z - hl.z;
      h += hl.height * Math.exp(-(dx * dx + dz * dz) / (hl.radius * hl.radius));
    }
    return h;
  }

  private stampPath(p: TrackPath, st: Stamp): void {
    const segs = p.closed ? p.count : p.count - 1;
    for (let k = 0; k < segs; k++) {
      // Bridge spans are analytic decks, not terrain: the ground under them stays.
      if (p.deck[k]) continue;
      const b = (k + 1) % p.count;
      // Ends of the stamped run (an open path's ends, a deck's abutments) are rounded off, not stretched along.
      const openEnd = (!p.closed && b === p.count - 1) || (p.deck[b] === 1 && b < segs);
      const openStart = (!p.closed && k === 0) || p.deck[(k - 1 + p.count) % p.count] === 1;
      const reach = p.half[k]! + Math.max(p.runL[k]!, p.runR[k]!) + BLEND;
      const i0 = Math.max(0, Math.floor((Math.min(p.x[k]!, p.x[b]!) - reach - this.minX) / CELL));
      const i1 = Math.min(this.nx - 1, Math.ceil((Math.max(p.x[k]!, p.x[b]!) + reach - this.minX) / CELL));
      const j0 = Math.max(0, Math.floor((Math.min(p.z[k]!, p.z[b]!) - reach - this.minZ) / CELL));
      const j1 = Math.min(this.nz - 1, Math.ceil((Math.max(p.z[k]!, p.z[b]!) + reach - this.minZ) / CELL));
      const ex = p.x[b]! - p.x[k]!;
      const ez = p.z[b]! - p.z[k]!;
      const len2 = ex * ex + ez * ez || 1e-12;
      const len = Math.sqrt(len2);
      for (let j = j0; j <= j1; j++) {
        const z = this.minZ + j * CELL;
        for (let i = i0; i <= i1; i++) {
          const x = this.minX + i * CELL;
          let f = ((x - p.x[k]!) * ex + (z - p.z[k]!) * ez) / len2;
          const beyond = (f > 1 && openEnd) || (f < 0 && openStart);
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          const cx = p.x[k]! + ex * f;
          const cz = p.z[k]! + ez * f;
          const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
          if (d2 > reach * reach) continue;
          const c = j * this.nx + i;
          if (d2 >= st.d2[c]!) continue;
          st.d2[c] = d2;
          const perp = ((x - cx) * ez - (z - cz) * ex) / len;
          const lat = beyond ? Math.sign(perp || 1) * Math.sqrt(d2) : perp;
          const yc = p.y[k]! + (p.y[b]! - p.y[k]!) * f;
          const half = p.half[k]! + (p.half[b]! - p.half[k]!) * f;
          const bank = p.bank[k]! + (p.bank[b]! - p.bank[k]!) * f;
          const run = lat > 0 ? p.runL[k]! : p.runR[k]!;
          const a = Math.abs(lat);
          const edge = yc - Math.max(-half, Math.min(half, lat)) * Math.tan(bank);
          if (a <= half) {
            st.h[c] = edge;
            st.surf[c] = p.surface[k]!;
          } else if (a <= half + run) {
            st.h[c] = edge;
            st.surf[c] = p.runSurface[k]!;
          } else {
            const t = Math.min(1, (a - half - run) / BLEND);
            const e = t * t * (3 - 2 * t);
            st.h[c] = edge + (this.base(x, z) - edge) * e;
            st.surf[c] = this.terrain;
          }
        }
      }
    }
  }

  /** Bilinear heightfield (no decks). */
  private fieldAt(x: number, z: number): number {
    const u = (x - this.minX) / CELL;
    const v = (z - this.minZ) / CELL;
    if (u < 0 || v < 0 || u >= this.nx - 1 || v >= this.nz - 1) return this.base(x, z);
    const i = u | 0;
    const j = v | 0;
    const fu = u - i;
    const fv = v - j;
    const c = j * this.nx + i;
    const h = this.heights;
    const a = h[c]! + (h[c + 1]! - h[c]!) * fu;
    const b = h[c + this.nx]! + (h[c + this.nx + 1]! - h[c + this.nx]!) * fu;
    return a + (b - a) * fv;
  }

  heightAt(x: number, z: number, y = Infinity): number {
    const h = this.fieldAt(x, z);
    if (this.deckCells.size === 0) return h;
    const d = this.deckAt(x, z, y + STEP_UP);
    return d > h ? d : h;
  }

  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T, y = Infinity): T {
    const e = CELL * 0.5;
    const dx = this.heightAt(x + e, z, y) - this.heightAt(x - e, z, y);
    const dz = this.heightAt(x, z + e, y) - this.heightAt(x, z - e, y);
    const nx = -dx;
    const ny = 2 * e;
    const nz = -dz;
    const len = Math.hypot(nx, ny, nz);
    out.x = nx / len;
    out.y = ny / len;
    out.z = nz / len;
    return out;
  }

  /** Index into `SURFACE_IDS` at (x, z) for a body at height `y` (a deck's surface when it is on one). */
  surfaceIndex(x: number, z: number, y = Infinity): number {
    if (this.deckCells.size > 0) {
      const d = this.deckAt(x, z, y + STEP_UP);
      if (d > -Infinity && d >= this.fieldAt(x, z)) return this.deckSurface;
    }
    const i = Math.round((x - this.minX) / CELL);
    const j = Math.round((z - this.minZ) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return this.terrain;
    return this.surf[j * this.nx + i]!;
  }

  frictionAt(x: number, z: number, y = Infinity): number {
    return SURFACES[SURFACE_IDS[this.surfaceIndex(x, z, y)]!].grip;
  }

  surfaceAt(x: number, z: number, y = Infinity): SurfaceId {
    return SURFACE_IDS[this.surfaceIndex(x, z, y)]!;
  }

  /** Deck segments by 8 m cell. */
  private readonly deckCells = new Map<number, number[]>();
  private deckPath: TrackPath | null = null;
  /** Surface index of the last deck `deckAt` found. */
  private deckSurface = 0;
  private readonly seg = blankSegment();

  private indexDecks(p: TrackPath): void {
    this.deckPath = p;
    for (let k = 0; k < p.count; k++) {
      if (!p.deck[k]) continue;
      const b = (k + 1) % p.count;
      const r = p.half[k]! + Math.max(p.runL[k]!, p.runR[k]!);
      const i0 = Math.floor((Math.min(p.x[k]!, p.x[b]!) - r) / DECK_CELL);
      const i1 = Math.floor((Math.max(p.x[k]!, p.x[b]!) + r) / DECK_CELL);
      const j0 = Math.floor((Math.min(p.z[k]!, p.z[b]!) - r) / DECK_CELL);
      const j1 = Math.floor((Math.max(p.z[k]!, p.z[b]!) + r) / DECK_CELL);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = deckKey(i, j);
          const list = this.deckCells.get(key);
          if (list) list.push(k);
          else this.deckCells.set(key, [k]);
        }
      }
    }
  }

  /** Highest deck surface at (x, z) no higher than `yMax`, −∞ when none. */
  private deckAt(x: number, z: number, yMax: number): number {
    const list = this.deckCells.get(deckKey(Math.floor(x / DECK_CELL), Math.floor(z / DECK_CELL)));
    const p = this.deckPath;
    if (!list || !p) return -Infinity;
    let best = -Infinity;
    for (const k of list) {
      const { b, ex, ez, len2, f } = segmentAt(p, k, x, z, this.seg);
      if (f < -0.02 || f > 1.02) continue;
      const lat = ((x - p.x[k]! - ex * f) * ez - (z - p.z[k]! - ez * f) * ex) / Math.sqrt(len2);
      const half = p.half[k]!;
      const run = lat > 0 ? p.runL[k]! : p.runR[k]!;
      if (Math.abs(lat) > half + run) continue;
      const yc = p.y[k]! + (p.y[b]! - p.y[k]!) * f - Math.max(-half, Math.min(half, lat)) * Math.tan(p.bank[k]!);
      if (yc > yMax || yc <= best) continue;
      best = yc;
      this.deckSurface = Math.abs(lat) <= half ? p.surface[k]! : p.runSurface[k]!;
    }
    return best;
  }
}
