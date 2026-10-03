import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive } from "./car-drive.ts";
import { assignClass, CLASSES, type VehicleClassId } from "./vehicle-classes.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { DT, paint } from "./test-support.ts";

/**
 * The drawn wheels turn with the ground: the rate is the car's travel along its nose over the tyre's drawn radius
 * (the class's wheel scale), so reversing turns them back, a sideways slide turns nothing, and a monster's big
 * wheels turn slower than a sedan's at the same speed. Checked against the distance the car actually moved.
 */

function makeCar(cls: VehicleClassId): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  assignClass(car, cls);
  car.spawnFacing(0, 0, 0, 0);
  return car;
}

/** Roll at (vx, vz) for `secs` with the velocity held; the wheel's angle (rad) and the distance moved along the nose (m). */
function roll(car: DeformableCar, vx: number, vz: number, secs: number): { angle: number; along: number } {
  const z0 = car.group.position.z;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    car.velocity.set(vx, 0, vz);
    car.integrate(DT);
  }
  return { angle: car.wheels[0]!.rotation.x, along: car.group.position.z - z0 };
}

const radius = (cls: VehicleClassId) => TYRE_R * CLASSES[cls].wheelScale;

for (const cls of ["sedan", "monster"] as const) {
  describe(`drawn wheel spin, ${cls}`, () => {
    it("good: 10 m/s forward turns the wheel +10/r rad in 1 s, 3 m/s back turns it −3/r, on the class's own radius", () => {
      const fwd = roll(makeCar(cls), 0, 10, 1);
      assert.ok(Math.abs(fwd.angle - 10 / radius(cls)) < 0.02 * (10 / radius(cls)), `forward ${fwd.angle.toFixed(3)} rad vs ${(10 / radius(cls)).toFixed(3)}`);
      const rev = roll(makeCar(cls), 0, -3, 1);
      assert.ok(Math.abs(rev.angle + 3 / radius(cls)) < 0.02 * (3 / radius(cls)), `reverse ${rev.angle.toFixed(3)} rad vs ${(-3 / radius(cls)).toFixed(3)}`);
    });

    it("close-but-wrong: the wheel's rolling distance is the distance the car moved, signed (not the speed's magnitude)", () => {
      for (const v of [10, -10, -3, 25]) {
        const r = roll(makeCar(cls), 0, v, 1);
        assert.ok(Math.abs(r.angle * radius(cls) - r.along) < 0.02 * Math.abs(r.along), `${v} m/s: rolled ${(r.angle * radius(cls)).toFixed(3)} m, moved ${r.along.toFixed(3)} m`);
      }
    });

    it("bad: a pure sideways slide turns nothing, and a 60° slide turns by its component along the nose", () => {
      assert.equal(roll(makeCar(cls), 10, 0, 1).angle, 0);
      const slant = roll(makeCar(cls), 10 * Math.sin(Math.PI / 3), 10 * Math.cos(Math.PI / 3), 1);
      assert.ok(Math.abs(slant.angle * radius(cls) - 5) < 0.1, `rolled ${(slant.angle * radius(cls)).toFixed(3)} m of a 5 m component`);
    });
  });
}

describe("drawn wheel spin, driven and flying", () => {
  it("good: the real drive in reverse turns the wheels back, and they stay back once it rolls", () => {
    const car = makeCar("sedan");
    const z0 = car.group.position.z;
    for (let i = 0; i < 180; i++) {
      applyDrive(car, { throttle: -1, steer: 0, brake: 0, ebrake: false, boost: false }, DT);
      car.integrate(DT);
    }
    const along = car.group.position.z - z0;
    assert.ok(car.velocity.dot(car.forward) < -2, `not reversing: ${car.velocity.dot(car.forward).toFixed(2)} m/s`);
    assert.ok(car.wheels[0]!.rotation.x < 0, `wheels turned forward ${car.wheels[0]!.rotation.x.toFixed(2)} rad reversing`);
    assert.ok(Math.abs(car.wheels[0]!.rotation.x * TYRE_R - along) < 0.05 * Math.abs(along), `rolled ${(car.wheels[0]!.rotation.x * TYRE_R).toFixed(2)} m, moved ${along.toFixed(2)} m`);
  });

  it("good: in the air the wheels keep their rate and slow with bearing drag; the gas winds a driven body's up", () => {
    const rateAfter = (throttle: number, secs: number): number => {
      const car = makeCar("sedan");
      roll(car, 0, 10, 0.5);
      const spun = car["wheelRate"];
      car.group.position.y = 80;
      car.airborne = true;
      car.airThrottle = throttle;
      for (let i = 0; i < Math.round(secs / DT); i++) car.integrate(DT);
      assert.ok(car.airborne, "landed");
      return car["wheelRate"] / spun;
    };
    const coast = rateAfter(0, 0.5);
    assert.ok(coast > 0.6 && coast < 0.85, `0.5 s of drag left ${coast.toFixed(2)} of the rate`);
    assert.ok(rateAfter(0, 3) < 0.2, "still spinning at full rate 3 s on");
    assert.ok(rateAfter(1, 0.5) > coast + 0.1, "throttle did not spin the wheels up");
    assert.ok(rateAfter(-1, 0.5) < coast - 0.1, "reverse throttle did not slow them");
  });

  it("bad: a wheel that has left the car is not turned by it", () => {
    const car = makeCar("sedan");
    car["looseWheels"][0]!.loose = true;
    roll(car, 0, 10, 0.5);
    assert.equal(car.wheels[0]!.rotation.x, 0);
    assert.ok(car.wheels[1]!.rotation.x > 1, "a wheel on the car stopped turning");
  });

  it("close-but-wrong: a crashed car with a dead drivetrain still freewheels at the ground's pace, forward and back", () => {
    for (const v of [10, -4]) {
      const car = makeCar("sedan");
      car.crashed = true;
      car.deform.drivetrainAlive = false;
      const r = roll(car, 0, v, 1);
      assert.ok(Math.abs(r.angle * radius("sedan") - r.along) < 0.03 * Math.abs(r.along), `${v} m/s: rolled ${(r.angle * radius("sedan")).toFixed(3)} m, moved ${r.along.toFixed(3)} m`);
    }
  });

  it("good: a netplay client's frame turns the wheels the same way, signed, from the snapshot velocity", () => {
    for (const v of [10, -3]) {
      const car = makeCar("sedan");
      car.velocity.set(0, 0, v);
      car.refreshBasis();
      for (let i = 0; i < 60; i++) car.netFrame(DT);
      const want = v / radius("sedan");
      assert.ok(Math.abs(car.wheels[0]!.rotation.x - want) < 0.02 * Math.abs(want), `${v} m/s: ${car.wheels[0]!.rotation.x.toFixed(3)} rad vs ${want.toFixed(3)}`);
    }
  });
});
