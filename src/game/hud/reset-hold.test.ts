import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RESET_HOLD, ResetHold } from "./reset-hold.ts";

const FRAME = 1 / 60;

/** Press for `secs` (in frames) then release; every step's result in order, with the fill after each. */
function press(h: ResetHold, secs: number): { acts: (string | null)[]; fills: number[] } {
  const acts: (string | null)[] = [];
  const fills: number[] = [];
  for (let t = 0; t < secs - 1e-9; t += FRAME) {
    acts.push(h.step(true, FRAME));
    fills.push(h.fill);
  }
  acts.push(h.step(false, FRAME));
  fills.push(h.fill);
  return { acts, fills };
}

describe("given a reset control pressed and released", () => {
  it("when it is released before the hold time, then the release is a tap and nothing acted while it was down", () => {
    const h = new ResetHold();
    const { acts } = press(h, RESET_HOLD * 0.5);
    assert.deepEqual(acts.filter((a) => a !== null), ["tap"]);
    assert.equal(acts[acts.length - 1], "tap");
  });

  it("when it stays down to the hold time, then the hold acts once on the step it completes, and the release after it is nothing", () => {
    const h = new ResetHold();
    const { acts } = press(h, RESET_HOLD * 1.6);
    assert.deepEqual(acts.filter((a) => a !== null), ["hold"]);
    assert.notEqual(acts[acts.length - 1], "tap");
    const at = (acts.indexOf("hold") + 1) * FRAME;
    assert.ok(at >= RESET_HOLD && at < RESET_HOLD + 2 * FRAME, `the hold acted at ${at.toFixed(3)} s`);
  });

  it("when it is down, then the fill rises from 0 to 1 over the hold time, and is empty after the hold acts, after a release, and with nothing pressed", () => {
    const h = new ResetHold();
    assert.equal(h.fill, 0);
    const { fills } = press(h, RESET_HOLD * 1.5);
    assert.ok(fills[0]! > 0 && fills[0]! < 0.1);
    assert.ok(Math.abs(fills[Math.floor(RESET_HOLD / FRAME / 2)]! - 0.5) < 0.05, "half way at half the time");
    assert.ok(fills.slice(0, Math.floor(RESET_HOLD / FRAME) - 1).every((f, i, a) => i === 0 || f >= a[i - 1]!), "never falls while held");
    assert.equal(fills[fills.length - 1], 0, "empty after the release");
    const k = new ResetHold();
    for (let t = 0; t < RESET_HOLD + 0.1; t += FRAME) k.step(true, FRAME);
    assert.equal(k.fill, 0, "empty once it has acted, though still down");
  });

  it("when the press is cancelled (a menu opened) before the hold time, then neither a tap nor a hold follows, and a fresh press starts from empty", () => {
    const h = new ResetHold();
    for (let t = 0; t < RESET_HOLD * 0.5; t += FRAME) h.step(true, FRAME);
    h.cancel();
    assert.equal(h.fill, 0);
    assert.equal(h.step(false, FRAME), null);
    assert.equal(h.step(true, FRAME), null);
    assert.ok(h.fill < 0.05);
  });

  it("when two presses follow each other, then each is its own tap or hold", () => {
    const h = new ResetHold();
    const acts = [...press(h, 0.1).acts, ...press(h, RESET_HOLD + 0.2).acts, ...press(h, 0.1).acts].filter((a) => a !== null);
    assert.deepEqual(acts, ["tap", "hold", "tap"]);
  });
});
