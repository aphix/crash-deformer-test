import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  DIRT_EXTENT,
  DIRT_TRACK_PATHS,
  GLASS_CELL_ALPHA,
  GLASS_STREAK_ALPHA,
  HAZARD_BAND_METRES,
  TRACK_GAUGE,
  WALL_HEIGHT_METRES,
  makeBarrierTexture,
  makeConcreteWallTexture,
  makeCorrugatedTexture,
  makeDirtTexture,
  makeGlassTexture,
  makePlankTexture,
  makeRubberTexture,
  makeTyreStackTexture,
  pointOnPath,
} from "./derby-textures.ts";

const BUILDERS = {
  dirt: makeDirtTexture,
  plank: makePlankTexture,
  corrugated: makeCorrugatedTexture,
  tyre: makeTyreStackTexture,
  rubber: makeRubberTexture,
  wall: makeConcreteWallTexture,
  barrier: makeBarrierTexture,
  glass: makeGlassTexture,
} as const;

const built = new Map<keyof typeof BUILDERS, THREE.DataTexture>();
function textureOf(name: keyof typeof BUILDERS): THREE.DataTexture {
  const cached = built.get(name);
  if (cached) return cached;
  const texture = BUILDERS[name]();
  built.set(name, texture);
  return texture;
}

const CHANNELS = 4;
const OPAQUE = 255;
const BLUE_INDEX = 2;
const ALPHA_INDEX = 3;

function channelAt(texture: THREE.DataTexture, column: number, row: number, channel: number): number {
  return texture.image.data[(row * texture.image.width + column) * CHANNELS + channel];
}

function luminanceAt(texture: THREE.DataTexture, column: number, row: number): number {
  return (channelAt(texture, column, row, 0) + channelAt(texture, column, row, 1) + channelAt(texture, column, row, BLUE_INDEX)) / 3;
}

function rowMean(texture: THREE.DataTexture, row: number): number {
  let total = 0;
  for (let column = 0; column < texture.image.width; column++) total += luminanceAt(texture, column, row);
  return total / texture.image.width;
}

/** Mean luminance down a column over the rows `fromRow` up to (not including) `toRow`. */
function columnMean(texture: THREE.DataTexture, column: number, fromRow: number, toRow: number): number {
  let total = 0;
  for (let row = fromRow; row < toRow; row++) total += luminanceAt(texture, column, row);
  return total / (toRow - fromRow);
}

function dirtLuminanceAt(texture: THREE.DataTexture, worldX: number, worldZ: number): number {
  const column = Math.floor(((worldX + DIRT_EXTENT) / (2 * DIRT_EXTENT)) * texture.image.width);
  const row = Math.floor(((worldZ + DIRT_EXTENT) / (2 * DIRT_EXTENT)) * texture.image.height);
  return luminanceAt(texture, column, row);
}

function firstMismatch(first: THREE.DataTexture, second: THREE.DataTexture): number {
  for (let index = 0; index < first.image.data.length; index++) {
    if (first.image.data[index] !== second.image.data[index]) return index;
  }
  return -1;
}

