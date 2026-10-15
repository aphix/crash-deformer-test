import * as THREE from "three";
import { CAR_HALF, type DeformableCar } from "../vehicle/car.ts";
import type { MassName } from "../kernel/rig-spec.ts";
import { COMPACTOR, CompactorRig } from "./compactor.ts";
import { strikeCar, bodyHit, type ContactBox } from "../contact/external-contact.ts";
import { launch as launchAt, makeCar, makeWorld, tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { sliceSpeed } from "../contact/sat.ts";
import { SimPacer } from "../engine/sim-pace.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { makeCar as makeClassCar } from "../vehicle/ground-probe.test-util.ts";
import { DOOR_LANES, RAM, type DoorScenario } from "./door-rig.ts";
import { fireRam, tyresStep } from "./door-rig.test-util.ts";
import { firePiston, fitRigid } from "./piston-rig.test-util.ts";
import { Ground, setGround } from "../world/ground.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

/**
 * Matched pairs for docs/CONTACT_PARITY.md: the same hit delivered by a scene rig (Doors ram,
 * press, piston) and by other cars through the engine's `fixedStep` order (`tickWorld`).
 * Not a test file itself.
 */

const FRAME = 1 / FRAME_HZ;
/** Clear air (m) between the parked car's bumper and a striker car's: the striker starts this far off. */
const STRIKE_GAP = 2 * CAR_HALF.z + 0.25;
const D2R = Math.PI / 180;

export type CarState = {
  detached: string[];
  /** Struck-side door angle (deg) and latch: the right (+x) side unless `carState` is told the left. */
  doorDeg: number;
  latched: boolean;
  /** Struck-side mirror fold (deg); 0 once the mirror is off. */
  mirrorFoldDeg: number;
  /** Per control particle: plan-view travel from rest in the passenger-cell frame (mm): height is not crush (the body masses carry no gravity, so they keep the height the hit left them at). */
  planMm: Record<string, number>;
  /** Per control particle: crush band reached (`-` under yield, `y` yield, `m` middle, `P` packed). */
  band: Record<string, string>;
  /** Largest particle travel, wheels (hubs) excluded (mm). */
  bodyMm: number;
  drivetrainAlive: boolean;
  /** Cabin intrusion: largest change in distance between any two cabin particles (mm). */
  cabinMm: number;
  /** Bumper-to-bumper shortening (mm). */
  shortenMm: number;
  /** Frontal (nose) and rear (tail) crush past the cell (mm). */
  noseMm: number;
  tailMm: number;
};

/** Cars built once per (slot, squash) and stood up again by `spawnFacing` (the engine's own scene reset, `resetVisual`) for each run: building one costs about as much as a pass of the hit. A run's cars take distinct slots. */
const slotCars = new Map<string, DeformableCar>();
function carAt(slot: number, squash?: number): DeformableCar {
  const key = `${slot}/${squash}`;
  let car = slotCars.get(key);
  if (!car) {
    car = makeCar("shape", squash);
    slotCars.set(key, car);
  }
  return car;
}

export function parkCar(squash?: number): DeformableCar {
  const car = carAt(0, squash);
  car.spawnFacing(0, 0, 0, 0);
  return car;
}

function launch(car: DeformableCar, x: number, z: number, yaw: number, kph: number): void {
  car.spawnFacing(x, z, yaw, kph / 3.6);
}

const CABIN = ["cell", "doorL", "doorR", "roof"];

/**
 * Damage in the passenger-cell frame: a plan-view rigid fit (rotation, translation, mean height)
 * of the cabin particles' body-frame positions onto their rest, so a shove or a frame drift of the
 * followed group reads as zero.
 */
export function carState(car: DeformableCar, side: -1 | 1 = 1): CarState {
  const detached: string[] = [];
  for (const p of car.snapshot().parts as { name: string; detached: boolean }[]) if (p.detached) detached.push(p.name);
  if (!detached.includes("mirrorR") && car.partOff("mirrorR")) detached.push("mirrorR");
  if (!detached.includes("mirrorL") && car.partOff("mirrorL")) detached.push("mirrorL");
  detached.sort();
  const d = car.deform;
  const cabin = d.masses.filter((m) => CABIN.includes(m.name));
  const fitCabin = fitRigid(d.masses, (m) => CABIN.includes(m.name));
  const fit = new Map<string, THREE.Vector3>();
  const planMm: Record<string, number> = {};
  const band: Record<string, string> = {};
  let bodyMm = 0;
  for (const m of d.masses) {
    const f = fitCabin(m.local.x, m.local.y, m.local.z).clone();
    fit.set(m.name, f);
    const t = f.distanceTo(m.rest);
    planMm[m.name] = Math.round(Math.hypot(f.x - m.rest.x, f.z - m.rest.z) * 1000);
    band[m.name] = t >= m.bands.max ? "P" : t >= m.bands.middle ? "m" : t >= m.bands.yield ? "y" : "-";
    if (!m.hub) bodyMm = Math.max(bodyMm, t * 1000);
  }
  let cabinMm = 0;
  for (let i = 0; i < cabin.length; i++) {
    for (let j = i + 1; j < cabin.length; j++) {
      const a = cabin[i]!;
      const b = cabin[j]!;
      cabinMm = Math.max(cabinMm, Math.abs(a.local.distanceTo(b.local) - a.rest.distanceTo(b.rest)) * 1000);
    }
  }
  const z = (n: string) => fit.get(n)!.z;
  const nose = (z("bumperFL") + z("bumperFR")) * 0.5;
  const tail = (z("bumperRL") + z("bumperRR")) * 0.5;
  const door = car.doorHinge(side);
  return {
    detached,
    doorDeg: door.theta / D2R,
    latched: door.latched,
    // A mirror that has left the car has no fold.
    mirrorFoldDeg: car.partOff(side > 0 ? "mirrorR" : "mirrorL") ? 0 : Math.abs(door.mirrorFold) / D2R,
    planMm,
    band,
    bodyMm: Math.round(bodyMm),
    drivetrainAlive: d.drivetrainAlive,
    cabinMm: Math.round(cabinMm),
    shortenMm: Math.round((4.12 - (nose - tail)) * 1000),
    noseMm: Math.round((2.06 - nose) * 1000),
    tailMm: Math.round((2.06 + tail) * 1000),
  };
}

/** The sim's readout of one car as text, so two reads are equal exactly when parts, door, latch, mirror, crush and cabin read the same to the test's own precision. */
function readoutKey(car: DeformableCar, side: -1 | 1 = 1): string {
  const s = carState(car, side);
  return [s.detached.join(), s.doorDeg.toFixed(2), s.latched, s.mirrorFoldDeg.toFixed(2), s.bodyMm, s.cabinMm, s.shortenMm, s.drivetrainAlive, ...Object.values(s.planMm)].join("|");
}

/** Sampling interval (s) of `stillWatch`, and how long (s) a readout must hold before a hit counts as played out. */
const STILL_SAMPLE_S = 0.1;
const STILL_HOLD_S = 0.5;

/** A per-step watch: `true` once `read()` has given the same text for `STILL_HOLD_S` s. A hit is run until its readout has stopped changing, not for a fixed settle. */
export function stillWatch(read: () => string): (dt: number) => boolean {
  let clock = 0;
  let sampledAt = 0;
  let changedAt = 0;
  let last = "";
  return (dt) => {
    clock += dt;
    if (clock - sampledAt < STILL_SAMPLE_S - 1e-9) return false;
    sampledAt = clock;
    const now = read();
    if (now !== last) {
      last = now;
      changedAt = clock;
    }
    return clock - changedAt >= STILL_HOLD_S;
  };
}

function speedOf(car: DeformableCar): number {
  return Math.hypot(car.velocity.x, car.velocity.z);
}

/** Run a world until every car is slow and contact has been over for `settle` s (or `cap` s); `watch` sees the world before its first frame. */
function runOut(cars: DeformableCar[], cap: number, settle = 1.5, watch?: (w: CrashWorld) => void): number {
  const w = makeWorld(cars, false, false, null);
  watch?.(w);
  let quiet = 0;
  let t = 0;
  for (; t < cap; t += FRAME) {
    tickWorld(w, FRAME);
    const moving = cars.some((c) => speedOf(c) > 0.3 && c.crashed);
    quiet = moving ? 0 : quiet + FRAME;
    if (w.clock.phase !== "approach" && quiet > settle) break;
  }
  return t;
}

/** Run a world until some car has crashed and every car's readout has held for `STILL_HOLD_S` (or `cap` s): the damage a hit leaves, not how far the wrecks slide on. */
function runUntilReadoutHeld(cars: DeformableCar[], cap: number): void {
  const w = makeWorld(cars, false, false, null);
  const still = stillWatch(() => cars.map((c) => readoutKey(c)).join("/"));
  for (let t = 0; t < cap; t += FRAME) {
    tickWorld(w, FRAME);
    const readoutHeld = still(FRAME);
    if (readoutHeld && cars.some((c) => c.crashed)) return;
  }
}

// ── Doors: a car sideswipes the parked car on the Doors ram lane ─────────────────────────────

let cageHalfMemo: { x: number; z: number } | null = null;
/** The stock car's cage plan half extents (m): the contact shape of a striker car, so the lane a car-shaped head sweeps and the place a striker car stands are the cage's, not the drawn nominal `CAR_HALF`. */
function cageHalf(): { x: number; z: number } {
  if (!cageHalfMemo) {
    const plan = makeCar().cage.fields.planBox;
    cageHalfMemo = { x: (plan[1]! - plan[0]!) / 2, z: (plan[3]! - plan[2]!) / 2 };
  }
  return cageHalfMemo;
}

/** The striker `b` has driven its whole length and `PASSED_MARGIN_M` more along the lane past the struck car `a`: it cannot touch it again. */
const PASSED_MARGIN_M = 0.5;
function hasPassed(lane: (typeof DOOR_LANES)[DoorScenario], a: DeformableCar, b: DeformableCar): boolean {
  return lane.dir * (b.group.position.z - a.group.position.z) > 2 * cageHalf().z + PASSED_MARGIN_M;
}

/** Run `w` until the striker has passed, its pass took at most the ram's whole travel at `kph`, and `read`'s outcome has held for `STILL_HOLD_S`; the ram's own travel and settle bound it. */
function runPass(w: CrashWorld, tyres: boolean, kph: number, passed: () => boolean, read: () => string): void {
  const still = stillWatch(read);
  const seconds = (RAM.start + RAM.end + 2 * cageHalf().z) / (kph / 3.6) + RAM.settle;
  for (let t = 0; t < seconds; t += FRAME) {
    if (tyres) tyresStep(w.cars, FRAME);
    tickWorld(w, FRAME);
    const readoutHeld = still(FRAME);
    if (readoutHeld && passed()) return;
  }
}

/**
 * A second car (its side face on the lane's inner edge, the lane's travel and speed) drives past
 * the parked car's `side`, its door set as the scenario sets it (`tyres`: both cars in neutral).
 */
export function carDoorPass(scenario: DoorScenario, kph: number, tyres = false, side: -1 | 1 = 1): CarState {
  const lane = DOOR_LANES[scenario];
  const a = parkCar();
  if (lane.part === "panel") a.setPanelOpen(side, lane.open);
  else a.setDoorOpen(side, lane.open);
  const b = carAt(1);
  const x = side * (lane.inner + cageHalf().x);
  // Leading face at the ram's start, so both runs cover the same ground.
  launch(b, x, -lane.dir * (RAM.start + cageHalf().z), lane.dir > 0 ? 0 : Math.PI, kph);
  const w = makeWorld([a, b], false, false, null);
  runPass(w, tyres, kph, () => hasPassed(lane, a, b), () => readoutKey(a, side));
  return carState(a, side);
}

/** The Doors ram; `carShaped`: a head with a car body's length, height and width on the same lane. */
export function ramDoorPass(scenario: DoorScenario, kph: number, kg: number, carShaped = false): CarState {
  const a = parkCar();
  const shape = carShaped ? { bottom: 0, top: 2 * CAR_HALF.y, width: 2 * cageHalf().x } : undefined;
  fireRam(a, scenario, { kph, kg, side: 1, length: carShaped ? 2 * cageHalf().z : RAM.length, shape, stillWhen: stillWatch(() => readoutKey(a)) });
  return carState(a);
}

/**
 * The frame swap of `carDoorPass`: the striker car stands still on the lane's inner edge and the door car reverses (or drives
 * on) into it at the same closing speed, brakes off, undriven (`tyres`: in neutral). Same relative start, so the same ground is covered.
 */
function reversingDoorPass(scenario: DoorScenario, kph: number, tyres = false, side: -1 | 1 = 1): CarState {
  const lane = DOOR_LANES[scenario];
  const u = kph / 3.6;
  const a = carAt(0);
  launchAt(a, 0, lane.dir * (RAM.start + cageHalf().z), 0, 0, -lane.dir * u);
  if (lane.part === "panel") a.setPanelOpen(side, lane.open);
  else a.setDoorOpen(side, lane.open);
  const b = carAt(1);
  b.spawnFacing(side * (lane.inner + cageHalf().x), 0, lane.dir > 0 ? 0 : Math.PI, 0);
  const w = makeWorld([a, b], false, false, null);
  runPass(w, tyres, kph, () => hasPassed(lane, a, b), () => readoutKey(a, side));
  return carState(a, side);
}

/** The four ways one door hit is delivered: the ram runs into a still car, a car runs into a still ram, a car stands in for the ram (runs into a still car), the struck car runs into that still car. */
type DoorForm = "ramMoves" | "carMoves" | "carStrikes" | "reversingCar";
export const DOOR_FORMS: readonly DoorForm[] = ["ramMoves", "carMoves", "carStrikes", "reversingCar"];

/**
 * One door hit in `form` on `side`. Tyre grip off (`grip` false) is the control: a zero-friction ground and no tyre model on any
 * car, so the four forms differ only by what is a real defect. Grip on runs every car through `applyDrive` in neutral (brakes off,
 * no thrust: the road's rolling and air drag and the tyres' grip, the only frame-dependent terms). A ram of a car's own mass gets a
 * car body's size of head.
 */
export function doorHit(form: DoorForm, scenario: DoorScenario, kph: number, kg: number, grip: boolean, side: -1 | 1 = 1): CarState {
  return onGround(grip, () => {
    if (form === "carStrikes") return carDoorPass(scenario, kph, grip, side);
    if (form === "reversingCar") return reversingDoorPass(scenario, kph, grip, side);
    const a = parkCar();
    const carShaped = Math.abs(kg - a.deform.totalMass) < 1;
    const shape = carShaped ? { bottom: 0, top: 2 * CAR_HALF.y, width: 2 * cageHalf().x } : undefined;
    fireRam(a, scenario, { kph, kg, side, length: carShaped ? 2 * cageHalf().z : RAM.length, shape, carMoves: form === "carMoves", tyres: grip, stillWhen: stillWatch(() => readoutKey(a, side)) });
    return carState(a, side);
  });
}

/** How far two door-hit outcomes are apart: parts and latch as one flag, angles in degrees, crush in mm (hubs excluded). */
export type DoorGap = { parts: boolean; doorDeg: number; mirrorDeg: number; crushMm: number; cabinMm: number };

export function doorGap(x: CarState, y: CarState): DoorGap {
  let crushMm = 0;
  for (const name of Object.keys(x.planMm)) if (!name.startsWith("hub")) crushMm = Math.max(crushMm, Math.abs(x.planMm[name]! - y.planMm[name]!));
  return {
    parts: x.detached.join() === y.detached.join() && x.latched === y.latched && x.drivetrainAlive === y.drivetrainAlive,
    doorDeg: Math.abs(x.doorDeg - y.doorDeg),
    mirrorDeg: Math.abs(x.mirrorFoldDeg - y.mirrorFoldDeg),
    crushMm,
    cabinMm: Math.abs(x.cabinMm - y.cabinMm),
  };
}

// ── Press vs two cars ──────────────────────────────────────────────────────────────────────

/** One rendered frame of the press scene: 4 slices (`fixedStep` order), then the skin. */
function pressFrame(p: CompactorRig, target: number): void {
  const car = p.car!;
  for (let s = 0; s < 4; s++) {
    p.step(FRAME / 4, target);
    car.afterContacts(FRAME / 4);
    if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(FRAME / 4);
    car.stepBreakage(FRAME / 4);
  }
  car.updateSkin();
}

/** Close the press (`CompactorRig`, the engine's) until `until` holds or the plates reach max. */
export function pressUntil(until: (p: CompactorRig) => boolean): { state: CarState; face: number; work: number } {
  const p = new CompactorRig(parkCar());
  for (let f = 0; f < 60 * 8 && !until(p); f++) pressFrame(p, COMPACTOR.maxFace);
  // Hold the plates so the structure settles at that face.
  for (let f = 0; f < 30; f++) pressFrame(p, p.face);
  return { state: carState(p.car!), face: p.face, work: p.work };
}

/** One slice's momentum (N·s) from the front and rear plate, and how many plates touched. */
type PressHit = { frontJ: number; rearJ: number; hits: number };

/** What a striker delivered to the car it hit: the momentum (N·s) it had lost along its travel at each slice start, and that time (s). */
type Delivered = { t: number[]; lost: number[] };
/** The forces a sandwich's two strikers put on the middle car, and the mass (kg) of one striker. */
type SandwichForce = { nose: Delivered; tail: Delivered; kg: number };

/** Record what `striker` (travelling along `dir` * z) loses slice by slice into `out`. */
function trackDelivered(w: CrashWorld, striker: DeformableCar, dir: 1 | -1, out: Delivered): void {
  const inner = w.world.beforeSlice!;
  let t = 0;
  let p0 = NaN;
  w.world.beforeSlice = (h) => {
    const p = striker.deform.totalMass * striker.velocity.z * dir;
    if (Number.isNaN(p0)) p0 = p;
    out.t.push(t);
    out.lost.push(p0 - p);
    t += h;
    return inner(h);
  };
}

/** The momentum `d` had delivered by `t` (linear between its slices; held at its ends). */
function deliveredAt(d: Delivered, t: number): number {
  const last = d.t.length - 1;
  if (t <= d.t[0]!) return d.lost[0]!;
  if (t >= d.t[last]!) return d.lost[last]!;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d.t[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return d.lost[lo]! + ((d.lost[hi]! - d.lost[lo]!) * (t - d.t[lo]!)) / (d.t[hi]! - d.t[lo]!);
}

type Plate = { box: ContactBox; end: 1 | -1; given: Delivered; face: number; u: number };

/**
 * The press with force-driven plates: each plate is a body of `kg` that the momentum a sandwich's striker delivered pushes
 * toward the car (so the plate takes the striker's place: same push over time, no speed or shortening target), and that the car's
 * reaction (`strikeCar`'s impulse) pushes back. The slab, the contact and the crash rules are `CompactorRig.step`'s; only the
 * plate's motion differs. The plates stop where they are once the delivered momentum is spent.
 */
class ForcePress extends CompactorRig {
  private tau: number;
  private readonly end: number;
  private readonly plates: Plate[];
  private readonly kg: number;

  constructor(car: DeformableCar, force: SandwichForce) {
    super(car);
    this.kg = force.kg;
    const start = (d: Delivered) => d.t[d.lost.findIndex((j) => j > 0.5)]!;
    this.tau = Math.min(start(force.nose), start(force.tail));
    this.end = Math.max(force.nose.t[force.nose.t.length - 1]!, force.tail.t[force.tail.t.length - 1]!);
    const face = COMPACTOR.bumperZ + 0.02;
    this.plates = [
      { box: this.front, end: 1, given: force.nose, face, u: 0 },
      { box: this.rear, end: -1, given: force.tail, face, u: 0 },
    ];
    this.face = face;
  }

  get spent(): boolean {
    return this.tau >= this.end;
  }

  override step(dt: number): PressHit {
    const car = this.car!;
    const hit = { frontJ: 0, rearJ: 0, hits: 0 };
    const was = this.tau;
    this.tau += dt;
    car.integrate(dt);
    car.refreshBasis();
    for (const p of this.plates) {
      // the compactor's slab (compactor.ts PLATE), here with a mass and the speed the push has given it
      p.box.x = 0;
      p.box.y = 1.02;
      p.box.z = p.end * (p.face + 0.24);
      p.box.hx = 1.8;
      p.box.hy = 1.05;
      p.box.hz = 0.24;
      p.box.yaw = p.end > 0 ? Math.PI : 0;
      p.box.vx = 0;
      p.box.vz = -p.end * p.u;
      p.box.kg = this.kg;
      p.box.hardness = 1;
      const j = strikeCar(car, p.box, dt, true);
      if (bodyHit.touching) {
        car.noteContactEnd(p.end, p.face);
        hit.hits++;
      }
      if (p.end > 0) hit.frontJ = j;
      else hit.rearJ = j;
      p.u += (deliveredAt(p.given, this.tau) - deliveredAt(p.given, was) - j) / this.kg;
    }
    if (car.deform.massActive) {
      car.deform.stepStructure(dt, car.group.quaternion);
      for (const p of this.plates) strikeCar(car, p.box, dt, false);
      car.syncPose(dt);
    }
    for (const p of this.plates) {
      if (this.spent || p.face <= COMPACTOR.maxFace) p.u = 0;
      p.face = Math.max(COMPACTOR.maxFace, p.face - p.u * dt);
      this.work += p.u * (p.end > 0 ? hit.frontJ : hit.rearJ);
    }
    this.face = Math.min(this.plates[0]!.face, this.plates[1]!.face);
    if (car.crashed) this.contacted = true;
    return hit;
  }
}

/** Push the press's plates with the force a sandwich's strikers delivered, until it is spent; the car's state after it settles. */
export function pressByForce(force: SandwichForce): { state: CarState; face: number; work: number } {
  const p = new ForcePress(parkCar(), force);
  for (let f = 0; f < 60 * 12 && !p.spent; f++) pressFrame(p, COMPACTOR.maxFace);
  for (let f = 0; f < 30; f++) pressFrame(p, p.face);
  return { state: carState(p.car!), face: p.face, work: p.work };
}

/** Bumper-to-bumper shortening of a car (m), read live. */
export function shortening(car: DeformableCar): number {
  const d = car.deform;
  if (!d.massActive) return 0;
  const z = (n: MassName) => d.massLocal(n).z;
  return 4.12 - ((z("bumperFL") + z("bumperFR")) * 0.5 - (z("bumperRL") + z("bumperRR")) * 0.5);
}

export type Sandwich = { a: CarState; b: CarState; c: CarState; keLostJ: number; aShareJ: number; seconds: number; force: SandwichForce };

/**
 * Two cars at `kph` each into the nose and tail of a parked third, square. Energy to the middle
 * car: the run's kinetic-energy loss split by bumper-to-bumper shortening (same structure, so
 * same crush force per metre).
 */
export function carSandwich(kph: number): Sandwich {
  const a = parkCar();
  const b = carAt(1);
  const c = carAt(2);
  const force: SandwichForce = { nose: { t: [], lost: [] }, tail: { t: [], lost: [] }, kg: b.deform.totalMass };
  launch(b, 0, STRIKE_GAP, Math.PI, kph);
  launch(c, 0, -STRIKE_GAP, 0, kph);
  const ke0 = 0.5 * (b.deform.totalMass + c.deform.totalMass) * (kph / 3.6) ** 2;
  const seconds = runOut([a, b, c], 10, 1.5, (w) => {
    trackDelivered(w, b, -1, force.nose);
    trackDelivered(w, c, 1, force.tail);
  });
  let ke1 = 0;
  for (const car of [a, b, c]) ke1 += 0.5 * car.deform.totalMass * speedOf(car) ** 2;
  const sa = shortening(a);
  const sum = sa + shortening(b) + shortening(c);
  const keLostJ = ke0 - ke1;
  return { a: carState(a), b: carState(b), c: carState(c), keLostJ, aShareJ: sum > 1e-6 ? (keLostJ * sa) / sum : 0, seconds, force };
}

// ── Piston vs car ──────────────────────────────────────────────────────────────────────────

/** Where a striker meets the parked car: the piston's `front`, `rear` and `right` heads. */
export type Strike = "front" | "rear" | "right";

/** `carMoves`: the frame swap, the head stands still and the car drives into it at the head's speed. */
export function pistonStrike(at: Strike, kph: number, kg: number, hardness: number, squash?: number, carMoves = false): CarState {
  const a = carAt(0, squash);
  const still = stillWatch(() => readoutKey(a));
  firePiston(a, at, { speedKph: kph, massKg: kg, hardness, after: 1.5, carMoves, onSlice: (_rig, head) => still(FRAME / 2) && head.contacted });
  return carState(a);
}

/**
 * A car of the same mass at the same speed square into the parked car's nose, tail or right side (at the door line, like the
 * piston). `carMoves`: the frame swap, the striker stands still where it would have hit and the struck car drives into it.
 */
export function carStrike(at: Strike, kph: number, squash?: number, carMoves = false): { a: CarState; b: CarState } {
  const a = parkCar(squash);
  a.parked = !carMoves;
  const b = carAt(1, squash);
  const [x, z, yaw] = at === "front" ? [0, STRIKE_GAP, Math.PI] : at === "rear" ? [0, -STRIKE_GAP, 0] : [CAR_HALF.x + CAR_HALF.z + 0.25, 0.08, -Math.PI / 2];
  if (carMoves) {
    const u = kph / 3.6;
    b.spawnFacing(x, z, yaw, 0);
    launchAt(a, 0, 0, 0, -Math.sin(yaw) * u, -Math.cos(yaw) * u);
  } else launch(b, x, z, yaw, kph);
  runUntilReadoutHeld([a, b], 8);
  return { a: carState(a), b: carState(b) };
}

/** An asphalt plane at y = 0 with no grip: the control for what the tyres add to a frame swap. */
class SlipGround extends Ground {
  constructor() {
    super();
    this.addGrid({ nu: 2, nv: 2, step: 2e7, stepV: 2e7, u0: -1e7, v0: -1e7, heights: new Float32Array(4), ox: 0, oy: 0, oz: 0, reach: Infinity, grip: 0 });
  }
}

/** `run` on a ground with the tyre grip as asked: off is a zero-friction ground under every car (the control for what the tyres add to a frame swap). */
export function onGround<T>(grip: boolean, run: () => T): T {
  if (!grip) setGround(new SlipGround());
  try {
    return run();
  } finally {
    setGround(null);
  }
}

// ── Comparison ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-particle plan-view crush agrees within 15 % or 10 mm, whichever is larger. The cabin particles are the fit's
 * own anchors: their travel is the fit's residual (a cabin tilt of θ reads as θ times the particle's height above
 * the cell), and the cabin's intrusion is compared on its own as the change of every pair distance (`cabinMm`).
 */
export function crushMismatch(x: CarState, y: CarState): string[] {
  const out: string[] = [];
  for (const name of Object.keys(x.planMm)) {
    if (name.startsWith("hub") || CABIN.includes(name)) continue;
    const p = x.planMm[name]!;
    const q = y.planMm[name]!;
    if (Math.abs(p - q) > Math.max(10, 0.15 * Math.max(p, q))) out.push(`${name} ${p}/${q}`);
  }
  return out;
}

// ── A police sedan into a sedan's side: do the drawn bodies pass through each other? ───────────

type SideHit = {
  /** Deepest the striker's drawn skin lay inside the struck car's drawn right side at the end of any frame (m). */
  overlapM: number;
  /** After they separate: the struck right side's deepest inward travel from rest (mm) and the striker's nose crush (mm). */
  intrusionMm: number;
  noseMm: number;
};

/** The struck car's drawn right side: the highest x of its skin per 0.1 m of height and length, in its own body frame. */
function rightSide(car: DeformableCar, side: Map<number, number>): void {
  side.clear();
  const pos = car.body.geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x <= 0) continue;
    const key = Math.round(pos.getY(i) * 10) * 1000 + Math.round(pos.getZ(i) * 10);
    side.set(key, Math.max(side.get(key) ?? 0, x));
  }
}

