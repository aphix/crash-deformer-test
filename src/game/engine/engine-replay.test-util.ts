import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { clipBytes } from "../net/reel-codec.ts";
import { agreement, recordField } from "./replay-fidelity.test-util.ts";

/**
 * A recorded race crash replayed headless (docs/HIGHLIGHTS.md), over many seeded races: the harness of
 * `engine-replay.test.ts` (a race is ~10 s of headless sim, a seed with its clips 12-20 s: a sweep of 64 seeds is four
 * shards of 16, each `SEEDS=17,18,... node --experimental-strip-types --test engine-replay.test.ts`).
 */

/** A ramming field (aggression 1) of 12 on the city course: crashes come in the first lap. */
const FIELD = { trackId: "city", laps: 1, aiCount: 11, noReset: false, aggression: 1 };
/** Race seconds recorded (the first lap's crashes), and the clips wanted from them. */
const RACE_S = 75;
const CLIPS = 5;

/**
 * A race with no clip by this race second gets a hit of its own: the player's car drives flat out straight ahead (the way
 * `replay-fidelity.test.ts` scripts its attacker) into the first wall it meets. A seed whose AI field races a clean lap
 * (every hit under `MIN_SCORE`) would leave nothing to replay: seed 14 of 1-64, and seed 7 once a trajectory changed.
 */
const SCRIPTED_AT = 12;

/**
 * One test per seed: its race's crashes recorded, then each clip replayed and held to the live sim: every car of it, every
 * step of it, to the bit (the pedals are on the 8-bit grid in the sim itself, so a clip holds what the sim ran). The seeds
 * of a sweep (`SEEDS=14,28 node ...` runs just those) must between them leave clips to hold: a test whose races recorded
 * nothing proves nothing.
 */
export function sweepSeeds(list: readonly number[]): void {
  const seeds = process.env.SEEDS ? process.env.SEEDS.split(",").map(Number) : list;
  const total = { clips: 0, steps: 0 };
  describe(`highlight replay, seeds ${seeds[0]} to ${seeds[seeds.length - 1]}`, () => {
    for (const seed of seeds) it(`bad: seed ${seed}: a recorded race crash replayed headless must match the live sim at every step, to the bit`, (t) => {
      const w = makeWorld();
      w.race.enter();
      try {
        const recs = recordField(w, {
          options: FIELD,
          seed,
          before: () => {
            if (w.race.recorder.now >= SCRIPTED_AT && w.race.recorder.ledger.kept.length === 0 && w.seat.mode !== "drive") {
              w.seat.mode = "drive";
              w.seat.carIndex = 0;
              w.seat.intent.gas = 1;
            }
          },
          done: () => w.race.recorder.ledger.kept.length >= CLIPS,
          maxFrames: RACE_S * 60,
        });
        assert.ok(recs.length >= 1, `seed ${seed}: no clip in ${RACE_S} s of a ramming field and a flat-out player: the recorder or the ledger saw no crash`);
        const rows: string[] = [];
        for (const rec of recs) {
          const { clip } = rec;
          const a = agreement(rec, () => w.race.resetProps());
          rows.push(
            `${clip.cars.length} cars, ${(clipBytes(clip) / 1024).toFixed(0)} KB, ${clip.keyStep.length} keyframes, score ${clip.score.toFixed(1)}, ${clip.firstB < 0 ? "wall" : "pair"} impact at ${clip.firstImpact.toFixed(2)} s: ` +
              `${a.steps} steps, worst pose ${a.pose.max} m, velocity ${a.vel.max} m/s, crush ${a.crush.max} m, wreck flags differ ${a.wreckMismatch}`,
          );
          total.steps += a.steps;
          assert.ok(a.steps >= 100, `seed ${seed}: only ${a.steps} steps compared\n${rows.join("\n")}`);
          assert.deepEqual({ pose: a.pose.max, vel: a.vel.max, crush: a.crush.max, wreck: a.wreckMismatch }, { pose: 0, vel: 0, crush: 0, wreck: 0 }, `seed ${seed}: a car strays from the live sim\n${rows.join("\n")}`);
        }
        total.clips += recs.length;
        t.diagnostic(rows.join("\n"));
      } finally {
        w.race.exit();
        setGround(null);
      }
    });
    it(`the sweep replayed at least a clip per seed`, () => {
      assert.ok(total.clips >= seeds.length && total.steps > 0, `${total.clips} clips and ${total.steps} steps over ${seeds.length} seeds`);
    });
  });
}
