import * as THREE from "three";
import { bleedAfterSlide, DeformableCar } from "../vehicle/car.ts";
import { StrongestContact, type ContactHit, type JerseyBarrier } from "../scenes/engine-props.ts";
import { partContactPair } from "../contact/external-contact.ts";
import { markApproaches, resolveCarPair } from "../contact/pair-contact.ts";
import { bandsMeet } from "../contact/cage-outline.ts";
import type { EjectionWatch } from "../vehicle/ejection.ts";
import { armCrushRows, contactHz } from "../vehicle/car-air.ts";
import { CarSurfaces } from "../vehicle/car-surfaces.ts";
import { armTops } from "../world/surfaces.ts";
import { STOCK_PAINT } from "../vehicle/constants.ts";

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
  /** Cleared each step, then offered every hit: the strongest one is the step's impact. */
  readonly strongest: StrongestContact;
  /** Before each slice; true when it stepped the slice itself (a rig scene drives its car). */
  beforeSlice: ((h: number) => boolean) | null;
  /** Each SAT pair hit, before it is offered to `strongest`. */
  pairHit: ((a: number, b: number, hit: ContactHit) => void) | null;
  /** A door, mirror or panel of one car met the other (`partContactPair`), a mass of one met a mass of the other (`collideWith`), or one stood on or touched the other's top (`CarSurfaces.met`): they touched without a SAT hit. */
  partTouch: ((a: number, b: number) => void) | null;
  /** Each car right after its `afterContacts` (the derby bowl). */
  afterCar: ((car: DeformableCar, h: number) => void) | null;
  /** Each car at the end of a slice of `h` s (race walls and props). */
  collide: ((car: DeformableCar, i: number, h: number) => void) | null;
  /**
   * Decides, at the end of every step, whether a disabling hit throws a driver out (`car.driverOut`, an `Ejection`
   * event). Null where the cars' record already says who was thrown when: a highlight replay.
   */
  ejection: EjectionWatch | null;
  /** What a body in flight stands on besides the ground: the other cars' tops (and the roofs' load crush). */
  surfaces: CarSurfaces;
  /**
   * The step's schedule as the last `stepWorld` ran it: its slice count − 1. It follows every car in the world (any pair anywhere
   * can hold the slices up), so a replay of a few cars cannot work it out: the recorder keeps it (`HighlightClip.shape`).
   */
  shape: number;
  /** A recorded `shape` the next `stepWorld` runs to the letter (a highlight replay); −1: the cars decide, as live. */
  plan: number;
  /** The slice (s) the pacer's 1/240 s floor takes now (`SimPacer.fine`), which a step with a hit about to land is cut to; 0 where no pacer steps the world (a harness, a replay: the recorded `shape` decides there). */
  fine: number;
  /** Steps `stepWorld` cut into more slices than it would have taken because a hit was about to land (to `fine`), counted up for ever (the bench reads differences). */
  fineCuts: number;
};

export function newWorld(cars: readonly DeformableCar[], barrier: JerseyBarrier | null = null, ejection: EjectionWatch | null = null): World {
  return {
    cars,
    barrier,
    barrierHits: [],
    strongest: new StrongestContact(),
    beforeSlice: null,
    pairHit: null,
    partTouch: null,
    afterCar: null,
    collide: null,
    ejection,
    surfaces: new CarSurfaces(),
    shape: 0,
    plan: -1,
    fine: 0,
    fineCuts: 0,
  };
}

/**
 * Car pairs within this squared plan distance (m^2) at a step's or slice's start are the ones its contact passes visit and
 * `markApproaches` looks ahead from: a pair resolves only inside `resolveCarPair`'s 5.2 m (27 m^2 here), a slice moves a car
 * by its step's travel and the capped pushes, and the approach look-ahead wants a car length plus 3 m (a step or two of a
 * 200 m/s closing), so 8 m covers both.
 */
const NEAR_PAIR2 = 64;
/** Pairs the slice visits, as car index pairs (a, b), a < b, in the order a plain double loop would reach them.
 *  A module scratch like the file's other per-step temporaries; `collectNear` grows it when a field outgrows it. */
