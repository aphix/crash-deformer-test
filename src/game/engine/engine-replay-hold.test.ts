import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { Track, blankPoint } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };
import { agreement, recordField } from "./replay-fidelity.test-util.ts";

/**
 * The race of `replay-fidelity.test.ts`'s T-bone on the oval, with a scripted crash instead of a lucky one: at race second 1 the player's car (car 0) is put
 * 14 m behind a stopped car 1 lying across the road and driven flat out into its side. The recorder keeps that crash whatever the seed (the AI cars
 * are 6-7 s behind; a flat-out hit into a stopped car's side scores far above `MIN_SCORE`), so every seed has a clip to replay. Two seconds after
 * the player's car is a wreck whose engine still runs (a hold acts only on a racing car), the reset is held.
 */
const FIELD = { trackId: "oval", laps: 3, aiCount: 3, noReset: false, aggression: 0.35 };
const SEEDS = process.env.SEEDS ? process.env.SEEDS.split(",").map(Number) : [1, 2, 3, 4, 5, 6];
const track = new Track(oval);

describe("given a race on the oval where the player's car is driven flat out into a stopped car's side and then holds reset, put back with its damage kept", () => {
  for (const seed of SEEDS) {
    it(`when seed ${seed}'s race is recorded and each clip it kept is replayed headless, then a clip carries the held reset and every car matches the live sim at every step, to the bit`, (t) => {
      const w = makeWorld();
      w.race.enter();
      const pt = blankPoint();
      let placed = false;
      let wreckAt = -1;
      let holdAt = -1;
      try {
        const recs = recordField(w, {
          options: FIELD,
          seed,
          before: () => {
            const now = w.race.recorder.now;
            if (!placed && w.race.hud().phase === "racing" && w.race.session!.time >= 1) {
              placed = true;
              const put = (slot: number, d: number, turn: number, speed: number): void => {
                track.pointAt(d, pt);
                w.live()[slot]!.spawnFacing(pt.x, pt.z, Math.atan2(pt.tx, pt.tz) + turn, speed);
              };
              put(0, 40, 0, 20);
              put(1, 54, Math.PI / 2, 0);
              w.seat.carIndex = 0;
              w.seat.mode = "drive";
              w.seat.intent.gas = 1;
              w.onPairContact = () => {
                w.seat.mode = "follow";
                w.seat.intent.gas = 0;
                w.onPairContact = null;
              };
            }
            const car = w.live()[0]!;
            if (placed && wreckAt < 0 && car.crashed && car.deform.drivetrainAlive) wreckAt = now;
            if (wreckAt >= 0 && holdAt < 0 && now >= wreckAt + 2) {
              w.race.holdReset();
              holdAt = now;
            }
          },
          done: () => holdAt >= 0 && w.race.recorder.now > holdAt + 6,
          maxFrames: 40 * 60,
        });
        assert.ok(placed, `seed ${seed}: the crash was never scripted`);
        assert.ok(wreckAt >= 0, `seed ${seed}: the player's car never became a wreck with a running engine, so no hold could act`);
        assert.ok(recs.length >= 1, `seed ${seed}: the scripted crash kept no clip`);
        // Not vacuous: a kept clip must carry the player's car put on a spot at the hold's step (a keyframe), or the replay never meets a held reset.
        const stepTime = (clip: (typeof recs)[number]["clip"], step: number): number => {
          let at = clip.t0;
          for (let i = 0; i < step; i++) at += clip.h[i]!;
          return at;
        };
        const carriesHold = (clip: (typeof recs)[number]["clip"]): boolean =>
          clip.keyStep.some((step, k) => k > 0 && clip.cars.some((c, j) => c.slot === 0 && ((clip.keyCars[k]! >>> j) & 1) === 1) && Math.abs(stepTime(clip, step) - holdAt) < 0.1);
        assert.ok(recs.some((rec) => carriesHold(rec.clip)), `seed ${seed}: no kept clip carries the player's placement at the hold (${holdAt.toFixed(2)} s); clips start at ${recs.map((r) => r.clip.t0.toFixed(1)).join(", ")} s`);
        const rows: string[] = [];
        for (const rec of recs) {
          const a = agreement(rec, () => w.race.resetProps());
          rows.push(`${rec.clip.cars.length} cars, score ${rec.clip.score.toFixed(1)}, ${a.steps} steps, worst pose ${a.pose.max} m, velocity ${a.vel.max} m/s, crush ${a.crush.max} m, wreck flags differ ${a.wreckMismatch}`);
          assert.equal(a.pose.max, 0, `seed ${seed}: a car's pose strays from the live sim\n${rows.join("\n")}`);
          assert.equal(a.vel.max, 0, `seed ${seed}: a car's velocity strays from the live sim\n${rows.join("\n")}`);
          assert.equal(a.crush.max, 0, `seed ${seed}: a car's crush strays from the live sim\n${rows.join("\n")}`);
          assert.equal(a.wreckMismatch, 0, `seed ${seed}: a car's wreck flags differ from the live sim\n${rows.join("\n")}`);
        }
        t.diagnostic(rows.join("\n"));
      } finally {
        w.race.exit();
        setGround(null);
      }
    });
  }
});
