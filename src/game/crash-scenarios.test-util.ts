import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { JerseyBarrier } from "./engine-props.ts";
import { resolveCarPair } from "./pair-contact.ts";
import { applyGroundFriction, CRASH, leftoverCrumple } from "./physics-util.ts";
import { BARRIER_HALF, physicsSlice, sliceSpeed } from "./sat.ts";
import type { DeformMode } from "./streamed-deform.ts";
import { mass, paint } from "./test-support.ts";

/**
 * Headless crash scenarios in the `CrashEngine.tickInner` / `fixedStep` order
 * (docs/RIG_ANALYSIS.md §3.1). The jersey slab is the real `JerseyBarrier`,
 * held fixed (no slide, no dent). Not a test file itself.
 */

const IMPACT_SCALE = 0.032;
const SLOMO_HOLD = 6.5;
const FRAME = 1 / 60;

export type CrashResult = {
  /** Nose shortening vs the cell at the end (m, positive = shorter). */
  noseShortL: number;
  noseShortR: number;
  noseMaxL: number;
  noseMaxR: number;
  /** Tail shortening vs the cell at the end, worse side. */
  tailShort: number;
  tailMax: number;
  /** Group travel along the approach axis after first contact (m). */
  comTravel: number;
  /** Time to 95 % of the COM Δv (ms), and the average g over it. */
  pulseMs: number;
  avgG: number;
  /** Deepest mass half-sphere past the slab face (m), and deepest mass centre. */
  maxPastFace: number;
  maxCentrePastFace: number;
  /** Rearward engine travel vs the cell (max of L/R), and its most forward value. */
  engineMax: number;
  engineMin: number;
  doorMaxL: number;
  doorMaxR: number;
  roofMax: number;
  /** Planar cell displacement vs its rest place in the group (hub) frame (m). */
  cellShift: number;
  /** Cabin intrusion (§3.1): the larger of the lateral door inward motions and the roof drop (m). */
  cabinIntrusion: number;
  engineGapErr: number;
  impactLocalX: number;
  drivetrainAlive: boolean;
  detached: string[];
  hubsPopped: string[];
  lampsOut: string[];
  hinge: Record<string, number>;
  /** Peak sensor compression (m): `crushAmount`, which drives the buckle wrinkle. */
  crushMax: number;
  /** Sum of |Δ group yaw| per frame once contact has been quiet for 0.1 s (rad). */
  quietYawDrift: number;
  /** Frames after first contact with |angular.y| at the ±6 rad/s clamp (≥ 5.9). */
  spinFrames: number;
};

export type CrashWorld = {
  cars: DeformableCar[];
  barrier: JerseyBarrier | null;
  acc: number;
  timeScale: number;
  targetScale: number;
  impact: boolean;
  wallSinceImpact: number;
  slomo: boolean;
  /** Group position at the start of the last slice before each car's first contact. */
  preContact: Map<DeformableCar, THREE.Vector3>;
};

export type ScenarioOpts = {
  mode?: DeformMode;
  slomo?: boolean;
  /** Sim seconds to keep running after first contact. */
  after?: number;
  squash?: number;
  buckle?: number;
};

export function makeCar(mode: DeformMode = "shape", squash = 0.4, buckle = 0.45): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene());
  car.deform.setMode(mode);
  car.deform.squash = squash;
  car.deform.buckle = buckle;
  return car;
}

function launch(car: DeformableCar, x: number, z: number, yaw: number, vx: number, vz: number): void {
  car.spawnFacing(x, z, yaw, 0);
  car.velocity.set(vx, 0, vz);
  car.speed = Math.hypot(vx, vz);
  car.spawnSpeed = car.speed;
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
}

function holdSlab(b: JerseyBarrier): void {
  b.vel.set(0, 0, 0);
  b.crush = 0;
}

function bleedAfterSlide(car: DeformableCar, dt: number): void {
  if (!car.crashed) return;
  const q = car.deform.quietTime();
  const mu = q < 0.15 ? CRASH.muScuff : CRASH.muSlide * (1 + Math.min(1.4, q));
  applyGroundFriction(car.velocity, dt, mu, true);
  if (car.deform.massActive && q > 0.08) {
    car.deform.dragGround(dt, THREE.MathUtils.clamp((q - 0.08) / 1.1, 0, 1));
  }
}

