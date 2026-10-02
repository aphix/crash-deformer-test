import * as THREE from "three";
import { bleedAfterSlide, DeformableCar } from "./car.ts";
import { JerseyBarrier, type ContactHit } from "./engine-props.ts";
import { tyreOverlap } from "./pair-contact.ts";
import { beginImpact, easeTimeScale, phaseClock, stepPhase, type PhaseClock } from "./phase.ts";
import { CAGES } from "./rig-spec.ts";
import { BARRIER_HALF, physicsSlice, sliceSpeed } from "./sat.ts";
import type { DeformMode } from "./streamed-deform.ts";
import { mass, paint } from "./test-support.ts";
import { newWorld, stepWorld, type World } from "./world-step.ts";

/**
 * Headless crash scenarios through the engine's own step (`stepWorld`) and phase clock, at
 * `CrashEngine.tickInner`'s slices (docs/RIG_ANALYSIS.md §3.1). The jersey slab is the real
 * `JerseyBarrier`, held fixed (no slide, no dent). Not a test file itself.
 */

const FRAME = 1 / 60;
const CELL_SPAN = CAGES.find((c) => c.name === "chassisCell")!;

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
  /**
   * Skin cabin intrusion (m): the largest lateral-inward or downward motion, relative to the cell
   * mass, of a body-skin vertex in the cabin section (the `chassisCell` z span, above its floor).
   */
  skinCabin: number;
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
  /** Deepest overlap (m) of this car's tyres with another car's over the run; negative: the closest clearance. */
  tyreOverlap: number;
  /** Largest slice step of any mass past the zip limit 3·v·h + 5 cm (m; negative: the closest margin), and which. */
  massStepExcess: number;
  massStepName: string;
};

export type CrashWorld = {
  cars: DeformableCar[];
  acc: number;
  clock: PhaseClock;
  slomo: boolean;
  /** Group position at the start of the last slice before each car's first contact. */
  preContact: Map<DeformableCar, THREE.Vector3>;
  /** The engine's step; the probes hook `afterCar` (their zip check). */
  world: World;
};

export type ScenarioOpts = {
  mode?: DeformMode;
  slomo?: boolean;
  /** Sim seconds to keep running after first contact. */
  after?: number;
  squash?: number;
  buckle?: number;
};

export type WallOpts = ScenarioOpts & {
  /** Hit this car instead of a fresh one. A car that has already crashed is re-aimed with its damage kept. */
  car?: DeformableCar;
};

/** A car at the calibrated default squash/buckle (`StreamedDeformation`) unless the scenario overrides them. */
export function makeCar(mode: DeformMode = "shape", squash?: number, buckle?: number): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene());
  car.deform.setMode(mode);
  if (squash !== undefined) car.deform.squash = squash;
  if (buckle !== undefined) car.deform.buckle = buckle;
  return car;
}

function launch(car: DeformableCar, x: number, z: number, yaw: number, vx: number, vz: number): void {
  car.spawnFacing(x, z, yaw, 0);
  car.velocity.set(vx, 0, vz);
  car.speed = Math.hypot(vx, vz);
  car.spawnSpeed = car.speed;
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
}

/**
 * Re-aim a crashed car without the spawn reset (spawn and `bindKinematic` put the rig back to
 * rest): the damaged lattice moves rigidly to the new pose, sits there 0.35 s (a wreck backing off
 * between hits: past REARM_QUIET, so the next contact is a fresh hit, not the last one's tail), then
 * takes the velocity.
 */
function relaunchDamaged(car: DeformableCar, x: number, z: number, yaw: number, vx: number, vz: number): void {
  const g = car.group;
  g.position.set(x, 0, z);
  g.rotation.set(0, yaw, 0, "YXZ");
  g.updateWorldMatrix(false, false);
  for (const m of car.deform.masses) {
    m.world.copy(m.local).applyMatrix4(g.matrixWorld);
    m.vel.set(0, 0, 0);
  }
  car.velocity.set(0, 0, 0);
  car.angular.set(0, 0, 0);
  for (let t = 0; t < 0.35; t += 1 / 240) {
    car.deform.stepStructure(1 / 240);
    car.syncPose(1 / 240);
  }
  for (const m of car.deform.masses) m.vel.set(vx, 0, vz);
  car.velocity.set(vx, 0, vz);
  car.angular.set(0, 0, 0);
  car.speed = Math.hypot(vx, vz);
  car.refreshBasis();
}

