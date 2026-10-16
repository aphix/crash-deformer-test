import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { levelOrder } from "../scenes/ground-stack.ts";
import { LANDING_HEIGHT, MINIGAME_MODE, MINIGAME_MODES, MODE_LABELS, START_HILL, STATION_HALF_WIDTH, type MinigameMode } from "../scenes/minigame-constants.ts";
import { floorHeightAt, lipHeight, stationBackX, stationFrontX } from "../scenes/minigame-profile.ts";
import { flatGroundTiles, makeFlatGround, makeStationSurface, STATION_SURFACE_STYLES, SURFACE_DRAW_CALL_BUDGET, SURFACE_STEP, SURFACE_TERRAIN_COLOUR, type GroundRectangle } from "./minigame-surface-art.ts";

const HEIGHT_TOLERANCE = 0.001;
const EXTENT_TOLERANCE = 0.001;
/** Area (m2) the triangles may differ from the band's: under the smallest cell (a 0.2 m edge line over one 0.2 m step is 0.04 m2). */
const COVERAGE_TOLERANCE = 0.01;
/** How far (m) the surface may sit off the floor between two vertices of a row: the chord a flat triangle cuts off a bend. */
const CHORD_TOLERANCE = 0.002;
const COLOUR_TOLERANCE = 1e-6;
/** Probe spacing (m) across the band. */
const LATERAL_PROBE_STEP = 0.05;
/** Spacing (m) of the floor's own integral, far finer than the surface's cells. */
const INTEGRAL_STEP = 0.01;
/** Share a side wall's area may differ from the floor's integral: the chords of the cells and the sliver where the floor crosses the pad's level. */
const WALL_AREA_TOLERANCE = 0.005;
/** A floor this close (m) to the pad's level has no wall. */
const LEVEL_FLOOR = 1e-4;
const AREA_TOLERANCE = 1e-6;

type Corner = { x: number; y: number; z: number };
type Triangle = { corners: readonly [Corner, Corner, Corner]; red: number; green: number; blue: number };

function surfaceMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

function surfaceTriangles(root: THREE.Object3D): Triangle[] {
  const triangles: Triangle[] = [];
  for (const mesh of surfaceMeshes(root)) {
    const positions = mesh.geometry.getAttribute("position");
    const colours = mesh.geometry.getAttribute("color");
    const cornerAt = (index: number): Corner => ({ x: positions.getX(index), y: positions.getY(index), z: positions.getZ(index) });
    for (let first = 0; first < positions.count; first += 3) {
      triangles.push({ corners: [cornerAt(first), cornerAt(first + 1), cornerAt(first + 2)], red: colours.getX(first), green: colours.getY(first), blue: colours.getZ(first) });
    }
  }
  return triangles;
}

/** A band's side wall stands in the plane of one of its two side edges: all three corners at z = +-`STATION_HALF_WIDTH`. */
function isSideWall(triangle: Triangle): boolean {
  const [first, second, third] = triangle.corners;
  return Math.abs(first.z) === STATION_HALF_WIDTH && second.z === first.z && third.z === first.z;
}

function floorTriangles(triangles: readonly Triangle[]): Triangle[] {
  return triangles.filter((triangle) => !isSideWall(triangle));
}

function cornersOf(triangles: readonly Triangle[]): Corner[] {
  return triangles.flatMap((triangle) => [...triangle.corners]);
}

