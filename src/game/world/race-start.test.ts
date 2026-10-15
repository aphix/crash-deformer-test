import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";
import { startWrecks, WATCH } from "./race-start.test-util.ts";

describe("given a race started from the grid of the stunt course (Crossover Canyon) with every slot AI-driven, field seed 1", () => {
  it(`when 5 rivals race at the default aggression slider, then no car wrecks in the first ${WATCH} s of racing`, () => {
    assert.deepEqual(startWrecks("stunt", 1, 5, DEFAULT_RACE_OPTIONS.aggression), []);
  });

  it(`when 5 rivals race at the ramming maximum of the aggression slider, then some car is wrecked in the first ${WATCH} s of racing (the check can fail)`, () => {
    assert.ok(startWrecks("stunt", 1, 5, 1).length >= 1, "no wreck at the ramming maximum: the clean-start test above proves nothing");
  });
});
