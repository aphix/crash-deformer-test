import { describe, it } from "node:test";
import { setGround } from "./ground.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import { makeWorld, raceOnce, type World } from "./race-world.test-util.ts";
import { parseTrack } from "./track-schema.ts";
import { Track } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";

const RACES = 3;
const SLIDER = 0.35;

/** One race's result and every car's final pose and body, rounded: what a replay must reproduce. */
function raceDigest(w: World, track: Track, seed: number): unknown {
  const o = raceOnce(w, track, 4.5 + 6 * (track.length / 9), seed, SLIDER);
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    outcome: o,
    cars: w.race.snapshot()!.cars.map((c) => [c.id, c.status, c.lap, r4(c.progress), c.finishTime === null ? null : r4(c.finishTime)]),
    poses: w.live().map((c) => [r4(c.group.position.x), r4(c.group.position.z), r4(c.yaw), c.deform.masses.map((m) => r4(m.local.z))]),
  };
}

describe(`given ${RACES} city races on one field, seeds 1 to ${RACES}, on cars that Retry, Next and a campaign reuse`, () => {
  it(`when the ${RACES} races run in a row on one world, then each plays out exactly as the same race on fresh cars, in outcome, final poses and bodies`, () => {
    const track = new Track(TRACKS.find((j) => parseTrack(j).id === "city"));
    // One world at a time: the active ground is process-wide (`ground.ts`), and leaving a race restores the flat one.
    const chained = makeWorld();
    chained.race.enter();
    const reused: unknown[] = [];
    try {
      for (let seed = 1; seed <= RACES; seed++) reused.push(raceDigest(chained, track, seed));
    } finally {
      chained.race.exit();
    }
    try {
      for (let seed = 1; seed <= RACES; seed++) {
        const fresh = makeWorld();
        fresh.race.enter();
        const expected = raceDigest(fresh, track, seed);
        fresh.race.exit();
        assertSameDigest(reused[seed - 1], expected, `race ${seed} on the reused field`);
      }
    } finally {
      setGround(null);
    }
  });
});
