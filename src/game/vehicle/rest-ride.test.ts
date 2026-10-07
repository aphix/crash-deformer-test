import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { stepFree } from "./car-air.ts";
import { SPRINGS } from "./car-suspension.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import { layOnWedge, RAD, stepSlices, Wedge } from "./wedge.test-util.ts";
import { setGround } from "../world/ground.ts";

/**
 * A body on its tyre springs rests where they hold it: parked, rolling, or let down from a little above, it comes to its rest ride
 * (origin on the ground, `Suspension`'s springs at their rest length) and stays, at every slice rate. The rigid step (`stepFree`) alone
 * moves the car here: no drive, no world, the ground the active one.
 */
const MILLIMETRE = 0.001;
const RATES_HZ = [60, 144, 240] as const;
const PARK_S = 5;
const WEDGE_DEG = 10;
/** The most (m) a car laid on the face is off its rest ride when the springs start to move it: their amplitude decays as e^(−ζωt) from it. */
const LARGEST_OFFSET = 0.05;

describe("given a car at its rest ride on flat ground, held by its tyre springs", () => {
  const testCases = RATES_HZ.flatMap((hz) => (["sedan", "monster"] as const).map((cls) => ({ it: `when a ${cls} is left for ${PARK_S} s at ${hz} Hz, then its origin stays within 1 mm of its rest ride`, cls, hz })));
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const car = makeCar(testCase.cls);
      car.spawnFacing(0, 0, 0, 0);
      stepSlices(car, PARK_S, testCase.hz);
      assert.ok(Math.abs(car.group.position.y) <= MILLIMETRE, `origin ${(car.group.position.y * 1000).toFixed(2)} mm off its rest ride`);
    });
  }
});

describe("given a car standing still on flat ground with the drive's throttle held", () => {
  const FULL_THROTTLE: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };

  for (const cls of ["sedan", "monster"] as const) {
    it(`when the drive pushes a ${cls} every slice for 0.5 s from rest, then its speed grows slice after slice instead of being held at rest`, () => {
      const car = makeCar(cls);
      car.spawnFacing(0, 0, 0, 0);
      const slice = 1 / 120;
      let speedBefore = 0;
      for (let s = 0; s < 60; s++) {
        applyDrive(car, FULL_THROTTLE, slice);
        stepFree(car, slice);
        const speed = car.velocity.length();
        assert.ok(speed > speedBefore, `slice ${s}: speed ${speed.toFixed(4)} m/s after ${speedBefore.toFixed(4)}`);
        speedBefore = speed;
      }
    });
  }
});

describe("given a car rolling over flat ground at 5 m/s on its tyre springs", () => {
  const testCases = RATES_HZ.flatMap((hz) => (["sedan", "monster"] as const).map((cls) => ({ it: `when a ${cls} rolls for 4 s at ${hz} Hz, then it rides within 1 mm of its rest ride, not held up by its dampers`, cls, hz })));
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const car = makeCar(testCase.cls);
      car.spawnFacing(0, 0, 0, 5);
      stepSlices(car, 4, testCase.hz);
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
      stepSlices(car, PARK_S, testCase.hz);
      assert.ok(Math.abs(car.group.position.y) <= MILLIMETRE, `origin ${(car.group.position.y * 1000).toFixed(2)} mm off its rest ride`);
    });
  }

  it("when a monster is released 8 cm above its rest ride, then it falls instead of being held there at rest", () => {
    const car = makeCar("monster");
    car.spawnFacing(0, 0, 0, 0);
    car.group.position.y = 0.08;
    stepSlices(car, 0.05, 144);
    assert.ok(car.velocity.y < -0.01, `vertical speed ${car.velocity.y.toFixed(4)} m/s`);
  });
});

describe("given a car standing with its tyres on a 10° wedge's face, held by its tyre springs", () => {
  afterEach(() => setGround(null));

  const testCases = RATES_HZ.flatMap((hz) =>
    (["sedan", "monster"] as const).flatMap((cls) => [
      { it: `when a ${cls} is left on the face facing up it for ${PARK_S} s at ${hz} Hz, then its origin is where it was once its springs had settled, within 1 mm`, cls, hz, yawDegrees: 90 },
      { it: `when a ${cls} is left on the face facing across it for ${PARK_S} s at ${hz} Hz, then its origin is where it was once its springs had settled, within 1 mm`, cls, hz, yawDegrees: 0 },
    ]),
  );
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const wedge = new Wedge(WEDGE_DEG);
      setGround(wedge);
      const car = layOnWedge(testCase.cls, wedge, testCase.yawDegrees * RAD);
      const spring = SPRINGS[testCase.cls];
      const settleS = Math.log(LARGEST_OFFSET / MILLIMETRE) / (spring.zeta * 2 * Math.PI * spring.hz);
      assert.ok(settleS < PARK_S, "the spring envelope outlasts the test");
      stepSlices(car, settleS, testCase.hz);
      const restedAt = car.group.position.clone();
      stepSlices(car, PARK_S - settleS, testCase.hz);
      assert.ok(Math.abs(car.group.position.y - restedAt.y) <= MILLIMETRE, `origin sank ${((restedAt.y - car.group.position.y) * 1000).toFixed(2)} mm`);
      assert.ok(Math.hypot(car.group.position.x - restedAt.x, car.group.position.z - restedAt.z) <= MILLIMETRE, "origin crept along the face");
    });
  }
});
