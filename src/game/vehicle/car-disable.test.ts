import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { FLIGHT } from "./car-flight.ts";

describe("given a car whose engine is killed from outside the crash sim (a guard's gunfire: `DeformableCar.disable`)", () => {
  const testCases = [
    { it: "when a shot-dead car's flight block restores a running car (a highlight replay's keyframe), then the restored car's engine is dead", disabled: true, expectedAlive: false },
    { it: "when a running car's flight block restores a shot-dead car, then the restored car's engine runs", disabled: false, expectedAlive: true },
  ] as const;

  for (const testCase of testCases) {
    it(testCase.it, () => {
      const recorded = makeCar();
      launch(recorded, 0, 0, 0, 0, 0);
      const replayed = makeCar();
      launch(replayed, 0, 0, 0, 0, 0);
      if (testCase.disabled) recorded.disable();
      else replayed.disable();
      const block = new Float64Array(FLIGHT);
      recorded.flight(block, 0, false);
      replayed.flight(block, 0, true);
      assert.equal(replayed.deform.drivetrainAlive, testCase.expectedAlive, "the replayed car's engine");
    });
  }

  it("when its engine is killed, then it stops running and the step counts as one it was put on a spot in (the recorder keys it)", () => {
    const car = makeCar();
    launch(car, 0, 0, 0, 0, 0);
    const placed = car.placements;
    car.disable();
    assert.equal(car.deform.drivetrainAlive, false, "the engine");
    assert.equal(car.placements, placed + 1, "keyed");
  });
});