/** `CrashEngine.fixedStep` minus poles, balls, derby and compactor. Returns the strongest contact impulse. */
function fixedStep(w: CrashWorld, dt: number): number {
  const { cars, barrier } = w;
  let nearWall = false;
  if (barrier) for (const car of cars) if (car.group.position.lengthSq() < 160) nearWall = true;
  const slices = nearWall && dt > 0.006 ? 3 : dt > 0.012 ? 2 : 1;
  const h = dt / slices;
  let strongest = 0;
  for (let i = 0; i < slices; i++) {
    for (const car of cars) {
      if (!car.crashed) {
        const pre = w.preContact.get(car) ?? new THREE.Vector3();
        w.preContact.set(car, pre.copy(car.group.position));
      }
      if (!car.deform.massActive) car.integrate(h);
      if (car.deform.massActive) car.syncPose(h);
      else car.refreshBasis();
    }
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const ca = cars[a]!;
        const cb = cars[b]!;
        if (barrier && barrier.blocksPair(ca, cb)) continue;
        const dx = ca.group.position.x - cb.group.position.x;
        const dz = ca.group.position.z - cb.group.position.z;
        if (dx * dx + dz * dz > 28) continue;
        if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform);
      }
    }
    let satBusy = false;
    let wrecked = true;
    for (const car of cars) {
      if (car.velocity.lengthSq() > 1.4) satBusy = true;
      if (!car.crashed || leftoverCrumple(car.deform.crumpleTravelCorner()) >= 0.2) wrecked = false;
    }
    for (let k = 0; k < (satBusy && !wrecked ? 3 : 1); k++) {
      for (const car of cars) {
        if (car.deform.massActive) car.syncPose(0);
        else car.refreshBasis();
      }
      const feed = k === 0;
      let moved = false;
      if (barrier) {
        for (const car of cars) {
          const hit = barrier.resolve(car, !car.crashed, feed, h);
          holdSlab(barrier);
          if (hit) {
            moved = true;
            strongest = Math.max(strongest, hit.impulse);
          }
        }
      }
      for (let a = 0; a < cars.length; a++) {
        for (let b = a + 1; b < cars.length; b++) {
          if (barrier && barrier.blocksPair(cars[a]!, cars[b]!)) continue;
          const pair = resolveCarPair(cars[a]!, cars[b]!, !(cars[a]!.crashed && cars[b]!.crashed), feed, h);
          if (pair) {
            moved = true;
            strongest = Math.max(strongest, pair.impulse);
          }
        }
      }
      if (barrier) {
        for (const car of cars) {
          if (barrier.resolve(car, false, false, h)) moved = true;
          holdSlab(barrier);
        }
      }
      if (!moved) break;
    }
    for (const car of cars) {
      if (car.deform.massActive) car.deform.stepStructure(h);
      if (car.deform.massActive) car.syncPose(h);
      if (barrier) barrier.clip(car);
      car.afterContacts(h);
    }
  }
  return strongest;
}

/** One rendered frame of `CrashEngine.tickInner` (physics part) plus `updatePhase` timing. */
export function tickWorld(w: CrashWorld, wallDt = FRAME): void {
  w.timeScale += (w.targetScale - w.timeScale) * Math.min(1, wallDt * (w.impact && w.wallSinceImpact > SLOMO_HOLD ? 1.15 : 3.2));
  const simDt = wallDt * w.timeScale;
  const vmax = sliceSpeed(w.cars);
  w.acc = Math.min(0.05, w.acc + simDt);
  let steps = 0;
  let strongest = 0;
  while (w.acc > 1e-5 && steps < 8) {
    const h = physicsSlice(w.acc, vmax);
    strongest = Math.max(strongest, fixedStep(w, h));
    w.acc -= h;
    for (const car of w.cars) {
      if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
      if (w.wallSinceImpact > 0.2 && car.crashed) bleedAfterSlide(car, h);
    }
    steps++;
  }
  for (const car of w.cars) car.updateDeform(simDt);
  if (!w.impact && strongest > 0.4) {
    w.impact = true;
    w.wallSinceImpact = 0;
    if (w.slomo) {
      w.targetScale = IMPACT_SCALE;
      if (w.timeScale > IMPACT_SCALE * 1.15) w.timeScale = IMPACT_SCALE;
    }
  }
  if (w.impact) {
    w.wallSinceImpact += wallDt;
    if (w.wallSinceImpact > SLOMO_HOLD) w.targetScale = 1;
  }
}

const _fwd = new THREE.Vector3();
/** World heading of the group's +z axis (rad), independent of the Euler order. */
function heading(car: DeformableCar): number {
  car.group.getWorldDirection(_fwd);
  return Math.atan2(_fwd.x, _fwd.z);
}

