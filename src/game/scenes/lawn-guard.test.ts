import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import { parseTrack } from "../world/track-schema.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { TRACK_ID } from "../world/constants.ts";
import { GUARD_DEPLOY_S, LawnGuard, NO_TARGET, SHOT_RING } from "./lawn-guard.ts";

/** The National Mall's White House grounds (`TrackJson.guards`). */
const spec = TRACKS.map((j) => parseTrack(j)).find((t) => t.id === TRACK_ID.nationalMall)!.guards!;
/** A fixed step at the race's finest slice. */
const STEP = 1 / 240;
/** A spot on the North Lawn, between the house and Pennsylvania Avenue, and one out on the Ellipse's road past the south fence. */
const NORTH_LAWN = { x: -1000, z: -1090 };
const OFF_GROUNDS = { x: -1000, z: -760 };

/** A guard post on the grounds and one car standing at `at`; the post stepped `seconds` s (the car parked). */
function run(at: { x: number; z: number }, seconds: number, standDown = false) {
  const guard = new LawnGuard(spec, 4);
  guard.reset(7);
  guard.standDown = standDown;
  const car = makeCar();
  launch(car, at.x, at.z, 0, 0, 0);
  const cars = [car];
  let firstShotAt = -1;
  let diedAt = -1;
  let hitsToKill = 0;
  for (let t = 0; t < seconds; t += STEP) {
    const before = guard.shots;
    guard.step(cars, STEP);
    for (let k = before; k < guard.shots; k++) {
      if (firstShotAt < 0) firstShotAt = t;
      if (diedAt < 0) hitsToKill += guard.shotHit[k % SHOT_RING]!;
    }
    if (diedAt < 0 && !car.deform.drivetrainAlive) diedAt = t;
  }
  return { guard, car, firstShotAt, diedAt, hitsToKill };
}

describe("given the White House grounds' guard post (owner, 2026-10-14: drive onto the lawn and the guards come out and shoot the car)", () => {
  it("when a car parks on the North Lawn, then the squad opens fire once it is out of the doors, and the car's engine dies at its 10th to 15th hit, keyed for the replay", () => {
    const { guard, car, firstShotAt, diedAt, hitsToKill } = run(NORTH_LAWN, 12);
    assert.ok(firstShotAt >= GUARD_DEPLOY_S - STEP && firstShotAt < GUARD_DEPLOY_S + 0.1, `first shot at ${firstShotAt.toFixed(2)} s`);
    assert.ok(diedAt > firstShotAt && diedAt < firstShotAt + 4, `the engine died at ${diedAt.toFixed(2)} s`);
    assert.ok(hitsToKill >= 10 && hitsToKill <= 15, `${hitsToKill} hits killed it`);
    assert.equal(car.placements, 2, "the spawn and the kill: the recorder keys the step the guards killed it in");
    assert.equal(guard.target, NO_TARGET, "a dead car is no target");
  });

  it("when the course's secret is out (the VIP comes out instead), then a car on the lawn draws no fire and keeps its engine", () => {
    const { guard, car } = run(NORTH_LAWN, 12, true);
    assert.equal(guard.shots, 0, "no shot");
    assert.equal(guard.alarm, -1, "no alarm");
    assert.equal(car.deform.drivetrainAlive, true, "the engine runs");
  });

  it("when a car stays off the grounds, then no alarm goes up and nobody fires, though the same car on the lawn is fired on", () => {
    const off = run(OFF_GROUNDS, 8);
    assert.equal(off.guard.alarm, -1, "no alarm");
    assert.equal(off.guard.shots, 0, "no shot");
    assert.ok(run(NORTH_LAWN, 8).guard.shots > 0, "on the lawn they fire");
  });
});
