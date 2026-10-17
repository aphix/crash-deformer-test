import type * as THREE from "three";
import { skinKernel } from "../deform/skin-kernel.ts";
import { DETAIL_LEVELS, type CarDetail } from "../present/car-detail.ts";
import { gpuRenderer } from "../present/auto-fx.ts";
import type { DetailGovernor } from "../present/detail-governor.ts";
import type { Cinematics } from "../present/engine-cine.ts";
import { probeDepth } from "../present/depth-probe.ts";
import { describePost, FX_TIERS, type FxTier } from "../present/engine-post.ts";
import type { DriverSeat } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { BenchPlan } from "./engine-bench-plan.ts";
import { browserName, perSecond, stat, type Battery, type BenchResult, type BenchSettings, type Block, type LongTasks, type PhaseCard, type RagdollCost, type ReplayResult } from "./engine-bench-report.ts";
import { REPLAY_TIER_S, replayTier, type ReplayFrames } from "./engine-bench-replay.ts";
import type { HighlightClip } from "../match/highlights.ts";
import type { RagdollSystem } from "../present/engine-ragdoll.ts";
import { SKY_MODES, skyDetailFor, type SkyDome } from "../present/sky-dome.ts";
import type { RaceDirector } from "./engine-race.ts";
import type { SimPacer } from "./sim-pace.ts";
import { SETTING_KEY } from "./constants.ts";
import type { World } from "./world-step.ts";
import { armedSolids } from "../world/surfaces.ts";
import { PHASE_NAMES, WORK_COUNT, WORK_NAMES } from "./sim-phases.ts";

/** The timings both benches share: the window, the A/B blocks. The warm-up and the course are the plan's. */
export const BENCH = { seed: 1, measureS: 30, blockS: 3, paceCycles: 3, fxCycles: 2, detailCycles: 2, skyCycles: 2, skyWaitS: 10, settleFrames: 10 } as const;
/** The key a rung's share of the window is kept under. */
const rungKey = (level: number): string => `${DETAIL_LEVELS[level]?.far ?? "?"} m`;
/** Samples kept: far above any display rate, so the window always fits. */
export const CAP = BENCH.measureS * 400;
/** The timer-query block of the main window (the A/B arms' blocks count up from 1). */
export const WINDOW_BLOCK = 0;
/** Timer queries in flight at most (a draw finding them all out goes untimed); the results kept: the window and every A/B block at the sample rate cap. */
const QUERY_POOL = 64;
const GPU_LOG_CAP = CAP * 4;
/** A detail rung's slot in the window's counts: 0 for a level the ladder has no rung for (`rungKey` "?"), else the level + 1. */
export const RUNG_SLOTS = DETAIL_LEVELS.length + 1;
export const rungSlot = (level: number): number => (level >= 0 && level < DETAIL_LEVELS.length ? level + 1 : 0);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The engine's protected parts the bench times, handed over by `EngineInput.benchParts`. */
export interface BenchParts {
  renderer: THREE.WebGLRenderer;
  cine: Pick<Cinematics, "render" | "tier">;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  race: Pick<RaceDirector, "phase" | "time" | "reseed" | "policeStats" | "loadBenchCourse" | "crashAtStart" | "recorder">;
  seat: DriverSeat;
  live(): readonly DeformableCar[];
  /** The distance detail and the rung its governor holds: the bench pins rungs for its A/B and puts the governor's back. */
  detail: Pick<CarDetail, "level" | "setLevel" | "setDistances">;
  governor: Pick<DetailGovernor, "level">;
  /** The live world: the steps it cut to fine slices for a hit about to land, and where its step's time and work are counted (`phases`: the clock reads go on for the window only). */
  world: Pick<World, "fineCuts" | "phases">;
  /** The cosmetic Rapier world (the thrown drivers' and knocked props'): its step cost is its own row, not part of the engine's cpu; `traffic` is what the sim posted to its worker. */
  ragdoll: Pick<RagdollSystem, "stats" | "traffic">;
  /** The race's sky: the bytes of the picture it holds (0 until the strip is in, and for no sky). */
  sky: Pick<SkyDome, "textureBytes">;
}

