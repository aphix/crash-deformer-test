import * as THREE from "three";
import type { ColliderDesc } from "@dimforge/rapier3d";
import type { Rapier } from "../kernel/rapier.ts";
import { hypot2 } from "../kernel/physics-core.js";
import { propColliders, type Placed, type PropCollider } from "../world/placements.ts";
import { blankPoint, pointOn, type Track, type TrackPath } from "../world/track.ts";
import { ARCH_STEPS, DECK_LIP, DECK_THICK, GANTRY_BEAM, levelAt, RoadIndex, sampleStep, sections, surfY, TUNNEL_GAP, TUNNEL_SHELL, TUNNEL_SIDE } from "./track-mesh.ts";
import { pillarPieces } from "./track-structures.ts";

/**
 * A fixed solid of a course that a thrown dummy hits (the cosmetic Rapier world's static colliders). `x`, `z`, `r`: its
 * centre and bounding radius in plan (the reach test); `make`: its collider. Built once per course and shared by every throw.
 */
export type Solid = { x: number; z: number; r: number; make: (R: Rapier) => ColliderDesc | null };

/** Longest beam (m) a tunnel roof or a deck is cut into: bends and crests stay within a few cm of the drawn shell. */
const BEAM = 8;
/** Beams overlap their neighbours by this much (m), so no gap opens on a bend. */
const LAP = 0.05;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _z = new THREE.Vector3();
const _mid = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** A cuboid `solid`: half extents (`hx`, `hy`, `hz`) about (`x`, `y`, `z`), turned by the current `_q`. */
function box(x: number, y: number, z: number, hx: number, hy: number, hz: number): Solid {
  const { x: qx, y: qy, z: qz, w: qw } = _q;
  return { x, z, r: hypot2(hx, hz), make: (R) => R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation({ x: qx, y: qy, z: qz, w: qw }) };
}

/** The slab of depth `thick` on the far side of the quad a0 b0 b1 a1 from `away`: a0→b0 across, a→a1 along the run. */
function slab(a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3, thick: number, away: THREE.Vector3): Solid {
  _mid.copy(a0).add(b0).add(a1).add(b1).multiplyScalar(0.25);
  _u.copy(a1).add(b1).sub(a0).sub(b0);
  const run = _u.length() / 2;
  _u.normalize();
  _v.copy(b0).add(b1).sub(a0).sub(a1);
  const across = _v.length() / 2;
  _v.normalize();
  _n.crossVectors(_u, _v).normalize();
  if (_n.dot(_a.copy(_mid).sub(away)) < 0) _n.negate();
  _z.crossVectors(_v, _n);
  _q.setFromRotationMatrix(_m.makeBasis(_v, _n, _z));
  _mid.addScaledVector(_n, thick / 2);
  return box(_mid.x, _mid.y, _mid.z, across / 2 + LAP, thick / 2, run / 2 + LAP);
}

/** Sample index ranges [a, b] of the sections along `p` where `on[k]` holds for the segment leaving each, cut to at most `BEAM` m. */
function stretches(p: TrackPath, secs: readonly number[], on: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  const n = secs.length;
  const last = p.closed ? n : n - 1;
  const most = BEAM / sampleStep(p);
  let a = -1;
  let len = 0;
  for (let i = 0; i < last; i++) {
    const k = secs[i]!;
    const b = secs[(i + 1) % n]!;
    if (!on[k]) {
      a = -1;
      continue;
    }
    if (a < 0) {
      a = k;
      len = 0;
    }
    len += (b - k + p.count) % p.count;
    if (len >= most || i + 1 >= last || !on[secs[i + 1]!]) {
      out.push([a, b]);
      a = -1;
    }
  }
  return out;
}

const world = (p: TrackPath, k: number, lat: number, y: number, out: THREE.Vector3): THREE.Vector3 => out.set(p.x[k]! + p.tz[k]! * lat, y, p.z[k]! - p.tx[k]! * lat);

