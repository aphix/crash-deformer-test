import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { DERBY_ARENA } from "./constants.ts";
import { DIRT_EXTENT, DIRT_TRACK_PATHS, TRACK_GAUGE, TRACK_LANE_WIDTH, TRACK_RIDGE_WIDTH, makeDirtTexture, pointOnPath } from "./derby-dirt-texture.ts";

const dirt = makeDirtTexture();
const CHANNELS = 4;
const OPAQUE = 255;
const ALPHA_INDEX = 3;

function luminanceAtTexel(column: number, row: number): number {
  const offset = (row * dirt.image.width + column) * CHANNELS;
  return (dirt.image.data[offset] + dirt.image.data[offset + 1] + dirt.image.data[offset + 2]) / 3;
}

function luminanceAtWorld(worldX: number, worldZ: number): number {
  const column = Math.floor(((worldX + DIRT_EXTENT) / (2 * DIRT_EXTENT)) * dirt.image.width);
  const row = Math.floor(((worldZ + DIRT_EXTENT) / (2 * DIRT_EXTENT)) * dirt.image.height);
  return luminanceAtTexel(column, row);
}

const CENTRELINE_SAMPLES = 1500;
const centreline = DIRT_TRACK_PATHS.flatMap((path) => Array.from({ length: CENTRELINE_SAMPLES + 1 }, (_, sample) => pointOnPath(path, sample / CENTRELINE_SAMPLES)));

function nearestCentrelineMetres(worldX: number, worldZ: number): number {
  let nearest = Infinity;
  for (const point of centreline) nearest = Math.min(nearest, Math.hypot(point.x - worldX, point.z - worldZ));
  return nearest;
}

/** A point `offsetMetres` to the side of a path sample counts only where its own centreline is the nearest one, to within this (m). */
const OFFSET_TOLERANCE = 0.12;

/** The luminance `offsetMetres` to the side of a path at `fraction`, or undefined where another path is nearer than the offset. */
function luminanceAtOffset(path: (typeof DIRT_TRACK_PATHS)[number], fraction: number, offsetMetres: number): number | undefined {
  const point = pointOnPath(path, fraction);
  const worldX = point.x - point.headingZ * offsetMetres;
  const worldZ = point.z + point.headingX * offsetMetres;
  if (Math.abs(nearestCentrelineMetres(worldX, worldZ) - Math.abs(offsetMetres)) > OFFSET_TOLERANCE) return undefined;
  return luminanceAtWorld(worldX, worldZ);
}

const QUERY_STRIDE = 15;

function meanLuminanceAtOffset(offsetMetres: number): { mean: number; samples: number } {
  let total = 0;
  let samples = 0;
  for (const path of DIRT_TRACK_PATHS) {
    for (let sample = 0; sample <= CENTRELINE_SAMPLES; sample += QUERY_STRIDE) {
      const luminance = luminanceAtOffset(path, sample / CENTRELINE_SAMPLES, offsetMetres);
      if (luminance === undefined) continue;
      total += luminance;
      samples++;
    }
  }
  return { mean: total / samples, samples };
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
    let total = 0;
    for (let index = 0; index < dirt.image.data.length; index += CHANNELS) total += dirt.image.data[index];
    const mean = total / (dirt.image.data.length / CHANNELS) / OPAQUE;
    assert.ok(mean >= LEAST, "mean luminance at least 0.80");
    assert.ok(mean <= MOST, "mean luminance at most 0.90");
  });

  it("when horizontally adjacent texels of plain dirt are compared, then they differ by little (smooth, not speckle)", () => {
    const PROBE_ROW = 16;
    const ADJACENT_LIMIT = 6;
    let difference = 0;
    for (let column = 0; column < dirt.image.width - 1; column++) difference += Math.abs(luminanceAtTexel(column, PROBE_ROW) - luminanceAtTexel(column + 1, PROBE_ROW));
    assert.ok(difference / (dirt.image.width - 1) < ADJACENT_LIMIT, "mean adjacent texel difference");
  });
});

