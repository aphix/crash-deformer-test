import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../ground.ts";
import { makeWorld, raceOnce } from "./race-world.test-util.ts";
import { parseTrack } from "./track-schema.ts";
import { Track } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";

/** Real-stack finish sweep (see race-world.test-util.ts). Seeds per course: RACE_FINISH_SEEDS (5 for the full sweep). */
const SEEDS = Number(process.env.RACE_FINISH_SEEDS ?? 2);
const COURSES = (process.env.RACE_FINISH_COURSES ?? "oval,rally,city,stunt").split(",");

describe("race finish through the real stack", () => {
  for (const course of COURSES) {
    it(`${course}: 5 AI cars finish 2 laps on every seed`, (t) => {
      const track = new Track(TRACKS.find((j) => parseTrack(j).id === course));
      // Reference lap: the course at half the sedan's top speed (9 m/s), the basis of the AI course
      // test too. Bound: the grid and countdown, then 2 laps at 3 × the reference lap.
      const refLap = track.length / 9;
      const bound = 4.5 + 2 * 3 * refLap;
      const w = makeWorld();
      w.race.enter();
      try {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const o = raceOnce(w, track, bound);
          const dnf = o.dnf.map((d) => `${d.name}: ${d.cause}`).join("; ");
          t.diagnostic(
            `${course} seed ${seed}: finished ${o.finished}/5, out ${o.out}, DNF ${o.dnf.length}${dnf ? ` [${dnf}]` : ""}, respawns ${o.respawns}, winner ${o.winner.toFixed(1)} s, slowest lap ${o.slowestLap.toFixed(1)} s (ref ${refLap.toFixed(1)} s), closed ${o.closedAt.toFixed(1)} s (bound ${bound.toFixed(0)} s)`,
          );
          assert.ok(Number.isFinite(o.closedAt), `${course} seed ${seed}: no results within ${bound.toFixed(0)} s`);
          assert.ok(o.finished + o.out >= 4, `${course} seed ${seed}: ${o.finished} finished, ${o.out} out; DNF ${dnf}`);
        }
      } finally {
        w.race.exit();
        setGround(null);
      }
    });
  }
});
