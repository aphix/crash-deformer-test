import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";
import { approachSide, pair, run, watch } from "./fleet-ramps.test-util.ts";

/**
 * The fleet ramps' full-sanity sweeps (`npm run test:ai-long-run`, not the per-commit suite): the neighbourhood of two
 * staged cases run cell by cell, hoping a defect shows in a cell the staged cases do not reach. What each sweep caught is pinned by a
 * staged test in fleet-ramps.test.ts.
 */

describe("given two cars driving head-on at each other up the two ramps, with no slab between them", () => {
  afterEach(() => setGround(null));
  // The staged 16/11/0.4 case (fleet-ramps.test.ts) passed on main for its own cell only: on the speeds and offsets around it, 23 of 75 cells flagged (a wreck
  // coming down beside another was lifted its whole depth into the other's flank, up to 0.45 m in one slice). The whole
  // neighbourhood is the test: a result that holds for one realisation of a chaotic pile-up and not its neighbours is a defect.
  it("when the speeds and offsets around that case are swept (first car 15–17 m/s, second 7–9 m/s, 0.3–0.5 m across: 75 combinations), then no frame of any of them moves a car's height away from its speeds", (t) => {
    const failures: string[] = [];
    let frames = 0;
    for (const vA of [15, 15.5, 16, 16.5, 17]) {
      for (const vB of [7, 7.5, 8, 8.5, 9]) {
        for (const dx of [0.3, 0.4, 0.5]) {
          const { w, cars } = pair(vA, vB, dx);
          const flags = watch(cars);
          run(w, 4, flags.frame, flags.slice);
          frames += flags.list.length;
          if (flags.list.length > 0) failures.push(`${vA}/${vB}/${dx}: ${flags.list.length} frames, first ${flags.list[0]}`);
          for (const c of cars) c.dispose();
        }
      }
    }
    t.diagnostic(`${failures.length} of 75 cells flagged, ${frames} frames`);
    assert.deepEqual(failures, []);
  });
});

describe("given a car driven at walking pace into a ramp's side", () => {
  afterEach(() => setGround(null));
  it("when it is run for 12 s with the spawn a few mm either way, at 30° and 45° off the run and at wall heights from 0.05 m to 0.4 m, then it still never rolls over", (t) => {
    // The monster driven at the flank at 30° crept up it on one tyre, took off at the high end (z 3.4) and tipped onto the wall
    // (72° on main). That lands between 4.3 and 5.8 s, so the 6 s window above passed 7 of 21 throttle draws at wall 0.2 m and all 21 at 0.05 m by timing alone.
    const failures: string[] = [];
    let n = 0;
    for (const cls of VEHICLE_CLASS_IDS) {
      for (const off of [30, 45]) {
        for (const wall of [0.05, 0.2, 0.4]) {
          for (const dx of [-0.003, 0, 0.003]) {
            const r = approachSide(cls, off, wall, { frames: 720, dx });
            n++;
            if (r.roll > 30) failures.push(`${cls} ${off}° off the run, wall ${wall} m, spawn ${dx * 1000} mm: worst roll ${r.roll.toFixed(0)}°, reached z ${r.z.toFixed(1)}`);
          }
        }
      }
    }
    t.diagnostic(`${n} runs, ${failures.length} over 30°`);
    assert.deepEqual(failures, []);
  });
});
