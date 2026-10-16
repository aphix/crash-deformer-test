import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_STEP,
  BOX_CELL_PITCH,
  BOX_COUNT,
  BOX_NET_CLEARANCE,
  BOX_PILE_HALF_WIDTH,
  BOX_PILE_LEAD,
  BOX_PILE_TRAIL,
  BOX_SIZE_MAX,
  BOX_SIZE_MIN,
  CAPTURE_HALF_WIDTH,
  FRAME_EXTRA_BOARDS,
  HighJumpCapture,
  MAJOR_BOARD_EVERY,
  POST_HALF_SPAN,
  highJumpLayout,
  type BoxPlacement,
  type HighJumpMeasured,
  type TorsoSample,
} from "./minigame-high-jump.ts";

const GRAVITY = 9.80665;
const FRAME_SECONDS = 1 / 60;
const LIP_Y = 2.5;
const EDGE_NUDGE = 1e-6;
const MILLIMETRE = 0.001;
const BOX_OVERLAP_TOLERANCE = 1e-9;

/** A synthetic best case: the numbers the real measurement would fill in. */
const SYNTHETIC_MEASURED: HighJumpMeasured = { apexHeight: 31.3, apexDistance: 48, landingDistance: 96 };

function sample(x: number, y: number, z = 0): TorsoSample {
  return { x, y, z, still: 0 };
}

/**
 * A ballistic torso released at the apex (x = 0, y = apexY) with horizontal speed `speed`, sampled once per 60 Hz frame
 * as the ragdoll's `latest()` is: no interpolation between frames.
 */
function ballisticFrames(apexY: number, speed: number, frameCount: number): TorsoSample[] {
  return Array.from({ length: frameCount }, (_, frame) => {
    const seconds = frame * FRAME_SECONDS;
    return sample(speed * seconds, apexY - (GRAVITY * seconds * seconds) / 2);
  });
}

/** Feeds the frames in order, as the engine does; returns every frame's answer. */
function feed(capture: HighJumpCapture, frames: readonly TorsoSample[], postsX: number): (number | null)[] {
  return frames.map((frame, index) => capture.step(index === 0 ? null : frames[index - 1], frame, postsX, LIP_Y));
}

function firstNumber(answers: readonly (number | null)[]): number | null {
  return answers.find((answer) => answer !== null) ?? null;
}

describe("given a torso falling at 28 m/s past the posts, sampled once per 60 Hz frame", () => {
  const speed = 15;
  const apexY = 60;
  /** The plane lies half way between two frames, where an uninterpolated sample is furthest from the plane. */
  const crossingSeconds = 171.5 * FRAME_SECONDS;
  const postsX = speed * crossingSeconds;
  const analyticHeightAboveLip = apexY - (GRAVITY * crossingSeconds * crossingSeconds) / 2 - LIP_Y;
  const fallSpeedAtCrossing = GRAVITY * crossingSeconds;

  it("is a real 28 m/s descent", () => {
    assert.ok(Math.abs(fallSpeedAtCrossing - 28) < 0.2, `fall speed ${fallSpeedAtCrossing}`);
  });

  it("when the torso crosses the plane between two frames, then the height is the analytic one to under a millimetre", () => {
    const capture = new HighJumpCapture();
    const answers = feed(capture, ballisticFrames(apexY, speed, 240), postsX);
    const captured = firstNumber(answers);
    assert.ok(captured !== null, "a capture came back");
    assert.ok(
      Math.abs(captured - analyticHeightAboveLip) < MILLIMETRE,
      `captured ${captured} vs analytic ${analyticHeightAboveLip}`,
    );
    assert.equal(capture.captured, captured, "captured is readable afterwards");
    assert.equal(answers.filter((answer) => answer !== null).length, 1, "exactly one frame answered");
  });

  it("when the plane lies before the torso's fall has reached it, then no frame answers and nothing is captured", () => {
    const capture = new HighJumpCapture();
    const frames = ballisticFrames(apexY, speed, 100);
    assert.ok(frames[frames.length - 1].x < postsX, "the frames stop short of the plane");
    const answers = feed(capture, frames, postsX);
    assert.equal(firstNumber(answers), null, "no answer before the plane");
    assert.equal(capture.captured, null, "nothing captured");
    const populated = firstNumber(feed(capture, ballisticFrames(apexY, speed, 240), postsX));
    assert.ok(populated !== null, "the same capture answers once the frames reach the plane");
  });

  it("when the posts stand where the torso peaks, then the capture is the plane crossing, not the apex", () => {
    const capture = new HighJumpCapture();
    const captured = firstNumber(feed(capture, ballisticFrames(apexY, speed, 240), postsX));
    assert.ok(captured !== null);
    assert.ok(apexY - LIP_Y - captured > 1, `captured ${captured} is well below the apex height ${apexY - LIP_Y}`);
  });
});

