import { describeDepthProbe, type DepthProbe } from "../present/depth-probe.ts";
import { FX_TIER_ULTRA } from "../present/constants.ts";
import { labLine, stripLines, type StripResult } from "./engine-bench-plan.ts";

/** The detail A/B's arms: no cuts at all, then the ladder's rungs for 75, 50 and 30 m (`DETAIL_LEVELS`). */
export const DETAIL_ARMS: readonly { key: string; level: number | null }[] = [{ key: "off", level: null }, { key: "75 m", level: 0 }, { key: "50 m", level: 2 }, { key: "30 m", level: 4 }];

export interface Stat {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** A stretch of frames under one setting (the A/B arms): what it cost and gave. */
export interface Block {
  frames: number;
  wallS: number;
  fps: number;
  /** Race-clock seconds per wall second, %. */
  simSpeedPct: number;
  /** Wall ms of sim per race-clock second: the cost of a second of the game whatever the step. */
  simMsPerSimS: number;
  msPerStep: number;
  stepsPerFrame: number;
  cpuMs: number;
  drawMs: number;
  /** Mean draw time on the GPU (timer query), null where the device has none. */
  gpuMs: number | null;
  /** Steps cut to the pacer's fine slice for a hit about to land (`World.fineCuts`), per race-clock second. */
  fineCutsPerSimS: number;
  /** Draw calls and triangles of a frame, mean (`renderer.info`: the whole frame, the post chain's passes included). */
  calls: number;
  triangles: number;
}

/** What was switched on while the bench ran. */
export interface BenchSettings {
  fxTier: string;
  fxAuto: boolean;
  /** `describePost` of the tier the window mostly ran. */
  post: string;
  fxDensity: number;
  celLook: number | null;
  shadows: { enabled: boolean; type: string; map: string; casters: number };
  pixelRatio: number;
  deviceRatio: number;
  canvas: string;
  antialias: boolean;
  toneMapping: number;
  night: boolean;
  wet: boolean;
  realism: number;
  squash: number;
  buckle: number;
  deformMode: string;
  depth: { bits: number; subpixelBits: number; contextDepth: boolean; fragmentHighFloat: { precision: number; rangeMin: number; rangeMax: number } | null; near: number; far: number; logarithmicDepthBuffer: boolean; probe: DepthProbe };
}

/** The stretches of a run in order: the grid and warm-up, the sampled window, the three A/Bs, then the replay of the run's own crash (`PAGE_PHASES[PHASE_WARM]` ...). */
export const PAGE_PHASES = ["warm", "window", "ab-pace", "ab-detail", "ab-fx", "replay"] as const;
export const PHASE_WARM = 0;
export const PHASE_WINDOW = 1;
export const PHASE_AB_PACE = 2;
export const PHASE_AB_DETAIL = 3;
export const PHASE_AB_FX = 4;
export const PHASE_REPLAY = 5;

/** Mean and 95th percentile of one reading (ms). */
export interface Pair {
  mean: number;
  p95: number;
}

/**
 * The cosmetic Rapier world's cost over a stretch of frames (`RagdollSystem.stats`): `world.step()` calls, their ms, and the world's size
 * at the end of it. `steps` 0 is a world with nothing to move (no dummy thrown, no prop knocked): its steps cost nothing.
 */
export interface RagdollCost {
  steps: number;
  stepMs: Pair;
  colliders: number;
  bodies: number;
}

/** One FX tier's stretch of the replay: the frames the reel drew at it, and what they cost. */
export interface ReplayTier {
  frames: number;
  wallS: number;
  fps: number;
  /** 1000 / the 99th-percentile frame interval. */
  fpsLow1: number;
  frameMs: Pair;
  cpuMs: Pair;
  simMs: Pair;
  renderMs: Pair;
  /** Mean draw time on the GPU (timer query), null where the device has none. */
  gpuMs: number | null;
  ragdoll: RagdollCost;
}

/**
 * The run's own crash played back as a highlight reel (docs/PERF_BENCH.md): the clip this run recorded of two racers put head-on at the
 * start line, replayed `tierS` wall seconds at each FX tier in turn.
 */
export interface ReplayResult {
  /** Wall seconds measured at each tier (after a settle). */
  tierS: number;
  /** The clip: its size on the wire (bytes, deflated), the cars it carries, the drivers thrown in it, and its recorded length (steps). */
  clip: { bytes: number; cars: number; ejections: number; steps: number };
  tiers: Record<string, ReplayTier>;
}

/** The page's state `atS` seconds into `phase` (`BenchResult.pageEvents`). */
export interface PageEvent {
  phase: (typeof PAGE_PHASES)[number];
  atS: number;
  visible: boolean;
  focused: boolean;
  fullscreen: boolean;
}

export interface BenchResult {
  course: string;
  /** The commit the page was built from ("dev": built without git). */
  build: string;
  /** Cars in play (racers, traffic, police), and what the police did: stakeouts parked, pursuits begun, the largest pack. */
  cars: number;
  cops: { stakeouts: number; pursuits: number; maxPack: number } | null;
  /** Cars that were wrecks (`crashed`): mean over the window's frames, and at its end. */
  crashed: { mean: number; end: number };
  frames: number;
  wallS: number;
  fps: number;
  /** 1000 / the 99th-percentile frame interval: the rate of the slowest 1 % of frames. */
  fpsLow1: number;
  /** Mean fps of each third of the window (a falling row is the device throttling). */
  fpsThirds: [number, number, number];
  /** Frames drawn in each wall second of the window, and the sim's ms (`SimPacer.run`: physics, AI, breakage) in each. */
  fpsPerSecond: number[];
  simMsPerSecond: number[];
  /** Frame interval (rAF to rAF), ms. */
  frameMs: Stat;
  /** Main-thread time inside the engine's frame, ms (sim + AI + skins + fx + draw submission). */
  cpuMs: Stat;
  /** Of it: the sim steps (`SimPacer.run`: physics, AI, breakage), and the draw (`Cinematics.render`). */
  simMs: Stat;
  renderMs: Stat;
  /** Draw time on the GPU (timer query), null where the device has none. */
  gpuMs: Stat | null;
  stepsPerFrame: number;
  msPerStep: number;
  /** Wall ms of sim per race-clock second. */
  simMsPerSimS: number;
  /** Steps cut to the pacer's fine slice for a hit about to land (`World.fineCuts`), per race-clock second. */
  fineCutsPerSimS: number;
  /** Frames the pacer stopped early, and the sim seconds it gave up (never stepped). */
  cutFrames: number;
  lostSimS: number;
  /** Share of the sampled frames the pacer ran at its coarse 1/120 s slice (`SimPacer` adaptive), %. */
  coarsePct: number;
  /** Sim seconds per wall second, %: below 100 the game runs slower than real time (the pacer's cuts, or the slow-motion). */
  simSpeedPct: number;
  /** The strip bench's settings and how far up the straight the lead racer got (null: the city bench). */
  strip: StripResult | null;
  /** The Lab bench's throws the window saw (null: a race bench). */
  labThrown: number | null;
  calls: number;
  triangles: number;
  /** Share of the window's frames at each FX tier, % (the auto tier moves). */
  tierPct: Record<string, number>;
  /** Share of the window's frames at each distance-detail rung, % (keyed by the distance beyond which only the body is drawn; the governor moves it). */
  detailPct: Record<string, number>;
  setupMs: { options: number; start: number };
  /**
   * The page's state over the run, from the warm-up to the end of the replay: one entry as each phase begins and one at every change
   * (`atS`: seconds into that entry's phase): shown on screen (not a background tab), the window focused, fullscreen. A hidden or
   * unfocused page is throttled by the browser, so frames in those spans are not the device's speed.
   */
  pageEvents: PageEvent[];
  settings: BenchSettings;
  /** The pacer pinned to 1/240 s and to 1/120 s in alternating blocks (same tier), then the FX tier alternated minimal / low / high (and ultra when the page asked: `&ultra=1`). */
  abPace: { fine: Block; coarse: Block };
  abFx: { minimal: Block; low: Block; high: Block; ultra?: Block };
  /** The distance detail pinned: no cuts, then the rungs for 75, 50 and 30 m (the governor off, the FX tier held). */
  abDetail: Record<string, Block>;
  /** The cosmetic Rapier world (the thrown drivers' and knocked props'): `world.step()` over the sampled window, and the world's size. */
  ragdoll: RagdollCost;
  /** The run's own crash replayed as a highlight at each FX tier (null: no clip, `replayWhy` says why). */
  replay: ReplayResult | null;
  replayWhy: string | null;
  device: {
    browser: string;
    userAgent: string;
    gpu: string;
    /** The browser reports a generic GPU ("… or similar"): the name is not the machine's. */
    gpuMasked: boolean;
    cores: number;
    memoryGB: number | null;
    screen: string;
    dpr: number;
    canvas: string;
    /** The smallest step `performance.now()` took in a 25 ms spin, ms (browsers round it to 0.1, 1 or 16.7 ms). */
    timerStepMs: number;
  };
}

/** Mean and percentiles of the first `n` values (order-free). */
export function stat(values: ArrayLike<number>, n = values.length): Stat {
  const s = Float64Array.from({ length: n }, (_, i) => values[i]!).sort();
  let sum = 0;
  for (const v of s) sum += v;
  const at = (p: number): number => s[Math.min(n - 1, Math.floor(p * n))] ?? 0;
  return { mean: n ? sum / n : 0, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: n ? s[n - 1]! : 0 };
}

const BROWSERS: [string, RegExp][] = [
  ["Edge", /Edg\/([\d.]+)/],
  ["Opera", /OPR\/([\d.]+)/],
  ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
  ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
  ["Safari", /Version\/([\d.]+).*Safari/],
];

/** The browser and its major version from a user agent string. */
export function browserName(ua: string): string {
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]!.split(".")[0]}`;
  }
  return "unknown browser";
}

/**
 * Per full wall second of the frame intervals (ms): the frames drawn, and the ms of `work` (one value per frame,
 * e.g. the sim's time) spent in it; both scaled to an exact 1000 ms. A partial last second is dropped.
 */
export function perSecond(intervals: ArrayLike<number>, work: ArrayLike<number>, n = intervals.length): { fps: number[]; workMs: number[] } {
  const fps: number[] = [];
  const workMs: number[] = [];
  let acc = 0;
  let busy = 0;
  let count = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    acc += intervals[i]!;
    busy += work[i]!;
    count++;
    if (acc >= 1000) {
      fps[k] = Math.round((count * 1000) / acc);
      workMs[k++] = Math.round((busy * 1000) / acc);
      acc = busy = count = 0;
    }
  }
  return { fps, workMs };
}

const f1 = (v: number): string => v.toFixed(1);
const row = (label: string, s: Stat): string => `${label.padEnd(10)}p50 ${f1(s.p50)}  p95 ${f1(s.p95)}  p99 ${f1(s.p99)}  max ${f1(s.max)} ms`;
/** The GPU timer spans the draw, so a wait inside it (the display's back buffer, another process) counts: a p95 within 15 % of a frame's length is that wait, and p50 is the work. */
const waited = (gpu: Stat, frame: Stat): boolean => gpu.p95 >= 0.85 * frame.p50 && gpu.p95 <= 1.15 * frame.p50;
const gpuOf = (b: Block): string => (b.gpuMs === null ? "gpu n/a" : `gpu ${f1(b.gpuMs)}`);
const arm = (label: string, b: Block): string => `${label} ${f1(b.fps)} fps, sim ${Math.round(b.simSpeedPct)} %, ${Math.round(b.simMsPerSimS)} ms/sim-s, cpu ${f1(b.cpuMs)}, draw ${f1(b.drawMs)}, ${gpuOf(b)}, ${Math.round(b.calls)} calls`;
const pair = (p: Pair): string => `${f1(p.mean)}/${f1(p.p95)}`;
const ragdollLine = (g: RagdollCost): string => `ragdoll world: ${g.steps} steps, step ${g.stepMs.mean.toFixed(2)} ms mean / ${g.stepMs.p95.toFixed(2)} p95, ${g.colliders} colliders, ${g.bodies} bodies`;
/** The replay's lines: the clip and a row per FX tier (mean/p95 ms), or why there is none. */
const replayLines = (r: ReplayResult | null, why: string | null): string[] =>
  r === null
    ? [`replay: none (${why ?? "no reason given"})`]
    : [
        `replay of this run's crash: ${r.clip.cars} cars, ${r.clip.ejections} thrown, ${Math.round(r.clip.bytes / 1024)} KB clip, ${r.tierS} s per tier (mean/p95 ms)`,
        ...Object.entries(r.tiers).map(
          ([tier, t]) => `  ${tier.padEnd(8)}${f1(t.fps)} fps, 1% low ${f1(t.fpsLow1)}, frame ${pair(t.frameMs)}, cpu ${pair(t.cpuMs)}, sim ${pair(t.simMs)}, draw ${pair(t.renderMs)}, ${t.gpuMs === null ? "gpu n/a" : `gpu ${f1(t.gpuMs)}`}, ragdoll step ${t.ragdoll.stepMs.mean.toFixed(2)}/${t.ragdoll.stepMs.p95.toFixed(2)} (${t.ragdoll.steps} steps)`,
        ),
      ];

