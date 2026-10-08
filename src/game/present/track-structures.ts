import * as THREE from "three";
import { hypot2 } from "../kernel/physics-core.js";
import { clamp } from "../kernel/scalar.ts";
import { TILE, box, type Piece } from "./prefabs.ts";
import { blankPoint, pointOn, type TrackGround, type TrackPath } from "../world/track.ts";
import { levelAt, runs, sampleStep, surfY, WALL_PERIOD, WALL_PROFILE, wallLateral, wallRuns } from "../world/track-sections.ts";
import {
  ARCH_STEPS, CONCRETE, CONCRETE_DARK, DECK_COL, DECK_LIP, DECK_THICK, Mesher, PILLAR_EVERY, PILLAR_R, RED,
  RoadIndex, sampleAt, TUNNEL_GAP, TUNNEL_IN, TUNNEL_LIGHT, TUNNEL_LIGHT_EVERY, TUNNEL_SHELL,
  TUNNEL_SIDE, TUNNEL_TILE, WHITE,
} from "./track-mesh.ts";

/** Track art above the ground: walls, bridge decks with pillars and tunnels. */

/** A section frame: centre, flat unit tangent, arc length. */
type Frame = { x: number; z: number; tx: number; tz: number; s: number };

function frameOf(p: TrackPath, k: number): Frame {
  return { x: p.x[k]!, z: p.z[k]!, tx: p.tx[k]!, tz: p.tz[k]!, s: k * sampleStep(p) };
}

/**
 * Quad strip for profile segment j..j+1 between sections A and B (profiles as (lateral + left, y)
 * pairs). Front faces follow the profile's left-hand normal: a profile running clockwise (seen
 * with + lateral to the right, y up) faces out of the solid it bounds.
 */
function stripJ(m: Mesher, fa: Frame, A: readonly number[], fb: Frame, B: readonly number[], j: number, hex: number, tile: number, v0: number): void {
  const ids: number[] = [];
  for (const [f, P] of [
    [fa, A],
    [fb, B],
  ] as const) {
    const dl = P[j * 2 + 2]! - P[j * 2]!;
    const dy = P[j * 2 + 3]! - P[j * 2 + 1]!;
    const len = hypot2(dl, dy) || 1;
    for (let q = 0; q < 2; q++) {
      const l = P[(j + q) * 2]!;
      const id = m.v(f.x + f.tz * l, P[(j + q) * 2 + 1]!, f.z - f.tx * l, hex, f.s / tile, (v0 + q * len) / tile);
      m.normal(id, (f.tz * -dy) / len, dl / len, (-f.tx * -dy) / len);
      ids.push(id);
    }
  }
  m.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
}

/** Flat polygon (convex, (lateral, y) pairs) in the section plane, facing +s (`facing` 1) or −s (−1). */
function face(m: Mesher, f: Frame, P: readonly number[], facing: number, hex: number, tile: number): void {
  const ids: number[] = [];
  for (let i = 0; i < P.length; i += 2) {
    const l = P[i]!;
    const id = m.v(f.x + f.tz * l, P[i + 1]!, f.z - f.tx * l, hex, l / tile, P[i + 1]! / tile);
    m.normal(id, f.tx * facing, 0, f.tz * facing);
    ids.push(id);
  }
  for (let i = 1; i + 1 < ids.length; i++) {
    // In (lateral, y), counter-clockwise faces +s (left × up = forward).
    const ax = P[i * 2]! - P[0]!;
    const ay = P[i * 2 + 1]! - P[1]!;
    const bx = P[i * 2 + 2]! - P[0]!;
    const by = P[i * 2 + 3]! - P[1]!;
    const ccw = ax * by - ay * bx > 0;
    if (ccw === facing > 0) m.idx.push(ids[0]!, ids[i]!, ids[i + 1]!);
    else m.idx.push(ids[0]!, ids[i + 1]!, ids[i]!);
  }
}

