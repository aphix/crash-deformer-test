import * as THREE from "three";
import type { Collider, ColliderDesc, World } from "@dimforge/rapier3d-simd";
import type { Rapier } from "../kernel/rapier.ts";
import { activeGround } from "../world/ground.ts";
import { GRID, P_AX, P_BX, P_CX, P_OX, P_OY, P_OZ, P_RAD2, P_STEP, P_STEPV, P_STRIDE, P_U0, P_V0, Q_KIND, Q_NU, Q_NV, Q_SOLID, Q_STRIDE, type Surface } from "../world/surfaces.ts";
import type { Track } from "../world/track.ts";
import type { Solid } from "./ragdoll-solids.ts";

/** The course under a throw: its road walls come from `track` (none for a scene's own solids, the Lab's), every other solid from `solids` (`courseSolids`). */
type Course = { track: Track | null; solids: readonly Solid[] };
/** A sandbox lamp post (`LampPole`'s fields that matter here): a thin upright cylinder while it stands. */
export type Pole = { group: { position: { x: number; z: number }; visible: boolean }; intact: boolean; radius: number };
/** Half-thickness (m) of a flat solid's slab, and how far under its lowest node a tilted patch's prism reaches. */
const SLAB = 0.5;
/** Sandbox lamp post height (m): the cinematic eye's occluder for it. */
const POLE_H = 5.3;

/** Course ground patch cell size (m). */
const PATCH_CELL = 2;
/** A dummy's patch around a throw (`groundColliders`' `half`): 96 m across. */
export const PATCH_HALF = 48;
/** Metres down a throw that the patch built for it is centred. */
export const PATCH_AHEAD = 24;
/** Half-size (m) of the sandbox's flat pad collider: past any spot a car reaches. */
const FLAT_HALF = 1000;
/**
 * How far (m) a wall's box reaches under the ground: no bottom edge where it meets the ground for a body to be driven
 * under. A lying cone slid at 38 m/s into a road wall that stopped at the ground went 46 mm into it (4 of 80 run-overs
 * at 1/480); with the footing none over 23 mm.
 */
const FOOTING = 1;
/** Derby bowl wall: `derby-arena.ts`'s 28 slabs, 1.15 m high, 0.42 m thick at the 16.4 m bowl. */
const BOWL_SEGMENTS = 28;
const BOWL_H = 1.15;
const BOWL_T = 0.42;
const BOWL_R0 = 16.4;
/**
 * The range's sand: friction that wins over the dummy's `SLIDE` (Max rule), so he digs in instead of skating. Lane
 * ragdoll-6's range probe at 30–360 Hz (fixed step, the fleshy losses): 3 lands him 28.2–29.3 m out at 100 km/h.
 */
const SAND = 3;

const _q = new THREE.Quaternion();
const _r = new THREE.Vector3();

/** A one-cell grid patch (a plane, a ramp's face): its four nodes are all there is to it. */
function oneCell(s: Surface, k: number): boolean {
  const qo = k * Q_STRIDE;
  return s.q[qo + Q_KIND] === GRID && s.q[qo + Q_NU] === 2 && s.q[qo + Q_NV] === 2;
}

/**
 * The solid of one-cell patch `k` of `s`: a level one is a slab 0.5 m thick under its top (a cuboid, at most `FLAT_HALF` out
 * from its middle: the pad; a cylinder where the patch is round: the fleet disc), a tilted one the prism from its face down to
 * 0.5 m under its lowest node (a ramp's wedge). `sand`: the range's pad (a slab's floor, whose friction wins over the dummy's
 * slide).
 */
