import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COURSE_IDS } from "./race-world.test-util.ts";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";
import { startWrecks, WATCH } from "./race-start.test-util.ts";

/**
 * Full-sanity sweep, not a per-commit test: the first ${WATCH} s of racing of every course's grid over several field seeds, watched for any wreck.
 * The per-commit `race-start.test.ts` holds the stunt start (the owner's report) at one seed, with the ramming field as its control.
 */
describe("given races started from the grid with every slot AI-driven, clean racing", () => {
  const slider = DEFAULT_RACE_OPTIONS.aggression;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`when 5 rivals race the stunt course (Crossover Canyon) at the default aggression slider with field seed ${seed}, then no car wrecks in the first ${WATCH} s of racing`, () => {
      assert.deepEqual(startWrecks("stunt", seed, 5, slider), []);
    });
  }
  for (const course of COURSE_IDS.filter((id) => id !== "city")) {
    for (const seed of [1, 2, 3, 4]) {
      it(`when a full 8-car grid races the ${course} course at the default aggression slider with field seed ${seed}, then no car wrecks in the first ${WATCH} s of racing`, () => {
        assert.deepEqual(startWrecks(course, seed, 7, slider), []);
      });
    }
  }
  it("when 5 rivals race the city course with the aggression slider at 0 (a clean field), then the oncoming street traffic round the first corner wrecks nobody", () => {
    assert.deepEqual(startWrecks("city", 1, 5, 0), []);
  });
});

describe("given races of 5 rivals on the stunt course with the aggression slider at the ramming maximum, every slot AI-driven", () => {
  it("when 8 field seeds race their first seconds, then some car is wrecked in the first seconds, with at least 8 wrecks over the 8 seeds", () => {
    let wrecks = 0;
    for (let seed = 1; seed <= 8; seed++) wrecks += startWrecks("stunt", seed, 5, 1).length;
    assert.ok(wrecks >= 8, `${wrecks} wrecks over 8 seeds`);
  });
});
