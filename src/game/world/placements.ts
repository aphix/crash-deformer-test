import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import { PREFABS, type PrefabId } from "./catalog.ts";
import { blankPoint, blankProjection, blankSegment, pointOn, projectPath, segmentAt, type Projection, type Track, type TrackPath } from "./track.ts";

/**
 * Where every prop of a track stands, and what it collides with. Pure and deterministic
 * (seeded scatter), so every peer derives the same list from the same JSON.
 *
 * Facing: a prefab's front (grandstand seats, billboard face, lamp arm) is its local +X.
 * At yaw = the local heading, +X points left of travel, so `along` copies on the right side
 * take the heading and copies on the left the heading + π: their fronts face the road.
 */

/** A placed prefab: ground point, yaw (rad, +Z forward at 0), scale factors on `PREFABS[prefab].size`. */
export type Placed = { prefab: PrefabId; x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number };

/**
 * Footprint of a solid / knock placement, or of a piece of a course wall (`wallColliders`). Box half-extents (`hx`, `hz`)
 * lie in the collider's yawed frame: local x = (cos yaw, −sin yaw), local z = (sin yaw, cos yaw). A circle has
 * hx = hz = r; `r` is the bounding radius for both kinds. `mass` (kg) scales with the prop's volume.
 */
export type PropCollider = {
  /** Index into `placeProps` (a wall piece: into `wallColliders`). */
  index: number;
  /** The prop's prefab; null for a piece of a course wall. */
  prefab: PrefabId | null;
  body: "solid" | "knock";
  x: number;
  z: number;
  yaw: number;
  kind: "circle" | "box";
  r: number;
  hx: number;
  hz: number;
  mass: number;
  /** Heights (m, world) of its foot and its top: a car whose highest point is under `base` passes beneath it (a deck's wall or prop over a road), one whose lowest point is above `top` flies over. */
  base: number;
  top: number;
  /**
   * Which ends of a box are faces: bit 0 its −z end, bit 1 its +z end. A cleared bit is the joint to the next piece of a
   * course wall, never met on its own: the wall there goes on. Every prop has both.
   */
  ends: number;
};

/** Scatter points closer than this (m) beyond a corridor's wall line, plus the prop's radius, are rejected. */
const SCATTER_CLEAR = 3;
/** Scatter keeps this far (m) from the start line. */
const START_CLEAR = 25;
const SCATTER_TRIES = 40;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Signed distance (m) from (x, z) to the wall line of `path`'s corridor (< 0 inside road + runoff). */
function wallGap(path: TrackPath, x: number, z: number, proj: Projection): number {
  projectPath(path, x, z, -1, proj);
  const k = proj.k;
  return Math.sqrt(proj.dist2) - path.half[k]! - (proj.lateral > 0 ? path.runL[k]! : path.runR[k]!);
}

function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const len2 = ex * ex + ez * ez || 1e-12;
  const f = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
  const dx = x - ax - ex * f;
  const dz = z - az - ez * f;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Distance (m) from segment (u0, v0)→(u1, v1) to the box |u| ≤ hw, |v| ≤ hd; 0 when they touch. */
function segBoxDist(u0: number, v0: number, u1: number, v1: number, hw: number, hd: number): number {
  // Liang–Barsky clip: any part of the segment inside the box?
  const du = u1 - u0;
  const dv = v1 - v0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    return t0 <= t1;
  };
  if (clip(-du, u0 + hw) && clip(du, hw - u0) && clip(-dv, v0 + hd) && clip(dv, hd - v0)) return 0;
  // Apart: the gap closes at an endpoint or a box corner.
  const toBox = (u: number, v: number) => hypot2(Math.max(Math.abs(u) - hw, 0), Math.max(Math.abs(v) - hd, 0));
  let d = Math.min(toBox(u0, v0), toBox(u1, v1));
  for (const cu of [-hw, hw]) for (const cv of [-hd, hd]) d = Math.min(d, segDist(cu, cv, u0, v0, u1, v1));
  return d;
}

/**
 * Clearance (m) from a drawn footprint (oriented box: centre x, z; `yaw`; half-extents hw on local x,
 * hd on local z) to `path`'s road + runoff; ≤ 0 when it reaches onto them. Exact for the corridor as
 * the union of its segments, each widened by its half width + runoff on the box's side.
 */
