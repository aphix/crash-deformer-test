import { hypot3 } from "../kernel/physics-core.js";
import * as THREE from "three";
import type { RigidBody } from "@dimforge/rapier3d-simd";

/**
 * The thrown dummy's body (`RagdollSystem` builds and steps it): its parts and joints, its damping, and the only
 * velocity edits it makes, which take energy out and never add any.
 */

/**
 * Dummy parts standing (feet at y = 0): centre, half extents (m). Torso first: the throw places it.
 * A 1.62 m crash-test dummy, about 100 kg at water's density.
 */
export const PARTS = [
  { c: [0, 1.11, 0], h: [0.18, 0.27, 0.11] },
  { c: [0, 1.63, 0], h: [0.1, 0.11, 0.11] },
  { c: [-0.24, 1.21, 0], h: [0.05, 0.14, 0.05] },
  { c: [-0.24, 0.93, 0], h: [0.05, 0.14, 0.05] },
  { c: [0.24, 1.21, 0], h: [0.05, 0.14, 0.05] },
  { c: [0.24, 0.93, 0], h: [0.05, 0.14, 0.05] },
  { c: [-0.09, 0.63, 0], h: [0.075, 0.21, 0.075] },
  { c: [-0.09, 0.21, 0], h: [0.075, 0.21, 0.075] },
  { c: [0.09, 0.63, 0], h: [0.075, 0.21, 0.075] },
  { c: [0.09, 0.21, 0], h: [0.075, 0.21, 0.075] },
] as const;
/** Each part's mass (kg, water's density) and largest principal inertia (kg m²): `isCalm`'s kinetic energy. */
const MASS = PARTS.map((p) => 8000 * p.h[0] * p.h[1] * p.h[2]);
const INERTIA = PARTS.map((p, k) => {
  const [a, b] = [p.h[0] ** 2, p.h[1] ** 2, p.h[2] ** 2].sort((x, y) => y - x);
  return (MASS[k]! * (a! + b!)) / 3;
});
/** Arms (parts 2–5) start raised over the head: the superman dive out of the car. */
export const ARM = (k: number) => k >= 2 && k <= 5;
export const SHOULDER_Y = 1.35;
/** Spherical joints: parent, child, the joint point standing. Neck, shoulders, elbows, hips, knees. */
export const JOINTS = [
  [0, 1, 0, 1.39, 0],
  [0, 2, -0.24, SHOULDER_Y, 0],
  [2, 3, -0.24, 1.07, 0],
  [0, 4, 0.24, SHOULDER_Y, 0],
  [4, 5, 0.24, 1.07, 0],
  [0, 6, -0.09, 0.84, 0],
  [6, 7, -0.09, 0.42, 0],
  [0, 8, 0.09, 0.84, 0],
  [8, 9, 0.09, 0.42, 0],
] as const;

/** Dummy damping (per s) in the air, and from his first touch of the ground on: he lies down and stays down. */
export const AIR_LINEAR = 0.05;
export const AIR_ANGULAR = 0.8;
export const GROUND_LINEAR = 2.5;
export const GROUND_ANGULAR = 6;
/**
 * Once he lies on the ground and his torso has been under `REST_SPEED` for `SETTLE_AFTER` sim seconds, every part is
 * damped this hard (per s): a limb still flopping over settles in a few tenths of a second instead of creeping on
 * (range probe, jittered 240 Hz run: a leg moving at 0.9 m/s 3 s after his first ground contact).
 */
export const SETTLE_AFTER = 0.25;
export const SETTLE_LINEAR = 10;
export const SETTLE_ANGULAR = 10;
/**
 * Fleshy, not a rigid toy (owner, 2026-10-03): skin is a crumple zone. A hit on a part (`hits` in engine-ragdoll.ts, once per hit) sheds `1 − KEEP`
 * of the motion across each joint of that part, linear and spin (`give`), and no part turns about its joint faster
 * than `JOINT_SPIN` rad/s (`limit`: Rapier's spherical joints take no limit in JS; a limb whips at hundreds of rad/s
 * when it hits at 30 m/s). Both go through equal and opposite impulses between the two parts, so energy only leaves,
 * whatever the velocities (the old per-frame edits set absolute velocities and could add it).
 */
const KEEP = 0.5;
const JOINT_SPIN = 12;
/**
 * Asleep once the whole dummy's kinetic energy has stayed under `CALM_ENERGY` (J: 100 kg at 0.4 m/s) for `CALM_FOR`
 * sim seconds. Rapier's own thresholds cannot be set from JS, and a head rocking on its edge at 10 rad/s (4–6 J) kept
 * the old per-part speed rule awake for 2 s after he lay still (range probe, jittered 240 Hz run).
 */
const CALM_ENERGY = 8;
export const CALM_FOR = 0.5;

const _v = { x: 0, y: 0, z: 0 };
const _w = { x: 0, y: 0, z: 0 };
/** `limit`'s spins, 3 per part: each part read once (a Rapier getter allocates), again only after a shed changed it. */
const SPIN = new Float64Array(PARTS.length * 3);

