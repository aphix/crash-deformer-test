import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { FLIGHT, type DeformableCar } from "./car.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";

/**
 * A highlight keyframe holds a car as its flight block (`DeformableCar.flight`) and the replay drives on from it: a car rebuilt from
 * its block must then take every following slice exactly as the live car does, to the bit (the drive reads the heading off the
 * quaternion before it sets it from the Euler angles, and each is the other's derived copy only up to rounding).
 * The pair is one car and its twin, both driven with the same pedals on the same flat road, one slice at a time.
 */
const SLICE_S = 1 / 120;
const SLICES = 60;
const WARM_SLICES = 20;
const SPAWN_SPEED = 20;
const FULL_TURN = 2 * Math.PI;
const HEADING_COUNT = 16;
/** Headings spread round the compass, none a multiple of a right angle. */
const HEADINGS = Array.from({ length: HEADING_COUNT }, (_, k) => 0.123 + (k * FULL_TURN) / HEADING_COUNT);
const PEDALS: DriveInput = { throttle: 1, steer: 0.4, brake: 0, ebrake: false, boost: false };

function twinFromFlightBlock(car: DeformableCar): DeformableCar {
  const block = new Float64Array(FLIGHT);
  car.flight(block, 0, false);
  const twin = makeCar("sedan");
  twin.spawnFacing(0, 0, 0, 0);
  twin.flight(block, 0, true);
  return twin;
}

function poseAndMotion(car: DeformableCar): number[] {
  return [...car.group.position.toArray(), ...car.group.quaternion.toArray(), ...car.velocity.toArray(), ...car.angular.toArray(), car.yaw, car.pitch, car.roll];
}

/** Every slice of `SLICES`, the live car and its twin from the block, in a world each: the first slice at which they differ (-1: none). */
function firstSliceTheyDiffer(car: DeformableCar, twin: DeformableCar): number {
  const live = newWorld([car], null);
  const rebuilt = newWorld([twin], null);
  for (let slice = 0; slice < SLICES; slice++) {
    applyDrive(car, PEDALS, SLICE_S);
    stepWorld(live, SLICE_S);
    applyDrive(twin, PEDALS, SLICE_S);
    stepWorld(rebuilt, SLICE_S);
    const a = poseAndMotion(car);
    const b = poseAndMotion(twin);
    if (a.some((x, i) => x !== b[i])) return slice;
  }
  return -1;
}

function headingsWhereTheyDiffer(placeAt: (car: DeformableCar, heading: number) => void): string[] {
  const bad: string[] = [];
  for (const heading of HEADINGS) {
    const car = makeCar("sedan");
    placeAt(car, heading);
    const slice = firstSliceTheyDiffer(car, twinFromFlightBlock(car));
    if (slice >= 0) bad.push(`heading ${heading.toFixed(3)}: differ from slice ${slice}`);
  }
  return bad;
}

describe("given a car and a twin rebuilt from its flight block, driven on with the same pedals", () => {
  it("when the car has been driven on for some slices (its quaternion turned by the rigid step after the drive set it), at every heading, then both take every next slice to the bit", () => {
    const bad = headingsWhereTheyDiffer((car, heading) => {
      car.spawnFacing(3, -5, heading, SPAWN_SPEED);
      const warm = newWorld([car], null);
      for (let slice = 0; slice < WARM_SLICES; slice++) {
        applyDrive(car, PEDALS, SLICE_S);
        stepWorld(warm, SLICE_S);
      }
    });
    assert.deepEqual(bad, []);
  });

  it("when the car was just placed facing a yaw a full turn past its heading (its Euler angles are not the quaternion's derived copy), at every heading, then both take every next slice to the bit", () => {
    const bad = headingsWhereTheyDiffer((car, heading) => car.spawnFacing(3, -5, heading + FULL_TURN, SPAWN_SPEED));
    assert.deepEqual(bad, []);
  });
});