function boxClear(path: TrackPath, x: number, z: number, yaw: number, hw: number, hd: number): number {
  const c = detCos(yaw);
  const sn = detSin(yaw);
  const reach = hypot2(hw, hd);
  const segs = path.closed ? path.count : path.count - 1;
  let best = Infinity;
  for (let k = 0; k < segs; k++) {
    const b = (k + 1) % path.count;
    const ax = path.x[k]!;
    const az = path.z[k]!;
    const ex = path.x[b]! - ax;
    const ez = path.z[b]! - az;
    const lat = (x - ax) * ez - (z - az) * ex;
    const w = path.half[k]! + (lat > 0 ? path.runL[k]! : path.runR[k]!);
    if (segDist(x, z, ax, az, ax + ex, az + ez) - reach - w >= best) continue;
    // Segment ends in the box's frame: local x = (cos yaw, −sin yaw), local z = (sin yaw, cos yaw).
    const u0 = (ax - x) * c - (az - z) * sn;
    const v0 = (ax - x) * sn + (az - z) * c;
    best = Math.min(best, segBoxDist(u0, v0, u0 + ex * c - ez * sn, v0 + ex * sn + ez * c, hw, hd) - w);
  }
  return best;
}

/**
 * Height a prop stands at: the ground (terrain or a road at ground level), or a bridge deck when
 * the point is on a deck's road / runoff and not also on a road passing underneath.
 */
function standY(track: Track, x: number, z: number): number {
  const ground = track.ground();
  const field = ground.heightAt(x, z, -1e9);
  const top = ground.heightAt(x, z);
  if (top - field < 0.5) return field;
  const seg = blankSegment();
  for (const p of track.paths()) {
    const segs = p.closed ? p.count : p.count - 1;
    for (let k = 0; k < segs; k++) {
      if (p.deck[k]) continue;
      const { ex, ez, len2, f } = segmentAt(p, k, x, z, seg);
      if (f < 0 || f > 1) continue;
      const lat = ((x - p.x[k]!) * ez - (z - p.z[k]!) * ex) / Math.sqrt(len2);
      if (Math.abs(lat) <= p.half[k]! + (lat > 0 ? p.runL[k]! : p.runR[k]!)) return field;
    }
  }
  return top;
}

/**
 * Every prop of the track, in order: `props` as written, then `along` repeats (beside the race
 * loop, or a traffic route's centreline with `route`; copies on any other road, beside a bridge
 * span or in a tunnel are skipped), then seeded `scatter` (clear of every road: loop, shortcuts,
 * routes). y: see `standY` (ground level, or a deck for a prop on a bridge).
 */
