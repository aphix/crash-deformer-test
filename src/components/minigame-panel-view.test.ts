import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_HUD } from "../game/hud/hud-store.ts";
import { MINIGAME_MODES, MODE_LABELS, THROWS_PER_SET } from "../game/scenes/minigame-constants.ts";
import type { MinigameHudState } from "../game/scenes/minigame-session.ts";
import { minigamePanelView } from "./minigame-panel-view.ts";

const LONG_JUMP_READY: MinigameHudState = {
  mode: "longJump",
  phase: "ready",
  attempt: 1,
  throwsPerSet: null,
  liveValue: null,
  lastScore: null,
  setScores: [],
  setTotal: 0,
  setComplete: false,
  best: { thisCar: null, overall: null },
};
const RING_SET_LENGTH = 5;
const RING_READY: MinigameHudState = { ...LONG_JUMP_READY, mode: "ringFling", throwsPerSet: RING_SET_LENGTH };

describe("given the minigame HUD slice", () => {
  it("when the HUD starts, then no minigame is running", () => {
    assert.equal(INITIAL_HUD.minigame, null);
  });
});

describe("given a long jump in each phase", () => {
  it("when ready, then Reset run works and Retry does not", () => {
    const view = minigamePanelView(LONG_JUMP_READY);
    assert.equal(view.resetEnabled, true);
    assert.equal(view.retryEnabled, false);
    assert.equal(view.retryLabel, "Retry");
  });

  it("when running, then Reset run works and the live value reads in metres", () => {
    const view = minigamePanelView({ ...LONG_JUMP_READY, phase: "running", liveValue: 12.34 });
    assert.equal(view.resetEnabled, true);
    assert.equal(view.retryEnabled, false);
    assert.equal(view.live, "12.3 m");
  });

  it("when thrown, then neither Retry nor Reset run works", () => {
    const view = minigamePanelView({ ...LONG_JUMP_READY, phase: "thrown", liveValue: 20 });
    assert.equal(view.resetEnabled, false);
    assert.equal(view.retryEnabled, false);
  });

  it("when scored, then Retry works, Reset run does not and the Score line shows", () => {
    const view = minigamePanelView({ ...LONG_JUMP_READY, phase: "scored", lastScore: 31.25, best: { thisCar: 31.25, overall: 40 } });
    assert.equal(view.retryEnabled, true);
    assert.equal(view.resetEnabled, false);
    assert.equal(view.score, "31.3 m");
    assert.equal(view.bestThisCar, "31.3 m");
    assert.equal(view.bestOverall, "40.0 m");
  });

  it("when it is not a Ring Fling, then there is no throw counter, set line or stepper", () => {
    const view = minigamePanelView(LONG_JUMP_READY);
    assert.equal(view.throwCounter, null);
    assert.equal(view.setScores, null);
    assert.equal(view.total, null);
    assert.equal(view.stepper, null);
  });

  it("when no score is yet recorded, then the bests read as a dash", () => {
    assert.equal(minigamePanelView(LONG_JUMP_READY).bestOverall, "–");
  });
});

describe("given the quick-switch list", () => {
  for (const mode of MINIGAME_MODES) {
    it(`when the mode is ${mode}, then the list holds the other modes with their labels`, () => {
      const others = minigamePanelView({ ...LONG_JUMP_READY, mode }).otherModes;
      const expected = MINIGAME_MODES.filter((other) => other !== mode);
      assert.equal(others.length, expected.length);
      for (let index = 0; index < expected.length; index++) {
        assert.equal(others[index]?.mode, expected[index]);
        assert.equal(others[index]?.label, MODE_LABELS[expected[index]!]);
      }
    });
  }
});

describe("given a Ring Fling", () => {
  it("when between throws, then the button reads Next throw and the counter shows the place", () => {
    const view = minigamePanelView({ ...RING_READY, phase: "scored", attempt: 2, lastScore: 30, setScores: [20, 30], setTotal: 50 });
    assert.equal(view.retryLabel, "Next throw");
    assert.equal(view.throwCounter, "Throw 2 / 5");
    assert.equal(view.setScores, "20 pts · 30 pts");
    assert.equal(view.total, "50 pts");
    assert.equal(view.totalLabel, "Total");
    assert.equal(view.score, "30 pts");
  });

  it("when the set is complete, then the button reads New set and the total is the Best", () => {
    const view = minigamePanelView({ ...RING_READY, phase: "scored", attempt: 5, lastScore: 10, setScores: [10, 10, 10, 10, 10], setTotal: 50, setComplete: true });
    assert.equal(view.retryLabel, "New set");
    assert.equal(view.totalLabel, "Best");
    assert.equal(view.total, "50 pts");
    assert.equal(view.score, "50 pts");
    assert.equal(view.retryEnabled, true);
  });

  it("when the stepper is shown, then its bounds come from THROWS_PER_SET", () => {
    const atMin = minigamePanelView({ ...RING_READY, throwsPerSet: THROWS_PER_SET.min }).stepper;
    const atMax = minigamePanelView({ ...RING_READY, throwsPerSet: THROWS_PER_SET.max }).stepper;
    const between = minigamePanelView({ ...RING_READY, throwsPerSet: THROWS_PER_SET.min + 1 }).stepper;
    assert.equal(atMin?.value, THROWS_PER_SET.min, "value at the min");
    assert.equal(atMin?.canDecrease, false, "no decrease at the min");
    assert.equal(atMin?.canIncrease, true, "increase at the min");
    assert.equal(atMax?.value, THROWS_PER_SET.max, "value at the max");
    assert.equal(atMax?.canDecrease, true, "decrease at the max");
    assert.equal(atMax?.canIncrease, false, "no increase at the max");
    assert.equal(between?.value, THROWS_PER_SET.min + 1, "value between the bounds");
    assert.equal(between?.canDecrease, true, "decrease between the bounds");
    assert.equal(between?.canIncrease, true, "increase between the bounds");
  });

  it("when a set is under way, then the stepper is locked", () => {
    const midSet = minigamePanelView({ ...RING_READY, phase: "scored", attempt: 2, setScores: [10], setTotal: 10 }).stepper;
    const running = minigamePanelView({ ...RING_READY, phase: "running" }).stepper;
    assert.deepEqual([midSet?.canDecrease, midSet?.canIncrease, running?.canDecrease, running?.canIncrease], [false, false, false, false]);
  });

  it("when the set is complete, then the stepper opens again", () => {
    const done = minigamePanelView({ ...RING_READY, phase: "scored", setScores: [1], setTotal: 1, setComplete: true }).stepper;
    assert.equal(done?.canIncrease, true);
  });
});