function bounds(triangle: Triangle): GroundRectangle {
  const xs = triangle.corners.map((corner) => corner.x);
  const zs = triangle.corners.map((corner) => corner.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** The triangle's area seen from above. */
function footprintArea(triangle: Triangle): number {
  const [first, second, third] = triangle.corners;
  return Math.abs((second.x - first.x) * (third.z - first.z) - (third.x - first.x) * (second.z - first.z)) / 2;
}

/** The triangle's area seen from the side (along z): a wall's own area. */
function profileArea(triangle: Triangle): number {
  const [first, second, third] = triangle.corners;
  return Math.abs((second.x - first.x) * (third.y - first.y) - (third.x - first.x) * (second.y - first.y)) / 2;
}

/** The z component of the triangle's normal, from its winding. */
function normalZ(triangle: Triangle): number {
  const [first, second, third] = triangle.corners;
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function linearColour(hex: number): { red: number; green: number; blue: number } {
  const colour = new THREE.Color().setHex(hex);
  return { red: colour.r, green: colour.g, blue: colour.b };
}

function isColour(triangle: Triangle, hex: number): boolean {
  const expected = linearColour(hex);
  return Math.abs(triangle.red - expected.red) < COLOUR_TOLERANCE && Math.abs(triangle.green - expected.green) < COLOUR_TOLERANCE && Math.abs(triangle.blue - expected.blue) < COLOUR_TOLERANCE;
}

function triangleAt(triangles: readonly Triangle[], x: number, z: number): Triangle {
  const found = triangles.find((triangle) => {
    const box = bounds(triangle);
    return x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ;
  });
  assert.ok(found, `a triangle covers (${x}, ${z})`);
  return found;
}

/** The colours met walking across the band at `x`, each run once, as hex codes found in `knownColours` (-1 for any other). */
function coloursAcrossBand(triangles: readonly Triangle[], x: number, knownColours: readonly number[]): number[] {
  const runs: number[] = [];
  for (let z = -STATION_HALF_WIDTH + LATERAL_PROBE_STEP / 2; z < STATION_HALF_WIDTH; z += LATERAL_PROBE_STEP) {
    const triangle = triangleAt(triangles, x, z);
    const colour = knownColours.find((hex) => isColour(triangle, hex)) ?? -1;
    if (runs[runs.length - 1] !== colour) runs.push(colour);
  }
  return runs;
}

/** Centres of the grid's cells (grid from the lip) along the run, from the pad's end to the lip: where the lane carries its dashes, never the pad's bars. */
function cellCentresPastThePad(mode: MinigameMode): number[] {
  const firstCell = Math.ceil((stationBackX(mode) + START_HILL.padLength) / SURFACE_STEP);
  const lastCell = Math.floor(Math.min(stationFrontX(mode), 0) / SURFACE_STEP);
  return Array.from({ length: lastCell - firstCell }, (_, index) => (firstCell + index + 0.5) * SURFACE_STEP);
}

/** One corner per distinct x along the band's left edge, ascending. */
function leftEdgeColumns(corners: readonly Corner[]): Corner[] {
  const leftEdge = Math.min(...corners.map((corner) => corner.z));
  const column = corners.filter((corner) => corner.z === leftEdge).sort((a, b) => a.x - b.x);
  return column.filter((corner, index) => index === 0 || corner.x !== column[index - 1]!.x);
}

/** The floor's height integrated down the run (m2): what a side wall's area must come to. */
function floorIntegral(mode: MinigameMode): number {
  let area = 0;
  for (let x = stationBackX(mode) + INTEGRAL_STEP / 2; x < stationFrontX(mode); x += INTEGRAL_STEP) area += Math.abs(floorHeightAt(mode, x, 0) - LANDING_HEIGHT) * INTEGRAL_STEP;
  return area;
}

function overlaps(first: GroundRectangle, second: GroundRectangle): boolean {
  return first.minX < second.maxX - AREA_TOLERANCE && first.maxX > second.minX + AREA_TOLERANCE && first.minZ < second.maxZ - AREA_TOLERANCE && first.maxZ > second.minZ + AREA_TOLERANCE;
}

function area(rectangle: GroundRectangle): number {
  return (rectangle.maxX - rectangle.minX) * (rectangle.maxZ - rectangle.minZ);
}

describe("given the stations' surfaces built in node, with no document and no WebGL context", () => {
  it("when each is made, then it is one group with at most the draw-call budget of meshes", () => {
    assert.equal(Reflect.has(globalThis, "document"), false, "no document in this process");
    for (const mode of MINIGAME_MODES) {
      const group = makeStationSurface(mode, STATION_SURFACE_STYLES[mode]);
      const drawCalls = surfaceMeshes(group).length;
      assert.ok(drawCalls >= 1, `${mode} draws something`);
      assert.ok(drawCalls <= SURFACE_DRAW_CALL_BUDGET, `${mode} draws ${drawCalls} meshes, budget ${SURFACE_DRAW_CALL_BUDGET}`);
    }
  });
});

for (const mode of MINIGAME_MODES) {
  describe(`given the ${MODE_LABELS[mode]} station's surface`, () => {
    const style = STATION_SURFACE_STYLES[mode];
    const group = makeStationSurface(mode, style);
    const triangles = surfaceTriangles(group);
    const floor = floorTriangles(triangles);
    const walls = triangles.filter(isSideWall);
    const floorCorners = cornersOf(floor);

    it("when every floor vertex is compared with the floor function, then its height is the floor's at its x and z to a millimetre", () => {
      for (const corner of floorCorners) {
        const expected = floorHeightAt(mode, corner.x, corner.z);
        assert.ok(Math.abs(corner.y - expected) <= HEIGHT_TOLERANCE, `at (${corner.x}, ${corner.z}) height ${corner.y}, floor ${expected}`);
      }
    });

    it("when its extent is read, then the floor runs from the station's back to its front and across the sim ground's whole band, and the strip lies within it", () => {
      assert.ok(Math.abs(Math.min(...floorCorners.map((corner) => corner.x)) - stationBackX(mode)) <= EXTENT_TOLERANCE, "back x");
      assert.ok(Math.abs(Math.max(...floorCorners.map((corner) => corner.x)) - stationFrontX(mode)) <= EXTENT_TOLERANCE, "front x");
      assert.ok(Math.abs(Math.min(...floorCorners.map((corner) => corner.z)) + STATION_HALF_WIDTH) <= EXTENT_TOLERANCE, "left side");
      assert.ok(Math.abs(Math.max(...floorCorners.map((corner) => corner.z)) - STATION_HALF_WIDTH) <= EXTENT_TOLERANCE, "right side");
      assert.ok(style.laneHalfWidth < STATION_HALF_WIDTH, "the strip is narrower than the band");
    });

    it("when its triangles are added up as seen from above, then they cover the whole band with no hole", () => {
      const covered = floor.reduce((total, triangle) => total + footprintArea(triangle), 0);
      const band = (stationFrontX(mode) - stationBackX(mode)) * STATION_HALF_WIDTH * 2;
      assert.ok(Math.abs(covered - band) < COVERAGE_TOLERANCE, `covered ${covered} m2 of ${band} m2`);
    });

    it("when its vertex columns along the run are read, then none is farther from the next than a step and the lip is one of them at the lip's height", () => {
      const columns = leftEdgeColumns(floorCorners);
      for (let index = 1; index < columns.length; index++) {
        assert.ok(columns[index]!.x - columns[index - 1]!.x <= SURFACE_STEP + EXTENT_TOLERANCE, `gap before x ${columns[index]!.x}`);
      }
      const lip = columns.find((column) => Math.abs(column.x) <= EXTENT_TOLERANCE);
      assert.ok(lip, "a vertex column stands on the lip");
      assert.ok(Math.abs(lip.y - lipHeight(mode)) <= HEIGHT_TOLERANCE, `lip height ${lip.y}, wanted ${lipHeight(mode)}`);
    });

    it("when the surface is read between two vertices of a column, then it is within a chord tolerance of the floor", () => {
      const columns = leftEdgeColumns(floorCorners);
      for (let index = 1; index < columns.length; index++) {
        const before = columns[index - 1]!;
        const after = columns[index]!;
        const off = Math.abs((before.y + after.y) / 2 - floorHeightAt(mode, (before.x + after.x) / 2, before.z));
        assert.ok(off <= CHORD_TOLERANCE, `between x ${before.x} and ${after.x} the surface is ${off} m off the floor`);
      }
    });

    it("when the band's back and front edges are read, then both lie at the pad's level, so the flat ground beside them meets them without a step", () => {
      const edgeCorners = floorCorners.filter((corner) => Math.abs(corner.x - stationBackX(mode)) <= EXTENT_TOLERANCE || Math.abs(corner.x - stationFrontX(mode)) <= EXTENT_TOLERANCE);
      assert.ok(edgeCorners.length >= 4, "corners on both edges");
      for (const corner of edgeCorners) assert.ok(Math.abs(corner.y - LANDING_HEIGHT) <= HEIGHT_TOLERANCE, `edge corner at x ${corner.x} is ${corner.y} m high`);
    });

    it("when the band is read beside the strip, then it is terrain colour, and on the strip it is not", () => {
      const run = cellCentresPastThePad(mode);
      const beside = (style.laneHalfWidth + STATION_HALF_WIDTH) / 2;
      const probeX = run[Math.floor(run.length / 2)]!;
      for (const side of [-1, 1]) assert.ok(isColour(triangleAt(floor, probeX, side * beside), SURFACE_TERRAIN_COLOUR), `terrain beside the strip on side ${side}`);
      assert.equal(isColour(triangleAt(floor, probeX, style.laneHalfWidth / 2), SURFACE_TERRAIN_COLOUR), false, "the strip is painted");
    });

    it("when each side wall's corners are read, then its top corners are the floor's height at their x and its foot corners are the pad's level", () => {
      assert.ok(walls.length > 0, "the floor is off the pad's level somewhere, so there are walls");
      for (const corner of cornersOf(walls)) {
        const isFoot = corner.y === LANDING_HEIGHT;
        const isTop = Math.abs(corner.y - floorHeightAt(mode, corner.x, corner.z)) <= HEIGHT_TOLERANCE;
        assert.ok(isFoot || isTop, `wall corner (${corner.x}, ${corner.y}, ${corner.z}) is neither at the pad's level nor on the floor`);
      }
      for (const wall of walls) assert.ok(wall.corners.some((corner) => corner.y === LANDING_HEIGHT), "each wall triangle stands on the pad's level");
    });

    it("when the walls' areas are added up per side, then each side's wall is as large as the floor's depth or height integrated down the run", () => {
      const expected = floorIntegral(mode);
      assert.ok(expected > 0, "the floor leaves the pad's level");
      for (const side of [-1, 1]) {
        const wallArea = walls.filter((wall) => Math.sign(wall.corners[0].z) === side).reduce((total, wall) => total + profileArea(wall), 0);
        assert.ok(Math.abs(wallArea - expected) <= expected * WALL_AREA_TOLERANCE, `side ${side}: wall ${wallArea} m2, floor integral ${expected} m2`);
      }
    });

    it("when the pad at the station's back is read, then the floor there is level and no wall stands on it", () => {
      const padEndX = stationBackX(mode) + START_HILL.padLength;
      const wallsOnPad = walls.filter((wall) => wall.corners.every((corner) => corner.x <= padEndX));
      assert.equal(wallsOnPad.length, 0, "walls on the level pad");
    });

    it("when each wall's winding is read, then its visible face looks away from a raised floor's solid and into a trench", () => {
      let checkedWalls = 0;
      for (const wall of walls) {
        const heights = wall.corners.map((corner) => corner.y).filter((height) => Math.abs(height) > LEVEL_FLOOR);
        const isOneSidedAndWide = heights.length > 0 && (heights.every((height) => height > 0) || heights.every((height) => height < 0)) && profileArea(wall) > 0;
        if (!isOneSidedAndWide) continue;
        const outward = Math.sign(wall.corners[0].z);
        const raised = heights[0]! > 0;
        assert.equal(Math.sign(normalZ(wall)), raised ? outward : -outward, `wall at x ${wall.corners[0].x} on side ${outward} (${raised ? "raised" : "trench"})`);
        checkedWalls++;
      }
      assert.ok(checkedWalls >= walls.length / 2, `${checkedWalls} of ${walls.length} walls checked`);
    });
  });
}

describe("given the High jump's back drop behind the lip", () => {
  const triangles = surfaceTriangles(makeStationSurface(MINIGAME_MODE.highJump, STATION_SURFACE_STYLES.highJump));

  it("when its side walls are read, then they run down the drop to the pad's level, closing it to the front edge", () => {
    const walls = triangles.filter(isSideWall);
    const frontmostWallX = Math.max(...cornersOf(walls).map((corner) => corner.x));
    assert.ok(frontmostWallX >= stationFrontX(MINIGAME_MODE.highJump) - SURFACE_STEP - EXTENT_TOLERANCE, `walls end at x ${frontmostWallX}, the drop at ${stationFrontX(MINIGAME_MODE.highJump)}`);
    const lipWalls = walls.filter((wall) => wall.corners.some((corner) => Math.abs(corner.x) <= EXTENT_TOLERANCE) && wall.corners.some((corner) => corner.y > 0));
    assert.ok(lipWalls.length >= 2, "walls on both sides at the lip, standing on the raised floor");
  });
});

describe("given the High jump's red run-up strip with its dashed centre line", () => {
  const style = STATION_SURFACE_STYLES.highJump;
  const triangles = floorTriangles(surfaceTriangles(makeStationSurface(MINIGAME_MODE.highJump, style)));
  const runUpCellCentres = cellCentresPastThePad(MINIGAME_MODE.highJump);

  it("when the strip's middle is walked along the run-up, then dashes come and go as separate runs of the line's colour and the strip's", () => {
    const dashed = runUpCellCentres.map((x) => isColour(triangleAt(triangles, x, 0), style.centreDashColour!));
    const dashRuns = dashed.filter((isDash, index) => isDash && (index === 0 || !dashed[index - 1])).length;
    assert.ok(dashRuns >= 2, `${dashRuns} dashes along ${runUpCellCentres.length} cells`);
    assert.ok(dashed.includes(false), "gaps between the dashes");
    for (const x of runUpCellCentres) {
      const triangle = triangleAt(triangles, x, 0);
      assert.ok(isColour(triangle, style.centreDashColour!) || isColour(triangle, style.baseColour), `x ${x} is neither dash nor strip`);
    }
  });
});

describe("given each station's paint across the band", () => {
  const cases = [
    { it: "when a long jump dash is crossed, then the band runs terrain, asphalt, white line, asphalt, white dash, asphalt, white line, asphalt, terrain", mode: MINIGAME_MODE.longJump, runsOfPaint: ["terrain", "base", "line", "base", "line", "base", "line", "base", "terrain"] },
    { it: "when a high jump dash is crossed, then the band runs terrain, red, white line, red, white dash, red, white line, red, terrain", mode: MINIGAME_MODE.highJump, runsOfPaint: ["terrain", "base", "line", "base", "line", "base", "line", "base", "terrain"] },
    { it: "when the Ring Fling lane is crossed, then the band runs terrain, dark, light line, dark, light line, dark, terrain with no dash", mode: MINIGAME_MODE.ringFling, runsOfPaint: ["terrain", "base", "line", "base", "line", "base", "terrain"] },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      const style = STATION_SURFACE_STYLES[testCase.mode];
      const triangles = floorTriangles(surfaceTriangles(makeStationSurface(testCase.mode, style)));
      const paints = { terrain: SURFACE_TERRAIN_COLOUR, base: style.baseColour, line: style.edgeLineColour! };
      const probeX = cellCentresPastThePad(testCase.mode).find((x) => style.centreDashColour === null || isColour(triangleAt(triangles, x, 0), style.centreDashColour));
      assert.ok(probeX !== undefined, "an x where the centre line is painted");
      const colourNames = coloursAcrossBand(triangles, probeX, Object.values(paints)).map((hex) => Object.entries(paints).find(([, painted]) => painted === hex)?.[0] ?? "unknown");
      assert.equal(colourNames.join(","), testCase.runsOfPaint.join(","), "paint runs across the band");
    });
  }
});

describe("given a ground plan cut around holes", () => {
  const cases = [
    { it: "when one hole lies in the middle of the extent, then the tiles fill the extent but the hole", extent: { minX: -50, maxX: 150, minZ: -60, maxZ: 60 }, holes: [{ minX: -10, maxX: 30, minZ: -12, maxZ: 12 }] },
    { it: "when a hole touches the extent's edge, then the tiles fill the rest and none lies over it", extent: { minX: 0, maxX: 100, minZ: 0, maxZ: 80 }, holes: [{ minX: 0, maxX: 20, minZ: 30, maxZ: 50 }] },
    { it: "when three holes stand in a row sharing a width, then the tiles fill the extent but the holes", extent: { minX: -130, maxX: 200, minZ: -72, maxZ: 230 }, holes: [{ minX: -25, maxX: 0, minZ: -12, maxZ: 12 }, { minX: -90, maxX: 20, minZ: 78, maxZ: 102 }, { minX: -60, maxX: 25, minZ: 158, maxZ: 182 }] },
    { it: "when there is no hole, then the one tile is the extent", extent: { minX: -5, maxX: 5, minZ: -3, maxZ: 3 }, holes: [] },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      const tiles = flatGroundTiles(testCase.extent, testCase.holes);
      const expectedArea = area(testCase.extent) - testCase.holes.reduce((total, hole) => total + area(hole), 0);
      assert.ok(Math.abs(tiles.reduce((total, tile) => total + area(tile), 0) - expectedArea) < COVERAGE_TOLERANCE, "tiles cover the extent minus the holes");
      for (const tile of tiles) {
        assert.ok(tile.minX >= testCase.extent.minX && tile.maxX <= testCase.extent.maxX && tile.minZ >= testCase.extent.minZ && tile.maxZ <= testCase.extent.maxZ, "tile within the extent");
        for (const hole of testCase.holes) assert.equal(overlaps(tile, hole), false, `tile ${JSON.stringify(tile)} over hole ${JSON.stringify(hole)}`);
      }
      for (let first = 0; first < tiles.length; first++) {
        for (let second = first + 1; second < tiles.length; second++) assert.equal(overlaps(tiles[first]!, tiles[second]!), false, `tiles ${first} and ${second} overlap`);
      }
    });
  }
});