function cellSolid(R: Rapier, s: Surface, k: number, sand: boolean): ColliderDesc | null {
  const P = s.p;
  const o = k * P_STRIDE;
  const hs = s.nodes[k]!;
  const ox = P[o + P_OX]!;
  const oy = P[o + P_OY]!;
  const oz = P[o + P_OZ]!;
  const [ax, ay, az] = [P[o + P_AX]!, P[o + P_AX + 1]!, P[o + P_AX + 2]!];
  const [bx, by, bz] = [P[o + P_BX]!, P[o + P_BX + 1]!, P[o + P_BX + 2]!];
  const [cx, cy, cz] = [P[o + P_CX]!, P[o + P_CX + 1]!, P[o + P_CX + 2]!];
  const u0 = P[o + P_U0]!;
  const v0 = P[o + P_V0]!;
  const du = P[o + P_STEP]!;
  const dv = P[o + P_STEPV]!;
  const level = by === 1 && ay === 0 && cy === 0 && hs[1] === hs[0] && hs[2] === hs[0] && hs[3] === hs[0];
  if (level) {
    const top = oy + hs[0]!;
    const r2 = P[o + P_RAD2]!;
    if (r2 > 0) return R.ColliderDesc.cylinder(SLAB, Math.sqrt(r2)).setTranslation(ox, top - SLAB, oz).setFriction(0.9);
    const um = u0 + du / 2;
    const vm = v0 + dv / 2;
    _q.setFromAxisAngle(_r.set(0, 1, 0), Math.atan2(-az, ax));
    return R.ColliderDesc.cuboid(Math.min(Math.abs(du) / 2, FLAT_HALF), SLAB, Math.min(Math.abs(dv) / 2, FLAT_HALF))
      .setTranslation(ox + ax * um + cx * vm, top - SLAB, oz + az * um + cz * vm)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setFrictionCombineRule(sand ? R.CoefficientCombineRule.Max : R.CoefficientCombineRule.Average)
      .setFriction(sand ? SAND : 0.9);
  }
  const pts: number[] = [];
  let low = Infinity;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const u = u0 + i * du;
      const v = v0 + j * dv;
      const h = hs[j * 2 + i]!;
      const y = oy + ay * u + by * h + cy * v;
      low = Math.min(low, y);
      pts.push(ox + ax * u + bx * h + cx * v, y, oz + az * u + bz * h + cz * v);
    }
  }
  for (let m = 0; m < 4; m++) pts.push(pts[m * 3]!, low - SLAB, pts[m * 3 + 2]!);
  return R.ColliderDesc.convexHull(new Float32Array(pts))?.setFriction(0.9) ?? null;
}

/**
 * The ground under a throw at (`cx`, `cz`), `y` high: the active surface's own solids (`cellSolid` for its one-cell patches,
 * its `meshes`) and, where it has terrain (a multi-cell patch or a road deck), one heightfield patch of it `half` m to a side around the throw (its square, and the reach of the walls and solids built with it);
 * then the solids on it: the derby bowl's wall when `bowlR` > 0, the sandbox's standing `poles`, and on a `course` the road
 * walls, props, tunnels and decks near it. `sand`: the range's pad. `groups`: the collision groups of every collider built.
 */
