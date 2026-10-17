import * as THREE from "three";
import type { RaceCommand } from "../match/types.ts";
import { FX_TIERS, type FxTier } from "../present/engine-post.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { benchPlan, leaderAhead, type BenchPlan } from "./engine-bench-plan.ts";
import { watchPage } from "./engine-bench-page.ts";
import { warmUp } from "./engine-bench-warm.ts";
import { describeBench, DETAIL_ARMS, PACE_ARM, PHASE_AB_DETAIL, PHASE_AB_FX, PHASE_AB_PACE, PHASE_AB_SKY, PHASE_REPLAY, PHASE_WARM, PHASE_WINDOW, SKY_ARM, stat, type BenchResult, type LongTasks } from "./engine-bench-report.ts";
import { CLIP_WAIT_S, CRASH_GAP, CRASH_SPEED, ragdollCost, REPLAY_SETTLE_S, REPLAY_TIER_S, START_WAIT_S, type ReplayFrames } from "./engine-bench-replay.ts";
import { BENCH, blocksOf, CAP, deviceOf, emptyAcc, readBattery, replayResult, RUNG_SLOTS, rungSlot, settingsOf, summarize, tap, timerStep, topTier, watchLongTasks, watchWork, windowGpuMs, WINDOW_BLOCK, wrecks, type Acc, type BenchParts, type ReplayArm, type Samples, type Tap, type Window } from "./bench-measure.ts";
import type { HighlightClip } from "../match/highlights.ts";
import type { LabPresetId } from "../scenes/lab.ts";
import type { SimPacer } from "./sim-pace.ts";
import { SETTING_KEY } from "./constants.ts";
import type { SkyMode } from "../present/sky-dome.ts";
import { hudSettings, roundCard } from "./bench-card.ts";
import { INITIAL_HUD, type CrashHudState } from "../hud/hud-store.ts";

/** What `runBench` drives: the real engine, by its public face. */
interface BenchEngine {
  readonly ready: Promise<void>;
  readonly pace: SimPacer;
  fadeScenes: boolean;
  toggleRace(): void;
  raceCommand(cmd: RaceCommand): void;
  toggleLab(): void;
  setLabPreset(id: LabPresetId): void;
  /** The HUD's Reset: the scene's set put back. */
  reset(): void;
  /** The HUD's time scale: a fixed one, or null for the automatic slow-mo. */
  setTimeScale(value: number | null): void;
  /** Lab item `thing` let go at `velocity` (m/s). */
  flickLab(thing: number, velocity: THREE.Vector3): void;
  advance(seconds: number, opts?: { frameDt?: number; render?: boolean }): void;
  start(): void;
  setFxTier(tier: FxTier): void;
  setFxAuto(): void;
  /** The Sky setting. */
  setSky(mode: SkyMode): void;
  /** Fetch the Ultra look (the `ultra=1` arm needs it in before its first block); false when it did not load. */
  loadUltra(): Promise<boolean>;
  benchParts(): BenchParts;
  /** Every non-police car wears `style` (null: the fleet's mix). */
  useOneBody(style: CarStyleId | null): void;
  /** The run's crash as the reel plays it from this frame on (the clip's size on the wire), and the end of that reel; the reel's sim step ms since the last read. */
  playBenchReel(clip: HighlightClip): Promise<number>;
  stopBenchReel(): void;
  takeReelStepMs(): number;
}

