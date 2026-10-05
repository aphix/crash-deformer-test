import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { blankPoint, blankProjection, Track } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };
import { clipBytes } from "../net/reel-codec.ts";
import { agreement, recordField } from "./replay-fidelity.test-util.ts";

/**
 * The owner's rule: a replay matches the live crash it recorded, every car shown in it. A browser smoke of the oval race
 * (11 AI, police on) found a cop woken in the clip missing from its first 1.5 s (parked 5.7 km away until a later keyframe
 * put it on the road), cars drifting metres before the hit and a racer 21 m off after it. Scripted here, on any seed: the
 * race runs until a cop is put on a spot (a stakeout is parked), and the next frame two racers are put head-on on the road
 * beside it. The cop's placement is then inside the clip, and its crash is the clip's.
 */
const FIELD = { trackId: "oval", laps: 3, aiCount: 11, noReset: false, aggression: 1, police: true, spectate: true };
/** Race seconds to wait for the first stakeout (a third of the first lap in), at most. */
const WAIT_S = 120;
const SEEDS = [1, 2, 3];

describe("given the oval race with 11 AI and police on, where two racers are put head-on beside a cop that has just been placed on a stakeout spot", () => {
  for (const seed of SEEDS) {
    it(`when seed ${seed}'s clip of that crash is replayed, then it holds the head-on racers and the cop, and every car is where the live sim had it at every step`, (t) => {
      const w = makeWorld();
      w.race.enter();
      const track = new Track(oval);
      const pt = blankPoint();
      const proj = blankProjection();
      try {
        const base: number[] = [];
        let cop = -1;
        let armed = false;
        const recs = recordField(w, {
          options: FIELD,
          seed,
          before: () => {
            const cops = w.cars.length - w.race.racers.length;
            if (cop >= 0 && !armed) {
              // The frame after the cop was put on its spot: two racers head-on on the road beside it, 8 m apart at 20 m/s each.
              armed = true;
              const c = w.cars[cop]!.group.position;
              const s = track.project(c.x, c.z, -1, proj).s;
              for (const [slot, d, turn] of [[0, s, 0], [1, s + 8, Math.PI]] as const) {
                track.pointAt(d, pt);
                w.cars[slot]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz) + turn, 20);
              }
              return;
            }
            if (cops <= 0) return;
            const first = w.race.racers.length;
            for (let i = first; i < w.cars.length && cop < 0; i++) {
              base[i] ??= w.cars[i]!.placements;
              if (w.cars[i]!.placements !== base[i]) cop = i;
            }
          },
          done: () => armed && w.race.recorder.ledger.kept.length >= 1,
          maxFrames: (WAIT_S + 30) * 60,
        });
        assert.ok(cop >= 0, `seed ${seed}: no cop was put on a spot in ${WAIT_S} s of the police race`);
        const rec = recs.find((r) => r.clip.cars.some((c) => c.slot === 0) && r.clip.cars.some((c) => c.slot === 1) && r.clip.cars.some((c) => c.slot === cop));
        assert.ok(rec, `seed ${seed}: no clip holds both head-on racers and cop ${cop} (clips: ${recs.map((r) => r.clip.cars.map((c) => c.slot).join(",")).join(" | ")})`);
        const { clip } = rec;
        const a = agreement(rec, () => w.race.resetProps());
        t.diagnostic(
          `cop ${cop} of ${clip.cars.length} clip cars, ${(clipBytes(clip) / 1024).toFixed(0)} KB, ${clip.keyStep.length} keyframes, impact at ${clip.firstImpact.toFixed(2)} s: ` +
            `${a.steps} steps, worst pose ${a.pose.max} m, velocity ${a.vel.max} m/s, crush ${a.crush.max} m, wreck flags differ ${a.wreckMismatch}`,
        );
        assert.ok(a.steps >= 500, `${a.steps} steps compared`);
        assert.deepEqual({ pose: a.pose.max, vel: a.vel.max, crush: a.crush.max, wreck: a.wreckMismatch }, { pose: 0, vel: 0, crush: 0, wreck: 0 }, `seed ${seed}: a car strays from the live sim (m, m/s, m)`);
      } finally {
        w.race.exit();
        setGround(null);
      }
    });
  }
});