export function groundColliders(R: Rapier, world: World, groups: number, course: Course | null, sand: boolean, bowlR: number, poles: readonly Pole[], cx: number, cz: number, y: number, half: number): Collider[] {
  const ground = activeGround();
  const into: Collider[] = [];
  const place = (desc: ColliderDesc) => into.push(world.createCollider(desc.setCollisionGroups(groups)));
  const add = (desc: ColliderDesc, friction = 0.9) => place(desc.setFriction(friction));
  const n = Math.round((2 * half) / PATCH_CELL);
  const size = n * PATCH_CELL;
  let terrain = false;
  for (let k = 0; k < ground.count; k++) {
    if (ground.q[k * Q_STRIDE + Q_SOLID] === 0) continue;
    if (!oneCell(ground, k)) {
      terrain = true;
      continue;
    }
    const desc = cellSolid(R, ground, k, sand);
    if (desc) place(desc);
  }
  for (const m of ground.meshes) add(R.ColliderDesc.trimesh(m.vertices, m.indices));
  // A course's heightfield; a scene's own solids (the Lab's bench and floor, `setSolids`) carry its ground, edges sharp.
  if (terrain && course?.track !== null) {
    // Its vertices lie on the world's `PATCH_CELL` lattice, so every patch (any size, anywhere) has the same triangles where they
    // overlap, and what a body lands on does not hang on where its patch was centred.
    const x0 = Math.round((cx - size / 2) / PATCH_CELL) * PATCH_CELL;
    const z0 = Math.round((cz - size / 2) / PATCH_CELL) * PATCH_CELL;
    const heights = new Float32Array((n + 1) * (n + 1));
    for (let ix = 0; ix <= n; ix++) {
      for (let iz = 0; iz <= n; iz++) {
        // A bridge deck counts only for a throw at its height: under it the heightfield is the road.
        const h = ground.heightAt(x0 + ix * PATCH_CELL, z0 + iz * PATCH_CELL, y);
        // Rapier's heightfield: rows run along z, columns along x.
        heights[iz + ix * (n + 1)] = Number.isFinite(h) ? h : -40;
      }
    }
    // Its triangles' inner edges are fixed (`FIX_INTERNAL_EDGES`): a body sliding over the seam between two never catches on
    // it. Without, a crate slid flat at 11 m/s across the flat infield tipped 88° on a seam instead of sliding 7 m upright.
    add(R.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }, R.HeightFieldFlags.FIX_INTERNAL_EDGES).setTranslation(x0 + size / 2, 0, z0 + size / 2));
  }
  // Off a course every wall is built (the bowl's are all within reach of any throw in it); on one, those near it.
  const reach = course ? size / 2 : Infinity;
  // `level`: the path's own height, so a wall under a bridge stands on the road and not on the deck above it.
  const wall = (ax: number, az: number, bx: number, bz: number, h: number, t: number, out: number, level?: number) => {
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    if (Math.hypot(mx - cx, mz - cz) > reach) return;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return;
    const y = ground.heightAt(mx, mz, level);
    const base = Number.isFinite(y) ? y : 0;
    // Box long axis along the segment, its inner face on the line (`out`: the outward normal's sign).
    const nx = ((bz - az) / len) * out;
    const nz = (-(bx - ax) / len) * out;
    _q.setFromAxisAngle(_r.set(0, 1, 0), Math.atan2(bx - ax, bz - az));
    add(
      R.ColliderDesc.cuboid(t / 2, (h + FOOTING) / 2, len / 2 + 0.05)
        .setTranslation(mx + (nx * t) / 2, base + (h - FOOTING) / 2, mz + (nz * t) / 2)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
    );
  };
  if (bowlR > 0) {
    const scale = bowlR / BOWL_R0;
    const r = bowlR - (BOWL_T * scale) / 2;
    for (let k = 0; k < BOWL_SEGMENTS; k++) {
      const a0 = (k / BOWL_SEGMENTS) * Math.PI * 2;
      const a1 = ((k + 1) / BOWL_SEGMENTS) * Math.PI * 2;
      wall(Math.sin(a0) * r, Math.cos(a0) * r, Math.sin(a1) * r, Math.cos(a1) * r, BOWL_H, BOWL_T * scale, -1);
    }
  }
  for (const p of poles) {
    if (!p.intact || !p.group.visible) continue;
    add(R.ColliderDesc.cylinder(POLE_H / 2, p.radius).setTranslation(p.group.position.x, POLE_H / 2, p.group.position.z));
  }
  if (course) {
    for (const s of course.solids) {
      if (Math.hypot(s.x - cx, s.z - cz) > reach + s.r) continue;
      const desc = s.make(R);
      if (desc) add(desc);
    }
    const track = course.track;
    const wallH = track?.json.road.wallHeight ?? 0;
    for (const p of track ? track.paths() : []) {
      const segs = p.closed ? p.count : p.count - 1;
      for (let k = 0; k < segs; k++) {
        const b = (k + 1) % p.count;
        if (Math.hypot(p.x[k]! - cx, p.z[k]! - cz) > reach + 10) continue;
        // Left of travel = (tz, −tx); a wall stands half + run out on each flagged side.
        for (const side of [1, -1]) {
          if (!(side > 0 ? p.wallL[k] : p.wallR[k])) continue;
          const la = side * (p.half[k]! + (side > 0 ? p.runL[k]! : p.runR[k]!));
          const lb = side * (p.half[b]! + (side > 0 ? p.runL[b]! : p.runR[b]!));
          wall(p.x[k]! + p.tz[k]! * la, p.z[k]! - p.tx[k]! * la, p.x[b]! + p.tz[b]! * lb, p.z[b]! - p.tx[b]! * lb, wallH, 0.4, side, p.y[k]!);
        }
      }
    }
  }
  return into;
}
