import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { COURSE_IDS, FRAME, frame, makeWorld } from "./race-world.test-util.ts";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";

/**
 * Owner, 2026-10-03, on the stunt course: "3 of 5 AI cars become wrecks right at the start and limp around every lap".
 * The grid's two files (4 m stagger, 3-5 m off the middle) all steered for the racing line and met nose to tail there,
 * a shortcut's mouth took two cars abreast, and a pass closed to within a car length. The whole race stack headless,
 * every slot AI-driven, the first seconds of racing watched.
 */
const WATCH = 10;

/** The racers (the AI-driven player slot and `aiCount` rivals) that wreck in the first `WATCH` s of racing, each with where and against whom. */
function startWrecks(course: string, seed: number, aiCount: number, slider: number): string[] {
  const w = makeWorld();
  w.race.enter();
  try {
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { trackId: course, laps: 2, aiCount, noReset: false, aggression: slider } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    w.seat.mode = "follow";
    let touching = "";
    w.onPairContact = (a, b) => {
      touching = `cars ${a} and ${b}`;
    };
    const state = { acc: 0 };
    const wrecked = new Set<number>();
    const out: string[] = [];
    let raced = 0;
    // The grid and countdown first (bounded), then `WATCH` s of racing.
    for (let n = 0; raced < WATCH && n < 60 * 30; n++) {
      touching = "";
      frame(w, state);
      if (w.race.phase === "racing") raced += FRAME;
      for (let i = 0; i <= aiCount; i++) {
        const car = w.cars[i]!;
        if (!car.crashed || wrecked.has(i)) continue;
        wrecked.add(i);
        out.push(`car ${i} at ${raced.toFixed(2)} s, ${car.velocity.length().toFixed(1)} m/s, ${touching || "wall, prop or traffic"}`);
      }
    }
    assert.ok(raced >= WATCH, `${course} seed ${seed}: the race never got going`);
    return out;
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe("race start: clean racing wrecks nobody", () => {
  const slider = DEFAULT_RACE_OPTIONS.aggression;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`stunt (Crossover Canyon), 5 rivals at the default slider, seed ${seed}: no car wrecks in the first ${WATCH} s of racing`, () => {
      assert.deepEqual(startWrecks("stunt", seed, 5, slider), []);
    });
  }
  for (const course of COURSE_IDS.filter((id) => id !== "city")) {
    for (const seed of [1, 2, 3, 4]) {
      it(`${course}, a full 8-car grid at the default slider, seed ${seed}: no car wrecks in the first ${WATCH} s of racing`, () => {
        assert.deepEqual(startWrecks(course, seed, 7, slider), []);
      });
    }
  }
  it("city, a clean field (slider 0): the oncoming street traffic round the first corner wrecks nobody", () => {
    assert.deepEqual(startWrecks("city", 1, 5, 0), []);
  });
});

describe("race start: real fights still wreck", () => {
  it("stunt with every rival at the ramming slider: some car is wrecked in the first seconds, over 8 seeds", () => {
    let wrecks = 0;
    for (let seed = 1; seed <= 8; seed++) wrecks += startWrecks("stunt", seed, 5, 1).length;
    assert.ok(wrecks >= 8, `${wrecks} wrecks over 8 seeds`);
  });
});
