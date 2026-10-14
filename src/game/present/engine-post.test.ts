import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { easeFade } from "./engine-post.ts";

describe("given the post chain's strengths after a switch from a plain tier, at 60 Hz", () => {
  it("when it eases in from 0, then it never moves more than a quarter in a frame, takes more than 0.15 s and less than 0.5 s, and lands exactly on 1", () => {
    const FRAME = 1 / 60;
    let fade = 0;
    let frames = 0;
    for (; fade < 1 && frames < 600; frames++) {
      const next = easeFade(fade, FRAME);
      assert.ok(next >= fade && next - fade <= 0.25, `a frame moved the fade ${fade} -> ${next}`);
      fade = next;
    }
    assert.equal(fade, 1);
    assert.ok(frames * FRAME > 0.15 && frames * FRAME < 0.5, `took ${(frames * FRAME).toFixed(2)} s`);
  });
});
