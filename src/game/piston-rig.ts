import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import type { StreamedDeformation } from "./streamed-deform.ts";

type MassNode = StreamedDeformation["masses"][number];

/**
 * Eight horizontal impactors around a car parked at the origin facing +Z
 * (+X is the car's right). Key order 1–8 runs clockwise from the front-left
 * corner, seen from above.
 */
export const PISTON_IDS = ["frontLeft", "front", "frontRight", "right", "rearRight", "rear", "rearLeft", "left"] as const;
export type PistonId = (typeof PISTON_IDS)[number];

export type PistonConfig = {
  /** Impactor speed when it reaches the paint (km/h). */
  speedKph: number;
  /** Impactor mass (kg); with the speed it fixes the shot energy. */
  massKg: number;
  /**
   * Share of the crush energy the car takes: 1 is a rigid steel face, lower is
   * a crushable honeycomb block (an MDB face) that eats the rest.
   */
  hardness: number;
  /** Face width (m). Below 0.76 m a mid shot slips between the two bumper particles. */
  faceWidth: number;
  /** Face height (m). Contact with the particles is planar; height sets which paint the face meets. */
  faceHeight: number;
  /** Bolt the car down: its mean velocity is removed every step (a seismic floor); dents stay. */
  holdCar: boolean;
};

export const PISTON_DEFAULTS: Readonly<PistonConfig> = {
  speedKph: 40,
  massKg: 1500,
  hardness: 1,
  faceWidth: 1.2,
  faceHeight: 0.5,
  holdCar: false,
};

export const PISTON = {
  /** Clear air between the resting face and the paint (m); the run-up happens here. */
  restGap: 0.4,
  /** Face travel allowed past the paint before the end stop (m). */
  stroke: 0.9,
  /** m/s back to rest after the shot. */
  retractSpeed: 1.6,
  /** Steel head thickness (m); also the depth of the contact box. */
  headDepth: 0.3,
  /** Face centre height (m). */
  faceY: 0.48,
  /** Honeycomb block depth (m) at hardness 0; none on a rigid face. */
  honeycomb: 0.4,
  /** Max face travel per contact substep (m) so a fast head cannot tunnel a particle. */
  maxSubstep: 0.04,
  /** Contact lost this long (s) ends the push. */
  releaseAfter: 0.05,
} as const;

export type PistonPhase = "idle" | "accel" | "coast" | "retract";

type Axis = { ax: number; az: number; nx: number; nz: number };

const S = Math.SQRT1_2;
/**
 * Axis point and inward unit per piston (car frame at rest). Corner axes run
 * at 45° between the bumper and wing particles of that corner (0.33 m either
 * side); mid axes cross the centre of the side.
 */
const AXES: Readonly<Record<PistonId, Axis>> = {
  frontLeft: { ax: -0.945, az: 2.015, nx: S, nz: -S },
  front: { ax: 0, az: 2.1, nx: 0, nz: -1 },
  frontRight: { ax: 0.945, az: 2.015, nx: -S, nz: -S },
  right: { ax: 0.88, az: 0.08, nx: -1, nz: 0 },
  rearRight: { ax: 0.945, az: -2.015, nx: -S, nz: S },
  rear: { ax: 0, az: -2.1, nx: 0, nz: 1 },
  rearLeft: { ax: -0.945, az: -2.015, nx: S, nz: S },
  left: { ax: -0.88, az: 0.08, nx: 1, nz: 0 },
};

export class PistonHead {
  readonly id: PistonId;
  readonly index: number;
  readonly ax: number;
  readonly az: number;
  readonly nx: number;
  readonly nz: number;
  /** Lateral unit across the face (n rotated +90° about Y). */
  readonly tx: number;
  readonly tz: number;
  /** Yaw for `projectOutOfBox`: its box X axis is this piston's inward axis. */
  readonly boxYaw: number;
  phase: PistonPhase = "idle";
  /** Steel plate front along the axis (m from the axis point; negative is outside the car). */
  plate = 0;
  /** Plate speed along the inward axis (m/s). */
  u = 0;
  /** Honeycomb crushed so far (m). */
  faceSet = 0;
  /** Paint along the axis at rest (first skin the face meets). */
  skinS = 0;
  /** Particle contact plane minus paint: the physics face leads the visible face by this. */
  pad = 0;
  restPlate = 0;
  contacted = false;
  touching = false;
  /** Rig time of first touch (s, −1 before). */
  contactAt = -1;
  /** Closing speed at first touch (m/s). */
  closing = 0;
  /** Equivalent barrier speed this shot hands the car (m/s). */
  ebs = 0;
  /** Car crush energy of this shot (J). */
  energy = 0;
  private lastTouch = -1;
  private target = 0;
  private accel = 0;

