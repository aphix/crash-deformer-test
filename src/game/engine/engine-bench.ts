import type * as THREE from "three";
import type { RaceCommand } from "../match/types.ts";
import type { Cinematics } from "../present/engine-cine.ts";
import { describePost, type FxTier } from "../present/engine-post.ts";
import type { DriverSeat } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { RaceDirector } from "./engine-race.ts";
import type { SimPacer } from "./sim-pace.ts";

/** The one bench: city, 16 racers, police, the player's car on autopilot (the camera follows it), seed 1. */
const BENCH = { course: "city", aiCount: 15, seed: 1, warmS: 20, measureS: 30, blockS: 3, paceCycles: 3, fxCycles: 2, settleFrames: 10 } as const;
/** Samples kept: far above any display rate, so the window always fits. */
const CAP = BENCH.measureS * 400;

/** The engine's protected parts the bench times, handed over by `EngineInput.benchParts`. */
export interface BenchParts {
  renderer: THREE.WebGLRenderer;
  cine: Pick<Cinematics, "render" | "tier">;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  race: Pick<RaceDirector, "phase" | "time" | "reseed" | "policeStats">;
  seat: DriverSeat;
  live(): readonly DeformableCar[];
}

/** What `runBench` drives: the real engine, by its public face. */
interface BenchEngine {
  readonly ready: Promise<void>;
  readonly pace: SimPacer;
  fadeScenes: boolean;
  toggleRace(): void;
  raceCommand(cmd: RaceCommand): void;
  advance(seconds: number, opts?: { frameDt?: number; render?: boolean }): void;
  start(): void;
  setFxTier(tier: FxTier): void;
  setFxAuto(): void;
  benchParts(): BenchParts;
}

interface Stat {
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
}

export interface BenchResult {
  course: string;
  /** Cars in play (racers, traffic, police), and what the police did: stakeouts parked, pursuits begun, the largest pack. */
  cars: number;
  cops: { stakeouts: number; pursuits: number; maxPack: number };
  /** Cars that were wrecks (`crashed`): mean over the window's frames, and at its end. */
  crashed: { mean: number; end: number };
  frames: number;
  wallS: number;
  fps: number;
  /** 1000 / the 99th-percentile frame interval: the rate of the slowest 1 % of frames. */
  fpsLow1: number;
  /** Mean fps of each third of the window (a falling row is the device throttling). */
  fpsThirds: [number, number, number];
  /** Frames drawn in each wall second of the window. */
  fpsPerSecond: number[];
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
  /** Frames the pacer stopped early, and the sim seconds it gave up (never stepped). */
  cutFrames: number;
  lostSimS: number;
  /** Share of the sampled frames the pacer ran at its coarse 1/120 s slice (`SimPacer` adaptive), %. */
  coarsePct: number;
  /** Race-clock seconds per wall second, %: below 100 the game runs slower than real time (the pacer's cuts, or the slow-motion). */
  simSpeedPct: number;
  calls: number;
  triangles: number;
  /** Share of the window's frames at each FX tier, % (the auto tier moves). */
  tierPct: Record<string, number>;
  setupMs: { options: number; start: number };
  settings: BenchSettings;
  /** The pacer pinned to 1/240 s and to 1/120 s in alternating blocks (same tier), then the FX tier alternated minimal / low / high. */
  abPace: { fine: Block; coarse: Block };
  abFx: { minimal: Block; low: Block; high: Block };
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

/** Frames per wall second from the frame intervals (ms): one count per full second. */
export function perSecond(intervals: ArrayLike<number>, n = intervals.length): number[] {
  const out: number[] = [];
  let acc = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    acc += intervals[i]!;
    count++;
    if (acc >= 1000) {
      out.push(Math.round((count * 1000) / acc));
      acc = 0;
      count = 0;
    }
  }
  return out;
}