function readSpin(bodies: readonly RigidBody[], k: number): void {
  const w = bodies[k]!.angvel();
  SPIN[3 * k] = w.x;
  SPIN[3 * k + 1] = w.y;
  SPIN[3 * k + 2] = w.z;
}

/** Part `k` of the dummy `bodies` was just hit: the skin gives at each joint of it. */
export function give(bodies: readonly RigidBody[], k: number): void {
  for (const [a, b] of JOINTS) if (a === k || b === k) shed(bodies[a]!, bodies[b]!, 1 - KEEP, 1 - KEEP);
}

/** Holds every joint of the dummy `bodies` to `JOINT_SPIN` rad/s of relative spin. */
export function limit(bodies: readonly RigidBody[]): void {
  for (let k = 0; k < PARTS.length; k++) readSpin(bodies, k);
  for (let j = 0; j < JOINTS.length; j++) {
    const a = 3 * JOINTS[j]![0];
    const b = 3 * JOINTS[j]![1];
    const spin = hypot3(SPIN[a]! - SPIN[b]!, SPIN[a + 1]! - SPIN[b + 1]!, SPIN[a + 2]! - SPIN[b + 2]!);
    if (spin <= JOINT_SPIN) continue;
    shed(bodies[JOINTS[j]![0]]!, bodies[JOINTS[j]![1]]!, 0, 1 - JOINT_SPIN / spin);
    readSpin(bodies, JOINTS[j]![0]);
    readSpin(bodies, JOINTS[j]![1]);
  }
}

/** Is the whole dummy's kinetic energy under `CALM_ENERGY`? */
export function isCalm(bodies: readonly RigidBody[]): boolean {
  let energy = 0;
  for (let k = 0; energy < CALM_ENERGY && k < PARTS.length; k++) {
    const v = bodies[k]!.linvel();
    const w = bodies[k]!.angvel();
    energy += 0.5 * MASS[k]! * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * INERTIA[k]! * (w.x * w.x + w.y * w.y + w.z * w.z);
  }
  return energy < CALM_ENERGY;
}

/**
 * Shed the fractions `lin` and `spin` (0–1) of part `b`'s motion relative to its parent `a`: equal and opposite
 * impulses at the centres, so momentum stays and kinetic energy only drops. Linear: μ(1 − (1 − lin)²)|Δv|²/2 leaves (μ
 * the reduced mass). Spin: the impulse is scaled by the smaller inertias' reduced inertia, under which the energy
 * change stays negative.
 */
export function shed(a: RigidBody, b: RigidBody, lin: number, spin: number): void {
  if (lin > 0) {
    const va = a.linvel();
    const vb = b.linvel();
    const ma = a.mass();
    const mb = b.mass();
    const j = (lin * ma * mb) / (ma + mb);
    _v.x = (va.x - vb.x) * j;
    _v.y = (va.y - vb.y) * j;
    _v.z = (va.z - vb.z) * j;
    b.applyImpulse(_v, false);
    _w.x = -_v.x;
    _w.y = -_v.y;
    _w.z = -_v.z;
    a.applyImpulse(_w, false);
  }
  if (spin <= 0) return;
  const wa = a.angvel();
  const wb = b.angvel();
  const ia = a.principalInertia();
  const ib = b.principalInertia();
  const s = spin / (1 / Math.min(ia.x, ia.y, ia.z) + 1 / Math.min(ib.x, ib.y, ib.z));
  _v.x = (wa.x - wb.x) * s;
  _v.y = (wa.y - wb.y) * s;
  _v.z = (wa.z - wb.z) * s;
  b.applyTorqueImpulse(_v, false);
  _w.x = -_v.x;
  _w.y = -_v.y;
  _w.z = -_v.z;
  a.applyTorqueImpulse(_w, false);
}

const _qb = new THREE.Quaternion();

/** `body`'s pose into `into` at `o`: position xyz, rotation xyzw (what the dummies, purses and props capture after a step). */
export function readPose(body: RigidBody, into: Float32Array, o: number): void {
  const t = body.translation();
  const r = body.rotation();
  into[o] = t.x;
  into[o + 1] = t.y;
  into[o + 2] = t.z;
  into[o + 3] = r.x;
  into[o + 4] = r.y;
  into[o + 5] = r.z;
  into[o + 6] = r.w;
}

/** The pose `alpha` (0–1) of the way from the one at `o` in `a` to the one at `o` in `c` (position lerped, rotation slerped) into `p` and `q`: a body drawn between its last two steps. */
export function blendPose(a: Float32Array, c: Float32Array, o: number, alpha: number, p: THREE.Vector3, q: THREE.Quaternion): void {
  p.set(a[o]! + (c[o]! - a[o]!) * alpha, a[o + 1]! + (c[o + 1]! - a[o + 1]!) * alpha, a[o + 2]! + (c[o + 2]! - a[o + 2]!) * alpha);
  q.set(a[o + 3]!, a[o + 4]!, a[o + 5]!, a[o + 6]!).slerp(_qb.set(c[o + 3]!, c[o + 4]!, c[o + 5]!, c[o + 6]!), alpha);
}
