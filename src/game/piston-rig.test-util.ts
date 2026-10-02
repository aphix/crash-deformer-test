import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { PISTON, PISTON_IDS, PistonHead, PistonRig, type PistonConfig, type PistonId } from "./piston-rig.ts";
import type { MassNode } from "./deform-rig.ts";

/** Piston shot harness for the piston, skin and contact-parity suites: fire one shot, measure it. Not a test file itself. */

/**
 * Plan-view rigid fit (rotation about y + translation, mean height) of the masses `keep` selects. The returned
 * map takes a car-frame point into the fitted rest frame; it reuses one vector between calls.
 */
export function fitRigid(masses: readonly MassNode[], keep: (m: MassNode) => boolean): (x: number, y: number, z: number) => THREE.Vector3 {
  let px = 0;
  let pz = 0;
  let qx = 0;
  let qz = 0;
  let dy = 0;
  let count = 0;
  for (const m of masses) {
    if (!keep(m)) continue;
    px += m.local.x;
    pz += m.local.z;
    qx += m.rest.x;
    qz += m.rest.z;
    dy += m.local.y - m.rest.y;
    count++;
  }
  px /= count;
  pz /= count;
  qx /= count;
  qz /= count;
  dy /= count;
  let dot = 0;
  let cross = 0;
  for (const m of masses) {
    if (!keep(m)) continue;
    const ax = m.local.x - px;
    const az = m.local.z - pz;
    const bx = m.rest.x - qx;
    const bz = m.rest.z - qz;
    dot += ax * bx + az * bz;
    cross += bz * ax - bx * az;
  }
  const theta = Math.atan2(cross, dot);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const fitted = new THREE.Vector3();
  return (x, y, z) => fitted.set(c * (x - px) - s * (z - pz) + qx, y - dy, s * (x - px) + c * (z - pz) + qz);
}

/** Particles each piston is aimed at (the rig has no rear wing particle). */
export const PISTON_STRUCK: Readonly<Record<PistonId, readonly string[]>> = {
  frontLeft: ["bumperFL", "wingFL"],
  front: ["bumperFL", "bumperFR"],
  frontRight: ["bumperFR", "wingFR"],
  right: ["doorR"],
  rearRight: ["bumperRR"],
  rear: ["bumperRL", "bumperRR"],
  rearLeft: ["bumperRL"],
  left: ["doorL"],
};

/** Rest distance (m, plan view) from the struck paint beyond which nothing should move. */
export const PISTON_FAR = 1.2;
/** Paint within this distance (m) of the struck point counts as the dent. */
export const PISTON_DENT_RADIUS = 0.3;
/** Paint within this plan distance (m) of a hub is the wheel arch, reported apart from the panels. */
export const PISTON_ARCH = 0.5;

export type PistonShot = Partial<PistonConfig> & {
  /** Sim seconds to keep running after first contact (default 1.5). */
  after?: number;
};

export type PistonShotResult = {
  id: PistonId;
  contacted: boolean;
  /** Head speed at first touch (m/s). */
  closing: number;
  /** Equivalent barrier speed handed to `applyImpact` (m/s). */
  ebs: number;
  /** Crush energy the car takes (J). */
  energy: number;
  /** Inward travel along the hit (m) of every particle, rigid motion removed. */
  inward: Record<string, number>;
  /** `PISTON_STRUCK[id]` with their inward travel (m). */
  struck: { name: string; inward: number }[];
  /** Mean inward travel of the paint within `PISTON_DENT_RADIUS` of the struck point (m). */
  skinInward: number;
  /**
   * Largest residual (m) of a body particle (hubs excluded: they are the
   * wheels, reported in `farHub`) / skin vertex more than `PISTON_FAR` from
   * the struck point.
   */
  farParticle: number;
  farParticleName: string;
  farHub: number;
  /** Every far skin vertex, and the far ones outside `PISTON_ARCH` of a hub (body panels). */
  farSkin: number;
  farBodySkin: number;
  /** Body particles / panel vertices on the half of the car beyond its centre along the hit. */
  oppositeParticle: number;
  oppositeBodySkin: number;
  /** Door (toward the cell) and roof (down onto it) intrusion (m). */
  doorL: number;
  doorR: number;
  roof: number;
  drivetrainAlive: boolean;
  /** Plan-view travel of the car origin (m): the shove. */
  shove: number;
  /** Honeycomb crushed (m). */
  faceSet: number;
  /** Particle names, rest and fitted (rigid motion removed) car-frame xyz, in `deform.masses` order. */
  names: string[];
  particleRest: Float32Array;
  particles: Float32Array;
  /** Skin vertex rest and fitted car-frame xyz. */
  skinRest: Float32Array;
  skin: Float32Array;
  /** Struck paint point at rest (car frame, plan view). */
  strike: { x: number; z: number };
};

