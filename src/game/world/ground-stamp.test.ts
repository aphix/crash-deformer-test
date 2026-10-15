import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SURFACE_IDS } from "./catalog.ts";
import { capsuleRow } from "./ground-stamp.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";

const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_RANGE = 2 ** 32;

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return state / LCG_RANGE;
  };
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const along = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1e-12)));
  return Math.hypot(px - (ax + ex * along), pz - (az + ez * along));
}

describe("given the ground bake's row cull for a street segment", () => {
  it("when a row crosses the segment's reach, then every point on it within the reach lies inside the x run returned, and a row out of reach is refused", () => {
    const random = seededRandom(7);
    const run = new Float64Array(2);
    const reach = 20;
    let rowsInReach = 0;
    for (let trial = 0; trial < 300; trial++) {
      const [ax, az, bx, bz] = [0, 0, 0, 0].map(() => (random() - 0.5) * 120) as [number, number, number, number];
      for (let z = -80; z <= 80; z += 1) {
        const crosses = capsuleRow(ax, az, bx, bz, reach, z, run);
        let nearestInRow = Infinity;
        for (let x = -80; x <= 80; x += 0.5) {
          if (distanceToSegment(x, z, ax, az, bx, bz) > reach) continue;
          nearestInRow = Math.min(nearestInRow, x);
          assert.ok(crosses && x >= run[0]! - 1e-9 && x <= run[1]! + 1e-9, `row z=${z} of (${ax.toFixed(1)},${az.toFixed(1)})-(${bx.toFixed(1)},${bz.toFixed(1)}): x=${x} in reach, run ${crosses ? `${run[0]!.toFixed(2)}..${run[1]!.toFixed(2)}` : "refused"}`);
        }
        if (nearestInRow < Infinity) rowsInReach++;
      }
    }
    assert.ok(rowsInReach > 5000, `${rowsInReach} rows reached by a segment`);
  });
});

describe("given Havana's baked ground with a cobble side street ending at (-36.5, -46)", () => {
  const track = new Track(HAVANA);
  const ground = track.ground();
  const cobble = SURFACE_IDS.indexOf("cobble");
  const street = [...track.paths()].find((p) => p !== track.path && !p.closed && p.x[p.count - 1] === -36.5 && p.z[p.count - 1] === -46);

  it("when the street's last cells are read, then the road ends in a round cap one half-width past its end and no cobble stretches further along its line", () => {
    assert.ok(street, "the street is on the course");
    const endZ = street.z[street.count - 1]!;
    const capReach = street.half[street.count - 1]! + 1;
    const column = -37 - ground.minX;
    const cobbleBeyond: number[] = [];
    for (let z = Math.floor(endZ - capReach - 8); z <= Math.ceil(endZ - capReach); z++) {
      if (ground.surf[(z - ground.minZ) * ground.nx + column] === cobble) cobbleBeyond.push(z);
    }
    assert.deepEqual(cobbleBeyond, [], "rows of cobble past the cap, z");
    assert.equal(ground.surf[(endZ - 1 - ground.minZ) * ground.nx + column], cobble, "the street's own end is still cobble");
  });
});
