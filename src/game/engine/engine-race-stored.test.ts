import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frame } from "../world/race-world.test-util.ts";
import { leaveSurvival, survivalWorld } from "../world/survival-run.test-util.ts";

/**
 * A replay keeps a car hidden where the record had it put away (`ReplayScene.stored`, docs/HIGHLIGHTS.md): the director answers from
 * the spot `putAway` parks a car on, so the answer is the live game's own hide rule, never a copy of it.
 */
describe("given a Survival run: its hunters are put away off the course until they drop in", () => {
  it("when every car is asked whether it is stored, then the hidden hunters are, and no car on the road is, from the first frame to a dozen seconds in", () => {
    const w = survivalWorld();
    try {
      const state = { acc: 0 };
      let hidden = 0;
      let placed = 0;
      for (let n = 0; n <= 12 * 60; n++) {
        for (const [i, car] of w.cars.entries()) {
          const { x, z } = car.group.position;
          assert.equal(w.race.stored(i, x, z), !car.group.visible, `frame ${n}: car ${i} at (${x.toFixed(0)}, ${z.toFixed(0)}) is ${car.group.visible ? "drawn" : "hidden"}`);
          if (car.group.visible) placed++;
          else hidden++;
        }
        frame(w, state);
      }
      assert.ok(hidden > 0 && placed > 0, `${hidden} hidden and ${placed} drawn car-frames: the run put no car away or none on the road`);
    } finally {
      leaveSurvival(w);
    }
  });
});