/** Tunnel shell (the inner surface `addTunnels` draws: two side walls and the arch), deck slabs, and the start gantry's legs and the bridge bents. */
function structures(track: Track, out: Solid[]): void {
  const ground = track.ground();
  const paths = track.paths();
  const index = new RoadIndex(paths);
  const pt = pointOn(track.path, 0, blankPoint());
  // Start gantry legs (`TrackArt`): just past each side's wall line, 1.2 m square.
  for (const lat of [pt.half + track.path.runL[0]! + 1.2, -(pt.half + track.path.runR[0]! + 1.2)]) {
    const x = pt.x + pt.tz * lat;
    const z = pt.z - pt.tx * lat;
    const y = ground.heightAt(x, z, pt.y);
    _q.identity();
    out.push(box(x, y + (GANTRY_BEAM + 0.5) / 2, z, 0.6, (GANTRY_BEAM + 0.5) / 2, 0.6));
  }
  const ref = new THREE.Vector3();
  const [p0, p1, p2, p3] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const p of paths) {
    const secs = sections(p, 0);
    for (const [ka, kb] of stretches(p, secs, p.deck)) {
      // Slab top from the left lip across the road to the right: three planes, so a banked road under flat runoff stays exact.
      const lats = (k: number) => {
        const h = p.half[k]!;
        return [-(h + p.runR[k]! + DECK_LIP), -h, h, h + p.runL[k]! + DECK_LIP];
      };
      const la = lats(ka);
      const lb = lats(kb);
      world(p, ka, 0, levelAt(p, ka, 0) + 10, ref);
      for (let j = 0; j < 3; j++) {
        world(p, ka, la[j]!, levelAt(p, ka, la[j]!), p0);
        world(p, ka, la[j + 1]!, levelAt(p, ka, la[j + 1]!), p1);
        world(p, kb, lb[j]!, levelAt(p, kb, lb[j]!), p2);
        world(p, kb, lb[j + 1]!, levelAt(p, kb, lb[j + 1]!), p3);
        out.push(slab(p0, p1, p2, p3, DECK_THICK, ref));
      }
    }
    for (const [ka, kb] of stretches(p, secs, p.tunnel)) {
      // The inner profile of `addTunnels`: left foot, left top, arch, right top, right foot (lateral, height).
      const shape = (k: number): number[] => {
        const WL = p.half[k]! + p.runL[k]! + TUNNEL_GAP;
        const WR = p.half[k]! + p.runR[k]! + TUNNEL_GAP;
        const y0 = surfY(ground, p, k, 0);
        const top = y0 + TUNNEL_SIDE;
        const c = (WL - WR) / 2;
        const ra = (WL + WR) / 2;
        const rise = Math.min(3, ra * 0.3);
        const pts = [WL, surfY(ground, p, k, WL) - 0.4, WL, top];
        for (let i = 1; i < ARCH_STEPS; i++) pts.push(c + ra * Math.cos((i / ARCH_STEPS) * Math.PI), top + rise * Math.sin((i / ARCH_STEPS) * Math.PI));
        pts.push(-WR, top, -WR, surfY(ground, p, k, -WR) - 0.4);
        return pts;
      };
      const sa = shape(ka);
      const sb = shape(kb);
      world(p, ka, 0, surfY(ground, p, ka, 0) + TUNNEL_SIDE / 2, ref);
      for (let j = 0; j < sa.length / 2 - 1; j++) {
        world(p, ka, sa[2 * j]!, sa[2 * j + 1]!, p0);
        world(p, ka, sa[2 * j + 2]!, sa[2 * j + 3]!, p1);
        world(p, kb, sb[2 * j]!, sb[2 * j + 1]!, p2);
        world(p, kb, sb[2 * j + 2]!, sb[2 * j + 3]!, p3);
        out.push(slab(p0, p1, p2, p3, TUNNEL_SHELL, ref));
      }
    }
    if (!p.deck.includes(1)) continue;
    // Bridge bents (pillars and pier caps): each piece's own convex hull.
    for (const [geo] of pillarPieces(p, secs, ground, index)) {
      const at = geo.getAttribute("position");
      const pts = new Float32Array(at.array);
      geo.dispose();
      let x = 0;
      let z = 0;
      for (let i = 0; i < pts.length; i += 3) {
        x += pts[i]!;
        z += pts[i + 2]!;
      }
      x /= pts.length / 3;
      z /= pts.length / 3;
      let r = 0;
      for (let i = 0; i < pts.length; i += 3) r = Math.max(r, hypot2(pts[i]! - x, pts[i + 2]! - z));
      out.push({ x, z, r, make: (R) => R.ColliderDesc.convexHull(pts) });
    }
  }
}

/**
 * Every collider but the knockable props' (each of those is its own body, `PropBodies`) as a solid standing from its
 * placement's base (`floor` for one with no placement: the Lab's wall) to its top, at the footprint the cars hit, so a
 * dummy meets exactly what a car does. Appended to `out`.
 */
export function colliderSolids(colliders: readonly PropCollider[], placed: readonly Placed[], floor: number, out: Solid[]): Solid[] {
  for (const c of colliders) {
    if (c.body === "knock") continue;
    const y0 = placed[c.index]?.y ?? floor;
    const h = c.top - y0;
    if (c.kind === "circle") out.push({ x: c.x, z: c.z, r: c.r, make: (R) => R.ColliderDesc.cylinder(h / 2, c.r).setTranslation(c.x, y0 + h / 2, c.z) });
    else {
      _q.setFromAxisAngle(UP, c.yaw);
      out.push(box(c.x, y0 + h / 2, c.z, c.hx, h / 2, c.hz));
    }
  }
  return out;
}

/**
 * Every solid of `track` a dummy can hit that the ground heightfield and the road walls do not already give: the props
 * (`colliderSolids`), the start gantry's legs, bridge decks and bents, and the tunnels' shell.
 */
export function courseSolids(track: Track, placed: readonly Placed[]): Solid[] {
  const out = colliderSolids(propColliders(placed), placed, 0, []);
  structures(track, out);
  return out;
}
