import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TYRE_R } from "../deform/deform-state.ts";
import { CLASSES, type VehicleClassId } from "./vehicle-classes.ts";
import { SPOKE_PERIOD, spokeSmear } from "./wheel-blur.ts";

/**
 * A 5-spoke rim repeats every 72°, so a drawn frame that turns it more than half that shows the wrong motion
 * (wagon-wheel effect): the smear must be full wherever the spokes would read slow or backwards, and absent
 * wherever they read true, at every refresh rate and wheel size, in slow-mo too.
 */

/** The turn the eye reads between two frames: `step` folded into the nearest spoke (rad, signed). */
const seen = (step: number): number => step - SPOKE_PERIOD * Math.round(step / SPOKE_PERIOD);

describe("spoke smear against the wagon-wheel effect", () => {
  for (const cls of Object.keys(CLASSES) as VehicleClassId[]) {
    const radius = TYRE_R * CLASSES[cls].wheelScale;
    it(`good: ${cls} at 60, 144 and 240 Hz, 0..60 m/s: the spokes are smeared exactly where they would read wrong`, () => {
      for (const hz of [60, 144, 240]) {
        for (let v = 0; v <= 60; v += 0.25) {
          const step = v / radius / hz;
          const s = spokeSmear(step);
          if (seen(step) < 0.7 * step) assert.ok(s >= 0.99, `${cls} ${hz} Hz ${v} m/s: spokes read ${seen(step).toFixed(2)} of a true ${step.toFixed(2)} rad, smear ${s.toFixed(2)}`);
          if (step < 0.2 * SPOKE_PERIOD) assert.equal(s, 0, `${cls} ${hz} Hz ${v} m/s: sharp spokes got a smear of ${s}`);
        }
      }
    });
  }

  it("good: the smear grows with the turn per frame and does not care which way the wheel turns", () => {
    let last = 0;
    for (let i = 0; i <= 100; i++) {
      const s = spokeSmear((i / 100) * SPOKE_PERIOD);
      assert.ok(s >= last, `smear fell at ${i}%`);
      last = s;
      assert.equal(spokeSmear(-(i / 100) * SPOKE_PERIOD), s);
    }
  });

  it("close-but-wrong: a sedan at 20 m/s is smeared at 60 Hz, sharp in 1/10 slow-mo and at 240 Hz", () => {
    const step = (hz: number, scale: number) => (20 * scale) / TYRE_R / hz;
    assert.equal(spokeSmear(step(60, 1)), 1);
    assert.equal(spokeSmear(step(60, 0.1)), 0);
    assert.ok(spokeSmear(step(240, 1)) < 0.05, `240 Hz smear ${spokeSmear(step(240, 1))}`);
  });
});