/** Per-car metric accumulator (§3.1 definitions, all relative to the cell mass). */
class Probe {
  private readonly dir = new THREE.Vector3();
  private readonly start = new THREE.Vector3();
  private v0 = 0;
  private vMin = Infinity;
  private readonly trace: { t: number; v: number }[] = [];
  private t = 0;
  contact = false;
  r: CrashResult = {
    noseShortL: 0,
    noseShortR: 0,
    noseMaxL: 0,
    noseMaxR: 0,
    tailShort: 0,
    tailMax: 0,
    comTravel: 0,
    pulseMs: 0,
    avgG: 0,
    maxPastFace: 0,
    maxCentrePastFace: 0,
    engineMax: 0,
    engineMin: 0,
    doorMaxL: 0,
    doorMaxR: 0,
    roofMax: 0,
    cellShift: 0,
    cabinIntrusion: 0,
    engineGapErr: 0,
    impactLocalX: 0,
    drivetrainAlive: true,
    detached: [],
    hubsPopped: [],
    lampsOut: [],
    hinge: {},
    crushMax: 0,
    quietYawDrift: 0,
    spinFrames: 0,
  };
  private prevYaw = 0;

  readonly car: DeformableCar;

  constructor(car: DeformableCar, approach: THREE.Vector3) {
    this.car = car;
    this.dir.copy(approach).setY(0).normalize();
  }

  /** Called once per rendered frame; contact start uses the previous frame so the first-frame Δv counts. */
  sample(simDt: number, w: CrashWorld): void {
    const barrier = w.barrier;
    const car = this.car;
    if (!this.contact && !car.crashed) {
      this.v0 = car.velocity.dot(this.dir);
      return;
    }
    if (!this.contact) {
      this.contact = true;
      this.start.copy(w.preContact.get(car) ?? car.group.position);
      this.r.impactLocalX = car.deform.impactLocal.x;
      this.trace.push({ t: 0, v: this.v0 });
      this.prevYaw = heading(car);
    }
    this.t += simDt;
    const d = car.deform;
    const cell = mass(d, "cell").local;
    const r = this.r;
    const yaw = heading(car);
    if (d.quietTime() >= 0.1) r.quietYawDrift += Math.abs(Math.atan2(Math.sin(yaw - this.prevYaw), Math.cos(yaw - this.prevYaw)));
    this.prevYaw = yaw;
    if (Math.abs(car.angular.y) >= 5.9) r.spinFrames++;
    r.crushMax = Math.max(r.crushMax, d.crushAmount);
    const noseL = 2.0 - (mass(d, "bumperFL").local.z - cell.z);
    const noseR = 2.0 - (mass(d, "bumperFR").local.z - cell.z);
    const tail = Math.max(2.12 - (cell.z - mass(d, "bumperRL").local.z), 2.12 - (cell.z - mass(d, "bumperRR").local.z));
    const engL = 1.16 - (mass(d, "engineL").local.z - cell.z);
    const engR = 1.16 - (mass(d, "engineR").local.z - cell.z);
    r.noseShortL = noseL;
    r.noseShortR = noseR;
    r.tailShort = tail;
    r.noseMaxL = Math.max(r.noseMaxL, noseL);
    r.noseMaxR = Math.max(r.noseMaxR, noseR);
    r.tailMax = Math.max(r.tailMax, tail);
    r.engineMax = Math.max(r.engineMax, engL, engR);
    r.engineMin = Math.min(r.engineMin, engL, engR);
    r.doorMaxL = Math.max(r.doorMaxL, mass(d, "doorL").local.x - cell.x + 0.78);
    r.doorMaxR = Math.max(r.doorMaxR, 0.78 - (mass(d, "doorR").local.x - cell.x));
    r.roofMax = Math.max(r.roofMax, 0.63 - (mass(d, "roof").local.y - cell.y));
    const cellRest = mass(d, "cell").rest;
    r.cellShift = Math.max(r.cellShift, Math.hypot(cell.x - cellRest.x, cell.z - cellRest.z));
    r.cabinIntrusion = Math.max(r.doorMaxL, r.doorMaxR, r.roofMax);
    r.engineGapErr = Math.max(r.engineGapErr, Math.abs(mass(d, "engineL").local.distanceTo(mass(d, "engineR").local) - 0.6));
    r.comTravel = Math.max(r.comTravel, (car.group.position.x - this.start.x) * this.dir.x + (car.group.position.z - this.start.z) * this.dir.z);
    const v = car.velocity.dot(this.dir);
    this.vMin = Math.min(this.vMin, v);
    this.trace.push({ t: this.t, v });
    if (barrier && d.massActive) {
      const ox = barrier.group.position.x;
      const side = car.group.position.x - ox >= 0 ? 1 : -1;
      const hx = barrier.hx();
      for (const m of d.masses) {
        if (Math.abs(m.world.z - barrier.group.position.z) > BARRIER_HALF.z) continue;
        const past = hx - (m.world.x - ox) * side;
        r.maxCentrePastFace = Math.max(r.maxCentrePastFace, past);
        r.maxPastFace = Math.max(r.maxPastFace, past + m.radius * 0.5);
      }
    }
  }

