import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { newWorld, stepWorld } from "./world-step.ts";
import { FINE_HZ, QUIET_HZ, SLICES_PER_STEP } from "../kernel/constants.ts";

/** The pacer's quiet step and its fine floor (s). */
const COARSE = 1 / QUIET_HZ;
const FINE = 1 / FINE_HZ;

/** Every slice length (s) `stepWorld` ran, and every step's slice count, when a car starts `startX` m out and drives at 10 m/s into a resting car for 1.5 s in steps of `step` with the 1/240 s floor set. */
function slicesOf(startX: number, step: number): { lengths: number[]; counts: number[] } {
  const mover = makeCar("shape");
  const rest = makeCar("shape");
  launch(rest, 0, 0, 0, 0, 0);
  launch(mover, startX, 0, Math.PI / 2, 10, 0);
  const world = newWorld([mover, rest]);
  world.fine = FINE;
  const lengths: number[] = [];
  world.beforeSlice = (h) => {
    lengths.push(h);
    return false;
  };
  const counts: number[] = [];
  for (let i = 0; i < Math.round(1.5 / step); i++) {
    stepWorld(world, step);
    counts.push(world.shape + 1);
  }
  mover.dispose();
  rest.dispose();
  return { lengths, counts };
}

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
  it("when it starts 6 m out and is stepped at the pacer's coarse step with its 1/240 s floor set, then the steps counted as cut short are exactly those that ran in a contact cut of 1/240 s slices, some steps but not all", () => {
    const { cuts, sliced, widest, steps } = countedCuts(-6, FINE, COARSE);
    assert.ok(cuts > 0 && cuts < steps, `${cuts} of ${steps} steps counted`);
    assert.equal(cuts, sliced);
    assert.equal(widest, SLICES_PER_STEP);
  });
  it("when it hits the other with no pacer floor set, then its contact steps are cut to slices of 1/240 s all the same", () => {
    const { sliced, widest } = countedCuts(-6, 0, COARSE);
    assert.ok(sliced > 0);
    assert.equal(widest, SLICES_PER_STEP);
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

describe("given the pacer's coarse step", () => {
  it("when two cars are 200 m apart, then every step runs in one slice (the quiet step is not cut)", () => {
    const { lengths, counts } = slicesOf(-200, COARSE);
    assert.ok(counts.every((c) => c === 1), `slices per step: ${[...new Set(counts)].join(", ")}`);
    assert.equal(lengths.length, counts.length);
  });
  it("when one hits the other, then a step in contact runs in slices of exactly 1/240 s, never shorter", () => {
    const { lengths, counts } = slicesOf(-6, COARSE);
    assert.ok(counts.includes(SLICES_PER_STEP), "no step was cut for the hit");
    const off = lengths.filter((h) => Math.abs(h - Math.fround(FINE)) > 1e-7 && Math.abs(h - COARSE) > 1e-7);
    assert.deepEqual(off, [], "slices that are neither the whole step nor a 1/240 s one");
  });
});
