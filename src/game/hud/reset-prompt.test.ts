import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RaceView } from "../match/types.ts";
import { resetGlow, resetInput, resetPromptLabel } from "./reset-prompt.ts";

const view = (wheelsOff: number, canReset = true): RaceView => ({
  id: 0,
  racer: null,
  speedKph: 0,
  gear: 1,
  boost: null,
  boosting: false,
  wheelsOff,
  canReset,
});

describe("reset prompt", () => {
  it("good: it names the control of the input in use", () => {
    assert.equal(resetPromptLabel(view(2), "keyboard", true), "R");
    assert.equal(resetPromptLabel(view(2), "pad", true), "D-pad ↓");
    assert.equal(resetPromptLabel(view(2), "touch", true), "Respawn");
    assert.equal(resetPromptLabel(view(2), "touch", false), "Recover");
  });

  it("boundary: one wheel off keeps it down, two bring it up, all four keep it up", () => {
    assert.equal(resetPromptLabel(view(0), "keyboard", true), null);
    assert.equal(resetPromptLabel(view(1), "keyboard", true), null);
    assert.equal(resetPromptLabel(view(2), "keyboard", true), "R");
    assert.equal(resetPromptLabel(view(4), "keyboard", true), "R");
  });

  it("bad: a reset the game would refuse never shows a prompt, whatever the wheels", () => {
    assert.equal(resetPromptLabel(view(4, false), "keyboard", true), null);
    assert.equal(resetPromptLabel(view(3, false), "touch", false), null);
  });

  it("good: a connected pad wins; touch resets only while driving; the keyboard otherwise", () => {
    assert.equal(resetInput(true, true, true), "pad");
    assert.equal(resetInput(true, false, false), "pad");
    assert.equal(resetInput(false, true, true), "touch");
    assert.equal(resetInput(false, true, false), null);
    assert.equal(resetInput(false, false, false), "keyboard");
    assert.equal(resetInput(false, false, true), "keyboard");
  });

  describe("reset control glow", () => {
    const none = { race: null, derbyView: null, fleetView: null };
    const race = (v: RaceView | null) => ({ ...none, race: { view: v } });

    it("boundary: one wheel off no glow; two, three and four glow", () => {
      for (const [off, glows] of [[0, false], [1, false], [2, true], [3, true], [4, true]] as const) {
        assert.equal(resetGlow(race(view(off))), glows, `${off} off`);
      }
    });

    it("bad: a reset the game would refuse never glows, whatever the wheels", () => {
      for (const off of [2, 3, 4]) {
        assert.equal(resetGlow(race(view(off, false))), false, `race ${off} off`);
        assert.equal(resetGlow({ ...none, derbyView: view(off, false) }), false, `derby ${off} off`);
        assert.equal(resetGlow({ ...none, fleetView: view(off, false) }), false, `fleet ${off} off`);
      }
    });

    it("good: it follows the view of the scene in play: race, derby, fleet", () => {
      assert.equal(resetGlow(race(view(2))), true);
      assert.equal(resetGlow({ ...none, derbyView: view(2) }), true);
      assert.equal(resetGlow({ ...none, fleetView: view(2) }), true);
    });

    it("bad: no driven or watched car, no glow", () => {
      assert.equal(resetGlow(none), false);
      assert.equal(resetGlow(race(null)), false);
    });

    it("bad: a race's own view rules; a stale derby or fleet view never glows inside it", () => {
      assert.equal(resetGlow({ race: { view: view(1) }, derbyView: view(4), fleetView: view(4) }), false);
      assert.equal(resetGlow({ race: { view: null }, derbyView: view(4), fleetView: view(4) }), false);
    });
  });
});
