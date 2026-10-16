import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { VEHICLE_CLASS_IDS } from "./vehicle-classes.ts";
import { crashedRun, DRIFT, loopRun, NAMED_LOOPS, track } from "./ejection-slope.test-util.ts";

describe("given a car that was hit once earlier and drives on, which the ground must not kill or throw its driver", () => {
  afterEach(() => setGround(null));

  const stunt = track("stunt");
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const pace of [20, 30, 38]) {
      it(`when a ${cls} hit on its flank drives over the stunt course's CRUSH crest and down the kicker at ${pace} m/s, then the engine block stays put and nobody is thrown`, (t) => {
        const r = crashedRun(stunt, cls, pace, "side", 860, 960);
        t.diagnostic(`${cls} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm, ended at s ${r.endS.toFixed(0)}`);
        assert.ok(r.reached, `the run stopped at s ${r.endS.toFixed(0)}, short of s 960`);
        assert.ok(r.end - r.settled <= DRIFT, `the block moved ${((r.end - r.settled) * 1000).toFixed(0)} mm with nothing touching the car`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }

  // Owner/EjectFalse: "a car hit once earlier, touched at the stunt CRUSH crest, gains 0.08-0.12 m phantom engine-block
  // travel" (drivetrainHealth, handling, HUD damage). A planted wreck's frame sits on its hubs' mean, the cell 0.05-0.09 m
  // off it, and a touch moves the anchor back to the cell: the block, read in that frame, moved by the cell's offset, and
  // touched every frame over s 885-902 it added 62-66 mm (15 of 15 cases, main 9e1250e). `updateDrivetrain` now reads a
  // side or rear hit's block against the cabin and only while the frame sits on it (to PLANT_QUIET): the touch adds none.
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const pace of [20, 30, 38]) {
      it(`when a ${cls} hit on its flank is touched all the way over the stunt course's CRUSH crest (s 885-902) at ${pace} m/s, then the touch adds under 5 mm of engine-block travel`, (t) => {
        const r = crashedRun(stunt, cls, pace, "side", 860, 960, [885, 902]);
        t.diagnostic(`${cls} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm`);
        assert.ok(r.reached, `the run stopped at s ${r.endS.toFixed(0)}, short of s 960`);
        assert.ok(r.end - r.settled <= DRIFT, `the touch moved the block ${((r.end - r.settled) * 1000).toFixed(1)} mm`);
        assert.ok(r.alive, "the engine died");
      });
    }
  }

  for (const hit of ["rear", "front"] as const) {
    for (const cls of ["sedan", "truck"] as const) {
      it(`when a ${cls} hit on its ${hit} drives over the crest at 30 m/s, then the engine block stays put and nobody is thrown`, () => {
        const r = crashedRun(stunt, cls, 30, hit, 860, 960);
        assert.ok(r.reached, `the run stopped at s ${r.endS.toFixed(0)}, short of s 960`);
        assert.ok(r.end - r.settled <= DRIFT, `the block moved ${((r.end - r.settled) * 1000).toFixed(0)} mm with nothing touching the car`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }

  // A car touched every frame up the stunt bowl's banks (s 200-340, roll to 20 deg) adds nothing to its block's travel. A touch wakes
  // the lattice, which sets on a bank (the cell sinks 60 mm, the block slides 65 mm across and 21 mm along the nose at roll 20 deg):
  // a rear hit's block read counted that set as its push (20.7-21.2 mm at 20, 25 and 30 m/s), and a side hit's read against the cabin
  // without the frame's offset counts it as crush (6.6 mm at 20 m/s, 23 mm at 30).
  for (const hit of ["side", "rear"] as const) {
    for (const pace of [20, 25, 30]) {
      it(`when a sedan hit on its ${hit} is touched all the way up the stunt bowl's banks (s 200-340) at ${pace} m/s, then the touch adds under 5 mm of engine-block travel`, (t) => {
        const r = crashedRun(stunt, "sedan", pace, hit, 200, 345, [200, 340]);
        t.diagnostic(`${hit} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm`);
        assert.ok(r.reached, `the run stopped at s ${r.endS.toFixed(0)}, short of s 345`);
        assert.ok(r.end - r.settled <= DRIFT, `the touch moved the block ${((r.end - r.settled) * 1000).toFixed(1)} mm`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }

  // The loops the owner named: the stunt bowl (banks to 15 deg) and crest, the oval's banks, the rally hairpin and its climbs. Every other course's whole loop is in ejection-slope.ai-long-run.ts.
  for (const course of NAMED_LOOPS) {
    for (const pace of [25, 32]) {
      it(`when a damaged sedan drives the whole ${course} loop at ${pace} m/s (banks, crests, climbs), then the engine block stays put and nobody is thrown`, (t) => {
        const trk = track(course);
        const r = loopRun(trk, pace);
        t.diagnostic(`${course} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm, ended at s ${r.endS.toFixed(0)} of ${trk.length.toFixed(0)}`);
        assert.ok(r.reached, `the run stopped at s ${r.endS.toFixed(0)} of ${trk.length.toFixed(0)}, short of its end`);
        assert.ok(r.end - r.settled <= DRIFT, `the block moved ${((r.end - r.settled) * 1000).toFixed(0)} mm with nothing touching the car`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }
});
