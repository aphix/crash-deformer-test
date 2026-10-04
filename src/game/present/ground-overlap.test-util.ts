/**
 * Headless ground-layer overlap scan: where two ground layers (terrain, road / runoff ribbons, marks, kerbs ...) cover the
 * same (x, z) closer in depth than the depth buffer can tell apart, so the nearer one flickers through the other.
 *
 * The depth buffer is `DEPTH_BITS` fixed point over the camera's near / far, so one step is `z² (far - near) / (far · near · 2^bits)`
 * metres at distance z. Two layers `g` metres apart in height are `g / step(z)` steps apart in depth, plus the difference of their
 * `polygonOffsetUnits` (one unit is one depth step at any distance). A pair is ambiguous when that separation is under `MIN_STEPS`
 * (vertex depth and its interpolation carry about a step of error) at `RANGE`. The slope term of polygonOffset only helps, and
 * is ignored. A layer drawn in front of one that lies more than `INVERT_GAP` above it is ambiguous too.
 */

import type { Track } from "../world/track.ts";
import { levelOffset } from "../world/ground-stack.ts";
import { buildGroundLayers } from "./track-ground.ts";
import { RoadIndex, sections } from "./track-mesh.ts";

export const DEPTH_BITS = 24;
export const CAMERA_NEAR = 0.1;
/** The race camera's far plane (m); the menu scenes use 180. */
export const CAMERA_FAR = 900;
/** Reference distance (m) the ground must order correctly at: a chase cam sees cars 100+ m down the road. */
export const RANGE = 150;
/** A layer ordered behind one this much (m) below it is drawn the wrong way round. */
export const INVERT_GAP = 0.15;
/** Depth steps two layers must be apart. */
export const MIN_STEPS = 3;
/** Scan cell (m). */
export const SCAN_CELL = 0.25;
/** Side (m) of the bins an overlap's spots are grouped in. */
export const SPOT_BIN = 12;

/** Metres of height one depth step spans at distance `z`. */
export function depthStep(z: number, near = CAMERA_NEAR, far = CAMERA_FAR, bits = DEPTH_BITS): number {
  return (z * z * (far - near)) / (far * near * 2 ** bits);
}

/** A ground layer's triangles and the depth offset its material applies (`polygonOffsetUnits`, + = pushed away). */
export type ScanLayer = { name: string; pos: ArrayLike<number>; idx: ArrayLike<number>; units: number };

export type Overlap = {
  a: string;
  b: string;
  /** Area (m²) where the pair is under `MIN_STEPS` apart at `RANGE`. */
  area: number;
  /** Smallest separation (depth steps at `RANGE`, offsets included) in that area. */
  minSteps: number;
  /** Smallest height gap (m) in that area. */
  minGap: number;
  /** Centre of the worst cell. */
  x: number;
  z: number;
  /** The largest `SPOT_BIN` m bins of the overlap: [centre x, centre z, area m²]. */
  spots: [number, number, number][];
};

type Hit = { layer: number; y: number };

/**
 * Every pair of layers whose separation at `RANGE` is under `MIN_STEPS`, with the area, worst separation and its place.
 * `sparse` names the layers that are rasterised only where another layer already is (the terrain: it would be most of the map).
 * `cell` is the raster step (m): an overlap thinner than it can be missed.
 */
