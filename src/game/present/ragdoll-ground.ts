import * as THREE from "three";
import type { Collider, ColliderDesc, World } from "@dimforge/rapier3d";
import type { Rapier } from "../kernel/rapier.ts";
import { Corkscrew, corkscrewMesh } from "../scenes/corkscrew.ts";
import { FleetRamps, RAMP } from "../scenes/fleet-ramps.ts";
import { activeGround, DISC_GROUND, DISC_RADIUS, FLAT_GROUND } from "../world/ground.ts";
import type { Track } from "../world/track.ts";
import type { Solid } from "./ragdoll-solids.ts";

/** The course under a throw: its road walls come from `track` (none for a scene's own solids, the Lab's), every other solid from `solids` (`courseSolids`). */
type Course = { track: Track | null; solids: readonly Solid[] };
/** A sandbox lamp post (`LampPole`'s fields that matter here): a thin upright cylinder while it stands. */
export type Pole = { group: { position: { x: number; z: number }; visible: boolean }; intact: boolean; radius: number };
/** Corkscrew channel triangle spacing (m) along the run: the floor's twist is held to a few cm per strip. */
const CORK_STEP = 0.25;
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

/**
 * The ground under a throw at (`cx`, `cz`), `y` high: the flat pad, the fleet disc (with the jump ramps' wedges), the
 * corkscrew's pad and channel, or a course heightfield patch `half` m to a side of it (its square, and the reach of the
 * walls and solids built with it), and the solids on it: the derby bowl's wall when `bowlR` > 0, the sandbox's standing
 * `poles`, and on a `course` the road walls, props, tunnels and decks near it. `sand`: the range's pad. `groups`: the
 * collision groups of every collider built.
 */
export function groundColliders(R: Rapier, world: World, groups: number, course: Course | null, sand: boolean, bowlR: number, poles: readonly Pole[], cx: number, cz: number, y: number, half: number): Collider[] {
  const ground = activeGround();
  const into: Collider[] = [];
  const add = (desc: ColliderDesc, friction = 0.9) => into.push(world.createCollider(desc.setFriction(friction).setCollisionGroups(groups)));
  const n = Math.round((2 * half) / PATCH_CELL);
  const size = n * PATCH_CELL;
  if (ground === FLAT_GROUND || ground instanceof Corkscrew) {
    const rule = sand ? R.CoefficientCombineRule.Max : R.CoefficientCombineRule.Average;
    add(R.ColliderDesc.cuboid(FLAT_HALF, 0.5, FLAT_HALF).setTranslation(0, -0.5, 0).setFrictionCombineRule(rule), sand ? SAND : 0.9);
    if (ground instanceof Corkscrew) {
      const mesh = corkscrewMesh(CORK_STEP);
      add(R.ColliderDesc.trimesh(mesh.vertices, mesh.indices));
    }
  } else if (ground === DISC_GROUND || ground instanceof FleetRamps) {
    add(R.ColliderDesc.cylinder(0.5, DISC_RADIUS).setTranslation(0, -0.5, 0));
    if (ground instanceof FleetRamps) {
      // The two wedges (`FleetRamps`): high end against the slab, side and back faces are walls a heightfield could not give.
      const yaw = ground.group.rotation.y;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      for (const side of [1, -1]) {
        const pts: number[] = [];
        for (const [u, h] of [[RAMP.start, 0], [RAMP.start, RAMP.top], [RAMP.start + RAMP.len, 0]] as const) {
          for (const v of [-RAMP.halfW, RAMP.halfW]) pts.push(v * c + side * u * s, h, -v * s + side * u * c);
        }
        const hull = R.ColliderDesc.convexHull(new Float32Array(pts));
        if (hull) add(hull);
      }
    }
  } else if (course?.track !== null) {
    // A course's heightfield; a scene's own solids (the Lab's bench and floor, `setSolids`) carry its ground, edges sharp.
    // Its vertices lie on the world's `PATCH_CELL` lattice, so every patch (any size, anywhere) has the same triangles where
    // they overlap, and what a body lands on does not hang on where its patch was centred.
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
