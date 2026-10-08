import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RaceHud } from "../match/types.ts";
import { captureSubmitShown, flagButton, updateNoticeShown } from "./submit-rules.ts";

describe("given the Debug section's capture toggle and its recorded samples", () => {
  const cases = [
    { it: "the capture is on with 12 samples", captureTrace: true, traceSamples: 12, expected: true },
    { it: "the capture is on and has recorded nothing yet", captureTrace: true, traceSamples: 0, expected: false },
    { it: "the capture is off though the spawn snapshot counts as 1 sample", captureTrace: false, traceSamples: 1, expected: false },
    { it: "the capture is off and empty", captureTrace: false, traceSamples: 0, expected: false },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the Submit button is ${testCase.expected ? "drawn" : "not drawn"}`, () => {
      assert.equal(captureSubmitShown(testCase), testCase.expected);
    });
  }
});

const REEL = { clips: [], playing: 0 } satisfies RaceHud["reel"];

describe("given the [!] flag over the results reel and over a solo view", () => {
  const cases = [
    { it: "the reel shows clip id 7", race: { reel: REEL, solo: null, shown: 7 }, expected: { visible: true, clip: 7 } },
    { it: "the reel is in its flight between clips", race: { reel: { ...REEL, playing: -1 }, solo: null, shown: null }, expected: { visible: true, clip: null } },
    { it: "a clip is watched alone (a reel clip, id 7)", race: { reel: REEL, solo: "Head-on", shown: 7 }, expected: { visible: true, clip: 7 } },
    { it: "a saved highlight is watched alone (id 12)", race: { reel: null, solo: "Wall hit", shown: 12 }, expected: { visible: true, clip: 12 } },
    { it: "no reel and no solo view is up", race: { reel: null, solo: null, shown: null }, expected: { visible: false, clip: null } },
    { it: "there is no race at all", race: null, expected: { visible: false, clip: null } },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the button is ${testCase.expected.visible ? "drawn" : "not drawn"} and bound to clip ${testCase.expected.clip}`, () => {
      const button = flagButton(testCase.race);
      assert.equal(button.visible, testCase.expected.visible);
      assert.equal(button.clip, testCase.expected.clip);
    });
  }

  it("when the reel moves on to the next clip after the button was drawn for clip 7, then the button's own binding is still clip 7", () => {
    const drawn = flagButton({ reel: REEL, solo: null, shown: 7 });
    flagButton({ reel: { ...REEL, playing: 1 }, solo: null, shown: 8 });
    assert.equal(drawn.clip, 7);
  });
});

describe("given a newer build is deployed", () => {
  const cases = [
    { it: "the player is in the fleet scene (no race)", race: null, expected: true },
    { it: "a race is on its setup menu or grid", race: { phase: "grid" as const }, expected: true },
    { it: "a race is counting down", race: { phase: "countdown" as const }, expected: false },
    { it: "a race is under way", race: { phase: "racing" as const }, expected: false },
    { it: "a race has finished and shows its results", race: { phase: "finished" as const }, expected: true },
    { it: "the race scene is up with no session", race: { phase: null }, expected: true },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the update notice is ${testCase.expected ? "shown" : "held back"}`, () => {
      assert.equal(updateNoticeShown("a1b2c3d", testCase.race), testCase.expected);
    });
  }

  it("when no newer build is deployed, then the notice is never shown", () => {
    assert.equal(updateNoticeShown(null, null), false);
  });
});