const near = { pairs: new Int32Array(2 * 496) };

/** Fills `near.pairs` with the pairs of `cars` within `NEAR_PAIR2` of each other in plan; the count of ints written. */
function collectNear(cars: readonly DeformableCar[]): number {
  const n = cars.length;
  if (n * (n - 1) > near.pairs.length) near.pairs = new Int32Array(n * (n - 1));
  const out = near.pairs;
  let k = 0;
  for (let a = 0; a < n; a++) {
    const pa = cars[a]!.group.position;
    for (let b = a + 1; b < n; b++) {
      const pb = cars[b]!.group.position;
      const dx = pa.x - pb.x;
      const dz = pa.z - pb.z;
      if (dx * dx + dz * dz > NEAR_PAIR2) continue;
      out[k++] = a;
      out[k++] = b;
    }
  }
  return k;
}

/**
 * One fixed step of the world (`dt` from `physicsSlice`), split into 1–8 slices: integrate or pose, part contact, one pass over the
 * slice's contacts (slab, car pairs), then the structure step, slab clip and `afterContacts` per car. The pair loops visit the
 * slice's near pairs only (`collectNear`).
 */
export function stepWorld(w: World, dt: number): void {
  armTops(w.surfaces);
  const { cars, barrier, strongest } = w;
  const n = cars.length;
  w.ejection?.seed(cars);
  let nearWall = false;
  if (barrier) {
    for (let i = 0; i < n; i++) {
      if (cars[i]!.group.position.lengthSq() < 160) {
        nearWall = true;
        break;
      }
    }
  }
  let slices: number;
  if (w.plan >= 0) slices = (w.plan & 7) + 1;
  else {
    slices = nearWall && dt > 0.006 ? 3 : dt > 0.012 ? 2 : 1;
    // A step is solved at the rate a car in it asks for (`contactHz`): a body in flight touching something. A hit about to land (the pairs are marked here, the solids by the course's collide pass of the step before) is solved in slices no longer than the pacer's fine floor takes (`fine`).
    if (w.fine > 0) {
      const count = collectNear(cars);
      markApproaches(cars, near.pairs, count);
    }
    let hz = 0;
    let hit = false;
    for (let i = 0; i < n; i++) {
      const car = cars[i]!;
      hz = Math.max(hz, contactHz(car));
      hit = hit || car.nearHit;
    }
    if (dt * hz > slices + 1e-6) slices = Math.min(8, Math.ceil(dt * hz - 1e-6));
    if (hit && w.fine > 0 && Math.min(8, Math.ceil(dt / w.fine - 1e-6)) > slices) w.fineCuts++;
    if (hit && w.fine > 0) slices = Math.max(slices, Math.min(8, Math.ceil(dt / w.fine - 1e-6)));
  }
  // Read once: this step's collide passes mark the next.
  for (let i = 0; i < n; i++) cars[i]!.nearHit = false;
  const h = dt / slices;
  strongest.clear();

  for (let i = 0; i < slices; i++) {
    if (w.beforeSlice?.(h)) continue;
    w.surfaces.cars = cars;
    w.surfaces.met = w.partTouch;
    for (let ci = 0; ci < n; ci++) {
      const car = cars[ci]!;
      car.deform.beginSlice(h);
      car.surfaces = w.surfaces;
      car.slot = ci;
      // A wreck its masses hand to flight here (`syncPose`) flies this slice: handed over before the masses took it,
      // and left at that, it lost the slice's motion.
      if (car.deform.massActive) car.syncPose(h);
      if (!car.deform.massActive) {
        car.integrate(h);
        if (car.deform.massActive) car.syncPose(h);
        else car.refreshBasis();
      }
      // The cars stepped after this one see its roof where it is now.
      w.surfaces.sync(ci, car);
    }

    const pairs = collectNear(cars);
    const nearList = near.pairs;
    for (let k = 0; k < pairs; k += 2) {
      const a = nearList[k]!;
      const b = nearList[k + 1]!;
      const ca = cars[a]!;
      const cb = cars[b]!;
      if (barrier && barrier.blocksPair(ca, cb)) continue;
      const dx = ca.group.position.x - cb.group.position.x;
      const dz = ca.group.position.z - cb.group.position.z;
      // Cars at different heights (one flying over the other, on a bridge over it) never touch; nor does a fake falling off the fleet disc.
      if (dx * dx + dz * dz > 28 || !bandsMeet(ca, cb) || ca.falling || cb.falling) continue;
      const masses = (ca.deform.massActive || cb.deform.massActive) && ca.deform.collideWith(cb.deform, h);
      if (partContactPair(ca, cb, h) || masses) w.partTouch?.(a, b);
    }

    // One pass over the slice's contacts: the barrier, then every near pair through the one kernel, then the barrier's clip; accuracy
    // comes from the slice (substeps, `CONTACT_HZ`), not from passes over it.
    for (let ci = 0; ci < n; ci++) {
      const car = cars[ci]!;
      if (car.deform.massActive) car.syncPose(0);
      else car.refreshBasis();
    }
    if (barrier) {
      for (let ci = 0; ci < n; ci++) {
        const hit = barrier.resolve(cars[ci]!, true, true, h);
        if (hit) {
          w.barrierHits[ci] = true;
          strongest.offer(hit);
        }
      }
    }
    for (let k = 0; k < pairs; k += 2) {
      const a = nearList[k]!;
      const b = nearList[k + 1]!;
      if (barrier && barrier.blocksPair(cars[a]!, cars[b]!)) continue;
      if (!bandsMeet(cars[a]!, cars[b]!) || cars[a]!.falling || cars[b]!.falling) continue;
      const pair = resolveCarPair(cars[a]!, cars[b]!, h);
      if (pair) {
        w.pairHit?.(a, b, pair);
        strongest.offer(pair);
      }
    }
    if (barrier) for (let ci = 0; ci < n; ci++) barrier.resolve(cars[ci]!, false, false, h);
    // The pair pass moved the wrecks' masses (a tilted wreck's frame jumped 0.35 m in one re-measure): their pose and velocity are derived
    // from them now, before the structure step reads them, as the second pass's start did (the mixed fleet's column read a wreck at
    // -7.4 m/s against its masses' -2.8 without it: stack-column 'owner's drops').
    for (let ci = 0; ci < n; ci++) if (cars[ci]!.deform.massActive) cars[ci]!.syncPose(0);
    armCrushRows(h);

    for (let ci = 0; ci < n; ci++) {
      const car = cars[ci]!;
      if (car.deform.massActive) car.deform.stepStructure(h);
      if (car.deform.massActive) car.syncPose(h);
      if (barrier) barrier.clip(car);
      car.afterContacts(h);
      w.afterCar?.(car, h);
    }
    if (w.collide) for (let ci = 0; ci < n; ci++) w.collide(cars[ci]!, ci, h);
    for (let ci = 0; ci < n; ci++) cars[ci]!.deform.endSlice();
    // A step's last slice is baked by its caller (`stepBreakage`); the slices before it take their own, so the next slice reads the body
    // as this one's crush left it, not as the step began (a hit cut in two slices crushed what its first slice did not see).
    if (i < slices - 1) for (let ci = 0; ci < n; ci++) cars[ci]!.bakeBetweenSlices(h);
  }
  w.ejection?.step(cars, dt);
  w.shape = slices - 1;
  armTops(null);
}

/**
 * After each `stepWorld` (`CrashEngine.tickInner`, a highlight replay): a dead drivetrain's drive bleeds away, with
 * `bleed` (the crash clock is past the hit) a wreck slides to a stop on tyre-style friction, and each car's parts
 * follow the crash (`stepBreakage`: hinges, tears, lamps, glass) once for the whole step, never by the frame rate.
 */
export function settleStep(cars: readonly DeformableCar[], h: number, bleed: boolean): void {
  for (const car of cars) {
    if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
    if (bleed && car.crashed) bleedAfterSlide(car, h);
    car.stepBreakage(h);
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
  const paint = { ...STOCK_PAINT, name: "warm-up" };
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
