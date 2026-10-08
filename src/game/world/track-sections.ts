import { hypot2 } from "../kernel/physics-core.js";
import { clamp } from "../kernel/scalar.ts";
import type { PropCollider } from "./placements.ts";
import type { Track, TrackGround, TrackPath } from "./track.ts";

/** How a path is cut into sections for its art and its walls, and the one definition of a course wall: drawn, met by the cars and by the dummies. */

/** Section spacing cap (m); bends get closer sections (chord sagitta ≤ 2 cm). */
const MAX_STEP = 4;
/** Wall stripe length (m). */
export const WALL_PERIOD = 4;

/**
 * Wall cross-section (u outward from the wall line, v up), v > 0 as fractions of the wall height: the box `wallColliders`
 * makes, faces vertical and top flat, so what is drawn is what is met (a leaning face stood 0.14 m back at body height and 0.21
 * m at the top, an invisible 0.2 m of wall in front of it).
 */
export const WALL_PROFILE: readonly (readonly [number, number])[] = [
  [0, -0.3],
  [0, 1],
  [0.6, 1],
  [0.6, -0.3],
];
/** The wall's thickness at its foot (m): the profile's outermost point. */
const WALL_THICK = Math.max(...WALL_PROFILE.map(([u]) => u));
/** Where the wall's foot ends under the surface (m): the profile's lowest point. */
const WALL_FOOT = Math.min(...WALL_PROFILE.map(([, v]) => v));
/** The most (m) a level wall box's top may stand over the drawn top at its low end, on ground that climbs along the wall. */
const WALL_STEP = 0.1;

/** Path height at lateral `lat` of sample k (banked plane, flat beyond the road edge): the ground layer hint. */
export function levelAt(p: TrackPath, k: number, lat: number): number {
  const h = p.half[k]!;
  return p.y[k]! - clamp(lat, -h, h) * Math.tan(p.bank[k]!);
}

/** Surface height at lateral `lat` of sample k: the analytic deck on a bridge span, else the ground at the path's level. */
export function surfY(ground: TrackGround, p: TrackPath, k: number, lat: number): number {
  const y = levelAt(p, k, lat);
  return p.deck[k] ? y : ground.heightAt(p.x[k]! + p.tz[k]! * lat, p.z[k]! - p.tx[k]! * lat, y);
}

export function sampleStep(p: TrackPath): number {
  return p.length / (p.closed ? p.count : p.count - 1);
}

/**
 * Sample indices to build sections at: every flag change (deck, tunnel, walls, surfaces), at most
 * MAX_STEP m apart, closer where the path bends or crests (chord sagitta ≤ 2 cm) or its bank turns,
 * and on every multiple of `period` m when given. An open path ends on its last sample.
 *
 * A section quad across a bank that turns is twisted, and its two triangles meet along a diagonal
 * through the road's centre half × Δtan(bank) / 2 off the road's surface: 6.9 cm over stunt's bank
 * run-out at 4 m sections, wheels sunk in the drawn road. That too is held to 2 cm.
 */
export function sections(p: TrackPath, period: number): number[] {
  const n = p.count;
  const ds = sampleStep(p);
  const out = [0];
  let run = 0;
  let bend = 0;
  let twist = 0;
  for (let k = 1; k < n; k++) {
    run += ds;
    const a = k - 1;
    const b = p.closed ? (k + 1) % n : Math.min(n - 1, k + 1);
    const crest = Math.abs(p.y[b]! - 2 * p.y[k]! + p.y[a]!) / (ds * ds);
    bend = Math.max(bend, Math.abs(p.curv[a]!), Math.abs(p.curv[k]!), crest);
    twist = Math.max(twist, (p.half[k]! * Math.abs(Math.tan(p.bank[b]!) - Math.tan(p.bank[a]!))) / (2 * ds));
    const step = Math.min(MAX_STEP, Math.max(ds, Math.sqrt(0.16 / Math.max(bend, 1e-6))));
    // Twist: end the quad here if one more sample would take it past 2 cm (twist × length / 2).
    const twisted = (run + ds) * twist > 0.04;
    const flag =
      p.deck[k] !== p.deck[a] ||
      p.tunnel[k] !== p.tunnel[a] ||
      p.wallL[k] !== p.wallL[a] ||
      p.wallR[k] !== p.wallR[a] ||
      p.surface[k] !== p.surface[a] ||
      p.runSurface[k] !== p.runSurface[a];
    const tick = period > 0 && Math.floor((k * ds) / period) !== Math.floor((a * ds) / period);
    if (flag || tick || twisted || run >= step - 1e-6 || (!p.closed && k === n - 1)) {
      out.push(k);
      run = 0;
      bend = 0;
      twist = 0;
    }
  }
  return out;
}