/** The results card's text, top line first: the numbers the owner reads off a screenshot. */
export function describeBench(r: BenchResult): string[] {
  const d = r.device;
  const s = r.settings;
  const tiers = Object.entries(r.tierPct).sort((a, b) => b[1] - a[1]).map(([t, p]) => `${t} ${Math.round(p)} %`).join(", ");
  return [
    `CRUSH BENCH  ${r.course}  ${r.cars} cars  ${f1(r.wallS)} s  ${r.frames} frames  (${d.browser})  build ${r.build}`,
    ...(r.strip ? stripLines(r.strip) : []),
    ...(r.labThrown !== null ? [labLine(r.labThrown)] : []),
    `${f1(r.fps)} FPS   1% low ${f1(r.fpsLow1)}   by thirds ${r.fpsThirds.map(f1).join(" / ")}`,
    `fps each second: ${r.fpsPerSecond.join(" ")}`,
    `sim ms each second: ${r.simMsPerSecond.join(" ")}`,
    `SIM SPEED ${Math.round(r.simSpeedPct)} %   pacer cut ${r.cutFrames} of ${r.frames} frames, gave up ${f1(r.lostSimS)} sim-s   1/120 s steps in ${Math.round(r.coarsePct)} % of frames   wrecks: mean ${f1(r.crashed.mean)}, end ${r.crashed.end}`,
    row("frame", r.frameMs),
    row("CPU", r.cpuMs),
    row("  sim", r.simMs) + `   ${f1(r.stepsPerFrame)} steps/frame, ${r.msPerStep.toFixed(2)} ms/step, ${Math.round(r.simMsPerSimS)} ms per sim-second, ${f1(r.fineCutsPerSimS)} fine-slice cuts/sim-s`,
    row("  draw", r.renderMs),
    r.gpuMs ? row("GPU", r.gpuMs) + (waited(r.gpuMs, r.frameMs) ? "   p95 is one frame long: a wait on the display, p50 is the work" : "") : "GPU       no timer query on this device",
    ragdollLine(r.ragdoll),
    `draw ${r.calls} calls  ${Math.round(r.triangles / 1000)}k tris   cops: ${r.cops ? `${r.cops.stakeouts} stakeouts, ${r.cops.pursuits} pursuits, pack of ${r.cops.maxPack}` : "none"}`,
    `fx tier: ${tiers}${s.fxAuto ? " (auto)" : ""}   post chain at the top tier: ${s.post}`,
    `detail: only the body drawn beyond ${Object.entries(r.detailPct).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} for ${Math.round(v)} %`).join(", ")} of the window`,
    `shadows ${s.shadows.enabled ? `${s.shadows.type} ${s.shadows.map}, ${s.shadows.casters} casters` : "off"}   pixel ratio ${s.pixelRatio} of device ${s.deviceRatio}, canvas ${s.canvas}, ${s.antialias ? "MSAA" : "no MSAA"}   fx density ${f1(s.fxDensity)}, cel ${s.celLook === null ? "auto" : f1(s.celLook)}`,
    `night ${s.night ? "on" : "off"}, wet ${s.wet ? "on" : "off"}, realism ${f1(s.realism)}, squash ${f1(s.squash)}, buckle ${f1(s.buckle)}, deform ${s.deformMode}`,
    `depth: ${s.depth.bits} bits (drawing buffer${s.depth.contextDepth ? "" : ", none requested"}), subpixel ${s.depth.subpixelBits} bits, fragment highp ${s.depth.fragmentHighFloat ? `${s.depth.fragmentHighFloat.precision} bits, range 2^${s.depth.fragmentHighFloat.rangeMin}..2^${s.depth.fragmentHighFloat.rangeMax}` : "not supported"}, camera near ${s.depth.near} far ${s.depth.far}, log depth ${s.depth.logarithmicDepthBuffer ? "on" : "off"}, ${describeDepthProbe(s.depth.probe)}`,
    `A/B pacer pinned: ${arm("1/240 s", r.abPace.fine)}, ${f1(r.abPace.fine.fineCutsPerSimS)} fine-slice cuts/sim-s`,
    `                  ${arm("1/120 s", r.abPace.coarse)}, ${f1(r.abPace.coarse.fineCutsPerSimS)} fine-slice cuts/sim-s`,
    `A/B fx pinned: ${arm("minimal", r.abFx.minimal)}`,
    `               ${arm("low", r.abFx.low)}`,
    `               ${arm("high", r.abFx.high)}`,
    ...(r.abFx.ultra ? [`               ${arm(FX_TIER_ULTRA, r.abFx.ultra)}`] : []),
    ...DETAIL_ARMS.map((a, i) => `${i ? "                   " : "A/B detail pinned: "}${arm(a.key === "off" ? "no cuts" : `body beyond ${a.key}`, r.abDetail[a.key]!)}`),
    ...replayLines(r.replay, r.replayWhy),
    `load: options ${f1(r.setupMs.options)} ms, start ${f1(r.setupMs.start)} ms`,
    `${d.gpu}${d.gpuMasked ? "   [masked by the browser: not the real GPU]" : ""}`,
    `${d.cores} cores${d.memoryGB ? `, ${d.memoryGB} GB` : ""}  screen ${d.screen} @${d.dpr}  canvas ${d.canvas}  timer step ${f1(d.timerStepMs)} ms`,
  ];
}
