import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankPad, mergeTouch, PAD_BUTTON, PAD_DEAD, padLabel, readPad, stickScale, triggerValue, type PadSource } from "./gamepad.ts";
import { blankIntent, readIntent, shapeDrive } from "./drive-input.ts";
import { idleDrive } from "./car-drive.ts";
import { assertSameDigest } from "./test-support.ts";

/** A connected standard-mapping pad: `down` lists held button indices. */
function pad(axes: number[], down: number[] = [], lt = 0, rt = 0): PadSource {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const value = i === PAD_BUTTON.lt ? lt : i === PAD_BUTTON.rt ? rt : down.includes(i) ? 1 : 0;
    return { pressed: value > 0.5, value };
  });
  return { connected: true, axes, buttons };
}

describe("given a gamepad's sticks and triggers", () => {
  it("when a stick rests inside the radial deadzone, then it reads exactly zero in any direction", () => {
    assert.equal(stickScale(0.1, 0), 0);
    assert.equal(stickScale(0.1, -0.1), 0);
    assert.equal(stickScale(0, PAD_DEAD.stick * 0.99), 0);
    assert.ok(stickScale(0.12, 0.12) > 0, "a diagonal past the radius must register");
  });

  it("when a stick is pushed to full throw, then it reaches 1 and a diagonal corner never exceeds 1", () => {
    assert.ok(Math.abs(1 * stickScale(1, 0) - 1) < 1e-9);
    const s = stickScale(1, 1);
    assert.ok(Math.hypot(s, s) <= 1 + 1e-9, `corner magnitude ${Math.hypot(s, s)}`);
  });

  it("when a stick moves through its range, then the curve is gentler than linear mid-throw and continuous at the deadzone edge", () => {
    const mid = PAD_DEAD.stick + (1 - PAD_DEAD.stick) * 0.5;
    assert.ok(mid * stickScale(mid, 0) < 0.5, "mid-throw should steer less than half lock");
    const edge = PAD_DEAD.stick + 1e-3;
    assert.ok(edge * stickScale(edge, 0) < 1e-3, "no step at the deadzone edge");
    let last = 0;
    for (let x = 0; x <= 1; x += 0.01) {
      const out = x * stickScale(x, 0);
      assert.ok(out >= last - 1e-12, `non-monotonic at ${x}`);
      last = out;
    }
  });

  it("when a trigger is pulled, then it ignores resting noise and reaches 1 at full pull", () => {
    assert.equal(triggerValue(PAD_DEAD.trigger * 0.9), 0);
    assert.equal(triggerValue(1), 1);
    assert.ok(triggerValue(0.5) > 0.4 && triggerValue(0.5) < 0.5);
  });
});

describe("given a gamepad being polled", () => {
  it("when a button goes down, then it reports pressed only on the poll it went down", () => {
    const s = blankPad();
    const bit = 1 << PAD_BUTTON.north;
    readPad(pad([0, 0, 0, 0], [PAD_BUTTON.north]), s);
    assert.equal(s.pressed & bit, bit);
    readPad(pad([0, 0, 0, 0], [PAD_BUTTON.north]), s);
    assert.equal(s.pressed & bit, 0, "held, not pressed again");
    assert.equal(s.held & bit, bit);
    readPad(pad([0, 0, 0, 0]), s);
    readPad(pad([0, 0, 0, 0], [PAD_BUTTON.north]), s);
    assert.equal(s.pressed & bit, bit, "a second press registers");
  });

  it("when the pad is unplugged, then every axis and button reads zero", () => {
    const s = blankPad();
    readPad(pad([-1, 0, 1, 0], [PAD_BUTTON.south], 1, 1), s);
    assert.ok(s.connected && s.lx < -0.9 && s.rt === 1);
    readPad(null, s);
    assertSameDigest({ ...s }, blankPad(), "unplugged pad");
    readPad({ ...pad([-1, 0, 0, 0]), connected: false }, s);
    assert.equal(s.lx, 0);
  });

  it("when an Xbox pad or a PlayStation pad is named, then each gets its own label", () => {
    assert.equal(padLabel("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"), "Xbox controller");
    assert.equal(padLabel("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"), "PlayStation controller");
    assert.equal(padLabel("054c-0ce6-DualSense Wireless Controller"), "PlayStation controller");
    assert.equal(padLabel("Generic USB Joystick"), "Controller");
  });
});

