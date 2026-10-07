import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bandOf, crossing, describeDepthProbe, rowDistance, type DepthProbe } from "./depth-probe.ts";

describe("given the depth probe (how far a ground layer must be offset to show over a coplanar one on this GPU)", () => {
  it("when the share of pixels showing the layer rises with the offset, then the offset reaching a target share is interpolated between the two offsets around it, zero if already there, none if never reached", () => {
    const offsets = [0, 1, 2, 4];
    const shares = [0.2, 0.5, 0.9, 1];
    assert.equal(crossing(offsets, shares, 0.5), 1);
    assert.ok(Math.abs(crossing(offsets, shares, 0.95)! - 3) < 1e-9);
    assert.equal(crossing(offsets, [0.6, 0.7, 0.9, 1], 0.5), 0);
    assert.equal(crossing(offsets, [0.1, 0.2, 0.3, 0.4], 0.5), null);
  });

  const bandCases = [
    { it: "when ground nearer than 5 m is banded, then it has no band", z: 4.9, expected: -1 },
    { it: "when ground at 5 m is banded, then it is in the first band", z: 5, expected: 0 },
    { it: "when ground just short of 40 m is banded, then it is in the 20 to 40 m band", z: 39.9, expected: 2 },
    { it: "when ground at 40 m is banded, then it is in the 40 to 80 m band", z: 40, expected: 3 },
    { it: "when ground just short of 900 m is banded, then it is in the last band", z: 899, expected: 6 },
    { it: "when ground at the 900 m far plane is banded, then it has no band", z: 900, expected: -1 },
  ] as const;
  for (const testCase of bandCases) {
    it(testCase.it, () => {
      assert.equal(bandOf(testCase.z), testCase.expected);
    });
  }

  it("when the race camera 2.4 m up looks level over a 616-row view, then the bottom row sees ground 4 m out, each row up sees farther, and the horizon rows see none", () => {
    assert.ok(Math.abs(rowDistance(0, 616) - 3.99) < 0.02);
    assert.equal(rowDistance(308, 616), Infinity);
    let last = 0;
    for (let y = 0; y < 308; y++) {
      const d = rowDistance(y, 616);
      assert.ok(d > last, `row ${y}`);
      last = d;
    }
  });

  const cardCases = [
    {
      it: "when a phone's bands are written for the card, then the worst band's offset for 95 % of the pixels is given as a share of a pixel of slope and as depth steps",
      bands: [
        { from: 5, to: 10, slope: { u50: 0.01, u95: 0.031 }, steps: { u50: 20, u95: 58.4 } },
        { from: 10, to: 20, slope: { u50: 0.02, u95: 0.0625 }, steps: { u50: 30, u95: 61.6 } },
      ],
      expected: "coplanar layer shows at 0.063 px of slope or 62 steps",
    },
    {
      it: "when a band never reaches 95 % on either ladder, then the card says the offset is over the ladder's top",
      bands: [
        { from: 5, to: 10, slope: { u50: 0.5, u95: null }, steps: { u50: 900, u95: null } },
        { from: 10, to: 20, slope: { u50: 0.02, u95: 0.0625 }, steps: { u50: 30, u95: 61.6 } },
      ],
      expected: "coplanar layer shows at over 1 px of slope or over 2048 steps",
    },
  ] as const;
  for (const testCase of cardCases) {
    it(testCase.it, () => {
      const probe: DepthProbe = { subpixelBits: 4, bands: testCase.bands.map((b) => ({ ...b, slope: { ...b.slope }, steps: { ...b.steps } })) };
      assert.equal(describeDepthProbe(probe), testCase.expected);
    });
  }
});