describe("given each procedural arena texture", () => {
  const shapeCases = [
    { it: "when the dirt is built, then it is 1024 x 1024, clamped, opaque", builder: "dirt", width: 1024, height: 1024, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, hasTranslucentTexel: false },
    { it: "when the planks are built, then they are 256 x 256, repeating, opaque", builder: "plank", width: 256, height: 256, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, hasTranslucentTexel: false },
    { it: "when the corrugated metal is built, then it is 128 x 128, repeating, opaque", builder: "corrugated", width: 128, height: 128, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, hasTranslucentTexel: false },
    { it: "when the tyre stack is built, then it is 128 x 128, repeating, opaque", builder: "tyre", width: 128, height: 128, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, hasTranslucentTexel: false },
    { it: "when the rubber is built, then it is 64 x 64, repeating, opaque", builder: "rubber", width: 64, height: 64, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, hasTranslucentTexel: false },
    { it: "when the concrete wall is built, then it is 256 x 256, repeating along, clamped up, opaque", builder: "wall", width: 256, height: 256, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, hasTranslucentTexel: false },
    { it: "when the barrier is built, then it is 128 x 128, repeating, opaque", builder: "barrier", width: 128, height: 128, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, hasTranslucentTexel: false },
    { it: "when the glass is built, then it is 256 x 256, repeating along, clamped up, with translucent texels", builder: "glass", width: 256, height: 256, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, hasTranslucentTexel: true },
  ] as const;

  for (const testCase of shapeCases) {
    it(testCase.it, () => {
      const texture = textureOf(testCase.builder);
      let translucentTexels = 0;
      for (let index = ALPHA_INDEX; index < texture.image.data.length; index += CHANNELS) {
        if (texture.image.data[index] < OPAQUE) translucentTexels++;
      }
      assert.equal(texture.image.width, testCase.width, "width");
      assert.equal(texture.image.height, testCase.height, "height");
      assert.equal(texture.wrapS, testCase.wrapS, "wrapS");
      assert.equal(texture.wrapT, testCase.wrapT, "wrapT");
      assert.equal(texture.colorSpace, THREE.SRGBColorSpace, "colour space");
      assert.equal(texture.generateMipmaps, true, "mipmaps");
      assert.equal(translucentTexels > 0, testCase.hasTranslucentTexel, "has translucent texels");
    });
  }

  const determinismCases = [
    { it: "when the dirt texture is built twice, then no texel differs", builder: "dirt" },
    { it: "when the plank texture is built twice, then no texel differs", builder: "plank" },
    { it: "when the corrugated texture is built twice, then no texel differs", builder: "corrugated" },
    { it: "when the tyre texture is built twice, then no texel differs", builder: "tyre" },
    { it: "when the rubber texture is built twice, then no texel differs", builder: "rubber" },
    { it: "when the wall texture is built twice, then no texel differs", builder: "wall" },
    { it: "when the barrier texture is built twice, then no texel differs", builder: "barrier" },
    { it: "when the glass texture is built twice, then no texel differs", builder: "glass" },
  ] as const;

  for (const testCase of determinismCases) {
    it(testCase.it, () => {
      assert.equal(firstMismatch(textureOf(testCase.builder), BUILDERS[testCase.builder]()), -1, "first mismatching byte index");
    });
  }
});

describe("given the plank texture", () => {
  const plankCases = [
    { it: "when the first plank edge row meets its body row, then the gap is darker", gapRow: 0, bodyRow: 32 },
    { it: "when the second plank edge row meets its body row, then the gap is darker", gapRow: 64, bodyRow: 96 },
    { it: "when the third plank edge row meets its body row, then the gap is darker", gapRow: 128, bodyRow: 160 },
    { it: "when the fourth plank edge row meets its body row, then the gap is darker", gapRow: 192, bodyRow: 224 },
  ] as const;
  const GAP_BRIGHTNESS_SHARE = 0.5;

  for (const testCase of plankCases) {
    it(testCase.it, () => {
      const texture = textureOf("plank");
      assert.ok(rowMean(texture, testCase.gapRow) < rowMean(texture, testCase.bodyRow) * GAP_BRIGHTNESS_SHARE, "gap row mean luminance");
    });
  }
});

describe("given the corrugated metal texture", () => {
  const ribCases = [
    { it: "when the first rib crest meets the trough beside it, then the crest is brighter", crestColumn: 0, troughColumn: 13 },
    { it: "when the second rib crest meets the trough beside it, then the crest is brighter", crestColumn: 26, troughColumn: 38 },
    { it: "when the third rib crest meets the trough beside it, then the crest is brighter", crestColumn: 51, troughColumn: 64 },
    { it: "when the fourth rib crest meets the trough beside it, then the crest is brighter", crestColumn: 77, troughColumn: 90 },
    { it: "when the fifth rib crest meets the trough beside it, then the crest is brighter", crestColumn: 102, troughColumn: 115 },
  ] as const;

  for (const testCase of ribCases) {
    it(testCase.it, () => {
      const texture = textureOf("corrugated");
      const height = texture.image.height;
      assert.ok(columnMean(texture, testCase.crestColumn, 0, height) > columnMean(texture, testCase.troughColumn, 0, height), "crest column mean over trough column mean");
    });
  }
});

