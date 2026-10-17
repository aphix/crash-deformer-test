import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { launch, makeCar, makeWorld } from "../contact/crash-scenarios.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { PHASE_COUNT, PHASE_NAMES, startLaps, WORK_NAMES } from "./sim-phases.ts";
import { stepWorld } from "./world-step.ts";

const STEPS = 90;
const STEP_S = 1 / FRAME_HZ;
/** Metres between the lanes of a crowd's head-on pairs: close enough that cars of different lanes are near pairs too. */
const LANE_M = 3;

/** `count` cars in pairs of head-on strikers, one pair a lane, stepped `STEPS` steps through `stepWorld` with the world's phase clock `timed` or not. */
function crowd(count: number, timed: boolean): { digest: string; ms: Float64Array; work: Float64Array } {
  const cars = Array.from({ length: count }, () => makeCar("shape"));
  for (const [k, car] of cars.entries()) {
    const lane = Math.floor(k / 2) * LANE_M;
    if (k % 2 === 0) launch(car, -5, lane, Math.PI / 2, 12, 0);
    else launch(car, 5, lane, -Math.PI / 2, -12, 0);
  }
  const { world } = makeWorld(cars, false, false);
  const phases = world.phases;
  phases.on = timed;
  for (let i = 0; i < STEPS; i++) {
    startLaps(phases);
    stepWorld(world, STEP_S);
  }
  const hash = createHash("sha1");
  for (const car of cars) {
    const { position: p, quaternion: q } = car.group;
    hash.update(new Uint8Array(new Float64Array([p.x, p.y, p.z, q.x, q.y, q.z, q.w, car.velocity.x, car.velocity.y, car.velocity.z, car.angular.x, car.angular.y, car.angular.z, car.crashed ? 1 : 0]).buffer));
    for (const mass of car.deform.masses) hash.update(new Uint8Array(new Float64Array([mass.world.x, mass.world.y, mass.world.z]).buffer));
  }
  const result = { digest: hash.digest("hex"), ms: phases.ms.slice(), work: phases.work.slice() };
  for (const car of cars) car.dispose();
  return result;
}

describe("given the same head-on crash stepped through stepWorld with the phase clock off and then on", () => {
  const off = crowd(2, false);
  const on = crowd(2, true);

  it("when the clock is off, then no phase has any time; with it on, no phase is negative and the phases a crash always runs each hold some", () => {
    assert.equal(on.ms.length, PHASE_COUNT);
    for (const [i, name] of PHASE_NAMES.entries()) {
      assert.equal(off.ms[i], 0, `${name} accumulated with the clock off`);
      assert.ok(on.ms[i]! >= 0, `${name} is negative`);
    }
    for (const name of ["plan", "integrate", "pairs", "structure", "course"] as const) assert.ok(on.ms[PHASE_NAMES.indexOf(name)]! > 0, `${name} timed nothing`);
  });

  it("when the crash is stepped with the clock on, then every car and mass ends bit for bit where it ended with the clock off", () => {
    assert.equal(on.digest, off.digest, "the digest of poses, velocities and masses");
  });

  it("when the clock is off, then the work counters are the same as with it on (they are counts, kept always) and the crash did meet its cars", () => {
    for (const [i, name] of WORK_NAMES.entries()) assert.equal(off.work[i], on.work[i], `${name} differs with the clock`);
    assert.ok(on.work[WORK_NAMES.indexOf("pairContacts")]! > 0, "the two cars never met in a pair contact");
  });
});

describe("given a crowd of head-on pairs stepped through stepWorld", () => {
  it("when the same crowd is stepped twice, then every work counter is the same", () => {
    const first = crowd(4, false);
    const second = crowd(4, false);
    for (const [i, name] of WORK_NAMES.entries()) assert.equal(first.work[i], second.work[i], `${name} differs between two runs`);
    for (const name of ["slices", "liveCarSlices", "pairTests"] as const) assert.ok(first.work[WORK_NAMES.indexOf(name)]! > 0, `${name} counted nothing`);
  });

  const cases = [
    { it: "when there are four cars instead of two, then more pair tests are made", counter: "pairTests" },
    { it: "when there are four cars instead of two, then more car-slices are stepped", counter: "liveCarSlices" },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      const two = crowd(2, false).work[WORK_NAMES.indexOf(testCase.counter)]!;
      const four = crowd(4, false).work[WORK_NAMES.indexOf(testCase.counter)]!;
      assert.ok(four > two, `${testCase.counter}: ${four} for four cars, ${two} for two`);
    });
  }
});