export function placeProps(track: Track): Placed[] {
  const json = track.json;
  const out: Placed[] = [];
  const proj = blankProjection();
  const pt = blankPoint();
  const corridors = track.paths();

  for (const p of json.props) {
    const size = PREFABS[p.prefab].size;
    const s = p.scale;
    out.push({
      prefab: p.prefab,
      x: p.x,
      y: standY(track, p.x, p.z),
      z: p.z,
      yaw: p.yaw,
      sx: (p.size ? p.size[0] / size[0] : 1) * s,
      sy: (p.size ? p.size[1] / size[1] : 1) * s,
      sz: (p.size ? p.size[2] / size[2] : 1) * s,
    });
  }

  const nodeS = (i: number, field: string): number => {
    const s = track.nodeS[i];
    if (s === undefined) throw new Error(`${track.id}: ${field} ${i} ≥ ${track.nodeS.length} nodes`);
    return s;
  };
  for (const [ai, a] of json.along.entries()) {
    const route = a.route === undefined ? null : track.routes.find((r) => r.id === a.route);
    if (route === undefined) throw new Error(`${track.id}: along[${ai}].route ${a.route} is not a traffic route`);
    // The race loop between two nodes (whole loop when the range is empty), or a route's whole centreline.
    const path = route ? route.path : track.path;
    const L = path.length;
    const from = route ? 0 : nodeS(a.fromNode ?? 0, `along[${ai}].fromNode`);
    const to = route ? (path.closed ? 0 : L) : a.toNode === undefined ? from : nodeS(a.toNode, `along[${ai}].toNode`);
    const span = path.closed ? (((to - from) % L) + L) % L : to - from;
    const whole = path.closed && span < 1e-6;
    // A whole loop spreads its copies evenly so the seam at `from` has no short gap.
    const n = whole ? Math.max(1, Math.round(L / a.every)) : Math.floor(span / a.every + 1e-9) + 1;
    const step = whole ? L / n : a.every;
    const segs = path.closed ? path.count : path.count - 1;
    const others = corridors.filter((c) => c !== path);
    const r = PREFABS[a.prefab].foot * a.scale;
    // On its own corridor the drawn footprint (oriented box) must clear the road and runoff too: on a
    // bend the box turns into the road, so a lot inside a corner stays empty. A knock prop (hay bale,
    // cone) may stand on that runoff when the author's `offset` puts it there.
    const size = PREFABS[a.prefab].size;
    const hw = (size[0] * a.scale) / 2;
    const hd = (size[2] * a.scale) / 2;
    const ownClear = PREFABS[a.prefab].body !== "knock";
    for (let j = 0; j < n; j++) {
      const s = from + j * step;
      pointOn(path, s, pt);
      const u = Math.floor((path.closed ? (((s % L) + L) % L) : Math.max(0, Math.min(L, s))) * (segs / L));
      const k = path.closed ? u % path.count : Math.min(path.count - 1, u);
      // Nothing beside a bridge span (it would stand on the ground far below) or inside a tunnel.
      if (path.deck[k] || path.tunnel[k]) continue;
      const heading = Math.atan2(pt.tx, pt.tz);
      for (const sign of a.side === "both" ? [1, -1] : a.side === "left" ? [1] : [-1]) {
        const lat = sign * (pt.half + (sign > 0 ? path.runL[k]! : path.runR[k]!) + a.offset);
        const x = pt.x + pt.tz * lat;
        const z = pt.z - pt.tx * lat;
        const yaw = sign > 0 ? heading + Math.PI : heading;
        // Never on another road: the footprint's bounding circle keeps off it (lots stay clear of junctions).
        if (others.some((c) => wallGap(c, x, z, proj) < r)) continue;
        if (ownClear && boxClear(path, x, z, yaw, hw, hd) < 0) continue;
        out.push({
          prefab: a.prefab,
          x,
          y: standY(track, x, z),
          z,
          yaw,
          sx: a.scale,
          sy: a.scale,
          sz: a.scale,
        });
      }
    }
  }

  const g0 = track.gates[0]!;
  const b = track.bounds;
  for (const sc of json.scatter) {
    const rnd = mulberry32(sc.seed);
    const x0 = b.minX - sc.far;
    const z0 = b.minZ - sc.far;
    const w = b.maxX - b.minX + 2 * sc.far;
    const d = b.maxZ - b.minZ + 2 * sc.far;
    for (let i = 0; i < sc.count; i++) {
      for (let t = 0; t < SCATTER_TRIES; t++) {
        const x = x0 + rnd() * w;
        const z = z0 + rnd() * d;
        const yaw = rnd() * Math.PI * 2;
        const scale = sc.scaleMin + (sc.scaleMax - sc.scaleMin) * rnd();
        let gap = Infinity;
        for (const c of corridors) gap = Math.min(gap, wallGap(c, x, z, proj));
        if (gap < sc.near || gap > sc.far || gap < SCATTER_CLEAR + PREFABS[sc.prefab].foot * scale) continue;
        if (segDist(x, z, g0.ax, g0.az, g0.bx, g0.bz) < START_CLEAR) continue;
        out.push({ prefab: sc.prefab, x, y: standY(track, x, z), z, yaw, sx: scale, sy: scale, sz: scale });
        break;
      }
    }
  }
  return out;
}

/**
 * Colliders of the solid / knock placements, scaled by each placement's sx / sy / sz: one per piece of the prefab's `collider`
 * union, all with the placement's `index` (a knock prop is knocked as one), each piece's offset turned by the placement's yaw
 * (a box also by its own).
 */
export function propColliders(placed: readonly Placed[]): PropCollider[] {
  const out: PropCollider[] = [];
  for (const [index, p] of placed.entries()) {
    const spec = PREFABS[p.prefab];
    if (spec.body === "none") continue;
    const cos = detCos(p.yaw);
    const sin = detSin(p.yaw);
    for (const c of spec.collider) {
      const ox = (c.x ?? 0) * p.sx;
      const oz = (c.z ?? 0) * p.sz;
      const hx = c.kind === "circle" ? c.r * Math.max(p.sx, p.sz) : c.hx * p.sx;
      const hz = c.kind === "circle" ? hx : c.hz * p.sz;
      out.push({
        index,
        prefab: p.prefab,
        body: spec.body,
        x: p.x + ox * cos + oz * sin,
        z: p.z - ox * sin + oz * cos,
        yaw: p.yaw + (c.kind === "box" ? (c.yaw ?? 0) : 0),
        kind: c.kind,
        r: c.kind === "circle" ? hx : Math.sqrt(hx * hx + hz * hz),
        hx,
        hz,
        mass: spec.mass * p.sx * p.sy * p.sz,
        base: p.y + (c.y0 ?? 0) * p.sy,
        top: p.y + (c.y1 ?? spec.size[1]) * p.sy,
        ends: 3,
      });
    }
  }
  return out;
}