const _p = new THREE.Vector3();
const _toStruck = new THREE.Matrix4();

/** How deep (m) the striker's skin vertices lie inside `side` (`rightSide` of `struck`), the deepest of them. */
function skinOverlap(striker: DeformableCar, struck: DeformableCar, side: Map<number, number>): number {
  striker.body.updateWorldMatrix(true, false);
  struck.body.updateWorldMatrix(true, false);
  _toStruck.copy(struck.body.matrixWorld).invert().multiply(striker.body.matrixWorld);
  const pos = striker.body.geometry.getAttribute("position") as THREE.BufferAttribute;
  let deepest = 0;
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i).applyMatrix4(_toStruck);
    const out = side.get(Math.round(_p.y * 10) * 1000 + Math.round(_p.z * 10));
    if (out !== undefined && _p.x > 0 && _p.x < out) deepest = Math.max(deepest, out - _p.x);
  }
  return deepest;
}

/** The police sedan, built once like the pooled cars. */
let policeCar: DeformableCar | null = null;

/**
 * A police sedan at `mps` m/s nose-first into the right side of a parked sedan, run at the pacer's pinned slice (`SimPacer.pin`:
 * false 1/240 s, true 1/80 s) until both have stopped. The overlap is read once per frame, on the skin that frame draws.
 */
