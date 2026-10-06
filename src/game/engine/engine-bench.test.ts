import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { browserName, describeBench, perSecond, stat, type Block, type BenchResult } from "./engine-bench.ts";

const S = (p50: number) => ({ mean: p50, p50, p95: p50 * 2, p99: p50 * 3, max: p50 * 4 });
const B = (fps: number, gpuMs: number | null): Block => ({ frames: 270, wallS: 9, fps, simSpeedPct: 99, simMsPerSimS: 212, msPerStep: 0.9, stepsPerFrame: 2.7, cpuMs: 7.5, drawMs: 2.1, gpuMs });

const RESULT: BenchResult = {
  course: "city",
  cars: 22,
  cops: { stakeouts: 6, pursuits: 3, maxPack: 2 },
  crashed: { mean: 3.4, end: 5 },
  frames: 2700,
  wallS: 30,
  fps: 90,
  fpsLow1: 41.7,
  fpsThirds: [90, 90, 89],
  fpsPerSecond: [90, 91, 89, 90],
  frameMs: S(11.1),
  cpuMs: S(7.5),
  simMs: S(4.2),
  renderMs: S(2),
  gpuMs: null,
  stepsPerFrame: 2.7,
  msPerStep: 1.56,
  simMsPerSimS: 212,
  cutFrames: 40,
  lostSimS: 0.5,
  coarsePct: 62.4,
  simSpeedPct: 98.3,
  strip: null,
  calls: 420,
  triangles: 380_000,
  tierPct: { high: 97, minimal: 3 },
  setupMs: { options: 800, start: 140 },
  settings: {
    fxTier: "high",
    fxAuto: true,
    post: "HDR half-float scene target, bloom (5 mips from 1/2 res, threshold 1.6, 0.45 strength), one composite pass: tone map, grade, vignette, radial blur, grain 0.03",
    fxDensity: 0.7,
    celLook: null,
    shadows: { enabled: true, type: "PCF", map: "2048x2048", casters: 223 },
    pixelRatio: 1.5,
    deviceRatio: 2.625,
    canvas: "1373x618",
    antialias: false,
    toneMapping: 4,
    night: false,
    wet: false,
    realism: 0.35,
    squash: 1,
    buckle: 1,
    deformMode: "shape",
    depth: { bits: 24, subpixelBits: 8, contextDepth: true, fragmentHighFloat: { precision: 23, rangeMin: 127, rangeMax: 127 }, near: 0.1, far: 180, logarithmicDepthBuffer: false },
  },
  abPace: { fine: B(41, 3), coarse: B(58, 3) },
  abFx: { minimal: B(60, 1.1), low: B(55, 2.4), high: B(48, null) },
  device: { browser: "Chrome 150", userAgent: "UA", gpu: "Mali-G715", gpuMasked: false, cores: 9, memoryGB: 8, screen: "412x915", dpr: 2.625, canvas: "1373x618", timerStepMs: 0.1 },
};

describe("given a list of frame-time samples", () => {
  test("when the percentiles of the first 5 of 7 values are asked, then they ignore the rest and the order of the values, and an empty list gives all zeros", () => {
    const s = stat([5, 1, 9, 3, 7, 100, 100], 5);
    assert.deepEqual(s, { mean: 5, p50: 5, p95: 9, p99: 9, max: 9 });
    assert.deepEqual(stat([]), { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });
});

describe("given a browser's user-agent string", () => {
  test("when the bench names the browser, then it gives the browser and its major version, and an unknown agent reads as unknown browser", () => {
    assert.equal(browserName("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"), "Firefox 128");
    assert.equal(browserName("Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36"), "Chrome 150");
    assert.equal(browserName("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"), "Edge 150");
    assert.equal(browserName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), "Safari 17");
    assert.equal(browserName("curl/8"), "unknown browser");
  });
});

describe("given the frame times of a bench run", () => {
  test("when frames are counted per wall second, then each full second gives its frame count and a partial last second is dropped", () => {
    const frames = [...Array<number>(100).fill(10), ...Array<number>(50).fill(20), ...Array<number>(25).fill(40), 5];
    assert.deepEqual(perSecond(frames), [100, 50, 25]);
    assert.deepEqual(perSecond([300, 300]), []);
  });
});

describe("given the bench result of a phone running the city course (describeBench writes it as the results card)", () => {
  test("when the card is written, then it leads with fps and sim speed, lists the settings and both A/Bs, marks a browser-masked GPU, shows the GPU timing when it can, and fits a 412 px tall phone screen", () => {
    const lines = describeBench(RESULT);
    assert.match(lines[0]!, /^CRUSH BENCH {2}city {2}22 cars.*\(Chrome 150\)$/);
    assert.match(lines[1]!, /^90\.0 FPS {3}1% low 41\.7 {3}by thirds 90\.0 \/ 90\.0 \/ 89\.0$/);
    assert.equal(lines[2], "fps each second: 90 91 89 90");
    assert.match(lines[3]!, /^SIM SPEED 98 % .*1\/120 s steps in 62 % of frames {3}wrecks: mean 3\.4, end 5$/);
    assert.ok(lines.some((l) => /^GPU {7}no timer query/.test(l)));
    assert.ok(lines.some((l) => l.includes("2.7 steps/frame, 1.56 ms/step, 212 ms per sim-second")));
    assert.ok(lines.some((l) => l.startsWith("fx tier: high 97 %, minimal 3 % (auto)") && l.includes("radial blur, grain 0.03")));
    assert.ok(lines.some((l) => l.includes("PCF 2048x2048, 223 casters") && l.includes("pixel ratio 1.5 of device 2.625, canvas 1373x618, no MSAA")));
    assert.ok(lines.some((l) => l === "depth: 24 bits (drawing buffer), subpixel 8 bits, fragment highp 23 bits, range 2^127..2^127, camera near 0.1 far 180, log depth off"));
    const noDepth = describeBench({ ...RESULT, settings: { ...RESULT.settings, depth: { ...RESULT.settings.depth, bits: 16, contextDepth: false, fragmentHighFloat: null, logarithmicDepthBuffer: true } } });
    assert.ok(noDepth.some((l) => l === "depth: 16 bits (drawing buffer, none requested), subpixel 8 bits, fragment highp not supported, camera near 0.1 far 180, log depth on"));
    assert.ok(lines.some((l) => l.startsWith("A/B pacer pinned: 1/240 s 41.0 fps")) && lines.some((l) => l.includes("1/120 s 58.0 fps")));
    assert.ok(lines.some((l) => l.includes("minimal 60.0 fps") && l.includes("gpu 1.1")) && lines.some((l) => l.includes("high 48.0 fps") && l.includes("gpu n/a")));
    assert.ok(!lines.some((l) => l.includes("masked")));
    const masked = describeBench({ ...RESULT, device: { ...RESULT.device, gpu: "ANGLE (NVIDIA GeForce GTX 980), or similar", gpuMasked: true } });
    assert.ok(masked.some((l) => l.includes("GTX 980") && l.includes("[masked by the browser: not the real GPU]")));
    const timed = describeBench({ ...RESULT, gpuMs: S(3) });
    assert.ok(timed.some((l) => /^GPU {7}p50 3\.0 {2}p95 6\.0/.test(l)));
    assert.ok(lines.length <= 26, "fits a 412 px tall phone screen at 11 px type, scrolling");
  });
});
