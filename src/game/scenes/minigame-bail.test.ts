import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BAIL_ELEVATION_DEGREES, BAIL_NO_PRESS_RANGE_SHARE, BAIL_PERFECT_SECONDS, BAIL_WINDOW_SECONDS, bailRelease, bailVerdict, LongJumpBail } from "./minigame-bail.ts";

const BASE = { forward: 1.15, upward: 1, elevation: null } as const;
const EPSILON = 1e-9;
const HIT_AT = 10;
const DEGREES_TO_RADIANS = Math.PI / 180;

describe("given a press at some distance from the barrier hit", () => {
  const cases = [
    { it: "when it lands on the hit, then it is perfect at full quality", offset: 0, expectedKind: "perfect", expectedQuality: 1 },
    { it: "when it is as early as the perfect band, then it is still perfect at full quality", offset: -BAIL_PERFECT_SECONDS, expectedKind: "perfect", expectedQuality: 1 },
    { it: "when it is as late as the perfect band, then it is still perfect at full quality", offset: BAIL_PERFECT_SECONDS, expectedKind: "perfect", expectedQuality: 1 },
    { it: "when it is 0.05 s early, then it is early and earns 91% of the best launch", offset: -0.05, expectedKind: "early", expectedQuality: 1 - 0.02 / 0.22 },
    { it: "when it is 0.05 s late, then it is late and earns the same 91%", offset: 0.05, expectedKind: "late", expectedQuality: 1 - 0.02 / 0.22 },
    { it: "when it is 0.1 s early, then it is early and earns 68%", offset: -0.1, expectedKind: "early", expectedQuality: 1 - 0.07 / 0.22 },
    { it: "when it is 0.2 s late, then it is late and earns 23%", offset: 0.2, expectedKind: "late", expectedQuality: 1 - 0.17 / 0.22 },
    { it: "when it is as early as the window, then it is too early and earns nothing", offset: -BAIL_WINDOW_SECONDS, expectedKind: "tooEarly", expectedQuality: 0 },
    { it: "when it is far too early, then it is too early and earns nothing", offset: -1.2, expectedKind: "tooEarly", expectedQuality: 0 },
    { it: "when it is later than the window, then it is too late and earns nothing", offset: 0.4, expectedKind: "tooLate", expectedQuality: 0 },
    { it: "when there is no press, then it is no bail and earns nothing", offset: null, expectedKind: "none", expectedQuality: 0 },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      const verdict = bailVerdict(testCase.offset);
      assert.equal(verdict.kind, testCase.expectedKind, "kind");
      assert.ok(Math.abs(verdict.quality - testCase.expectedQuality) < EPSILON, `quality ${verdict.quality} vs ${testCase.expectedQuality}`);
      assert.equal(verdict.offsetSeconds, testCase.offset, "the offset is kept");
    });
  }
});

describe("given the release a bail of some quality earns", () => {
  const cases = [
    { it: "when the quality is 0, then the throw is the no-bail one: 30 degrees at half the range", quality: 0, expectedElevationDegrees: BAIL_ELEVATION_DEGREES.none, expectedRangeShare: BAIL_NO_PRESS_RANGE_SHARE },
    { it: "when the quality is 0.25, then the elevation and the range are a quarter of the way", quality: 0.25, expectedElevationDegrees: BAIL_ELEVATION_DEGREES.none + 0.25 * (BAIL_ELEVATION_DEGREES.perfect - BAIL_ELEVATION_DEGREES.none), expectedRangeShare: 0.625 },
    { it: "when the quality is 0.5, then the elevation and the range are half way", quality: 0.5, expectedElevationDegrees: BAIL_ELEVATION_DEGREES.none + 0.5 * (BAIL_ELEVATION_DEGREES.perfect - BAIL_ELEVATION_DEGREES.none), expectedRangeShare: 0.75 },
    { it: "when the quality is 1, then the throw is the perfect one: 45 degrees at the base speed and the whole range", quality: 1, expectedElevationDegrees: BAIL_ELEVATION_DEGREES.perfect, expectedRangeShare: 1 },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      const release = bailRelease(BASE, testCase.quality);
      assert.ok(release.elevation !== null && Math.abs(release.elevation - testCase.expectedElevationDegrees * DEGREES_TO_RADIANS) < EPSILON, `elevation ${release.elevation}`);
      const rangeShare = (release.forward / BASE.forward) ** 2 * Math.sin(2 * release.elevation!);
      assert.ok(Math.abs(rangeShare - testCase.expectedRangeShare) < EPSILON, `range share ${rangeShare} vs ${testCase.expectedRangeShare}`);
      assert.equal(release.upward, BASE.upward, "upward is the base's");
    });
  }

  it("when the quality is 1, then the speed is exactly the base's (the perfect throw is the sized one)", () => {
    assert.ok(Math.abs(bailRelease(BASE, 1).forward - BASE.forward) < EPSILON);
  });
});

