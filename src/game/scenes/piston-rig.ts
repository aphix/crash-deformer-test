import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { strikeCar, makeBox, partContact } from "../contact/external-contact.ts";
import type { StreamedDeformation } from "../deform/streamed-deform.ts";
import { KPH_PER_MS } from "../kernel/constants.ts";

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
  /** Loop: seconds from one shot to the next when the orbit isn't pacing the hops (orbit off, or the camera was moved). */
  hopSeconds: number;
};

export const PISTON_DEFAULTS: Readonly<PistonConfig> = {
  speedKph: 40,
  massKg: 1500,
  hardness: 1,
  faceWidth: 1.2,
  faceHeight: 0.5,
  holdCar: false,
  hopSeconds: 6.5,
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

type PistonPhase = "idle" | "accel" | "coast" | "retract";

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
 * The piston scene's physics: owns the heads and drives the parked car. Each head is a striker
 * box through the shared contact (`strikeCar`: crush from the face's overlap, the particles
 * held on the moving face, the stroke-sized crush force; `partContact`: doors and mirrors), and
 * hands the first hit to `applyImpact` with an equivalent barrier speed from the impactor's
 * energy. DOM-free; the engine and the tests run the same `step`.
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
  private readonly box = makeBox();

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
    const v = this.config.speedKph / KPH_PER_MS;
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
    this.config.hopSeconds = THREE.MathUtils.clamp(this.config.hopSeconds, 1.5, 20);
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
    const speed = this.config.speedKph / KPH_PER_MS;
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
    for (const h of this.heads) if (h.firing) fastest = Math.max(fastest, Math.abs(h.u), h.phase === "accel" ? this.config.speedKph / KPH_PER_MS : 0);
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
    for (const h of this.heads) if (h.contacted && h.firing && this.contact(h, car, honey, dt, true)) touching = true;
    if (touching) d.notifyContact();
    if (this.config.holdCar) holdCentreOfMass(d);
    d.stepStructure(dt);
    for (const h of this.heads) if (h.contacted && h.firing) this.contact(h, car, honey, dt, false);
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
    h.energy = this.shotEnergy(m) * (h.u * h.u) / Math.max(1e-6, (this.config.speedKph / KPH_PER_MS) ** 2);
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
   * The head as a striker box on its axis (moving at the face speed, its mass and hardness)
   * through the shared contact; whatever momentum the car takes comes off the impactor. A
   * honeycomb face gives way at its share of the closing speed while it has depth left. A head
   * on an end reports it (`noteContactEnd`), so front and rear together squeeze the car.
   */
  private contact(h: PistonHead, car: DeformableCar, honey: number, dt: number, crush: boolean): boolean {
    const d = car.deform;
    const cell = this.cell;
    const cellVn = cell ? cell.vel.x * h.nx + cell.vel.z * h.nz : 0;
    const give = 1 - THREE.MathUtils.clamp(this.config.hardness, 0, 1);
    const yieldRate = h.faceSet < honey ? give * Math.max(0, h.u - cellVn) : 0;
    const uFace = h.u - yieldRate;
    const half = PISTON.headDepth * 0.5;
    const plane = h.face(honey) + h.pad;
    const box = this.box;
    box.x = h.ax + h.nx * (plane - half);
    box.y = PISTON.faceY;
    box.z = h.az + h.nz * (plane - half);
    box.hx = this.config.faceWidth * 0.5;
    box.hy = this.config.faceHeight * 0.5;
    box.hz = half;
    box.yaw = Math.atan2(h.nx, h.nz);
    box.vx = h.nx * uFace;
    box.vz = h.nz * uFace;
    box.kg = this.config.massKg;
    box.hardness = this.config.hardness;
    let taken = strikeCar(car, box, dt, crush);
    const touching = d.faceContacts > 0;
    if (crush) taken += box.kg * partContact(car, box, dt).du;
    if (h.phase === "coast") h.u = Math.max(0, h.u - taken / this.config.massKg);
    if (touching) {
      h.touch(this.time);
      if (crush) h.faceSet = Math.min(honey, h.faceSet + yieldRate * dt);
      if (Math.abs(h.nz) > 0.5) car.noteContactEnd(h.az > 0 ? 1 : -1, Math.abs(h.az + h.nz * plane));
    }
    return touching;
  }
}
