import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { stepFree } from "./car-air.ts";
import type { DeformableCar } from "./car.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import type { VehicleClassId } from "./vehicle-classes.ts";
import { Ground, setGround } from "../world/ground.ts";

/**
 * A body on its tyre springs rests where they hold it: parked, rolling, or let down from a little above, it comes to its rest ride
 * (origin on the ground, `Suspension`'s springs at their rest length) and stays, at every slice rate. The rigid step (`stepFree`) alone
 * moves the car here: no drive, no world, the ground the active one.
 */
const MILLIMETRE = 0.001;
const RATES_HZ = [60, 144, 240] as const;
const PARK_S = 5;
/** The wedge: flat road to `FOOT`, the face rising `RUN` m of x at `WEDGE_DEG`, a flat top past it. */
const FOOT = -10;
const RUN = 20;
const WEDGE_DEG = 10;
const RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

class Wedge extends Ground {
  constructor(deg: number) {
    super();
    const top = RUN * Math.tan(deg * RAD);
    this.addPlane(0, -1e4, FOOT, -1e4, 1e4, Infinity);
    this.addFace(FOOT, -1e4, 0, RUN, 2e4, 0, top, 0, top, Infinity);
    this.addPlane(top, FOOT + RUN, 1e4, -1e4, 1e4, Infinity);
  }
}

function slices(car: DeformableCar, seconds: number, hz: number): void {
  for (let s = 0; s < Math.round(seconds * hz); s++) stepFree(car, 1 / hz);
}

/** `cls` standing at the origin with its tyres on the face's plane, facing `yaw` about the face's normal. */
function layOnFace(cls: VehicleClassId, wedge: Wedge, yaw: number): DeformableCar {
  const car = makeCar(cls);
  car.spawnFacing(0, 0, 0, 0);
  const normal = new THREE.Vector3(-Math.sin(WEDGE_DEG * RAD), Math.cos(WEDGE_DEG * RAD), 0);
  car.group.quaternion.setFromUnitVectors(UP, normal).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  const euler = new THREE.Euler().setFromQuaternion(car.group.quaternion, "YXZ");
  car.yaw = euler.y;
  car.pitch = euler.x;
  car.roll = euler.z;
  car.group.position.set(0, wedge.heightAt(0, 0), 0);
  return car;
}

describe("given a car at its rest ride on flat ground, held by its tyre springs", () => {
  const testCases = RATES_HZ.flatMap((hz) => (["sedan", "monster"] as const).map((cls) => ({ it: `when a ${cls} is left for ${PARK_S} s at ${hz} Hz, then its origin stays within 1 mm of its rest ride`, cls, hz })));
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const car = makeCar(testCase.cls);
      car.spawnFacing(0, 0, 0, 0);
      slices(car, PARK_S, testCase.hz);
      assert.ok(Math.abs(car.group.position.y) <= MILLIMETRE, `origin ${(car.group.position.y * 1000).toFixed(2)} mm off its rest ride`);
    });
  }
});

describe("given a car rolling over flat ground at 5 m/s on its tyre springs", () => {
  const testCases = RATES_HZ.flatMap((hz) => (["sedan", "monster"] as const).map((cls) => ({ it: `when a ${cls} rolls for 4 s at ${hz} Hz, then it rides within 1 mm of its rest ride, not held up by its dampers`, cls, hz })));
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const car = makeCar(testCase.cls);
      car.spawnFacing(0, 0, 0, 5);
      slices(car, 4, testCase.hz);
      assert.ok(Math.abs(car.group.position.y) <= MILLIMETRE, `origin ${(car.group.position.y * 1000).toFixed(2)} mm off its rest ride`);
    });
  }
});

describe("given a car let down onto flat ground from above its rest ride", () => {
  const testCases = RATES_HZ.flatMap((hz) => (["sedan", "monster"] as const).map((cls) => ({ it: `when a ${cls} is released 0.3 m up at ${hz} Hz, then it lands and ends within 1 mm of its rest ride after ${PARK_S} s`, cls, hz })));
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const car = makeCar(testCase.cls);
      car.spawnFacing(0, 0, 0, 0);
      car.group.position.y = 0.3;
      slices(car, PARK_S, testCase.hz);
      assert.ok(Math.abs(car.group.position.y) <= MILLIMETRE, `origin ${(car.group.position.y * 1000).toFixed(2)} mm off its rest ride`);
    });
  }

  it("when a monster is released 8 cm above its rest ride, then it falls instead of being held there at rest", () => {
    const car = makeCar("monster");
    car.spawnFacing(0, 0, 0, 0);
    car.group.position.y = 0.08;
    slices(car, 0.05, 144);
    assert.ok(car.velocity.y < -0.01, `vertical speed ${car.velocity.y.toFixed(4)} m/s`);
  });
});

describe("given a car standing with its tyres on a 10° wedge's face, held by its tyre springs", () => {
  afterEach(() => setGround(null));

  const testCases = RATES_HZ.flatMap((hz) =>
    (["sedan", "monster"] as const).flatMap((cls) => [
      { it: `when a ${cls} is left on the face facing up it for ${PARK_S} s at ${hz} Hz, then its origin is where it came to rest after 1 s, within 1 mm`, cls, hz, yawDegrees: 90 },
      { it: `when a ${cls} is left on the face facing across it for ${PARK_S} s at ${hz} Hz, then its origin is where it came to rest after 1 s, within 1 mm`, cls, hz, yawDegrees: 0 },
    ]),
  );
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const wedge = new Wedge(WEDGE_DEG);
      setGround(wedge);
      const car = layOnFace(testCase.cls, wedge, testCase.yawDegrees * RAD);
      slices(car, 1, testCase.hz);
      const restedAt = car.group.position.clone();
      slices(car, PARK_S - 1, testCase.hz);
      assert.ok(Math.abs(car.group.position.y - restedAt.y) <= MILLIMETRE, `origin sank ${((restedAt.y - car.group.position.y) * 1000).toFixed(2)} mm`);
      assert.ok(Math.hypot(car.group.position.x - restedAt.x, car.group.position.z - restedAt.z) <= MILLIMETRE, "origin crept along the face");
    });
  }
});
