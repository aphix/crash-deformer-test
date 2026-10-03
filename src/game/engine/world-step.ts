import * as THREE from "three";
import { bleedAfterSlide, DeformableCar } from "../vehicle/car.ts";
import type { WorldBounce } from "../vehicle/car-core.ts";
import { StrongestContact, type ContactHit, type JerseyBarrier } from "../scenes/engine-props.ts";
import { partContactPair } from "../contact/external-contact.ts";
import { resolveCarPair } from "../contact/pair-contact.ts";
import { shareHeight } from "../contact/sat.ts";
import { leftoverCrumple } from "../deform/physics-util.ts";
import type { EjectionWatch } from "../vehicle/ejection.ts";
import { CONTACT_HZ, nearContact } from "../vehicle/car-air.ts";
import { CarSurfaces } from "../vehicle/car-surfaces.ts";

/**
 * Everything one physics step touches besides the cars. The engine fills it per scene; a headless harness
 * sets the parts its scenario has. The hooks run at fixed points of the step, in car order.
 */
export type World = {
  /** Live cars, slot order. */
  cars: readonly DeformableCar[];
  /** The jersey slab while it is in the scene. */
  barrier: JerseyBarrier | null;
  /** Per car index, set when the slab took a hit from it. */
  barrierHits: boolean[];
  /** Loose parts bounce off the ground, cars and props (`afterContacts`). */
  bounce: WorldBounce | undefined;
  /** Cleared each step, then offered every hit: the strongest one is the step's impact. */
  readonly strongest: StrongestContact;
  /** Before each slice; true when it stepped the slice itself (a rig scene drives its car). */
  beforeSlice: ((h: number) => boolean) | null;
  /** Each SAT pair hit, before it is offered to `strongest`; `first` on the slice's first pass (cars in physical contact). */
  pairHit: ((a: number, b: number, hit: ContactHit, first: boolean) => void) | null;
  /** Ramp balls against one car: its hit, if any. */
  ballHit: ((car: DeformableCar) => ContactHit | null) | null;
  /** Lamp poles against one car: whether one moved it. */
  poleHit: ((car: DeformableCar) => boolean) | null;
  /** Each car right after its `afterContacts` (the derby bowl). */
  afterCar: ((car: DeformableCar, h: number) => void) | null;
  /** Each car at the end of a slice (race walls and props). */
  collide: ((car: DeformableCar, i: number) => void) | null;
  /**
   * Decides, at the end of every step, whether a disabling hit throws a driver out (`car.driverOut`, an `Ejection`
   * event). Null where the cars' record already says who was thrown when: a highlight replay.
   */
  ejection: EjectionWatch | null;
  /** What a body in flight stands on besides the ground: the other cars' tops (and the roofs' load crush). */
  surfaces: CarSurfaces;
};

export function newWorld(cars: readonly DeformableCar[], barrier: JerseyBarrier | null = null, ejection: EjectionWatch | null = null): World {
  return {
    cars,
    barrier,
    barrierHits: [],
    bounce: undefined,
    strongest: new StrongestContact(),
    beforeSlice: null,
    pairHit: null,
    ballHit: null,
    poleHit: null,
    afterCar: null,
    collide: null,
    ejection,
    surfaces: new CarSurfaces(),
  };
}

/**
 * One fixed step of the world (`dt` from `physicsSlice`), split into 1–3 slices: integrate or pose, mass pair
 * contact and part contact, up to three SAT passes (slab, car pairs, balls, poles), then the structure step,
 * slab clip and `afterContacts` per car.
 */