describe("given the tyre stack texture", () => {
  const TREAD_RING_OFFSET = 27;
  const SIDEWALL_OFFSET = 17;
  const tyreCases = [
    { it: "when the hole of a first-row tyre meets its tread ring, then the hole is darker", centreColumn: 32, centreRow: 32 },
    { it: "when the hole of a staggered second-row tyre meets its tread ring, then the hole is darker", centreColumn: 64, centreRow: 96 },
  ] as const;

  for (const testCase of tyreCases) {
    it(testCase.it, () => {
      const texture = textureOf("tyre");
      const hole = luminanceAt(texture, testCase.centreColumn, testCase.centreRow);
      const sidewall = luminanceAt(texture, testCase.centreColumn + SIDEWALL_OFFSET, testCase.centreRow);
      const treadRing = luminanceAt(texture, testCase.centreColumn + TREAD_RING_OFFSET, testCase.centreRow);
      assert.ok(hole < treadRing, "hole luminance under tread ring luminance");
      assert.ok(sidewall < treadRing, "sidewall luminance under tread ring luminance");
    });
  }
});

describe("given the rubber texture", () => {
  const STUD_CENTRES = [8, 24, 40, 56];
  const BETWEEN_STUDS = [16, 32, 48];
  const EDGE_COLUMN = 0;
  const PLAIN_COLUMN = 16;

  function meanAt(texture: THREE.DataTexture, positions: number[]): number {
    let total = 0;
    for (const column of positions) {
      for (const row of positions) total += luminanceAt(texture, column, row);
    }
    return total / (positions.length * positions.length);
  }

  it("when stud centres meet the rubber between them, then the studs are lighter on average", () => {
    const texture = textureOf("rubber");
    assert.ok(meanAt(texture, STUD_CENTRES) > meanAt(texture, BETWEEN_STUDS), "mean stud luminance over mean plain luminance");
  });

  it("when the edge band column meets a plain column, then the edge band is lighter on average", () => {
    const texture = textureOf("rubber");
    assert.ok(columnMean(texture, EDGE_COLUMN, 0, texture.image.height) > columnMean(texture, PLAIN_COLUMN, 0, texture.image.height), "edge column mean over plain column mean");
  });
});

describe("given the concrete wall texture", () => {
  const rowAt = (metres: number) => Math.floor((metres / WALL_HEIGHT_METRES) * 256);
  const SEAM_BRIGHTNESS_SHARE = 0.8;
  const hazardCases = [
    { it: "when the very top row is read, then it is all hazard stripes", metres: 3.45, expectedHazard: true },
    { it: "when a row mid-band is read, then it is all hazard stripes", metres: 3.0, expectedHazard: true },
    { it: "when the lowest band row (0.6 m down) is read, then it is all hazard stripes", metres: 3.5 - HAZARD_BAND_METRES + 0.02, expectedHazard: true },
    { it: "when the row just below the band is read, then it is plain concrete", metres: 3.5 - HAZARD_BAND_METRES - 0.02, expectedHazard: false },
    { it: "when a mid-wall row is read, then it is plain concrete", metres: 2.0, expectedHazard: false },
    { it: "when a row near the foot is read, then it is plain concrete", metres: 0.2, expectedHazard: false },
  ] as const;

  for (const testCase of hazardCases) {
    it(testCase.it, () => {
      const texture = textureOf("wall");
      const row = rowAt(testCase.metres);
      let yellow = 0;
      let black = 0;
      let concrete = 0;
      for (let column = 0; column < texture.image.width; column++) {
        const red = channelAt(texture, column, row, 0);
        const green = channelAt(texture, column, row, 1);
        const blue = channelAt(texture, column, row, BLUE_INDEX);
        if (red > 200 && green > 150 && blue < 80) yellow++;
        else if (Math.max(red, green, blue) < 60) black++;
        else concrete++;
      }
      assert.equal(yellow > 0, testCase.expectedHazard, "has yellow stripe texels");
      assert.equal(black > 0, testCase.expectedHazard, "has black stripe texels");
      assert.equal(concrete > 0, !testCase.expectedHazard, "has concrete texels");
    });
  }

  it("when the panel seam column meets the middle of the panel, then the seam is darker", () => {
    const texture = textureOf("wall");
    const concreteRows = rowAt(3.5 - HAZARD_BAND_METRES);
    assert.ok(columnMean(texture, 0, 0, concreteRows) < columnMean(texture, 128, 0, concreteRows) * SEAM_BRIGHTNESS_SHARE, "seam column mean over panel column mean");
  });
});

