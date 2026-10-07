import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { bodyContact, bodyHit, makeBox, type ContactBox } from "../contact/external-contact.ts";
import type { StreamedDeformation } from "../deform/streamed-deform.ts";

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

/** Plate slab (m): half thickness along the travel, half width, half height and centre height. */
export const PLATE = { hz: 0.24, hx: 1.8, hy: 1.05, y: 1.02 } as const;

type CompactorStage = "open" | "contact" | "wells" | "mid" | "max";

export function compactorStage(face: number): CompactorStage {
  if (face >= COMPACTOR.startFace - 0.02) return "open";
  if (face > COMPACTOR.wellFace) return "contact";
  if (face > COMPACTOR.midFace) return "wells";
  if (face > COMPACTOR.maxFace + 0.02) return "mid";
  return "max";
}

type WallHit = { frontJ: number; rearJ: number; hits: number };

/** Plate `end` (+1 front, −1 rear) with its face at |z| = `face`, closing at `speed`. */
function placePlate(box: ContactBox, end: 1 | -1, face: number, speed: number): void {
  box.x = 0;
  box.y = PLATE.y;
  box.z = end * (face + PLATE.hz);
  box.hx = PLATE.hx;
  box.hy = PLATE.hy;
  box.hz = PLATE.hz;
  box.yaw = end > 0 ? Math.PI : 0;
  box.vx = 0;
  box.vz = -end * speed;
  box.kg = Infinity;
  box.hardness = 1;
}

/**
 * The press scene's physics on a car parked at the origin facing +Z: the plates are a kinematic
 * driver only; the car meets them through the shared striker contact (`bodyContact`, the same
 * crush path a barrier or a piston face takes) and the shared crash rules
 * (`DeformableCar.noteContactEnd`: two struck ends make a squeeze). DOM-free: the engine and the
 * tests run the same `step`.
 */
export class CompactorRig {
  car: DeformableCar | null = null;
  face: number = COMPACTOR.startFace;
  frontJ = 0;
  rearJ = 0;
  /** Plate work on the car (J): Σ plate impulse × plate speed. */
  work = 0;
  maxGroupY = 0;
  maxCellY = 0;
  contacted = false;
  readonly front = makeBox();
  readonly rear = makeBox();
  private readonly hit: WallHit = { frontJ: 0, rearJ: 0, hits: 0 };

  constructor(car?: DeformableCar) {
    if (car) this.attach(car);
  }

  /** Open the plates on `car` (already parked at the origin, at rest). */
  attach(car: DeformableCar): void {
    this.car = car;
    this.face = COMPACTOR.startFace;
    this.frontJ = 0;
    this.rearJ = 0;
    this.work = 0;
    this.maxGroupY = 0;
    this.maxCellY = 0;
    this.contacted = false;
  }

  get d(): StreamedDeformation {
    return this.car!.deform;
  }

  get group(): THREE.Group {
    return this.car!.group;
  }

  get geom(): THREE.BufferGeometry {
    return this.car!.body.geometry;
  }

  get stage(): CompactorStage {
    return compactorStage(this.face);
  }

  /** One physics slice: move the plates toward `targetFace`, then the car against them. */
  step(dt: number, targetFace: number = COMPACTOR.maxFace): WallHit {
    const car = this.car!;
    const hit = this.hit;
    const moving = this.face > targetFace;
    this.face = Math.max(targetFace, this.face - COMPACTOR.speed * dt);
    const speed = moving ? COMPACTOR.speed : 0;
    car.refreshBasis();
    placePlate(this.front, 1, this.face, speed);
    placePlate(this.rear, -1, this.face, speed);
    hit.hits = 0;
    hit.frontJ = bodyContact(car, this.front, dt, true);
    if (bodyHit.touching) {
      car.noteContactEnd(1, this.face);
      hit.hits++;
    }
    hit.rearJ = bodyContact(car, this.rear, dt, true);
    if (bodyHit.touching) {
      car.noteContactEnd(-1, this.face);
      hit.hits++;
    }
    if (car.deform.massActive) {
      car.deform.stepStructure(dt);
      bodyContact(car, this.front, dt, false);
      bodyContact(car, this.rear, dt, false);
      car.syncPose(dt);
    }
    if (car.crashed) this.contacted = true;
    this.frontJ += hit.frontJ;
    this.rearJ += hit.rearJ;
    this.work += (hit.frontJ + hit.rearJ) * speed;
    this.maxGroupY = Math.max(this.maxGroupY, car.group.position.y);
    if (car.deform.massActive) this.maxCellY = Math.max(this.maxCellY, car.deform.massWorld("cell").y);
    return hit;
  }

  /** Close to `targetFace` one `dt` frame at a time, the car's frame tail included. */
  runTo(targetFace: number, dt = 1 / 60, cap = 2400): number {
    const car = this.car!;
    let n = 0;
    while (this.face > targetFace + 1e-4 && n < cap) {
      this.step(dt, targetFace);
      car.afterContacts(dt);
      car.stepBreakage(dt);
      car.updateSkin();
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
