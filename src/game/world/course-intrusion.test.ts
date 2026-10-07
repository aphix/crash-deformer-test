import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PREFABS } from "./catalog.ts";
import { placeProps, type Placed } from "./placements.ts";
import { Track, blankProjection, projectPath, type TrackPath } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";

/** Deepest a placed piece may reach (m) onto any road or runoff. */
const TOL = 0.1;

const proj = blankProjection();

/** How far (m) (x, z) lies inside `path`'s road + runoff at the level band [y0, y1]; ≤ 0 outside. */
function depthIn(path: TrackPath, x: number, z: number, y0: number, y1: number): { d: number; k: number } {
  projectPath(path, x, z, -1, proj);
  const k = proj.k;
  const d = path.half[k]! + (proj.lateral > 0 ? path.runL[k]! : path.runR[k]!) - Math.sqrt(proj.dist2);
  // A piece wholly under a bridge deck or above a road is not on it.
  const y = path.y[k]!;
  return { d: y1 < y - 0.5 || y0 > y + 2 ? 0 : d, k };
}

type Hit = { piece: string; path: number; k: number; s: number; depth: number };

/** The deepest point of `p`'s drawn footprint (oriented box, `size` × scale) on each corridor. */
function intrusions(track: Track, p: Placed, index: number): Hit[] {
  const size = PREFABS[p.prefab].size;
  const hw = (size[0] * p.sx) / 2;
  const hd = (size[2] * p.sz) / 2;
  const h = size[1] * p.sy;
  const c = Math.cos(p.yaw);
  const sn = Math.sin(p.yaw);
  const pts: [number, number][] = [];
  // Perimeter every 0.1 m, interior every 1 m.
  const nx = Math.max(1, Math.ceil((2 * hw) / 0.1));
  const nz = Math.max(1, Math.ceil((2 * hd) / 0.1));
  for (let i = 0; i <= nx; i++) for (const v of [-hd, hd]) pts.push([-hw + (2 * hw * i) / nx, v]);
  for (let j = 0; j <= nz; j++) for (const u of [-hw, hw]) pts.push([u, -hd + (2 * hd * j) / nz]);
  for (let u = -hw + 1; u < hw; u += 1) for (let v = -hd + 1; v < hd; v += 1) pts.push([u, v]);
  const out: Hit[] = [];
  for (const [pi, path] of track.paths().entries()) {
    let best: Hit | null = null;
    for (const [u, v] of pts) {
      const x = p.x + u * c + v * sn;
      const z = p.z - u * sn + v * c;
      const { d, k } = depthIn(path, x, z, p.y, p.y + h);
      if (d > TOL && (!best || d > best.depth)) best = { piece: `${p.prefab}#${index}`, path: pi, k, s: proj.s, depth: d };
    }
    if (best) out.push(best);
  }
  return out;
}

/** Every intrusion of a placed piece; knock props (cones, crates, hay bales) are road obstacles by design. */
function courseIntrusions(track: Track): string[] {
  const bad: string[] = [];
  for (const [i, p] of placeProps(track).entries()) {
    if (PREFABS[p.prefab].body === "knock") continue;
    for (const hit of intrusions(track, p, i)) {
      const name = hit.path === 0 ? "loop" : `path ${hit.path}`;
      bad.push(`${track.id}: ${hit.piece} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) intrudes ${hit.depth.toFixed(2)} m into the ${name} at segment ${hit.k} (s=${hit.s.toFixed(0)})`);
    }
  }
  return bad;
}

/** Lateral spacing (m) of the step scan across a road + runoff. */
const STEP_DX = 0.5;
/**
 * Most a step between neighbouring scan points may exceed the road's own bank over `STEP_DX` (m). The baked 1 m field
 * stays within 0.045 of it on every course (worst: rally's ford leaving the main road); the lips that launched race
 * cars off rally's runoff at 25 m/s were 0.13-0.35 m.
 */
const STEP_TOL = 0.05;

/** Every scan step across a path's road + runoff that rises or falls more than its bank plus `STEP_TOL`. */
function roadSteps(track: Track): string[] {
  const g = track.ground();
  const bad: string[] = [];
  for (const [pi, p] of track.paths().entries()) {
    const segs = p.closed ? p.count : p.count - 1;
    for (let k = 0; k < segs; k++) {
      if (p.deck[k]) continue;
      const lo = -(p.half[k]! + p.runR[k]!);
      const hi = p.half[k]! + p.runL[k]!;
      const bound = Math.abs(Math.tan(p.bank[k]!)) * STEP_DX + STEP_TOL;
      let prev = NaN;
      for (let o = lo; o <= hi + 1e-9; o += STEP_DX) {
        const h = g.heightAt(p.x[k]! + p.tz[k]! * o, p.z[k]! - p.tx[k]! * o, p.y[k]!);
        if (Math.abs(h - prev) > bound) bad.push(`${track.id}: path ${pi} segment ${k} steps ${(h - prev).toFixed(2)} m at ${o.toFixed(1)} m off its centreline`);
        prev = h;
      }
    }
  }
  return bad;
}

for (const json of TRACKS) {
  const track = new Track(json);
  describe(`given the ${track.id} course`, () => {
    it(`when every placed building and prop is measured against the road and runoff, then none reaches more than ${TOL} m onto them`, () => {
      assert.deepEqual(courseIntrusions(track), []);
    });
    it(`when the ground is scanned across every road and its runoff, then no step rises or falls more than the road's own bank plus ${STEP_TOL} m per ${STEP_DX} m`, () => {
      assert.deepEqual(roadSteps(track), []);
    });
  });
}