export function stepWorld(w: World, dt: number): void {
  const { cars, barrier, strongest } = w;
  let nearWall = false;
  if (barrier) {
    for (const car of cars) {
      if (car.group.position.lengthSq() < 160) {
        nearWall = true;
        break;
      }
    }
  }
  let slices = nearWall && dt > 0.006 ? 3 : dt > 0.012 ? 2 : 1;
  // A body in flight whose face is yielding to its load, or that stands on another car, is solved at CONTACT_HZ whatever the frame rate.
  if (dt * CONTACT_HZ > slices + 1e-6) {
    for (const car of cars) {
      if (nearContact(car)) {
        slices = Math.min(8, Math.ceil(dt * CONTACT_HZ - 1e-6));
        break;
      }
    }
  }
  const h = dt / slices;
  strongest.clear();

  for (let i = 0; i < slices; i++) {
    if (w.beforeSlice?.(h)) continue;
    w.surfaces.cars = cars;
    for (const car of cars) {
      car.surfaces = w.surfaces;
      // A wreck its masses hand to flight here (`syncPose`) flies this slice: handed over before the masses took it,
      // and left at that, it lost the slice's motion.
      if (car.deform.massActive) car.syncPose(h);
      if (car.deform.massActive) continue;
      car.integrate(h);
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
        // Cars at different heights (one flying over the other, on a bridge over it) never touch; nor does a fake falling off the fleet disc.
        if (dx * dx + dz * dz > 28 || !shareHeight(ca, cb) || ca.falling || cb.falling) continue;
        if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform, h);
        partContactPair(ca, cb);
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
        for (let ci = 0; ci < cars.length; ci++) {
          const hit = barrier.resolve(cars[ci]!, true, feed, h);
          if (hit) {
            w.barrierHits[ci] = true;
            moved = true;
            strongest.offer(hit);
          }
        }
      }

      for (let a = 0; a < cars.length; a++) {
        for (let b = a + 1; b < cars.length; b++) {
          if (barrier && barrier.blocksPair(cars[a]!, cars[b]!)) continue;
          if (!shareHeight(cars[a]!, cars[b]!) || cars[a]!.falling || cars[b]!.falling) continue;
          const pair = resolveCarPair(cars[a]!, cars[b]!, feed, h);
          if (pair) {
            moved = true;
            w.pairHit?.(a, b, pair, feed);
            strongest.offer(pair);
          }
        }
      }

      if (w.ballHit) {
        for (const car of cars) {
          const ballHit = w.ballHit(car);
          if (ballHit) {
            moved = true;
            strongest.offer(ballHit);
          }
        }
      }
      if (w.poleHit) {
        for (const car of cars) if (w.poleHit(car)) moved = true;
      }

      if (barrier) {
        for (const car of cars) {
          if (barrier.resolve(car, false, false, h)) moved = true;
        }
      }
      if (!moved) break;
    }

    for (const car of cars) {
      if (car.deform.massActive) car.deform.stepStructure(h);
      if (car.deform.massActive) car.syncPose(h);
      if (barrier) barrier.clip(car);
      car.afterContacts(h, w.bounce);
      w.afterCar?.(car, h);
    }
    if (w.collide) for (let ci = 0; ci < cars.length; ci++) w.collide(cars[ci]!, ci);
  }
  w.ejection?.step(cars, dt);
}

/**
 * After each `stepWorld` (`CrashEngine.tickInner`, a highlight replay): a dead drivetrain's drive bleeds away, and with
 * `bleed` (the crash clock is past the hit) a wreck slides to a stop on tyre-style friction.
 */
export function settleStep(cars: readonly DeformableCar[], h: number, bleed: boolean): void {
  for (const car of cars) {
    if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
    if (bleed && car.crashed) bleedAfterSlide(car, h);
  }
}

/** Warm-up crashes: car A at (x, z) facing `yaw` at 14 m/s into car B parked at the origin facing `yawB`, or driving at `vB`. */
const WARM_HITS = [
  // Head-on, 14 m/s each (100 km/h closing), noses 1.7 m apart.
  [0, -6, 0, Math.PI, 14],
  // T-bone into a parked car's door.
  [-4.5, 0, Math.PI / 2, 0, 0],
] as const;

/**
 * Run two throwaway crashes through `stepWorld` (1 s each) so V8 has compiled the crush path before play.
 * Cold, a race's first crashes ran it unoptimised: single frames took 21–27 ms of physics headless (oval, 8 cars),
 * 26–48 ms in the browser (docs/PERF_HITCH.md); after this warm-up, ≤ 7.4 ms. Returns whether every hit crashed
 * both cars (else it no longer warms the code it is for).
 */
export function warmCrashPath(): boolean {
  const scene = new THREE.Scene();
  const paint = { body: 0x808080, accent: 0x404040, name: "warm-up" };
  let crashed = true;
  for (const [x, z, yaw, yawB, vB] of WARM_HITS) {
    const a = new DeformableCar(paint, scene);
    const b = new DeformableCar(paint, scene);
    a.spawnFacing(x, z, yaw, 14);
    b.spawnFacing(0, 0, yawB, vB);
    const w = newWorld([a, b]);
    for (let i = 0; i < 240; i++) stepWorld(w, 1 / 240);
    crashed &&= a.crashed && b.crashed && a.deform.massActive && b.deform.massActive;
    a.dispose();
    b.dispose();
  }
  return crashed;
}
