import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BLUE_NOISE_SIZE, blueNoiseTexture } from "./blue-noise.ts";

const CHANNELS = 4;
const channelCases = [
  { channel: 0, name: "red" },
  { channel: 1, name: "green" },
  { channel: 2, name: "blue" },
  { channel: 3, name: "alpha" },
] as const;

/** The mean absolute difference between each texel and its right and lower neighbour (wrapping), in 8-bit steps, for one channel. */
function meanNeighbourStep(data: Uint8Array, channel: number): number {
  const n = BLUE_NOISE_SIZE;
  let sum = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const here = data[(y * n + x) * CHANNELS + channel]!;
      sum += Math.abs(here - data[(y * n + ((x + 1) % n)) * CHANNELS + channel]!);
      sum += Math.abs(here - data[(((y + 1) % n) * n + x) * CHANNELS + channel]!);
    }
  }
  return sum / (2 * n * n);
}

describe("given the shared blue-noise texture", () => {
  const tex = blueNoiseTexture();
  const data = tex.image.data as Uint8Array;

  it("when it is asked for twice, then both calls return the same texture", () => {
    assert.equal(blueNoiseTexture(), tex);
  });

  it("when its size is read, then it is a 64 by 64 table of four 8-bit channels", () => {
    assert.equal(tex.image.width, 64);
    assert.equal(tex.image.height, 64);
    assert.equal(data.length, 64 * 64 * 4);
  });

  for (const testCase of channelCases) {
    it(`when the ${testCase.name} channel is counted by value, then every 8-bit level appears between 8 and 17 times (a flat histogram)`, () => {
      const counts = new Array<number>(256).fill(0);
      for (let i = testCase.channel; i < data.length; i += CHANNELS) counts[data[i]!]!++;
      assert.equal(Math.min(...counts), 8);
      assert.equal(Math.max(...counts), 17);
    });

    it(`when the ${testCase.name} channel's neighbouring texels are compared, then they differ by more than white noise would (about 85 of 255 steps)`, () => {
      assert.ok(meanNeighbourStep(data, testCase.channel) > 90);
    });
  }
});
