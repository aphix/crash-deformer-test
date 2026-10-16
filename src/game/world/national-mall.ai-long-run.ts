import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";

/** The longest the course's ground may take to bake (ms): 0.38 s measured alone (1.4 s with every metre of a street stamped, 2.1 s with every paint polygon tested over the whole ground), held with room for a loaded test machine. */
const BAKE_MS = 1200;

/**
 * Wall-clock watch, not a per-commit test: a loaded gate run takes several times the time of a run alone, so the per-commit
 * `national-mall.test.ts` pins the bake's work counts (`TrackGround.bakeCounts`) instead.
 */
describe("given the National Mall course loaded on its own", () => {
  const json = TRACKS.find((j) => new Track(j).id === "national-mall");
  assert.ok(json, "the race menu lists the national-mall course");
  const track = new Track(json);
  const bakeStarted = performance.now();
  track.ground();
  const bakeMs = performance.now() - bakeStarted;

  it(`when its ground (some 4 M one-metre cells under 50 streets) is baked on loading, then it takes under ${BAKE_MS / 1000} s (6.2 s before each street's straight runs were stamped once)`, () => {
    assert.ok(bakeMs < BAKE_MS, `baked in ${bakeMs.toFixed(0)} ms`);
  });
});