describe("given the tyre track paths", () => {
  const shapeCases = [
    { it: "when the loops and arcs are counted, then there are four", shape: "ellipse", expectedCount: 4 },
    { it: "when the figure-eights are counted, then there is one", shape: "eight", expectedCount: 1 },
    { it: "when the straight skid runs are counted, then there are two", shape: "line", expectedCount: 2 },
  ] as const;

  for (const testCase of shapeCases) {
    it(testCase.it, () => {
      assert.equal(DIRT_TRACK_PATHS.filter((path) => path.shape === testCase.shape).length, testCase.expectedCount, "count");
    });
  }

  it("when the curved paths are measured, then their radii run from 8 m to 26 m", () => {
    const LEAST_RADIUS = 8;
    const MOST_RADIUS = 26;
    const curved = DIRT_TRACK_PATHS.filter((path) => path.shape !== "line");
    assert.equal(Math.min(...curved.map((path) => Math.min(path.radiusX, path.radiusZ))), LEAST_RADIUS, "smallest radius");
    assert.equal(Math.max(...curved.map((path) => Math.max(path.radiusX, path.radiusZ))), MOST_RADIUS, "largest radius");
  });

  it("when every centreline point is measured from the middle, then none comes within 4 m (the open bowl) and every lane stays on the floor", () => {
    const DEAD_MIDDLE_RADIUS = 4;
    const distances = centreline.map((point) => Math.hypot(point.x, point.z));
    assert.ok(Math.min(...distances) >= DEAD_MIDDLE_RADIUS, "nearest approach to the middle");
    assert.ok(Math.max(...distances) + TRACK_LANE_WIDTH / 2 + TRACK_RIDGE_WIDTH <= DERBY_ARENA.radius, "farthest lane edge from the middle");
  });

  it("when the gauge is read, then it is the car's wheel pair: twice CAR_HALF.x", () => {
    assert.equal(TRACK_GAUGE, 2 * CAR_HALF.x, "gauge");
  });
});

describe("given the tyre tracks laid in the dirt", () => {
  const RUT_CENTRE = TRACK_GAUGE / 2;
  const INSIDE_RUT = 0.2;
  const OUTSIDE_RUT = 0.45;
  const LANE_CENTRE = 0;
  const PLAIN = 3.4;
  const RIDGE = TRACK_LANE_WIDTH / 2 + TRACK_RIDGE_WIDTH / 2;
  const MIN_SAMPLES = 150;
  const profileCases = [
    { it: "when a rut meets the lane centre between the ruts, then the rut is at least 10 levels darker", darkerOffset: RUT_CENTRE, lighterOffset: LANE_CENTRE, leastGapLevels: 10 },
    { it: "when the lane centre meets plain dirt beside the lane, then the lane is at least 25 levels darker", darkerOffset: LANE_CENTRE, lighterOffset: PLAIN, leastGapLevels: 25 },
    { it: "when plain dirt meets the pushed-up ridge outside the lane, then the ridge is at least 5 levels lighter", darkerOffset: PLAIN, lighterOffset: RIDGE, leastGapLevels: 5 },
    { it: "when 0.2 m inside a rut on the lane side meets the lane 0.45 m from the rut's middle, then the rut is at least 6 levels darker (it is wider than 0.4 m)", darkerOffset: RUT_CENTRE - INSIDE_RUT, lighterOffset: RUT_CENTRE - OUTSIDE_RUT, leastGapLevels: 6 },
    { it: "when 0.2 m inside a rut on the outer side meets plain dirt, then the rut is at least 12 levels darker (it is wider than 0.4 m)", darkerOffset: RUT_CENTRE + INSIDE_RUT, lighterOffset: PLAIN, leastGapLevels: 12 },
  ] as const;

  for (const testCase of profileCases) {
    it(testCase.it, () => {
      const darker = meanLuminanceAtOffset(testCase.darkerOffset);
      const lighter = meanLuminanceAtOffset(testCase.lighterOffset);
      assert.ok(darker.samples >= MIN_SAMPLES, "darker offset sample count");
      assert.ok(lighter.samples >= MIN_SAMPLES, "lighter offset sample count");
      assert.ok(lighter.mean - darker.mean >= testCase.leastGapLevels, "gap between the means (levels)");
    });
  }

  it("when a full loop is read in sixteenths, then the ruts fade in and out: their contrast with plain dirt varies by at least 30 levels", () => {
    const BINS = 16;
    const SAMPLES_PER_BIN = 30;
    const FADE_RANGE_LEAST = 30;
    const contrasts = [];
    for (let bin = 0; bin < BINS; bin++) {
      let rutTotal = 0;
      let plainTotal = 0;
      let samples = 0;
      for (let sample = 0; sample < SAMPLES_PER_BIN; sample++) {
        const fraction = (bin + sample / SAMPLES_PER_BIN) / BINS;
        const rut = luminanceAtOffset(DIRT_TRACK_PATHS[0], fraction, RUT_CENTRE);
        const plain = luminanceAtOffset(DIRT_TRACK_PATHS[0], fraction, PLAIN);
        if (rut === undefined || plain === undefined) continue;
        rutTotal += rut;
        plainTotal += plain;
        samples++;
      }
      if (samples > 0) contrasts.push((plainTotal - rutTotal) / samples);
    }
    assert.ok(contrasts.length >= BINS / 2, "sixteenths with a clean reading");
    assert.ok(Math.max(...contrasts) - Math.min(...contrasts) >= FADE_RANGE_LEAST, "range of rut contrast over the loop (levels)");
  });
});
