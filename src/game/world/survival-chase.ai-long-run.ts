import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chase } from "./survival-players.test-util.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";

/**
 * Full-sanity run, not the per-commit suite: a player that holds the throttle for 120 s and steers only round solids, the whole Survival stack (the pack, the rules) against it,
 * is watched for leaving the map. What pins the rim in the per-commit suite is `survival-chase.test.ts` (the flood fill and the 60 m/s launches at every kind of place on the rim).
 */

const track = new Track(HAVANA);

describe("given Havana's Survival course, a closed city with a ring of stucco blocks round it", () => {
  it("when a player holds the throttle and steers only round solids, then it stays on the map", (t) => {
    const c = chase("flee", 1, 120);
    const b = track.bounds;
    t.diagnostic(`reach x ${c.reach.minX.toFixed(0)}…${c.reach.maxX.toFixed(0)}, z ${c.reach.minZ.toFixed(0)}…${c.reach.maxZ.toFixed(0)}; ended ${c.cause} at ${c.time.toFixed(1)} s`);
    assert.ok(c.reach.minX > b.minX && c.reach.maxX < b.maxX, `drove to x ${c.reach.minX.toFixed(0)}…${c.reach.maxX.toFixed(0)}`);
    assert.ok(c.reach.minZ > b.minZ && c.reach.maxZ < b.maxZ, `drove to z ${c.reach.minZ.toFixed(0)}…${c.reach.maxZ.toFixed(0)}`);
  });
});