describe("given flat ground made from tiles", () => {
  const tiles = flatGroundTiles({ minX: -50, maxX: 150, minZ: -60, maxZ: 60 }, [{ minX: -10, maxX: 30, minZ: -12, maxZ: 12 }]);
  const ground = makeFlatGround("test-ground", tiles);

  it("when it is made, then it is one terrain-level mesh in the terrain colour, flat at the pad's level, covering exactly the tiles", () => {
    assert.equal(ground.name, "test-ground");
    assert.equal(ground.renderOrder, levelOrder("terrain"), "terrain level");
    const groundTriangles = surfaceTriangles(ground);
    assert.ok(groundTriangles.length >= tiles.length * 2, "two triangles a tile");
    for (const triangle of groundTriangles) {
      assert.ok(isColour(triangle, SURFACE_TERRAIN_COLOUR), "terrain colour");
      for (const corner of triangle.corners) assert.equal(corner.y, LANDING_HEIGHT, "flat at the pad's level");
    }
    const covered = groundTriangles.reduce((total, triangle) => total + footprintArea(triangle), 0);
    assert.ok(Math.abs(covered - tiles.reduce((total, tile) => total + area(tile), 0)) < COVERAGE_TOLERANCE, "covers the tiles");
  });

  it("when its triangles' normals are read, then they face up so the ground shows from above", () => {
    const normals = ground.geometry.getAttribute("normal");
    assert.ok(normals.count > 0);
    for (let index = 0; index < normals.count; index++) assert.ok(normals.getY(index) > 0.999, `normal ${index} is ${normals.getY(index)} up`);
  });
});