/** The smallest step `performance.now()` takes over a 25 ms spin (ms): the browser's timer resolution as this page sees it. */
export function timerStep(): number {
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

/** The timer-query results (ms) landed so far, with the block each belongs to (`Tap.block`); `n` entries, the rest of the arrays unwritten. */
interface GpuLog {
  n: number;
  block: Int32Array;
  ms: Float64Array;
}

/** Per-frame scratch the patches below add to, read and zeroed by the frame loop. */
export interface Tap {
  simMs: number;
  drawMs: number;
  /** Sim seconds the pacer stepped since the patch went on (each frame's sim time less what it gave up): every bench's clock, the race clock while it races. */
  simS: number;
  /** Draws are wrapped in a GPU timer query while true. */
  timing: boolean;
  /** The block the queries belong to (`WINDOW_BLOCK`: the main window). */
  block: number;
  /** Blocks numbered so far (the A/B arms' blocks count up from 1, across both A/Bs). */
  blocks: number;
  /** Moves the timer queries that have landed into the log (the frame loop calls it once per frame, outside the frame's timing). */
  collect(): void;
  /** The log once the last queries land (a few frames late; up to 3 s), then every patch comes off. */
  finish(): Promise<GpuLog>;
}

/** Instance patches for the run only: the sim's time (`SimPacer.run`) and the draw's (`Cinematics.render`, with a GPU timer query). */
export function tap(pace: SimPacer, parts: BenchParts): Tap {
  const { renderer, cine } = parts;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const elapsedTarget = timer ? timer.TIME_ELAPSED_EXT : 0;
  // The queries are made once and used round in a ring: `oldest` is the first still in flight, `inFlight` how many are.
  const pool = timer ? Array.from({ length: QUERY_POOL }, () => gl.createQuery()) : [];
  const poolBlock = new Int32Array(QUERY_POOL);
  let oldest = 0;
  let inFlight = 0;
  const log: GpuLog = { n: 0, block: new Int32Array(GPU_LOG_CAP), ms: new Float64Array(GPU_LOG_CAP) };
  const run = pace.run;
  const render = cine.render;
  const t: Tap = {
    simMs: 0,
    drawMs: 0,
    simS: 0,
    timing: false,
    block: WINDOW_BLOCK,
    blocks: 0,
    collect() {
      if (timer === null || inFlight === 0 || !gl.getQueryParameter(pool[oldest]!, gl.QUERY_RESULT_AVAILABLE)) return;
      const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean;
      do {
        if (!disjoint && log.n < GPU_LOG_CAP) {
          log.block[log.n] = poolBlock[oldest]!;
          log.ms[log.n++] = (gl.getQueryParameter(pool[oldest]!, gl.QUERY_RESULT) as number) / 1e6;
        }
        oldest = (oldest + 1) % QUERY_POOL;
        inFlight--;
      } while (inFlight > 0 && gl.getQueryParameter(pool[oldest]!, gl.QUERY_RESULT_AVAILABLE));
    },
    async finish() {
      const deadline = performance.now() + 3000;
      while (inFlight > 0 && performance.now() < deadline) {
        await sleep(100);
        t.collect();
      }
      for (let i = 0; i < pool.length; i++) gl.deleteQuery(pool[i]!);
      pace.run = run;
      cine.render = render;
      renderer.info.autoReset = true;
      return log;
    },
  };
  pace.run = (simDt, scale, vmax, fineNeeded, deadline, step): void => {
    const t0 = performance.now();
    const lost0 = pace.lost;
    run.call(pace, simDt, scale, vmax, fineNeeded, deadline, step);
    t.simMs += performance.now() - t0;
    t.simS += simDt - (pace.lost - lost0);
  };
  cine.render = (scene, camera, wallDt): void => {
    const t0 = performance.now();
    const timed = timer !== null && t.timing && inFlight < QUERY_POOL;
    const slot = (oldest + inFlight) % QUERY_POOL;
    if (timed) gl.beginQuery(elapsedTarget, pool[slot]!);
    render.call(cine, scene, camera, wallDt);
    if (timed) {
      gl.endQuery(elapsedTarget);
      poolBlock[slot] = t.block;
      inFlight++;
    }
    t.drawMs += performance.now() - t0;
  };
  renderer.info.autoReset = false;
  return t;
}

/** How many of the cars in play are wrecks. */
export function wrecks(parts: BenchParts): number {
  const cars = parts.live();
  let n = 0;
  for (let i = 0; i < cars.length; i++) if (cars[i]!.crashed) n++;
  return n;
}

/** The deterministic counters of a window, in the order `readCounters` fills them: the pacer's steps, the world's work (`WORK_NAMES`), then the counters of the contact surface, the skin kernel and the ragdoll worker's posts. */
export const COUNTER_NAMES = ["steps", ...WORK_NAMES, "prismQueries", "prismsVisited", "prismTouches", "skins", "skinVerts", "ragdollMessages", "ragdollBytes"] as const;
export const COUNTER_COUNT = COUNTER_NAMES.length;

/** The counters as they stand now, into `out` (`COUNTER_COUNT` long). Each only counts up: a window's work is the difference of two reads. */
function readCounters(parts: BenchParts, pace: Pick<SimPacer, "total">, out: Float64Array): void {
  out[0] = pace.total;
  out.set(parts.world.phases.work, 1);
  let k = 1 + WORK_COUNT;
  const solids = armedSolids();
  out[k++] = solids?.prismQueries ?? 0;
  out[k++] = solids?.prismsVisited ?? 0;
  out[k++] = solids?.prismTouches ?? 0;
  const kernel = skinKernel();
  out[k++] = kernel?.calls ?? 0;
  out[k++] = kernel?.verts ?? 0;
  out[k++] = parts.ragdoll.traffic.messages;
  out[k] = parts.ragdoll.traffic.bytes;
}

/** The phase table of a window of `clockS` sim seconds whose sim cost `simMs` ms: `phaseMs` and `counts` are the window's differences. */
export function phaseCard(phaseMs: Float64Array, counts: Float64Array, simMs: number, clockS: number): PhaseCard {
  const perS = (v: number): number => (clockS ? v / clockS : 0);
  const msPerSimS: Record<string, number> = {};
  let attributed = 0;
  for (let i = 0; i < PHASE_NAMES.length; i++) {
    msPerSimS[PHASE_NAMES[i]!] = perS(phaseMs[i]!);
    attributed += phaseMs[i]!;
  }
  const workPerSimS: Record<string, number> = {};
  for (let i = 0; i < COUNTER_COUNT; i++) workPerSimS[COUNTER_NAMES[i]!] = perS(counts[i]!);
  return { msPerSimS, unattributedMsPerSimS: perS(simMs - attributed), workPerSimS };
}

/** The sim's phase clock and counters over one window: the clock reads go on at the call and off at `end`, which returns the differences (`Window.phaseMs`, `Window.counts`). */
export function watchWork(parts: BenchParts, pace: Pick<SimPacer, "total">): { end(): { phaseMs: Float64Array; counts: Float64Array } } {
  const phases = parts.world.phases;
  const phaseMs0 = phases.ms.slice();
  const counts0 = new Float64Array(COUNTER_COUNT);
  readCounters(parts, pace, counts0);
  phases.on = true;
  return {
    end: () => {
      phases.on = false;
      const counts = new Float64Array(COUNTER_COUNT);
      readCounters(parts, pace, counts);
      const phaseMs = phases.ms.slice();
      for (let i = 0; i < phaseMs.length; i++) phaseMs[i] = phaseMs[i]! - phaseMs0[i]!;
      for (let i = 0; i < COUNTER_COUNT; i++) counts[i] = counts[i]! - counts0[i]!;
      return { phaseMs, counts };
    },
  };
}

const LONG_TASK_ENTRY = "longtask";

/** Counts the long tasks (`PerformanceObserver` "longtask") from now until `stop`, which returns them; `stop` returns null where the browser has no such entries (Chrome only). */
export function watchLongTasks(): { stop(): LongTasks | null } {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes(LONG_TASK_ENTRY)) return { stop: () => null };
  const found: LongTasks = { count: 0, totalMs: 0, maxMs: 0 };
  const take = (entries: PerformanceEntryList): void => {
    for (const entry of entries) {
      found.count++;
      found.totalMs += entry.duration;
      found.maxMs = Math.max(found.maxMs, entry.duration);
    }
  };
  const observer = new PerformanceObserver((list) => take(list.getEntries()));
  observer.observe({ type: LONG_TASK_ENTRY });
  return {
    stop: () => {
      take(observer.takeRecords());
      observer.disconnect();
      return found;
    },
  };
}

