import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { MSG } from "./codec.ts";
import { REEL_PART, ReelParts, reelParts } from "./reel-wire.ts";

/** A message of `n` bytes, none repeating the one before. */
const message = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 255);

describe("given a highlight reel message split into fixed-size wire frames and gathered back by a receiver", () => {
  it("when messages of 1, one under, exactly, one over, and several frames' worth of bytes are split and gathered, then each comes back whole and nothing completes before the last frame", () => {
    for (const n of [1, REEL_PART - 1, REEL_PART, REEL_PART + 1, 5 * REEL_PART + 17]) {
      const msg = message(n);
      const parts = reelParts(msg);
      assert.equal(parts.length, Math.ceil(n / REEL_PART), `${n} bytes: frame count`);
      const gather = new ReelParts();
      const got = parts.map((p) => gather.take(p));
      assert.ok(got.slice(0, -1).every((g) => g === null), "nothing before the last frame");
      assertSameNumbers(got.at(-1)!, msg, `${n} bytes`);
    }
  });

  it("when frames arrive that do not belong (a last or middle frame with no start, a frame with no flags, or a fresh start mid-reel), then none completes a reel and a fresh start replaces the half-gathered one", () => {
    const msg = message(3 * REEL_PART);
    const parts = reelParts(msg);
    const gather = new ReelParts();
    assert.equal(gather.take(parts[2]!), null, "a last frame with no start gathers nothing");
    assert.equal(gather.take(parts[1]!), null, "a middle frame with no start gathers nothing");
    assert.equal(gather.take(new Uint8Array([MSG.reelPart])), null, "a frame with no flags");
    gather.take(parts[0]!);
    gather.take(parts[1]!);
    // A fresh start drops the half-gathered reel.
    const other = message(REEL_PART + 5);
    const op = reelParts(other);
    assert.equal(gather.take(op[0]!), null);
    assertSameNumbers(gather.take(op[1]!)!, other, "the restarted reel");
  });

  it("when a hostile stream sends a first frame and over 200 middle frames with no end, then nothing completes and once past the cap what was gathered is dropped", () => {
    const gather = new ReelParts();
    const first = reelParts(message(REEL_PART))[0]!;
    first[1] = 1; // FIRST only: no end in sight
    const mid = first.slice();
    mid[1] = 0;
    assert.equal(gather.take(first), null);
    for (let i = 0; i < 200; i++) assert.equal(gather.take(mid), null);
    const last = mid.slice();
    last[1] = 2;
    assert.equal(gather.take(last), null, "once over the cap, what was gathered is gone");
  });
});
