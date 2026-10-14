import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RaceHudRow } from "../match/types.ts";
import { STANDING_LI, withLeavers } from "./standings-motion.ts";

const row = (id: number, place: number): RaceHudRow => ({ id, name: `car ${id}`, place, lap: 1, status: "racing", gap: null, bestLap: null, you: false, watched: false });

describe("given the classes a standings row carries", () => {
  it("then it slides (a transform transition), fades through opacity (a transition, not a keyframe a moved row would restart), and fades while data-fading", () => {
    assert.match(STANDING_LI, /transition-\[transform,opacity\]/);
    assert.match(STANDING_LI, /data-\[fading\]:opacity-0/);
    assert.doesNotMatch(STANDING_LI, /animate-/);
  });
});

describe("given a car that left the standings from P2 of four", () => {
  it("when the rest stand P1 to P3, then it is put back at P2, flagged leaving", () => {
    const slots = withLeavers([row(1, 1), row(3, 2), row(4, 3)], [row(2, 2)]);
    assert.deepEqual(
      slots.map((s) => [s.row.id, s.leaving]),
      [[1, false], [2, true], [3, false], [4, false]],
    );
  });
  it("when it is back in the standings, then it is not a leaver", () => {
    const slots = withLeavers([row(1, 1), row(2, 2)], [row(2, 2)]);
    assert.deepEqual(
      slots.map((s) => s.leaving),
      [false, false],
    );
  });
});
