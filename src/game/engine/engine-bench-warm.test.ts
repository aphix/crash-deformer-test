import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RacePhase } from "../match/types.ts";
import { warmUp } from "./engine-bench-warm.ts";

/** More frames than any warm-up here needs: the fake frame throws past it, so a warm-up that never ends fails the test instead of hanging it. */
const FRAME_LIMIT = 500;

/** The warm-up of a race bench on the race clock: each frame moves the clock a 60th while racing, and `onFrame` may change the race (a finish). Resolves to the frames it took. */
async function warmRaceBench(warmS: number, onFrame: (race: { phase: RacePhase | null; time: number }, frames: number) => void): Promise<number> {
  const race: { phase: RacePhase | null; time: number } = { phase: "racing", time: 0 };
  let frames = 0;
  const nextFrame = async (): Promise<void> => {
    if (++frames > FRAME_LIMIT) throw new Error(`the warm-up was still going after ${FRAME_LIMIT} frames`);
    if (race.phase === "racing") race.time += 1 / 60;
    onFrame(race, frames);
  };
  await warmUp(nextFrame, { race, simS: () => 0, plan: { lab: null, warmS }, ui: { set: () => {} } });
  return frames;
}

describe("given a bench race whose warm-up runs on the race clock", () => {
  test("when the race is under way, then the warm-up lasts until the race clock reaches the warm-up seconds", async () => {
    const frames = await warmRaceBench(1, () => {});
    assert.ok(frames >= 60, `${frames} frames for 1 s of race clock`);
  });

  test("when the race finishes before the warm-up seconds have run, then the warm-up ends and the bench goes on to its window", async () => {
    const frames = await warmRaceBench(8, (race, n) => {
      if (n === 3) race.phase = "finished";
    });
    assert.equal(frames, 3, "the warm-up ended on the frame the race finished");
  });
});