const f1 = (v: number): string => v.toFixed(1);
const row = (label: string, s: Stat): string => `${label.padEnd(10)}p50 ${f1(s.p50)}  p95 ${f1(s.p95)}  p99 ${f1(s.p99)}  max ${f1(s.max)} ms`;
const gpuOf = (b: Block): string => (b.gpuMs === null ? "gpu n/a" : `gpu ${f1(b.gpuMs)}`);
const arm = (label: string, b: Block): string => `${label} ${f1(b.fps)} fps, sim ${Math.round(b.simSpeedPct)} %, ${Math.round(b.simMsPerSimS)} ms/sim-s, cpu ${f1(b.cpuMs)}, draw ${f1(b.drawMs)}, ${gpuOf(b)}`;

/** The results card's text, top line first: the numbers the owner reads off a screenshot. */
export function describeBench(r: BenchResult): string[] {
  const d = r.device;
  const s = r.settings;
  const tiers = Object.entries(r.tierPct).sort((a, b) => b[1] - a[1]).map(([t, p]) => `${t} ${Math.round(p)} %`).join(", ");
  return [
    `CRUSH BENCH  ${r.course}  ${r.cars} cars  ${f1(r.wallS)} s  ${r.frames} frames  (${d.browser})`,
    `${f1(r.fps)} FPS   1% low ${f1(r.fpsLow1)}   by thirds ${r.fpsThirds.map(f1).join(" / ")}`,
    `fps each second: ${r.fpsPerSecond.join(" ")}`,
    `SIM SPEED ${Math.round(r.simSpeedPct)} %   pacer cut ${r.cutFrames} of ${r.frames} frames, gave up ${f1(r.lostSimS)} sim-s   1/120 s steps in ${Math.round(r.coarsePct)} % of frames   wrecks: mean ${f1(r.crashed.mean)}, end ${r.crashed.end}`,
    row("frame", r.frameMs),
    row("CPU", r.cpuMs),
    row("  sim", r.simMs) + `   ${f1(r.stepsPerFrame)} steps/frame, ${r.msPerStep.toFixed(2)} ms/step, ${Math.round(r.simMsPerSimS)} ms per sim-second`,
    row("  draw", r.renderMs),
    r.gpuMs ? row("GPU", r.gpuMs) : "GPU       no timer query on this device",
    `draw ${r.calls} calls  ${Math.round(r.triangles / 1000)}k tris   cops: ${r.cops.stakeouts} stakeouts, ${r.cops.pursuits} pursuits, pack of ${r.cops.maxPack}`,
    `fx tier: ${tiers}${s.fxAuto ? " (auto)" : ""}   post chain at the top tier: ${s.post}`,
    `shadows ${s.shadows.enabled ? `${s.shadows.type} ${s.shadows.map}, ${s.shadows.casters} casters` : "off"}   pixel ratio ${s.pixelRatio} of device ${s.deviceRatio}, canvas ${s.canvas}, ${s.antialias ? "MSAA" : "no MSAA"}   fx density ${f1(s.fxDensity)}, cel ${s.celLook === null ? "auto" : f1(s.celLook)}`,
    `night ${s.night ? "on" : "off"}, wet ${s.wet ? "on" : "off"}, realism ${f1(s.realism)}, squash ${f1(s.squash)}, buckle ${f1(s.buckle)}, deform ${s.deformMode}`,
    `A/B pacer pinned: ${arm("1/240 s", r.abPace.fine)}`,
    `                  ${arm("1/120 s", r.abPace.coarse)}`,
    `A/B fx pinned: ${arm("minimal", r.abFx.minimal)}`,
    `               ${arm("low", r.abFx.low)}`,
    `               ${arm("high", r.abFx.high)}`,
    `load: options ${f1(r.setupMs.options)} ms, start ${f1(r.setupMs.start)} ms`,
    `${d.gpu}${d.gpuMasked ? "   [masked by the browser: not the real GPU]" : ""}`,
    `${d.cores} cores${d.memoryGB ? `, ${d.memoryGB} GB` : ""}  screen ${d.screen} @${d.dpr}  canvas ${d.canvas}  timer step ${f1(d.timerStepMs)} ms`,
  ];
}

