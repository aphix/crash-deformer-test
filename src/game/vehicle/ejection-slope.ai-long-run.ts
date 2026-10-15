import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { parseTrack } from "../world/track-schema.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { crashedRun, DRIFT, NAMED_LOOPS, track } from "./ejection-slope.test-util.ts";

/**
 * The slope tests' full-sanity sweep (`npm run test:ai-long-run`, not the per-commit suite): a damaged sedan driven round the whole
 * main loop of every course the owner's report did not name (the named ones, `NAMED_LOOPS`, run in ejection-slope.test.ts), 2.9 to 4.5 km
 * of road each, hoping a slope or bank the staged crest runs do not reach kills the engine or throws the driver.
 */
describe("given a car that was hit once earlier and drives on, which the ground must not kill or throw its driver", () => {
  afterEach(() => setGround(null));

  for (const course of TRACKS.map((j) => parseTrack(j).id).filter((id) => id !== "city" && !(NAMED_LOOPS as readonly string[]).includes(id))) {
    for (const pace of [25, 32]) {
      it(`when a damaged sedan drives the whole ${course} loop at ${pace} m/s (banks, crests, climbs), then the engine block stays put and nobody is thrown`, (t) => {
        const trk = track(course);
        const r = crashedRun(trk, "sedan", pace, "side", 60, trk.length - 30);
        t.diagnostic(`${course} ${pace} m/s: block travel ${(r.settled * 1000).toFixed(1)} -> ${(r.end * 1000).toFixed(1)} mm, ended at s ${r.endS.toFixed(0)} of ${trk.length.toFixed(0)}`);
        assert.ok(r.end - r.settled <= DRIFT, `the block moved ${((r.end - r.settled) * 1000).toFixed(0)} mm with nothing touching the car`);
        assert.ok(r.alive, "the engine died");
        assert.deepEqual(r.thrown, []);
      });
    }
  }
});