  constructor(id: PistonId, index: number) {
    const a = AXES[id];
    this.id = id;
    this.index = index;
    this.ax = a.ax;
    this.az = a.az;
    this.nx = a.nx;
    this.nz = a.nz;
    this.tx = -a.nz;
    this.tz = a.nx;
    this.boxYaw = Math.atan2(-a.nz, a.nx);
  }

  get firing(): boolean {
    return this.phase === "accel" || this.phase === "coast";
  }

  /** Visible face (honeycomb front, or the plate on a rigid face) along the axis. */
  face(honey: number): number {
    return this.plate + Math.max(0, honey - this.faceSet);
  }

  /** Along-axis and lateral coordinates of a world point. */
  along(x: number, z: number): number {
    return (x - this.ax) * this.nx + (z - this.az) * this.nz;
  }

  lateral(x: number, z: number): number {
    return (x - this.ax) * this.tx + (z - this.az) * this.tz;
  }

  fire(speed: number, honey: number): void {
    this.phase = "accel";
    this.u = 0;
    this.target = speed;
    // Reach full speed with a tenth of the gap to spare.
    const run = Math.max(0.05, this.skinS - this.face(honey) - PISTON.restGap * 0.1);
    this.accel = (speed * speed) / (2 * run);
    this.contacted = false;
    this.touching = false;
    this.contactAt = -1;
    this.closing = 0;
    this.ebs = 0;
    this.energy = 0;
    this.lastTouch = -1;
  }

  /** Kinematics only: run-up, free coast (contact slows it), end stop, release, retract. */
  advance(dt: number, honey: number, time: number): void {
    if (this.phase === "idle") return;
    if (this.phase === "retract") {
      this.plate -= PISTON.retractSpeed * dt;
      if (this.plate <= this.restPlate) {
        this.plate = this.restPlate;
        this.phase = "idle";
      }
      return;
    }
    if (this.phase === "accel") {
      this.u = Math.min(this.target, this.u + this.accel * dt);
      if (this.u >= this.target) this.phase = "coast";
    }
    this.plate += this.u * dt;
    const end = this.skinS + PISTON.stroke;
    const stopped = this.contacted && this.u <= 0.02;
    const released = this.contacted && !this.touching && time - this.lastTouch > PISTON.releaseAfter;
    if (this.face(honey) >= end || stopped || released) {
      this.plate = Math.min(this.plate, end - Math.max(0, honey - this.faceSet));
      this.u = 0;
      this.phase = "retract";
    }
  }

  touch(time: number): void {
    this.touching = true;
    this.lastTouch = time;
  }

  park(): void {
    this.phase = "idle";
    this.plate = this.restPlate;
    this.u = 0;
    this.faceSet = 0;
    this.contacted = false;
    this.touching = false;
    this.contactAt = -1;
    this.closing = 0;
    this.ebs = 0;
    this.energy = 0;
    this.lastTouch = -1;
  }
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

function shiftVelocities(d: StreamedDeformation, dx: number, dz: number): void {
  for (const m of d.masses) {
    if (!m.dynamic) continue;
    m.vel.x += dx;
    m.vel.z += dz;
  }
}

function holdCentreOfMass(d: StreamedDeformation): void {
  let mx = 0;
  let mz = 0;
  let mass = 0;
  for (const m of d.masses) {
    if (!m.dynamic) continue;
    mx += m.vel.x * m.mass;
    mz += m.vel.z * m.mass;
    mass += m.mass;
  }
  if (mass < 1e-6) return;
  shiftVelocities(d, -mx / mass, -mz / mass);
}

/**
 * The piston scene's physics: owns the heads, drives the parked car through
 * the mass-level box contact (`projectOutOfBox` in the moving head's frame plus
 * the stroke-sized `brakeInbound` crush force), and hands the first hit to
 * `applyImpact` with an equivalent barrier speed from the impactor's energy.
 * DOM-free; the engine and the tests run the same `step`.
 */
export class PistonRig {
  readonly heads: PistonHead[];
  readonly config: PistonConfig;
  car: DeformableCar | null = null;
  time = 0;
  /** First touch of any head since the last `takeHit()`: FX and cinematic hook. */
  readonly hitPoint = new THREE.Vector3();
  readonly hitNormal = new THREE.Vector3();
  hitClosing = 0;
  private hitFresh = false;
  private cell: MassNode | null = null;

  constructor(config: Partial<PistonConfig> = {}) {
    this.config = { ...PISTON_DEFAULTS };
    this.heads = PISTON_IDS.map((id, i) => new PistonHead(id, i));
    this.setConfig(config);
  }