// ponytail: executor form, the project's TS lib predates Promise.withResolvers.
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

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
function overlay(loopProgress: string | null): {
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
    set: (text) => void (pre.textContent = loopProgress === null ? text : `${text} · ${loopProgress}`),
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
      // The card covers most of the screen: Hide, at its top so a short screen never has to scroll to it, folds it to its receipt
      // line and buttons; Show brings the text back.
      const hide = document.createElement("button");
      hide.textContent = "Hide";
      hide.style.cssText = `${buttonStyle};margin:0 0 6px`;
      hide.onclick = () => {
        const shown = pre.style.display !== "none";
        pre.style.display = shown ? "none" : "";
        copy.style.display = shown ? "none" : "";
        hide.textContent = shown ? "Show card" : "Hide";
      };
      root.prepend(hide);
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

/** One frame the bench ran, as the slots of `Beat.frame`: the stamp, the wall time since the last (s), and the ms of the engine's own frame, of it the sim and the draw. */
const FRAME_NOW = 0;
const FRAME_DT = 1;
const FRAME_CPU = 2;
const FRAME_SIM = 3;
const FRAME_DRAW = 4;
const FRAME_FIELDS = 5;

/**
 * The loop's state between rAFs: the last stamp, so a frame's dt is the real interval wherever the caller picks the loop up, the
 * last frame's readings (`FRAME_*`), and the Lab bench's throws (null: a race).
 */
interface Beat {
  prev: number;
  frame: Float64Array;
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

const _launch = new THREE.Vector3();

/**
 * The Lab's sequence on the sim seconds stepped (`Tap.simS`): each `segmentS` the next throw's set loads (the player's set picker,
 * or Reset for the set already up), and `settleS` into the segment its thrower leaves at the throw's stored velocity (the player's
 * flick), so a device steps the same throws per sim-second however fast it runs.
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
  engine.flickLab(0, _launch.set(next.along, next.up, 0));
}

/** The Lab's sequence starts over now at throw `first` (an A/B block: every arm of a round replays the same throw from its set's load). */
function restartLab(run: LabRun, simS: number, first: number): void {
  run.origin = simS;
  run.first = first;
  run.segment = -1;
}

/** One rAF: the Lab's throw when one is due, then the engine handed its measured wall time through `advance` (the loop's own `tickInner`), timed together. Writes the frame to `beat.frame`. */
async function frame(engine: BenchEngine, renderer: THREE.WebGLRenderer, t: Tap, beat: Beat): Promise<void> {
  const now = await nextFrame();
  const dt = Math.min(0.1, (now - beat.prev) / 1000);
  beat.prev = now;
  t.collect();
  renderer.info.reset();
  t.simMs = t.drawMs = 0;
  const f0 = performance.now();
  if (beat.lab) driveLab(engine, t, beat.lab);
  engine.advance(dt, { frameDt: dt, render: true });
  beat.frame[FRAME_NOW] = now;
  beat.frame[FRAME_DT] = dt;
  beat.frame[FRAME_CPU] = performance.now() - f0;
  beat.frame[FRAME_SIM] = t.simMs;
  beat.frame[FRAME_DRAW] = t.drawMs;
}

/** Counts one frame in `slot`; a slot joins `order` the first time it is counted, so the shares come out in the order first seen. Returns the slots seen so far. */
function countSlot(counts: Float64Array, order: Uint8Array, seen: number, slot: number): number {
  if (counts[slot] === 0) order[seen++] = slot;
  counts[slot] = counts[slot]! + 1;
  return seen;
}

/** `measureS` wall seconds of one sample per frame, the engine's own auto FX tier and pacer as they are. */
async function sample(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, ui: { set(text: string): void }): Promise<{ s: Samples; w: Window; longTasks: LongTasks | null }> {
  const { renderer, cine } = parts;
  const arr = (): Float64Array => new Float64Array(CAP);
  const s: Samples = {
    n: 0,
    iv: arr(),
    cpu: arr(),
    sim: arr(),
    draw: arr(),
    steps: arr(),
    coarse: arr(),
    wrecks: arr(),
    calls: arr(),
    tris: arr(),
    tierCounts: new Float64Array(FX_TIERS.length),
    tierOrder: new Uint8Array(FX_TIERS.length),
    tiersSeen: 0,
    levelCounts: new Float64Array(RUNG_SLOTS),
    levelOrder: new Uint8Array(RUNG_SLOTS),
    levelsSeen: 0,
  };
  const pace = engine.pace;
  const lost0 = pace.lost;
  const cut0 = pace.cut;
  const fine0 = parts.world.fineCuts;
  const clock0 = t.simS;
  const thrown0 = beat.lab?.throws ?? 0;
  const ragdoll0 = parts.ragdoll.stats.steps;
  const work = watchWork(parts, pace);
  const longTasks = watchLongTasks();
  let wall = 0;
  let shownSecond = NaN;
  t.timing = true;
  t.block = WINDOW_BLOCK;
  while (wall < BENCH.measureS && s.n < CAP) {
    await frame(engine, renderer, t, beat);
    const f = beat.frame;
    const i = s.n++;
    wall += f[FRAME_DT]!;
    s.iv[i] = f[FRAME_DT]! * 1000;
    s.cpu[i] = f[FRAME_CPU]!;
    s.sim[i] = f[FRAME_SIM]!;
    s.draw[i] = f[FRAME_DRAW]!;
    s.steps[i] = pace.steps;
    s.coarse[i] = pace.coarse ? 1 : 0;
    s.wrecks[i] = wrecks(parts);
    s.calls[i] = renderer.info.render.calls;
    s.tris[i] = renderer.info.render.triangles;
    s.tiersSeen = countSlot(s.tierCounts, s.tierOrder, s.tiersSeen, FX_TIERS.indexOf(cine.tier));
    s.levelsSeen = countSlot(s.levelCounts, s.levelOrder, s.levelsSeen, rungSlot(parts.detail.level));
    const second = Math.round(wall);
    if (second === shownSecond) continue;
    shownSecond = second;
    ui.set(`CRUSH BENCH: measuring ${second} / ${BENCH.measureS} s`);
  }
  t.timing = false;
  const { phaseMs, counts } = work.end();
  return {
    s,
    w: { wallS: wall, lostSimS: pace.lost - lost0, cutFrames: pace.cut - cut0, fineCuts: parts.world.fineCuts - fine0, clockS: t.simS - clock0, thrown: (beat.lab?.throws ?? 0) - thrown0, ragdoll: ragdollCost(parts.ragdoll.stats, ragdoll0), phaseMs, counts },
    longTasks: longTasks.stop(),
  };
}

/** One setting of an A/B: `set` flips it before its block. */
interface Arm {
  key: string;
  set(): void | Promise<void>;
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
      await a.set();
      ui.set(`CRUSH BENCH: ${title} ${a.key}, round ${c + 1} / ${cycles}`);
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
        await frame(engine, renderer, t, beat);
        const f = beat.frame;
        wall += f[FRAME_DT]!;
        acc.frames++;
        acc.sim += f[FRAME_SIM]!;
        acc.cpu += f[FRAME_CPU]!;
        acc.draw += f[FRAME_DRAW]!;
        acc.steps += engine.pace.steps;
        acc.calls += renderer.info.render.calls;
        acc.tris += renderer.info.render.triangles;
      }
      acc.wallS += wall;
      acc.clockS += t.simS - clock0;
      acc.fineCuts += parts.world.fineCuts - fine0;
    }
  }
  t.timing = false;
  return { accs, blockKeys };
}

