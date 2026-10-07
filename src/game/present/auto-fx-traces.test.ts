import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FxTier } from "./engine-post.ts";
import { AutoFx } from "./auto-fx.ts";

/**
 * Recorded frames (`auto-fx-traces.json`, from the bench page's own measurements on a desktop and on a 4x-throttled phone view): per
 * frame the wall interval the governor saw, the main thread's ms, the GPU timer's ms (-1: none) and the race clock. A trace of a
 * pinned display shows the refresh rate whatever the headroom, so the governor must read the work times.
 */
interface Trace {
  wall: number[];
  work: number[];
  gpu: number[];
  time: number[] | null;
}
const traces = JSON.parse(readFileSync(new URL("./auto-fx-traces.json", import.meta.url), "utf8")) as Record<string, Trace>;

interface Segment {
  trace: string;
  seconds: number;
}

/**
 * Feeds the segments to the governor frame by frame as the engine does: the wall interval, the PREVIOUS frame's main-thread ms, the
 * newest GPU ms (hidden for a browser with no timer), the race clock (a recorded one on its first pass, else from -4.5 s). Returns
 * every switch as [second it happened, tier], to the nearest tenth.
 */
function replay(fx: AutoFx, segments: Segment[], opts: { timer: boolean; race: boolean }): [number, FxTier][] {
  const moves: [number, FxTier][] = [];
  let t = 0;
  let clock = -4.5;
  let prevWork = 3;
  for (const seg of segments) {
    const tr = traces[seg.trace]!;
    const n = tr.wall.length;
    let segMs = 0;
    for (let i = 0; segMs < seg.seconds * 1000; i++) {
      const k = i % n;
      const ms = tr.wall[k]!;
      segMs += ms;
      t += ms;
      clock = tr.time && i < n ? tr.time[k]! : clock + ms / 1000;
      const to = fx.frame(ms, prevWork, opts.timer ? tr.gpu[k]! : -1, opts.race ? clock : null);
      prevWork = tr.work[k]!;
      if (to !== null) moves.push([Math.round(t / 100) / 10, to]);
    }
  }
  return moves;
}

describe("given recorded frames of a race that opens on a burst of load (the first seconds after green are slow while shaders and first-use assets settle)", () => {
  const raceStartCases = [
    { it: "when a 144 Hz display with a GPU timer runs the race, then it lifts to high within 8 s of green and holds it", trace: "race-start-burst-144hz", timer: true, seconds: 16, expected: [[7, "high"]] },
    { it: "when a 60 Hz display runs it with no GPU timer, then it lifts to high once the wall rate is back (6.8 s) and steps down again as the wall rate falls to 30 fps at 11 s and 16 s", trace: "race-start-burst-60hz-no-timer", timer: false, seconds: 16, expected: [[6.8, "high"], [11.4, "low"], [16, "minimal"]] },
    { it: "when a plain 60 Hz display with a GPU timer runs it, then it lifts to high shortly after the load check", trace: "race-60hz", timer: true, seconds: 16, expected: [[4, "high"]] },
  ] as const;
  for (const testCase of raceStartCases) {
    it(testCase.it, () => {
      const moves = replay(new AutoFx(true, true), [{ trace: testCase.trace, seconds: testCase.seconds }], { timer: testCase.timer, race: true });
      assert.equal(moves.join(" "), testCase.expected.join(" "));
    });
  }
});

describe("given recorded frames of a phone view whose main thread alone takes 20 ms a frame (4x CPU throttle)", () => {
  it("when it runs a race with a capable-desktop policy, then it never lifts above minimal, however long, because there is no room", () => {
    const moves = replay(new AutoFx(true, true), [{ trace: "overloaded-phone-4x-60hz", seconds: 90 }], { timer: true, race: true });
    assert.deepEqual(moves, []);
  });

  it("when it is on high after a calm start and the load then arrives, then it steps down to low and to minimal and stays there", () => {
    const moves = replay(new AutoFx(true, true), [{ trace: "calm-desktop-60hz", seconds: 6 }, { trace: "overloaded-phone-4x-60hz", seconds: 30 }], { timer: true, race: false });
    assert.deepEqual(moves, [[2.5, "high"], [8, "low"], [11.6, "minimal"]]);
  });
});

describe("given a desktop that falls to minimal under a spell of load and then recovers", () => {
  it("when the spell lasts 8 s in the middle of 90 s of calm frames, then it drops during the spell and climbs back to high afterwards, one tier at a time", () => {
    const moves = replay(new AutoFx(true, true), [{ trace: "calm-desktop-60hz", seconds: 20 }, { trace: "overloaded-phone-4x-60hz", seconds: 8 }, { trace: "calm-desktop-60hz", seconds: 90 }], { timer: true, race: false });
    assert.deepEqual(moves, [[2.5, "high"], [22.1, "low"], [25.6, "minimal"], [47.1, "low"], [56.6, "high"]]);
  });
});

describe("given the automatic tier on a desktop that holds high for minutes", () => {
  it("when it plays idle and then three races, then it asks only for high (idle, and each race's load check) and minimal (each race's start), never ultra", () => {
    const fx = new AutoFx(true, true);
    const asked = new Set<FxTier>();
    for (const m of replay(fx, [{ trace: "calm-desktop-60hz", seconds: 60 }], { timer: true, race: false })) asked.add(m[1]);
    for (let r = 0; r < 3; r++) for (const m of replay(fx, [{ trace: "calm-desktop-60hz", seconds: 60 }], { timer: true, race: true })) asked.add(m[1]);
    assert.deepEqual([...asked].sort(), ["high", "minimal"]);
  });
});
