import { blankProjection, projectPath, WINDOW, type Projection, type TrackPath } from "../world/track.ts";

/** A square grid over the path's bounds: per cell (row-major from `x0`, `z0`), `GRID_HINTS` path samples to project from (-1: unused). */
export type RoadGrid = { x0: number; z0: number; cols: number; rows: number; hint: Int16Array };

/** Cell side (m) of a `RoadGrid`, how far (m) from the road a cell still has hints, and how many stretches of road a cell may name. */
const GRID_CELL = 8;
const GRID_REACH = 40;
const GRID_HINTS = 3;

/**
 * `Sight.grid`: per cell, up to `GRID_HINTS` path samples to project from: the nearest to the cell centre on each stretch of
 * road (samples more than `WINDOW` along from each other are different stretches) that lies within `GRID_CELL` * √2 of
 * the nearest one, the margin by which a point of the cell can reorder two distances. The nearest road to any point of the
 * cell is then in one of those samples' windows (`projectPath`), whichever crossing or hairpin it is at; a cell with no road within
 * `GRID_REACH`, or more stretches than that, has none (the whole path is searched). `solid` used to start from the last
 * query's segment, which on a crossing course could be the other road's. O(cells × samples) once a course.
 */
export function roadGrid(p: TrackPath): RoadGrid {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let k = 0; k < p.count; k++) {
    x0 = Math.min(x0, p.x[k]!);
    x1 = Math.max(x1, p.x[k]!);
    z0 = Math.min(z0, p.z[k]!);
    z1 = Math.max(z1, p.z[k]!);
  }
  x0 -= GRID_REACH;
  z0 -= GRID_REACH;
  const cols = Math.ceil((x1 + GRID_REACH - x0) / GRID_CELL);
  const rows = Math.ceil((z1 + GRID_REACH - z0) / GRID_CELL);
  const hint = new Int16Array(cols * rows * GRID_HINTS).fill(-1);
  const n = p.count;
  const dist2 = new Float64Array(n);
  const best: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x0 + (c + 0.5) * GRID_CELL;
      const cz = z0 + (r + 0.5) * GRID_CELL;
      let bd = GRID_REACH * GRID_REACH;
      for (let k = 0; k < n; k++) {
        const d = (p.x[k]! - cx) ** 2 + (p.z[k]! - cz) ** 2;
        dist2[k] = d;
        if (d < bd) bd = d;
      }
      if (bd >= GRID_REACH * GRID_REACH) continue;
      const reorder = (Math.sqrt(bd) + GRID_CELL * Math.SQRT2) ** 2;
      // Stretches: runs of samples within `reorder` of the centre, a new one past a gap of more than `WINDOW`.
      best.length = 0;
      let first = -1;
      let last = -Infinity;
      for (let k = 0; k < n; k++) {
        if (dist2[k]! >= reorder) continue;
        if (first < 0) first = k;
        if (k - last > WINDOW) best.push(k);
        else if (dist2[k]! < dist2[best[best.length - 1]!]!) best[best.length - 1] = k;
        last = k;
      }
      // A closed path's last stretch continues into its first.
      if (p.closed && best.length > 1 && first + n - last <= WINDOW) {
        if (dist2[best[best.length - 1]!]! < dist2[best[0]!]!) best[0] = best[best.length - 1]!;
        best.pop();
      }
      if (best.length > GRID_HINTS) continue;
      for (let h = 0; h < best.length; h++) hint[(r * cols + c) * GRID_HINTS + h] = best[h]!;
    }
  }
  return { x0, z0, cols, rows, hint };
}

/** The nearest road to (x, z) into `out`: from each of the cell's hints' windows, or the whole path where it has none (no `g`: always). */
export function projectGrid(g: RoadGrid | undefined, p: TrackPath, x: number, z: number, out: Projection): void {
  const c = g ? Math.floor((x - g.x0) / GRID_CELL) : -1;
  const r = g ? Math.floor((z - g.z0) / GRID_CELL) : -1;
  const at = g && c >= 0 && c < g.cols && r >= 0 && r < g.rows ? (r * g.cols + c) * GRID_HINTS : -1;
  if (!g || at < 0 || g.hint[at]! < 0) {
    projectPath(p, x, z, -1, out);
    return;
  }
  projectPath(p, x, z, g.hint[at]!, out);
  for (let h = 1; h < GRID_HINTS && g.hint[at + h]! >= 0; h++) {
    projectPath(p, x, z, g.hint[at + h]!, _alt);
    if (_alt.dist2 >= out.dist2) continue;
    out.k = _alt.k;
    out.s = _alt.s;
    out.lateral = _alt.lateral;
    out.dist2 = _alt.dist2;
    out.cx = _alt.cx;
    out.cz = _alt.cz;
  }
}

const _alt = blankProjection();