  head(id: PistonId): PistonHead {
    return this.heads[PISTON_IDS.indexOf(id)]!;
  }

  get busy(): boolean {
    return this.heads.some((h) => h.phase !== "idle");
  }

  /** Honeycomb depth for the current hardness (0 on a rigid face). */
  get honey(): number {
    return PISTON.honeycomb * (1 - THREE.MathUtils.clamp(this.config.hardness, 0, 1));
  }

  /** ½·μ·v² share the car takes: μ is the reduced mass, or the impactor's when the car is held. */
  shotEnergy(carMass: number): number {
    const v = this.config.speedKph / 3.6;
    const big = this.config.massKg;
    const mu = this.config.holdCar ? big : (carMass * big) / (carMass + big);
    return 0.5 * mu * v * v * THREE.MathUtils.clamp(this.config.hardness, 0, 1);
  }

  setConfig(patch: Partial<PistonConfig>): void {
    Object.assign(this.config, patch);
    this.config.speedKph = THREE.MathUtils.clamp(this.config.speedKph, 1, 200);
    this.config.massKg = THREE.MathUtils.clamp(this.config.massKg, 50, 20000);
    this.config.hardness = THREE.MathUtils.clamp(this.config.hardness, 0.05, 1);
    this.config.faceWidth = THREE.MathUtils.clamp(this.config.faceWidth, 0.2, 2);
    this.config.faceHeight = THREE.MathUtils.clamp(this.config.faceHeight, 0.15, 1.2);
    if (this.car && !this.busy) this.measure(this.car);
  }

  /** Take a car parked at the origin, yaw 0, at rest; measure each face's paint and contact pad. */
  attach(car: DeformableCar): void {
    this.car = car;
    this.cell = car.deform.masses.find((m) => m.name === "cell") ?? null;
    this.time = 0;
    this.hitFresh = false;
    this.measure(car);
  }