/** The Sky setting `full`, then frames until the strip is in the dome (`BENCH.skyWaitS` at most): its decode is the page's first ask, not the arm's cost. */
async function showFullSky(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat): Promise<void> {
  engine.setSky("full");
  await waitFor(engine, parts, t, beat, BENCH.skyWaitS, () => parts.sky.textureBytes > 0);
}

/** Frames of a wait: one `frame` each, with no samples, until `done` or `limitS` wall seconds. True when `done` came first. */
async function waitFor(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, limitS: number, done: () => boolean): Promise<boolean> {
  t.timing = false;
  for (let wall = 0; !done(); wall += beat.frame[FRAME_DT]!) {
    if (wall >= limitS) return false;
    await frame(engine, parts.renderer, t, beat);
  }
  return true;
}

/** The run's own crash: the race restarts, then the first two grid cars go head-on (`RaceField.crashAtStart`) and the recorder files it. The clip, or why there is none. */
async function recordCrash(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, ui: { set(text: string): void }): Promise<HighlightClip | string> {
  const { race } = parts;
  ui.set("CRUSH BENCH: crash at the start line");
  race.reseed(BENCH.seed);
  engine.raceCommand({ type: "retry" });
  if (!(await waitFor(engine, parts, t, beat, START_WAIT_S, () => race.phase === "racing"))) return "the restarted race did not go green";
  if (!race.crashAtStart(CRASH_GAP, CRASH_SPEED)) return "fewer than two cars on the grid";
  const kept = race.recorder.ledger.kept;
  if (!(await waitFor(engine, parts, t, beat, CLIP_WAIT_S, () => kept.length > 0))) return "the crash was not filed as a highlight";
  return kept[0]!;
}