describe("given a pair of samples straddling the plane", () => {
  const postsX = 40;
  const crossingTestCases = [
    { it: "when the crossing is above the lip, then the height above the lip comes back", previous: sample(38, 13), current: sample(42, 9), expected: 8.5 },
    { it: "when the crossing is below the lip, then the score is 0, not negative and not null", previous: sample(38, 1), current: sample(42, -3), expected: 0 },
    { it: "when the crossing is exactly at the lip, then the score is 0", previous: sample(38, 4.5), current: sample(42, 0.5), expected: 0 },
    { it: "when the later sample lies exactly on the plane, then that sample's height counts", previous: sample(36, 20), current: sample(40, 12), expected: 12 - LIP_Y },
    { it: "when the torso is rising through the plane, then the rising height counts", previous: sample(38, 6), current: sample(42, 14), expected: 10 - LIP_Y },
  ] as const;
  for (const testCase of crossingTestCases) {
    it(testCase.it, () => {
      const capture = new HighJumpCapture();
      const captured = capture.step(testCase.previous, testCase.current, postsX, LIP_Y);
      assert.ok(captured !== null, "the crossing was seen");
      assert.ok(Math.abs(captured - testCase.expected) < 1e-9, `captured ${captured}, expected ${testCase.expected}`);
      assert.equal(capture.captured, captured, "captured field");
    });
  }

  const nonCrossingTestCases = [
    { it: "when there is no previous sample, then there is no crossing", previous: null, current: sample(42, 9) },
    { it: "when both samples are before the plane, then there is no crossing", previous: sample(30, 9), current: sample(35, 9) },
    { it: "when both samples are past the plane, then there is no crossing", previous: sample(41, 9), current: sample(45, 9) },
    { it: "when the previous sample lies on the plane, then the pair is not the crossing (the pair before it was)", previous: sample(40, 9), current: sample(44, 9) },
    { it: "when the torso goes back through the plane, then it is not a +x crossing", previous: sample(42, 9), current: sample(38, 9) },
  ] as const;
  for (const testCase of nonCrossingTestCases) {
    it(testCase.it, () => {
      const capture = new HighJumpCapture();
      assert.equal(capture.step(testCase.previous, testCase.current, postsX, LIP_Y), null, "answer");
      assert.equal(capture.captured, null, "captured");
      const control = capture.step(sample(38, 9), sample(42, 9), postsX, LIP_Y);
      assert.ok(control !== null, "a real crossing is still captured afterwards");
    });
  }

  it("when a second crossing follows the first, then it answers null; after reset it captures again", () => {
    const capture = new HighJumpCapture();
    const first = capture.step(sample(38, 13), sample(42, 9), postsX, LIP_Y);
    assert.ok(first !== null, "first crossing");
    assert.equal(capture.step(sample(38, 20), sample(42, 20), postsX, LIP_Y), null, "second crossing");
    assert.equal(capture.captured, first, "the first capture is kept");
    capture.reset();
    assert.equal(capture.captured, null, "reset clears the capture");
    const again = capture.step(sample(38, 20), sample(42, 20), postsX, LIP_Y);
    assert.ok(again !== null && Math.abs(again - (20 - LIP_Y)) < 1e-9, "captures again after reset");
  });
});

describe("given the capture band beside the posts", () => {
  const postsX = 40;
  const bandTestCases = [
    { it: "when he crosses on the lane centre, then it counts", z: 0, counts: true },
    { it: "when he crosses beside a post, outside the posts' span, then it counts", z: POST_HALF_SPAN + 1, counts: true },
    { it: "when he crosses exactly at the band's edge, then it counts", z: CAPTURE_HALF_WIDTH, counts: true },
    { it: "when he crosses exactly at the other band edge, then it counts", z: -CAPTURE_HALF_WIDTH, counts: true },
    { it: "when he crosses just past the band's edge, then it does not count", z: CAPTURE_HALF_WIDTH + EDGE_NUDGE, counts: false },
    { it: "when he crosses just past the other band edge, then it does not count", z: -CAPTURE_HALF_WIDTH - EDGE_NUDGE, counts: false },
  ] as const;
  for (const testCase of bandTestCases) {
    it(testCase.it, () => {
      const capture = new HighJumpCapture();
      const captured = capture.step(sample(38, 9, testCase.z), sample(42, 9, testCase.z), postsX, LIP_Y);
      assert.equal(captured !== null, testCase.counts, "counted");
      assert.equal(capture.captured !== null, testCase.counts, "captured field");
    });
  }

  it("when the samples are both outside the band but the crossing between them is inside, then the interpolated lateral position counts", () => {
    const capture = new HighJumpCapture();
    const captured = capture.step(sample(36, 9, -CAPTURE_HALF_WIDTH - 1), sample(44, 9, CAPTURE_HALF_WIDTH + 1), postsX, LIP_Y);
    assert.ok(captured !== null, "counted");
  });

  it("when his first crossing is outside the band, then a later crossing inside it does not rescue the throw", () => {
    const capture = new HighJumpCapture();
    assert.equal(capture.step(sample(38, 9, CAPTURE_HALF_WIDTH + 2), sample(42, 9, CAPTURE_HALF_WIDTH + 2), postsX, LIP_Y), null, "outside");
    assert.equal(capture.step(sample(38, 9), sample(42, 9), postsX, LIP_Y), null, "later inside crossing");
    assert.equal(capture.captured, null, "nothing captured");
  });
});

