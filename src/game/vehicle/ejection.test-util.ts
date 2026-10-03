import type { DeformableCar } from "./car.ts";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { armKill, DEFAULT_REALISM } from "./vehicle-classes.ts";

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