describe("given the barrier texture", () => {
  const BASE_ROW = 3;
  const BODY_ROW = 60;
  const SHOULDER_ROW = 84;
  const BELOW_SHOULDER_ROW = 76;
  const SEAM_COLUMN = 0;
  const PANEL_COLUMN = 64;
  it("when the base, the shoulder and the seam meet the body, then the base is darker, the shoulder lighter, the seam darker", () => {
    const texture = textureOf("barrier");
    assert.ok(rowMean(texture, BASE_ROW) < rowMean(texture, BODY_ROW), "base row mean under body row mean");
    assert.ok(rowMean(texture, SHOULDER_ROW) > rowMean(texture, BELOW_SHOULDER_ROW), "shoulder row mean over body row mean");
    assert.ok(columnMean(texture, SEAM_COLUMN, 0, texture.image.height) < columnMean(texture, PANEL_COLUMN, 0, texture.image.height), "seam column mean under panel column mean");
  });
});

describe("given the glass texture", () => {
  const MULLION_COLUMN = 0;
  const MULLION_EDGE_COLUMN = 255;
  const CELL_COLUMN = 128;
  const CELL_ROW = 40;
  const TRANSOM_ROW = 84;
  const glassCases = [
    { it: "when a texel inside a cell is read, then it is translucent at the cell alpha", column: CELL_COLUMN, row: CELL_ROW, expectedAlpha: GLASS_CELL_ALPHA, expectedOpaque: false },
    { it: "when a texel on the mullion is read, then it is opaque", column: MULLION_COLUMN, row: CELL_ROW, expectedAlpha: OPAQUE, expectedOpaque: true },
    { it: "when a texel on the mullion's other edge is read, then it is opaque", column: MULLION_EDGE_COLUMN, row: CELL_ROW, expectedAlpha: OPAQUE, expectedOpaque: true },
    { it: "when a texel on a transom is read, then it is opaque", column: CELL_COLUMN, row: TRANSOM_ROW, expectedAlpha: OPAQUE, expectedOpaque: true },
  ] as const;

  for (const testCase of glassCases) {
    it(testCase.it, () => {
      const alpha = channelAt(textureOf("glass"), testCase.column, testCase.row, ALPHA_INDEX);
      assert.equal(alpha, testCase.expectedAlpha, "alpha");
      assert.equal(alpha === OPAQUE, testCase.expectedOpaque, "is opaque");
    });
  }

  it("when the frame is measured, then a mullion is 0.12 m of a 3 m panel wide and a transom recurs every 2.8 m of 8.5 m", () => {
    const texture = textureOf("glass");
    const MULLION_TEXELS = { least: 10, most: 11 };
    const EXPECTED_TRANSOMS = 4;
    let opaqueColumns = 0;
    for (let column = 0; column < texture.image.width; column++) {
      if (channelAt(texture, column, CELL_ROW, ALPHA_INDEX) === OPAQUE) opaqueColumns++;
    }
    let transomRuns = 0;
    for (let row = 0; row < texture.image.height; row++) {
      const opaque = channelAt(texture, CELL_COLUMN, row, ALPHA_INDEX) === OPAQUE;
      const previousOpaque = row > 0 && channelAt(texture, CELL_COLUMN, row - 1, ALPHA_INDEX) === OPAQUE;
      if (opaque && !previousOpaque) transomRuns++;
    }
    assert.ok(opaqueColumns >= MULLION_TEXELS.least && opaqueColumns <= MULLION_TEXELS.most, "opaque columns of a cell row");
    assert.equal(transomRuns, EXPECTED_TRANSOMS, "transom runs in a cell column");
  });

  it("when the interior alphas are scanned, then the reflection streak lifts the strongest one to the streak alpha", () => {
    const texture = textureOf("glass");
    let strongestInterior = 0;
    for (let index = ALPHA_INDEX; index < texture.image.data.length; index += CHANNELS) {
      const alpha = texture.image.data[index];
      if (alpha < OPAQUE && alpha > strongestInterior) strongestInterior = alpha;
    }
    assert.equal(strongestInterior, GLASS_STREAK_ALPHA, "strongest interior alpha");
  });
});