export type PistonLocality = {
  /** Largest extra travel (m) over the tap of a body particle beyond `PISTON_FAR`. */
  farParticle: number;
  farParticleName: string;
  /** Largest extra travel (m) over the tap of a skin vertex beyond `PISTON_FAR`. */
  farSkin: number;
  /** Same over the half of the car beyond its centre along the hit. */
  oppositeParticle: number;
  oppositeSkin: number;
  /** Mean extra inward travel (m) over the tap of the paint within `PISTON_DENT_RADIUS` of the struck point. */
  dent: number;
};

/**
 * Damage the shot's energy caused, as the difference from a near-zero-energy
 * tap of the same piston: arming the crash already sags the particles and
 * moves the skin (see docs/PISTON_RIG.md), and that is not the hit's doing.
 */
export function pistonLocality(shot: PistonShotResult, tap: PistonShotResult): PistonLocality {
  const head = new PistonHead(shot.id, PISTON_IDS.indexOf(shot.id));
  const nx = head.nx;
  const nz = head.nz;
  const sx = shot.strike.x;
  const sz = shot.strike.z;
  const out: PistonLocality = { farParticle: 0, farParticleName: "", farSkin: 0, oppositeParticle: 0, oppositeSkin: 0, dent: 0 };
  for (let i = 0; i < shot.names.length; i++) {
    if (shot.names[i]!.startsWith("hub")) continue;
    const k = i * 3;
    const rx = shot.particleRest[k]!;
    const rz = shot.particleRest[k + 2]!;
    const e = Math.hypot(shot.particles[k]! - tap.particles[k]!, shot.particles[k + 1]! - tap.particles[k + 1]!, shot.particles[k + 2]! - tap.particles[k + 2]!);
    if (Math.hypot(rx - sx, rz - sz) > PISTON_FAR && e > out.farParticle) {
      out.farParticle = e;
      out.farParticleName = shot.names[i]!;
    }
    if (rx * nx + rz * nz > 0) out.oppositeParticle = Math.max(out.oppositeParticle, e);
  }
  let dentN = 0;
  for (let k = 0; k < shot.skinRest.length; k += 3) {
    const rx = shot.skinRest[k]!;
    const ry = shot.skinRest[k + 1]!;
    const rz = shot.skinRest[k + 2]!;
    const ex = shot.skin[k]! - tap.skin[k]!;
    const ez = shot.skin[k + 2]! - tap.skin[k + 2]!;
    const e = Math.hypot(ex, shot.skin[k + 1]! - tap.skin[k + 1]!, ez);
    if (Math.hypot(rx - sx, rz - sz) > PISTON_FAR) out.farSkin = Math.max(out.farSkin, e);
    if (rx * nx + rz * nz > 0) out.oppositeSkin = Math.max(out.oppositeSkin, e);
    if (Math.hypot(rx - sx, ry - PISTON.faceY, rz - sz) < PISTON_DENT_RADIUS) {
      out.dent += ex * nx + ez * nz;
      dentN++;
    }
  }
  if (dentN > 0) out.dent /= dentN;
  return out;
}

/**
 * Park `car` at the origin, fire one piston with `shot`, run the engine's
 * frame order (2 slices of a 1/60 s frame, cutDrive, one skin update per frame)
 * until `after` seconds past first contact, and measure the damage in the car
 * frame with the rigid motion fitted out on the particles beyond `PISTON_FAR`.
 */
export function firePiston(car: DeformableCar, id: PistonId, shot: PistonShot = {}): PistonShotResult {
  const rig = new PistonRig(shot);
  car.spawnFacing(0, 0, 0, 0);
  rig.attach(car);
  const geo = car.body.geometry;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const rest = Float32Array.from(pos.array as Float32Array);
  const head = rig.head(id);
  rig.fire(id);
  const frame = 1 / 60;
  const after = shot.after ?? 1.5;
  let since = 0;
  for (let f = 0; f < 60 * 20; f++) {
    for (let s = 0; s < 2; s++) {
      rig.step(frame / 2);
      car.afterContacts(frame / 2);
      if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(frame / 2);
    }
    car.updateDeform(frame);
    if (head.contacted) since += frame;
    if (since >= after || (!head.contacted && head.phase === "idle")) break;
  }
  return measureShot(car, rig, id, rest);
}

