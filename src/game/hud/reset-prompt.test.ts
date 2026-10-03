import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RaceView } from "../match/types.ts";
import { resetInput, resetPromptLabel } from "./reset-prompt.ts";

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
});