describe("given one attempt's bail", () => {
  it("when the press comes before the hit, then the throw goes at the hit with the early verdict", () => {
    const bail = new LongJumpBail();
    bail.press(HIT_AT - 0.1);
    bail.hit(HIT_AT);
    const verdict = bail.launchDue(HIT_AT);
    assert.equal(verdict?.kind, "early");
    assert.ok(Math.abs(verdict!.offsetSeconds! + 0.1) < EPSILON, `offset ${verdict!.offsetSeconds}`);
    assert.ok(!bail.holding, "no longer held");
  });

  it("when the hit comes first, then the throw waits for a late press and goes the moment it comes, with the late verdict", () => {
    const bail = new LongJumpBail();
    bail.hit(HIT_AT);
    assert.equal(bail.launchDue(HIT_AT + 0.1), null, "still held at 0.1 s");
    assert.ok(bail.holding, "held");
    bail.press(HIT_AT + 0.12);
    const verdict = bail.launchDue(HIT_AT + 0.12);
    assert.equal(verdict?.kind, "late");
    assert.ok(Math.abs(verdict!.offsetSeconds! - 0.12) < EPSILON, `offset ${verdict!.offsetSeconds}`);
  });

  it("when no press comes in the window, then the throw goes at the window's end with no bail, and not a moment before", () => {
    const bail = new LongJumpBail();
    bail.hit(HIT_AT);
    assert.equal(bail.launchDue(HIT_AT + BAIL_WINDOW_SECONDS - 0.001), null, "just inside the window");
    assert.equal(bail.launchDue(HIT_AT + BAIL_WINDOW_SECONDS)?.kind, "none");
  });

  it("when two presses come, then only the first counts", () => {
    const bail = new LongJumpBail();
    bail.press(HIT_AT - 0.2);
    bail.press(HIT_AT);
    bail.hit(HIT_AT);
    const verdict = bail.launchDue(HIT_AT);
    assert.equal(verdict?.kind, "early");
    assert.ok(Math.abs(verdict!.offsetSeconds! + 0.2) < EPSILON, `offset ${verdict!.offsetSeconds}`);
  });

  it("when the only press is far too early, then it is the wasted bail and the throw goes at the hit with no quality", () => {
    const bail = new LongJumpBail();
    bail.press(HIT_AT - 1);
    bail.hit(HIT_AT);
    const verdict = bail.launchDue(HIT_AT);
    assert.equal(verdict?.kind, "tooEarly");
    assert.equal(verdict?.quality, 0);
  });

  it("when the first press comes after the throw has gone, then the verdict becomes too late with that offset", () => {
    const bail = new LongJumpBail();
    bail.hit(HIT_AT);
    bail.launchDue(HIT_AT + BAIL_WINDOW_SECONDS);
    assert.equal(bail.verdict?.kind, "none");
    bail.press(HIT_AT + 0.6);
    assert.equal(bail.verdict?.kind, "tooLate");
    assert.ok(Math.abs(bail.verdict!.offsetSeconds! - 0.6) < EPSILON);
  });

  it("when there is no hit yet, then nothing is due and a press waits for it", () => {
    const bail = new LongJumpBail();
    bail.press(HIT_AT - 0.05);
    assert.equal(bail.launchDue(HIT_AT), null);
    assert.ok(bail.pressed, "pressed");
    assert.ok(!bail.holding, "nothing held");
  });

  it("when the attempt is reset, then the press, the hit and the verdict are gone", () => {
    const bail = new LongJumpBail();
    bail.press(HIT_AT);
    bail.hit(HIT_AT);
    bail.launchDue(HIT_AT);
    bail.reset();
    assert.ok(!bail.pressed && !bail.holding && bail.verdict === null, "clean");
    assert.equal(bail.launchDue(HIT_AT + 1), null, "nothing due");
  });
});
