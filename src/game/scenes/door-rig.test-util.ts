import type { DeformableCar } from "../vehicle/car.ts";
import { DoorRig, type DoorScenario, type RamShot } from "./door-rig.ts";

/** Fire one shot on a parked car and run it out at 60 Hz the way the engine does. */
export function fireRam(
  car: DeformableCar,
  scenario: DoorScenario,
  opts: { kph: number; kg: number; side?: -1 | 1; length?: number; shape?: DoorRig["shape"]; carMoves?: boolean },
): RamShot {
  const rig = new DoorRig();
  rig.attach(car);
  if (opts.length) rig.length = opts.length;
  rig.shape = opts.shape ?? null;
  rig.carMoves = opts.carMoves ?? false;
  rig.fire(scenario, opts.side ?? 1, opts.kph, opts.kg);
  const dt = 1 / 60;
  for (let t = 0; t < 30 && rig.phase !== "idle"; t += dt) {
    car.integrate(dt);
    rig.step(dt);
    car.updateDeform(dt);
  }
  return rig.result();
}
