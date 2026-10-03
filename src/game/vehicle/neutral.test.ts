import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive, DRIVE, idleDrive, type DriveInput } from "./car-drive.ts";
import { DT, paint } from "./test-support.ts";

/**
 * A thrown-out driver's car freewheels (`DriveInput.neutral`, Main/owner 2026-10-03: "continues in neutral"): no thrust,
 * no lift-off engine braking, only rolling resistance and air drag; ordinary driving is untouched.
 */

const KPH = 1 / 3.6;
const SECS = 2.5;

/** A sedan on the flat doing 130 km/h, driven `SECS` s on `input`: its speed then (m/s). */
function run(input: DriveInput, secs = SECS): { speed: number; car: DeformableCar } {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, "sedan");
  car.spawnFacing(0, 0, 0, 130 * KPH);
  for (let i = 0; i < Math.round(secs / DT); i++) {
    applyDrive(car, input, DT);
    car.integrate(DT);
  }
  return { speed: car.velocity.length(), car };
}

describe("a freewheeling (neutral) car", () => {
  const v0 = 130 * KPH;
  const lift = run(idleDrive());
  const free = run({ ...idleDrive(), neutral: true });

  it("bad: at 130 km/h on the flat it sheds far less speed in 2.5 s than with the lift-off engine braking (decels reported)", (t) => {
    const liftDecel = (v0 - lift.speed) / SECS;
    const freeDecel = (v0 - free.speed) / SECS;
    t.diagnostic(`130 km/h, ${SECS} s: lift-off ${liftDecel.toFixed(2)} m/s² (${(lift.speed / KPH).toFixed(0)} km/h left), neutral ${freeDecel.toFixed(2)} m/s² (${(free.speed / KPH).toFixed(0)} km/h left)`);
    // Rolling resistance + air drag alone: about 0.5 m/s² at this speed.
    assert.ok(freeDecel > 0.3 * (DRIVE.roll + DRIVE.drag * v0 * v0) && freeDecel < 1.5 * (DRIVE.roll + DRIVE.drag * v0 * v0), `neutral sheds ${freeDecel.toFixed(2)} m/s²`);
    assert.ok(liftDecel > 5 * freeDecel, `lift-off ${liftDecel.toFixed(2)} vs neutral ${freeDecel.toFixed(2)} m/s²`);
    assert.ok(free.speed > 0.9 * v0, `${(free.speed / KPH).toFixed(0)} km/h left of 130`);
  });

  it("good: the car carries the flag (the recorder's input byte reads it) and an ordinary input does not", () => {
    assert.equal(free.car.drive.neutral, true);
    assert.equal(lift.car.drive.neutral, false);
  });

  it("good: ordinary driving is bit-identical with or without the field (neutral false or absent)", () => {
    const a = run({ ...idleDrive(), throttle: 0.6, steer: 0.2 });
    const b = run({ ...idleDrive(), throttle: 0.6, steer: 0.2, neutral: false });
    assert.equal(a.speed, b.speed);
    assert.equal(a.car.group.position.x, b.car.group.position.x);
    assert.equal(a.car.group.position.z, b.car.group.position.z);
  });

  it("bad: a held brake still brakes a freewheeling car (neutral is only the no-pedals case)", () => {
    const braked = run({ ...idleDrive(), brake: 1, neutral: true }, 1);
    assert.ok(braked.speed < 0.6 * v0, `${(braked.speed / KPH).toFixed(0)} km/h after a second on the brake`);
  });
});
