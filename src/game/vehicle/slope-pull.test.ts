import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { G } from "./car-air.ts";
import { layOnWedge, RAD, stepSlices, Wedge } from "./wedge.test-util.ts";
import { setGround } from "../world/ground.ts";

/**
 * A car coasting on its tyre springs over a face keeps the pull of gravity along it: on a face at angle θ a frictionless body gains
 * G·sin θ along the slope a second, G·sin θ·cos θ of it horizontal, uphill or down. The rigid step (`stepFree`) alone moves the car: no
 * drive, so nothing holds its speed but the contacts.
 */
const WEDGE_DEG = 10;
const COAST_S = 0.5;
const RATE_HZ = 240;
/** Most the gain may stray from the closed form (fraction of it): a slice's contact rounding, not a missing pull. */
const GAIN_TOLERANCE = 0.1;
const PULL = G * Math.sin(WEDGE_DEG * RAD) * Math.cos(WEDGE_DEG * RAD);

describe("given a car coasting along a 10° wedge's face on its tyre springs", () => {
  afterEach(() => setGround(null));

  const testCases = (["sedan", "monster"] as const).flatMap((cls) => [
    { it: `when a ${cls} coasts up the face at 6 m/s for ${COAST_S} s, then gravity has slowed it by G·sin·cos a second`, cls, yawDegrees: 90, startSpeedX: 6 },
    { it: `when a ${cls} coasts down the face at 6 m/s for ${COAST_S} s, then gravity has sped it up by G·sin·cos a second`, cls, yawDegrees: 270, startSpeedX: -6 },
  ]);
  for (const testCase of testCases) {
    it(testCase.it, () => {
      const wedge = new Wedge(WEDGE_DEG);
      setGround(wedge);
      const car = layOnWedge(testCase.cls, wedge, testCase.yawDegrees * RAD);
      car.velocity.set(testCase.startSpeedX, testCase.startSpeedX * Math.tan(WEDGE_DEG * RAD), 0);
      stepSlices(car, COAST_S, RATE_HZ);
      const gain = car.velocity.x - testCase.startSpeedX;
      const expected = -PULL * COAST_S;
      assert.ok(Math.abs(gain - expected) <= GAIN_TOLERANCE * Math.abs(expected), `horizontal speed changed by ${gain.toFixed(3)} m/s, gravity along the face gives ${expected.toFixed(3)}`);
    });
  }
});
