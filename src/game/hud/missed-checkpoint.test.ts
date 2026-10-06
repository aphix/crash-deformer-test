import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { holdResetLabel, missedCheckpointText } from "./reset-prompt.ts";

describe("given a checkpoint was missed, which the player cannot see", () => {
  it("when the control in use is the keyboard, a pad or the touch pad, then the banner says to hold that control to go back, not just that one was missed", () => {
    assert.equal(holdResetLabel("keyboard"), "hold R");
    assert.equal(missedCheckpointText({ canHold: true }, "keyboard"), "Missed checkpoint: hold R to go back");
    assert.equal(missedCheckpointText({ canHold: true }, "pad"), "Missed checkpoint: hold D-pad ↓ to go back");
    assert.equal(missedCheckpointText({ canHold: true }, "touch"), "Missed checkpoint: hold Respawn to go back");
  });

  it("when a hold would not act (spectating, a menu, Survival) or no control is on screen, then the banner only says a checkpoint was missed", () => {
    assert.equal(missedCheckpointText({ canHold: false }, "keyboard"), "Missed checkpoint");
    assert.equal(missedCheckpointText({}, "keyboard"), "Missed checkpoint");
    assert.equal(missedCheckpointText(null, "keyboard"), "Missed checkpoint");
    assert.equal(missedCheckpointText({ canHold: true }, null), "Missed checkpoint");
  });
});
