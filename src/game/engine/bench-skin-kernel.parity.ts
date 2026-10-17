import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { skinKernel } from "../deform/skin-kernel.ts";
import { loadSkinKernelForTest } from "../deform/skin-kernel.test-util.ts";
import { COUNTER_COUNT, summarize, type BenchParts, type Samples, type Window } from "./bench-measure.ts";
import { PHASE_COUNT } from "./sim-phases.ts";
import type { BenchPlan } from "./engine-bench-plan.ts";

/**
 * Run alone (`test:parity`, outside the test preload that loads the kernel), so the kernel starts unloaded and the
 * bench card's `skinKernel` can be read both ways.
 */
// `summarize` reads the build's commit as it runs, not as the module loads.
Object.assign(globalThis, { __BUILD_SHA__: "test" });

const f = (): Float64Array => new Float64Array(0);
const SAMPLES: Samples = { n: 0, iv: f(), cpu: f(), sim: f(), draw: f(), steps: f(), coarse: f(), wrecks: f(), calls: f(), tris: f(), tierCounts: f(), tierOrder: new Uint8Array(0), tiersSeen: 0, levelCounts: f(), levelOrder: new Uint8Array(0), levelsSeen: 0 };
const WINDOW: Window = { wallS: 0, lostSimS: 0, cutFrames: 0, fineCuts: 0, clockS: 0, thrown: 0, ragdoll: { steps: 0, stepMs: { mean: 0, p95: 0 }, colliders: 0, bodies: 0 }, phaseMs: new Float64Array(PHASE_COUNT), counts: new Float64Array(COUNTER_COUNT) };
const PARTS = { live: () => [], race: { policeStats: null } } as unknown as BenchParts;
const PLAN = { id: "test" } as BenchPlan;
const card = () => summarize(PARTS, PLAN, SAMPLES, WINDOW, {} as never);

describe("given the bench card assembled from a run", () => {
  it("when the skin kernel is not loaded, then the card says skinKernel false; once it loads, true", async () => {
    assert.equal(skinKernel(), null, "this file runs without the preload");
    assert.equal(card().skinKernel, false);
    await loadSkinKernelForTest();
    assert.equal(card().skinKernel, true);
  });
});
