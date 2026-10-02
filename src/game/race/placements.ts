import { PREFABS, type PrefabId } from "./catalog.ts";
import { blankPoint, blankProjection, pointOn, projectPath, type Projection, type Track, type TrackPath } from "./track.ts";

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
 * Footprint of a solid / knock placement. Box half-extents (`hx`, `hz`) lie in the prop's yawed
 * frame: local x = (cos yaw, −sin yaw), local z = (sin yaw, cos yaw). A circle has hx = hz = r;
 * `r` is the bounding radius for both kinds. `mass` (kg) scales with the prop's volume.
 */
export type PropCollider = {
  /** Index into `placeProps`. */
  index: number;
  prefab: PrefabId;
  body: "solid" | "knock";
  x: number;
  z: number;
  yaw: number;
  kind: "circle" | "box";
  r: number;
  hx: number;
  hz: number;
  mass: number;
};

/** Scatter points closer than this (m) beyond a corridor's wall line, plus the prop's radius, are rejected. */
const SCATTER_CLEAR = 3;
/** Scatter keeps this far (m) from the start line. */
const START_CLEAR = 25;
const SCATTER_TRIES = 40;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bounding radius (m) of a prefab's collider at scale (sx, sz); 0 without one. */
function footRadius(prefab: PrefabId, sx: number, sz: number): number {
  const c = PREFABS[prefab].collider;
  if (!c) return 0;
  return c.kind === "circle" ? c.r * Math.max(sx, sz) : Math.sqrt((c.hx * sx) ** 2 + (c.hz * sz) ** 2);
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

/**
 * Height a prop stands at: the ground (terrain or a road at ground level), or a bridge deck when
 * the point is on a deck's road / runoff and not also on a road passing underneath.
 */
function standY(track: Track, x: number, z: number): number {
  const ground = track.ground();
  const field = ground.heightAt(x, z, -1e9);
  const top = ground.heightAt(x, z);
  if (top - field < 0.5) return field;
  for (const p of track.paths()) {
    const segs = p.closed ? p.count : p.count - 1;
    for (let k = 0; k < segs; k++) {
      if (p.deck[k]) continue;
      const b = (k + 1) % p.count;
      const ex = p.x[b]! - p.x[k]!;
      const ez = p.z[b]! - p.z[k]!;
      const len2 = ex * ex + ez * ez || 1e-12;
      const f = ((x - p.x[k]!) * ex + (z - p.z[k]!) * ez) / len2;
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
  json.along.forEach((a, ai) => {
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
    const r = footRadius(a.prefab, a.scale, a.scale);
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
        // Never on another road (its own corridor is the author's call via `offset`).
        if (others.some((c) => wallGap(c, x, z, proj) < r)) continue;
        out.push({
          prefab: a.prefab,
          x,
          y: standY(track, x, z),
          z,
          yaw: sign > 0 ? heading + Math.PI : heading,
          sx: a.scale,
          sy: a.scale,
          sz: a.scale,
        });
      }
    }
  });

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
        if (gap < sc.near || gap > sc.far || gap < SCATTER_CLEAR + footRadius(sc.prefab, scale, scale)) continue;
        if (segDist(x, z, g0.ax, g0.az, g0.bx, g0.bz) < START_CLEAR) continue;
        out.push({ prefab: sc.prefab, x, y: standY(track, x, z), z, yaw, sx: scale, sy: scale, sz: scale });
        break;
      }
    }
  }
  return out;
}

/** Colliders of the solid / knock placements, scaled by each placement's sx / sz. */
export function propColliders(placed: readonly Placed[]): PropCollider[] {
  const out: PropCollider[] = [];
  placed.forEach((p, index) => {
    const spec = PREFABS[p.prefab];
    const c = spec.collider;
    if (spec.body === "none" || !c) return;
    const hx = c.kind === "circle" ? c.r * Math.max(p.sx, p.sz) : c.hx * p.sx;
    const hz = c.kind === "circle" ? hx : c.hz * p.sz;
    out.push({
      index,
      prefab: p.prefab,
      body: spec.body,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      kind: c.kind,
      r: c.kind === "circle" ? hx : Math.sqrt(hx * hx + hz * hz),
      hx,
      hz,
      mass: spec.mass * p.sx * p.sy * p.sz,
    });
  });
  return out;
}
