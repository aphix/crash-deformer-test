import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankProjection, projectPath, Track, WINDOW, type Projection, type TrackPath } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";
import { parseTrack } from "./track-schema.ts";
import { mulberry32 } from "./placements.ts";

/**
 * `projectPath` finds the nearest centreline point: ±WINDOW samples round a hint, else the whole path (through a segment grid
 * searched from the point outward). It must answer exactly what the plain scans answer: the oracle below IS the scans, kept
 * as they were (window in offset order, first of equal distances wins; whole path in index order, lowest index wins).
 */

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
  out.lateral = (dx * ez - dz * ex) / Math.sqrt(len2);
}

function scan(path: TrackPath, x: number, z: number, hint: number, out: Projection): Projection {
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

const same = (a: Projection, b: Projection) =>
  Object.is(a.dist2, b.dist2) && a.k === b.k && Object.is(a.s, b.s) && Object.is(a.cx, b.cx) && Object.is(a.cz, b.cz) && Object.is(a.lateral, b.lateral);

describe("projectPath", () => {
  for (const json of TRACKS) {
    const id = parseTrack(json).id;
    it(`${id}: every path answers as the plain scans do, near the road, off it, far away, with and without a hint`, () => {
      const track = new Track(json);
      const rand = mulberry32(21);
      const b = track.bounds;
      const want = blankProjection();
      const got = blankProjection();
      let queries = 0;
      for (const p of track.paths()) {
        for (let i = 0; i < 1500; i++) {
          let x: number;
          let z: number;
          const mode = rand();
          if (mode < 0.45) {
            // Beside the road, on the corridor and well off it (the traffic cars' distance).
            const k = Math.floor(rand() * p.count);
            const lat = (rand() * 2 - 1) * (rand() < 0.5 ? 30 : 120);
            x = p.x[k]! + p.tz[k]! * lat;
            z = p.z[k]! - p.tx[k]! * lat;
          } else if (mode < 0.6) {
            // On whole-metre laterals of a vertex: equal distances to two segments (the tie rule).
            const k = Math.floor(rand() * p.count);
            const lat = Math.round((rand() * 2 - 1) * 40);
            x = p.x[k]! + p.tz[k]! * lat;
            z = p.z[k]! - p.tx[k]! * lat;
          } else {
            // Anywhere in and around the course's box, as far as 80 m out.
            x = b.minX - 80 + rand() * (b.maxX - b.minX + 160);
            z = b.minZ - 80 + rand() * (b.maxZ - b.minZ + 160);
          }
          const r = rand();
          const hint = r < 0.4 ? -1 : r < 0.8 ? Math.floor(rand() * p.count) : p.count + 3;
          scan(p, x, z, hint, want);
          projectPath(p, x, z, hint, got);
          queries++;
          assert.ok(same(want, got), `(${x.toFixed(3)}, ${z.toFixed(3)}) hint ${hint}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
        }
      }
      assert.ok(queries >= 3000);
    });
  }

  it("a point far outside the path's box takes the plain scan", () => {
    const track = new Track(TRACKS[0]);
    const want = blankProjection();
    const got = blankProjection();
    for (const [x, z] of [[5000, 5000], [-4000, 10], [10, -9000]] as const) {
      scan(track.path, x, z, -1, want);
      projectPath(track.path, x, z, -1, got);
      assert.ok(same(want, got), `(${x}, ${z})`);
    }
  });
});