// ponytail: executor form, the project's TS lib predates Promise.withResolvers.
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The clipboard, through the async API where the page is allowed it, else a hidden textarea. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** A text card over the canvas; `set` rewrites it while the bench runs, `done` swaps in the results and a button that copies the full details as JSON. */
function overlay(): { set(text: string): void; done(lines: string[], details: () => string): void } {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:8px;top:8px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;z-index:99999;padding:8px 10px;" +
    "background:rgba(8,10,14,.92);color:#e8f0ff;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;border-radius:8px;pointer-events:none";
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:0;white-space:pre-wrap";
  root.append(pre);
  document.body.append(root);
  return {
    set: (text) => void (pre.textContent = text),
    done: (lines, details) => {
      pre.textContent = lines.join("\n");
      root.style.pointerEvents = "auto";
      root.style.borderLeft = "4px solid #7ee787";
      const button = document.createElement("button");
      button.textContent = "Copy details (JSON)";
      button.style.cssText = "margin-top:6px;padding:6px 10px;font:inherit;border-radius:6px;border:1px solid #7ee787;background:#14301c;color:#e8f0ff";
      button.onclick = () => {
        void copyText(details()).then((ok) => void (button.textContent = ok ? "Copied" : "Copy failed: select the card text instead"));
      };
      root.append(button);
    },
  };
}

/** The smallest step `performance.now()` takes over a 25 ms spin (ms): the browser's timer resolution as this page sees it. */
function timerStep(): number {
  let min = Infinity;
  let prev = performance.now();
  const end = prev + 25;
  for (;;) {
    const now = performance.now();
    if (now !== prev) {
      min = Math.min(min, now - prev);
      prev = now;
    }
    if (now > end) break;
  }
  return min === Infinity ? 0 : min;
}

/** Per-frame scratch the patches below add to, read and zeroed by the frame loop. */
interface Tap {
  simMs: number;
  drawMs: number;
  /** Draws are wrapped in a GPU timer query while true. */
  timing: boolean;
  /** The block the queries belong to (0: the main window). */
  block: number;
  /** Blocks numbered so far (the A/B arms' blocks count up from 1, across both A/Bs). */
  blocks: number;
  /** Timer-query results (ms) once they land (a few frames late; up to 3 s), then every patch comes off. */
  finish(): Promise<{ block: number; ms: number }[]>;
}

/** Instance patches for the run only: the sim's time (`SimPacer.run`) and the draw's (`Cinematics.render`, with a GPU timer query). */
function tap(pace: SimPacer, parts: BenchParts): Tap {
  const { renderer, cine } = parts;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const queries: { q: WebGLQuery; block: number }[] = [];
  const run = pace.run;
  const render = cine.render;
  const t: Tap = {
    simMs: 0,
    drawMs: 0,
    timing: false,
    block: 0,
    blocks: 0,
    async finish() {
      const out: { block: number; ms: number }[] = [];
      const deadline = performance.now() + 3000;
      let pending = queries;
      while (pending.length && performance.now() < deadline) {
        await sleep(100);
        const disjoint = timer ? (gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean) : false;
        pending = pending.filter((e) => {
          if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) return true;
          if (!disjoint) out.push({ block: e.block, ms: (gl.getQueryParameter(e.q, gl.QUERY_RESULT) as number) / 1e6 });
          gl.deleteQuery(e.q);
          return false;
        });
      }
      pace.run = run;
      cine.render = render;
      renderer.info.autoReset = true;
      return out;
    },
  };
  pace.run = (...a: Parameters<SimPacer["run"]>): void => {
    const t0 = performance.now();
    run.apply(pace, a);
    t.simMs += performance.now() - t0;
  };
  cine.render = (...a: Parameters<Cinematics["render"]>): void => {
    const t0 = performance.now();
    const q = t.timing && timer ? gl.createQuery() : null;
    if (q) gl.beginQuery(timer!.TIME_ELAPSED_EXT, q);
    try {
      render.apply(cine, a);
    } finally {
      if (q) {
        gl.endQuery(timer!.TIME_ELAPSED_EXT);
        queries.push({ q, block: t.block });
      }
      t.drawMs += performance.now() - t0;
    }
  };
  renderer.info.autoReset = false;
  return t;
}

