import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PAD_BUTTON, blankPad } from "../vehicle/gamepad.ts";
import { blankFreeInput } from "../present/free-cam.ts";
import { readFreeInput } from "./engine-free.ts";

describe("given the keys and sticks held in the free view", () => {
  const keyed = [
    { it: "when W is held, then forward is 1", keys: ["KeyW"], expectedForward: 1, expectedStrafe: 0, expectedRise: 0, expectedFast: false },
    { it: "when the up arrow is held, then forward is 1", keys: ["ArrowUp"], expectedForward: 1, expectedStrafe: 0, expectedRise: 0, expectedFast: false },
    { it: "when S is held, then forward is -1", keys: ["KeyS"], expectedForward: -1, expectedStrafe: 0, expectedRise: 0, expectedFast: false },
    { it: "when A is held, then strafe is -1 (left)", keys: ["KeyA"], expectedForward: 0, expectedStrafe: -1, expectedRise: 0, expectedFast: false },
    { it: "when the right arrow is held, then strafe is 1 (right)", keys: ["ArrowRight"], expectedForward: 0, expectedStrafe: 1, expectedRise: 0, expectedFast: false },
    { it: "when PageUp is held, then rise is 1", keys: ["PageUp"], expectedForward: 0, expectedStrafe: 0, expectedRise: 1, expectedFast: false },
    { it: "when PageDown is held, then rise is -1", keys: ["PageDown"], expectedForward: 0, expectedStrafe: 0, expectedRise: -1, expectedFast: false },
    { it: "when W and S are held together, then they cancel", keys: ["KeyW", "KeyS"], expectedForward: 0, expectedStrafe: 0, expectedRise: 0, expectedFast: false },
    { it: "when Shift and W are held, then forward is 1 and fast is on", keys: ["ShiftLeft", "KeyW"], expectedForward: 1, expectedStrafe: 0, expectedRise: 0, expectedFast: true },
    { it: "when Q and E are held (the car-switch keys), then nothing flies", keys: ["KeyQ", "KeyE"], expectedForward: 0, expectedStrafe: 0, expectedRise: 0, expectedFast: false },
  ];
  for (const testCase of keyed) {
    it(testCase.it, () => {
      const out = readFreeInput(new Set(testCase.keys), blankPad(), false, blankFreeInput());
      assert.equal(out.forward, testCase.expectedForward, "forward");
      assert.equal(out.strafe, testCase.expectedStrafe, "strafe");
      assert.equal(out.rise, testCase.expectedRise, "rise");
      assert.equal(out.fast, testCase.expectedFast, "fast");
    });
  }

  it("when the left stick is pushed up and right, then forward and strafe follow it, and the right stick is the look", () => {
    const pad = { ...blankPad(), lx: 0.5, ly: -0.75, rx: 0.25, ry: -0.5 };
    const out = readFreeInput(new Set(), pad, false, blankFreeInput());
    assert.equal(out.forward, 0.75, "forward");
    assert.equal(out.strafe, 0.5, "strafe");
    assert.equal(out.lookX, 0.25, "look x");
    assert.equal(out.lookY, -0.5, "look y");
  });

  it("when the right trigger is pulled 0.6 and the left 0.2, then rise is the difference, and X is fast", () => {
    const pad = { ...blankPad(), rt: 0.6, lt: 0.2, held: 1 << PAD_BUTTON.west };
    const out = readFreeInput(new Set(), pad, false, blankFreeInput());
    assert.ok(Math.abs(out.rise - 0.4) < 1e-9, `rise ${out.rise}`);
    assert.equal(out.fast, true, "fast");
  });

  it("when W and S cancel and the left stick is pushed up 0.4, then forward is the stick's 0.4", () => {
    const pad = { ...blankPad(), ly: -0.4 };
    assert.equal(readFreeInput(new Set(["KeyW", "KeyS"]), pad, false, blankFreeInput()).forward, 0.4);
  });

  it("when a menu holds the keys, then every axis is zero with keys and sticks down", () => {
    const pad = { ...blankPad(), lx: 1, ly: -1, rx: 1, ry: 1, rt: 1, held: 1 << PAD_BUTTON.west };
    const out = readFreeInput(new Set(["KeyW", "KeyD", "PageUp", "ShiftLeft"]), pad, true, { forward: 1, strafe: 1, rise: 1, lookX: 1, lookY: 1, fast: true });
    assert.equal(out.forward, 0, "forward");
    assert.equal(out.strafe, 0, "strafe");
    assert.equal(out.rise, 0, "rise");
    assert.equal(out.lookX, 0, "look x");
    assert.equal(out.lookY, 0, "look y");
    assert.equal(out.fast, false, "fast");
  });
});
