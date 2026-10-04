import * as THREE from "three";
import { PARTS } from "./ragdoll-body.ts";

/** A dummy part as Rapier hands it out. */
export type Part = { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } };

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const AX = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
const BX = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
const _axis = new THREE.Vector3();

/** Part `k`'s orientation. */
const rot = (b: Part, out: THREE.Quaternion): THREE.Quaternion => out.set(b.rotation().x, b.rotation().y, b.rotation().z, b.rotation().w);

/** Penetration depth (m) of parts `i` and `j` of `bodies`: the smallest overlap over the 15 separating axes of two oriented boxes, 0 when apart. */
export function depth(bodies: readonly Part[], i: number, j: number): number {
  const hi = PARTS[i]!.h;
  const hj = PARTS[j]!.h;
  const ti = bodies[i]!.translation();
  const tj = bodies[j]!.translation();
  _d.set(tj.x - ti.x, tj.y - ti.y, tj.z - ti.z);
  rot(bodies[i]!, _qa);
  rot(bodies[j]!, _qb);
  for (let a = 0; a < 3; a++) {
    AX[a]!.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).applyQuaternion(_qa);
    BX[a]!.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).applyQuaternion(_qb);
  }
  let least = Infinity;
  const test = (axis: THREE.Vector3): boolean => {
    const len = axis.length();
    if (len < 1e-6) return true;
    axis.divideScalar(len);
    let ra = 0;
    let rb = 0;
    for (let a = 0; a < 3; a++) {
      ra += hi[a]! * Math.abs(axis.dot(AX[a]!));
      rb += hj[a]! * Math.abs(axis.dot(BX[a]!));
    }
    const over = ra + rb - Math.abs(axis.dot(_d));
    least = Math.min(least, over);
    return over > 0;
  };
  for (let a = 0; a < 3; a++) if (!test(_axis.copy(AX[a]!)) || !test(_axis.copy(BX[a]!))) return 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (!test(_axis.copy(AX[a]!).cross(BX[b]!))) return 0;
  return least;
}

/** Hinge angle (rad) of limb part `c` about its parent `p`'s x axis: 0 hanging straight, positive swinging the limb toward −z (back). */
export function hinge(bodies: readonly Part[], p: number, c: number): number {
  _u.set(0, -1, 0).applyQuaternion(rot(bodies[c]!, _qb)).applyQuaternion(rot(bodies[p]!, _qa).invert());
  return Math.atan2(-_u.z, -_u.y);
}

/** The angle (rad) between part `c`'s local `axis` and part `p`'s `about` direction. */
export function cone(bodies: readonly Part[], p: number, c: number, axis: THREE.Vector3, about: THREE.Vector3): number {
  _u.copy(axis).applyQuaternion(rot(bodies[c]!, _qb)).applyQuaternion(rot(bodies[p]!, _qa).invert());
  return _u.angleTo(about);
}

/** Twist (rad, signed) of part `c` about its own y axis relative to its parent `p`. */
export function twist(bodies: readonly Part[], p: number, c: number): number {
  rot(bodies[p]!, _qa).invert().multiply(rot(bodies[c]!, _qb));
  const t = 2 * Math.atan2(_qa.y, _qa.w);
  return t > Math.PI ? t - 2 * Math.PI : t < -Math.PI ? t + 2 * Math.PI : t;
}

export const POSE_KEYS = ["swing", "twist", "headChest", "elbow", "knee", "limbTorso", "shoulder", "hip"] as const;
export type Pose = Record<(typeof POSE_KEYS)[number], number>;

const OUT = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)] as const;
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * How far out of anatomy the dummy `bodies` is (degrees, metres for depths): neck `swing` and `twist` (head's up vs
 * chest's up, head's twist about its own axis), head–chest box depth `headChest`, `elbow` and `knee` hyperextension
 * (swung the wrong way past straight), deepest `limbTorso` box overlap of an upper arm or thigh with the chest,
 * and the worst `shoulder` angle off the outward axis and `hip` angle off straight down.
 */
export function pose(bodies: readonly Part[]): Pose {
  const deg = 180 / Math.PI;
  const elbow = Math.max(hinge(bodies, 2, 3), hinge(bodies, 4, 5));
  const knee = Math.max(-hinge(bodies, 6, 7), -hinge(bodies, 8, 9));
  return {
    swing: cone(bodies, 0, 1, UP, UP) * deg,
    twist: Math.abs(twist(bodies, 0, 1)) * deg,
    headChest: depth(bodies, 0, 1),
    elbow: elbow * deg,
    knee: knee * deg,
    limbTorso: Math.max(depth(bodies, 0, 2), depth(bodies, 0, 4), depth(bodies, 0, 6), depth(bodies, 0, 8)),
    shoulder: Math.max(cone(bodies, 0, 2, DOWN, OUT[0]), cone(bodies, 0, 4, DOWN, OUT[1])) * deg,
    hip: Math.max(cone(bodies, 0, 6, DOWN, DOWN), cone(bodies, 0, 8, DOWN, DOWN)) * deg,
  };
}

/** A deterministic stream in [0, 1). */
export function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export type Shot = { p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; w: THREE.Vector3 };

/**
 * `n` throws: speeds 4–30 m/s in every heading, 0.5–2.5 m up, flung up or down by up to 35°, spinning up to 14 rad/s;
 * half leave in the car's head-first dive (80° from upright, arms raised), half in a random orientation.
 */
export function throwSet(n: number, seed: number): Shot[] {
  const r = stream(seed);
  const shots: Shot[] = [];
  for (let i = 0; i < n; i++) {
    const yaw = r() * 2 * Math.PI;
    const speed = 4 + r() * 26;
    const lift = (r() - 0.4) * 0.6;
    const v = new THREE.Vector3(Math.cos(yaw) * speed * Math.cos(lift), speed * Math.sin(lift), Math.sin(yaw) * speed * Math.cos(lift));
    const q = new THREE.Quaternion();
    if (i % 2 === 0) q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw + Math.PI / 2).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (80 * Math.PI) / 180));
    else q.set(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    const w = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(r() * 14);
    shots.push({ p: new THREE.Vector3((r() - 0.5) * 20, 0.5 + 2 * r(), (r() - 0.5) * 20), q, v, w });
  }
  return shots;
}

/** The running worst of every `Pose` key. */
export function worst(into: Pose, now: Pose): void {
  for (const k of POSE_KEYS) into[k] = Math.max(into[k], now[k]);
}

export const noPose = (): Pose => ({ swing: 0, twist: 0, headChest: 0, elbow: 0, knee: 0, limbTorso: 0, shoulder: 0, hip: 0 });

/** The `q`-quantile (0–1) of `xs`. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