/**
 * `clip` played back as the highlight reel at each of `tiers` in turn (a restart at each: the same flight and crash every time):
 * `REPLAY_SETTLE_S` unscored (the replay's world is built on its first frames), then `REPLAY_TIER_S` scored. The reel's own sim steps are its
 * `sim` (the engine's pacer does not run while a reel plays).
 */
async function replayTiers(engine: BenchEngine, parts: BenchParts, t: Tap, beat: Beat, ui: { set(text: string): void }, clip: HighlightClip, tiers: readonly FxTier[]): Promise<{ bytes: number; arms: ReplayArm[] }> {
  const arms: ReplayArm[] = [];
  let bytes = 0;
  for (const tier of tiers) {
    ui.set(`CRUSH BENCH: replaying the crash at ${tier}`);
    engine.setFxTier(tier);
    bytes = await engine.playBenchReel(clip);
    await waitFor(engine, parts, t, beat, REPLAY_SETTLE_S, () => false);
    engine.takeReelStepMs();
    const frames: ReplayFrames = { n: 0, iv: new Float64Array(CAP), cpu: new Float64Array(CAP), sim: new Float64Array(CAP), draw: new Float64Array(CAP) };
    const ragdoll0 = parts.ragdoll.stats.steps;
    t.timing = true;
    t.block = ++t.blocks;
    const block = t.block;
    for (let wall = 0; wall < REPLAY_TIER_S && frames.n < CAP; ) {
      await frame(engine, parts.renderer, t, beat);
      const i = frames.n++;
      wall += beat.frame[FRAME_DT]!;
      frames.iv[i] = beat.frame[FRAME_DT]! * 1000;
      frames.cpu[i] = beat.frame[FRAME_CPU]!;
      frames.sim[i] = engine.takeReelStepMs();
      frames.draw[i] = beat.frame[FRAME_DRAW]!;
    }
    t.timing = false;
    arms.push({ tier, frames, block, ragdoll: ragdollCost(parts.ragdoll.stats, ragdoll0) });
  }
  engine.stopBenchReel();
  return { bytes, arms };
}

/**
 * `?bench=city`, `?bench=strip&…` or `?bench=lab` (`benchPlan`): the real game on the real clock for a fixed run, then a card of what it
 * cost. The engine's loop is stopped and each rAF hands it the measured wall time through `advance` (the real pacer deadline included),
 * so a frame is timed, not simulated. Warm-up, then `measureS` sampled with the game's own settings, then alternating A/B blocks (pacer,
 * detail, FX tier), then the crash replay. Afterwards the settings go back to automatic and the scene plays on under the card.
 * `hud` reads the HUD's state (the card keeps the settings that differ from the defaults, `bench-card.ts`); `opts.submit` posts the card's JSON (Submit button, and the bench loop's `auto` post). Null: no such bench.
 */