describe("given a gamepad driving a car", () => {
  it("when the right trigger is held with the left stick pushed left, then the car gets gas and a left yaw (positive steer) rolling forward, and a right push steers the other way", () => {
    const s = blankPad();
    readPad(pad([-1, 0, 0, 0], [], 0, 1), s);
    const intent = readIntent(new Set(), s, blankIntent());
    assert.ok(intent.wheel > 0.99 && intent.analogWheel);
    assert.equal(intent.gas, 1);
    const feel = { wheel: 0, gas: 0, brake: 0 };
    const out = idleDrive();
    for (let i = 0; i < 30; i++) shapeDrive(intent, feel, 6, 1 / 60, out);
    assert.ok(out.steer > 0.5, `steer ${out.steer}`);
    assert.equal(out.throttle, 1);
    readPad(pad([1, 0, 0, 0], [], 0, 1), s);
    readIntent(new Set(), s, intent);
    for (let i = 0; i < 30; i++) shapeDrive(intent, feel, 6, 1 / 60, out);
    assert.ok(out.steer < -0.5, `stick right steer ${out.steer}`);
  });

  it("when the left trigger is pulled, then it is an analog brake and, once stopped, reverse", () => {
    const s = blankPad();
    readPad(pad([0, 0, 0, 0], [], 0.6, 0), s);
    const intent = readIntent(new Set(), s, blankIntent());
    const feel = { wheel: 0, gas: 0, brake: 0 };
    const out = idleDrive();
    shapeDrive(intent, feel, 8, 1 / 60, out);
    assert.ok(Math.abs(out.brake - triggerValue(0.6)) < 1e-9 && out.throttle === 0, "partial pull = partial brake, no ramp");
    shapeDrive(intent, feel, 0, 1 / 60, out);
    assert.ok(out.throttle < 0 && out.brake === 0);
  });

  it("when keyboard and pad inputs are used together, then per axis the larger magnitude wins", () => {
    const s = blankPad();
    readPad(pad([-0.4, 0, 0, 0], [], 0.4, 0), s);
    const i = readIntent(new Set(["KeyD", "KeyW"]), s, blankIntent());
    assert.equal(i.wheel, -1, "full D beats a light left stick");
    assert.equal(i.analogWheel, false);
    assert.equal(i.gas, 1);
    assert.ok(i.brake > 0 && i.analogBrake, "LT still reads while W is held");
    readPad(pad([-1, 0, 0, 0]), s);
    readIntent(new Set(), s, i);
    assert.ok(i.wheel > 0.99 && i.analogWheel);
  });

  it("when A (Cross) and X (Square) are pressed, then they act as the handbrake and the boost, alongside Space and Shift", () => {
    const s = blankPad();
    readPad(pad([0, 0, 0, 0], [PAD_BUTTON.south, PAD_BUTTON.west]), s);
    const i = readIntent(new Set(), s, blankIntent());
    assert.ok(i.handbrake && i.boost);
    readPad(pad([0, 0, 0, 0], [PAD_BUTTON.east]), s);
    readIntent(new Set(), s, i);
    assert.ok(!i.handbrake && !i.boost);
    readIntent(new Set(["Space", "ShiftRight"]), null, i);
    assert.ok(i.handbrake && i.boost);
  });

  it("when the touch stick is held up-left with no pad plugged in, then it is gas and a left wheel, and a sub-frame tap still presses once", () => {
    const s = blankPad();
    const t = { x: -0.7, y: -0.7, held: 0, tapped: 0 };
    readPad(null, s);
    mergeTouch(t, s, 0);
    const i = readIntent(new Set(), s, blankIntent());
    assert.ok(i.wheel > 0.5 && i.analogWheel, `wheel ${i.wheel}`);
    assert.ok(i.gas > 0.5 && i.brake === 0, `gas ${i.gas} brake ${i.brake}`);
    t.x = 0;
    t.y = 1;
    readPad(null, s);
    mergeTouch(t, s, s.held);
    const down = readIntent(new Set(), s, i);
    assert.ok(down.brake === 1 && down.gas === 0, "stick down brakes, then reverses");
    const view = 1 << PAD_BUTTON.north;
    t.y = 0;
    t.tapped = view;
    let prev = s.held;
    readPad(null, s);
    mergeTouch(t, s, prev);
    assert.equal(s.pressed & view, view, "tap released before the poll");
    prev = s.held;
    readPad(null, s);
    mergeTouch(t, s, prev);
    assert.equal(s.pressed, 0, "one tap, one press");
  });
});
