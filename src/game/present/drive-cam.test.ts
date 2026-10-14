import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHASE, followBlend, wobbleEnvelope } from "./drive-cam.ts";

describe("given the chase view's follow blend over forward speed (masterclass 23:34: fade over a parameter)", () => {
  it("when the car is under the band or past it, then the blend is 0 or 1", () => {
    assert.equal(followBlend(-5), 0);
    assert.equal(followBlend(CHASE.followFrom), 0);
    assert.equal(followBlend(CHASE.followTo), 1);
    assert.equal(followBlend(40), 1);
  });
  it("when the speed climbs through the band, then the blend rises without a jump or a fall, and the old 3 m/s switch is mid-band", () => {
    const STEP = 0.01;
    let prev = 0;
    for (let v = 0; v <= 8; v += STEP) {
      const b = followBlend(v);
      assert.ok(b >= prev, `the blend fell at ${v.toFixed(2)} m/s`);
      assert.ok(b - prev < 0.02, `the blend jumped at ${v.toFixed(2)} m/s: ${prev} -> ${b}`);
      prev = b;
    }
    assert.ok(followBlend(3) > 0 && followBlend(3) < 1);
  });
});

describe("given a landing's wobble envelope", () => {
  const { hold, attack } = CHASE.landing;
  it("when the landing has just begun, then the amplitude is 0, not the full amplitude", () => {
    assert.equal(wobbleEnvelope(hold, hold, attack), 0);
  });
  it("when the landing runs its hold, then the amplitude eases in without a jump, peaks, and fades out to 0", () => {
    const STEP = 0.001;
    let prev = 0;
    let peak = 0;
    for (let left = hold; left >= 0; left -= STEP) {
      const a = wobbleEnvelope(left, hold, attack);
      assert.ok(Math.abs(a - prev) < 0.05, `the envelope jumped at ${left.toFixed(3)} s left: ${prev} -> ${a}`);
      peak = Math.max(peak, a);
      prev = a;
    }
    assert.ok(peak > 0.8 && peak <= 1);
    assert.ok(wobbleEnvelope(0, hold, attack) === 0);
  });
});
