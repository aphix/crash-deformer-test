/**
 * Headless ground-layer overlap scan: where two ground layers (terrain, road / runoff ribbons, marks, kerbs ...) cover the
 * same (x, z), can the renderer tell which is in front? Layers above the terrain are painted over what is below them in the
 * order of the one stack (`scenes/ground-stack.ts`) and write no depth, so two of them are ambiguous only where the one
 * painted later lies clearly under the one painted earlier. A layer that writes depth (the terrain, a bridge deck) is
 * compared with what is drawn on it by depth: the depth buffer is `DEPTH_BITS` fixed point over the camera's near / far, so
 * one step is `z² (far - near) / (far · near · 2^bits)` metres of view depth at distance z, and a height `g` between two
 * planes seen from a camera `CAMERA_HEIGHT` up at that distance is `g · z / CAMERA_HEIGHT` of it (a grazing view). The lift
 * of the layer drawn on it (pixels of the ground's depth slope, `depthSlope`) adds to its height; the pair is ambiguous when
 * the result is under the raster noise (`rasterNoise`).
 */

import type { Track } from "../world/track.ts";
import { GROUND_LIFT_PX, isBaseLevel, levelOrder } from "../scenes/ground-stack.ts";
import { buildGroundLayers } from "./track-ground.ts";
import { RoadIndex, sections } from "./track-mesh.ts";

export const DEPTH_BITS = 24;
export const CAMERA_NEAR = 0.1;
/** The race camera's far plane (m); the menu scenes use 180. */
export const CAMERA_FAR = 900;
/** Reference distance (m) the ground must order correctly at: a chase cam sees cars 100+ m down the road, and the fog is thin out to here. */
export const RANGE = 250;
/** Height (m) of the chase camera over the road; its floor is 0.45 m, a hood cam sits at about 1.2 m. */
export const CAMERA_HEIGHT = 2.4;
/** Sub-pixel bits of a GPU that rounds vertices coarsely (4 is the least GLES 3 allows; desktop GPUs have 8). */
export const SUBPIXEL_BITS = 4;
/** A layer painted over one this much (m) above it is drawn the wrong way round. */
export const INVERT_GAP = 0.15;
/** Scan cell (m). */
export const SCAN_CELL = 0.25;
/** Side (m) of the bins an overlap's spots are grouped in. */
export const SPOT_BIN = 12;

/** Metres of view depth one depth step spans at distance `z`. */
export function depthStep(z: number, near = CAMERA_NEAR, far = CAMERA_FAR, bits = DEPTH_BITS): number {
  return (z * z * (far - near)) / (far * near * 2 ** bits);
}

/**
 * Depth steps one pixel row of flat ground climbs, seen from a camera `height` up with a vertical field of view `fov` (deg) over
 * `pixels` rows: the same at every distance, since both the step and the climb grow with the square of it.
 */
export function depthSlope(height = CAMERA_HEIGHT, fov = 62, pixels = 616, near = CAMERA_NEAR, far = CAMERA_FAR, bits = DEPTH_BITS): number {
  const focal = pixels / 2 / Math.tan((fov * Math.PI) / 360);
  return (far * near * 2 ** bits) / ((far - near) * height * focal);
}

/** Depth steps two planes of the same slope can differ by through vertex rounding to 1/2^bits px (at worst, both corners of a pixel). */
export function rasterNoise(height = CAMERA_HEIGHT, bits = SUBPIXEL_BITS): number {
  return (depthSlope(height) * Math.SQRT2) / 2 ** (bits + 1);
}

/** Depth steps a height of `g` metres between two planes spans at distance `z` from a camera `height` up. */
export function heightSteps(g: number, z: number, height = CAMERA_HEIGHT): number {
  return (g * z) / height / depthStep(z);
}

/** A ground layer's triangles and how it is drawn: its place in the draw order, whether it writes depth, how much nearer (pixels of its depth slope) it is tested than it lies. */
export type ScanLayer = { name: string; pos: ArrayLike<number>; idx: ArrayLike<number>; order: number; writes: boolean; lift: number };

