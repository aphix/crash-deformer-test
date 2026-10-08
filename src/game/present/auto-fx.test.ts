import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FxTier } from "./engine-post.ts";
import { AutoFx, hardwareDesktop } from "./auto-fx.ts";

// Deterministic 60 Hz jitter spanning 16.8–17.5 ms (57–59.5 fps per frame, about 58 fps on average).
const jitter60 = (i: number): number => 16.8 + ((i * 7) % 8) * 0.1;
const steady = (fps: number) => (): number => 1000 / fps;

/** A main thread that is nearly idle (ms per frame) and a browser with no GPU timer (Firefox): these tests vary the wall rate alone. */
const LIGHT_WORK_MS = 3;
const NO_GPU = -1;

/** A match clock in seconds, negative before green; `run` advances it by each frame. */
const race = (): { t: number } => ({ t: -4.5 });

/** Feeds `seconds` of frames; every switch the policy asked for as [second it happened, tier]. */
function run(fx: AutoFx, seconds: number, frame: (i: number) => number, match?: { t: number }): [number, FxTier][] {
  const out: [number, FxTier][] = [];
  let t = 0;
  for (let i = 0; t < seconds * 1000; i++) {
    const ms = frame(i);
    t += ms;
    if (match) match.t += ms / 1000;
    const to = fx.frame(ms, LIGHT_WORK_MS, NO_GPU, match ? match.t : null);
    if (to !== null) out.push([Math.round(t / 100) / 10, to]);
  }
  return out;
}

/** A capable client fed 60 Hz frames until the load check lifts it to "high" (stops on that frame, at 2.5 s). */
function onHigh(): AutoFx {
  const fx = new AutoFx(true, true);
  let t = 0;
  for (let i = 0; fx.frame(jitter60(i), LIGHT_WORK_MS, NO_GPU, null) === null; i++) t += jitter60(i);
  assert.equal(Math.round(t / 100) / 10, 2.5);
  return fx;
}