  finish(): CrashResult {
    const r = this.r;
    const car = this.car;
    const dv = this.v0 - this.vMin;
    if (dv > 0.5) {
      const hit = this.trace.find((s) => s.v <= this.v0 - 0.95 * dv);
      if (hit) {
        r.pulseMs = hit.t * 1000;
        r.avgG = (0.95 * dv) / Math.max(1e-3, hit.t) / 9.81;
      }
    }
    r.drivetrainAlive = car.deform.drivetrainAlive;
    const snap = car.snapshot() as {
      parts: { name: string; detached: boolean; hingeT: number }[];
      lamps: { kind: string; side: number; intact: boolean }[];
    };
    for (const p of snap.parts) {
      r.hinge[p.name] = p.hingeT;
      if (p.detached) r.detached.push(p.name);
    }
    for (const l of snap.lamps) if (!l.intact) r.lampsOut.push(`${l.kind}${l.side < 0 ? "L" : "R"}`);
    for (const h of ["hubFL", "hubFR", "hubRL", "hubRR"]) if (car.deform.hubPopped(h)) r.hubsPopped.push(h);
    return r;
  }
}

function run(w: CrashWorld, probes: Probe[], after: number): void {
  const limit = 60 * 120;
  let sinceContact = 0;
  for (let frame = 0; frame < limit; frame++) {
    const before = w.timeScale;
    tickWorld(w);
    const simDt = FRAME * (before + w.timeScale) * 0.5;
    for (const p of probes) p.sample(simDt, w);
    if (probes.some((p) => p.contact)) sinceContact += simDt;
    if (sinceContact >= after) return;
  }
}

export function makeWorld(cars: DeformableCar[], barrier: boolean, slomo: boolean): CrashWorld {
  const scene = new THREE.Scene();
  return {
    cars,
    barrier: barrier ? new JerseyBarrier(scene, new THREE.Group()) : null,
    acc: 0,
    timeScale: 1,
    targetScale: 1,
    impact: false,
    wallSinceImpact: 0,
    slomo,
    preContact: new Map(),
  };
}

export type WallApproach = "front" | "rear" | "side";

/**
 * Square or offset rigid-wall hit. The slab lies along Z through the origin;
 * the car comes from +X. `overlap` is the share of the car width on the slab,
 * measured from the car's left (−Z) side.
 */
export function runWall(speedKph: number, overlap = 1, approach: WallApproach = "front", opts: ScenarioOpts = {}): CrashResult {
  const v = speedKph / 3.6;
  const car = makeCar(opts.mode, opts.squash, opts.buckle);
  if (approach === "front") {
    const z = overlap >= 1 ? 0 : BARRIER_HALF.z + 0.88 * (1 - 2 * overlap);
    launch(car, 6.2, z, -Math.PI / 2, -v, 0);
  } else if (approach === "rear") {
    launch(car, 6.2, 0, Math.PI / 2, -v, 0);
  } else {
    launch(car, 2.6, 0, 0, -v, 0);
  }
  const w = makeWorld([car], true, opts.slomo ?? false);
  const probe = new Probe(car, car.velocity);
  run(w, [probe], opts.after ?? 1.5);
  return probe.finish();
}

/**
 * Two-car hit. `head-on`: full overlap, nose to nose along X. `t-bone`: car B
 * (the bullet) drives its nose into the stationary car A's right door.
 */
export function runPair(kphA: number, kphB: number, kind: "head-on" | "t-bone" = "head-on", opts: ScenarioOpts = {}): [CrashResult, CrashResult] {
  const a = makeCar(opts.mode, opts.squash, opts.buckle);
  const b = makeCar(opts.mode, opts.squash, opts.buckle);
  if (kind === "head-on") {
    launch(a, -5, 0, Math.PI / 2, kphA / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -kphB / 3.6, 0);
  } else {
    launch(a, 0, 0, 0, 0, 0);
    launch(b, 6, 0, -Math.PI / 2, -kphB / 3.6, 0);
  }
  const w = makeWorld([a, b], false, opts.slomo ?? false);
  const dirA = kind === "head-on" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
  const pa = new Probe(a, dirA);
  const pb = new Probe(b, new THREE.Vector3(-1, 0, 0));
  run(w, [pa, pb], opts.after ?? 1.5);
  return [pa.finish(), pb.finish()];
}
