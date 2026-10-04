import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPlateaus, plateauHeight, type Plateau } from "./terrain.ts";
import { Track } from "./track.ts";
import { square } from "./track.test-util.ts";

/**
 * The terrain features the heightfield adds after the roads (terrain.ts): a plateau with a sharp-crested top and planar sides, and
 * surface paint. The `square` course's infield (x 8..112, z 8..125 clear of road and runoff) holds them.
 */

const HILL: Plateau = { x: 60, z: 60, halfX: 10, halfZ: 15, height: 3, run: [8, 8, 10, 10], round: 3, top: "concrete" };

describe("plateau height", () => {
  it("is the flat top on the top, zero beyond the feet, and one rising plane in between on each side", () => {
    // The flat top ends 3 m (the rounding) inside the nominal edges: |dx| ≤ 7, |dz| ≤ 12.
    for (const [dx, dz] of [[0, 0], [6.9, 11.9], [-6.9, -11.9], [0, 11.9], [-6.9, 0]] as const) assert.equal(plateauHeight(HILL, HILL.x + dx, HILL.z + dz), 3, `top at (${dx}, ${dz})`);
    for (const [dx, dz] of [[10 + 8 + 3.1, 0], [0, 15 + 10 + 3.1], [-(10 + 8 + 3.1), 0], [0, -(15 + 10 + 3.1)], [40, 40]] as const) assert.equal(plateauHeight(HILL, HILL.x + dx, HILL.z + dz), 0, `ground at (${dx}, ${dz})`);
    // The +z side: a 3 m rise over 10 m, 0.3 m per metre between the roundings (3 m either side of the crest at z+15 and of the foot at z+25).
    const h = (dz: number) => plateauHeight(HILL, HILL.x, HILL.z + dz);
    assert.ok(Math.abs(h(18.5) - h(19.5) - 0.3) < 1e-9 && Math.abs(h(19.5) - h(20.5) - 0.3) < 1e-9, "the plane's grade is height / run");
    assert.ok(Math.abs(h(20) - 1.5) < 1e-9, "its middle is half the height");
  });

  it("has no step above a kerb: along any line it never climbs faster than height / run, and the crest and foot are bends, not corners", () => {
    let steepest = 0;
    let kink = 0;
    for (const [ax, az, bx, bz] of [[30, 60, 90, 60], [60, 25, 60, 95], [35, 30, 85, 90], [85, 30, 35, 90]] as const) {
      const n = 600;
      let prev = -1;
      let prevGrade = 0;
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const z = az + ((bz - az) * i) / n;
        const h = plateauHeight(HILL, x, z);
        const len = Math.hypot(bx - ax, bz - az) / n;
        if (prev >= 0) {
          const grade = (h - prev) / len;
          steepest = Math.max(steepest, Math.abs(grade));
          // The grade changes by a bounded amount per centimetre-scale step: no corner.
          kink = Math.max(kink, Math.abs(grade - prevGrade));
          prevGrade = grade;
        }
        prev = h;
      }
    }
    assert.ok(steepest <= HILL.height / 8 + 1e-6, `steepest grade ${steepest.toFixed(3)} against ${(HILL.height / 8).toFixed(3)} on the shortest run`);
    assert.ok(kink < 0.02, `a corner: the grade jumps ${kink.toFixed(4)} between 10 cm steps`);
  });

  it("with no rounding the crest is a corner: the grade jumps by the whole slope across 10 cm", () => {
    const grade = (p: Plateau, dz: number) => (plateauHeight(p, HILL.x, HILL.z + dz + 0.05) - plateauHeight(p, HILL.x, HILL.z + dz - 0.05)) / 0.1;
    assert.ok(Math.abs(grade({ ...HILL, round: 0 }, 15.1) - grade({ ...HILL, round: 0 }, 14.9) + 0.3) < 1e-9, "flat, then 0.3 m per metre down");
    assert.ok(Math.abs(grade(HILL, 15.1) - grade(HILL, 14.9)) < 0.02, "the rounded crest changes grade a little at a time");
  });
});

describe("a plateau on a course", () => {
  const plain = square({ environment: { terrain: "concrete", plateaus: [HILL], paint: [{ surface: "grass", poly: [[30, 30], [90, 30], [90, 90], [30, 90]] }] } });

  it("raises the ground: the top at its height in concrete, grass on the sides it falls by, the road untouched", () => {
    const g = new Track(plain).ground();
    assert.equal(g.heightAt(60, 60), 3);
    assert.equal(g.surfaceAt(60, 60), "concrete");
    assert.equal(g.surfaceAt(60, 80), "grass", "the slope is the lawn painted under it");
    assert.ok(Math.abs(g.heightAt(60, 80) - 1.5) < 0.02, `half way down ${g.heightAt(60, 80)}`);
    assert.equal(g.heightAt(60, 95), 0);
    assert.equal(g.heightAt(0, 30), 0, "the road is flat as before");
    assert.equal(g.surfaceAt(0, 30), "asphalt");
    const n = g.normalAt(60, 80, { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(Math.atan2(Math.hypot(n.x, n.z), n.y) - Math.atan(0.3)) < 0.02, `the slope's normal is tilted ${JSON.stringify(n)}`);
  });

  it("paints bare terrain only: the polygon's lawn on concrete, never a road or what lies outside", () => {
    const g = new Track(plain).ground();
    assert.equal(g.surfaceAt(40, 50), "grass");
    assert.equal(g.surfaceAt(20, 50), "concrete", "outside the polygon the terrain stays");
    assert.equal(g.frictionAt(40, 50), 0.5);
    const road = new Track(square({ environment: { terrain: "concrete", paint: [{ surface: "grass", poly: [[-20, -20], [140, -20], [140, 160], [-20, 160]] }] } })).ground();
    assert.equal(road.surfaceAt(0, 30), "asphalt", "a polygon over the road leaves the road its surface");
    assert.equal(road.surfaceAt(-10, 30), "grass");
  });

  it("refuses a plateau that reaches a road, or past the baked ground", () => {
    assert.throws(() => new Track(square({ environment: { plateaus: [{ ...HILL, x: 400, z: 60 }] } })).ground(), /reaches past the baked ground/);
    assert.throws(() => new Track(square({ environment: { plateaus: [{ ...HILL, x: 12, z: 60 }] } })), /a road reaches the plateau/);
    // A street along z through the plateau's middle, sampled every metre as a path is.
    const street = (x: number) => ({ count: 61, x: Array(61).fill(x), z: Array.from({ length: 61 }, (_, i) => 30 + i), tx: Array(61).fill(0), tz: Array(61).fill(1), half: Array(61).fill(5), runL: Array(61).fill(2), runR: Array(61).fill(2) });
    assert.throws(() => checkPlateaus("t", [HILL], [street(60)]), /a road reaches the plateau/);
    assert.doesNotThrow(() => checkPlateaus("t", [HILL], [street(20)]), "a street beside the footprint is fine");
  });
});
