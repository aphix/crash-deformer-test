import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AI_DIFFICULTIES } from "../ai/constants.ts";
import { setGround } from "./ground.ts";
import { contactRace } from "./race-contact.test-util.ts";
import { COURSE_IDS, makeWorld } from "./race-world.test-util.ts";
import { parseTrack } from "./track-schema.ts";
import { Track } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";

/**
 * Full-sanity sweep, not a per-commit test: whole fields watched for any racer driving into another car.
 *
 * Each rival rolls its aggression in [0, slider]: at 0 every field is the same, so the seed does not vary the race, the course and the field size do.
 * Medium and hard hold it: a medium rival is at most 10 ms stale and its contact guard runs every slice. Easy rivals decide up to 200 ms late (a car 77 ms
 * behind a lead that brakes hard at 40 m/s closes the gap before it looks again: razor-shelf x4 at 10 Hz, city x7 at 20 Hz), so no clean-racing bar is claimed
 * for them; `race-ai.test.ts` holds their laps and road share.
 *
 * The mechanism it guards, a holding driver's contact guard braking for a car ahead every slice, is pinned in `race-ai.test.ts`
 * ("given a stale medium driver holding its last drive between thinks, with a stopped car 8 m ahead of it at 17 m/s").
 */
for (const difficulty of AI_DIFFICULTIES.slice(1)) {
  describe(`given the aggression slider at 0, so every rival is as gentle as can be and the field seed does not vary the race, at ${difficulty} AI`, () => {
    for (const course of COURSE_IDS) {
      for (const aiCount of [4, 7]) {
        it(`when a 2-lap race runs on the ${course} course with ${aiCount} AI rivals, then no racer drives into another car`, (t) => {
          const track = new Track(TRACKS.find((j) => parseTrack(j).id === course));
          const w = makeWorld();
          w.race.enter();
          try {
            const r = contactRace(w, track, 4.5 + 2 * 3 * (track.length / 9), 1, 0, aiCount, difficulty);
            const mine = r.contacts.filter((c) => !c.traffic && c.initiator >= 0);
            t.diagnostic(`${course} x${aiCount}: ${r.contacts.length} contacts, ${mine.length} racer-initiated, finished ${r.outcome.finished}`);
            const hits = mine.map((c) => `frame ${c.frame}: car ${c.initiator} into car ${c.initiator === c.a ? c.b : c.a} (closing ${c.verdict.closing.toFixed(1)} m/s)`);
            assert.equal(hits.length, 0, hits.join("; "));
          } finally {
            w.race.exit();
            setGround(null);
          }
        });
      }
    }
  });
}