describe("given the dirt texture and its tyre track paths", () => {
  const TRACK_SAMPLES = 150;
  const OFF_LOOP_SAMPLES = 600;
  const MIN_METRES_OFF = 1;
  const LATTICE_STEP = 1.5;
  const LATTICE_REACH = 33;
  const TRACK_DARKER_SHARE = 0.85;
  const RIDGE_OFFSET = 0.22;
  const PLAIN_OFFSET = 0.9;
  const GRIT_ADJACENT_LIMIT = 6;
  const lapOffsetOfOuterLap = 1;

  function strokePoints(lap: number, samples: number) {
    const points = [];
    for (const path of DIRT_TRACK_PATHS) {
      for (let sample = 0; sample < samples; sample++) {
        const point = pointOnPath(path, sample / samples, lap);
        for (const side of [-1, 1]) {
          points.push({ x: point.x - point.headingZ * side * (TRACK_GAUGE / 2), z: point.z + point.headingX * side * (TRACK_GAUGE / 2), side, headingX: point.headingX, headingZ: point.headingZ });
        }
      }
    }
    return points;
  }

  function offLoopMeanLuminance(texture: THREE.DataTexture): number {
    const strokes = [0, 1, 2].flatMap((lap) => strokePoints(lap, OFF_LOOP_SAMPLES));
    let total = 0;
    let count = 0;
    for (let worldX = -LATTICE_REACH; worldX <= LATTICE_REACH; worldX += LATTICE_STEP) {
      for (let worldZ = -LATTICE_REACH; worldZ <= LATTICE_REACH; worldZ += LATTICE_STEP) {
        if (strokes.some((stroke) => (stroke.x - worldX) ** 2 + (stroke.z - worldZ) ** 2 < MIN_METRES_OFF ** 2)) continue;
        total += dirtLuminanceAt(texture, worldX, worldZ);
        count++;
      }
    }
    return total / count;
  }

  it("when texels on the track strokes meet dirt a metre off every loop, then the tracks are darker on average", () => {
    const texture = textureOf("dirt");
    const onTrack = strokePoints(0, TRACK_SAMPLES);
    let total = 0;
    for (const stroke of onTrack) total += dirtLuminanceAt(texture, stroke.x, stroke.z);
    assert.ok(total / onTrack.length < offLoopMeanLuminance(texture) * TRACK_DARKER_SHARE, "mean track luminance under mean off-loop luminance");
  });

  it("when the pushed-up edge outside the outermost lap meets plain dirt beside it, then the edge is lighter on average", () => {
    const texture = textureOf("dirt");
    const outerLap = strokePoints(lapOffsetOfOuterLap, TRACK_SAMPLES).filter((stroke) => stroke.side === 1);
    let edgeTotal = 0;
    let plainTotal = 0;
    for (const stroke of outerLap) {
      edgeTotal += dirtLuminanceAt(texture, stroke.x - stroke.headingZ * RIDGE_OFFSET, stroke.z + stroke.headingX * RIDGE_OFFSET);
      plainTotal += dirtLuminanceAt(texture, stroke.x - stroke.headingZ * PLAIN_OFFSET, stroke.z + stroke.headingX * PLAIN_OFFSET);
    }
    assert.ok(edgeTotal / outerLap.length > plainTotal / outerLap.length, "mean edge luminance over mean plain luminance");
  });

  it("when horizontally adjacent texels of plain dirt are compared, then they differ by little (smooth, not speckle)", () => {
    const texture = textureOf("dirt");
    const PROBE_ROW = 16;
    let difference = 0;
    for (let column = 0; column < texture.image.width - 1; column++) difference += Math.abs(luminanceAt(texture, column, PROBE_ROW) - luminanceAt(texture, column + 1, PROBE_ROW));
    assert.ok(difference / (texture.image.width - 1) < GRIT_ADJACENT_LIMIT, "mean adjacent texel difference");
  });
});
