import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frame, makeWorld } from "../world/race-world.test-util.ts";
import { setGround } from "../world/ground.ts";

/**
 * Full-sanity run (`npm run test:ai-long-run`): the racers-only highlight rule over whole seeded races. The rule itself is
 * pinned per commit by `engine-record.test.ts` (a staged field of racers, traffic and police, and the race's recorder
 * counting only its entrants as racers); this watches natural fields for a clip it lets through.
 */

/** Seeds tried, in order, until the clips pooled reach `MIN_CLIPS`: how busy a seeded race is moves with every trajectory change, the bars below do not. */
const SEEDS = [5, 6, 7, 8, 9, 10, 11, 12];
const MIN_CLIPS = 3;

/** A seeded 100 s city race with 8 AI, traffic and police, watched in follow mode: its racer count and the (first car, second car or -1) of each kept clip's first impact. */
function cityClips(seed: number): { racers: number; firsts: (readonly [number, number])[] } {
  const w = makeWorld();
  w.race.enter();
  try {
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { trackId: "city", laps: 2, aiCount: 8, police: true, noReset: false, aggression: 1 } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    w.seat.mode = "follow";
    const racers = w.race.racers.length;
    const state = { acc: 0 };
    for (let n = 0; n / 60 < 100 && w.race.phase !== "finished"; n++) frame(w, state);
    w.race.recorder.end();
    return { racers, firsts: w.race.recorder.ledger.kept.map((c) => [c.cars[c.firstA]!.slot, c.firstB >= 0 ? c.cars[c.firstB]!.slot : -1] as const) };
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe("given seeded 100 s city races with 8 AI, traffic and police, watched in follow mode, until their clips reach three", () => {
  it("when the highlight clips are listed, then at least 3 exist, every one has a racer in its first impact, and at least one is a racer hitting a cop or traffic car", () => {
    const pooled: { seed: number; racers: number; firsts: (readonly [number, number])[] }[] = [];
    for (const seed of SEEDS) {
      pooled.push({ seed, ...cityClips(seed) });
      if (pooled.reduce((n, r) => n + r.firsts.length, 0) >= MIN_CLIPS) break;
    }
    const total = pooled.reduce((n, r) => n + r.firsts.length, 0);
    assert.ok(total >= MIN_CLIPS, `${total} clips in ${pooled.length} races of 100 s: the field is too quiet to test`);
    for (const { seed, racers, firsts } of pooled) {
      assert.deepEqual(
        firsts.filter(([a, b]) => a >= racers && !(b >= 0 && b < racers)),
        [],
        `seed ${seed}, racers ${racers}: clips whose first impact has no racer: ${JSON.stringify(firsts)}`,
      );
    }
    assert.ok(
      pooled.some(({ racers, firsts }) => firsts.some(([a, b]) => a < racers && b >= racers)),
      `a racer's hit on a cop or traffic car is no moment: ${JSON.stringify(pooled)}`,
    );
  });
});
