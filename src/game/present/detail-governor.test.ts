import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DETAIL_LEVELS } from "./car-detail.ts";
import { DetailGovernor } from "./detail-governor.ts";

const LAST = DETAIL_LEVELS.length - 1;

/** A main thread that is nearly idle (ms per frame) and a browser with no GPU timer (Firefox): these tests vary the wall rate alone. */
const LIGHT_WORK_MS = 3;
const NO_GPU = -1;

/** A frame source: the interval (ms) and the sim time the pacer gave up in it (ms) of frame `i`. */
interface Frames {
  ms(i: number): number;
  lost?(i: number): number;
}

const steady = (fps: number, lostShare = 0): Frames => ({ ms: () => 1000 / fps, lost: () => (1000 / fps) * lostShare });

/** Feeds `seconds` of frames in a match; every rung the governor moved to as [second it moved, rung], to the nearest tenth. */
function run(gov: DetailGovernor, seconds: number, frames: Frames, matching = true): [number, number][] {
  const out: [number, number][] = [];
  let t = 0;
  for (let i = 0; t < seconds * 1000; i++) {
    const ms = frames.ms(i);
    t += ms;
    const to = gov.frame(ms, frames.lost?.(i) ?? 0, LIGHT_WORK_MS, NO_GPU, matching);
    if (to !== null) out.push([Math.round(t / 100) / 10, to]);
  }
  return out;
}

const seconds = (moves: [number, number][]): number[] => moves.map((m) => m[0]);
const rungs = (moves: [number, number][]): number[] => moves.map((m) => m[1]);

describe("given a match that runs under 57 fps on a phone's rung", () => {
  test("when it stays slow, then it steps one rung nearer every 3.5 s (1.5 s settle plus two slow windows) down to the last rung and no further", () => {
    const moves = run(new DetailGovernor(2), 30, steady(45));
    assert.equal(moves.length, 2);
    assert.equal(moves[0]![1], 3, "first step to rung 3");
    assert.equal(moves[1]![1], LAST, "second step to the last rung");
    assert.ok(Math.abs(moves[0]![0] - 3.5) < 0.2, `first step at ${moves[0]![0]} s`);
    assert.ok(Math.abs(moves[1]![0] - 7) < 0.3, `second step at ${moves[1]![0]} s`);
  });

  test("when the frames are fast but the pacer gives up 5 % of the sim's time, then it steps nearer too", () => {
    const moves = run(new DetailGovernor(0), 5, steady(60, 0.05));
    assert.equal(moves.length, 1);
    assert.equal(moves[0]![1], 1);
  });

  test("when the frames are fast and the pacer gives up 1 %, then that is a fine match: it never steps nearer, it steps back", () => {
    assert.deepEqual(rungs(run(new DetailGovernor(2), 30, steady(100, 0.01))), [1, 0]);
  });

  test("when one frame hitches for 400 ms among 60 fps frames, then it never steps: one hitch ends one window", () => {
    const hitch: Frames = { ms: (i) => (i === 200 ? 400 : 10) };
    assert.equal(run(new DetailGovernor(0), 20, hitch).length, 0);
  });
});

describe("given a match that holds its frame rate", () => {
  test("when a phone has run fine for 10 windows, then it steps one rung back every 11.5 s, as far as the 75 m rung", () => {
    const moves = run(new DetailGovernor(2), 40, steady(60));
    assert.deepEqual(rungs(moves), [1, 0]);
    assert.ok(Math.abs(seconds(moves)[0]! - 11.5) < 0.3, `first step back at ${seconds(moves)[0]} s`);
  });

  test("when a step back is followed at once by slow windows, then the next try waits twice as long, and twice as long again, up to 80 windows", () => {
    const gov = new DetailGovernor(2);
    // Seconds of 100 fps (or 40 fps) frames the governor takes to move, and the rung it moves to.
    const untilMove = (fps: number): { s: number; to: number } => {
      let t = 0;
      for (let i = 0; i < 20000; i++) {
        t += 1000 / fps;
        const to = gov.frame(1000 / fps, 0, LIGHT_WORK_MS, NO_GPU, true);
        if (to !== null) return { s: t / 1000, to };
      }
      throw new Error("the governor never moved");
    };
    const back = untilMove(100);
    assert.equal(back.to, 1);
    assert.ok(Math.abs(back.s - 11.5) < 0.01, `first step back after ${back.s} s`);
    assert.equal(untilMove(40).to, 2, "slow at once: nearer again");
    assert.equal(gov.holdWindows, 20);
    const second = untilMove(100);
    assert.equal(second.to, 1);
    assert.ok(Math.abs(second.s - 21.5) < 0.01, `second step back after ${second.s} s`);
    assert.equal(untilMove(40).to, 2);
    assert.equal(gov.holdWindows, 40);
    untilMove(100);
    untilMove(40);
    assert.equal(gov.holdWindows, 80);
    untilMove(100);
    untilMove(40);
    assert.equal(gov.holdWindows, 80, "the hold stops doubling at 80 windows");
  });

  test("when a step back holds for longer than twice its hold before a slow spell, then the hold stays", () => {
    const gov = new DetailGovernor(3);
    run(gov, 15, steady(100));
    assert.equal(gov.level, 2);
    run(gov, 70, steady(100));
    assert.equal(gov.level, 0);
    run(gov, 4, steady(30));
    assert.equal(gov.level, 1, "slow again: one rung nearer");
    assert.equal(gov.holdWindows, 10);
  });
});

describe("given the governor outside a match, at the match's start and when it is given a start rung", () => {
  test("when there is no match, then nothing is counted however slow the frames are; and a match's first 1.5 s are not counted either", () => {
    const gov = new DetailGovernor(0);
    assert.equal(run(gov, 30, steady(20), false).length, 0);
    assert.equal(gov.level, 0);
    const moves = run(gov, 4, steady(20));
    assert.ok(moves.length >= 1 && moves[0]![0] >= 3.4, `first step at ${moves[0]?.[0]} s`);
  });

  test("when the match stops and starts again, then the count starts from a fresh settle", () => {
    const gov = new DetailGovernor(0);
    assert.equal(run(gov, 3, steady(20)).length, 0, "settle plus one slow window is not two windows");
    run(gov, 5, steady(20), false);
    assert.equal(run(gov, 3, steady(20)).length, 0, "the settle ran again");
  });

  test("when the start rung is out of the ladder, then it is clamped to it", () => {
    assert.equal(new DetailGovernor(99).level, LAST);
    assert.equal(new DetailGovernor(-3).level, 0);
  });
});
