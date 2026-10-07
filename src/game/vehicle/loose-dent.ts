import * as THREE from "three";
import { computeNormalsFast } from "../deform/fast-normals.ts";

/**
 * Cosmetic dents on a torn part: every bounce that changes its velocity this much pushes the skin around
 * the contact point inward. The hit is recorded in the part's frame (a pure function of the loose body's
 * state, so a replay dents identically); carving it is separate (`applyDents`), so a car nobody is looking
 * at can skip the work and catch up later. Never feeds the sim.
 */

/** Dents per part; later bounces leave it as it is. */
export const DENT_MAX = 4;
/** A bounce changes the part's velocity by at least this (m/s) to dent it. */
export const DENT_MIN_DV = 1.8;
/** Dent depth per m/s of velocity change, and its ceiling (m). */
const DENT_PER_MPS = 0.012;
const DENT_DEPTH = 0.05;
/** Skin within this of the contact point moves (m). */
const DENT_REACH = 0.26;
/** No vertex ends up farther than this from where it started (m). */
const DENT_CAP = 0.08;

export interface DentState {
  /** Per recorded bounce: unit normal xyz in the part's frame (away from what it hit), then the depth (m). */
  hits: Float32Array;
  count: number;
  applied: number;
  /** The part's meshes and their positions before the first dent. */
  meshes: THREE.Mesh[] | null;
  rest: Float32Array[] | null;
}

export function newDentState(): DentState {
  return { hits: new Float32Array(DENT_MAX * 4), count: 0, applied: 0, meshes: null, rest: null };
}

const _n = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** A bounce that changed `object`'s velocity by `dv` (world m/s): record it unless it was too soft or the part has had its share. */
export function recordDent(d: DentState, object: THREE.Object3D, dv: THREE.Vector3): void {
  const speed = dv.length();
  if (speed < DENT_MIN_DV || d.count >= DENT_MAX) return;
  _n.copy(dv).divideScalar(speed).applyQuaternion(_q.copy(object.quaternion).invert());
  const o = d.count++ * 4;
  d.hits[o] = _n.x;
  d.hits[o + 1] = _n.y;
  d.hits[o + 2] = _n.z;
  d.hits[o + 3] = Math.min(DENT_DEPTH, speed * DENT_PER_MPS);
}

/** Carve every recorded dent not yet on the mesh. */
export function applyDents(d: DentState, object: THREE.Object3D): void {
  if (d.applied === d.count) return;
  if (!d.meshes) {
    d.meshes = [];
    object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) d.meshes!.push(m);
    });
    d.rest = d.meshes.map((m) => Float32Array.from((m.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array));
  }
  while (d.applied < d.count) carve(d, object, d.applied++ * 4);
}

/** Put the skin back as it was before the first dent. */
export function clearDents(d: DentState): void {
  if (d.meshes) {
    for (const [k, m] of d.meshes.entries()) {
      const attr = m.geometry.getAttribute("position") as THREE.BufferAttribute;
      (attr.array as Float32Array).set(d.rest![k]!);
      attr.needsUpdate = true;
      computeNormalsFast(m.geometry);
    }
  }
  d.count = d.applied = 0;
  d.meshes = d.rest = null;
}

/** A child mesh sits at its own offset in the part's frame; the part's own mesh is the frame (`off` below). */

function carve(d: DentState, object: THREE.Object3D, o: number): void {
  const nx = d.hits[o]!;
  const ny = d.hits[o + 1]!;
  const nz = d.hits[o + 2]!;
  const depth = d.hits[o + 3]!;
  // The contact point: the vertex furthest against the normal.
  let best = Infinity;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const m of d.meshes!) {
    const a = (m.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const off = m === object ? _zero : m.position;
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i]! + off.x;
      const y = a[i + 1]! + off.y;
      const z = a[i + 2]! + off.z;
      const along = x * nx + y * ny + z * nz;
      if (along < best) [best, cx, cy, cz] = [along, x, y, z];
    }
  }
  const meshes = d.meshes!;
  for (let k = 0; k < meshes.length; k++) {
    const m = meshes[k]!;
    const attr = m.geometry.getAttribute("position") as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    const rest = d.rest![k]!;
    const off = m === object ? _zero : m.position;
    for (let i = 0; i < a.length; i += 3) {
      const r = Math.hypot(a[i]! + off.x - cx, a[i + 1]! + off.y - cy, a[i + 2]! + off.z - cz);
      if (r >= DENT_REACH) continue;
      const push = depth * (1 - r / DENT_REACH) ** 2;
      let x = a[i]! + nx * push;
      let y = a[i + 1]! + ny * push;
      let z = a[i + 2]! + nz * push;
      const moved = Math.hypot(x - rest[i]!, y - rest[i + 1]!, z - rest[i + 2]!);
      if (moved > DENT_CAP) {
        const k2 = DENT_CAP / moved;
        x = rest[i]! + (x - rest[i]!) * k2;
        y = rest[i + 1]! + (y - rest[i + 1]!) * k2;
        z = rest[i + 2]! + (z - rest[i + 2]!) * k2;
      }
      a[i] = x;
      a[i + 1] = y;
      a[i + 2] = z;
    }
    attr.needsUpdate = true;
    computeNormalsFast(m.geometry);
  }
}
