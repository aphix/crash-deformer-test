import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BOARD, type LabItem, type LabPose } from "../scenes/lab.ts";
import { tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { pairEta, PRE_IMPACT_LEAD, preImpact } from "../match/phase.ts";
import { labRig, leaveLab, runLab, type LabRig } from "./engine-lab.test-util.ts";
import { FREE, WALL, type LabShot } from "./engine-lab.ts";
import { benchPlan } from "./engine-bench-plan.ts";

/**
 * The Lab's throw bench (`Lab`), headless through the engine's own step: the presets stand, a thrown car topples the house
 * of cards, a car-car hit keeps the pair's momentum, and nothing passes through anything at 10, 30 or 55 m/s.
 */

afterEach(leaveLab);

const SEDAN = { cls: "sedan", style: "sedan" } as const;
const at = (x: number, z: number, yaw: number): LabPose => ({ x, y: 0, z, yaw, pitch: 0, roll: 0 });
const car = (pose: LabPose): LabItem => ({ kind: "car", type: SEDAN, pose, hold: "free" });

/** Plan distance (m) each car of a rig moves over `seconds` of sim. */
function planMoves(r: LabRig, seconds: number): number[] {
  const from = r.cars.map((c) => c.group.position.clone());
  runLab(r, seconds);
  return r.cars.map((c, i) => Math.hypot(c.group.position.x - from[i]!.x, c.group.position.z - from[i]!.z));
}

/** How far (m) the thrown car's centre ever got past the target's along the throw, while beside it within `beside` m and below its roof. */
function deepestPast(shot: LabShot, beside: number): number {
  const dx = shot.launch.x;
  const dz = shot.launch.z;
  const len = Math.hypot(dx, dz);
  let worst = -Infinity;
  for (let k = 0; k < shot.pathN; k++) {
    const rx = shot.path[k * 3]! - shot.targetPath[k * 3]!;
    const ry = shot.path[k * 3 + 1]! - shot.targetPath[k * 3 + 1]!;
    const rz = shot.path[k * 3 + 2]! - shot.targetPath[k * 3 + 2]!;
    const along = (rx * dx + rz * dz) / len;
    const across = Math.abs(rx * dz - rz * dx) / len;
    if (across < beside && Math.abs(ry) < 1) worst = Math.max(worst, along);
  }
  return worst;
}

const FRAME = 1 / 60;
/** The engine's pre-impact window at 60 frames a second, and its sim step. */
const LEAD = Math.max(PRE_IMPACT_LEAD, 2 * FRAME);

/**
 * `wallS` seconds of 60 Hz frames with the sandbox's automatic slow-mo: before each frame in approach, the engine's
 * pre-impact rule on the cars' predicted hit. The sim second the slow-mo first came on, first went back to 1x before
 * any hit, and the hit landed (NaN: never).
 */
function watchSlowmo(r: LabRig, wallS: number): { slowedAt: number; freedAt: number; hitAt: number } {
  r.w.slomo = true;
  let sim = 0;
  const lab = r.w.world.beforeSlice!;
  r.w.world.beforeSlice = (h) => {
    const out = lab(h);
    sim += h;
    return out;
  };
  const c = r.w.clock;
  const seen = { slowedAt: NaN, freedAt: NaN, hitAt: NaN };
  for (let f = 0; f < wallS / FRAME; f++) {
    if (c.phase === "approach") {
      for (const car of r.cars) car.refreshBasis();
      preImpact(c, pairEta(r.cars), sim, LEAD, FRAME, () => false);
      if (c.timeScale < 1 && Number.isNaN(seen.slowedAt)) seen.slowedAt = sim;
      if (c.timeScale === 1 && !Number.isNaN(seen.slowedAt) && Number.isNaN(seen.freedAt)) seen.freedAt = sim;
    }
    tickWorld(r.w, FRAME);
    if (c.phase !== "approach" && Number.isNaN(seen.hitAt)) seen.hitAt = sim;
  }
  return seen;
}

describe("given the house of cards on the bench (two sedans nose to tail, a third lying across both roofs)", () => {
  it("when it is left alone, then it settles within 5 mm in its first 5 s and then no car moves 0.1 mm or tips over the next 10 s", () => {
    const r = labRig("cards");
    const settle = planMoves(r, 5);
    assert.ok(Math.max(...settle) < 0.005, `settling moved the cars ${settle.map((m) => (m * 1000).toFixed(2)).join(" / ")} mm`);
    const after = planMoves(r, 10);
    assert.ok(Math.max(...after) < 1e-4, `standing moved the cars ${after.map((m) => (m * 1000).toFixed(3)).join(" / ")} mm over 10 s`);
    for (const c of r.cars) assert.ok(c.group.matrixWorld.elements[5]! > 0.99, `a car tipped to up ${c.group.matrixWorld.elements[5]}`);
  });

  const toppleCases = [
    { it: "when a sedan is thrown at its top car at 10 m/s, then the top car and both cars under it are knocked off their places", speed: 10 },
    { it: "when a sedan is thrown at its top car at 30 m/s, then the top car and both cars under it are knocked off their places", speed: 30 },
  ] as const;
  for (const testCase of toppleCases) {
    it(testCase.it, () => {
      const r = labRig("cards");
      runLab(r, 5);
      const shot = r.lab.throwAt(0, 3, testCase.speed);
      runLab(r, 4);
      assert.notEqual(shot.contactS, null, "the thrown car never met the stack");
      assert.deepEqual([...shot.fell].sort(), [1, 2, 3]);
    });
  }
});

describe("given two sedans on the bench 20 m apart, the far one broadside to the near one", () => {
  const momentumCases = [
    { it: "when the near one is thrown into the far one's side at 10 m/s, then their momentum along the throw changes by under 4 % through the hit", speed: 10 },
    { it: "when the near one is thrown into the far one's side at 30 m/s, then their momentum along the throw changes by under 4 % through the hit", speed: 30 },
    { it: "when the near one is thrown into the far one's side at 55 m/s, then their momentum along the throw changes by under 4 % through the hit", speed: 55 },
  ] as const;
  for (const testCase of momentumCases) {
    it(testCase.it, () => {
      const r = labRig([car(at(-14, 0, Math.PI / 2)), car(at(6, 0, 0))]);
      runLab(r, 0.5);
      const shot = r.lab.throwAt(0, 1, testCase.speed);
      runLab(r, 3);
      assert.notEqual(shot.momentumAfter, null, "the hit never ended");
      const change = Math.abs(shot.momentumAfter! - shot.momentumBefore) / shot.momentumBefore;
      assert.ok(change < 0.04, `momentum ${shot.momentumBefore.toFixed(0)} -> ${shot.momentumAfter!.toFixed(0)} kg m/s (${(change * 100).toFixed(2)} %) over ${shot.pulseS} s`);
    });
  }
});

describe("given a sedan thrown at something on the bench", () => {
  const throughCarCases = [
    { it: "when it hits a parked sedan's side at 10 m/s, then it never ends up past the parked car", speed: 10 },
    { it: "when it hits a parked sedan's side at 30 m/s, then it never ends up past the parked car", speed: 30 },
    { it: "when it hits a parked sedan's side at 55 m/s, then it never ends up past the parked car", speed: 55 },
  ] as const;
  for (const testCase of throughCarCases) {
    it(testCase.it, () => {
      const r = labRig([car(at(-14, 0, Math.PI / 2)), car(at(6, 0, 0))]);
      runLab(r, 0.5);
      const shot = r.lab.throwAt(0, 1, testCase.speed);
      runLab(r, 3);
      assert.notEqual(shot.contactS, null, "it never met the parked car");
      const past = deepestPast(shot, 1.5);
      assert.ok(past < 0, `its centre got ${past.toFixed(2)} m past the parked car's`);
    });
  }

  const throughWallCases = [
    { it: "when it is thrown nose first at the pegboard at 10 m/s, then its centre never gets to the board's face", speed: 10 },
    { it: "when it is thrown nose first at the pegboard at 30 m/s, then its centre never gets to the board's face", speed: 30 },
    { it: "when it is thrown nose first at the pegboard at 55 m/s, then its centre never gets to the board's face", speed: 55 },
  ] as const;
  for (const testCase of throughWallCases) {
    it(testCase.it, () => {
      const r = labRig([car(at(0, BOARD.z + 16, Math.PI))]);
      runLab(r, 0.5);
      const shot = r.lab.throwAt(0, WALL, testCase.speed);
      runLab(r, 3);
      assert.equal(shot.hit, WALL, "it never met the board");
      let nearest = Infinity;
      for (let k = 0; k < shot.pathN; k++) nearest = Math.min(nearest, shot.path[k * 3 + 2]! - BOARD.z);
      assert.ok(nearest > 0, `its centre reached ${nearest.toFixed(2)} m from the board's face`);
    });
  }

  const throughBlockCases = [
    { it: "when it is thrown at a concrete barrier block at 10 m/s, then its centre never gets past the block's near face", speed: 10 },
    { it: "when it is thrown at a concrete barrier block at 30 m/s, then its centre never gets past the block's near face", speed: 30 },
    { it: "when it is thrown at a concrete barrier block at 55 m/s, then its centre never gets past the block's near face", speed: 55 },
  ] as const;
  for (const testCase of throughBlockCases) {
    it(testCase.it, () => {
      const block: LabItem = { kind: "prop", prefab: "barrier-block", pose: at(6, 0, 0), hold: "free" };
      const r = labRig([car(at(-14, 0, Math.PI / 2)), block]);
      runLab(r, 0.5);
      const shot = r.lab.throwAt(0, 1, testCase.speed);
      runLab(r, 3);
      assert.equal(shot.hit, 1, "it never met the block");
      let farthest = -Infinity;
      for (let k = 0; k < shot.pathN; k++) farthest = Math.max(farthest, shot.path[k * 3]!);
      // The block is 0.64 m thick across the throw: its near face stands at x = 6 - 0.32.
      assert.ok(farthest < 6 - 0.32, `its centre reached x = ${farthest.toFixed(2)}`);
    });
  }
});

describe("given a sedan flicked at 30 m/s with the automatic slow-mo on", () => {
  it("when it is flicked at the house of cards' top car, then the slow-mo comes on before the hit and holds until it lands", () => {
    const r = labRig("cards");
    runLab(r, 5);
    r.lab.flick(0, 3, 0, 0, 30);
    const seen = watchSlowmo(r, 6);
    assert.ok(seen.hitAt > 0, "it never hit the stack");
    assert.ok(seen.slowedAt < seen.hitAt, `the slow-mo came on at sim ${seen.slowedAt} s, the hit at ${seen.hitAt.toFixed(3)} s`);
    assert.ok(Number.isNaN(seen.freedAt), `time went back to 1x at sim ${seen.freedAt.toFixed(3)} s, before the hit at ${seen.hitAt.toFixed(3)} s`);
  });

  it("when it is flicked past a parked sedan alongside it with 1.2 m to spare, then the slow-mo that came on for it hands back to 1x one step after the hit was due and stays off", () => {
    const r = labRig([car(at(-14, 0, Math.PI / 2)), car(at(6, 3, Math.PI / 2))]);
    runLab(r, 0.5);
    r.lab.flick(0, FREE, 1, 0, 30);
    const seen = watchSlowmo(r, 10);
    assert.ok(Number.isNaN(seen.hitAt), `it hit something at sim ${seen.hitAt.toFixed(3)} s`);
    assert.ok(seen.slowedAt > 0, "the slow-mo never came on");
    assert.ok(seen.freedAt > seen.slowedAt && seen.freedAt <= seen.slowedAt + LEAD + 2 * FRAME, `slowed at sim ${seen.slowedAt.toFixed(3)} s, back to 1x at ${seen.freedAt.toFixed(3)} s`);
    assert.equal(r.w.clock.timeScale, 1);
  });
});

describe("given the throws of the Lab's bench page (?bench=lab), each on its own set", () => {
  const seq = benchPlan("?bench=lab")!.lab!;
  for (const step of seq.throws) {
    it(`when the ${step.preset} set has stood ${seq.settleS} s and its thrower is flicked at its target at ${step.speed} m/s, then the thrower meets the set within 2 s of the set loading and has knocked its target off its place by the next set`, () => {
      const r = labRig(step.preset);
      runLab(r, seq.settleS);
      const shot = r.lab.flick(0, step.target, 0, 0, step.speed);
      runLab(r, seq.segmentS - seq.settleS);
      assert.notEqual(shot.contactS, null, "the thrower never met the set");
      // The bench's A/B blocks are 3 s of wall from the set's load: the hit must land well inside one.
      assert.ok(seq.settleS + shot.contactS! < 2, `met the set ${(seq.settleS + shot.contactS!).toFixed(2)} s after it loaded`);
      assert.ok(shot.fell.includes(step.target), `knocked ${JSON.stringify(shot.fell)}, not ${step.target}`);
    });
  }
});