/** One frame the bench ran: the wall time since the last, and where the engine spent its own. */
interface Frame {
  now: number;
  dt: number;
  cpuMs: number;
  simMs: number;
  drawMs: number;
}

/** The last rAF stamp, so a frame's dt is the real interval wherever the caller picks the loop up. */
interface Beat {
  prev: number;
}

/** One rAF: hand the engine its measured wall time through `advance` (the loop's own `tickInner`), timed. */
async function frame(engine: BenchEngine, renderer: THREE.WebGLRenderer, t: Tap, beat: Beat): Promise<Frame> {
  const now = await nextFrame();
  const dt = Math.min(0.1, (now - beat.prev) / 1000);
  beat.prev = now;
  renderer.info.reset();
  t.simMs = t.drawMs = 0;
  const f0 = performance.now();
  engine.advance(dt, { frameDt: dt, render: true });
  return { now, dt, cpuMs: performance.now() - f0, simMs: t.simMs, drawMs: t.drawMs };
}

/** How many of the cars in play are wrecks. */
function wrecks(parts: BenchParts): number {
  let n = 0;
  for (const car of parts.live()) if (car.crashed) n++;
  return n;
}

/** One value per sampled frame. */
interface Samples {
  n: number;
  iv: Float64Array;
  cpu: Float64Array;
  sim: Float64Array;
  draw: Float64Array;
  steps: Float64Array;
  coarse: Float64Array;
  wrecks: Float64Array;
  calls: Float64Array;
  tris: Float64Array;
  tiers: Map<string, number>;
}

/** The window: what the pacer lost and the race clock covered while it ran. */
interface Window {
  wallS: number;
  lostSimS: number;
  cutFrames: number;
  clockS: number;
}

/** The grid and the warm-up: frames with no samples until `warmS` of race clock has run. */
async function lead(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, ui: { set(text: string): void }): Promise<void> {
  const { renderer, race } = parts;
  for (;;) {
    await frame(engine, renderer, t, beat);
    if (race.phase === "racing" && race.time >= BENCH.warmS) return;
    ui.set(`CRUSH BENCH: ${race.phase === "racing" ? `warming ${Math.round(race.time)} / ${BENCH.warmS} s` : "grid"}`);
  }
}

/** `measureS` wall seconds of one sample per frame, the engine's own auto FX tier and pacer as they are. */
async function sample(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, ui: { set(text: string): void }): Promise<{ s: Samples; w: Window }> {
  const { renderer, race, cine } = parts;
  const arr = (): Float64Array => new Float64Array(CAP);
  const s: Samples = { n: 0, iv: arr(), cpu: arr(), sim: arr(), draw: arr(), steps: arr(), coarse: arr(), wrecks: arr(), calls: arr(), tris: arr(), tiers: new Map() };
  const pace = engine.pace;
  const lost0 = pace.lost;
  const cut0 = pace.cut;
  const clock0 = race.time;
  let wall = 0;
  t.timing = true;
  t.block = 0;
  while (wall < BENCH.measureS && s.n < CAP) {
    const f = await frame(engine, renderer, t, beat);
    const i = s.n++;
    wall += f.dt;
    s.iv[i] = f.dt * 1000;
    s.cpu[i] = f.cpuMs;
    s.sim[i] = f.simMs;
    s.draw[i] = f.drawMs;
    s.steps[i] = pace.steps;
    s.coarse[i] = pace.coarse ? 1 : 0;
    s.wrecks[i] = wrecks(parts);
    s.calls[i] = renderer.info.render.calls;
    s.tris[i] = renderer.info.render.triangles;
    s.tiers.set(cine.tier, (s.tiers.get(cine.tier) ?? 0) + 1);
    ui.set(`CRUSH BENCH: measuring ${Math.round(wall)} / ${BENCH.measureS} s`);
  }
  t.timing = false;
  return { s, w: { wallS: wall, lostSimS: pace.lost - lost0, cutFrames: pace.cut - cut0, clockS: race.time - clock0 } };
}

