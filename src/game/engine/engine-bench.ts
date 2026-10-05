import type * as THREE from "three";
import type { RaceCommand } from "../match/types.ts";
import type { Cinematics } from "../present/engine-cine.ts";
import type { DriverSeat } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { RaceDirector } from "./engine-race.ts";
import type { SimPacer } from "./sim-pace.ts";

/** The one bench: city, 16 racers, police, the player's car on autopilot (the camera follows it), seed 1. */
const BENCH = { course: "city", aiCount: 15, seed: 1, warmS: 20, measureS: 30 } as const;
/** Samples kept: far above any display rate, so the window always fits. */
const CAP = BENCH.measureS * 400;

/** The engine's protected parts the bench times, handed over by `EngineInput.benchParts`. */
export interface BenchParts {
  renderer: THREE.WebGLRenderer;
  cine: Pick<Cinematics, "render" | "tier">;
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
  benchParts(): BenchParts;
}

interface Stat {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface BenchResult {
  course: string;
  /** Cars in play (racers, traffic, police), and what the police did: stakeouts parked, pursuits begun, the largest pack. */
  cars: number;
  cops: { stakeouts: number; pursuits: number; maxPack: number };
  frames: number;
  wallS: number;
  fps: number;
  /** 1000 / the 99th-percentile frame interval: the rate of the slowest 1 % of frames. */
  fpsLow1: number;
  /** Mean fps of each third of the window (a falling row is the device throttling). */
  fpsThirds: [number, number, number];
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
  /** Frames the pacer stopped early, and the sim seconds it gave up (never stepped). */
  cutFrames: number;
  lostSimS: number;
  /** Share of the sampled frames the pacer ran at its coarse 1/120 s slice (`SimPacer` adaptive), %. */
  coarsePct: number;
  /** Race-clock seconds per wall second, %: below 100 the game runs slower than real time (the pacer's cuts, or the slow-motion). */
  simSpeedPct: number;
  calls: number;
  triangles: number;
  setupMs: { options: number; start: number };
  device: { gpu: string; cores: number; memoryGB: number | null; screen: string; dpr: number; ratio: number; canvas: string; tier: string };
}

/** Mean and percentiles of the first `n` values (order-free). */
export function stat(values: ArrayLike<number>, n = values.length): Stat {
  const s = Float64Array.from({ length: n }, (_, i) => values[i]!).sort();
  let sum = 0;
  for (const v of s) sum += v;
  const at = (p: number): number => s[Math.min(n - 1, Math.floor(p * n))] ?? 0;
  return { mean: n ? sum / n : 0, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: n ? s[n - 1]! : 0 };
}

const f1 = (v: number): string => v.toFixed(1);
const row = (label: string, s: Stat): string => `${label.padEnd(10)}p50 ${f1(s.p50)}  p95 ${f1(s.p95)}  p99 ${f1(s.p99)}  max ${f1(s.max)} ms`;

/** The results card's text, top line first: the numbers the owner reads off a screenshot. */
export function describeBench(r: BenchResult): string[] {
  const d = r.device;
  return [
    `CRUSH BENCH  ${r.course}  ${r.cars} cars  ${f1(r.wallS)} s  ${r.frames} frames`,
    `${f1(r.fps)} FPS   1% low ${f1(r.fpsLow1)}   by thirds ${r.fpsThirds.map(f1).join(" / ")}`,
    `SIM SPEED ${Math.round(r.simSpeedPct)} %   pacer cut ${r.cutFrames} of ${r.frames} frames, gave up ${f1(r.lostSimS)} sim-s   1/120 s steps in ${Math.round(r.coarsePct)} % of frames`,
    row("frame", r.frameMs),
    row("CPU", r.cpuMs),
    row("  sim", r.simMs) + `   ${f1(r.stepsPerFrame)} steps/frame, ${r.msPerStep.toFixed(2)} ms/step`,
    row("  draw", r.renderMs),
    r.gpuMs ? row("GPU", r.gpuMs) : "GPU       no timer query on this device",
    `draw ${r.calls} calls  ${Math.round(r.triangles / 1000)}k tris   cops: ${r.cops.stakeouts} stakeouts, ${r.cops.pursuits} pursuits, pack of ${r.cops.maxPack}`,
    `load: options ${f1(r.setupMs.options)} ms, start ${f1(r.setupMs.start)} ms`,
    `${d.gpu}`,
    `${d.cores} cores${d.memoryGB ? `, ${d.memoryGB} GB` : ""}  screen ${d.screen} @${d.dpr}  canvas ${d.canvas} (ratio ${d.ratio})  fx ${d.tier}`,
  ];
}

// ponytail: executor form, the project's TS lib predates Promise.withResolvers.
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A line of text over the canvas; `set` rewrites it, `done` swaps it for the card. */
function overlay(): { set(text: string): void; done(lines: string[]): void } {
  const el = document.createElement("pre");
  el.style.cssText =
    "position:fixed;left:8px;top:8px;margin:0;padding:8px 10px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;z-index:99999;" +
    "background:rgba(8,10,14,.92);color:#e8f0ff;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;border-radius:8px;white-space:pre-wrap;pointer-events:none";
  document.body.append(el);
  return {
    set: (text) => void (el.textContent = text),
    done: (lines) => {
      el.textContent = lines.join("\n");
      el.style.pointerEvents = "auto";
      el.style.borderLeft = "4px solid #7ee787";
    },
  };
}

/** Per-frame scratch the patches below add to, read and zeroed by the frame loop. */
interface Tap {
  simMs: number;
  drawMs: number;
  /** Draws are wrapped in a GPU timer query while true (the measured window only). */
  timing: boolean;
  /** Timer-query results (ms) once they land (a few frames late; up to 3 s), then every patch comes off. */
  finish(): Promise<number[]>;
}

/** Instance patches for the run only: the sim's time (`SimPacer.run`) and the draw's (`Cinematics.render`, with a GPU timer query). */
function tap(pace: SimPacer, parts: BenchParts): Tap {
  const { renderer, cine } = parts;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const queries: WebGLQuery[] = [];
  const run = pace.run;
  const render = cine.render;
  const t: Tap = {
    simMs: 0,
    drawMs: 0,
    timing: false,
    async finish() {
      const ms: number[] = [];
      const deadline = performance.now() + 3000;
      let pending = queries;
      while (pending.length && performance.now() < deadline) {
        await sleep(100);
        const disjoint = timer ? (gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean) : false;
        pending = pending.filter((q) => {
          if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
          if (!disjoint) ms.push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6);
          gl.deleteQuery(q);
          return false;
        });
      }
      pace.run = run;
      cine.render = render;
      renderer.info.autoReset = true;
      return ms;
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
        queries.push(q);
      }
      t.drawMs += performance.now() - t0;
    }
  };
  renderer.info.autoReset = false;
  return t;
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
  calls: Float64Array;
  tris: Float64Array;
}

