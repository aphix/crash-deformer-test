import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contactHz, stepFree } from "./car-air.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import { stepSlices } from "./wedge.test-util.ts";

/**
 * The world cuts a step finer (`contactHz`) only for a car that holds a hard contact or is about to: every car rolling on its tyre
 * springs asks for the plain slice, or one car in a field of thirty-two would drag all of them to the fine rate.
 */
const SLICE_HZ = 144;

describe("given a car on flat ground, its tyres in their springs", () => {
  it("when a sedan has rolled for 2 s at 8 m/s, then it asks for the plain slice", () => {
    const car = makeCar("sedan");
    car.spawnFacing(0, 0, 0, 8);
    stepSlices(car, 2, SLICE_HZ);
    assert.equal(contactHz(car), 0, "the rate a rolling sedan asks for");
  });

  it("when a sedan is let down from 0.25 m, then some slice of the landing asks for a finer rate and the settled car does not", () => {
    const car = makeCar("sedan");
    car.spawnFacing(0, 0, 0, 0);
    car.group.position.y = 0.25;
    let finest = 0;
    for (let s = 0; s < 2 * SLICE_HZ; s++) {
      stepFree(car, 1 / SLICE_HZ);
      finest = Math.max(finest, contactHz(car));
    }
    assert.ok(finest > 0, "no slice of the landing asked for a finer rate");
    assert.equal(contactHz(car), 0, "the rate the car asks for 2 s after it landed");
  });
});

describe("given a car whose belly is in the ground", () => {
  it("when a sedan rolls at 3 m/s with its body 4 cm below its rest ride, then it asks for a finer slice", () => {
    const car = makeCar("sedan");
    car.spawnFacing(0, 0, 0, 3);
    car.group.position.y = -0.04;
    stepFree(car, 1 / SLICE_HZ);
    assert.ok(contactHz(car) > 0, "the rate a sedan with its belly in the road asks for");
  });
});