export type Overlap = {
  a: string;
  b: string;
  /** Area (m²) where the pair is ambiguous at `RANGE`. */
  area: number;
  /** Smallest separation (depth steps; 0 for a pair painted the wrong way round) in that area. */
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
 * Every pair of layers the renderer cannot tell apart at `RANGE`, with the area, worst separation and its place.
 * `sparse` names the layers that are rasterised only where another layer already is (the terrain: it would be most of the map).
 * `cell` is the raster step (m): an overlap thinner than it can be missed. `noise` is the separation (steps) a pair needs.
 */
export function scanOverlaps(layers: readonly ScanLayer[], range = RANGE, cell = SCAN_CELL, sparse: readonly string[] = ["terrain"], noise = rasterNoise()): Overlap[] {
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
  for (const [li, l] of layers.entries()) {
    if (!sparse.includes(l.name)) raster(li, false);
  }
  for (const [li, l] of layers.entries()) {
    if (sparse.includes(l.name)) raster(li, true);
  }

  const out = new Map<string, Overlap>();
  const bins = new Map<string, Map<string, [number, number, number]>>();
  for (const [k, list] of cells) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const hp = list[p]!;
        const hq = list[q]!;
        const lp = layers[hp.layer]!;
        const lq = layers[hq.layer]!;
        const gap = Math.abs(hp.y - hq.y);
        let steps: number;
        if (lp.name === lq.name) {
          // One mesh: parts of it that lie at one height look the same; painted in index order, parts at two heights are a coin toss.
          if (lp.writes || gap <= INVERT_GAP) continue;
          steps = 0;
        } else {
          const pBack = lp.order <= lq.order;
          const back = pBack ? lp : lq;
          const front = pBack ? lq : lp;
          const yBack = pBack ? hp.y : hq.y;
          const yFront = pBack ? hq.y : hp.y;
          if (!back.writes) {
            // Painted over: wrong only where the one painted later lies clearly under the one painted earlier.
            if (yBack - yFront <= INVERT_GAP) continue;
            steps = 0;
          } else if (front.order === back.order) {
            // Two depth-writing layers (a bridge's top and its paint): by height alone.
            steps = heightSteps(gap, range);
          } else {
            // Drawn on a depth-writing layer: its height over it and its lift, against the raster noise.
            steps = heightSteps(yFront - yBack, range) + (front.lift - back.lift) * depthSlope();
          }
          if (Math.abs(steps) >= noise) continue;
        }
        const [first, second] = lp.name < lq.name ? [lp.name, lq.name] : [lq.name, lp.name];
        const id = `${first}|${second}`;
        let o = out.get(id);
        if (!o) {
          o = { a: first, b: second, area: 0, minSteps: Infinity, minGap: Infinity, x: 0, z: 0, spots: [] };
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
        if (steps < o.minSteps) {
          o.minSteps = steps;
          o.x = cx;
          o.z = cz;
        }
      }
    }
  }
  for (const [id, o] of out) o.spots = [...bins.get(id)!.values()].sort((u, v) => v[2] - u[2]).slice(0, 3);
  return [...out.values()].sort((u, v) => v.area - u.area);
}

/** A course's ground meshes as the scan's layers, named by kind and surface (a bridge's with `.deck`), drawn as `TrackArt` draws them. */
export function courseLayers(track: Track): ScanLayer[] {
  const paths = track.paths();
  const layers = buildGroundLayers(track, track.ground(), new RoadIndex(paths), paths, paths.map((p) => sections(p, 0)));
  return layers.map((l) => ({
    name: `${l.surface && l.kind !== "terrain" ? `${l.kind}.${l.surface}` : l.kind}${l.level === "deck" ? ".deck" : ""}`,
    pos: l.m.pos,
    idx: l.m.idx,
    order: levelOrder(l.level),
    writes: isBaseLevel(l.level),
    lift: isBaseLevel(l.level) ? 0 : GROUND_LIFT_PX,
  }));
}