/** Continuous jersey barrier on each walled side, broken (and capped) where the flag is off: `wallRuns`, the very walls the cars and the dummies meet. */
export function addWalls(m: Mesher, p: TrackPath, ground: TrackGround, wallHeight: number): void {
  const prof = WALL_PROFILE.map(([u, v]) => [u, v > 0 ? v * wallHeight : v] as const);
  const vlen: number[] = [0];
  for (let j = 1; j < prof.length; j++) vlen.push(vlen[j - 1]! + hypot2(prof[j]![0] - prof[j - 1]![0], prof[j]![1] - prof[j - 1]![1]));
  const ds = sampleStep(p);
  for (const { side, ks } of wallRuns(p)) {
    // Left wall: the profile as written runs clockwise; the right wall is its mirror, so reversed.
    const order = side > 0 ? prof.map((_, j) => j) : prof.map((_, j) => prof.length - 1 - j);
    const at = (k: number): number[] => {
      const lat = wallLateral(p, k, side);
      const y = surfY(ground, p, k, lat);
      return order.flatMap((j) => [lat + side * prof[j]![0], y + prof[j]![1]]);
    };
    for (let i = 0; i + 1 < ks.length; i++) {
      const k = ks[i]!;
      const k2 = ks[i + 1]!;
      const A = at(k);
      const B = at(k2);
      const fa = frameOf(p, k);
      const fb = frameOf(p, k2);
      const stripe = Math.floor((k * ds) / WALL_PERIOD) % 2 ? RED : WHITE;
      for (let q = 0; q < prof.length - 1; q++) {
        const j = side > 0 ? q : prof.length - 2 - q;
        const hex = j === 1 ? stripe : j < 1 ? CONCRETE : CONCRETE_DARK;
        stripJ(m, fa, A, fb, B, q, hex, TILE.concrete, side > 0 ? vlen[q]! : vlen[prof.length - 1]! - vlen[prof.length - 1 - q]!);
      }
    }
    face(m, frameOf(p, ks[0]!), at(ks[0]!), -1, CONCRETE_DARK, TILE.concrete);
    face(m, frameOf(p, ks.at(-1)!), at(ks.at(-1)!), 1, CONCRETE_DARK, TILE.concrete);
  }
}

/** Bridge slabs under every deck span: lips beyond the walls, fascias, underside, end faces. */
export function addDecks(m: Mesher, p: TrackPath, secs: readonly number[]): void {
  const n = secs.length;
  const slab = (k: number): number[] => {
    const hL = p.half[k]! + p.runL[k]!;
    const hR = p.half[k]! + p.runR[k]!;
    const L = hL + DECK_LIP;
    const R = -(hR + DECK_LIP);
    const top = (l: number) => levelAt(p, k, l);
    // Clockwise round the slab, open along the road (the ribbon is the top).
    return [hL, top(hL), L, top(L), L, top(L) - DECK_THICK, R, top(R) - DECK_THICK, R, top(R), -hR, top(-hR)];
  };
  for (const [a, b] of runs(p, secs, (k) => p.deck[k] === 1)) {
    for (let i = a; i < b; i++) {
      const k = secs[i % n]!;
      const k2 = secs[(i + 1) % n]!;
      const A = slab(k);
      const B = slab(k2);
      let v = 0;
      for (let j = 0; j < 5; j++) {
        stripJ(m, frameOf(p, k), A, frameOf(p, k2), B, j, j === 2 ? CONCRETE_DARK : DECK_COL, TILE.concrete, v);
        v += hypot2(A[j * 2 + 2]! - A[j * 2]!, A[j * 2 + 3]! - A[j * 2 + 1]!);
      }
    }
    for (const [i, facing] of [
      [a, -1],
      [b, 1],
    ] as const) {
      const k = secs[i % n]!;
      const S = slab(k);
      face(m, frameOf(p, k), [S[2]!, S[3]!, S[4]!, S[5]!, S[6]!, S[7]!, S[8]!, S[9]!], facing, CONCRETE_DARK, TILE.concrete);
    }
  }
}

