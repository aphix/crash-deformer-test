import * as THREE from "three";
import { CAR_HALF, type DeformableCar } from "./car.ts";
import { COMPACTOR, enforceWalls } from "./compactor.ts";
import { makeCar, makeWorld, tickWorld } from "./crash-scenarios.test-util.ts";
import { DOOR_LANES, fireRam, RAM, type DoorScenario } from "./door-rig.ts";
import { firePiston } from "./piston-rig.ts";

/**
 * Matched pairs for docs/CONTACT_PARITY.md: the same hit delivered by a scene rig (Doors ram,
 * press, piston) and by other cars through the engine's `fixedStep` order (`tickWorld`).
 * Not a test file itself.
 */

const FRAME = 1 / 60;
const D2R = Math.PI / 180;

export type CarState = {
  detached: string[];
  /** Right (+x) door angle (deg) and latch; the probes strike the right side. */
  doorDeg: number;
  latched: boolean;
  /** Per control particle: travel from rest in the passenger-cell frame (mm). */
  travelMm: Record<string, number>;
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

export function parkCar(): DeformableCar {
  const car = makeCar();
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
export function carState(car: DeformableCar): CarState {
  const detached: string[] = [];
  for (const p of car.snapshot().parts as { name: string; detached: boolean }[]) if (p.detached) detached.push(p.name);
  if (!detached.includes("mirrorR") && car.partOff("mirrorR")) detached.push("mirrorR");
  if (!detached.includes("mirrorL") && car.partOff("mirrorL")) detached.push("mirrorL");
  detached.sort();
  const d = car.deform;
  const cabin = d.masses.filter((m) => CABIN.includes(m.name));
  let px = 0;
  let pz = 0;
  let qx = 0;
  let qz = 0;
  let dy = 0;
  for (const m of cabin) {
    px += m.local.x / cabin.length;
    pz += m.local.z / cabin.length;
    qx += m.rest.x / cabin.length;
    qz += m.rest.z / cabin.length;
    dy += (m.local.y - m.rest.y) / cabin.length;
  }
  let dot = 0;
  let cross = 0;
  for (const m of cabin) {
    const ax = m.local.x - px;
    const az = m.local.z - pz;
    const bx = m.rest.x - qx;
    const bz = m.rest.z - qz;
    dot += ax * bx + az * bz;
    cross += bz * ax - bx * az;
  }
  const th = Math.atan2(cross, dot);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const fit = new Map<string, THREE.Vector3>();
  const travelMm: Record<string, number> = {};
  const band: Record<string, string> = {};
  let bodyMm = 0;
  for (const m of d.masses) {
    const x = m.local.x - px;
    const z = m.local.z - pz;
    const f = new THREE.Vector3(c * x - s * z + qx, m.local.y - dy, s * x + c * z + qz);
    fit.set(m.name, f);
    const t = f.distanceTo(m.rest);
    travelMm[m.name] = Math.round(t * 1000);
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
  const door = car.doorHinge(1);
  return {
    detached,
    doorDeg: door.theta / D2R,
    latched: door.latched,
    mirrorFoldDeg: Math.abs(door.mirrorFold) / D2R,
    travelMm,
    band,
    bodyMm: Math.round(bodyMm),
    drivetrainAlive: d.drivetrainAlive,
    cabinMm: Math.round(cabinMm),
    shortenMm: Math.round((4.12 - (nose - tail)) * 1000),
    noseMm: Math.round((2.06 - nose) * 1000),
    tailMm: Math.round((2.06 + tail) * 1000),
  };
}

function speedOf(car: DeformableCar): number {
  return Math.hypot(car.velocity.x, car.velocity.z);
}

/** Run a world until every car is slow and contact has been over for `settle` s (or `cap` s). */
function runOut(cars: DeformableCar[], cap: number, settle = 1.5): number {
  const w = makeWorld(cars, false, false);
  let quiet = 0;
  let t = 0;
  for (; t < cap; t += FRAME) {
    tickWorld(w, FRAME);
    const moving = cars.some((c) => speedOf(c) > 0.3 && c.crashed);
    quiet = moving ? 0 : quiet + FRAME;
    if (w.impact && quiet > settle) break;
  }
  return t;
}

// ── Doors: a car sideswipes the parked car on the Doors ram lane ─────────────────────────────

/**
 * A second car (its side face on the lane's inner edge, the lane's travel and speed) drives past
 * the parked car's right side, its door set as the scenario sets it.
 */
export function carDoorPass(scenario: DoorScenario, kph: number): { a: CarState; b: DeformableCar; seconds: number } {
  const lane = DOOR_LANES[scenario];
  const a = parkCar();
  a.setDoorOpen(1, lane.open);
  const b = makeCar();
  const x = lane.inner + CAR_HALF.x;
  // Leading face at the ram's start, so both runs cover the same ground.
  launch(b, x, -lane.dir * (RAM.start + CAR_HALF.z), lane.dir > 0 ? 0 : Math.PI, kph);
  const w = makeWorld([a, b], false, false);
  const travel = RAM.start + RAM.end + 2 * CAR_HALF.z;
  const seconds = travel / (kph / 3.6) + RAM.settle;
  for (let t = 0; t < seconds; t += FRAME) tickWorld(w, FRAME);
  return { a: carState(a), b, seconds };
}

export function ramDoorPass(scenario: DoorScenario, kph: number, kg: number): CarState {
  const a = parkCar();
  fireRam(a, scenario, { kph, kg, side: 1 });
  return carState(a);
}

// ── Press vs two cars ──────────────────────────────────────────────────────────────────────

/** The engine's `stepCompactor` (engine.ts) on a parked car, one physics slice at a time. */
export class CarPress {
  face: number = COMPACTOR.startFace;
  /** Plate work on the car (J): Σ plate impulse × plate speed. */
  work = 0;
  readonly car: DeformableCar;
  constructor(car: DeformableCar) {
    this.car = car;
    car.deform.bidirectional = true;
    car.deform.deepCrush = false;
  }

  slice(dt: number, target: number): void {
    const car = this.car;
    this.face = Math.max(target, this.face - COMPACTOR.speed * dt);
    car.refreshBasis();
    if (!car.deform.massActive && this.face < COMPACTOR.bumperZ + 0.12) {
      car.deform.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 18, 18, car.group, car.velocity, car.angular);
      car.crashed = true;
    }
    car.deform.bidirectional = true;
    car.deform.deepCrush = this.face < COMPACTOR.midFace;
    if (car.deform.massActive) {
      car.deform.notifyContact();
      const hit = enforceWalls(car.deform, this.face, dt);
      this.work += (hit.frontJ + hit.rearJ) * COMPACTOR.speed;
      car.deform.stepStructure(dt);
      enforceWalls(car.deform, this.face, dt);
      car.syncPose(dt);
    }
    car.afterContacts(dt);
  }

  /** One rendered frame (4 slices, then the skin), as the engine runs it at 60 Hz. */
  frame(target: number): void {
    for (let s = 0; s < 4; s++) {
      this.slice(FRAME / 4, target);
      if (this.car.deform.massActive && !this.car.deform.drivetrainAlive) this.car.deform.cutDrive(FRAME / 4);
    }
    this.car.updateDeform(FRAME);
  }
}

/** Close the press until `until(state)` holds or the plates reach `COMPACTOR.maxFace`. */
export function pressUntil(until: (p: CarPress) => boolean): { state: CarState; face: number; work: number } {
  const p = new CarPress(parkCar());
  for (let f = 0; f < 60 * 8 && !until(p); f++) p.frame(COMPACTOR.maxFace);
  // Hold the plates so the structure settles at that face.
  for (let f = 0; f < 30; f++) p.frame(p.face);
  return { state: carState(p.car), face: p.face, work: p.work };
}

/** Bumper-to-bumper shortening of a car (m), read live. */
export function shortening(car: DeformableCar): number {
  const d = car.deform;
  if (!d.massActive) return 0;
  const z = (n: string) => d.massLocal(n).z;
  return 4.12 - ((z("bumperFL") + z("bumperFR")) * 0.5 - (z("bumperRL") + z("bumperRR")) * 0.5);
}

export type Sandwich = { a: CarState; b: CarState; c: CarState; keLostJ: number; aShareJ: number; seconds: number };

/**
 * Two cars at `kph` each into the nose and tail of a parked third, square. Energy to the middle
 * car: the run's kinetic-energy loss split by bumper-to-bumper shortening (same structure, so
 * same crush force per metre).
 */
export function carSandwich(kph: number): Sandwich {
  const a = parkCar();
  const b = makeCar();
  const c = makeCar();
  const gap = 2 * CAR_HALF.z + 0.25;
  launch(b, 0, gap, Math.PI, kph);
  launch(c, 0, -gap, 0, kph);
  const ke0 = 0.5 * (b.deform.totalMass + c.deform.totalMass) * (kph / 3.6) ** 2;
  const seconds = runOut([a, b, c], 10);
  let ke1 = 0;
  for (const car of [a, b, c]) ke1 += 0.5 * car.deform.totalMass * speedOf(car) ** 2;
  const sa = shortening(a);
  const sum = sa + shortening(b) + shortening(c);
  const keLostJ = ke0 - ke1;
  return { a: carState(a), b: carState(b), c: carState(c), keLostJ, aShareJ: sum > 1e-6 ? (keLostJ * sa) / sum : 0, seconds };
}

// ── Piston vs car ──────────────────────────────────────────────────────────────────────────

export function pistonFront(kph: number, kg: number, hardness: number): CarState {
  const a = makeCar();
  firePiston(a, "front", { speedKph: kph, massKg: kg, hardness, after: 1.5 });
  return carState(a);
}

/** A car of the same mass at the same speed square into the parked car's nose. */
export function carFront(kph: number): { a: CarState; b: CarState } {
  const a = parkCar();
  const b = makeCar();
  launch(b, 0, 2 * CAR_HALF.z + 0.25, Math.PI, kph);
  runOut([a, b], 8);
  return { a: carState(a), b: carState(b) };
}

// ── Comparison ─────────────────────────────────────────────────────────────────────────────

/** Per-particle crush agrees within 15 % or 10 mm, whichever is larger. */
export function crushMismatch(x: CarState, y: CarState): string[] {
  const out: string[] = [];
  for (const name of Object.keys(x.travelMm)) {
    if (name.startsWith("hub")) continue;
    const p = x.travelMm[name]!;
    const q = y.travelMm[name]!;
    if (Math.abs(p - q) > Math.max(10, 0.15 * Math.max(p, q))) out.push(`${name} ${p}/${q}`);
  }
  return out;
}