/** The battery now, null where the browser has no `navigator.getBattery` (Chrome has it; a refusal is logged and reads as none). */
export async function readBattery(): Promise<Battery | null> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<Battery> };
  if (nav.getBattery === undefined) return null;
  try {
    const battery = await nav.getBattery();
    return { charging: battery.charging, level: battery.level };
  } catch (err) {
    console.warn("Crush bench: navigator.getBattery failed", err);
    return null;
  }
}

/** One value per sampled frame. */
export interface Samples {
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
  /** Frames counted at each FX tier (an index into `FX_TIERS`) and each detail rung (`rungSlot`), the slots in the order first counted, and how many there are. */
  tierCounts: Float64Array;
  tierOrder: Uint8Array;
  tiersSeen: number;
  levelCounts: Float64Array;
  levelOrder: Uint8Array;
  levelsSeen: number;
}

/** The window: what the pacer lost, the sim clock covered and the Lab threw while it ran. */
export interface Window {
  wallS: number;
  lostSimS: number;
  cutFrames: number;
  fineCuts: number;
  clockS: number;
  thrown: number;
  /** The cosmetic Rapier world's `world.step()` cost over the window. */
  ragdoll: RagdollCost;
  /** The differences of the sim's phase clock (`PHASE_NAMES` order, ms) and counters (`COUNTER_NAMES` order) over the window. */
  phaseMs: Float64Array;
  counts: Float64Array;
}