/** Sums over the frames of one arm (all its blocks). */
interface Acc {
  frames: number;
  wallS: number;
  clockS: number;
  sim: number;
  cpu: number;
  draw: number;
  steps: number;
  gpu: number[];
}

const emptyAcc = (): Acc => ({ frames: 0, wallS: 0, clockS: 0, sim: 0, cpu: 0, draw: 0, steps: 0, gpu: [] });

function toBlock(a: Acc): Block {
  const n = Math.max(1, a.frames);
  return {
    frames: a.frames,
    wallS: a.wallS,
    fps: a.wallS ? a.frames / a.wallS : 0,
    simSpeedPct: a.wallS ? (100 * a.clockS) / a.wallS : 0,
    simMsPerSimS: a.clockS ? a.sim / a.clockS : 0,
    msPerStep: a.steps ? a.sim / a.steps : 0,
    stepsPerFrame: a.steps / n,
    cpuMs: a.cpu / n,
    drawMs: a.draw / n,
    gpuMs: a.gpu.length ? a.gpu.reduce((x, y) => x + y, 0) / a.gpu.length : null,
  };
}

/** One setting of an A/B: `set` flips it before its block. */
interface Arm {
  key: string;
  set(): void;
}

/**
 * The arms in turn, `cycles` times round, each for `blockS` wall seconds after `settleFrames` unscored frames: the race
 * drifts under every arm alike, so the arms are compared on the same stretch. Returns each arm's sums and which arm each timer
 * query block (numbered from 1) belonged to.
 */
async function alternate(
  engine: BenchEngine,
  parts: BenchParts,
  t: Tap,
  beat: Beat,
  ui: { set(text: string): void },
  title: string,
  arms: Arm[],
  cycles: number,
): Promise<{ accs: Map<string, Acc>; blockKeys: Map<number, string> }> {
  const { renderer, race } = parts;
  const accs = new Map(arms.map((a) => [a.key, emptyAcc()]));
  const blockKeys = new Map<number, string>();
  for (let c = 0; c < cycles; c++) {
    for (const a of arms) {
      a.set();
      t.timing = false;
      for (let i = 0; i < BENCH.settleFrames; i++) await frame(engine, renderer, t, beat);
      t.block = ++t.blocks;
      blockKeys.set(t.block, a.key);
      t.timing = true;
      const acc = accs.get(a.key)!;
      const clock0 = race.time;
      let wall = 0;
      while (wall < BENCH.blockS) {
        const f = await frame(engine, renderer, t, beat);
        wall += f.dt;
        acc.frames++;
        acc.sim += f.simMs;
        acc.cpu += f.cpuMs;
        acc.draw += f.drawMs;
        acc.steps += engine.pace.steps;
        ui.set(`CRUSH BENCH: ${title} ${a.key}, round ${c + 1} / ${cycles}`);
      }
      acc.wallS += wall;
      acc.clockS += race.time - clock0;
    }
  }
  t.timing = false;
  return { accs, blockKeys };
}

/** What was switched on, read off the renderer, the sun and the HUD's own state. */
function settingsOf(parts: BenchParts, hud: Record<string, unknown>, top: string): BenchSettings {
  const { renderer, scene, sun } = parts;
  const size = renderer.domElement;
  let casters = 0;
  scene.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh && o.castShadow) casters++;
  });
  return {
    fxTier: parts.cine.tier,
    fxAuto: hud["fxAuto"] === true,
    post: describePost(top as FxTier),
    fxDensity: Number(hud["fxDensity"]),
    celLook: typeof hud["celLook"] === "number" ? hud["celLook"] : null,
    shadows: { enabled: renderer.shadowMap.enabled, type: ["Basic", "PCF", "PCFSoft", "VSM"][renderer.shadowMap.type] ?? String(renderer.shadowMap.type), map: `${sun.shadow.mapSize.x}x${sun.shadow.mapSize.y}`, casters },
    pixelRatio: renderer.getPixelRatio(),
    deviceRatio: Math.round(devicePixelRatio * 1000) / 1000,
    canvas: `${size.width}x${size.height}`,
    antialias: renderer.getContext().getContextAttributes()?.antialias === true,
    toneMapping: renderer.toneMapping,
    night: hud["night"] === true,
    wet: hud["wet"] === true,
    realism: Number(hud["realism"]),
    squash: Number(hud["squash"]),
    buckle: Number(hud["buckle"]),
    deformMode: String(hud["deformMode"]),
  };
}

