import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { assignClass, type VehicleClassId } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";

const SLICE = 1 / 80;
const FULL: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };

/** A car of `cls` at rest on flat ground, `crashed` or fresh, its masses not armed, driven at full throttle for 0.5 s with the engine's wreck-slide rule on: its speed (m/s). */
function throttleSpeed(cls: VehicleClassId, crashed: boolean): number {
  const car = new DeformableCar(paint(), new THREE.Scene());
  assignClass(car, cls);
  car.spawnFacing(0, 0, 0, 0);
  car.crashed = crashed;
  const w = newWorld([car]);
  for (let s = 0; s < 60; s++) {
    applyDrive(car, FULL, SLICE);
    stepWorld(w, SLICE);
    settleStep(w.cars, SLICE, true);
  }
  return car.velocity.length();
}

describe("given a crashed car on its wheels with its masses at rest and its drivetrain alive", () => {
  for (const cls of ["sedan", "monster"] as const) {
    it(`when a ${cls} holds full throttle for 0.5 s, then it reaches at least half the speed of a fresh ${cls}`, (t) => {
      const fresh = throttleSpeed(cls, false);
      const wreck = throttleSpeed(cls, true);
      t.diagnostic(`${cls}: fresh ${fresh.toFixed(3)} m/s, crashed ${wreck.toFixed(3)} m/s`);
      assert.ok(fresh > 1, `the fresh ${cls} reached only ${fresh.toFixed(3)} m/s`);
      assert.ok(wreck >= 0.5 * fresh, `the crashed ${cls} reached ${wreck.toFixed(3)} m/s against the fresh car's ${fresh.toFixed(3)}`);
    });
  }
});