/** Runs [a, b] of section indices where `on(sample)` holds for the segment leaving each section. */
export function runs(p: TrackPath, secs: readonly number[], on: (k: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  const n = secs.length;
  const last = p.closed ? n : n - 1;
  let start = -1;
  for (let i = 0; i < last; i++) {
    const inRun = on(secs[i]!);
    if (inRun && start < 0) start = i;
    if (!inRun && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) {
    // A run reaching the loop's end continues into one starting at section 0.
    if (p.closed && out.length > 0 && out[0]![0] === 0) out[0] = [start, out[0]![1] + n];
    else out.push([start, last]);
  }
  return out;
}

/**
 * One unbroken wall on a side of a path: `side` 1 on the left of travel, −1 on the right; its section samples in order,
 * each consecutive pair one piece of it; both ends of the run are the wall's drawn (capped) ends, every other section a joint.
 */
type WallRun = { side: number; ks: number[] };

/** Every wall of `p`, as its art draws it: the flagged runs of its sections (`WALL_PERIOD`), left side first. */
export function wallRuns(p: TrackPath): WallRun[] {
  const secs = sections(p, WALL_PERIOD);
  const n = secs.length;
  return [1, -1].flatMap((side) => {
    const flag = side > 0 ? p.wallL : p.wallR;
    return runs(p, secs, (k) => flag[k] === 1).map(([a, b]) => ({ side, ks: Array.from({ length: b - a + 1 }, (_, j) => secs[(a + j) % n]!) }));
  });
}

/** The road face of `side`'s wall at sample k: its lateral offset (m, left of travel +) on the path's frame. */
export function wallLateral(p: TrackPath, k: number, side: number): number {
  return side * (p.half[k]! + (side > 0 ? p.runL[k]! : p.runR[k]!));
}

/**
 * Every piece of path `p`'s walls as solid box colliders, in run and section order: the chord between two sections'
 * road-face points, `WALL_THICK` deep behind it, from the profile's foot to the wall's top, local z along the wall from
 * the first section to the second. A box is level, so a chord that climbs more than `WALL_STEP` is cut into level boxes
 * (none stands more than `WALL_STEP` over the drawn top at its low end). A run's two drawn ends are faces; every other
 * end, a piece's or a cut's, is the joint to the next box. `index` is 0: `wallColliders` numbers the boxes across the course.
 */
export function pathWallColliders(p: TrackPath, ground: TrackGround, height: number): PropCollider[] {
  return wallRuns(p).flatMap(({ side, ks }) => {
    const last = ks.length - 2;
    return ks.slice(0, -1).flatMap((ka, j): PropCollider[] => {
      const kb = ks[j + 1]!;
      const la = wallLateral(p, ka, side);
      const lb = wallLateral(p, kb, side);
      const ax = p.x[ka]! + p.tz[ka]! * la;
      const az = p.z[ka]! - p.tx[ka]! * la;
      const dx = p.x[kb]! + p.tz[kb]! * lb - ax;
      const dz = p.z[kb]! - p.tx[kb]! * lb - az;
      const len = hypot2(dx, dz);
      if (len < 1e-3) return [];
      // Across: the chord's normal on the wall's outer side (left of travel is (tz, −tx)).
      const outer = (dz * p.tz[ka]! + dx * p.tx[ka]!) * side > 0 ? 1 : -1;
      const nx = (outer * dz) / len;
      const nz = (-outer * dx) / len;
      const ya = surfY(ground, p, ka, la);
      const yb = surfY(ground, p, kb, lb);
      const hx = WALL_THICK / 2;
      const cuts = Math.max(1, Math.ceil(Math.abs(yb - ya) / WALL_STEP));
      const hz = len / cuts / 2;
      return Array.from({ length: cuts }, (_, i): PropCollider => {
        const t0 = i / cuts;
        const t1 = (i + 1) / cuts;
        const y0 = ya + (yb - ya) * t0;
        const y1 = ya + (yb - ya) * t1;
        return {
          index: 0,
          prefab: null,
          body: "solid",
          x: ax + dx * ((t0 + t1) / 2) + nx * hx,
          z: az + dz * ((t0 + t1) / 2) + nz * hx,
          yaw: Math.atan2(dx, dz),
          kind: "box",
          r: hypot2(hx, hz),
          hx,
          hz,
          mass: 0,
          base: Math.min(y0, y1) + WALL_FOOT,
          top: Math.max(y0, y1) + height,
          ends: (j === 0 && i === 0 ? 1 : 0) | (j === last && i === cuts - 1 ? 2 : 0),
        };
      });
    });
  });
}

/** Every piece of `track`'s walls (`pathWallColliders`), path after path, numbered across the course. */
export function wallColliders(track: Track): PropCollider[] {
  const ground = track.ground();
  const height = track.json.road.wallHeight;
  const out = track.paths().flatMap((p) => pathWallColliders(p, ground, height));
  for (const [i, c] of out.entries()) c.index = i;
  return out;
}