/** Sums over the frames of one arm (all its blocks). */
export interface Acc {
  frames: number;
  wallS: number;
  clockS: number;
  sim: number;
  cpu: number;
  draw: number;
  steps: number;
  fineCuts: number;
  calls: number;
  tris: number;
  gpuSum: number;
  gpuCount: number;
}

export const emptyAcc = (): Acc => ({ frames: 0, wallS: 0, clockS: 0, sim: 0, cpu: 0, draw: 0, steps: 0, fineCuts: 0, calls: 0, tris: 0, gpuSum: 0, gpuCount: 0 });

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
    gpuMs: a.gpuCount ? a.gpuSum / a.gpuCount : null,
    fineCutsPerSimS: a.clockS ? a.fineCuts / a.clockS : 0,
    calls: a.calls / n,
    triangles: a.tris / n,
  };
}

/** The depth buffer facts a ground flicker (z-fighting) depends on, with the probe's offset a ground layer needs to show over a coplanar one (drawn now, between the window and the A/Bs, whose settle frames absorb it). */
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
export function settingsOf(parts: BenchParts, hud: Record<string, unknown>, top: string): BenchSettings {
  const { renderer, scene, sun, camera } = parts;
  const size = renderer.domElement;
  let casters = 0;
  scene.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh && o.castShadow) casters++;
  });
  const cel = hud[SETTING_KEY.celLook];
  const sky = SKY_MODES.find((mode) => mode === hud[SETTING_KEY.sky]) ?? "auto";
  return {
    fxTier: parts.cine.tier,
    fxAuto: hud["fxAuto"] === true,
    post: describePost(top as FxTier),
    fxDensity: Number(hud["fxDensity"]),
    celLook: typeof cel === "number" ? cel : null,
    shadows: { enabled: renderer.shadowMap.enabled, type: ["Basic", "PCF", "PCFSoft", "VSM"][renderer.shadowMap.type] ?? String(renderer.shadowMap.type), map: `${sun.shadow.mapSize.x}x${sun.shadow.mapSize.y}`, casters },
    pixelRatio: renderer.getPixelRatio(),
    deviceRatio: Math.round(devicePixelRatio * 1000) / 1000,
    canvas: `${size.width}x${size.height}`,
    antialias: renderer.getContext().getContextAttributes()?.antialias === true,
    toneMapping: renderer.toneMapping,
    night: hud[SETTING_KEY.night] === true,
    wet: hud[SETTING_KEY.wet] === true,
    sky,
    skyDetail: skyDetailFor(sky, top as FxTier),
    realism: Number(hud[SETTING_KEY.realism]),
    squash: Number(hud["squash"]),
    buckle: Number(hud["buckle"]),
    deformMode: String(hud["deformMode"]),
    depth: depthOf(renderer, camera),
  };
}

/** Each counted slot's share of `frames`, %, keyed by `keyOf(slot)` in the order the slots were first counted. */
function sharesOf(counts: Float64Array, order: Uint8Array, seen: number, frames: number, keyOf: (slot: number) => string): Record<string, number> {
  const shares: Record<string, number> = {};
  for (let i = 0; i < seen; i++) shares[keyOf(order[i]!)] = (100 * counts[order[i]!]!) / Math.max(1, frames);
  return shares;
}