/** The window: what the pacer lost and the race clock covered while it ran. */
interface Window {
  wallS: number;
  lostSimS: number;
  cutFrames: number;
  clockS: number;
}

/** Grid and warm-up (no samples), then `measureS` wall seconds of one sample per frame. */
async function sample(engine: BenchEngine, parts: BenchParts, t: Tap, ui: { set(text: string): void }): Promise<{ s: Samples; w: Window }> {
  const { renderer, race } = parts;
  const arr = (): Float64Array => new Float64Array(CAP);
  const s: Samples = { n: 0, iv: arr(), cpu: arr(), sim: arr(), draw: arr(), steps: arr(), coarse: arr(), calls: arr(), tris: arr() };
  const pace = engine.pace;
  let prev = await nextFrame();
  let startedAt = 0;
  let lost0 = 0;
  let cut0 = 0;
  let clock0 = 0;
  let stage: "grid" | "warm" | "measure" = "grid";
  for (;;) {
    const now = await nextFrame();
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    renderer.info.reset();
    t.simMs = t.drawMs = 0;
    const f0 = performance.now();
    engine.advance(dt, { frameDt: dt, render: true });
    const cpuMs = performance.now() - f0;
    if (stage === "grid" && race.phase === "racing") stage = "warm";
    if (stage === "warm" && race.time >= BENCH.warmS) {
      stage = "measure";
      startedAt = now;
      lost0 = pace.lost;
      cut0 = pace.cut;
      clock0 = race.time;
      t.timing = true;
    }
    if (stage !== "measure") {
      ui.set(`CRUSH BENCH: ${stage === "grid" ? "grid" : `warming ${Math.round(race.time)} / ${BENCH.warmS} s`}`);
      continue;
    }
    if (now - startedAt >= BENCH.measureS * 1000 || s.n >= CAP) break;
    const i = s.n++;
    s.iv[i] = dt * 1000;
    s.cpu[i] = cpuMs;
    s.sim[i] = t.simMs;
    s.draw[i] = t.drawMs;
    s.steps[i] = pace.steps;
    s.coarse[i] = pace.coarse ? 1 : 0;
    s.calls[i] = renderer.info.render.calls;
    s.tris[i] = renderer.info.render.triangles;
    ui.set(`CRUSH BENCH: measuring ${Math.round((now - startedAt) / 1000)} / ${BENCH.measureS} s`);
  }
  t.timing = false;
  return { s, w: { wallS: (prev - startedAt) / 1000, lostSimS: pace.lost - lost0, cutFrames: pace.cut - cut0, clockS: race.time - clock0 } };
}