describe("given the automatic graphics-effects tier policy (it steps the effects tier up or down from the measured frame rate)", () => {
  it("when a hardware desktop holds 60 fps, then it goes to high 2.5 s after ready (1.5 s settle, 1 s sample) and stays there", () => {
    assert.deepEqual(run(new AutoFx(true, true), 3, jitter60), [[2.5, "high"]]);
    assert.deepEqual(run(onHigh(), 120, jitter60), []);
  });

  it("when the GPU is software or the frame rate stays under 57 fps, then the tier stays minimal", () => {
    assert.deepEqual(run(new AutoFx(false, true), 10, steady(144)), []);
    assert.deepEqual(run(new AutoFx(true, true), 10, steady(55)), []);
  });

  it("when the frame rate sustains 49 fps from high, then it steps high to low to minimal, 3.5 s each (settle plus two slow windows), never below", () => {
    const fx = onHigh();
    assert.deepEqual(run(fx, 60, steady(49)), [[3.5, "low"], [7.0, "minimal"]]);
  });

  it("when frames come in a 45 fps vsync cadence (two on-time frames, one double), then it drops although most frames are 16.7 ms", () => {
    const fx = onHigh();
    const cadence = (i: number): number => (i % 3 === 2 ? 2000 / 60 : 1000 / 60);
    assert.deepEqual(run(fx, 4, cadence), [[3.5, "low"]]);
  });

  it("when a single hitch of 100, 400 or 2000 ms interrupts 60 fps frames, then it ends only one slow window and never drops", () => {
    for (const hitch of [100, 400, 2000]) {
      const fx = onHigh();
      assert.deepEqual(run(fx, 30, (i) => (i === 300 ? hitch : jitter60(i))), [], `${hitch} ms hitch`);
    }
  });

  it("when the frame rate is 52 fps and then 48 fps, then it is judged against 60 fps, not the screen's refresh rate: 52 fps holds and 48 fps drops", () => {
    assert.deepEqual(run(onHigh(), 30, steady(52)), []);
    assert.deepEqual(run(onHigh(), 30, steady(48)), [[3.5, "low"], [7.0, "minimal"]]);
  });

  it("when a race starts, then it starts on minimal and lifts to the tier that held 3 s after green plus the 1 s window, then is monitored again", () => {
    const fx = onHigh();
    const m = race();
    // Grid and countdown 4.5 s, green + 3 s = 7.5 s, window to 8.5 s.
    assert.deepEqual(run(fx, 8, jitter60, m), [[0, "minimal"]]);
    assert.deepEqual(run(fx, 1, jitter60, m), [[0.5, "high"]]);
    // Monitor again: 1.5 s settle (0.5 s of it spent in the lift's second), then two slow windows.
    assert.deepEqual(run(fx, 4, steady(40), m), [[3, "low"]]);
  });

  it("when a race runs under 57 fps at green + 3 s, then it stays minimal to the race's end, which returns it to the ceiling", () => {
    const fx = onHigh();
    const m = race();
    assert.deepEqual(run(fx, 30, steady(45), m), [[0, "minimal"]]);
    assert.deepEqual(run(fx, 1, jitter60), [[0, "high"]]);
  });

  it("when a race starts on a machine whose ceiling is low, then it lifts to low, not high", () => {
    const fx = onHigh();
    assert.deepEqual(run(fx, 4, steady(49)), [[3.5, "low"]]);
    assert.deepEqual(run(fx, 12, jitter60, race()), [[0, "minimal"], [8.5, "low"]]);
  });

  it("when a derby starts with its clock closer to green, then it is probed 3 s after green the same way", () => {
    const fx = onHigh();
    const m = { t: -1.5 };
    assert.deepEqual(run(fx, 10, jitter60, m), [[0, "minimal"], [5.5, "high"]]);
  });

  it("when a match starts during the load check, then it keeps minimal and the check lifts it 3 s after green", () => {
    const fx = new AutoFx(true, true);
    assert.deepEqual(run(fx, 1, jitter60), []);
    assert.deepEqual(run(fx, 12, jitter60, race()), [[8.5, "high"]]);
  });

  it("when a software-GPU machine runs a race, then it stays minimal through the race", () => {
    assert.deepEqual(run(new AutoFx(false, true), 12, steady(144), race()), []);
  });

  it("when the player picks a tier by hand, then auto turns off: no match drop or lift and no slowdown drop until it is resumed", () => {
    const fx = onHigh();
    fx.auto = false;
    assert.deepEqual(run(fx, 12, jitter60, race()), []);
    assert.deepEqual(run(fx, 10, steady(30)), []);
    fx.resume("off");
    assert.deepEqual(run(fx, 1, jitter60), [[0, "high"]]);
  });
});

describe("given the check for being fit to host a public match", () => {
  it("when the machine is a hardware desktop before its load check, after it holds high, or after it falls to low, then it is fit", () => {
    assert.equal(new AutoFx(true, true).canHost(), true);
    const fx = onHigh();
    assert.equal(fx.canHost(), true);
    run(fx, 4, steady(49));
    assert.equal(fx.canHost(), true, "low is still fit (3.5 s in)");
  });

  it("when the machine is a phone or software GPU, a desktop under 57 fps at its load check, or one that fell to minimal, then it is not fit", () => {
    assert.equal(new AutoFx(false, true).canHost(), false);
    const slow = new AutoFx(true, true);
    run(slow, 10, steady(55));
    assert.equal(slow.canHost(), false);
    const fell = onHigh();
    run(fell, 60, steady(49));
    assert.equal(fell.canHost(), false);
  });
});

describe("given the check for a hardware desktop (a fine pointer and a hardware GPU)", () => {
  const nvidia = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)";
  it("when the pointer is fine and the GPU is hardware, then it is a hardware desktop", () => {
    assert.equal(hardwareDesktop(nvidia, true), true);
  });
  it("when the renderer is a software rasterizer or unknown, or the pointer is coarse, then it is not a hardware desktop", () => {
    assert.equal(hardwareDesktop("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", true), false);
    assert.equal(hardwareDesktop("llvmpipe (LLVM 15.0.7, 256 bits)", true), false);
    assert.equal(hardwareDesktop("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)", true), false);
    assert.equal(hardwareDesktop("Gallium 0.4 on softpipe", true), false);
    assert.equal(hardwareDesktop(nvidia, false), false);
    assert.equal(hardwareDesktop(null, true), false);
  });
});

