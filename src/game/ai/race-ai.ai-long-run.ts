import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AI_DIFFICULTIES, type AiDifficulty } from "./constants.ts";
import { COURSES, raced, type Summary } from "./race-ai.test-util.ts";

/**
 * Full-sanity sweeps, not per-commit tests: 8 clean AI cars raced for 3 laps on every course at every difficulty, watched for a stuck or lost
 * car, a car off the road, and the tiers' ordering. The per-commit `race-ai.test.ts` holds the same claims on the oval alone; the mistakes
 * ordering (medium makes some, easy more) needs the whole course list, since medium makes none on the oval.
 */
const total = (d: AiDifficulty, f: (r: Summary) => number): number => COURSES.reduce((a, t) => a + f(raced(t, d)), 0);

for (const difficulty of AI_DIFFICULTIES) {
  describe(`given 8 clean AI cars (aggression 0) at ${difficulty} difficulty on the grid of every course`, () => {
    for (const track of COURSES) {
      it(`when they race 3 laps on ${track.id}, then all 8 finish, they stay on the road at least 95% of the time, and the winner finishes within the time bound`, (t) => {
        const r = raced(track, difficulty);
        t.diagnostic(`${track.id} ${difficulty}: winner ${r.winner.toFixed(1)} s, best lap ${Math.min(...r.lapTimes).toFixed(2)} s, slowest lap ${Math.max(...r.lapTimes).toFixed(2)} s, on road ${(100 * r.share).toFixed(1)}%, mistakes ${r.mistakes}`);
        assert.equal(r.finished, 8, `finished ${r.finished}/8 by ${r.time.toFixed(0)} s (bound ${r.limit.toFixed(0)} s); laps ${r.laps}`);
        assert.ok(r.share >= 0.95, `on the road ${(r.share * 100).toFixed(1)}% of ${r.samples} samples`);
        assert.ok(r.winner < r.limit);
      });
    }
  });
}

describe("given 8 clean AI cars on every course at each difficulty, raced for 3 laps", () => {
  it("when easy races hard, then easy's winner is slower on every course and at least 8% slower on average, and medium's is faster than easy's", () => {
    let mean = 0;
    for (const t of COURSES) {
      const [e, m, h] = AI_DIFFICULTIES.map((d) => raced(t, d).winner);
      assert.ok(e! > h! && m! < e!, `${t.id}: winner easy ${e!.toFixed(1)} s, medium ${m!.toFixed(1)} s, hard ${h!.toFixed(1)} s`);
      mean += e! / h! / COURSES.length;
    }
    assert.ok(mean >= 1.08, `easy takes ${((mean - 1) * 100).toFixed(1)}% longer than hard on average`);
  });
});

describe("given 8 clean AI cars on every course at each difficulty", () => {
  it("when they race 3 laps, then easy makes mistakes on every course and more than medium does, and hard makes exactly none", () => {
    for (const t of COURSES) {
      assert.ok(raced(t, "easy").mistakes > 0, `${t.id}: easy made no mistake`);
      assert.equal(raced(t, "hard").mistakes, 0, t.id);
    }
    const [e, m, h] = AI_DIFFICULTIES.map((d) => total(d, (r) => r.mistakes));
    assert.ok(e! > m! && m! > 0 && h === 0, `mistakes: easy ${e}, medium ${m}, hard ${h}`);
  });
});