const LAYOUT_CASES = [
  { name: "a high best case", measured: { apexHeight: 31.3, apexDistance: 48, landingDistance: 96 } },
  { name: "a best case that is a whole number of boards", measured: { apexHeight: 28, apexDistance: 40, landingDistance: 80 } },
  { name: "a low best case", measured: { apexHeight: 9, apexDistance: 22, landingDistance: 50 } },
  { name: "a landing nearer the posts than the net's clearance", measured: { apexHeight: 12, apexDistance: 30, landingDistance: 33 } },
  { name: "a landing beyond the net", measured: { apexHeight: 12, apexDistance: 30, landingDistance: 90 } },
] as const;

function pileEndX(measured: HighJumpMeasured): number {
  return Math.min(measured.landingDistance + BOX_PILE_TRAIL, measured.apexDistance + 30 - BOX_NET_CLEARANCE);
}

function boundingRadius(box: BoxPlacement): number {
  return Math.sqrt(box.width * box.width + box.depth * box.depth) / 2;
}

for (const layoutCase of LAYOUT_CASES) {
  describe(`given ${layoutCase.name} (apex ${layoutCase.measured.apexHeight} m at ${layoutCase.measured.apexDistance} m, landing ${layoutCase.measured.landingDistance} m)`, () => {
    const measured = layoutCase.measured;
    const layout = highJumpLayout(measured, LIP_Y);

    it("when the layout is made, then the posts stand at the apex and the net 30 m behind them", () => {
      assert.equal(layout.postsX, measured.apexDistance, "postsX");
      assert.equal(layout.netX, measured.apexDistance + 30, "netX is the posts plus 30 m");
    });

    it("when the layout is made, then the frame top is the best apex plus exactly one board", () => {
      assert.equal(FRAME_EXTRA_BOARDS, 1, "the extra board count");
      assert.equal(layout.frameTop, measured.apexHeight + BOARD_STEP, "frame top");
    });

    it("when the layout is made, then the boards are evenly spaced from the lip and reach up to the frame top", () => {
      assert.equal(layout.boards.length, Math.ceil(layout.frameTop / BOARD_STEP), "board count");
      for (let index = 0; index < layout.boards.length; index++) {
        const board = layout.boards[index];
        assert.equal(board.heightAboveLip, index * BOARD_STEP, `board ${index} height above the lip`);
        assert.equal(board.y, LIP_Y + index * BOARD_STEP, `board ${index} height above the pad`);
        assert.equal(board.major, index % MAJOR_BOARD_EVERY === 0, `board ${index} major flag`);
      }
      const topBoard = layout.boards[layout.boards.length - 1];
      assert.ok(topBoard.heightAboveLip < layout.frameTop, "the top board is under the frame top");
      assert.ok(topBoard.heightAboveLip + BOARD_STEP >= layout.frameTop, "no board missing under the frame top");
      assert.equal(layout.boards[0].heightAboveLip, 0, "the first board is the lip line");
      assert.ok(layout.boards.some((board) => board.major), "a major board exists");
      assert.ok(layout.boards.some((board) => !board.major), "a minor board exists");
    });

    it("when the layout is made, then BOX_COUNT boxes come back with sizes in range", () => {
      assert.equal(layout.boxes.length, BOX_COUNT, "box count");
      for (const box of layout.boxes) {
        for (const side of [box.width, box.height, box.depth]) {
          assert.ok(side >= BOX_SIZE_MIN && side <= BOX_SIZE_MAX, `side ${side} within ${BOX_SIZE_MIN}-${BOX_SIZE_MAX}`);
        }
      }
      const distinctWidths = new Set(layout.boxes.map((box) => box.width));
      assert.ok(distinctWidths.size > BOX_COUNT / 2, `box widths vary (${distinctWidths.size} distinct)`);
    });

    it("when the boxes are laid out, then none overlaps another (stacked ones only touch), within one nanometre", () => {
      let stackedPairs = 0;
      for (let first = 0; first < layout.boxes.length; first++) {
        for (let second = first + 1; second < layout.boxes.length; second++) {
          const lower = layout.boxes[first];
          const upper = layout.boxes[second];
          const centreDistance = Math.hypot(lower.x - upper.x, lower.z - upper.z);
          if (centreDistance >= boundingRadius(lower) + boundingRadius(upper)) continue;
          const verticalOverlap =
            Math.min(lower.y + lower.height / 2, upper.y + upper.height / 2) - Math.max(lower.y - lower.height / 2, upper.y - upper.height / 2);
          assert.ok(verticalOverlap <= BOX_OVERLAP_TOLERANCE, `boxes ${first} and ${second} overlap by ${verticalOverlap}`);
          stackedPairs++;
        }
      }
      assert.ok(stackedPairs > 0, "some boxes are stacked, so the pair check had something to test");
    });

    it("when the boxes are laid out, then they rest on or above the pad, the bottom ones on it", () => {
      let boxesOnPad = 0;
      for (const box of layout.boxes) {
        const bottom = box.y - box.height / 2;
        assert.ok(bottom >= -BOX_OVERLAP_TOLERANCE, `bottom ${bottom} is above the pad`);
        if (Math.abs(bottom) <= BOX_OVERLAP_TOLERANCE) boxesOnPad++;
      }
      assert.ok(boxesOnPad > 0, "some boxes stand on the pad");
    });

    it("when the boxes are laid out, then all lie within the pile footprint and short of the net", () => {
      const startX = measured.apexDistance - BOX_PILE_LEAD;
      const endX = pileEndX(measured);
      for (const box of layout.boxes) {
        const radius = boundingRadius(box);
        assert.ok(box.x - radius >= startX - BOX_OVERLAP_TOLERANCE, `box at ${box.x} starts at or after ${startX}`);
        assert.ok(box.x + radius <= endX + BOX_OVERLAP_TOLERANCE, `box at ${box.x} ends at or before ${endX}`);
        assert.ok(box.x + radius <= layout.netX - BOX_NET_CLEARANCE + BOX_OVERLAP_TOLERANCE, `box at ${box.x} stops short of the net`);
        assert.ok(Math.abs(box.z) + radius <= BOX_PILE_HALF_WIDTH + BOX_OVERLAP_TOLERANCE, `box at z ${box.z} within the pile's width`);
      }
    });

    it("when the layout is made twice, then every box is the same", () => {
      const again = highJumpLayout(measured, LIP_Y);
      assert.equal(again.boxes.length, layout.boxes.length, "box count");
      for (let index = 0; index < layout.boxes.length; index++) {
        const box = layout.boxes[index];
        const copy = again.boxes[index];
        assert.equal(copy.x, box.x, `box ${index} x`);
        assert.equal(copy.y, box.y, `box ${index} y`);
        assert.equal(copy.z, box.z, `box ${index} z`);
        assert.equal(copy.yaw, box.yaw, `box ${index} yaw`);
        assert.equal(copy.width, box.width, `box ${index} width`);
        assert.equal(copy.height, box.height, `box ${index} height`);
        assert.equal(copy.depth, box.depth, `box ${index} depth`);
      }
    });
  });
}

describe("given a landing so near the posts that the piles cannot hold one cell", () => {
  it("when the layout is made, then it refuses with a RangeError naming the footprint", () => {
    const measured = { apexHeight: 12, apexDistance: 30, landingDistance: 30 - BOX_PILE_TRAIL - BOX_PILE_LEAD + BOX_CELL_PITCH / 2 };
    assert.throws(() => highJumpLayout(measured, LIP_Y), RangeError);
  });
});

describe("given the layout's boards for a different lip height", () => {
  it("when the lip is raised, then the boards' heights above the lip stay and their heights above the pad follow", () => {
    const low = highJumpLayout(SYNTHETIC_MEASURED, 0);
    const high = highJumpLayout(SYNTHETIC_MEASURED, 4);
    assert.equal(high.boards.length, low.boards.length, "board count");
    for (let index = 0; index < low.boards.length; index++) {
      assert.equal(high.boards[index].heightAboveLip, low.boards[index].heightAboveLip, `board ${index} above the lip`);
      assert.equal(high.boards[index].y, low.boards[index].y + 4, `board ${index} above the pad`);
    }
  });
});
