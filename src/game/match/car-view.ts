import type { DeformableCar } from "../vehicle/car.ts";
import { carGear, carRpm } from "../vehicle/vehicle-classes.ts";
import type { RaceView } from "./types.ts";

/**
 * Damage arc 0-1 (1 = untouched): the weaker of the two things that stop a car, the engine block (`drivetrainHealth`:
 * its crush travel against the travel that kills it, 0 once dead) and the wheels still on (a quarter each). One scalar the
 * driver can read at a glance; a car that has lost two wheels reads at most half, whatever its engine says.
 */
function carDamage(car: DeformableCar): number {
  const d = car.deform;
  return Math.min(d.drivetrainHealth, d.wheelsOn / 4);
}

/** The gauge fields of a `RaceView` that come straight off the car: speed, gear, revs, damage, wheels, boost burn. */
export function carGauge(car: DeformableCar): Pick<RaceView, "speedKph" | "gear" | "rpm" | "damage" | "wheelsOff" | "boosting"> {
  return {
    speedKph: car.velocity.length() * 3.6,
    gear: carGear(car),
    rpm: carRpm(car),
    damage: carDamage(car),
    wheelsOff: 4 - car.deform.wheelsOn,
    boosting: car.drive.boost,
  };
}
