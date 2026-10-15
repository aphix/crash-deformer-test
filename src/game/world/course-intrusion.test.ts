import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRACK_ID } from "./constants.ts";
import { PREFABS } from "./catalog.ts";
import { placeProps, type Placed } from "./placements.ts";
import { Track, blankProjection, projectPath, type TrackPath } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
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

/** The farthest (m) a path's road + runoff reaches from its centreline: a point further off cannot lie inside it. */
function reachOf(path: TrackPath): number {
  let reach = 0;
  for (let k = 0; k < path.count; k++) reach = Math.max(reach, path.half[k]! + Math.max(path.runL[k]!, path.runR[k]!));
  return reach;
}

/** Side (m) of the footprint squares culled together. */
const BLOCK = 4;

/** A group of footprint points (car-aligned offsets from the piece's centre) and the circle that holds them. */
type Block = { u: number; v: number; radius: number; pts: [number, number][] };

function blocksOf(pts: readonly [number, number][]): Block[] {
  const byCell = new Map<number, [number, number][]>();
  for (const pt of pts) {
    const cell = Math.floor(pt[0] / BLOCK) * 65536 + Math.floor(pt[1] / BLOCK);
    const held = byCell.get(cell);
    if (held) held.push(pt);
    else byCell.set(cell, [pt]);
  }
  return [...byCell.values()].map((held) => {
    const u = held.reduce((sum, pt) => sum + pt[0], 0) / held.length;
    const v = held.reduce((sum, pt) => sum + pt[1], 0) / held.length;
    return { u, v, radius: Math.max(...held.map((pt) => Math.hypot(pt[0] - u, pt[1] - v))), pts: held };
  });
}

/** Whether every point within `radius` of (x, z) is out of `path`'s corridor, whose reach from its centreline is `reach`. */
function clearOf(path: TrackPath, reach: number, x: number, z: number, radius: number): boolean {
  projectPath(path, x, z, -1, proj);
  return Math.sqrt(proj.dist2) > reach + radius;
}

/** The deepest point of `p`'s drawn footprint (oriented box, `size` × scale) on each corridor, `reaches` being `reachOf` of each. */
function intrusions(track: Track, reaches: readonly number[], p: Placed, index: number): Hit[] {
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
  const blocks = blocksOf(pts);
  const out: Hit[] = [];
  for (const [pi, path] of track.paths().entries()) {
    // A corridor that stays further from a block's circle than its reach holds none of the block's points: only the blocks near it are scanned point by point.
    if (clearOf(path, reaches[pi]!, p.x, p.z, Math.hypot(hw, hd))) continue;
    let best: Hit | null = null;
    for (const block of blocks) {
      if (clearOf(path, reaches[pi]!, p.x + block.u * c + block.v * sn, p.z - block.u * sn + block.v * c, block.radius)) continue;
      for (const [u, v] of block.pts) {
        const x = p.x + u * c + v * sn;
        const z = p.z - u * sn + v * c;
        const { d, k } = depthIn(path, x, z, p.y, p.y + h);
        if (d > TOL && (!best || d > best.depth)) best = { piece: `${p.prefab}#${index}`, path: pi, k, s: proj.s, depth: d };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** Every intrusion of a placed piece; knock props (cones, crates, hay bales) are road obstacles by design. */
function courseIntrusions(track: Track): string[] {
  const reaches = track.paths().map(reachOf);
  const bad: string[] = [];
  for (const [i, p] of placeProps(track).entries()) {
    if (PREFABS[p.prefab].body === "knock") continue;
    for (const hit of intrusions(track, reaches, p, i)) {
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

/** The first node of `path` with the same tangent, width and runoff 15 nodes (about 15 m) either side, and as wide a runoff on its right as on its left: a straight stretch to stand a building beside. */
function straightNode(path: TrackPath): number {
  const near = 15;
  const same = (a: Float64Array, k: number) => Math.abs(a[k - near]! - a[k + near]!) < 1e-9;
  for (let k = near; k < path.count - near; k++) {
    if (same(path.tx, k) && same(path.tz, k) && same(path.half, k) && same(path.runL, k) && same(path.runR, k) && path.runL[k] === path.runR[k]) return k;
  }
  throw new Error("no straight stretch");
}

const buildingCases = [
  { it: "when its near face is 0.5 m inside the runoff's outer edge on the left, then it is reported 0.5 m onto the loop", side: 1, turn: 0, inward: 0.5, expectedHits: 1 },
  { it: "when its near face is 0.5 m inside the runoff's outer edge on the right, then it is reported 0.5 m onto the loop", side: -1, turn: 0, inward: 0.5, expectedHits: 1 },
  { it: "when it is turned 45° and its corner is 0.5 m inside the runoff's outer edge, then it is reported 0.5 m onto the loop", side: 1, turn: Math.PI / 4, inward: 0.5, expectedHits: 1 },
  { it: `when its near face is half of ${TOL} m inside the runoff's outer edge, then it is not reported`, side: 1, turn: 0, inward: TOL / 2, expectedHits: 0 },
  { it: "when it stands 30 m clear of the runoff, then it is not reported", side: 1, turn: 0, inward: -30, expectedHits: 0 },
  { it: "when it stands on the road's centreline, then it is reported as deep as the road and runoff reach", side: 1, turn: 0, inward: Infinity, expectedHits: 1 },
] as const;

describe("given a building beside a straight of the oval course, set by how far its nearest point is inside the runoff's outer edge", () => {
  const track = new Track(TRACKS.find((json) => parseTrack(json).id === TRACK_ID.oval));
  const loop = track.paths()[0]!;
  const reaches = track.paths().map(reachOf);
  const node = straightNode(loop);
  const edge = loop.half[node]! + loop.runL[node]!;
  const half = PREFABS.building.size[0] / 2;
  for (const testCase of buildingCases) {
    it(testCase.it, () => {
      // The building's centre is this far (m) from its point nearest the road: a face's, or a turned corner's.
      const outward = testCase.turn === 0 ? half : half * Math.SQRT2;
      // A point further inside than the corridor is wide puts the building's centre on the centreline.
      const inward = Math.min(testCase.inward, edge + outward);
      const lateral = testCase.side * (edge + outward - inward);
      const placed = { prefab: "building", x: loop.x[node]! + loop.tz[node]! * lateral, y: loop.y[node]!, z: loop.z[node]! - loop.tx[node]! * lateral, yaw: Math.atan2(loop.tx[node]!, loop.tz[node]!) + testCase.turn, sx: 1, sy: 1, sz: 1 } as const;
      const hits = intrusions(track, reaches, placed, 0);
      assert.equal(hits.length, testCase.expectedHits, "pieces reported");
      if (testCase.expectedHits === 0) return;
      assert.equal(hits[0]!.path, 0, "the corridor reached");
      assert.ok(Math.abs(hits[0]!.depth - Math.min(inward, edge)) < 1e-6, `depth ${hits[0]!.depth}`);
    });
  }
});