export async function runBench(engine: BenchEngine, hud: () => CrashHudState, search: string, opts: { submit: SubmitBench; auto: boolean; loopProgress: string | null }): Promise<BenchResult | null> {
  const plan = benchPlan(search);
  if (!plan) return null;
  const ui = overlay(opts.loopProgress);
  ui.set("CRUSH BENCH: loading…");
  const timerStepMs = timerStep();
  const batteryStart = await readBattery();
  await engine.ready;
  if (plan.ultra && !(await engine.loadUltra())) throw new Error("CRUSH BENCH: ultra=1, but the Ultra look did not load (see the console)");
  const parts = engine.benchParts();
  parts.renderer.setAnimationLoop(null);
  engine.fadeScenes = false;
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
  const beat: Beat = { prev: await nextFrame(), frame: new Float64Array(FRAME_FIELDS), lab: plan.lab ? { plan: plan.lab, origin: 0, first: 0, segment: -1, preset: null, thrown: false, throws: 0 } : null };
  const page = watchPage();
  page.phase(PHASE_WARM);
  await warmUp(() => frame(engine, parts.renderer, t, beat), { race: parts.race, simS: () => t.simS, plan, ui });
  page.phase(PHASE_WINDOW);
  const { s, w, longTasks } = await sample(engine, parts, t, beat, ui);
  const leaderWindowM = leaderAhead(parts, plan);
  const top = topTier(s, parts.cine.tier);
  const settings = settingsOf(parts, hud() as unknown as Record<string, unknown>, top);

  // The A/Bs hold the tier the window mostly ran, so the pacer arms differ in the pacer alone.
  engine.setFxTier(top);
  page.phase(PHASE_AB_PACE);
  const pace = await alternate(engine, parts, t, beat, ui, "pacer", [{ key: PACE_ARM.fine, set: () => void (engine.pace.pin = false) }, { key: PACE_ARM.coarse, set: () => void (engine.pace.pin = true) }], BENCH.paceCycles);
  engine.pace.pin = null;
  page.phase(PHASE_AB_DETAIL);
  // The detail arms run at the window's tier too (the governor is off with the tier pinned), then the governor's rung is put back.
  const detail = await alternate(engine, parts, t, beat, ui, "detail", DETAIL_ARMS.map((a) => ({ key: a.key, set: () => (a.level === null ? parts.detail.setDistances(Infinity, Infinity) : parts.detail.setLevel(a.level)) })), BENCH.detailCycles);
  parts.detail.setLevel(parts.governor.level);
  page.phase(PHASE_AB_FX);
  const fxTiers: FxTier[] = plan.ultra ? ["minimal", "low", "high", "ultra"] : ["minimal", "low", "high"];
  const fx = await alternate(engine, parts, t, beat, ui, SETTING_KEY.fx, fxTiers.map((tier) => ({ key: tier, set: () => engine.setFxTier(tier) })), BENCH.fxCycles);
  // The sky arms hold the window's tier too, with the Sky setting `full` (the whole strip, waited for: it loads when first asked) against `off`; the player's setting goes back after.
  page.phase(PHASE_AB_SKY);
  engine.setFxTier(top);
  const sky = plan.lab ? null : await alternate(engine, parts, t, beat, ui, SETTING_KEY.sky, [{ key: SKY_ARM.full, set: () => showFullSky(engine, parts, t, beat) }, { key: SKY_ARM.off, set: () => engine.setSky("off") }], BENCH.skyCycles);
  engine.setSky(settings.sky);
  // What the run was like at its end is read now: the replay starts the race over.
  const leaderEndM = leaderAhead(parts, plan);
  const summary = summarize(parts, plan, s, w, setupMs);
  page.phase(PHASE_REPLAY);
  let replayRun: { bytes: number; arms: ReplayArm[]; clip: HighlightClip } | null = null;
  let replayWhy: string | null = null;
  if (plan.lab) replayWhy = "the Lab has no race to crash";
  else {
    try {
      const clip = await recordCrash(engine, parts, t, beat, ui);
      if (typeof clip === "string") replayWhy = clip;
      else replayRun = { ...(await replayTiers(engine, parts, t, beat, ui, clip, fxTiers)), clip };
    } catch (err) {
      engine.stopBenchReel();
      replayWhy = err instanceof Error ? err.message : String(err);
    }
  }
  const pageEvents = page.stop();
  engine.setFxAuto();
  if (plan.lab) engine.setTimeScale(null);

  const gpu = await t.finish();
  const abPace = blocksOf(pace, gpu);
  const abSky = sky && blocksOf(sky, gpu);
  const abFx = blocksOf(fx, gpu);
  const device = await deviceOf(parts, timerStepMs, batteryStart);
  const windowGpu = windowGpuMs(gpu);
  const result: BenchResult = {
    ...summary,
    gpuMs: windowGpu.length ? stat(windowGpu) : null,
    replay: replayRun && replayResult(replayRun, gpu),
    replayWhy,
    pageEvents,
    longTasks,
    strip: plan.strip ? { spec: plan.strip, body: plan.body, racers: plan.racers, leaderWindowM, leaderEndM } : null,
    labThrown: plan.lab ? w.thrown : null,
    settings,
    abPace: { fine: abPace[PACE_ARM.fine]!, coarse: abPace[PACE_ARM.coarse]! },
    abFx: { minimal: abFx["minimal"]!, low: abFx["low"]!, high: abFx["high"]!, ...(plan.ultra ? { ultra: abFx["ultra"]! } : {}) },
    abDetail: blocksOf(detail, gpu),
    abSky: abSky && { full: abSky[SKY_ARM.full]!, off: abSky[SKY_ARM.off]! },
    device,
  };
  const payload = (): object => ({ at: new Date().toISOString(), url: location.href, userAgent: navigator.userAgent, hud: hudSettings(hud(), INITIAL_HUD), result: roundCard(result) });
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