/** Pillar bents every ≈12 m under deck spans, down to the ground below; none standing on a road. */
export function pillarPieces(p: TrackPath, secs: readonly number[], ground: TrackGround, index: RoadIndex): Piece[] {
  const out: Piece[] = [];
  const n = secs.length;
  const ds = sampleStep(p);
  const pt = blankPoint();
  for (const [a, b] of runs(p, secs, (k) => p.deck[k] === 1)) {
    const s0 = secs[a % n]! * ds;
    let s1 = secs[b % n]! * ds;
    if (s1 <= s0) s1 += p.length;
    const count = Math.max(1, Math.round((s1 - s0) / PILLAR_EVERY));
    for (let c = 0; c < count; c++) {
      const s = s0 + ((c + 0.5) * (s1 - s0)) / count;
      pointOn(p, s, pt);
      const k = sampleAt(p, s);
      const lats = pt.half >= 6 ? [pt.half * 0.55, -pt.half * 0.55] : [0];
      const legs: { x: number; z: number; top: number; foot: number }[] = [];
      for (const lat of lats) {
        const x = pt.x + pt.tz * lat;
        const z = pt.z - pt.tx * lat;
        const top = pt.y - clamp(lat, -pt.half, pt.half) * Math.tan(p.bank[k]!) - DECK_THICK - 0.6;
        const foot = ground.heightAt(x, z, pt.y - 3);
        if (top - foot < 1.2 || index.coveredBy(x, z, -1.5) >= 0) break;
        legs.push({ x, z, top, foot });
      }
      if (legs.length !== lats.length) continue;
      const yaw = Math.atan2(pt.tx, pt.tz);
      for (const g of legs) {
        out.push([new THREE.CylinderGeometry(PILLAR_R, PILLAR_R * 1.15, g.top - g.foot + 0.3, 8, 1, true).translate(g.x, (g.top + g.foot - 0.3) / 2, g.z), DECK_COL]);
      }
      // Pier cap: 0.6 m deep, flush under the slab, across the bent.
      const capTop = Math.max(...legs.map((g) => g.top)) + 0.6;
      const span = lats.length > 1 ? Math.abs(lats[0]! - lats[1]!) : 0;
      const capGeo = box(span + PILLAR_R * 2 + 1.2, 0.6, 1.3, 0, 0, 0).rotateY(yaw).translate(pt.x, capTop - 0.3, pt.z);
      out.push([capGeo, CONCRETE_DARK]);
    }
  }
  return out;
}

