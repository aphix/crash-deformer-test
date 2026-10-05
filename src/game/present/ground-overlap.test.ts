import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "../world/track.ts";
import { OFF_MENU, TRACKS } from "../world/tracks/index.ts";
import { levelOffset } from "../world/ground-stack.ts";
import { courseLayers, depthStep, RANGE, scanOverlaps, type ScanLayer } from "./ground-overlap.test-util.ts";

/** A flat 4 × 4 m square `y` m over the ground, two triangles. */
const quad = (name: string, y: number, units: number): ScanLayer => ({
  name,
  pos: [0, y, 0, 4, y, 0, 4, y, 4, 0, y, 4],
  idx: [0, 1, 2, 0, 2, 3],
  units,
});

describe("given the scan for ground layers that z-fight (are drawn at the same depth)", () => {
  it("when the depth resolution is read, then 24 bits over 0.1 to 900 m is 13 mm at the 150 m reference and under a millimetre at 30 m", () => {
    assert.ok(Math.abs(depthStep(RANGE) - 0.0134) < 0.0005);
    assert.ok(depthStep(30) < 0.001);
  });

  it("when two layers share a plane and a depth offset (or one sits 3 cm over the other), then the whole shared square is found, and none is found once their levels give them different depth offsets", () => {
    const flat = scanOverlaps([quad("road.dirt", 0.015, 0), quad("road.asphalt", 0.015, 0)]);
    assert.equal(flat.length, 1);
    assert.ok(Math.abs(flat[0]!.area - 16) < 1e-6, "the whole 4 × 4 m square");
    // The old lift: 3 cm of height is 2 steps at 150 m, under the 3 the scan wants.
    assert.equal(scanOverlaps([quad("road.dirt", 0.03, 0), quad("road.asphalt", 0.015, 0)]).length, 1);
    const stacked = scanOverlaps([quad("road.dirt", 0.015, levelOffset("dirt").polygonOffsetUnits), quad("road.asphalt", 0.015, levelOffset("asphalt").polygonOffsetUnits)]);
    assert.deepEqual(stacked, []);
  });

  it("when a layer that a level draws in front of lies clearly below another, then it is flagged", () => {
    // Dirt (a higher level) 20 cm under asphalt: asphalt must win by height, the level order says dirt.
    const inverted = scanOverlaps([quad("road.dirt", 0, levelOffset("dirt").polygonOffsetUnits), quad("road.asphalt", 0.2, levelOffset("asphalt").polygonOffsetUnits)]);
    assert.equal(inverted.length, 1);
  });

  it("when every course's ground layers are scanned at 150 m, then under 2 m² of its whole ground is ambiguous", () => {
    for (const raw of [...TRACKS, ...OFF_MENU]) {
      const track = new Track(raw);
      const overlaps = scanOverlaps(courseLayers(track), RANGE, 0.5);
      const area = overlaps.reduce((sum, o) => sum + o.area, 0);
      assert.ok(area < 2, `${track.id}: ${area} m² ambiguous: ${overlaps.map((o) => `${o.a} over ${o.b} ${o.area} m² at ${o.x},${o.z}`).join("; ")}`);
    }
  });
});
