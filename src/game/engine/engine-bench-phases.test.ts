import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { COUNTER_NAMES, phaseCard, readBattery, watchLongTasks, watchWork } from "./bench-measure.ts";
import { benchRaceEngine, disposeBenchEngine, FRAME_S, runFrames } from "./engine-bench-headless.test-util.ts";
import type { CrashEngine } from "./engine.ts";
import { PHASE_NAMES, WORK_NAMES } from "./sim-phases.ts";

/** Frames the race runs unmeasured first (10 s of sim: the grid's first crashes are in), then the measured stretch (2 s). */
const WARM_FRAMES = 2400;
const WINDOW_FRAMES = 480;

/** The most of the window's sim ms the phases may leave unattributed: the pacer's loop and the pose blend between steps (measured 0.7 %, 10 s warm, 2 s window). */
const MAX_UNATTRIBUTED = 0.08;

describe("given a phase table made of a window's phase ms and counter differences", () => {
  const phaseMs = new Float64Array(PHASE_NAMES.length).fill(10);
  const counts = new Float64Array(COUNTER_NAMES.length).fill(50);

  it("when the window covered 2 sim seconds and cost 250 ms, then each phase and counter is per sim second and what the phases leave over is unattributed", () => {
    const card = phaseCard(phaseMs, counts, 250, 2);
    for (const name of PHASE_NAMES) assert.equal(card.msPerSimS[name], 5, `${name} ms per sim-second`);
    assert.equal(card.unattributedMsPerSimS, 75, "(250 - 10 phases of 10) / 2");
    for (const name of COUNTER_NAMES) assert.equal(card.workPerSimS[name], 25, `${name} per sim-second`);
  });

  it("when the window covered no sim time, then every figure is zero rather than infinite", () => {
    const card = phaseCard(phaseMs, counts, 250, 0);
    assert.equal(card.unattributedMsPerSimS, 0, "unattributed");
    assert.equal(Object.values(card.msPerSimS).every((ms) => ms === 0), true, "phases");
    assert.equal(Object.values(card.workPerSimS).every((n) => n === 0), true, "counters");
  });
});

describe("given the real engine on the city bench's race, headless", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  before(async () => {
    engine = await benchRaceEngine();
    runFrames(engine, WARM_FRAMES);
  });
  after(() => disposeBenchEngine(engine));
  afterEach(() => {
    assert.equal(engine["world"].phases.on, false, "a window left the phase clock on");
  });

  it("when a window is watched, then its phases plus the unattributed equal the sim ms it cost, no phase is negative, the unattributed is under 8 % of it, and the phases a race always runs each hold time", () => {
    const parts = engine.benchParts();
    const pace = engine.pace;
    const run = pace.run;
    let simMs = 0;
    pace.run = (...args) => {
      const t0 = performance.now();
      run.apply(pace, args);
      simMs += performance.now() - t0;
    };
    const stepsBefore = pace.total;
    const work = watchWork(parts, pace);
    runFrames(engine, WINDOW_FRAMES);
    const { phaseMs, counts } = work.end();
    pace.run = run;
    const clockS = WINDOW_FRAMES * FRAME_S;
    const card = phaseCard(phaseMs, counts, simMs, clockS);
    let sum = card.unattributedMsPerSimS;
    for (const name of PHASE_NAMES) {
      assert.ok(card.msPerSimS[name]! >= 0, `${name} is negative`);
      sum += card.msPerSimS[name]!;
    }
    const headline = simMs / clockS;
    assert.ok(Math.abs(sum - headline) <= 1e-9 * headline, `phases + unattributed ${sum} against the sim's ${headline} ms per sim-second`);
    assert.ok(card.unattributedMsPerSimS >= 0, "the phases cannot exceed the sim's own time");
    assert.ok(card.unattributedMsPerSimS <= MAX_UNATTRIBUTED * headline, `${card.unattributedMsPerSimS} of ${headline} ms per sim-second unattributed`);
    for (const name of ["drive", "plan", "integrate", "pairs", "structure", "course", "rules", "settle"] as const) assert.ok(card.msPerSimS[name]! > 0, `${name} timed nothing`);
    if (card.workPerSimS["wreckCarSlices"]! > 0) assert.ok(card.msPerSimS["wreck"]! > 0, "wrecks stepped but the wreck phase timed nothing");
    assert.equal(counts[COUNTER_NAMES.indexOf("steps")], pace.total - stepsBefore, "the window's steps are the pacer's");
    for (const name of WORK_NAMES) assert.ok(card.workPerSimS[name]! >= 0, `${name} is negative`);
    for (const name of ["slices", "liveCarSlices", "pairTests", "prismQueries", "prismsVisited", "skins", "skinVerts"] as const) assert.ok(card.workPerSimS[name]! > 0, `${name} counted nothing`);
  });

  it("when the sim then runs unwatched, then the phase clock reads nothing", () => {
    const phases = engine["world"].phases;
    const before = phases.ms.slice();
    runFrames(engine, 60);
    for (const [i, name] of PHASE_NAMES.entries()) assert.equal(phases.ms[i], before[i], `${name} moved with the clock off`);
  });
});

