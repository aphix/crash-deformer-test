import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { carLayout } from "../net/car-pose.ts";
import { makeCarFrame } from "../net/codec.ts";
import type { DeformableCar } from "./car.ts";

const FRAME = 1 / 60;

/** `from`'s wreck section (what a highlight keyframe and a netplay snapshot carry of a wreck) laid on `to`, as a replay restores it. */
function restoreWreck(from: DeformableCar, to: DeformableCar): void {
  const f = makeCarFrame(carLayout(from));
  from.deform.readNetState(f.deform);
  from.readPartNetState(f.parts);
  if ((f.deform.flags & 1) !== 0) to.deform.armMasses(to.group, to.velocity, to.angular);
  to.writeNetState(f.deform, f.parts);
}

describe("given a car whose engine is killed from outside the crash sim (a guard's gunfire: `DeformableCar.disable`)", () => {
  it("when it was doing 15 m/s and nobody drives it, then it rolls to a stop and sleeps like a crash-killed wreck, not on at its speed for good", () => {
    const car = makeCar();
    launch(car, 0, 0, 0, 0, 15);
    const w = makeWorld([car], false, false);
    for (let f = 0; f < 30; f++) tickWorld(w, FRAME);
    const from = car.group.position.clone();
    car.disable();
    let slept = -1;
    for (let f = 0; f < 600 && slept < 0; f++) {
      tickWorld(w, FRAME);
      if (car.asleep) slept = f;
    }
    assert.ok(slept >= 0, "asleep within 10 s");
    assert.ok(car.group.position.distanceTo(from) < 20, `stopped within 20 m, rolled ${car.group.position.distanceTo(from).toFixed(1)} m`);
  });

  it("when its engine is killed, then it is a wreck with a dead drivetrain and the kill is counted for the recorder, not as a placement", () => {
    const car = makeCar();
    launch(car, 0, 0, 0, 0, 0);
    const placed = car.placements;
    car.disable();
    assert.equal(car.deform.drivetrainAlive, false, "the engine");
    assert.ok(car.crashed && car.deform.massActive, "a wreck");
    assert.equal(car.kills, 1, "counted as a kill");
    assert.equal(car.placements, placed, "not put anywhere");
  });

  const testCases = [
    { it: "when a shot-dead car's wreck section restores a running wreck (a highlight replay's keyframe), then the restored car's engine is dead", disabled: true, expectedAlive: false },
    { it: "when a running wreck's section restores a shot-dead car, then the restored car's engine runs", disabled: false, expectedAlive: true },
  ] as const;

  for (const testCase of testCases) {
    it(testCase.it, () => {
      const recorded = makeCar();
      launch(recorded, 0, 0, 0, 0, 0);
      const replayed = makeCar();
      launch(replayed, 0, 0, 0, 0, 0);
      // Both are wrecks (the kill makes the shot car one): only the engine differs.
      for (const car of [recorded, replayed]) {
        car.deform.armMasses(car.group, car.velocity, car.angular);
        car.crashed = true;
      }
      if (testCase.disabled) recorded.disable();
      else replayed.disable();
      restoreWreck(recorded, replayed);
      assert.equal(replayed.deform.drivetrainAlive, testCase.expectedAlive, "the replayed car's engine");
    });
  }
});
