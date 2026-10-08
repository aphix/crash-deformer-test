import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { browserName, describeBench, perSecond, stat, type Block, type BenchResult } from "./engine-bench-report.ts";
import { benchPlan } from "./engine-bench-plan.ts";

const S = (p50: number) => ({ mean: p50, p50, p95: p50 * 2, p99: p50 * 3, max: p50 * 4 });
const B = (fps: number, gpuMs: number | null, fineCutsPerSimS = 0): Block => ({ frames: 270, wallS: 9, fps, simSpeedPct: 99, simMsPerSimS: 212, msPerStep: 0.9, stepsPerFrame: 2.7, cpuMs: 7.5, drawMs: 2.1, gpuMs, fineCutsPerSimS, calls: 640, triangles: 410000 });

const RESULT: BenchResult = {
  course: "city",
  build: "36b137f",
  cars: 22,
  cops: { stakeouts: 6, pursuits: 3, maxPack: 2 },
  crashed: { mean: 3.4, end: 5 },
  frames: 2700,
  wallS: 30,
  fps: 90,
  fpsLow1: 41.7,
  fpsThirds: [90, 90, 89],
  fpsPerSecond: [90, 91, 89, 90],
  simMsPerSecond: [212, 230, 640, 205],
  frameMs: S(11.1),
  cpuMs: S(7.5),
  simMs: S(4.2),
  renderMs: S(2),
  gpuMs: null,
  stepsPerFrame: 2.7,
  msPerStep: 1.56,
  simMsPerSimS: 212,
  fineCutsPerSimS: 3.4,
  cutFrames: 40,
  lostSimS: 0.5,
  coarsePct: 62.4,
  simSpeedPct: 98.3,
  strip: null,
  labThrown: null,
  calls: 420,
  triangles: 380_000,
  tierPct: { high: 97, minimal: 3 },
  detailPct: { "50 m": 80, "40 m": 20 },
  setupMs: { options: 800, start: 140 },
  pageEvents: [{ phase: "warm", atS: 0, visible: true, focused: true, fullscreen: false }],
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
    depth: {
      bits: 24,
      subpixelBits: 8,
      contextDepth: true,
      fragmentHighFloat: { precision: 23, rangeMin: 127, rangeMax: 127 },
      near: 0.1,
      far: 180,
      logarithmicDepthBuffer: false,
      probe: { subpixelBits: 8, bands: [{ from: 5, to: 10, slope: { u50: 0.01, u95: 0.0625 }, steps: { u50: 20, u95: 61.6 } }] },
    },
  },
  abPace: { fine: B(41, 3, 12.5), coarse: B(58, 3, 0) },
  abFx: { minimal: B(60, 1.1), low: B(55, 2.4), high: B(48, null) },
  abDetail: { off: B(44, null), "75 m": B(49, null), "50 m": B(56, null), "30 m": B(59, null) },
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

describe("given the frame times and the sim's time per frame of a bench run", () => {
  test("when they are summed per wall second, then each full second gives its frame count and the sim's ms in it, scaled to 1000 ms, and a partial last second is dropped", () => {
    const frames = [...Array<number>(100).fill(10), ...Array<number>(50).fill(20), ...Array<number>(25).fill(40), 5];
    const simMs = [...Array<number>(100).fill(2), ...Array<number>(50).fill(8), ...Array<number>(25).fill(0), 3];
    assert.deepEqual(perSecond(frames, simMs), { fps: [100, 50, 25], workMs: [200, 400, 0] });
    assert.deepEqual(perSecond([500, 750], [100, 150]), { fps: [2], workMs: [200] });
    assert.deepEqual(perSecond([300, 300], [1, 1]), { fps: [], workMs: [] });
  });
});