describe("given a browser with long-task entries, or without", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "PerformanceObserver");
  afterEach(() => Object.defineProperty(globalThis, "PerformanceObserver", original!));

  class Supported {
    static supportedEntryTypes = ["longtask"];
    private readonly callback: (list: { getEntries(): { duration: number }[] }) => void;
    constructor(callback: (list: { getEntries(): { duration: number }[] }) => void) {
      this.callback = callback;
    }
    observe(): void {
      this.callback({ getEntries: () => [{ duration: 60 }, { duration: 110.5 }] });
    }
    takeRecords(): { duration: number }[] {
      return [{ duration: 52 }];
    }
    disconnect(): void {}
  }

  it("when the browser lists longtask, then the count, total and longest of the tasks seen, and the ones still pending at stop, are returned", () => {
    Object.defineProperty(globalThis, "PerformanceObserver", { value: Supported, configurable: true });
    const found = watchLongTasks().stop();
    assert.ok(found !== null, "long tasks are supported");
    assert.equal(found.count, 3, "count");
    assert.equal(found.totalMs, 222.5, "total ms");
    assert.equal(found.maxMs, 110.5, "longest ms");
  });

  it("when the browser does not list longtask, then there is no reading at all (null, not zero)", () => {
    Object.defineProperty(globalThis, "PerformanceObserver", { value: class { static supportedEntryTypes = ["mark"]; }, configurable: true });
    assert.equal(watchLongTasks().stop(), null);
  });
});

describe("given a browser with a battery, without one, or that refuses it", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  afterEach(() => Object.defineProperty(globalThis, "navigator", original!));
  const withNavigator = (value: object): void => void Object.defineProperty(globalThis, "navigator", { value, configurable: true });

  it("when getBattery answers, then the charging flag and level are read", async () => {
    withNavigator({ getBattery: async () => ({ charging: true, level: 0.62, chargingTime: 5, dischargingTime: Infinity }) });
    const battery = await readBattery();
    assert.ok(battery !== null, "a battery");
    assert.equal(battery.charging, true, "charging");
    assert.equal(battery.level, 0.62, "level");
    assert.equal(Object.keys(battery).length, 2, "only the two fields a card keeps");
  });

  it("when the browser has no getBattery, then there is no reading (null)", async () => {
    withNavigator({});
    assert.equal(await readBattery(), null);
  });

  it("when getBattery is refused, then the refusal is logged and the reading is none", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    withNavigator({ getBattery: async () => Promise.reject(new Error("blocked by permissions policy")) });
    assert.equal(await readBattery(), null);
    assert.equal(warn.mock.callCount(), 1, "the refusal was logged");
  });
});
