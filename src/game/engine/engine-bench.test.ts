import assert from "node:assert/strict";
import { test } from "node:test";
import { describeBench, stat, type BenchResult } from "./engine-bench.ts";

const S = (p50: number) => ({ mean: p50, p50, p95: p50 * 2, p99: p50 * 3, max: p50 * 4 });

const RESULT: BenchResult = {
  course: "city",
  cars: 22,
  cops: { stakeouts: 6, pursuits: 3, maxPack: 2 },
  frames: 2700,
  wallS: 30,
  fps: 90,
  fpsLow1: 41.7,
  fpsThirds: [90, 90, 89],
  frameMs: S(11.1),
  cpuMs: S(7.5),
  simMs: S(4.2),
  renderMs: S(2),
  gpuMs: null,
  stepsPerFrame: 2.7,
  msPerStep: 1.56,
  cutFrames: 40,
  lostSimS: 0.5,
  coarsePct: 62.4,
  simSpeedPct: 98.3,
  calls: 420,
  triangles: 380_000,
  setupMs: { options: 800, start: 140 },
  device: { gpu: "Mali-G715", cores: 9, memoryGB: 8, screen: "412x915", dpr: 2.625, ratio: 1.5, canvas: "1373x618", tier: "minimal" },
};

test("stat: percentiles of the first n values, order-free", () => {
  const s = stat([5, 1, 9, 3, 7, 100, 100], 5);
  assert.deepEqual(s, { mean: 5, p50: 5, p95: 9, p99: 9, max: 9 });
  assert.deepEqual(stat([]), { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 });
});

test("describeBench: the card leads with fps and sim speed, and says when the GPU can't be timed", () => {
  const lines = describeBench(RESULT);
  assert.match(lines[0]!, /^CRUSH BENCH {2}city {2}22 cars/);
  assert.match(lines[1]!, /^90\.0 FPS {3}1% low 41\.7 {3}by thirds 90\.0 \/ 90\.0 \/ 89\.0$/);
  assert.match(lines[2]!, /^SIM SPEED 98 % .*1\/120 s steps in 62 % of frames$/);
  assert.ok(lines.some((l) => /^GPU {7}no timer query/.test(l)));
  assert.ok(lines.some((l) => l.includes("2.7 steps/frame, 1.56 ms/step")));
  assert.ok(lines.some((l) => l.includes("1373x618 (ratio 1.5)")));
  const timed = describeBench({ ...RESULT, gpuMs: S(3) });
  assert.ok(timed.some((l) => /^GPU {7}p50 3\.0 {2}p95 6\.0/.test(l)));
  assert.ok(lines.length <= 12, "fits a 412 px tall phone screen at 11 px type");
});