export function scanOverlaps(layers: readonly ScanLayer[], range = RANGE, cell = SCAN_CELL, sparse: readonly string[] = ["terrain"]): Overlap[] {
  const step = depthStep(range);
  const cells = new Map<number, Hit[]>();
  const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  const raster = (li: number, onlyKnown: boolean) => {
    const { pos, idx } = layers[li]!;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const ia = idx[t]! * 3;
      const ib = idx[t + 1]! * 3;
      const ic = idx[t + 2]! * 3;
      const ax = pos[ia]!;
      const ay = pos[ia + 1]!;
      const az = pos[ia + 2]!;
      const bx = pos[ib]!;
      const by = pos[ib + 1]!;
      const bz = pos[ib + 2]!;
      const cx = pos[ic]!;
      const cy = pos[ic + 1]!;
      const cz = pos[ic + 2]!;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const i0 = Math.floor(Math.min(ax, bx, cx) / cell);
      const i1 = Math.floor(Math.max(ax, bx, cx) / cell);
      const j0 = Math.floor(Math.min(az, bz, cz) / cell);
      const j1 = Math.floor(Math.max(az, bz, cz) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          const list = cells.get(k);
          if (onlyKnown && !list) continue;
          const x = (i + 0.5) * cell;
          const z = (j + 0.5) * cell;
          const l0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
          const l1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const hit = { layer: li, y: l0 * ay + l1 * by + l2 * cy };
          // A centre exactly on a shared edge lies in both triangles: the layer counts once there.
          if (list?.some((h) => h.layer === li && Math.abs(h.y - hit.y) < 1e-6)) continue;
          if (list) list.push(hit);
          else cells.set(k, [hit]);
        }
      }
    }
  };
  layers.forEach((l, li) => {
    if (!sparse.includes(l.name)) raster(li, false);
  });
  layers.forEach((l, li) => {
    if (sparse.includes(l.name)) raster(li, true);
  });

  const out = new Map<string, Overlap>();
  const bins = new Map<string, Map<string, [number, number, number]>>();
  for (const [k, list] of cells) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const hp = list[p]!;
        const hq = list[q]!;
        // One mesh (one material, one colour, uv from world xz): coplanar parts of it look the same whichever wins.
        if (layers[hp.layer]!.name === layers[hq.layer]!.name) continue;
        // Separation in depth steps, positive when the higher layer also draws in front.
        const hi = hp.y >= hq.y ? hp : hq;
        const lo = hi === hp ? hq : hp;
        const gap = hi.y - lo.y;
        const steps = gap / step + layers[lo.layer]!.units - layers[hi.layer]!.units;
        // Ambiguous: too close in depth, or ordered against their heights by more than INVERT_GAP (a level drawing in front of a surface that is clearly above it).
        if (Math.abs(steps) >= MIN_STEPS && (steps > 0 || gap <= INVERT_GAP)) continue;
        const a = layers[hi.layer]!.name;
        const b = layers[lo.layer]!.name;
        const id = `${a}|${b}`;
        let o = out.get(id);
        if (!o) {
          o = { a, b, area: 0, minSteps: Infinity, minGap: Infinity, x: 0, z: 0, spots: [] };
          out.set(id, o);
          bins.set(id, new Map());
        }
        const cx = (Math.floor(k / 65536) - 32768 + 0.5) * cell;
        const cz = ((k % 65536) - 32768 + 0.5) * cell;
        const bk = `${Math.floor(cx / SPOT_BIN)},${Math.floor(cz / SPOT_BIN)}`;
        const bin = bins.get(id)!;
        const spot = bin.get(bk);
        if (spot) spot[2] += cell * cell;
        else bin.set(bk, [(Math.floor(cx / SPOT_BIN) + 0.5) * SPOT_BIN, (Math.floor(cz / SPOT_BIN) + 0.5) * SPOT_BIN, cell * cell]);
        o.area += cell * cell;
        o.minGap = Math.min(o.minGap, gap);
        if (Math.abs(steps) < o.minSteps) {
          o.minSteps = Math.abs(steps);
          o.x = cx;
          o.z = cz;
        }
      }
    }
  }
  for (const [id, o] of out) o.spots = [...bins.get(id)!.values()].sort((u, v) => v[2] - u[2]).slice(0, 3);
  return [...out.values()].sort((u, v) => v.area - u.area);
}

/** A course's ground meshes as the scan's layers, named by kind and surface, with the depth offset `TrackArt` gives them. */
export function courseLayers(track: Track): ScanLayer[] {
  const paths = track.paths();
  const layers = buildGroundLayers(track, track.ground(), new RoadIndex(paths), paths, paths.map((p) => sections(p, 0)));
  return layers.map((l) => ({ name: l.surface && l.kind !== "terrain" ? `${l.kind}.${l.surface}` : l.kind, pos: l.m.pos, idx: l.m.idx, units: levelOffset(l.level).polygonOffsetUnits }));
}