function summarize(parts: BenchParts, s: Samples, w: Window, gpu: number[], setupMs: BenchResult["setupMs"]): Omit<BenchResult, "settings" | "abPace" | "abFx" | "device"> {
  const { race } = parts;
  const { n, iv } = s;
  const third = Math.floor(n / 3);
  const fpsOf = (a: number, b: number): number => {
    let sum = 0;
    for (let i = a; i < b; i++) sum += iv[i]!;
    return b > a ? (1000 * (b - a)) / sum : 0;
  };
  const frameMs = stat(iv, n);
  const simMs = stat(s.sim, n);
  let stepSum = 0;
  let simSum = 0;
  for (let i = 0; i < n; i++) {
    stepSum += s.steps[i]!;
    simSum += s.sim[i]!;
  }
  return {
    course: BENCH.course,
    cars: parts.live().length,
    cops: { ...race.policeStats! },
    crashed: { mean: stat(s.wrecks, n).mean, end: wrecks(parts) },
    frames: n,
    wallS: w.wallS,
    fps: fpsOf(0, n),
    fpsLow1: frameMs.p99 ? 1000 / frameMs.p99 : 0,
    fpsThirds: [fpsOf(0, third), fpsOf(third, 2 * third), fpsOf(2 * third, n)],
    fpsPerSecond: perSecond(iv, n),
    frameMs,
    cpuMs: stat(s.cpu, n),
    simMs,
    renderMs: stat(s.draw, n),
    gpuMs: gpu.length ? stat(gpu) : null,
    stepsPerFrame: n ? stepSum / n : 0,
    msPerStep: stepSum ? simSum / stepSum : 0,
    simMsPerSimS: w.clockS ? simSum / w.clockS : 0,
    cutFrames: w.cutFrames,
    lostSimS: w.lostSimS,
    coarsePct: n ? 100 * stat(s.coarse, n).mean : 0,
    simSpeedPct: w.wallS ? (100 * w.clockS) / w.wallS : 0,
    calls: stat(s.calls, n).p50,
    triangles: stat(s.tris, n).p50,
    tierPct: Object.fromEntries([...s.tiers].map(([tier, count]) => [tier, (100 * count) / Math.max(1, n)])),
    setupMs,
  };
}

/** The device, as this page sees it. */
async function deviceOf(parts: BenchParts, timerStepMs: number): Promise<BenchResult["device"]> {
  const { renderer } = parts;
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown GPU";
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const brave = await (navigator as Navigator & { brave?: { isBrave(): Promise<boolean> } }).brave?.isBrave().catch(() => false);
  return {
    browser: browserName(navigator.userAgent) + (brave ? " (Brave)" : ""),
    userAgent: navigator.userAgent,
    gpu,
    gpuMasked: /\bor similar\b/i.test(gpu),
    cores: navigator.hardwareConcurrency,
    memoryGB: mem ?? null,
    screen: `${screen.width}x${screen.height}`,
    dpr: Math.round(devicePixelRatio * 1000) / 1000,
    canvas: `${renderer.domElement.width}x${renderer.domElement.height}`,
    timerStepMs,
  };
}

