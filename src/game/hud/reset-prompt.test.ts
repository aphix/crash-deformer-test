import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RaceView } from "../match/types.ts";
import { needsReset, resetGlow, resetInput, resetPromptLabel } from "./reset-prompt.ts";

const view = (wheelsOff: number, canReset = true): RaceView => ({
  id: 0,
  racer: null,
  speedKph: 0,
  gear: 1,
  rpm: 0.3,
  damage: 1,
  chase: null,
  boost: null,
  boosting: false,
  wheelsOff,
  canReset,
});

describe("given a car view reporting how many wheels are off and whether the game would allow a reset", () => {
  it("when the input in use is the keyboard, a pad or touch, then the reset prompt names that input's control: R, D-pad ↓, and Respawn in a race or Recover otherwise", () => {
    assert.equal(resetPromptLabel(view(2), "keyboard", true), "R");
    assert.equal(resetPromptLabel(view(2), "pad", true), "D-pad ↓");
    assert.equal(resetPromptLabel(view(2), "touch", true), "Respawn");
    assert.equal(resetPromptLabel(view(2), "touch", false), "Recover");
  });

  it("when 0, 1, 2 and 4 wheels are off, then the prompt stays down with one wheel off or none, and comes up with two or all four", () => {
    assert.equal(resetPromptLabel(view(0), "keyboard", true), null);
    assert.equal(resetPromptLabel(view(1), "keyboard", true), null);
    assert.equal(resetPromptLabel(view(2), "keyboard", true), "R");
    assert.equal(resetPromptLabel(view(4), "keyboard", true), "R");
  });

  it("when the game would refuse the reset, then the prompt never shows, whatever the wheels", () => {
    assert.equal(resetPromptLabel(view(4, false), "keyboard", true), null);
    assert.equal(resetPromptLabel(view(3, false), "touch", false), null);
  });

  it("when a pad is connected, only touch is in use, or neither, then a connected pad wins, touch resets only while driving, and the keyboard is used otherwise", () => {
    assert.equal(resetInput(true, true, true), "pad");
    assert.equal(resetInput(true, false, false), "pad");
    assert.equal(resetInput(false, true, true), "touch");
    assert.equal(resetInput(false, true, false), null);
    assert.equal(resetInput(false, false, false), "keyboard");
    assert.equal(resetInput(false, false, true), "keyboard");
  });

  it("when 1, 2 and 4 wheels are off, and 4 are off but the game would refuse, then a reset is needed with two or more wheels off and an allowed reset, nothing else", () => {
    assert.equal(needsReset(view(1)), false);
    assert.equal(needsReset(view(2)), true);
    assert.equal(needsReset(view(4)), true);
    assert.equal(needsReset(view(4, false)), false);
  });

  describe("given the reset controls' glow, driven by the viewed car of the scene in play", () => {
    const none = { race: null, derbyView: null, fleetView: null };
    const race = (v: RaceView | null) => ({ ...none, race: { view: v } });

    it("when 0 to 4 wheels are off in a race, then the controls glow only with two, three or four off", () => {
      for (const [off, glows] of [[0, false], [1, false], [2, true], [3, true], [4, true]] as const) {
        assert.equal(resetGlow(race(view(off))), glows, `${off} off`);
      }
    });

    it("when the game would refuse the reset, then the controls never glow in a race, a derby or the fleet, whatever the wheels", () => {
      for (const off of [2, 3, 4]) {
        assert.equal(resetGlow(race(view(off, false))), false, `race ${off} off`);
        assert.equal(resetGlow({ ...none, derbyView: view(off, false) }), false, `derby ${off} off`);
        assert.equal(resetGlow({ ...none, fleetView: view(off, false) }), false, `fleet ${off} off`);
      }
    });

    it("when two wheels are off in a race, a derby or the fleet, then the controls glow, following the view of the scene in play", () => {
      assert.equal(resetGlow(race(view(2))), true);
      assert.equal(resetGlow({ ...none, derbyView: view(2) }), true);
      assert.equal(resetGlow({ ...none, fleetView: view(2) }), true);
    });

    it("when there is no driven or watched car, then the controls do not glow", () => {
      assert.equal(resetGlow(none), false);
      assert.equal(resetGlow(race(null)), false);
    });

    it("when a race has its own view, then a stale derby or fleet view never makes the controls glow inside it", () => {
      assert.equal(resetGlow({ race: { view: view(1) }, derbyView: view(4), fleetView: view(4) }), false);
      assert.equal(resetGlow({ race: { view: null }, derbyView: view(4), fleetView: view(4) }), false);
    });
  });
});
