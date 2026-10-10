import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VOICE_FULL_RANGE_M, VOICE_MAX_RANGE_M, VOICE_RESUME_RANGE_M, voiceGain, voiceSendOpen } from "./voice-range.ts";

/** The Web Audio linear distance model with rolloff 1 (the spec's formula), the curve the owner asked for. */
const specLinearGain = (distance: number): number =>
  1 - (Math.min(Math.max(distance, VOICE_FULL_RANGE_M), VOICE_MAX_RANGE_M) - VOICE_FULL_RANGE_M) / (VOICE_MAX_RANGE_M - VOICE_FULL_RANGE_M);

/** `measuredGain`: a real Chromium 149 PannerNode (linear, ref 12, max 30) read back through an AnalyserNode; its read-back is good to about 0.01. */
const gainCases = [
  { it: "when the speaker is 5 m away, then it is heard at full strength", distance: 5, measuredGain: 1.0 },
  { it: "when the speaker is exactly at the full-strength range, then it is still at full strength", distance: VOICE_FULL_RANGE_M, measuredGain: 1.0 },
  { it: "when the speaker is 20 m away, then it is heard at about half strength", distance: 20, measuredGain: 0.56 },
  { it: "when the speaker is 29 m away, then it is barely heard", distance: 29, measuredGain: 0.06 },
  { it: "when the speaker is exactly at the maximum range, then it is silent", distance: VOICE_MAX_RANGE_M, measuredGain: 0 },
  { it: "when the speaker is 31 m away, then it is silent", distance: 31, measuredGain: 0 },
  { it: "when the speaker is 35 m away, then it is silent", distance: 35, measuredGain: 0 },
] as const;

describe("given a listener and a speaker some distance apart", () => {
  for (const testCase of gainCases) {
    it(testCase.it, () => {
      const gain = voiceGain(testCase.distance);
      assert.ok(Math.abs(gain - specLinearGain(testCase.distance)) < 1e-12, `gain ${gain} follows the linear distance model`);
      assert.ok(Math.abs(gain - testCase.measuredGain) < 0.01, `gain ${gain} matches the measured panner's ${testCase.measuredGain}`);
    });
  }

  it("when the distance grows, then the gain never rises", () => {
    let previous = voiceGain(0);
    for (let distance = 0.5; distance <= 40; distance += 0.5) {
      const gain = voiceGain(distance);
      assert.ok(gain <= previous, `gain at ${distance} m (${gain}) is no more than the gain before it (${previous})`);
      previous = gain;
    }
  });
});

const gateCases = [
  { it: "when a speaker being sent to is 29 m away, then it is still sent to", distance: 29, wasOpen: true, expectedOpen: true },
  { it: "when a speaker being sent to is just inside the maximum range, then it is still sent to", distance: VOICE_MAX_RANGE_M - 0.01, wasOpen: true, expectedOpen: true },
  { it: "when a speaker being sent to reaches the maximum range, then it is no longer sent to", distance: VOICE_MAX_RANGE_M, wasOpen: true, expectedOpen: false },
  { it: "when a speaker being sent to is 35 m away, then it is no longer sent to", distance: 35, wasOpen: true, expectedOpen: false },
  { it: "when a speaker not being sent to is 31 m away, then it is still not sent to", distance: 31, wasOpen: false, expectedOpen: false },
  { it: "when a speaker not being sent to is at the maximum range, then it is still not sent to", distance: VOICE_MAX_RANGE_M, wasOpen: false, expectedOpen: false },
  { it: "when a speaker not being sent to is between the resume and maximum ranges, then it is still not sent to", distance: (VOICE_RESUME_RANGE_M + VOICE_MAX_RANGE_M) / 2, wasOpen: false, expectedOpen: false },
  { it: "when a speaker not being sent to comes within the resume range, then it is sent to again", distance: VOICE_RESUME_RANGE_M, wasOpen: false, expectedOpen: true },
  { it: "when a speaker not being sent to is 5 m away, then it is sent to", distance: 5, wasOpen: false, expectedOpen: true },
] as const;

describe("given a speaker whose browser sends to a listener only while within range", () => {
  for (const testCase of gateCases) {
    it(testCase.it, () => {
      assert.equal(voiceSendOpen(testCase.distance, testCase.wasOpen), testCase.expectedOpen, "sending");
    });
  }

  it("when a listener drifts out past the maximum range and back to just inside it, then sending resumes only at the resume range", () => {
    const path = [28, VOICE_MAX_RANGE_M - 0.1, VOICE_MAX_RANGE_M + 0.5, VOICE_MAX_RANGE_M - 0.5, VOICE_RESUME_RANGE_M];
    const expectedOpen = [true, true, false, false, true];
    let open = false;
    for (let step = 0; step < path.length; step++) {
      open = voiceSendOpen(path[step]!, open);
      assert.equal(open, expectedOpen[step], `step ${step} at ${path[step]} m`);
    }
  });

  it("when the resume range is read against the maximum range, then the resume range is the nearer, so the gate has a band that cannot flicker", () => {
    assert.ok(VOICE_RESUME_RANGE_M < VOICE_MAX_RANGE_M, "resume range is inside the maximum range");
    assert.ok(VOICE_FULL_RANGE_M < VOICE_RESUME_RANGE_M, "full-strength range is inside the resume range");
  });
});
