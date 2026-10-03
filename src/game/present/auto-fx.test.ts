import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FxTier } from "./engine-post.ts";
import { AutoFx, hardwareDesktop } from "./auto-fx.ts";

// Deterministic 60 Hz jitter spanning 16.8–17.5 ms (57–59.5 fps per frame, about 58 fps on average).
const jitter60 = (i: number): number => 16.8 + ((i * 7) % 8) * 0.1;
const steady = (fps: number) => (): number => 1000 / fps;

/** Feeds `seconds` of frames; every switch the policy asked for as [second it happened, tier]. */
function run(fx: AutoFx, seconds: number, frame: (i: number) => number, match = false): [number, FxTier][] {
  const out: [number, FxTier][] = [];
  let t = 0;
  for (let i = 0; t < seconds * 1000; i++) {
    const ms = frame(i);
    t += ms;
    const to = fx.frame(ms, match);
    if (to !== null) out.push([Math.round(t / 100) / 10, to]);
  }
  return out;
}

/** A capable client fed 60 Hz frames until the load check lifts it to "high" (stops on that frame, at 2.5 s). */
function onHigh(): AutoFx {
  const fx = new AutoFx(true, true);
  let t = 0;
  for (let i = 0; fx.frame(jitter60(i), false) === null; i++) t += jitter60(i);
  assert.equal(Math.round(t / 100) / 10, 2.5);
  return fx;
}

describe("auto FX tier", () => {
  it("load check: a hardware desktop holding 60 fps goes high 2.5 s after ready (1.5 s settle, 1 s sample) and stays", () => {
    assert.deepEqual(run(new AutoFx(true, true), 3, jitter60), [[2.5, "high"]]);
    assert.deepEqual(run(onHigh(), 120, jitter60), []);
  });

  it("load check: a software GPU or a minimal tier under 57 fps stays minimal", () => {
    assert.deepEqual(run(new AutoFx(false, true), 10, steady(144)), []);
    assert.deepEqual(run(new AutoFx(true, true), 10, steady(55)), []);
  });

  it("a sustained 49 fps steps high → low → minimal, 3.5 s each (settle plus two slow windows), never below", () => {
    const fx = onHigh();
    assert.deepEqual(run(fx, 60, steady(49)), [[3.5, "low"], [7.0, "minimal"]]);
  });

  it("a 45 fps vsync cadence (two on-time frames, one double) drops though most frames are 16.7 ms", () => {
    const fx = onHigh();
    const cadence = (i: number): number => (i % 3 === 2 ? 2000 / 60 : 1000 / 60);
    assert.deepEqual(run(fx, 4, cadence), [[3.5, "low"]]);
  });

  it("one hitch, however long, ends only one slow window and never drops", () => {
    for (const hitch of [100, 400, 2000]) {
      const fx = onHigh();
      assert.deepEqual(run(fx, 30, (i) => (i === 300 ? hitch : jitter60(i))), [], `${hitch} ms hitch`);
    }
  });

  it("is judged against 60 fps, not the refresh: 52 fps holds, 48 fps drops", () => {
    assert.deepEqual(run(onHigh(), 30, steady(52)), []);
    assert.deepEqual(run(onHigh(), 30, steady(48)), [[3.5, "low"], [7.0, "minimal"]]);
  });

  it("a match starts on minimal and its end returns to the tier that held, after any drop", () => {
    const fx = onHigh();
    assert.deepEqual(run(fx, 60, jitter60, true), [[0, "minimal"]]);
    assert.deepEqual(run(fx, 1, jitter60), [[0, "high"]]);
    // The second left of the 1.5 s settle, then two slow windows.
    assert.deepEqual(run(fx, 4, steady(40)), [[2.5, "low"]]);
    assert.deepEqual(run(fx, 4, jitter60, true), [[0, "minimal"]]);
    assert.deepEqual(run(fx, 30, jitter60), [[0, "low"]]);
  });

  it("a match that starts during the load check keeps minimal; the check's high waits for its end", () => {
    const fx = new AutoFx(true, true);
    assert.deepEqual(run(fx, 1, jitter60), []);
    assert.deepEqual(run(fx, 30, jitter60, true), []);
    assert.deepEqual(run(fx, 1, jitter60), [[0, "high"]]);
  });

  it("a manual pick turns auto off: no match drop, no slowdown drop, until resumed", () => {
    const fx = onHigh();
    fx.auto = false;
    assert.deepEqual(run(fx, 10, jitter60, true), []);
    assert.deepEqual(run(fx, 10, steady(30)), []);
    fx.resume("off");
    assert.deepEqual(run(fx, 1, jitter60), [[0, "high"]]);
  });
});

describe("hardwareDesktop", () => {
  const nvidia = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)";
  it("a fine pointer with a hardware GPU is a hardware desktop", () => {
    assert.equal(hardwareDesktop(nvidia, true), true);
  });
  it("software rasterizers, coarse pointers and unknown renderers are not", () => {
    assert.equal(hardwareDesktop("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", true), false);
    assert.equal(hardwareDesktop("llvmpipe (LLVM 15.0.7, 256 bits)", true), false);
    assert.equal(hardwareDesktop("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)", true), false);
    assert.equal(hardwareDesktop("Gallium 0.4 on softpipe", true), false);
    assert.equal(hardwareDesktop(nvidia, false), false);
    assert.equal(hardwareDesktop(null, true), false);
  });
});