/** The real slab held fixed: every resolve hands back the slide and dent it took. */
class HeldBarrier extends JerseyBarrier {
  override resolve(car: DeformableCar, deform: boolean, feed: boolean, dt: number): ContactHit | null {
    const hit = super.resolve(car, deform, feed, dt);
    this.vel.set(0, 0, 0);
    this.crush = 0;
    return hit;
  }
}

/** One rendered frame of `CrashEngine.tickInner`: the physics part and the phase clock (sandbox impact rule). */
export function tickWorld(w: CrashWorld, wallDt = FRAME): void {
  easeTimeScale(w.clock, wallDt);
  const simDt = wallDt * w.clock.timeScale;
  const vmax = sliceSpeed(w.cars);
  w.acc = Math.min(0.05, w.acc + simDt);
  let steps = 0;
  while (w.acc > 1e-5 && steps < 8) {
    const h = physicsSlice(w.acc, vmax);
    stepWorld(w.world, h);
    const hit = w.world.strongest;
    if (w.clock.phase === "approach" && hit.contact && hit.impulse > 0.4) beginImpact(w.clock, w.slomo);
    w.acc -= h;
    for (const car of w.cars) {
      if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
      if (w.clock.wallSinceImpact > 0.2 && car.crashed) bleedAfterSlide(car, h);
    }
    steps++;
  }
  for (const car of w.cars) car.updateDeform(simDt);
  stepPhase(w.clock, wallDt);
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
    skinCabin: 0,
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
    tyreOverlap: -Infinity,
    massStepExcess: -Infinity,
    massStepName: "",
  };
  private prevYaw = 0;
  /** Mass world xz, and the fastest mass speed, after the last slice with live masses (empty until then). */
  private massPrev: number[] = [];
  private massPrevV = 0;

  readonly car: DeformableCar;
  /** Body-skin vertices whose rest lies in the `chassisCell` span: index and start position. */
  private readonly cabinVerts: number[] = [];
  private readonly cabinStart: number[] = [];
  private readonly cellStart = new THREE.Vector3();

  constructor(car: DeformableCar, approach: THREE.Vector3) {
    this.car = car;
    this.dir.copy(approach).setY(0).normalize();
    const pos = car.body.geometry.getAttribute("position").array;
    const [, y0, z0] = CELL_SPAN.min;
    const z1 = CELL_SPAN.max[2];
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!,
        y = pos[i + 1]!,
        z = pos[i + 2]!;
      if (y < y0 || z < z0 || z > z1) continue;
      this.cabinVerts.push(i);
      this.cabinStart.push(x, y, z);
    }
    this.cellStart.copy(mass(car.deform, "cell").local);
  }

  /** Called after each car's afterContacts in every slice: the zip check, mass by mass, against the slice. */
  slice(h: number): void {
    const d = this.car.deform;
    if (!d.massActive || h <= 0) return;
    let v = this.car.velocity.length();
    for (const m of d.masses) v = Math.max(v, m.vel.length());
    const limit = 3 * Math.max(v, this.massPrevV) * h + 0.05;
    this.massPrevV = v;
    const seen = this.massPrev.length > 0;
    d.masses.forEach((m, i) => {
      if (seen) {
        const excess = Math.hypot(m.world.x - this.massPrev[i * 2]!, m.world.z - this.massPrev[i * 2 + 1]!) - limit;
        if (excess > this.r.massStepExcess) {
          this.r.massStepExcess = excess;
          this.r.massStepName = m.name;
        }
      }
      this.massPrev[i * 2] = m.world.x;
      this.massPrev[i * 2 + 1] = m.world.z;
    });
  }

  /** Called once per rendered frame; contact start uses the previous frame so the first-frame Δv counts. */
  sample(simDt: number, w: CrashWorld): void {
    const barrier = w.world.barrier;
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
    for (const o of w.cars) if (o !== car && o.deform.massActive && d.massActive) this.r.tyreOverlap = Math.max(this.r.tyreOverlap, tyreOverlap(car, o));
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
    if (d.skinnedThisFrame) {
      const pos = car.body.geometry.getAttribute("position").array;
      const cx = cell.x - this.cellStart.x,
        cy = cell.y - this.cellStart.y;
      for (let k = 0; k < this.cabinVerts.length; k++) {
        const i = this.cabinVerts[k]!;
        const x0 = this.cabinStart[k * 3]!;
        const inward = -Math.sign(x0) * (pos[i]! - x0 - cx);
        const drop = -(pos[i + 1]! - this.cabinStart[k * 3 + 1]! - cy);
        r.skinCabin = Math.max(r.skinCabin, inward, drop);
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
  w.world.afterCar = (car, h) => {
    for (const p of probes) if (p.car === car) p.slice(h);
  };
  for (let frame = 0; frame < limit; frame++) {
    const before = w.clock.timeScale;
    tickWorld(w);
    const simDt = FRAME * (before + w.clock.timeScale) * 0.5;
    for (const p of probes) p.sample(simDt, w);
    if (probes.some((p) => p.contact)) sinceContact += simDt;
    if (sinceContact >= after) return;
  }
}

export function makeWorld(cars: DeformableCar[], barrier: boolean, slomo: boolean): CrashWorld {
  const preContact = new Map<DeformableCar, THREE.Vector3>();
  const world = newWorld(cars, barrier ? new HeldBarrier(new THREE.Scene(), new THREE.Group()) : null);
  world.beforeSlice = () => {
    for (const car of cars) if (!car.crashed) preContact.set(car, (preContact.get(car) ?? new THREE.Vector3()).copy(car.group.position));
    return false;
  };
  return { cars, acc: 0, clock: phaseClock(), slomo, preContact, world };
}

export type WallApproach = "front" | "rear" | "side";

/**
 * Square or offset rigid-wall hit. The slab lies along Z through the origin;
 * the car comes from +X. `overlap` is the share of the car width on the slab,
 * measured from the car's left (−Z) side.
 */
export function runWall(speedKph: number, overlap = 1, approach: WallApproach = "front", opts: WallOpts = {}): CrashResult {
  const v = speedKph / 3.6;
  const car = opts.car ?? makeCar(opts.mode, opts.squash, opts.buckle);
  const z = approach === "front" && overlap < 1 ? BARRIER_HALF.z + 0.88 * (1 - 2 * overlap) : 0;
  const yaw = approach === "front" ? -Math.PI / 2 : approach === "rear" ? Math.PI / 2 : 0;
  if (car.crashed) {
    // Struck end 0.5 m off the face: a wreck coasting in from the spawn mark bleeds most of `v`.
    relaunchDamaged(car, BARRIER_HALF.x + 0.5 + strikeReach(car, approach), z, yaw, -v, 0);
  } else {
    launch(car, approach === "side" ? 2.6 : 6.2, z, yaw, -v, 0);
  }
  const w = makeWorld([car], true, opts.slomo ?? false);
  const probe = new Probe(car, car.velocity);
  run(w, [probe], opts.after ?? 1.5);
  return probe.finish();
}

/** Car-local reach of the end that strikes the slab, from the group origin (m). */
function strikeReach(car: DeformableCar, approach: WallApproach): number {
  const d = car.deform;
  if (approach === "front") return Math.max(mass(d, "bumperFL").local.z, mass(d, "bumperFR").local.z);
  if (approach === "rear") return -Math.min(mass(d, "bumperRL").local.z, mass(d, "bumperRR").local.z);
  let minX = Infinity;
  for (const m of d.masses) minX = Math.min(minX, m.local.x);
  return -minX;
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
