import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FrameGuard, hardwareDesktop } from "./fx-boost.ts";

// Deterministic 60 Hz jitter spanning 16.8–17.5 ms.
const jitter60 = (i: number): number => 16.8 + ((i * 7) % 8) * 0.1;

function armedOn(frame: (i: number) => number, n = 200): FrameGuard {
  const g = new FrameGuard();
  for (let i = 0; i < n; i++) g.sample(frame(i));
  g.arm();
  return g;
}

/** Index of the first fed frame that asked to drop back, or -1. */
function firstDrop(g: FrameGuard, frames: number[]): number {
  return frames.findIndex((ms) => g.feed(ms));
}

describe("reel FX boost frame guard", () => {
  it("a jittery 60 Hz display never drops, though every frame is slower than 60 fps", () => {
    const g = armedOn(jitter60);
    const frames = Array.from({ length: 400 }, (_, i) => jitter60(i + 3));
    assert.ok(Math.max(...frames) > 1000 / 60);
    assert.equal(firstDrop(g, frames), -1);
  });

  it("a sustained 45 fps feed drops on exactly the 11th long frame", () => {
    const g = armedOn(jitter60);
    assert.equal(firstDrop(g, Array(30).fill(22.2)), 10);
  });

  it("a 144 Hz display at 90 fps (above 60 fps) never drops, but at 45 fps does", () => {
    const g = armedOn(() => 1000 / 144);
    assert.equal(firstDrop(g, Array(300).fill(11.1)), -1);
    assert.equal(firstDrop(g, Array(30).fill(22.2)), 10);
  });

  it("one on-time frame inside a long run resets the streak", () => {
    const g = armedOn(jitter60);
    assert.equal(firstDrop(g, [...Array(10).fill(22.2), 16.9, ...Array(10).fill(22.2)]), -1);
    assert.equal(g.feed(22.2), true);
  });

  it("arming again clears the streak", () => {
    const g = armedOn(jitter60);
    assert.equal(firstDrop(g, Array(10).fill(22.2)), -1);
    g.arm();
    assert.equal(firstDrop(g, Array(10).fill(22.2)), -1);
  });

  it("too few samples at arm assume a 1000/60 ms refresh", () => {
    const g = armedOn(() => 1000 / 144, 5);
    // 18 ms is within 1.1x of 16.67 ms; 18.5 ms is past it.
    assert.equal(firstDrop(g, Array(30).fill(18)), -1);
    assert.equal(firstDrop(g, Array(30).fill(18.5)), 10);
  });

  it("the refresh is the median, so pre-boost hitches do not loosen it", () => {
    // 5 of 200 frames hitch to 100 ms: a mean would sit near 19.2 ms and let 20 ms frames pass.
    const g = armedOn((i) => (i % 40 === 0 ? 100 : jitter60(i)));
    assert.equal(firstDrop(g, Array(30).fill(20)), 10);
  });

  it("only the recent window sets the refresh: a 60 Hz history is forgotten after 144 Hz frames", () => {
    const g = new FrameGuard();
    for (let i = 0; i < 200; i++) g.sample(jitter60(i));
    for (let i = 0; i < 200; i++) g.sample(1000 / 144);
    g.arm();
    // Against 6.94 ms, 17.2 ms frames are long and below 60 fps.
    assert.equal(firstDrop(g, Array(30).fill(17.2)), 10);
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
