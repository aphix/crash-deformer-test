import type { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { DoorRig, type DoorScenario, type RamShot } from "./door-rig.ts";

/** Brakes off, no thrust: a freewheeling car (the road's rolling and air drag and the tyres' grip are all that act on it). */
const NEUTRAL: DriveInput = { ...idleDrive(), neutral: true };

/** One tyre step for each car whose drivetrain is alive, as the engine's `applyDrive` pass (a wreck's tyres are the wreck rules'). */
export function tyresStep(cars: readonly DeformableCar[], dt: number): void {
  for (const car of cars) if (car.deform.drivetrainAlive) applyDrive(car, NEUTRAL, dt);
}

/** Fire one shot on a parked car and run it out at 60 Hz the way the engine does (`tyres`: the car in neutral, its tyres on). */
export function fireRam(
  car: DeformableCar,
  scenario: DoorScenario,
  opts: { kph: number; kg: number; side?: -1 | 1; length?: number; shape?: DoorRig["shape"]; carMoves?: boolean; tyres?: boolean },
): RamShot {
  const rig = new DoorRig();
  rig.attach(car);
  if (opts.length) rig.length = opts.length;
  rig.shape = opts.shape ?? null;
  rig.carMoves = opts.carMoves ?? false;
  rig.fire(scenario, opts.side ?? 1, opts.kph, opts.kg);
  const dt = 1 / 60;
  for (let t = 0; t < 30 && rig.phase !== "idle"; t += dt) {
    if (opts.tyres) tyresStep([car], dt);
    car.integrate(dt);
    rig.step(dt);
    car.stepBreakage(dt);
    car.updateSkin();
  }
  return rig.result();
}
