import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armKill, assignClass, CLASSES, DEFAULT_REALISM, HANDLING, type VehicleClassId } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";

/** A derby wreck one hit from done: its wear limit is below a single hit's cap (36 m²/s²). */
export function worn(car: DeformableCar): DeformableCar {
  car.deform.wreckEnergy = 20;
  return car;
}

/** A sedan armed as the fleet arms it (`dressCar`): the HUD's default realism, no wear limit. */
export function fleetCar(): DeformableCar {
  const car = makeCar("shape", 0.32, 0.45);
  armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
  return car;
}

/** Two fleet sedans 10 m apart, head-on at `mps` each. */
export function headOn(mps: number): [DeformableCar, DeformableCar] {
  const a = fleetCar();
  const b = fleetCar();
  launch(a, -5, 0, Math.PI / 2, mps, 0);
  launch(b, 5, 0, -Math.PI / 2, -mps, 0);
  return [a, b];
}

/** A car of class `cls` dressed as a race or fleet car is: its body, the HUD's squash, buckle and mode, the default-realism kill limits. */
export function classCar(cls: VehicleClassId): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  assignClass(car, cls);
  car.deform.squash = INITIAL_HUD.squash;
  car.deform.buckle = INITIAL_HUD.buckle;
  car.deform.setMode(INITIAL_HUD.deformMode);
  armKill(car.deform, cls, HANDLING.realism, "default");
  return car;
}

export type Hit = "head-on" | "t-bone" | "rear-end";

/** What one car came out of a hit as: its engine, and whether its driver was thrown out. */
export type Outcome = { alive: boolean; health: number; travel: number; thrown: boolean };

const SECONDS = 2.5;

/**
 * One hit through the sandbox engine step (`tickWorld`: slices, pair contact, phase clock, `EjectionWatch`), returning
 * [striker, struck]. Head-on: both at `mps` along x, 10 m apart. T-bone: the striker drives its nose into the parked
 * struck car's right door. Rear-end: the striker drives its nose into the parked struck car's tail.
 */
export function collide(hit: Hit, striker: VehicleClassId, struck: VehicleClassId, mps: number): [Outcome, Outcome] {
  const s = classCar(striker);
  const t = classCar(struck);
  if (hit === "head-on") {
    launch(s, -5, 0, Math.PI / 2, mps, 0);
    launch(t, 5, 0, -Math.PI / 2, -mps, 0);
  } else if (hit === "t-bone") {
    launch(t, 0, 0, 0, 0, 0);
    launch(s, 6, 0, -Math.PI / 2, -mps, 0);
  } else {
    launch(t, 0, 0, Math.PI / 2, 0, 0);
    launch(s, -6, 0, Math.PI / 2, mps, 0);
  }
  const w = makeWorld([s, t], false, false);
  for (let f = 0; f < 60 * SECONDS; f++) tickWorld(w);
  const out = (car: DeformableCar, i: number): Outcome => ({
    alive: car.deform.drivetrainAlive,
    health: car.deform.drivetrainHealth,
    travel: car.deform.engineTravel,
    thrown: w.ejections.some((e) => e.car === i),
  });
  const result: [Outcome, Outcome] = [out(s, 0), out(t, 1)];
  s.dispose();
  t.dispose();
  return result;
}
