import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { SWINGS, driveLine, lineIds, type Finding } from "./checkpoint-sweep.test-util.ts";

const show = (f: Finding): string =>
  `${f.swing}: ${f.kind} on lap ${f.lap + 1} at main s=${f.s.toFixed(0)} m, ${f.lateral.toFixed(1)} m off the road, at (${f.x.toFixed(0)}, ${f.z.toFixed(0)}): ${f.detail}`;

/**
 * The checkpoints are invisible: a player who missed one has no idea how far back to go, and WRONG WAY on a road they are driving
 * the right way round is a lie. A scripted car follows each line of each course (the main loop, and every shortcut) at race speed
 * through the real RaceSession and Track, weaving, kicked sideways at every corner and every 23-90 m, and straying up to 10 m past
 * the road's edge wherever there is no wall (`SWINGS`).
 */
describe("given a scripted car that follows a line of a course at race speed, swinging up to 10 m off the road and knocked sideways", () => {
  for (const json of TRACKS) {
    const track = new Track(json);
    for (const { id, cut } of lineIds(track)) {
      it(`when it follows ${cut < 0 ? "the main loop" : `the ${id} shortcut`} of ${track.id} for two laps in each of ${SWINGS.length} ways of swinging, then it never misses a checkpoint, never sees WRONG WAY and completes its laps`, () => {
        const found = SWINGS.flatMap((how) => driveLine(track, cut, how));
        assert.deepEqual(found.map(show), []);
      });
    }
  }
});