/** A segment of identical frames: the wall interval, the main thread's ms and the GPU's ms (-1: no timer) of each, for `seconds`. */
interface Spell {
  seconds: number;
  wallMs: number;
  workMs: number;
  gpuMs: number;
}

const calm = (seconds: number, wallMs = 1000 / 60): Spell => ({ seconds, wallMs, workMs: 3, gpuMs: 2 });
/** Too full for 60 fps: 22 ms of main-thread work a frame, so the display shows every other vsync. */
const overloaded = (seconds: number): Spell => ({ seconds, wallMs: 2000 / 60, workMs: 22, gpuMs: 8 });

/** Feeds the spells in turn, outside a match; every switch as [second it happened, tier]. */
function runSpells(fx: AutoFx, spells: Spell[]): [number, FxTier][] {
  const out: [number, FxTier][] = [];
  let t = 0;
  for (const spell of spells) {
    for (let spent = 0; spent < spell.seconds * 1000; spent += spell.wallMs) {
      t += spell.wallMs;
      const to = fx.frame(spell.wallMs, spell.workMs, spell.gpuMs, null);
      if (to !== null) out.push([Math.round(t / 100) / 10, to]);
    }
  }
  return out;
}

describe("given the tier decided by frame work (the main thread's and the GPU's ms against the 60 fps budget), whatever the display's refresh", () => {
  const refreshCases = [
    { it: "when a 48 Hz display shows 3 ms of work and 2 ms of GPU, then it lifts to high although the screen shows 48 fps", spells: [calm(10, 1000 / 48)], expected: [[2.5, "high"]] },
    { it: "when a 30 Hz display shows 3 ms of work and 2 ms of GPU, then it lifts to high although the screen shows 30 fps", spells: [calm(10, 1000 / 30)], expected: [[2.6, "high"]] },
    { it: "when a 144 Hz display shows 3 ms of work and no GPU timer, then it lifts to high", spells: [{ seconds: 10, wallMs: 1000 / 144, workMs: 3, gpuMs: -1 }], expected: [[2.5, "high"]] },
    { it: "when a 60 Hz display shows 15 ms of work (on time, but a frame 90 % full) and no GPU timer, then it stays minimal", spells: [{ seconds: 10, wallMs: 1000 / 60, workMs: 15, gpuMs: -1 }], expected: [] },
    { it: "when a 60 Hz display shows 3 ms of work but 15 ms of GPU, then it stays minimal", spells: [{ seconds: 10, wallMs: 1000 / 60, workMs: 3, gpuMs: 15 }], expected: [] },
  ] as const;
  for (const testCase of refreshCases) {
    it(testCase.it, () => {
      assert.equal(runSpells(new AutoFx(true, true), [...testCase.spells]).join(" "), testCase.expected.join(" "));
    });
  }

  it("when a spell of overload falls to minimal and the load then ends, then it climbs one tier at a time after a long calm, never straight to high", () => {
    const moves = runSpells(new AutoFx(true, true), [calm(4), overloaded(12), calm(120)]);
    assert.deepEqual(moves, [[2.5, "high"], [6, "low"], [9.6, "minimal"], [31.4, "low"], [41, "high"]]);
  });

  it("when the load comes and goes every 10 s for 80 s, then it moves 5 times, not on every spell: a climb that fails is not repeated soon", () => {
    const spells = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? calm(10) : overloaded(10)));
    assert.deepEqual(runSpells(new AutoFx(true, true), spells), [[2.5, "high"], [12.2, "low"], [15.7, "minimal"], [47.5, "low"], [52, "minimal"]]);
  });

  it("when frames stay calm for 2 minutes, then it stays on high and never asks for the ultra tier", () => {
    const asked = runSpells(new AutoFx(true, true), [calm(120)]).map((m) => m[1]);
    assert.deepEqual(asked, ["high"]);
  });
});
