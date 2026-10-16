import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { DERBY_ARENA } from "./constants.ts";
import {
  DIRT_EXTENT,
  DIRT_TRACK_PATHS,
  LANE_GRID,
  RUT_GRID,
  TRACK_GAUGE,
  TRACK_LANE_WIDTH,
  endFadeAt,
  makeDirtTexture,
  paintTracks,
  pointOnPath,
  sampleField,
  type TrackFields,
  type TrackPath,
} from "./derby-dirt-texture.ts";

const dirt = makeDirtTexture();
const CHANNELS = 4;
const OPAQUE = 255;
const ALPHA_INDEX = 3;
const FULL_TURN = 2 * Math.PI;

function luminanceAtTexel(column: number, row: number): number {
  return dirt.image.data[(row * dirt.image.width + column) * CHANNELS];
}

/** Mean luminance of the texels whose distance from the middle satisfies `inside`. */
function meanLuminanceWhere(inside: (distance: number) => boolean): number {
  let total = 0;
  let count = 0;
  for (let row = 0; row < dirt.image.height; row++) {
    for (let column = 0; column < dirt.image.width; column++) {
      const worldX = ((column + 0.5) / dirt.image.width) * 2 * DIRT_EXTENT - DIRT_EXTENT;
      const worldZ = ((row + 0.5) / dirt.image.height) * 2 * DIRT_EXTENT - DIRT_EXTENT;
      if (!inside(Math.hypot(worldX, worldZ))) continue;
      total += luminanceAtTexel(column, row);
      count++;
    }
  }
  return total / count;
}

function pathNamed(overrides: Partial<TrackPath>): TrackPath {
  return { shape: "line", x: 0, z: 0, radiusX: 15, radiusZ: 0, tilt: 0, startRadians: 0, sweepRadians: 0, strength: 1, wander: 0, feather: 6, ...overrides };
}

function unitOf(world: number): number {
  return (world + DIRT_EXTENT) / (2 * DIRT_EXTENT);
}

function laneAt(fields: TrackFields, worldX: number, worldZ: number): number {
  return sampleField(fields.lane, LANE_GRID, unitOf(worldX), unitOf(worldZ));
}

function rutAt(fields: TrackFields, worldX: number, worldZ: number): number {
  return sampleField(fields.rut, RUT_GRID, unitOf(worldX), unitOf(worldZ));
}

function ridgeAt(fields: TrackFields, worldX: number, worldZ: number): number {
  return sampleField(fields.ridge, LANE_GRID, unitOf(worldX), unitOf(worldZ));
}

describe("given the dirt texture", () => {
  it("when it is built, then it is 1024 x 1024, clamped, sRGB, mipmapped and opaque", () => {
    let translucentTexels = 0;
    for (let index = ALPHA_INDEX; index < dirt.image.data.length; index += CHANNELS) {
      if (dirt.image.data[index] < OPAQUE) translucentTexels++;
    }
    assert.equal(dirt.image.width, 1024, "width");
    assert.equal(dirt.image.height, 1024, "height");
    assert.equal(dirt.wrapS, THREE.ClampToEdgeWrapping, "wrapS");
    assert.equal(dirt.wrapT, THREE.ClampToEdgeWrapping, "wrapT");
    assert.equal(dirt.colorSpace, THREE.SRGBColorSpace, "colour space");
    assert.equal(dirt.generateMipmaps, true, "mipmaps");
    assert.equal(translucentTexels, 0, "translucent texels");
  });

  it("when it is built twice, then no texel differs (first mismatch index -1)", () => {
    const rebuilt = makeDirtTexture();
    let firstMismatch = -1;
    for (let index = 0; index < dirt.image.data.length && firstMismatch === -1; index++) {
      if (dirt.image.data[index] !== rebuilt.image.data[index]) firstMismatch = index;
    }
    assert.equal(firstMismatch, -1, "first mismatching byte index");
  });

  it("when its mean luminance is taken, then it is pale and warm: 0.80 to 0.90 of white", () => {
    const LEAST = 0.8;
    const MOST = 0.9;
    const mean = meanLuminanceWhere(() => true) / OPAQUE;
    assert.ok(mean >= LEAST, "mean luminance at least 0.80");
    assert.ok(mean <= MOST, "mean luminance at most 0.90");
  });

  it("when the ring where cars circle (24-36 m) meets the square's far corners (beyond 46 m), then the ring is at least 7% darker", () => {
    const RING_LEAST = 24;
    const RING_MOST = 36;
    const CORNER_FROM = 46;
    const RING_SHARE_MOST = 0.93;
    const ring = meanLuminanceWhere((distance) => distance >= RING_LEAST && distance <= RING_MOST);
    const corners = meanLuminanceWhere((distance) => distance > CORNER_FROM);
    assert.ok(ring < corners * RING_SHARE_MOST, "ring mean luminance under corner mean luminance");
  });

  it("when each texel is compared with its 5 x 5 neighbourhood, then 5.5% to 12% differ by over 20 levels (pebbles and grit, not smooth parchment, not noise)", () => {
    const SPAN = 2;
    const DEVIATION = 20;
    const LEAST_SHARE = 0.055;
    const MOST_SHARE = 0.12;
    let deviating = 0;
    let texels = 0;
    for (let row = SPAN; row < dirt.image.height - SPAN; row++) {
      for (let column = SPAN; column < dirt.image.width - SPAN; column++) {
        let sum = 0;
        for (let rowShift = -SPAN; rowShift <= SPAN; rowShift++) {
          for (let columnShift = -SPAN; columnShift <= SPAN; columnShift++) sum += luminanceAtTexel(column + columnShift, row + rowShift);
        }
        if (Math.abs(luminanceAtTexel(column, row) - sum / (2 * SPAN + 1) ** 2) > DEVIATION) deviating++;
        texels++;
      }
    }
    assert.ok(deviating / texels >= LEAST_SHARE, "deviating share at least 5.5%");
    assert.ok(deviating / texels <= MOST_SHARE, "deviating share at most 12%");
  });
});