function summarize(parts: BenchParts, s: Samples, w: Window, gpu: number[], setupMs: BenchResult["setupMs"]): BenchResult {
  const { renderer, cine, race } = parts;
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
  for (let i = 0; i < n; i++) stepSum += s.steps[i]!;
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return {
    course: BENCH.course,
    cars: parts.live().length,
    cops: { ...race.policeStats! },
    frames: n,
    wallS: w.wallS,
    fps: fpsOf(0, n),
    fpsLow1: frameMs.p99 ? 1000 / frameMs.p99 : 0,
    fpsThirds: [fpsOf(0, third), fpsOf(third, 2 * third), fpsOf(2 * third, n)],
    frameMs,
    cpuMs: stat(s.cpu, n),
    simMs,
    renderMs: stat(s.draw, n),
    gpuMs: gpu.length ? stat(gpu) : null,
    stepsPerFrame: n ? stepSum / n : 0,
    msPerStep: stepSum ? (simMs.mean * n) / stepSum : 0,
    cutFrames: w.cutFrames,
    lostSimS: w.lostSimS,
    coarsePct: n ? (100 * stat(s.coarse, n).mean) : 0,
    simSpeedPct: w.wallS ? (100 * w.clockS) / w.wallS : 0,
    calls: stat(s.calls, n).p50,
    triangles: stat(s.tris, n).p50,
    setupMs,
    device: {
      gpu: info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown GPU",
      cores: navigator.hardwareConcurrency,
      memoryGB: mem ?? null,
      screen: `${screen.width}x${screen.height}`,
      dpr: Math.round(devicePixelRatio * 1000) / 1000,
      ratio: renderer.getPixelRatio(),
      canvas: `${renderer.domElement.width}x${renderer.domElement.height}`,
      tier: cine.tier,
    },
  };
}

/**
 * `?bench=city`: the real game on the real clock for a fixed run, then a card of what it cost. The engine's own loop is
 * stopped and each rAF hands the engine its measured wall time through `advance` (the same `tickInner` the loop runs,
 * the pacer's real 8 ms deadline included), so a frame is timed, not simulated. Sequence: the race is set up, runs its
 * grid and `warmS` of race clock (the police park from a third of a lap on), then `measureS` wall seconds are sampled.
 * Afterwards the loop is restarted and the race plays on under the card.
 */
export async function runBench(engine: BenchEngine): Promise<BenchResult> {
  const ui = overlay();
  ui.set("CRUSH BENCH: loading…");
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
  const { s, w } = await sample(engine, parts, t, ui);
  const result = summarize(parts, s, w, await t.finish(), setupMs);
  ui.done(describeBench(result));
  (window as unknown as { __benchResult?: BenchResult }).__benchResult = result;
  console.log("CRUSH BENCH", JSON.stringify(result));
  engine.start();
  return result;
}