function measureShot(car: DeformableCar, rig: PistonRig, id: PistonId, rest: Float32Array): PistonShotResult {
  const head = rig.head(id);
  const d = car.deform;
  const nx = head.nx;
  const nz = head.nz;
  const sx = head.ax + nx * head.skinS;
  const sz = head.az + nz * head.skinS;
  const far = (x: number, z: number) => Math.hypot(x - sx, z - sz) > PISTON_FAR;
  const opposite = (x: number, z: number) => x * nx + z * nz > 0;

  const fit = fitRigid(d.masses, (m) => !m.hub && far(m.rest.x, m.rest.z));

  const inward: Record<string, number> = {};
  const names: string[] = [];
  const particleRest = new Float32Array(d.masses.length * 3);
  const particles = new Float32Array(d.masses.length * 3);
  let farParticle = 0;
  let farParticleName = "";
  let farHub = 0;
  let oppositeParticle = 0;
  for (let i = 0; i < d.masses.length; i++) {
    const m = d.masses[i]!;
    const f = fit(m.local.x, m.local.y, m.local.z);
    names.push(m.name);
    m.rest.toArray(particleRest, i * 3);
    f.toArray(particles, i * 3);
    inward[m.name] = (f.x - m.rest.x) * nx + (f.z - m.rest.z) * nz;
    const res = f.distanceTo(m.rest);
    if (m.hub) {
      if (far(m.rest.x, m.rest.z)) farHub = Math.max(farHub, res);
      continue;
    }
    if (far(m.rest.x, m.rest.z) && res > farParticle) {
      farParticle = res;
      farParticleName = m.name;
    }
    if (opposite(m.rest.x, m.rest.z)) oppositeParticle = Math.max(oppositeParticle, res);
  }
  const hubs = d.masses.filter((m) => m.hub);
  const arch = (x: number, z: number) => hubs.some((m) => Math.hypot(x - m.rest.x, z - m.rest.z) < PISTON_ARCH);

  const now = (car.body.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const skin = new Float32Array(rest.length);
  let farSkin = 0;
  let farBodySkin = 0;
  let oppositeBodySkin = 0;
  let dent = 0;
  let dentN = 0;
  for (let i = 0; i < rest.length; i += 3) {
    const rx = rest[i]!;
    const ry = rest[i + 1]!;
    const rz = rest[i + 2]!;
    const f = fit(now[i]!, now[i + 1]!, now[i + 2]!);
    f.toArray(skin, i);
    const ex = f.x - rx;
    const ey = f.y - ry;
    const ez = f.z - rz;
    const res = Math.hypot(ex, ey, ez);
    const panel = !arch(rx, rz);
    if (far(rx, rz)) {
      farSkin = Math.max(farSkin, res);
      if (panel) farBodySkin = Math.max(farBodySkin, res);
    }
    if (panel && opposite(rx, rz)) oppositeBodySkin = Math.max(oppositeBodySkin, res);
    if (Math.hypot(rx - sx, ry - PISTON.faceY, rz - sz) < PISTON_DENT_RADIUS) {
      dent += ex * nx + ez * nz;
      dentN++;
    }
  }

  const local = (name: string) => d.masses.find((m) => m.name === name)!.local;
  const cell = local("cell");
  return {
    id,
    contacted: head.contacted,
    closing: head.closing,
    ebs: head.ebs,
    energy: head.energy,
    inward,
    struck: PISTON_STRUCK[id].map((name) => ({ name, inward: inward[name]! })),
    skinInward: dentN > 0 ? dent / dentN : 0,
    farParticle,
    farParticleName,
    farHub,
    farSkin,
    farBodySkin,
    oppositeParticle,
    oppositeBodySkin,
    doorL: local("doorL").x - cell.x + 0.78,
    doorR: 0.78 - (local("doorR").x - cell.x),
    roof: 0.63 - (local("roof").y - cell.y),
    drivetrainAlive: d.drivetrainAlive,
    shove: Math.hypot(car.group.position.x, car.group.position.z),
    faceSet: head.faceSet,
    names,
    particleRest,
    particles,
    skinRest: rest,
    skin,
    strike: { x: sx, z: sz },
  };
}