describe("given the generated tyre track paths", () => {
  const familyCases = [
    { it: "when the long ring arcs (radius 20 m or more) are counted, then there are at least 15", shape: "ellipse", radiusLeast: 20, radiusMost: 40, leastCount: 15 },
    { it: "when the figure-eights are counted, then there are at least 3", shape: "eight", radiusLeast: 10, radiusMost: 15, leastCount: 3 },
    { it: "when the skid streaks 8-20 m long are counted, then there are at least 8", shape: "line", radiusLeast: 4, radiusMost: 10, leastCount: 8 },
    { it: "when the donut rings (radius 3-6 m, a full turn) are counted, then there are at least 4", shape: "ellipse", radiusLeast: 3, radiusMost: 6, leastCount: 4 },
  ] as const;

  for (const testCase of familyCases) {
    it(testCase.it, () => {
      const matching = DIRT_TRACK_PATHS.filter((path) => path.shape === testCase.shape && path.radiusX >= testCase.radiusLeast && path.radiusX <= testCase.radiusMost);
      assert.ok(matching.length >= testCase.leastCount, "matching path count");
    });
  }

  it("when the paths are counted, then there are 40 to 60", () => {
    assert.ok(DIRT_TRACK_PATHS.length >= 40, "at least 40 paths");
    assert.ok(DIRT_TRACK_PATHS.length <= 60, "at most 60 paths");
  });

  it("when open paths are checked at both ends, then each end is outside r = 38 or has faded to under 5% strength, and there are open paths ending inside to prove it", () => {
    const FADED = 0.05;
    let endsInside = 0;
    let freeEnds = 0;
    for (const path of DIRT_TRACK_PATHS) {
      if (path.shape !== "line" && path.sweepRadians >= FULL_TURN) continue;
      for (const fraction of [0, 1]) {
        const end = pointOnPath(path, fraction);
        if (Math.hypot(end.x, end.z) >= DERBY_ARENA.radius) continue;
        endsInside++;
        if (endFadeAt(path, fraction) >= FADED) freeEnds++;
      }
    }
    assert.ok(endsInside >= 40, "open path ends inside the arena");
    assert.equal(freeEnds, 0, "ends inside the arena still at 5% strength or more");
  });

  it("when open paths are checked, then every one feathers over at least 5 m (or half its length)", () => {
    const FEATHER_LEAST = 5;
    const shortest = Math.min(...DIRT_TRACK_PATHS.filter((path) => path.shape === "line").map((path) => 2 * path.radiusX));
    assert.ok(Math.min(...DIRT_TRACK_PATHS.map((path) => path.feather)) >= FEATHER_LEAST, "least feather (m)");
    assert.ok(shortest >= 2 * FEATHER_LEAST - 2, "the shortest skid (m) still tapers to a point over its half length");
  });

  it("when the gauge is read, then it is the car's wheel pair: twice CAR_HALF.x", () => {
    assert.equal(TRACK_GAUGE, 2 * CAR_HALF.x, "gauge");
  });
});

