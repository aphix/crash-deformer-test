import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driveKeys } from "./drive-keys.ts";
import { boostPadButton } from "../vehicle/drive-input.ts";
import { padButtonName } from "../vehicle/gamepad.ts";

describe("given the driven car's key line", () => {
  const cases = [
    { it: "when a keyboard drives a car that may boost, then Shift boost is in the line", pad: false, boostable: true, expectedKeys: "W gas · S brake, then reverse · A/D steer · Space handbrake · Shift boost · drag look · V view · ` look back · R recover · Esc watch" },
    { it: "when a controller drives a car that may boost, then A boost is in the line", pad: true, boostable: true, expectedKeys: "RT gas · LT brake, then reverse · left stick steer · X handbrake · A boost · Y view · R3 look back · right stick look · LB/RB car · D-pad ↓ recover · Back watch" },
    { it: "when a keyboard drives the Long jump's car, then the line has no boost and nothing else changes", pad: false, boostable: false, expectedKeys: "W gas · S brake, then reverse · A/D steer · Space handbrake · drag look · V view · ` look back · R recover · Esc watch" },
    { it: "when a controller drives the Long jump's car, then the line has no boost and nothing else changes", pad: true, boostable: false, expectedKeys: "RT gas · LT brake, then reverse · left stick steer · X handbrake · Y view · R3 look back · right stick look · LB/RB car · D-pad ↓ recover · Back watch" },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      assert.equal(driveKeys(testCase.pad, testCase.boostable), testCase.expectedKeys);
    });
  }
});

describe("given the pad button the drive input binds to Boost", () => {
  it("when a controller drives a car that may boost, then the line names that button as boost", () => {
    const button = boostPadButton();
    assert.ok(button !== null, "a pad button boosts");
    const name = padButtonName("generic", button);
    assert.ok(driveKeys(true, true).split(" · ").includes(`${name} boost`), `no "${name} boost" in: ${driveKeys(true, true)}`);
  });
});
