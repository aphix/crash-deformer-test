import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bailControlName, bailPromptText, bailResultText } from "./bail-prompt.ts";
import { blankIntent, boostPadButton, DRIVE_KEYS, readIntent } from "../vehicle/drive-input.ts";
import { blankPad, PAD_BUTTON_COUNT, padButtonName, type PadFamily } from "../vehicle/gamepad.ts";

describe("given the pad button the drive input binds to Boost", () => {
  it("when every button is held in turn, then exactly the found one boosts, and no key does", () => {
    const found = boostPadButton();
    assert.ok(found !== null, "a button boosts");
    const boosting: number[] = [];
    for (let button = 0; button < PAD_BUTTON_COUNT; button++) {
      const pad = blankPad();
      pad.connected = true;
      pad.held = 1 << button;
      if (readIntent(new Set(), pad, blankIntent()).boost) boosting.push(button);
    }
    assert.equal(boosting.length, 1, `boosting buttons ${boosting.join(", ")}`);
    assert.equal(boosting[0], found, "the found button is the one that boosts");
    assert.ok(DRIVE_KEYS.boost.every((code) => readIntent(new Set([code]), null, blankIntent()).boost), "the boost keys boost");
  });
});

describe("given the control the bail prompt names", () => {
  const cases = [
    { it: "when the keyboard is in use, then it is Shift", padFamily: null, touch: false, expectedName: "Shift" },
    { it: "when a touch screen has no pad, then it is the Boost button", padFamily: null, touch: true, expectedName: "Boost" },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      assert.equal(bailControlName(testCase.padFamily, testCase.touch), testCase.expectedName);
    });
  }

  const padFamilies: readonly PadFamily[] = ["xbox", "playstation", "generic"];
  for (const family of padFamilies) {
    it(`when a ${family} pad is connected, then the name is what that pad calls the button the drive input binds to Boost`, () => {
      const button = boostPadButton()!;
      assert.equal(bailControlName(family, false), padButtonName(family, button));
    });
  }

  it("when a pad is connected on a touch screen too, then the pad's button is named, not the touch button", () => {
    assert.notEqual(bailControlName("xbox", true), "Boost");
  });

  it("when an Xbox pad and a PlayStation pad are connected, then they name the one binding differently", () => {
    assert.notEqual(bailControlName("xbox", false), bailControlName("playstation", false));
  });

  it("when a generic pad is connected, then it is named as an Xbox layout", () => {
    assert.equal(bailControlName("generic", false), bailControlName("xbox", false));
  });
});

describe("given the bail's texts", () => {
  it("when the prompt is named for a control, then it says to press it as the car hits the barrier", () => {
    assert.equal(bailPromptText("Cross", false), "Press Cross as you hit the barrier");
    assert.equal(bailPromptText("Cross", true), "Bail pressed");
  });

  it("when a verdict has a timing, then the result is rounded to hundredths of a second without a sign", () => {
    assert.equal(bailResultText({ kind: "early", offsetSeconds: -0.1234, quality: 0.5 }), "Early 0.12 s");
    assert.equal(bailResultText({ kind: "late", offsetSeconds: 0.0849, quality: 0.5 }), "Late 0.08 s");
  });
});
