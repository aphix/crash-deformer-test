import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { newWorld, stepWorld } from "./world-step.ts";

/** The pacer's coarse step and its fine floor (s). */
const COARSE = 1 / 90;
const FINE = 1 / 240;

/** Steps counted as cut short for contact, of `steps`, and the steps that actually ran in more than one slice (`World.shape`, the slices of the last step less one), when a car starts `startX` m out and drives at 10 m/s into a resting car for 1.5 s. */
function countedCuts(startX: number, fine: number, step: number): { cuts: number; sliced: number; widest: number; steps: number } {
  const mover = makeCar("shape");
  const rest = makeCar("shape");
  launch(rest, 0, 0, 0, 0, 0);
  launch(mover, startX, 0, Math.PI / 2, 10, 0);
  const world = newWorld([mover, rest]);
  world.fine = fine;
  const steps = Math.round(1.5 / step);
  let sliced = 0;
  let widest = 1;
  for (let i = 0; i < steps; i++) {
    stepWorld(world, step);
    if (world.shape > 0) sliced++;
    widest = Math.max(widest, world.shape + 1);
  }
  mover.dispose();
  rest.dispose();
  return { cuts: world.fineCuts, sliced, widest, steps };
}

const uncutCases = [
  { it: "when they are 200 m apart, then no step is counted as cut short", startX: -200, fine: FINE, step: COARSE },
  { it: "when one hits the other with no pacer floor set (a harness or a replay), then no step is counted as cut short", startX: -6, fine: 0, step: COARSE },
  { it: "when one hits the other with every step already as short as the 1/240 s floor, then no step is counted as cut short", startX: -6, fine: FINE, step: FINE },
] as const;

describe("given a car driven at 10 m/s at a resting car on open ground for 1.5 s", () => {
  it("when it starts 6 m out and is stepped at the pacer's coarse 1/90 s step with its 1/240 s floor set, then the steps counted as cut short are exactly those that ran in three slices of 1/270 s, some steps but not all", () => {
    const { cuts, sliced, widest, steps } = countedCuts(-6, FINE, COARSE);
    assert.ok(cuts > 0 && cuts < steps, `${cuts} of ${steps} steps counted`);
    assert.equal(cuts, sliced);
    assert.equal(widest, 3);
  });
  it("when it hits the other with no pacer floor set, then its contact steps are cut to slices of 1/240 s (3 of 1/270 s) all the same", () => {
    const { sliced, widest } = countedCuts(-6, 0, COARSE);
    assert.ok(sliced > 0);
    assert.equal(widest, 3);
  });
  it("when it hits the other at every step as short as the 1/240 s floor, then no step runs in more than one slice", () => {
    assert.equal(countedCuts(-6, FINE, FINE).widest, 1);
  });
  for (const testCase of uncutCases) {
    it(testCase.it, () => {
      assert.equal(countedCuts(testCase.startX, testCase.fine, testCase.step).cuts, 0);
    });
  }
});