describe("given one straight skid laid alone", () => {
  const fields = paintTracks([pathNamed({})]);
  const RUT_CENTRE = TRACK_GAUGE / 2;
  const PLAIN = 3.4;
  const lane = (offset: number) => laneAt(fields, 0, offset);
  const rut = (offset: number) => rutAt(fields, 0, offset);
  const ridge = (offset: number) => ridgeAt(fields, 0, offset);
  const fieldCases = [
    { it: "when the lane centre is read, then the lane is laid (0.1 or more) and 3.4 m off it there is none", read: "lane", centre: 0, leastCentre: 0.1, away: PLAIN, mostAway: 0.001 },
    { it: "when the rut centre is read, then the rut is laid (0.1 or more) and the lane centre between the ruts has none", read: "rut", centre: RUT_CENTRE, leastCentre: 0.1, away: 0, mostAway: 0.001 },
  ] as const;

  for (const testCase of fieldCases) {
    it(testCase.it, () => {
      const read = testCase.read === "lane" ? lane : rut;
      assert.ok(read(testCase.centre) >= testCase.leastCentre, "value at the centre");
      assert.ok(read(testCase.away) <= testCase.mostAway, "value away from it");
    });
  }

  it("when the lane is read across, then it is soft and 2.4 m wide: over half its strength at 0.6 m, under 2% at 1.4 m", () => {
    assert.ok(lane(0.6) >= lane(0) * 0.5, "lane at 0.6 m");
    assert.ok(lane(TRACK_LANE_WIDTH / 2 + 0.2) <= lane(0) * 0.02, "lane at 1.4 m");
  });

  it("when a rut is read across, then it is 0.55 m wide: 30% of its strength 0.2 m off its middle on both sides, nothing 0.45 m off", () => {
    const INSIDE = 0.2;
    const OUTSIDE = 0.45;
    assert.ok(rut(RUT_CENTRE - INSIDE) >= rut(RUT_CENTRE) * 0.3, "inside, lane side");
    assert.ok(rut(RUT_CENTRE + INSIDE) >= rut(RUT_CENTRE) * 0.3, "inside, outer side");
    assert.ok(rut(RUT_CENTRE - OUTSIDE) <= rut(RUT_CENTRE) * 0.02, "outside, lane side");
    assert.ok(rut(RUT_CENTRE + OUTSIDE) <= rut(RUT_CENTRE) * 0.02, "outside, outer side");
  });

  it("when the ridge is read, then it stands just outside the lane (1.35 m), not in it and not far away", () => {
    const BESIDE_LANE = TRACK_LANE_WIDTH / 2 + 0.15;
    assert.ok(ridge(BESIDE_LANE) >= 0.05, "ridge beside the lane");
    assert.ok(ridge(0) < ridge(BESIDE_LANE), "ridge in the lane under ridge beside it");
    assert.ok(ridge(PLAIN) <= 0.001, "ridge far away");
  });

  it("when tread chevrons are counted, then they are pressed into the ruts and not between them", () => {
    const WIDTH = 0.3;
    const cellMetres = (2 * DIRT_EXTENT) / 1024;
    let inRuts = 0;
    let between = 0;
    for (let row = 0; row < 1024; row++) {
      for (let column = 0; column < 1024; column++) {
        if (fields.tread[row * 1024 + column] === 0) continue;
        const worldZ = (row + 0.5) * cellMetres - DIRT_EXTENT;
        if (Math.abs(Math.abs(worldZ) - RUT_CENTRE) < WIDTH) inRuts++;
        else if (Math.abs(worldZ) < RUT_CENTRE - WIDTH) between++;
      }
    }
    assert.ok(inRuts >= 100, "tread texels in the ruts");
    assert.equal(between, 0, "tread texels between the ruts");
  });
});

describe("given tracks laid more than once, fading and feathering", () => {
  it("when two identical skids overlap, then the lane darkens more but less than twice (it saturates)", () => {
    const single = laneAt(paintTracks([pathNamed({})]), 0, 0);
    const double = laneAt(paintTracks([pathNamed({}), pathNamed({})]), 0, 0);
    assert.ok(double > single, "two passes over one");
    assert.ok(double < single * 2, "two passes under twice one");
  });

  it("when an open arc is read at its ends and its middle, then it feathers to under 20% of the middle at both ends", () => {
    const arc = pathNamed({ shape: "ellipse", x: 0, z: 0, radiusX: 12, radiusZ: 12, startRadians: 0, sweepRadians: 3, feather: 6 });
    const fields = paintTracks([arc]);
    const ENDS = 0.02;
    const at = (fraction: number) => {
      const point = pointOnPath(arc, fraction);
      return laneAt(fields, point.x, point.z);
    };
    assert.ok(at(0.5) >= 0.1, "lane at the middle");
    assert.ok(at(ENDS) <= at(0.5) * 0.2, "lane near the start");
    assert.ok(at(1 - ENDS) <= at(0.5) * 0.2, "lane near the end");
  });

  it("when a full loop is read in 48 steps, then its strength varies by at least 0.15 (it fades in and out)", () => {
    const loop = pathNamed({ shape: "ellipse", x: -2, z: 3, radiusX: 25, radiusZ: 22, sweepRadians: FULL_TURN });
    const fields = paintTracks([loop]);
    const STEPS = 48;
    const FADE_RANGE_LEAST = 0.15;
    const readings = Array.from({ length: STEPS }, (_, step) => {
      const point = pointOnPath(loop, step / STEPS);
      return laneAt(fields, point.x, point.z);
    });
    assert.ok(Math.max(...readings) - Math.min(...readings) >= FADE_RANGE_LEAST, "range of lane strength round the loop");
  });
});
