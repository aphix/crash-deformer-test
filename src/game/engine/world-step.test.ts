import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { newWorld, stepWorld } from "./world-step.ts";

/** The pacer's coarse step and its fine floor (s). */
const COARSE = 1 / 120;
const FINE = 1 / 240;

/** Steps counted as cut short for a coming hit, of `steps`, when a car starts `startX` m out and drives at 10 m/s into a resting car for 1.5 s. */
function countedCuts(startX: number, fine: number, step: number): { cuts: number; steps: number } {
  const mover = makeCar("shape");
  const rest = makeCar("shape");
  launch(rest, 0, 0, 0, 0, 0);
  launch(mover, startX, 0, Math.PI / 2, 10, 0);
  const world = newWorld([mover, rest]);
  world.fine = fine;
  const steps = Math.round(1.5 / step);
  for (let i = 0; i < steps; i++) stepWorld(world, step);
  mover.dispose();
  rest.dispose();
  return { cuts: world.fineCuts, steps };
}

const uncutCases = [
  { it: "when they are 200 m apart, then no step is counted as cut short", startX: -200, fine: FINE, step: COARSE },
  { it: "when one hits the other with no pacer floor set (a harness or a replay), then no step is counted as cut short", startX: -6, fine: 0, step: COARSE },
  { it: "when one hits the other with every step already as short as the 1/240 s floor, then no step is counted as cut short", startX: -6, fine: FINE, step: FINE },
] as const;

describe("given a car driven at 10 m/s at a resting car on open ground for 1.5 s", () => {
  it("when it starts 6 m out and is stepped at the pacer's coarse 1/120 s step with its 1/240 s floor set, then some steps but not all are counted as cut short for the coming hit", () => {
    const { cuts, steps } = countedCuts(-6, FINE, COARSE);
    assert.ok(cuts > 0 && cuts < steps, `${cuts} of ${steps} steps counted`);
  });
  for (const testCase of uncutCases) {
    it(testCase.it, () => {
      assert.equal(countedCuts(testCase.startX, testCase.fine, testCase.step).cuts, 0);
    });
  }
});
