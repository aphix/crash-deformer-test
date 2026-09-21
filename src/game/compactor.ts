import * as THREE from "three";
import { StreamedDeformation, type DeformMode } from "./streamed-deform.ts";

/**
 * Hydraulic car-compactor: two kinematic plates, equal and opposite, square
 * to the car's length. Faces start just past the bumpers, close to the wheel
 * wells, then past the hub midpoint into the cage.
 *
 * Hub rest |z| = 1.34, bumper |z| = 2.06.
 */
export const COMPACTOR = {
  bumperZ: 2.06,
  hubZ: 1.34,
  /** Just beyond the visible bumper. */
  startFace: 2.22,
  /** Plates at the wheel-well lip (hub + tyre). */
  wellFace: 1.5,
  /** Hub centre-line — "wheel midpoint". */
  midFace: 1.34,
  /** Past the rails (0.68) into the passenger cell. */
  maxFace: 0.62,
  /** m/s each plate travels inward. */
  speed: 0.55,
} as const;

export type CompactorStage = "open" | "contact" | "wells" | "mid" | "max";

export function compactorStage(face: number): CompactorStage {
  if (face >= COMPACTOR.startFace - 0.02) return "open";
  if (face > COMPACTOR.wellFace) return "contact";
  if (face > COMPACTOR.midFace) return "wells";
  if (face > COMPACTOR.maxFace + 0.02) return "mid";
  return "max";
}

export type WallHit = { frontJ: number; rearJ: number; hits: number };

/** Project any mass that crossed a plate back onto it and kill outbound speed. */
export function enforceWalls(d: StreamedDeformation, zFace: number, dt = 1 / 60): WallHit {
  let frontJ = 0;
  let rearJ = 0;
  let hits = 0;
  const face = Math.abs(zFace);
  const invDt = 1 / Math.max(dt, 1 / 240);
  for (const m of d.masses) {
    if (!m.dynamic) continue;
    const r = m.radius * 0.72;
    if (m.world.z + r > face) {
      const overlap = m.world.z + r - face;
      m.world.z -= overlap;
      const vn = m.vel.z;
      if (vn > 0) m.vel.z = 0;
      // Wall is kinematic: impulse is outbound momentum plus the plate advancing into the mass.
      frontJ += m.mass * (Math.max(0, vn) + overlap * invDt);
      hits++;
    }
    if (m.world.z - r < -face) {
      const overlap = -face - (m.world.z - r);
      m.world.z += overlap;
      const vn = m.vel.z;
      if (vn < 0) m.vel.z = 0;
      rearJ += m.mass * (Math.max(0, -vn) + overlap * invDt);
      hits++;
    }
  }
  return { frontJ, rearJ, hits };
}

export class CompactorRig {
  readonly d: StreamedDeformation;
  readonly group: THREE.Group;
  readonly vel: THREE.Vector3;
  readonly omega: THREE.Vector3;
  readonly geom: THREE.BufferGeometry;
  face: number = COMPACTOR.startFace;
  frontJ = 0;
  rearJ = 0;
  maxGroupY = 0;
  maxCellY = 0;
  contacted = false;

  constructor(mode: DeformMode = "lattice") {
    this.geom = new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6);
    this.d = new StreamedDeformation(this.geom);
    this.d.mode = mode;
    this.d.squash = 0.4;
    this.d.buckle = 0.45;
    this.group = new THREE.Group();
    this.group.position.set(0, 0, 0);
    this.group.rotation.set(0, 0, 0);
    this.group.updateMatrixWorld();
    this.vel = new THREE.Vector3();
    this.omega = new THREE.Vector3();
    this.d.bindKinematic(this.group, this.vel, this.omega);
  }

  get stage(): CompactorStage {
    return compactorStage(this.face);
  }

  step(dt: number, targetFace: number = COMPACTOR.maxFace): WallHit {
    this.face = Math.max(targetFace, this.face - COMPACTOR.speed * dt);
    if (!this.d.massActive && this.face < COMPACTOR.bumperZ + 0.12) {
      this.d.beginCrush(
        new THREE.Vector3(0, 0.36, 2.06),
        new THREE.Vector3(0, 0, -1),
        18,
        this.group,
        this.vel,
        this.omega,
      );
      this.contacted = true;
    }
    this.d.bidirectional = true;
    this.d.deepCrush = this.face < COMPACTOR.midFace;
    this.d.notifyContact();
    const hit = enforceWalls(this.d, this.face, dt);
    this.frontJ += hit.frontJ;
    this.rearJ += hit.rearJ;
    this.d.stepStructure(dt);
    enforceWalls(this.d, this.face, dt);
    this.d.followGroup(this.group, this.vel, this.omega, dt);
    this.d.update(dt, this.geom);
    this.maxGroupY = Math.max(this.maxGroupY, this.group.position.y);
    const cell = this.d.masses.find((m) => m.name === "cell");
    if (cell) this.maxCellY = Math.max(this.maxCellY, cell.world.y);
    return hit;
  }

  runTo(targetFace: number, dt = 1 / 60, cap = 2400): number {
    let n = 0;
    while (this.face > targetFace + 1e-4 && n < cap) {
      this.step(dt, targetFace);
      n++;
    }
    return n;
  }
}

export function travelOf(d: StreamedDeformation, name: string): number {
  const m = d.masses.find((n) => n.name === name);
  if (!m) return 0;
  return m.local.distanceTo(m.rest);
}
