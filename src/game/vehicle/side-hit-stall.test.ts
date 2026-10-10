import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { firePiston } from "../scenes/piston-rig.test-util.ts";
import type { PistonId } from "../scenes/piston-rig.ts";
import { applyDrive } from "./car-drive.ts";
import { FUEL_CUTOFF_G, STALL_S } from "./constants.ts";

// docs/UNIFIED_CONTACT.md stage 4, T-bone fuel cut-off: a side hit hard enough to trip the crash sensor cuts the fuel for a few
// seconds and the engine restarts; a head-on hit of the same speed, or a side tap under the sensor, does not.

const FRAME = 1 / 60;

function struck(id: PistonId, kph: number) {
  const car = makeCar("shape");
  firePiston(car, id, { speedKph: kph, massKg: 858, hardness: 1, after: 0.3 });
  return car;
}

describe("given a parked car struck by a 858 kg piston", () => {
  it("when it is hit on its side at 50 km/h, then the fuel is cut for the stall time", () => {
    assert.ok(struck("right", 50).stalledS > 0, "the side hit left the engine running");
  });

  it("when it is hit on its side at 50 km/h and driven on, then it has no drive until the stall time is out and the engine restarts", () => {
    const car = struck("right", 50);
    const input = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
    const wasStalled = car.stalledS;
    assert.ok(wasStalled > 0);
    for (let t = 0; t < STALL_S + 0.5; t += FRAME) applyDrive(car, input, FRAME);
    assert.equal(car.stalledS, 0, `still stalled after ${STALL_S + 0.5} s`);
  });

  it("when it is hit on its side at 8 km/h, below the crash sensor, then the engine keeps running", () => {
    assert.equal(struck("right", 8).stalledS, 0);
  });

  it("when it is hit on its nose at 50 km/h, then the engine keeps running (the cut-off is for side hits)", () => {
    assert.equal(struck("front", 50).stalledS, 0);
  });

  it("when the stall is read against the sensor's own threshold, then 50 km/h on the side is past it and 8 km/h is under it", () => {
    // The crush stroke the hit gets (`crushStroke`, squash 0.32) is affine in its barrier speed: average deceleration = ebs² / (2 · stroke).
    const stroke = (ebs: number) => (0.035 * ebs + 0.02) * (0.6 + 0.32);
    const decel = (kph: number) => (kph / 3.6) ** 2 / (2 * stroke(kph / 3.6)) / 9.81;
    assert.ok(decel(50) > FUEL_CUTOFF_G && decel(8) < FUEL_CUTOFF_G, `${decel(50).toFixed(1)} g and ${decel(8).toFixed(1)} g against ${FUEL_CUTOFF_G} g`);
  });
});
