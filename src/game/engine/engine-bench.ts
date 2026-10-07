import type * as THREE from "three";
import type { RaceCommand } from "../match/types.ts";
import { DETAIL_LEVELS, type CarDetail } from "../present/car-detail.ts";
import type { DetailGovernor } from "../present/detail-governor.ts";
import type { Cinematics } from "../present/engine-cine.ts";
import { probeDepth } from "../present/depth-probe.ts";
import { describePost, type FxTier } from "../present/engine-post.ts";
import type { DriverSeat } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { benchPlan, leaderAhead, type BenchPlan } from "./engine-bench-plan.ts";
import { browserName, describeBench, DETAIL_ARMS, perSecond, stat, type BenchResult, type BenchSettings, type Block } from "./engine-bench-report.ts";
import type { LabPresetId } from "../scenes/lab.ts";
import type { RaceDirector } from "./engine-race.ts";
import type { SimPacer } from "./sim-pace.ts";
import type { World } from "./world-step.ts";

/** The timings both benches share: the window, the A/B blocks. The warm-up and the course are the plan's. */
const BENCH = { seed: 1, measureS: 30, blockS: 3, paceCycles: 3, fxCycles: 2, detailCycles: 2, settleFrames: 10 } as const;
/** The key a rung's share of the window is kept under. */
const rungKey = (level: number): string => `${DETAIL_LEVELS[level]?.far ?? "?"} m`;
/** Samples kept: far above any display rate, so the window always fits. */
const CAP = BENCH.measureS * 400;

/** The engine's protected parts the bench times, handed over by `EngineInput.benchParts`. */
export interface BenchParts {
  renderer: THREE.WebGLRenderer;
  cine: Pick<Cinematics, "render" | "tier">;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  race: Pick<RaceDirector, "phase" | "time" | "reseed" | "policeStats" | "loadBenchCourse">;
  seat: DriverSeat;
  live(): readonly DeformableCar[];
  /** The distance detail (`present/car-detail.ts`) and the rung its governor holds: the bench pins rungs for its A/B and puts the governor's back. */
  detail: Pick<CarDetail, "level" | "setLevel" | "setDistances">;
  governor: Pick<DetailGovernor, "level">;
  /** The live world: the steps it cut to fine slices for a hit about to land. */
  world: Pick<World, "fineCuts">;
}