describe("given the bench result of a phone running the city course (describeBench writes it as the results card)", () => {
  test("when the card is written, then it leads with the build, fps, the sim's ms each second and sim speed, lists the settings (the depth buffer with the offset a ground layer needs to show over a coplanar one), both A/Bs and the steps cut short for a coming hit, marks a browser-masked GPU, shows the GPU timing when it can, and fits a 412 px tall phone screen", () => {
    const lines = describeBench(RESULT);
    assert.match(lines[0]!, /^CRUSH BENCH {2}city {2}22 cars.*\(Chrome 150\) {2}build 36b137f$/);
    assert.match(lines[1]!, /^90\.0 FPS {3}1% low 41\.7 {3}by thirds 90\.0 \/ 90\.0 \/ 89\.0$/);
    assert.equal(lines[2], "fps each second: 90 91 89 90");
    assert.equal(lines[3], "sim ms each second: 212 230 640 205");
    assert.match(lines[4]!, /^SIM SPEED 98 % .*1\/120 s steps in 62 % of frames {3}wrecks: mean 3\.4, end 5$/);
    assert.ok(lines.some((l) => /^GPU {7}no timer query/.test(l)));
    assert.ok(lines.some((l) => l.endsWith("2.7 steps/frame, 1.56 ms/step, 212 ms per sim-second, 3.4 fine-slice cuts/sim-s")));
    assert.ok(lines.some((l) => l.startsWith("fx tier: high 97 %, minimal 3 % (auto)") && l.includes("radial blur, grain 0.03")));
    assert.ok(lines.some((l) => l.includes("PCF 2048x2048, 223 casters") && l.includes("pixel ratio 1.5 of device 2.625, canvas 1373x618, no MSAA")));
    assert.ok(lines.some((l) => l === "depth: 24 bits (drawing buffer), subpixel 8 bits, fragment highp 23 bits, range 2^127..2^127, camera near 0.1 far 180, log depth off, coplanar layer shows at 0.063 px of slope or 62 steps"));
    const noDepth = describeBench({ ...RESULT, settings: { ...RESULT.settings, depth: { ...RESULT.settings.depth, bits: 16, contextDepth: false, fragmentHighFloat: null, logarithmicDepthBuffer: true } } });
    assert.ok(noDepth.some((l) => l === "depth: 16 bits (drawing buffer, none requested), subpixel 8 bits, fragment highp not supported, camera near 0.1 far 180, log depth on, coplanar layer shows at 0.063 px of slope or 62 steps"));
    assert.ok(lines.some((l) => l.startsWith("A/B pacer pinned: 1/240 s 41.0 fps") && l.endsWith(", 12.5 fine-slice cuts/sim-s")) && lines.some((l) => l.includes("1/120 s 58.0 fps") && l.endsWith(", 0.0 fine-slice cuts/sim-s")));
    assert.ok(lines.some((l) => l.includes("minimal 60.0 fps") && l.includes("gpu 1.1")) && lines.some((l) => l.includes("high 48.0 fps") && l.includes("gpu n/a")));
    assert.ok(lines.some((l) => l === "detail: only the body drawn beyond 50 m for 80 %, 40 m for 20 % of the window"));
    assert.ok(lines.some((l) => l.startsWith("A/B detail pinned: no cuts 44.0 fps")) && lines.some((l) => l.includes("body beyond 30 m 59.0 fps")));
    assert.ok(!lines.some((l) => l.includes("masked")));
    const masked = describeBench({ ...RESULT, device: { ...RESULT.device, gpu: "ANGLE (NVIDIA GeForce GTX 980), or similar", gpuMasked: true } });
    assert.ok(masked.some((l) => l.includes("GTX 980") && l.includes("[masked by the browser: not the real GPU]")));
    const timed = describeBench({ ...RESULT, gpuMs: S(3) });
    assert.ok(timed.some((l) => /^GPU {7}p50 3\.0 {2}p95 6\.0/.test(l) && !l.includes("wait on the display")), "frames of 11 ms: a 6 ms p95 is work");
    // The owner's 165 Hz desktop card: frame p50 6.1 ms, GPU p50 1.5 ms and p95 5.96 ms: one refresh long, so a wait.
    const waiting = describeBench({ ...RESULT, frameMs: S(6.1), gpuMs: { mean: 2.9, p50: 1.5, p95: 5.96, p99: 6.2, max: 10.6 } });
    assert.ok(waiting.some((l) => /^GPU {7}p50 1\.5 {2}p95 6\.0 {2}p99 6\.2 {2}max 10\.6 ms {3}p95 is one frame long: a wait on the display, p50 is the work$/.test(l)));
    assert.ok(lines.length <= 30, "the card scrolls on a 412 px tall phone screen at 11 px type");
  });
});

describe("given the bench result of the Lab's throws (?bench=lab)", () => {
  test("when the card is written, then its second line names the throws in turn, how often and when they leave, that time was held at 1x, and how many the window saw; a race's card has no such line", () => {
    const lines = describeBench({ ...RESULT, course: "lab", cars: 4, cops: null, labThrown: 4 });
    assert.match(lines[0]!, /^CRUSH BENCH {2}lab {2}4 cars/);
    const line = lines[1]!;
    const lab = benchPlan("?bench=lab")!.lab!;
    assert.ok(line.startsWith("lab: "), line);
    let from = 0;
    for (const t of lab.throws) {
      const at = line.indexOf(t.preset, from);
      assert.ok(at >= from, `${t.preset} is not named after the throw before it: ${line}`);
      assert.ok(line.slice(at).includes(`${t.along} m/s`) && line.slice(at).includes(`${t.up} m/s up`), `${t.preset}'s launch is not named: ${line}`);
      from = at + t.preset.length;
    }
    assert.ok(line.includes("held at 1x") && line.includes("4 thrown in the window"), line);
    assert.ok(!describeBench(RESULT).some((l) => l.startsWith("lab:")));
  });
});

describe("given the bench result of a page that asked for the Ultra arm (?ultra=1)", () => {
  test("when the card is written, then the fx A/B has an ultra row after high with its fps, gpu ms and draw calls; a card without the arm has no ultra row", () => {
    const lines = describeBench({ ...RESULT, abFx: { ...RESULT.abFx, ultra: { ...B(41, 3.2), calls: 655 } } });
    const at = lines.findIndex((l) => l.includes("high 48.0 fps"));
    assert.match(lines[at + 1]!, /^ +ultra 41\.0 fps, .*gpu 3\.2, 655 calls$/);
    assert.ok(!describeBench(RESULT).some((l) => l.includes("ultra ")));
  });
});
