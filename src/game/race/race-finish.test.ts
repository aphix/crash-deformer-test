import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../ground.ts";
import { finishSweep, makeWorld, raceOnce } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import city from "./tracks/city.json" with { type: "json" };

for (const course of ["oval", "rally", "city", "stunt"]) finishSweep(course);

describe("race finish: city traffic", () => {
  it("city at aggression 0.7, seed 1, on a fresh world: every car finishes (oncoming traffic once held the AI-driven player car nose to nose until it was DNF)", () => {
    const track = new Track(city);
    const w = makeWorld();
    w.race.enter();
    try {
      // The finish sweep's bound: the grid and countdown, then 2 laps at 3 × the 9 m/s reference lap.
      const o = raceOnce(w, track, 4.5 + 2 * 3 * (track.length / 9), 1, 0.7);
      assert.ok(Number.isFinite(o.closedAt), "the race closed");
      assert.equal(o.finished, 5, `finished ${o.finished}/5; DNF ${o.dnf.map((d) => `${d.name}: ${d.cause}`).join("; ")}`);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