/** What `runBench` drives: the real engine, by its public face. */
interface BenchEngine {
  readonly ready: Promise<void>;
  readonly pace: SimPacer;
  fadeScenes: boolean;
  /** Off for the bench page's life: it enters the race scene and pins the fx tier through the player's setters, and none of that is the player's pick. */
  followUrl: boolean;
  toggleRace(): void;
  raceCommand(cmd: RaceCommand): void;
  toggleLab(): void;
  setLabPreset(id: LabPresetId): void;
  /** The HUD's Reset: the scene's set put back. */
  reset(): void;
  /** The HUD's time scale: a fixed one, or null for the automatic slow-mo. */
  setTimeScale(value: number | null): void;
  /** Lab item `thing` thrown at item `target` at `speed` m/s (the plan direction dx, dz is a free throw's only). */
  flickLab(thing: number, target: number, dx: number, dz: number, speed: number): void;
  advance(seconds: number, opts?: { frameDt?: number; render?: boolean }): void;
  start(): void;
  setFxTier(tier: FxTier): void;
  setFxAuto(): void;
  benchParts(): BenchParts;
  /** Every non-police car wears `style` (null: the fleet's mix). */
  useOneBody(style: CarStyleId | null): void;
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

/** A bench card posted: the receipt id the server gave, or why it did not go. */
type BenchReceipt = { id: string } | { error: string };
/** What posts a bench card's JSON (the page owns the server's address and the loop's context). */
type SubmitBench = (payload: object) => Promise<BenchReceipt>;

/**
 * A text card over the canvas; `set` rewrites it while the bench runs, `done` swaps in the results and the buttons that copy
 * the full details as JSON and submit them, `receipt` shows how a submit went.
 */
function overlay(): {
  set(text: string): void;
  done(lines: string[], details: () => string, submit: () => void): void;
  receipt(state: "sending" | BenchReceipt): void;
} {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:8px;top:8px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;z-index:99999;padding:8px 10px;" +
    "background:rgba(8,10,14,.92);color:#e8f0ff;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;border-radius:8px;pointer-events:none";
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:0;white-space:pre-wrap";
  const status = document.createElement("div");
  status.style.cssText = "margin-top:6px";
  root.append(pre, status);
  document.body.append(root);
  const buttonStyle = "margin:6px 6px 0 0;padding:6px 10px;font:inherit;border-radius:6px;border:1px solid #7ee787;background:#14301c;color:#e8f0ff";
  const submitButton = document.createElement("button");
  return {
    set: (text) => void (pre.textContent = text),
    done: (lines, details, submit) => {
      pre.textContent = lines.join("\n");
      root.style.pointerEvents = "auto";
      root.style.borderLeft = "4px solid #7ee787";
      const copy = document.createElement("button");
      copy.textContent = "Copy details (JSON)";
      copy.style.cssText = buttonStyle;
      copy.onclick = () => {
        void copyText(details()).then((ok) => void (copy.textContent = ok ? "Copied" : "Copy failed: select the card text instead"));
      };
      submitButton.textContent = "Submit \u2191";
      submitButton.style.cssText = buttonStyle;
      submitButton.onclick = submit;
      root.append(copy, submitButton);
    },
    receipt: (state) => {
      status.replaceChildren();
      submitButton.disabled = state === "sending";
      if (state === "sending") status.textContent = "Sending\u2026";
      else if ("error" in state) status.textContent = `Not sent: ${state.error}`;
      else {
        const id = document.createElement("code");
        id.textContent = state.id;
        id.style.cssText = "user-select:all;font-size:13px;letter-spacing:.06em;padding:0 4px;background:#1c2530;border-radius:4px";
        const copyId = document.createElement("button");
        copyId.textContent = "Copy";
        copyId.style.cssText = `${buttonStyle};margin:0 0 0 6px;padding:2px 8px`;
        copyId.onclick = () => void copyText(state.id).then((ok) => void (copyId.textContent = ok ? "Copied" : "Select the id"));
        status.append("Receipt ", id, copyId);
      }
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
  /** Sim seconds the pacer stepped since the patch went on (each frame's sim time less what it gave up): every bench's clock, the race clock while it races. */
  simS: number;
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
    simS: 0,
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
    const lost0 = pace.lost;
    run.apply(pace, a);
    t.simMs += performance.now() - t0;
    t.simS += a[0] - (pace.lost - lost0);
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

/**
 * The loop's state between rAFs: the last stamp, so a frame's dt is the real interval wherever the caller picks the loop up,
 * and the Lab bench's throws (null: a race).
 */
interface Beat {
  prev: number;
  lab: LabRun | null;
}

/**
 * Where the Lab bench's sequence is: the sim second it (re)started at and the throw it started with, the segment under way (-1:
 * none yet), the set up, whether the segment's throw has left, and the throws so far.
 */
interface LabRun {
  plan: NonNullable<BenchPlan["lab"]>;
  origin: number;
  first: number;
  segment: number;
  preset: LabPresetId | null;
  thrown: boolean;
  throws: number;
}

/**
 * The Lab's sequence on the sim seconds stepped (`Tap.simS`): each `segmentS` the next throw's set loads (the player's set picker,
 * or Reset for the set already up), and `settleS` into the segment its thrower leaves for its target (the player's flick), so a
 * device steps the same throws per sim-second however fast it runs.
 */
function driveLab(engine: BenchEngine, t: Tap, run: LabRun): void {
  const k = Math.floor((t.simS - run.origin) / run.plan.segmentS);
  const next = run.plan.throws[(run.first + k) % run.plan.throws.length]!;
  if (k !== run.segment) {
    run.segment = k;
    run.thrown = false;
    if (run.preset === next.preset) engine.reset();
    else engine.setLabPreset(next.preset);
    run.preset = next.preset;
  }
  if (run.thrown || t.simS - run.origin - k * run.plan.segmentS < run.plan.settleS) return;
  run.thrown = true;
  run.throws++;
  engine.flickLab(0, next.target, 0, 0, next.speed);
}

/** The Lab's sequence starts over now at throw `first` (an A/B block: every arm of a round replays the same throw from its set's load). */
function restartLab(run: LabRun, simS: number, first: number): void {
  run.origin = simS;
  run.first = first;
  run.segment = -1;
}

/** One rAF: the Lab's throw when one is due, then the engine handed its measured wall time through `advance` (the loop's own `tickInner`), timed together. */
async function frame(engine: BenchEngine, renderer: THREE.WebGLRenderer, t: Tap, beat: Beat): Promise<Frame> {
  const now = await nextFrame();
  const dt = Math.min(0.1, (now - beat.prev) / 1000);
  beat.prev = now;
  renderer.info.reset();
  t.simMs = t.drawMs = 0;
  const f0 = performance.now();
  if (beat.lab) driveLab(engine, t, beat.lab);
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
  levels: Map<string, number>;
}

/** The window: what the pacer lost, the sim clock covered and the Lab threw while it ran. */
interface Window {
  wallS: number;
  lostSimS: number;
  cutFrames: number;
  fineCuts: number;
  clockS: number;
  thrown: number;
}

/** The grid and the warm-up: frames with no samples until `plan.warmS` has run, of race clock from the green or of the Lab's sim. */
async function lead(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, ui: { set(text: string): void }, plan: BenchPlan): Promise<void> {
  const { renderer, race } = parts;
  for (;;) {
    await frame(engine, renderer, t, beat);
    const going = plan.lab !== null || race.phase === "racing";
    const clock = plan.lab ? t.simS : race.time;
    if (going && clock >= plan.warmS) return;
    ui.set(`CRUSH BENCH: ${going ? `warming ${Math.round(clock)} / ${plan.warmS} s` : "grid"}`);
  }
}

/** `measureS` wall seconds of one sample per frame, the engine's own auto FX tier and pacer as they are. */
async function sample(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, ui: { set(text: string): void }): Promise<{ s: Samples; w: Window }> {
  const { renderer, cine } = parts;
  const arr = (): Float64Array => new Float64Array(CAP);
  const s: Samples = { n: 0, iv: arr(), cpu: arr(), sim: arr(), draw: arr(), steps: arr(), coarse: arr(), wrecks: arr(), calls: arr(), tris: arr(), tiers: new Map(), levels: new Map() };
  const pace = engine.pace;
  const lost0 = pace.lost;
  const cut0 = pace.cut;
  const fine0 = parts.world.fineCuts;
  const clock0 = t.simS;
  const thrown0 = beat.lab?.throws ?? 0;
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
    const rung = rungKey(parts.detail.level);
    s.levels.set(rung, (s.levels.get(rung) ?? 0) + 1);
    ui.set(`CRUSH BENCH: measuring ${Math.round(wall)} / ${BENCH.measureS} s`);
  }
  t.timing = false;
  return { s, w: { wallS: wall, lostSimS: pace.lost - lost0, cutFrames: pace.cut - cut0, fineCuts: parts.world.fineCuts - fine0, clockS: t.simS - clock0, thrown: (beat.lab?.throws ?? 0) - thrown0 } };
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
  fineCuts: number;
  gpu: number[];
}

const emptyAcc = (): Acc => ({ frames: 0, wallS: 0, clockS: 0, sim: 0, cpu: 0, draw: 0, steps: 0, fineCuts: 0, gpu: [] });

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
    fineCutsPerSimS: a.clockS ? a.fineCuts / a.clockS : 0,
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
  const { renderer } = parts;
  const accs = new Map(arms.map((a) => [a.key, emptyAcc()]));
  const blockKeys = new Map<number, string>();
  for (let c = 0; c < cycles; c++) {
    for (const a of arms) {
      a.set();
      if (beat.lab) restartLab(beat.lab, t.simS, c);
      t.timing = false;
      for (let i = 0; i < BENCH.settleFrames; i++) await frame(engine, renderer, t, beat);
      t.block = ++t.blocks;
      blockKeys.set(t.block, a.key);
      t.timing = true;
      const acc = accs.get(a.key)!;
      const clock0 = t.simS;
      const fine0 = parts.world.fineCuts;
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
      acc.clockS += t.simS - clock0;
      acc.fineCuts += parts.world.fineCuts - fine0;
    }
  }
  t.timing = false;
  return { accs, blockKeys };
}

/**
 * The depth buffer facts a ground flicker (z-fighting) depends on: the drawing buffer's depth bits, the fragment shader's float precision,
 * the camera's planes, and the probe's measure of the offset a ground layer needs to show over a coplanar one (drawn now, between the
 * window and the A/Bs, whose settle frames absorb it).
 */
function depthOf(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): BenchSettings["depth"] {
  const gl = renderer.getContext();
  const frag = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  return {
    bits: gl.getParameter(gl.DEPTH_BITS) as number,
    subpixelBits: gl.getParameter(gl.SUBPIXEL_BITS) as number,
    contextDepth: gl.getContextAttributes()?.depth === true,
    fragmentHighFloat: frag ? { precision: frag.precision, rangeMin: frag.rangeMin, rangeMax: frag.rangeMax } : null,
    near: camera.near,
    far: camera.far,
    logarithmicDepthBuffer: renderer.capabilities.logarithmicDepthBuffer,
    probe: probeDepth(renderer),
  };
}

/** What was switched on, read off the renderer, the sun and the HUD's own state. */
function settingsOf(parts: BenchParts, hud: Record<string, unknown>, top: string): BenchSettings {
  const { renderer, scene, sun, camera } = parts;
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
    depth: depthOf(renderer, camera),
  };
}

function summarize(parts: BenchParts, plan: BenchPlan, s: Samples, w: Window, gpu: number[], setupMs: BenchResult["setupMs"]): Omit<BenchResult, "strip" | "labThrown" | "settings" | "abPace" | "abFx" | "abDetail" | "device"> {
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
  const perS = perSecond(iv, s.sim, n);
  return {
    course: plan.id,
    build: __BUILD_SHA__,
    cars: parts.live().length,
    cops: race.policeStats ? { ...race.policeStats } : null,
    crashed: { mean: stat(s.wrecks, n).mean, end: wrecks(parts) },
    frames: n,
    wallS: w.wallS,
    fps: fpsOf(0, n),
    fpsLow1: frameMs.p99 ? 1000 / frameMs.p99 : 0,
    fpsThirds: [fpsOf(0, third), fpsOf(third, 2 * third), fpsOf(2 * third, n)],
    fpsPerSecond: perS.fps,
    simMsPerSecond: perS.workMs,
    frameMs,
    cpuMs: stat(s.cpu, n),
    simMs,
    renderMs: stat(s.draw, n),
    gpuMs: gpu.length ? stat(gpu) : null,
    stepsPerFrame: n ? stepSum / n : 0,
    msPerStep: stepSum ? simSum / stepSum : 0,
    simMsPerSimS: w.clockS ? simSum / w.clockS : 0,
    fineCutsPerSimS: w.clockS ? w.fineCuts / w.clockS : 0,
    cutFrames: w.cutFrames,
    lostSimS: w.lostSimS,
    coarsePct: n ? 100 * stat(s.coarse, n).mean : 0,
    simSpeedPct: w.wallS ? (100 * w.clockS) / w.wallS : 0,
    calls: stat(s.calls, n).p50,
    triangles: stat(s.tris, n).p50,
    tierPct: Object.fromEntries([...s.tiers].map(([tier, count]) => [tier, (100 * count) / Math.max(1, n)])),
    detailPct: Object.fromEntries([...s.levels].map(([rung, count]) => [rung, (100 * count) / Math.max(1, n)])),
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
 * `?bench=city`, `?bench=strip&…` or `?bench=lab` (`benchPlan`): the real game on the real clock for a fixed run, then a card of what it
 * cost. The engine's own loop is stopped and each rAF hands the engine its measured wall time through `advance` (the same
 * `tickInner` the loop runs, the pacer's real 8 ms deadline included), so a frame is timed, not simulated. Sequence: the
 * race is set up, runs its grid and `warmS` of race clock (the Lab: its first set stands `warmS` of sim, and its throws then
 * run on throughout), then `measureS` wall seconds are sampled with the game's own
 * settings (auto FX tier, adaptive pacer). Then, on the same race, the pacer is pinned to 1/240 s and to 1/120 s in
 * alternating blocks, and the FX tier to minimal, low and high in alternating blocks, each arm scored the same way.
 * Afterwards the settings go back to automatic, the loop restarts and the scene plays on under the card. `hud` reads the
 * HUD's state (every setting the player can change); `search` is the page's query string. `opts.submit` posts the card's JSON (the
 * card's Submit button, and the bench loop's `auto` post before it moves on). Null: no such bench.
 */
export async function runBench(engine: BenchEngine, hud: () => object, search: string, opts: { submit: SubmitBench; auto: boolean }): Promise<BenchResult | null> {
  const plan = benchPlan(search);
  if (!plan) return null;
  const ui = overlay();
  ui.set("CRUSH BENCH: loading…");
  const timerStepMs = timerStep();
  await engine.ready;
  const parts = engine.benchParts();
  parts.renderer.setAnimationLoop(null);
  engine.fadeScenes = false;
  engine.followUrl = false;
  // The Lab bench throws on the Lab's own sets (`LAB_BENCH`) at 1x: the slow-mo would stretch each hit over a different share
  // of each block. A race bench enters the race scene (no slow-mo in a race).
  if (plan.lab) {
    engine.toggleLab();
    engine.setTimeScale(1);
  } else engine.toggleRace();
  // The strip is built now, handed to the race field as an off-menu course, and every non-police car wears the one body asked for.
  if (plan.course) parts.race.loadBenchCourse(plan.course);
  engine.useOneBody(plan.body);
  const setupMs = { options: 0, start: 0 };
  if (plan.race) {
    const t0 = performance.now();
    engine.raceCommand(plan.race);
    const t1 = performance.now();
    parts.race.reseed(BENCH.seed);
    engine.raceCommand({ type: "start" });
    setupMs.options = t1 - t0;
    setupMs.start = performance.now() - t1;
    parts.seat.mode = "follow";
  }

  const t = tap(engine.pace, parts);
  const beat: Beat = { prev: await nextFrame(), lab: plan.lab ? { plan: plan.lab, origin: 0, first: 0, segment: -1, preset: null, thrown: false, throws: 0 } : null };
  await lead(engine, parts, t, beat, ui, plan);
  const { s, w } = await sample(engine, parts, t, beat, ui);
  const leaderWindowM = leaderAhead(parts, plan);
  const top = [...s.tiers].sort((a, b) => b[1] - a[1])[0]?.[0] ?? parts.cine.tier;
  const settings = settingsOf(parts, hud() as Record<string, unknown>, top);

  // The A/Bs hold the tier the window mostly ran, so the pacer arms differ in the pacer alone.
  engine.setFxTier(top as FxTier);
  const pace = await alternate(engine, parts, t, beat, ui, "pacer", [{ key: "fine", set: () => void (engine.pace.pin = false) }, { key: "coarse", set: () => void (engine.pace.pin = true) }], BENCH.paceCycles);
  engine.pace.pin = null;
  // The detail arms run at the window's tier too (the governor is off with the tier pinned), then the governor's rung is put back.
  const detail = await alternate(engine, parts, t, beat, ui, "detail", DETAIL_ARMS.map((a) => ({ key: a.key, set: () => (a.level === null ? parts.detail.setDistances(Infinity, Infinity) : parts.detail.setLevel(a.level)) })), BENCH.detailCycles);
  parts.detail.setLevel(parts.governor.level);
  const fx = await alternate(engine, parts, t, beat, ui, "fx", (["minimal", "low", "high"] as const).map((tier) => ({ key: tier, set: () => engine.setFxTier(tier) })), BENCH.fxCycles);
  engine.setFxAuto();
  if (plan.lab) engine.setTimeScale(null);

  const gpu = await t.finish();
  const abPace = blocksOf(pace, gpu);
  const abFx = blocksOf(fx, gpu);
  const device = await deviceOf(parts, timerStepMs);
  const result: BenchResult = {
    ...summarize(parts, plan, s, w, gpu.filter((g) => g.block === 0).map((g) => g.ms), setupMs),
    strip: plan.strip ? { spec: plan.strip, body: plan.body, racers: plan.racers, leaderWindowM, leaderEndM: leaderAhead(parts, plan) } : null,
    labThrown: plan.lab ? w.thrown : null,
    settings,
    abPace: { fine: abPace["fine"]!, coarse: abPace["coarse"]! },
    abFx: { minimal: abFx["minimal"]!, low: abFx["low"]!, high: abFx["high"]! },
    abDetail: blocksOf(detail, gpu),
    device,
  };
  const payload = (): object => ({ at: new Date().toISOString(), url: location.href, userAgent: navigator.userAgent, hud: hud(), result });
  const send = async (): Promise<BenchReceipt> => {
    ui.receipt("sending");
    const receipt = await opts.submit(payload());
    ui.receipt(receipt);
    return receipt;
  };
  ui.done(describeBench(result), () => JSON.stringify(payload(), null, 1), () => void send());
  (window as unknown as { __benchResult?: BenchResult }).__benchResult = result;
  console.log("CRUSH BENCH", JSON.stringify(result));
  engine.start();
  // The bench loop posts each card as it finishes, before the page moves on to the next bench.
  if (opts.auto) await send();
  return result;
}
