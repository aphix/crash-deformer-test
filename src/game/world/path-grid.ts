/**
 * Nearest segment of a sampled path to a point, through a grid of the path's segments. `projectPath` (track.ts) takes it when
 * a point is off the corridor its hint names: a traffic car, a respawn, a unit dropped in. The plain scan reads every segment
 * (`path.count`: 700 on the oval, 4 000-14 000 on the long courses) per car per physics step; this reads the few near the point.
 * Same winner as that scan: the lowest distance, equal distances to the lowest segment index, the same arithmetic per segment.
 */

/** The part of a `TrackPath` this reads. */
type GridPath = {
  readonly count: number;
  readonly closed: boolean;
  readonly length: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
};

/** The part of a `Projection` this writes. */
type GridHit = { k: number; s: number; lateral: number; dist2: number; cx: number; cz: number };

/** Cell (m) of the grid: about 16 segments of a straight road a cell. */
const GRID_CELL = 16;

/** A path's segments by cell (CSR: `items[start[c]..start[c + 1]]` are the segments whose bounding box touches cell c). */
type SegGrid = { x0: number; z0: number; nx: number; nz: number; start: Int32Array; items: Int32Array; seen: Int32Array; stamp: number };
const segGrids = new WeakMap<GridPath, SegGrid>();

function segGrid(path: GridPath): SegGrid {
  let g = segGrids.get(path);
  if (g) return g;
  const n = path.count;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < n; k++) {
    minX = Math.min(minX, path.x[k]!);
    maxX = Math.max(maxX, path.x[k]!);
    minZ = Math.min(minZ, path.z[k]!);
    maxZ = Math.max(maxZ, path.z[k]!);
  }
  const nx = Math.floor((maxX - minX) / GRID_CELL) + 1;
  const nz = Math.floor((maxZ - minZ) / GRID_CELL) + 1;
  const start = new Int32Array(nx * nz + 1);
  // Pass 0 counts the segments per cell, pass 1 fills them in segment order.
  let items = new Int32Array(0);
  let fill = start;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      const b = path.closed ? (k + 1) % n : k + 1;
      if (b >= n) continue;
      const i0 = Math.floor((Math.min(path.x[k]!, path.x[b]!) - minX) / GRID_CELL);
      const i1 = Math.floor((Math.max(path.x[k]!, path.x[b]!) - minX) / GRID_CELL);
      const j0 = Math.floor((Math.min(path.z[k]!, path.z[b]!) - minZ) / GRID_CELL);
      const j1 = Math.floor((Math.max(path.z[k]!, path.z[b]!) - minZ) / GRID_CELL);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (pass === 0) start[j * nx + i + 1]!++;
          else items[fill[j * nx + i]!++] = k;
        }
      }
    }
    if (pass === 0) {
      for (let c = 0; c < nx * nz; c++) start[c + 1]! += start[c]!;
      items = new Int32Array(start[nx * nz]!);
      fill = start.slice(0, nx * nz);
    }
  }
  g = { x0: minX, z0: minZ, nx, nz, start, items, seen: new Int32Array(n), stamp: 0 };
  segGrids.set(path, g);
  return g;
}

/**
 * Nearest point on segment k→k+1 into `out` if closer than out.dist2, or as close with a lower k (the whole-path scan has
 * always kept the lowest k of equal distances, and the grid visits segments in cell order).
 */
function trySegment(path: GridPath, k: number, x: number, z: number, out: GridHit): void {
  const n = path.count;
  const b = path.closed ? (k + 1) % n : k + 1;
  if (b >= n) return;
  const ax = path.x[k]!;
  const az = path.z[k]!;
  const ex = path.x[b]! - ax;
  const ez = path.z[b]! - az;
  const len2 = ex * ex + ez * ez || 1e-12;
  const num = (x - ax) * ex + (z - az) * ez;
  // Clamped to an end without the division: that is nearly every segment.
  const f = num <= 0 ? 0 : num >= len2 ? 1 : num / len2;
  const cx = ax + ex * f;
  const cz = az + ez * f;
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > out.dist2 || (d2 === out.dist2 && k > out.k)) return;
  const segs = path.closed ? n : n - 1;
  out.dist2 = d2;
  out.k = k;
  out.s = ((k + f) / segs) * path.length;
  out.cx = cx;
  out.cz = cz;
  out.lateral = (dx * ez - dz * ex) / Math.sqrt(len2);
}

function scanCell(path: GridPath, g: SegGrid, c: number, x: number, z: number, out: GridHit): void {
  for (let t = g.start[c]!; t < g.start[c + 1]!; t++) {
    const k = g.items[t]!;
    if (g.seen[k] === g.stamp) continue;
    g.seen[k] = g.stamp;
    trySegment(path, k, x, z, out);
  }
}

/**
 * The nearest segment of the whole path into `out` (whose `dist2` the caller set to Infinity), found from the cell under
 * (x, z) outward: it stops once the cells searched reach farther in every direction than the best distance. A point far
 * outside the path's box takes the plain scan.
 */
export function nearestOnPath(path: GridPath, x: number, z: number, out: GridHit): void {
  const g = segGrid(path);
  const u = (x - g.x0) / GRID_CELL;
  const v = (z - g.z0) / GRID_CELL;
  if (u < -2 || v < -2 || u > g.nx + 2 || v > g.nz + 2) {
    for (let k = 0; k < path.count; k++) trySegment(path, k, x, z, out);
    return;
  }
  const ci = Math.min(g.nx - 1, Math.max(0, Math.floor(u)));
  const cj = Math.min(g.nz - 1, Math.max(0, Math.floor(v)));
  g.stamp++;
  for (let r = 0; ; r++) {
    const i0 = ci - r;
    const i1 = ci + r;
    const j0 = cj - r;
    const j1 = cj + r;
    for (let j = Math.max(0, j0); j <= Math.min(g.nz - 1, j1); j++) {
      if (j === j0 || j === j1) {
        for (let i = Math.max(0, i0); i <= Math.min(g.nx - 1, i1); i++) scanCell(path, g, j * g.nx + i, x, z, out);
      } else {
        if (i0 >= 0) scanCell(path, g, j * g.nx + i0, x, z, out);
        if (i1 < g.nx) scanCell(path, g, j * g.nx + i1, x, z, out);
      }
    }
    if (out.dist2 < Infinity) {
      // Nothing unsearched is nearer than the block's nearest edge (a 1e-9 margin swallows rounding).
      const lim = Math.min(x - (g.x0 + i0 * GRID_CELL), g.x0 + (i1 + 1) * GRID_CELL - x, z - (g.z0 + j0 * GRID_CELL), g.z0 + (j1 + 1) * GRID_CELL - z);
      if (lim > 0 && lim * lim > out.dist2 * (1 + 1e-9) + 1e-9) return;
    }
    if (i0 <= 0 && j0 <= 0 && i1 >= g.nx - 1 && j1 >= g.nz - 1) return;
  }
}
