import * as THREE from "three";
import type { Collider, ColliderDesc, World } from "@dimforge/rapier3d";
import type { Rapier } from "../kernel/rapier.ts";
import { activeGround, DISC_GROUND, DISC_RADIUS, FLAT_GROUND } from "../world/ground.ts";
import type { Track } from "../world/track.ts";

/** Course ground patch around a throw: cells per side and cell size (m), 96 m across. */
const PATCH_N = 48;
const PATCH_CELL = 2;
/** Half-size (m) of the sandbox's flat pad collider: past any spot a car reaches. */
const FLAT_HALF = 1000;
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
 * The ground under a throw at (`cx`, `cz`): the flat pad, the fleet disc, or a course heightfield patch, and the walls
 * on it (the derby bowl's when `bowlR` > 0, the course's near it). `sand`: the range's pad. `onCourse`: the active
 * ground is `course`'s. `groups`: the collision groups of every collider built.
 */
export function groundColliders(R: Rapier, world: World, groups: number, course: Track | null, onCourse: boolean, sand: boolean, bowlR: number, cx: number, cz: number): Collider[] {
  const ground = activeGround();
  const into: Collider[] = [];
  const add = (desc: ColliderDesc, friction = 0.9) => into.push(world.createCollider(desc.setFriction(friction).setCollisionGroups(groups)));
  const size = PATCH_N * PATCH_CELL;
  if (ground === FLAT_GROUND) {
    const rule = sand ? R.CoefficientCombineRule.Max : R.CoefficientCombineRule.Average;
    add(R.ColliderDesc.cuboid(FLAT_HALF, 0.5, FLAT_HALF).setTranslation(0, -0.5, 0).setFrictionCombineRule(rule), sand ? SAND : 0.9);
  } else if (ground === DISC_GROUND) add(R.ColliderDesc.cylinder(0.5, DISC_RADIUS).setTranslation(0, -0.5, 0));
  else {
    const n = PATCH_N;
    const heights = new Float32Array((n + 1) * (n + 1));
    for (let ix = 0; ix <= n; ix++) {
      for (let iz = 0; iz <= n; iz++) {
        const y = ground.heightAt(cx - size / 2 + ix * PATCH_CELL, cz - size / 2 + iz * PATCH_CELL);
        // Rapier's heightfield: rows run along z, columns along x.
        heights[iz + ix * (n + 1)] = Number.isFinite(y) ? y : -40;
      }
    }
    add(R.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }).setTranslation(cx, 0, cz));
  }
  // Off a course every wall is built (the bowl's are all within reach of any throw in it); on one, those near it.
  const reach = onCourse ? size / 2 : Infinity;
  const wall = (ax: number, az: number, bx: number, bz: number, h: number, t: number, out: number) => {
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    if (Math.hypot(mx - cx, mz - cz) > reach) return;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return;
    const y = ground.heightAt(mx, mz);
    const base = Number.isFinite(y) ? y : 0;
    // Box long axis along the segment, its inner face on the line (`out`: the outward normal's sign).
    const nx = ((bz - az) / len) * out;
    const nz = (-(bx - ax) / len) * out;
    _q.setFromAxisAngle(_r.set(0, 1, 0), Math.atan2(bx - ax, bz - az));
    add(
      R.ColliderDesc.cuboid(t / 2, h / 2, len / 2 + 0.05)
        .setTranslation(mx + (nx * t) / 2, base + h / 2, mz + (nz * t) / 2)
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
  if (course && onCourse) {
    const wallH = course.json.road.wallHeight;
    for (const p of course.paths()) {
      const segs = p.closed ? p.count : p.count - 1;
      for (let k = 0; k < segs; k++) {
        const b = (k + 1) % p.count;
        if (Math.hypot(p.x[k]! - cx, p.z[k]! - cz) > reach + 10) continue;
        // Left of travel = (tz, −tx); a wall stands half + run out on each flagged side.
        for (const side of [1, -1]) {
          if (!(side > 0 ? p.wallL[k] : p.wallR[k])) continue;
          const la = side * (p.half[k]! + (side > 0 ? p.runL[k]! : p.runR[k]!));
          const lb = side * (p.half[b]! + (side > 0 ? p.runL[b]! : p.runR[b]!));
          wall(p.x[k]! + p.tz[k]! * la, p.z[k]! - p.tx[k]! * la, p.x[b]! + p.tz[b]! * lb, p.z[b]! - p.tx[b]! * lb, wallH, 0.4, side);
        }
      }
    }
  }
  return into;
}
