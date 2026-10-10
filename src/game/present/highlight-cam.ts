import { hypot2, hypot3 } from "../kernel/physics-core.js";
import type * as THREE from "three";
import { sightLine, solid, type Sight } from "./spectate-cam.ts";
import { SHOT_FOV } from "./constants.ts";

/** The reel's far-overhead flight between clips (docs/HIGHLIGHTS.md). */
const OVERHEAD = {
  /** Eye height over the course (m), and the extra climb at mid-flight per metre flown (capped at `climbMax`). */
  height: 80,
  climb: 0.25,
  climbMax: 60,
  /** The eye trails the look point by this fraction of its height along the flight, so the view is never straight down. */
  trail: 0.35,
  fov: 50,
};

/**
 * Far-overhead pose at `u` ∈ [0, 1] of the flight from (ax, az) to (bx, bz): eased along the line, climbing in the
 * middle of a long flight, looking down on the point it is over. A pure function of its inputs: every peer at the
 * same `u` frames the same shot.
 */
export function overheadPose(camera: THREE.PerspectiveCamera, ax: number, az: number, bx: number, bz: number, u: number): void {
  const t = Math.min(1, Math.max(0, u));
  const s = t * t * (3 - 2 * t);
  const dx = bx - ax;
  const dz = bz - az;
  const d = hypot2(dx, dz);
  const x = ax + dx * s;
  const z = az + dz * s;
  const y = OVERHEAD.height + Math.sin(Math.PI * t) * Math.min(OVERHEAD.climbMax, d * OVERHEAD.climb);
  // Trail along the flight (a hover with no flight trails toward −z).
  const fx = d > 1e-3 ? dx / d : 0;
  const fz = d > 1e-3 ? dz / d : 1;
  const back = y * OVERHEAD.trail;
  camera.position.set(x - fx * back, y, z - fz * back);
  camera.lookAt(x, 0, z);
  if (camera.fov !== OVERHEAD.fov) {
    camera.fov = OVERHEAD.fov;
    camera.updateProjectionMatrix();
  }
}

/**
 * The context shot (docs/HIGHLIGHTS.md "Camera lookahead"): a fixed eye that keeps two impact points of a clip in frame,
 * for the hit that comes after the crash cam has handed back. It is fitted in world space, from the course's solids and
 * the narrowest screen the reel plays on, so every peer picks the same eye whatever its screen.
 */
const CONTEXT = {
  /** The widest lens (deg); an eye's own lens is the widest up to this that still shows both points car-sized. */
  fov: SHOT_FOV,
  /**
   * The narrowest screen (width over height) the points are fitted to: what the reel's lens (`coverLens`) frames in the part of
   * the view the panels leave free, a phone upright under its bottom sheet (0.446 in the judge's layouts). Any wider screen
   * (a desktop beside its panels, a phone on its side) shows the same eye's points nearer its middle.
   */
  aspect: 0.44,
  /** Each point lies within this share of the frame's half-extent from its middle (the reel's frame margin is 0.8, a panel takes some). */
  fit: 0.6,
  /** A 2 m subject spans at least 1/14 of the frame's height (`VIEW.share` asks 1/16): distance (m) times the lens's tan(half fov) stays under this. */
  reach: 14,
  /**
   * Eyes tried, nearest first: the distance (m) flat from the points' midpoint and the height (m) over it. Low ones stand 5 m
   * and 0.3 of their reach up; the high ones look down a street the low ones cannot see along (a block of buildings in every
   * direction); the last, far and near the ground, look down the line of two points too far apart for a screen's width, one
   * behind the other, through a narrower lens.
   */
  eyes: [
    [14, 9.2],
    [20, 11],
    [26, 12.8],
    [8, 25],
    [14, 25],
    [30, 3],
    [36, 3.5],
    [46, 4],
    [60, 5],
  ],
  /** Directions round the midpoint tried from the seeded `turn`, then along the points' own line (rad off it, from behind either point). */
  turns: 24,
  line: [0, Math.PI, 0.05, -0.05, Math.PI + 0.05, Math.PI - 0.05, 0.1, -0.1, Math.PI + 0.1, Math.PI - 0.1],
};

type Vec3 = { x: number; y: number; z: number };

/** `look`'s eye frame: forward (unit), right (flat, unit) and up. */
const _f = { x: 0, y: 0, z: 0 };
const _r = { x: 0, y: 0, z: 0 };
const _u = { x: 0, y: 0, z: 0 };