  private measure(car: DeformableCar): void {
    const pos = car.body.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const hw = this.config.faceWidth * 0.5;
    const y0 = PISTON.faceY - this.config.faceHeight * 0.5;
    const y1 = PISTON.faceY + this.config.faceHeight * 0.5;
    for (const h of this.heads) {
      let skin = Infinity;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i]!;
        const y = arr[i + 1]!;
        const z = arr[i + 2]!;
        if (y < y0 || y > y1 || Math.abs(h.lateral(x, z)) > hw) continue;
        skin = Math.min(skin, h.along(x, z));
      }
      let reach = Infinity;
      for (const m of car.deform.masses) {
        if (m.hub) continue;
        const r = m.radius * 0.5;
        if (Math.abs(h.lateral(m.rest.x, m.rest.z)) >= hw + r) continue;
        reach = Math.min(reach, h.along(m.rest.x, m.rest.z) - r);
      }
      if (!Number.isFinite(skin)) skin = reach;
      h.skinS = skin;
      h.pad = Number.isFinite(reach) ? reach - skin : 0;
      h.restPlate = skin - PISTON.restGap - this.honey;
      h.park();
    }
  }

  /** Put every head back at rest with a fresh honeycomb. */
  park(): void {
    for (const h of this.heads) h.park();
    this.time = 0;
    this.hitFresh = false;
  }

  fire(which: PistonId | "all"): void {
    if (!this.car) return;
    const speed = this.config.speedKph / 3.6;
    for (const h of this.heads) {
      if (which !== "all" && h.id !== which) continue;
      if (h.phase !== "idle") continue;
      h.fire(speed, this.honey);
    }
  }

  /** The first touch since the last call, or false. */
  takeHit(): boolean {
    const fresh = this.hitFresh;
    this.hitFresh = false;
    return fresh;
  }

  /** One physics slice (the engine's `fixedStep` slice); substeps so a head moves ≤ 4 cm. */
  step(dt: number): void {
    if (!this.car || dt <= 0) return;
    let fastest = 0;
    for (const h of this.heads) if (h.firing) fastest = Math.max(fastest, Math.abs(h.u), h.phase === "accel" ? this.config.speedKph / 3.6 : 0);
    const n = Math.max(1, Math.min(16, Math.ceil((fastest * dt) / PISTON.maxSubstep)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(this.car, h);
  }

  private substep(car: DeformableCar, dt: number): void {
    const d = car.deform;
    this.time += dt;
    const honey = this.honey;
    car.refreshBasis();
    for (const h of this.heads) {
      h.touching = false;
      h.advance(dt, honey, this.time);
    }
    for (const h of this.heads) if (h.firing && !h.contacted && this.overlaps(h, d, honey)) this.firstTouch(car, h, honey);
    if (!d.massActive) return;
    let touching = false;
    for (const h of this.heads) if (h.contacted && h.firing && this.contact(h, d, honey, dt, true)) touching = true;
    if (touching) d.notifyContact();
    if (this.config.holdCar) holdCentreOfMass(d);
    d.stepStructure(dt);
    for (const h of this.heads) if (h.contacted && h.firing) this.contact(h, d, honey, dt, false);
    if (this.config.holdCar) holdCentreOfMass(d);
    car.syncPose(dt);
  }

  /** Any particle sphere (projectOutOfBox's half radius) across this face's contact plane. */
  private overlaps(h: PistonHead, d: StreamedDeformation, honey: number): boolean {
    const plane = h.face(honey) + h.pad;
    const hw = this.config.faceWidth * 0.5;
    for (const m of d.masses) {
      if (m.hub && !m.popped) continue;
      const r = m.radius * 0.5;
      if (Math.abs(h.lateral(m.world.x, m.world.z)) >= hw + r) continue;
      if (h.along(m.world.x, m.world.z) - r < plane) return true;
    }
    return false;
  }

  private firstTouch(car: DeformableCar, h: PistonHead, honey: number): void {
    const d = car.deform;
    const m = d.totalMass;
    h.contacted = true;
    h.contactAt = this.time;
    h.closing = h.u;
    h.energy = this.shotEnergy(m) * (h.u * h.u) / Math.max(1e-6, (this.config.speedKph / 3.6) ** 2);
    h.ebs = Math.sqrt((2 * h.energy) / m);
    h.touch(this.time);
    const s = h.face(honey) + h.pad;
    _p.set(h.ax + h.nx * s, PISTON.faceY, h.az + h.nz * s);
    _n.set(h.nx, 0, h.nz);
    if (!car.crashed) car.applyImpact(_p, _n, h.u, h.ebs);
    if (!this.hitFresh) {
      this.hitPoint.copy(_p);
      this.hitNormal.copy(_n);
      this.hitClosing = h.u;
      this.hitFresh = true;
    }
  }

  /**
   * Box contact in the head's rest frame: shift the car into it, project the
   * particles out of the head (`projectOutOfBox`), apply the crush force that
   * spends this shot's stroke (`brakeInbound`), shift back. Whatever momentum
   * the car takes comes off the impactor. A honeycomb face gives way at its
   * share of the closing speed while it has depth left.
   */
  private contact(h: PistonHead, d: StreamedDeformation, honey: number, dt: number, crush: boolean): boolean {
    const cell = this.cell;
    const cellVn = cell ? cell.vel.x * h.nx + cell.vel.z * h.nz : 0;
    const give = 1 - THREE.MathUtils.clamp(this.config.hardness, 0, 1);
    const yieldRate = h.faceSet < honey ? give * Math.max(0, h.u - cellVn) : 0;
    const uFace = h.u - yieldRate;
    const half = PISTON.headDepth * 0.5;
    const plane = h.face(honey) + h.pad;
    const cx = h.ax + h.nx * (plane - half);
    const cz = h.az + h.nz * (plane - half);
    shiftVelocities(d, -h.nx * uFace, -h.nz * uFace);
    const removed = d.projectOutOfBox(cx, cz, half, this.config.faceWidth * 0.5, h.boxYaw);
    const touching = d.faceContacts > 0;
    let taken = 0;
    if (crush && touching) {
      const j = (d.totalMass * h.ebs * h.ebs) / (2 * Math.max(0.05, d.hitStroke())) * dt;
      taken = d.brakeInbound(h.nx, h.nz, j, 0);
    }
    shiftVelocities(d, h.nx * uFace, h.nz * uFace);
    if (h.phase === "coast") h.u = Math.max(0, h.u - (removed + taken) / this.config.massKg);
    if (touching) {
      h.touch(this.time);
      if (crush) h.faceSet = Math.min(honey, h.faceSet + yieldRate * dt);
    }
    return touching;
  }
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

  // Plan-view rigid fit (rotation + translation, mean height) of the far particles.
  let px = 0;
  let pz = 0;
  let qx = 0;
  let qz = 0;
  let dy = 0;
  let count = 0;
  for (const m of d.masses) {
    if (m.hub || !far(m.rest.x, m.rest.z)) continue;
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
  for (const m of d.masses) {
    if (m.hub || !far(m.rest.x, m.rest.z)) continue;
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
  const fit = (x: number, y: number, z: number): THREE.Vector3 =>
    fitted.set(c * (x - px) - s * (z - pz) + qx, y - dy, s * (x - px) + c * (z - pz) + qz);

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
