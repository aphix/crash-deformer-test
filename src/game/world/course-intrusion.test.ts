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
  track.paths().forEach((path, pi) => {
    let best: Hit | null = null;
    for (const [u, v] of pts) {
      const x = p.x + u * c + v * sn;
      const z = p.z - u * sn + v * c;
      const { d, k } = depthIn(path, x, z, p.y, p.y + h);
      if (d > TOL && (!best || d > best.depth)) best = { piece: `${p.prefab}#${index}`, path: pi, k, s: proj.s, depth: d };
    }
    if (best) out.push(best);
  });
  return out;
}

/** Every intrusion of a placed piece; knock props (cones, crates, hay bales) are road obstacles by design. */
function courseIntrusions(track: Track): string[] {
  const bad: string[] = [];
  placeProps(track).forEach((p, i) => {
    if (PREFABS[p.prefab].body === "knock") return;
    for (const hit of intrusions(track, p, i)) {
      const name = hit.path === 0 ? "loop" : `path ${hit.path}`;
      bad.push(`${track.id}: ${hit.piece} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) intrudes ${hit.depth.toFixed(2)} m into the ${name} at segment ${hit.k} (s=${hit.s.toFixed(0)})`);
    }
  });
  return bad;
}

describe("course geometry", () => {
  for (const json of TRACKS) {
    const track = new Track(json);
    it(`${track.id}: no placed building or prop reaches more than ${TOL} m onto the road or runoff`, () => {
      assert.deepEqual(courseIntrusions(track), []);
    });
  }
});