/** Tunnel shells (dark inside, concrete outside), portals with headwalls, and ceiling light strips. */
export function addTunnels(m: Mesher, lights: Mesher, p: TrackPath, secs: readonly number[], ground: TrackGround): void {
  const n = secs.length;
  const ds = sampleStep(p);
  const shape = (k: number, outer: boolean): number[] => {
    const WL = p.half[k]! + p.runL[k]! + TUNNEL_GAP + (outer ? TUNNEL_SHELL : 0);
    const WR = p.half[k]! + p.runR[k]! + TUNNEL_GAP + (outer ? TUNNEL_SHELL : 0);
    const y0 = surfY(ground, p, k, 0);
    const footL = surfY(ground, p, k, WL) - 0.4;
    const footR = surfY(ground, p, k, -WR) - 0.4;
    const top = y0 + TUNNEL_SIDE;
    const c = (WL - WR) / 2;
    const ra = (WL + WR) / 2;
    const rise = Math.min(3, ra * 0.3) + (outer ? TUNNEL_SHELL : 0);
    const arch: number[] = [];
    for (let i = 1; i < ARCH_STEPS; i++) {
      const t = (i / ARCH_STEPS) * Math.PI;
      arch.push(c + ra * Math.cos(t), top + rise * Math.sin(t));
    }
    // Inner: counter-clockwise round the road (faces in); outer: clockwise (faces out).
    const inner = [WL, footL, WL, top, ...arch, -WR, top, -WR, footR];
    if (!outer) return inner;
    const pts: number[] = [];
    for (let i = inner.length - 2; i >= 0; i -= 2) pts.push(inner[i]!, inner[i + 1]!);
    return pts;
  };
  const P = ARCH_STEPS + 3;
  for (const [a, b] of runs(p, secs, (k) => p.tunnel[k] === 1)) {
    for (let i = a; i < b; i++) {
      const k = secs[i % n]!;
      const k2 = secs[(i + 1) % n]!;
      const fa = frameOf(p, k);
      const fb = frameOf(p, k2);
      for (const outer of [false, true]) {
        const A = shape(k, outer);
        const B = shape(k2, outer);
        for (let j = 0; j < P - 1; j++) {
          const side = j === 0 || j === P - 2;
          stripJ(m, fa, A, fb, B, j, outer ? CONCRETE_DARK : side ? TUNNEL_TILE : TUNNEL_IN, TILE.concrete, j * 2);
        }
      }
    }
    for (const [i, facing] of [
      [a, -1],
      [b, 1],
    ] as const) {
      const k = secs[i % n]!;
      const f = frameOf(p, k);
      const I = shape(k, false);
      const O = shape(k, true);
      const crown = Math.max(...O.filter((_, q) => q % 2 === 1)) + 1.2;
      const wide = 2.5;
      for (let j = 0; j < P - 1; j++) {
        // Ring between the inner and outer shells (outer listed the other way round).
        const o0 = P - 1 - j;
        const o1 = P - 2 - j;
        const ring = [I[j * 2]!, I[j * 2 + 1]!, I[j * 2 + 2]!, I[j * 2 + 3]!, O[o1 * 2]!, O[o1 * 2 + 1]!, O[o0 * 2]!, O[o0 * 2 + 1]!];
        // Headwall: the outer shell out to a rectangle round the portal.
        const lift = (l: number, y: number, q: number) => (q === 0 || q === P - 1 ? [l + Math.sign(l) * wide, y] : [l + Math.sign(l) * wide * (Math.abs(l) / Math.max(1, Math.abs(O[0]!))), crown]);
        const head = [O[o0 * 2]!, O[o0 * 2 + 1]!, O[o1 * 2]!, O[o1 * 2 + 1]!, ...lift(O[o1 * 2]!, O[o1 * 2 + 1]!, o1), ...lift(O[o0 * 2]!, O[o0 * 2 + 1]!, o0)];
        for (const dir of [facing, -facing]) {
          face(m, f, ring, dir, CONCRETE, TILE.concrete);
          face(m, f, head, dir, CONCRETE, TILE.concrete);
        }
      }
    }
    // Ceiling light strips.
    const s0 = secs[a % n]! * ds;
    let s1 = secs[b % n]! * ds;
    if (s1 <= s0) s1 += p.length;
    const pt = blankPoint();
    for (let s = s0 + TUNNEL_LIGHT_EVERY / 2; s + 2.4 < s1; s += TUNNEL_LIGHT_EVERY) {
      const ids: number[] = [];
      for (const ss of [s, s + 2.4]) {
        pointOn(p, ss, pt);
        const k = sampleAt(p, ss);
        const I = shape(k, false);
        const apex = I[(1 + ARCH_STEPS / 2) * 2 + 1]! - 0.08;
        const c = (p.runL[k]! - p.runR[k]!) / 2;
        for (const lat of [c - 0.18, c + 0.18]) ids.push(lights.v(pt.x + pt.tz * lat, apex, pt.z - pt.tx * lat, TUNNEL_LIGHT));
      }
      lights.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
    }
  }
}