export function copIntoSide(mps: number, coarse: boolean): SideHit {
  const struck = parkCar();
  const cop = (policeCar ??= makeClassCar("police"));
  launch(cop, CAR_HALF.x + CAR_HALF.z + 0.25, 0.08, -Math.PI / 2, mps * 3.6);
  const w = newWorld([struck, cop], null);
  const pacer = new SimPacer();
  pacer.pin = coarse;
  const side = new Map<number, number>();
  let overlapM = 0;
  let quiet = 0;
  for (let t = 0; t < 10 && quiet < 1.5; t += FRAME) {
    pacer.run(FRAME, 1, sliceSpeed(w.cars), true, Infinity, (h) => {
      w.fine = pacer.fine;
      stepWorld(w, h);
      for (const car of w.cars) {
        if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
        car.stepBreakage(h);
      }
    });
    for (const car of w.cars) car.updateSkin();
    rightSide(struck, side);
    overlapM = Math.max(overlapM, skinOverlap(cop, struck, side));
    quiet = w.cars.some((c) => speedOf(c) > 0.3 && c.crashed) ? 0 : quiet + FRAME;
  }
  let inward = 0;
  for (const m of struck.deform.masses) if (m.rest.x > 0.4 && !m.hub) inward = Math.max(inward, m.rest.x - m.local.x);
  return { overlapM, intrusionMm: Math.round(inward * 1000), noseMm: carState(cop).noseMm };
}