/** The arms' sums with the timer-query times of their blocks folded in, as blocks. */
function blocksOf(r: { accs: Map<string, Acc>; blockKeys: Map<number, string> }, gpu: { block: number; ms: number }[]): Record<string, Block> {
  for (const g of gpu) {
    const key = r.blockKeys.get(g.block);
    if (key !== undefined) r.accs.get(key)!.gpu.push(g.ms);
  }
  return Object.fromEntries([...r.accs].map(([key, acc]) => [key, toBlock(acc)]));
}

/**
 * `?bench=city`: the real game on the real clock for a fixed run, then a card of what it cost. The engine's own loop is
 * stopped and each rAF hands the engine its measured wall time through `advance` (the same `tickInner` the loop runs,
 * the pacer's real 8 ms deadline included), so a frame is timed, not simulated. Sequence: the race is set up, runs its
 * grid and `warmS` of race clock (the police park from a third of a lap on), then `measureS` wall seconds are sampled with
 * the game's own settings (auto FX tier, adaptive pacer). Then, on the same race, the pacer is pinned to 1/240 s and to
 * 1/120 s in alternating blocks, and the FX tier to minimal, low and high in alternating blocks, each arm scored the same
 * way. Afterwards the settings go back to automatic, the loop restarts and the race plays on under the card.
 * `hud` reads the HUD's state (every setting the player can change).
 */
export async function runBench(engine: BenchEngine, hud: () => object): Promise<BenchResult> {
  const ui = overlay();
  ui.set("CRUSH BENCH: loading…");
  const timerStepMs = timerStep();
  await engine.ready;
  const parts = engine.benchParts();
  parts.renderer.setAnimationLoop(null);
  engine.fadeScenes = false;
  engine.toggleRace();
  const t0 = performance.now();
  engine.raceCommand({ type: "options", options: { trackId: BENCH.course, laps: 9, aiCount: BENCH.aiCount, police: true, aggression: 1, spectate: false, noReset: false } });
  const t1 = performance.now();
  parts.race.reseed(BENCH.seed);
  engine.raceCommand({ type: "start" });
  const setupMs = { options: t1 - t0, start: performance.now() - t1 };
  parts.seat.mode = "follow";

  const t = tap(engine.pace, parts);
  const beat: Beat = { prev: await nextFrame() };
  await lead(engine, parts, t, beat, ui);
  const { s, w } = await sample(engine, parts, t, beat, ui);
  const top = [...s.tiers].sort((a, b) => b[1] - a[1])[0]?.[0] ?? parts.cine.tier;
  const settings = settingsOf(parts, hud() as Record<string, unknown>, top);

  // The A/Bs hold the tier the window mostly ran, so the pacer arms differ in the pacer alone.
  engine.setFxTier(top as FxTier);
  const pace = await alternate(engine, parts, t, beat, ui, "pacer", [{ key: "fine", set: () => void (engine.pace.pin = false) }, { key: "coarse", set: () => void (engine.pace.pin = true) }], BENCH.paceCycles);
  engine.pace.pin = null;
  const fx = await alternate(engine, parts, t, beat, ui, "fx", (["minimal", "low", "high"] as const).map((tier) => ({ key: tier, set: () => engine.setFxTier(tier) })), BENCH.fxCycles);
  engine.setFxAuto();

  const gpu = await t.finish();
  const abPace = blocksOf(pace, gpu);
  const abFx = blocksOf(fx, gpu);
  const device = await deviceOf(parts, timerStepMs);
  const result: BenchResult = {
    ...summarize(parts, s, w, gpu.filter((g) => g.block === 0).map((g) => g.ms), setupMs),
    settings,
    abPace: { fine: abPace["fine"]!, coarse: abPace["coarse"]! },
    abFx: { minimal: abFx["minimal"]!, low: abFx["low"]!, high: abFx["high"]! },
    device,
  };
  const details = (): string => JSON.stringify({ at: new Date().toISOString(), url: location.href, userAgent: navigator.userAgent, hud: hud(), result }, null, 1);
  ui.done(describeBench(result), details);
  (window as unknown as { __benchResult?: BenchResult }).__benchResult = result;
  console.log("CRUSH BENCH", JSON.stringify(result));
  engine.start();
  return result;
}