/** The frame of the eye `eye` looking at (ax, ay, az) into `_f`, `_r` and `_u`; false when it looks straight up or down. */
function look(eye: Vec3, ax: number, ay: number, az: number): boolean {
  const len = hypot3(ax - eye.x, ay - eye.y, az - eye.z);
  _f.x = (ax - eye.x) / len;
  _f.y = (ay - eye.y) / len;
  _f.z = (az - eye.z) / len;
  const flat = hypot2(_f.x, _f.z);
  if (flat < 1e-6) return false;
  // Right = forward x up, flat; up = right x forward.
  _r.x = -_f.z / flat;
  _r.z = _f.x / flat;
  _u.x = -_r.z * _f.y;
  _u.y = _r.z * _f.x - _r.x * _f.z;
  _u.z = _r.x * _f.y;
  return true;
}

/**
 * The least tan(half fov) at which `p` lies within `CONTEXT.fit` of the middle of the frame (`CONTEXT.aspect` wide) of the eye
 * `eye` looking along `f` (unit), with `r` its right (flat, unit) and `u` its up; Infinity when `p` is nearer than 4 m or behind it.
 */
function tanNeeded(p: Vec3, eye: Vec3, f: Vec3, r: Vec3, u: Vec3): number {
  const vx = p.x - eye.x;
  const vy = p.y - eye.y;
  const vz = p.z - eye.z;
  const z = vx * f.x + vy * f.y + vz * f.z;
  if (z < 4) return Infinity;
  const x = Math.abs(vx * r.x + vz * r.z) / (CONTEXT.fit * CONTEXT.aspect);
  const y = Math.abs(vx * u.x + vy * u.y + vz * u.z) / CONTEXT.fit;
  return Math.max(x, y) / z;
}

/** `fov` (deg), or the least wider lens in which `p` lies in the frame of the eye `eye` looking at `aim` (`inFrame`'s test; `fov` when it never does). */
export function fovFor(eye: Vec3, aim: Vec3, p: Vec3, fov: number): number {
  if (!look(eye, aim.x, aim.y, aim.z)) return fov;
  const need = tanNeeded(p, eye, _f, _r, _u);
  return Number.isFinite(need) ? Math.max(fov, (2 * Math.atan(need) * 180) / Math.PI) : fov;
}

/** `p` lies in the frame of the eye `eye` looking at `aim` through the lens `fov` (deg) on every screen the reel plays on (`tanNeeded`). */
export function inFrame(eye: Vec3, aim: Vec3, p: Vec3, fov: number): boolean {
  return look(eye, aim.x, aim.y, aim.z) && tanNeeded(p, eye, _f, _r, _u) <= Math.tan((fov * Math.PI) / 360);
}

/**
 * An eye from which both `a` and `b` lie in frame and car-sized, looking at their midpoint, with a clear line to each over the
 * course's static solids `s`, standing in none; into `eye` and `aim`. Returns its lens (deg), 0 when none works (a wall or a
 * building in every way, or the points too far apart for any lens). The eyes are tried nearest first, each from the directions
 * starting at `turn` (rad).
 */
export function contextEye(s: Sight, a: Vec3, b: Vec3, turn: number, eye: THREE.Vector3, aim: THREE.Vector3): number {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const mz = (a.z + b.z) / 2;
  const tanMax = Math.tan((CONTEXT.fov * Math.PI) / 360);
  const line = Math.atan2(a.z - mz, a.x - mx);
  for (const [reach, up] of CONTEXT.eyes) {
    for (let k = 0; k < CONTEXT.turns + CONTEXT.line.length; k++) {
      const t = k < CONTEXT.turns ? turn + (k * 2 * Math.PI) / CONTEXT.turns : line + CONTEXT.line[k - CONTEXT.turns]!;
      const e = { x: mx + Math.cos(t) * reach!, y: my + up!, z: mz + Math.sin(t) * reach! };
      if (solid(s, e.x, e.y, e.z, 0.5)) continue;
      if (!look(e, mx, my, mz)) continue;
      // The widest lens that keeps both points a car's size is the eye's; both must fit inside it.
      const tanH = Math.min(tanMax, CONTEXT.reach / Math.max(hypot3(a.x - e.x, a.y - e.y, a.z - e.z), hypot3(b.x - e.x, b.y - e.y, b.z - e.z)));
      if (Math.max(tanNeeded(a, e, _f, _r, _u), tanNeeded(b, e, _f, _r, _u)) > tanH) continue;
      if (sightLine(s, e.x, e.y, e.z, a.x, a.y, a.z) < 0 || sightLine(s, e.x, e.y, e.z, b.x, b.y, b.z) < 0) continue;
      eye.set(e.x, e.y, e.z);
      aim.set(mx, my, mz);
      return (2 * Math.atan(tanH) * 180) / Math.PI;
    }
  }
  return 0;
}

/** The context shot's camera: `eye` looking at `aim` through the lens `fov` (deg) that `contextEye` fitted. */
export function contextPose(camera: THREE.PerspectiveCamera, eye: THREE.Vector3, aim: THREE.Vector3, fov: number): void {
  camera.position.copy(eye);
  camera.lookAt(aim);
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}
