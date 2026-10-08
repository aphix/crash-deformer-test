import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { pathWallColliders } from "./track-sections.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

/**
 * Where a shortcut or side street meets the main road, the main wall is open for its width. A run of the wall that ends inside
 * that mouth leaves a drawn, solid end face on the connecting road: the rally's ridge track ran into one with the cap 0.8 m
 * inside its 6 m of road, and a rival at 23 m/s died on it.
 */

/** Half the width (m) of the cars' contact footprint: a car at the edge of the road reaches this far beyond it. */
const CAR_HALF_WIDTH = 0.95;

const COURSES = [...TRACKS, ...OFF_MENU].map((json) => ({ it: parseTrack(json).id, json }));

describe("given each course's wall runs and the other roads of the course (shortcuts, side streets, branches)", () => {
  for (const testCase of COURSES) {
    it(`when the ${testCase.it} course is built, then no wall run ends within a road's half-width plus a car's half-width of that road's edge`, () => {
      const track = new Track(testCase.json);
      const paths = track.paths();
      const ground = track.ground();
      // The boxes come path by path, run by run: each path's own are `pathWallColliders`.
      const byPath = paths.map((p) => pathWallColliders(p, ground, track.json.road.wallHeight));
      const pieces = byPath.flat();
      const owner: number[] = byPath.flatMap((cs, pi) => cs.map(() => pi));
      const tight: string[] = [];
      for (const [j, c] of pieces.entries()) {
        for (const [bit, sign] of [[1, -1], [2, 1]] as const) {
          if ((c.ends & bit) === 0) continue;
          const x = c.x + Math.sin(c.yaw) * c.hz * sign;
          const z = c.z + Math.cos(c.yaw) * c.hz * sign;
          for (const [pi, p] of paths.entries()) {
            if (pi === owner[j]) continue;
            // The tightest sample of that road: how far past its edge the run end is, against what that sample's road asks for.
            let tightest = { margin: Infinity, clear: 0, half: 0, k: 0 };
            for (let k = 0; k < p.count; k++) {
              const clear = Math.hypot(p.x[k]! - x, p.z[k]! - z) - p.half[k]!;
              const margin = clear - (p.half[k]! + CAR_HALF_WIDTH);
              if (margin < tightest.margin) tightest = { margin, clear, half: p.half[k]!, k };
            }
            if (tightest.margin < 0) {
              tight.push(`a run end at (${x.toFixed(1)}, ${z.toFixed(1)}) of road ${owner[j]} is ${tightest.clear.toFixed(1)} m from the edge of road ${pi} (half-width ${tightest.half.toFixed(1)} m) at its sample ${tightest.k}`);
            }
          }
        }
      }
      assert.deepEqual(tight, []);
    });
  }
});
