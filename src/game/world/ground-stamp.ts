/** The ground bake's stamping shortcuts (`TrackGround.stampPath`): which cells a segment can reach, and which samples one segment can stand for. */
import type { TrackPath } from "./track.ts";

/**
 * The run of x (into `out`: lo, hi) over which the row at `z` lies within `r` of the segment (ax, az)-(bx, bz): the end discs' and
 * the two side lines' crossings of the row. False when the row misses the segment's reach.
 */
export function capsuleRow(ax: number, az: number, bx: number, bz: number, r: number, z: number, out: Float64Array): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [cx, cz] of [[ax, az], [bx, bz]] as const) {
    const dz = z - cz;
    if (dz * dz > r * r) continue;
    const w = Math.sqrt(r * r - dz * dz);
    lo = Math.min(lo, cx - w);
    hi = Math.max(hi, cx + w);
  }
  const ex = bx - ax;
  const ez = bz - az;
  const len = Math.sqrt(ex * ex + ez * ez);
  if (len > 1e-9 && ez !== 0) {
    for (const s of [-1, 1]) {
      const ox = ax - (s * r * ez) / len;
      const oz = az + (s * r * ex) / len;
      const t = (z - oz) / ez;
      if (t < 0 || t > 1) continue;
      const x = ox + t * ex;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  if (lo > hi) return false;
  out[0] = lo;
  out[1] = hi;
  return true;
}

/**
 * Sample `m` of an open path carries on its straight run from sample `k` unchanged: on the line through `k` and `k + 1`, with the
 * same width, runoff, height, bank and surfaces, and no deck between.
 */
export function sameRun(p: TrackPath, k: number, m: number): boolean {
  const ex = p.x[k + 1]! - p.x[k]!;
  const ez = p.z[k + 1]! - p.z[k]!;
  const len = Math.sqrt(ex * ex + ez * ez);
  const off = ((p.x[m]! - p.x[k]!) * ez - (p.z[m]! - p.z[k]!) * ex) / len;
  return (
    Math.abs(off) < 1e-6 &&
    p.half[m] === p.half[k] &&
    p.runL[m] === p.runL[k] &&
    p.runR[m] === p.runR[k] &&
    p.y[m] === p.y[k] &&
    p.bank[m] === p.bank[k] &&
    p.surface[m] === p.surface[k] &&
    p.runSurface[m] === p.runSurface[k] &&
    p.deck[m - 1] === 0 &&
    p.deck[m] === 0
  );
}
