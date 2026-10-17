import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driveKeys } from "./drive-keys.ts";

describe("given the driven car's key line", () => {
  const cases = [
    { it: "when a keyboard drives a car that may boost, then Shift boost is in the line", pad: false, boostable: true, expectedKeys: "W gas · S brake, then reverse · A/D steer · Space handbrake · Shift boost · drag look · V view · ` look back · R recover · Esc watch" },
    { it: "when a controller drives a car that may boost, then X boost is in the line", pad: true, boostable: true, expectedKeys: "RT gas · LT brake, then reverse · left stick steer · A handbrake · X boost · Y view · R3 look back · right stick look · LB/RB car · D-pad ↓ recover · Back watch" },
    { it: "when a keyboard drives the Long jump's car, then the line has no boost and nothing else changes", pad: false, boostable: false, expectedKeys: "W gas · S brake, then reverse · A/D steer · Space handbrake · drag look · V view · ` look back · R recover · Esc watch" },
    { it: "when a controller drives the Long jump's car, then the line has no boost and nothing else changes", pad: true, boostable: false, expectedKeys: "RT gas · LT brake, then reverse · left stick steer · A handbrake · Y view · R3 look back · right stick look · LB/RB car · D-pad ↓ recover · Back watch" },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      assert.equal(driveKeys(testCase.pad, testCase.boostable), testCase.expectedKeys);
    });
  }
});
