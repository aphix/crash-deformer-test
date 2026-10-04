import { SURFACE_IDS } from "./catalog.ts";
import type { TrackJson } from "./track-schema.ts";

/**
 * Terrain features the heightfield adds after the roads are stamped (`TrackGround`): raised platforms, and surface paint.
 * Pure.
 *
 * A plateau is a flat top at `height` whose every side falls in one plane to the ground over its `run`, each corner a
 * cone. A crest (top to plane) and a foot (plane to ground) are a parabola `round` m either side of their line: a bend a
 * car's four tyres can follow, where a bare kink hangs two of them at once (ground-fit matrix, round 0 vs 3 m). The
 * footprint plus `round` must be clear of every road (`checkPlateaus`).
 */
export type Plateau = TrackJson["environment"]["plateaus"][number];
type Paint = TrackJson["environment"]["paint"][number];

/** The part of a `TrackPath` the road check reads. */
type Corridor = { count: number; x: ArrayLike<number>; z: ArrayLike<number>; tx: ArrayLike<number>; tz: ArrayLike<number>; half: ArrayLike<number>; runL: ArrayLike<number>; runR: ArrayLike<number> };

/** max(0, x) with its corner rounded to a parabola over ±w. */
const soft = (x: number, w: number): number => (x <= -w ? 0 : x >= w ? x : ((x + w) * (x + w)) / (4 * w));

/** Height (m) the plateau lifts the ground at (x, z): 0 off its footprint, `height` on its flat top. */
export function plateauHeight(p: Plateau, x: number, z: number): number {
  const dx = x - p.x;
  const dz = z - p.z;
  const rx = p.run[dx < 0 ? 0 : 1];
  const rz = p.run[dz < 0 ? 2 : 3];
  const ux = soft(Math.abs(dx) - p.halfX, p.round) / rx;
  const uz = soft(Math.abs(dz) - p.halfZ, p.round) / rz;
  // The foot is rounded `round` m along the side it falls off.
  return p.height * soft(1 - Math.hypot(ux, uz), p.round / (ux >= uz ? rx : rz));
}

function inside(poly: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let in_ = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) in_ = !in_;
  }
  return in_;
}

/**
 * Paint each polygon's surface over the grid cells (`surf`, nx wide from (minX, minZ), `cell` apart) that are still bare
 * terrain: a road or its runoff keeps its own.
 */
export function paintGrid(paint: readonly Paint[], surf: Uint8Array, terrain: number, minX: number, minZ: number, nx: number, cell: number): void {
  for (const p of paint) {
    const id = SURFACE_IDS.indexOf(p.surface);
    for (let c = 0; c < surf.length; c++) {
      if (surf[c] === terrain && inside(p.poly, minX + (c % nx) * cell, minZ + Math.floor(c / nx) * cell)) surf[c] = id;
    }
  }
}

/** Lift the grid `heights` by `plateaus`, and lay each top's surface on its flat. */
export function raisePlateaus(plateaus: readonly Plateau[], heights: Float32Array, surf: Uint8Array, minX: number, minZ: number, nx: number, cell: number): void {
  const nz = heights.length / nx;
  for (const p of plateaus) {
    const top = SURFACE_IDS.indexOf(p.top);
    const i0 = Math.floor((p.x - p.halfX - p.run[0] - p.round - minX) / cell);
    const i1 = Math.ceil((p.x + p.halfX + p.run[1] + p.round - minX) / cell);
    const j0 = Math.floor((p.z - p.halfZ - p.run[2] - p.round - minZ) / cell);
    const j1 = Math.ceil((p.z + p.halfZ + p.run[3] + p.round - minZ) / cell);
    if (i0 < 0 || j0 < 0 || i1 >= nx || j1 >= nz) throw new Error(`plateau at (${p.x}, ${p.z}) reaches past the baked ground`);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const h = plateauHeight(p, minX + i * cell, minZ + j * cell);
        if (h <= 0) continue;
        const c = j * nx + i;
        heights[c] = heights[c]! + h;
        if (h >= p.height - 0.005) surf[c] = top;
      }
    }
  }
}

/** Throws when a road or its runoff reaches the footprint of a plateau (a centimetre or more of it under the road). */
export function checkPlateaus(id: string, plateaus: readonly Plateau[], paths: readonly Corridor[]): void {
  for (const p of plateaus) {
    for (const path of paths) {
      for (let k = 0; k < path.count; k++) {
        // The road + runoff's two edges and its centreline.
        for (const lat of [-(path.half[k]! + path.runR[k]!), 0, path.half[k]! + path.runL[k]!]) {
          const x = path.x[k]! + path.tz[k]! * lat;
          const z = path.z[k]! - path.tx[k]! * lat;
          if (plateauHeight(p, x, z) > 0.01) throw new Error(`${id}: a road reaches the plateau at (${p.x}, ${p.z}) near (${x.toFixed(1)}, ${z.toFixed(1)})`);
        }
      }
    }
  }
}