export function summarize(parts: BenchParts, plan: BenchPlan, s: Samples, w: Window, setupMs: BenchResult["setupMs"]): Omit<BenchResult, "strip" | "labThrown" | "settings" | "abPace" | "abFx" | "abDetail" | "abSky" | "device" | "pageEvents" | "gpuMs" | "replay" | "replayWhy" | "longTasks"> {
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
    skinKernel: skinKernel() !== null,
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
    tierPct: sharesOf(s.tierCounts, s.tierOrder, s.tiersSeen, n, (slot) => FX_TIERS[slot]!),
    detailPct: sharesOf(s.levelCounts, s.levelOrder, s.levelsSeen, n, (slot) => rungKey(slot - 1)),
    setupMs,
    ragdoll: w.ragdoll,
    phases: phaseCard(w.phaseMs, w.counts, simSum, w.clockS),
  };
}

/** The device, as this page sees it; `batteryStart` is what `readBattery` said when the run began. */
export async function deviceOf(parts: BenchParts, timerStepMs: number, batteryStart: Battery | null): Promise<BenchResult["device"]> {
  const { renderer } = parts;
  const gl = renderer.getContext();
  const gpu = gpuRenderer(gl) ?? "unknown GPU";
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const brave = await (navigator as Navigator & { brave?: { isBrave(): Promise<boolean> } }).brave?.isBrave().catch(() => false);
  const batteryEnd = await readBattery();
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
    battery: batteryStart && batteryEnd && { start: batteryStart, end: batteryEnd },
  };
}

/** The arms' sums with the timer-query times of their blocks folded in, as blocks. */
export function blocksOf(r: { accs: Map<string, Acc>; blockKeys: Map<number, string> }, gpu: GpuLog): Record<string, Block> {
  for (let i = 0; i < gpu.n; i++) {
    const key = r.blockKeys.get(gpu.block[i]!);
    if (key === undefined) continue;
    const acc = r.accs.get(key)!;
    acc.gpuSum += gpu.ms[i]!;
    acc.gpuCount++;
  }
  return Object.fromEntries([...r.accs].map(([key, acc]) => [key, toBlock(acc)]));
}

/** The window's timer-query times (ms), in the order they landed. */
export function windowGpuMs(gpu: GpuLog): Float64Array {
  const ms = new Float64Array(gpu.n);
  let count = 0;
  for (let i = 0; i < gpu.n; i++) if (gpu.block[i] === WINDOW_BLOCK) ms[count++] = gpu.ms[i]!;
  return ms.subarray(0, count);
}

/** The FX tier the most window frames ran (the first to reach it on a tie), `fallback` when none was sampled. */
export function topTier(s: Samples, fallback: FxTier): FxTier {
  let top = fallback;
  let topCount = 0;
  for (let i = 0; i < s.tiersSeen; i++) {
    const slot = s.tierOrder[i]!;
    if (s.tierCounts[slot]! > topCount) {
      topCount = s.tierCounts[slot]!;
      top = FX_TIERS[slot]!;
    }
  }
  return top;
}

/** One FX tier's replay before the GPU timer results land: its frames, the timer-query block they belong to, and the ragdoll world's cost during them. */
export interface ReplayArm {
  tier: FxTier;
  frames: ReplayFrames;
  block: number;
  ragdoll: RagdollCost;
}

/** The mean of the GPU timer-query results (ms) of one block, null when the device gave none. */
function gpuMeanOf(gpu: GpuLog, block: number): number | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < gpu.n; i++) {
    if (gpu.block[i] !== block) continue;
    sum += gpu.ms[i]!;
    count++;
  }
  return count ? sum / count : null;
}

/** The replay's card entry: the clip's size, cars and throws, and each tier's row with its GPU time. */
export function replayResult(run: { bytes: number; arms: readonly ReplayArm[]; clip: HighlightClip }, gpu: GpuLog): ReplayResult {
  const { clip } = run;
  return {
    tierS: REPLAY_TIER_S,
    clip: { bytes: run.bytes, cars: clip.cars.length, ejections: clip.ejections.length, steps: clip.h.length },
    tiers: Object.fromEntries(run.arms.map((a) => [a.tier, replayTier(a.frames, gpuMeanOf(gpu, a.block), a.ragdoll)])),
  };
}
