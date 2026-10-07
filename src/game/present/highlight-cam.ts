import { hypot2 } from "../kernel/physics-core.js";
import type * as THREE from "three";

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
