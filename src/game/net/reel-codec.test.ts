import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HighlightClip } from "../match/highlights.ts";
import { NET_VERSION } from "./codec.ts";
import { carLayout } from "./car-pose.ts";
import { decodeSaved, encodeSaved, packReel, unpackReel } from "./reel-codec.ts";
import { makeClip, sameClip } from "./reel-clip.test-util.ts";

describe("highlight codec", () => {
  it("bad: a reel must come back from MSG.reel byte for byte, with its seed and start time", async () => {
    const { clip, car } = makeClip();
    const msg = await packReel({ seed: 0xdeadbeef, clips: [clip, clip] }, 1234.5);
    const got = await unpackReel(msg, carLayout(car));
    assert.equal(got.reel.seed, 0xdeadbeef);
    assert.equal(got.startAt, 1234.5);
    assert.equal(got.reel.clips.length, 2);
    sameClip(got.reel.clips[1]!, clip);
  });

  it("bad: a saved clip must decode to the same clip", async () => {
    const { clip, car } = makeClip();
    const got = await decodeSaved(await encodeSaved(clip), carLayout(car));
    assert.notEqual(typeof got, "string", `decoded as ${String(got)}`);
    sameClip(got as HighlightClip, clip);
  });

  it("bad: a clip saved by another build must be refused as 'version', a damaged one as 'corrupt'", async () => {
    const { clip, car } = makeClip();
    const L = carLayout(car);
    const bytes = Uint8Array.from(atob(await encodeSaved(clip)), (c) => c.charCodeAt(0));
    const recode = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
    const edited = (at: number, v: number): string => {
      const b = bytes.slice();
      b[at] = v;
      return recode(b);
    };
    assert.equal(await decodeSaved(edited(4, bytes[4]! + 1), L), "version", "another REPLAY_VERSION");
    assert.equal(await decodeSaved(edited(6, NET_VERSION + 1), L), "version", "another NET_VERSION");
    assert.equal(await decodeSaved(edited(7, bytes[7]! ^ 0xff), L), "version", "another sim fingerprint");
    assert.equal(await decodeSaved(edited(0, 0), L), "corrupt", "not a clip");
    assert.equal(await decodeSaved(recode(bytes.subarray(0, bytes.length - 40)), L), "corrupt", "truncated");
    assert.equal(await decodeSaved("%%%", L), "corrupt", "not base64");
  });
});
