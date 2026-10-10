import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RagdollStats } from "../present/engine-ragdoll.ts";
import { ragdollCost, replayTier, type ReplayFrames } from "./engine-bench-replay.ts";

const NO_COST = { steps: 0, stepMs: { mean: 0, p95: 0 }, colliders: 0, bodies: 0 };

describe("given the ragdoll world's step log (a ring of the newest world.step() ms)", () => {
  test("when fewer steps ran since the mark than the ring holds, then the cost is those steps' mean and p95, and the world's size is the one now", () => {
    const log = new Float64Array(8);
    log.set([9, 9, 1, 2, 3, 4]);
    const stats: RagdollStats = { steps: 6, log, colliders: 70, bodies: 12 };
    const cost = ragdollCost(stats, 2);
    assert.equal(cost.steps, 4);
    assert.equal(cost.stepMs.mean, 2.5);
    assert.equal(cost.stepMs.p95, 4);
    assert.equal(cost.colliders, 70);
    assert.equal(cost.bodies, 12);
  });

  test("when more steps ran since the mark than the ring holds, then the newest ones in the ring are scored and the count is the real one", () => {
    const log = new Float64Array(4);
    // 10 steps ran: step k wrote k + 1 ms at slot k % 4, so the ring holds steps 6..9 (7, 8, 9, 10 ms).
    for (let k = 0; k < 10; k++) log[k % 4] = k + 1;
    const cost = ragdollCost({ steps: 10, log, colliders: 0, bodies: 0 }, 0);
    assert.equal(cost.steps, 10);
    assert.equal(cost.stepMs.mean, 8.5);
    assert.equal(cost.stepMs.p95, 10);
  });

  test("when no step ran since the mark (a world with nothing to move), then the cost is zero steps and zero ms", () => {
    const cost = ragdollCost({ steps: 5, log: new Float64Array(4), colliders: 3, bodies: 1 }, 5);
    assert.equal(cost.steps, 0);
    assert.equal(cost.stepMs.mean, 0);
    assert.equal(cost.stepMs.p95, 0);
  });
});

describe("given the frames the reel drew at one FX tier", () => {
  const frames: ReplayFrames = { n: 4, iv: Float64Array.of(10, 10, 10, 30), cpu: Float64Array.of(4, 5, 6, 9), sim: Float64Array.of(1, 1, 2, 4), draw: Float64Array.of(2, 2, 3, 5) };

  test("when the tier's row is made, then the fps is frames over their wall time, the wall time is their sum, and each reading is its mean and p95", () => {
    const row = replayTier(frames, 1.5, NO_COST);
    assert.equal(row.frames, 4);
    assert.equal(row.wallS, 0.06);
    assert.equal(row.fps, (1000 * 4) / 60);
    assert.equal(row.frameMs.mean, 15);
    assert.equal(row.cpuMs.mean, 6);
    assert.equal(row.simMs.mean, 2);
    assert.equal(row.renderMs.mean, 3);
    assert.equal(row.gpuMs, 1.5);
  });

  test("when the 1 % low is read, then it is one over the 99th-percentile frame interval", () => {
    assert.equal(replayTier(frames, null, NO_COST).fpsLow1, 1000 / 30);
  });

  test("when no frame was drawn, then the row is zeros and not a division by zero, and a device with no timer query has a null gpu", () => {
    const row = replayTier({ n: 0, iv: new Float64Array(2), cpu: new Float64Array(2), sim: new Float64Array(2), draw: new Float64Array(2) }, null, NO_COST);
    assert.equal(row.fps, 0);
    assert.equal(row.fpsLow1, 0);
    assert.equal(row.gpuMs, null);
  });
});
