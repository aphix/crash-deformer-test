import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MINIGAME_MODE, MINIGAME_MODES, MODE_LABELS, START_HILL, STATION_HALF_WIDTH, type MinigameMode } from "../scenes/minigame-constants.ts";
import { floorHeightAt, lipHeight, stationBackX, stationFrontX } from "../scenes/minigame-profile.ts";
import { makeStationSurface, STATION_SURFACE_STYLES, SURFACE_DRAW_CALL_BUDGET, SURFACE_STEP } from "./minigame-surface-art.ts";

/** Centres of the grid's cells (grid from the lip) along the run, from the pad's end to the lip: where the lane carries its dashes, never the pad's bars. */
function cellCentresPastThePad(mode: MinigameMode): number[] {
  const firstCell = Math.ceil((stationBackX(mode) + START_HILL.padLength) / SURFACE_STEP);
  const lastCell = Math.floor(Math.min(stationFrontX(mode), 0) / SURFACE_STEP);
  return Array.from({ length: lastCell - firstCell }, (_, index) => (firstCell + index + 0.5) * SURFACE_STEP);
}

const HEIGHT_TOLERANCE = 0.001;
const EXTENT_TOLERANCE = 0.001;
/** Area (m2) the triangles may differ from the lane's: under the smallest cell (a 0.2 m edge line over one 0.2 m step is 0.04 m2). */
const COVERAGE_TOLERANCE = 0.01;
/** How far (m) the surface may sit off the floor between two vertices of a row: the chord a flat triangle cuts off a bend. */
const CHORD_TOLERANCE = 0.002;
const COLOUR_TOLERANCE = 1e-6;
/** Probe spacing (m) across the lane. */
const LATERAL_PROBE_STEP = 0.05;
const VERTICES_PER_TRIANGLE = 3;

type Vertex = { x: number; y: number; z: number };
type PaintedTriangle = { minX: number; maxX: number; minZ: number; maxZ: number; area: number; red: number; green: number; blue: number };

function surfaceMeshes(group: THREE.Group): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

function surfaceVertices(group: THREE.Group): Vertex[] {
  const vertices: Vertex[] = [];
  for (const mesh of surfaceMeshes(group)) {
    const positions = mesh.geometry.getAttribute("position");
    for (let index = 0; index < positions.count; index++) vertices.push({ x: positions.getX(index), y: positions.getY(index), z: positions.getZ(index) });
  }
  return vertices;
}

function paintedTriangles(group: THREE.Group): PaintedTriangle[] {
  const triangles: PaintedTriangle[] = [];
  for (const mesh of surfaceMeshes(group)) {
    const positions = mesh.geometry.getAttribute("position");
    const colours = mesh.geometry.getAttribute("color");
    for (let first = 0; first < positions.count; first += VERTICES_PER_TRIANGLE) {
      const xs = [0, 1, 2].map((corner) => positions.getX(first + corner));
      const zs = [0, 1, 2].map((corner) => positions.getZ(first + corner));
      const area = Math.abs((xs[1]! - xs[0]!) * (zs[2]! - zs[0]!) - (xs[2]! - xs[0]!) * (zs[1]! - zs[0]!)) / 2;
      triangles.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), area, red: colours.getX(first), green: colours.getY(first), blue: colours.getZ(first) });
    }
  }
  return triangles;
}

/** The linear colour three stores for `hex`, as a comparable string-free triple. */
function linearColour(hex: number): { red: number; green: number; blue: number } {
  const colour = new THREE.Color().setHex(hex);
  return { red: colour.r, green: colour.g, blue: colour.b };
}

function isColour(triangle: PaintedTriangle, hex: number): boolean {
  const expected = linearColour(hex);
  return Math.abs(triangle.red - expected.red) < COLOUR_TOLERANCE && Math.abs(triangle.green - expected.green) < COLOUR_TOLERANCE && Math.abs(triangle.blue - expected.blue) < COLOUR_TOLERANCE;
}

function triangleAt(triangles: readonly PaintedTriangle[], x: number, z: number): PaintedTriangle {
  const found = triangles.find((triangle) => x > triangle.minX && x < triangle.maxX && z > triangle.minZ && z < triangle.maxZ);
  assert.ok(found, `a triangle covers (${x}, ${z})`);
  return found;
}

/** The colours met walking across the lane at `x`, each run once, as hex codes found in `knownColours` (-1 for any other). */
function coloursAcrossLane(triangles: readonly PaintedTriangle[], x: number, laneHalfWidth: number, knownColours: readonly number[]): number[] {
  const runs: number[] = [];
  for (let z = -laneHalfWidth + LATERAL_PROBE_STEP / 2; z < laneHalfWidth; z += LATERAL_PROBE_STEP) {
    const triangle = triangleAt(triangles, x, z);
    const colour = knownColours.find((hex) => isColour(triangle, hex)) ?? -1;
    if (runs[runs.length - 1] !== colour) runs.push(colour);
  }
  return runs;
}

/** Sorted x of every distinct vertex column along the lane's left edge. */
function vertexColumns(vertices: readonly Vertex[]): Vertex[] {
  const leftEdge = Math.min(...vertices.map((vertex) => vertex.z));
  const column = vertices.filter((vertex) => vertex.z === leftEdge).sort((a, b) => a.x - b.x);
  return column.filter((vertex, index) => index === 0 || vertex.x !== column[index - 1]!.x);
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
    const vertices = surfaceVertices(group);

    it("when every vertex is compared with the floor function, then its height is the floor's at its x and z to a millimetre", () => {
      for (const vertex of vertices) {
        const floor = floorHeightAt(mode, vertex.x, vertex.z);
        assert.ok(Math.abs(vertex.y - floor) <= HEIGHT_TOLERANCE, `at (${vertex.x}, ${vertex.z}) height ${vertex.y}, floor ${floor}`);
      }
    });

    it("when its extent is read, then it runs from the station's back to its front and the lane's width, within the station's half width", () => {
      assert.ok(Math.abs(Math.min(...vertices.map((vertex) => vertex.x)) - stationBackX(mode)) <= EXTENT_TOLERANCE, "back x");
      assert.ok(Math.abs(Math.max(...vertices.map((vertex) => vertex.x)) - stationFrontX(mode)) <= EXTENT_TOLERANCE, "front x");
      assert.ok(Math.abs(Math.min(...vertices.map((vertex) => vertex.z)) + style.laneHalfWidth) <= EXTENT_TOLERANCE, "left side");
      assert.ok(Math.abs(Math.max(...vertices.map((vertex) => vertex.z)) - style.laneHalfWidth) <= EXTENT_TOLERANCE, "right side");
      assert.ok(style.laneHalfWidth <= STATION_HALF_WIDTH, "lane within the station's half width");
    });

    it("when its triangles are added up as seen from above, then they cover the whole lane with no hole", () => {
      const covered = paintedTriangles(group).reduce((total, triangle) => total + triangle.area, 0);
      const lane = (stationFrontX(mode) - stationBackX(mode)) * style.laneHalfWidth * 2;
      assert.ok(Math.abs(covered - lane) < COVERAGE_TOLERANCE, `covered ${covered} m2 of ${lane} m2`);
    });

    it("when its vertex columns along the run are read, then none is farther from the next than a step and the lip is one of them at the lip's height", () => {
      const columns = vertexColumns(vertices);
      for (let index = 1; index < columns.length; index++) {
        assert.ok(columns[index]!.x - columns[index - 1]!.x <= SURFACE_STEP + EXTENT_TOLERANCE, `gap before x ${columns[index]!.x}`);
      }
      const lip = columns.find((column) => Math.abs(column.x) <= EXTENT_TOLERANCE);
      assert.ok(lip, "a vertex column stands on the lip");
      assert.ok(Math.abs(lip.y - lipHeight(mode)) <= HEIGHT_TOLERANCE, `lip height ${lip.y}, wanted ${lipHeight(mode)}`);
    });

    it("when the surface is read between two vertices of a column, then it is within a chord tolerance of the floor", () => {
      const columns = vertexColumns(vertices);
      for (let index = 1; index < columns.length; index++) {
        const before = columns[index - 1]!;
        const after = columns[index]!;
        const middleX = (before.x + after.x) / 2;
        const off = Math.abs((before.y + after.y) / 2 - floorHeightAt(mode, middleX, before.z));
        assert.ok(off <= CHORD_TOLERANCE, `between x ${before.x} and ${after.x} the surface is ${off} m off the floor`);
      }
    });
  });
}

describe("given the High jump's red run-up strip with its dashed centre line", () => {
  const style = STATION_SURFACE_STYLES.highJump;
  const triangles = paintedTriangles(makeStationSurface(MINIGAME_MODE.highJump, style));
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

describe("given each station's paint across the lane", () => {
  const cases = [
    { it: "when a long jump dash is crossed, then the lane runs asphalt, white line, asphalt, white dash, asphalt, white line, asphalt", mode: MINIGAME_MODE.longJump, runsOfPaint: ["base", "line", "base", "line", "base", "line", "base"] },
    { it: "when a high jump dash is crossed, then the strip runs red, white line, red, white dash, red, white line, red", mode: MINIGAME_MODE.highJump, runsOfPaint: ["base", "line", "base", "line", "base", "line", "base"] },
    { it: "when the Ring Fling lane is crossed, then it runs dark, light line, dark, light line, dark with no dash", mode: MINIGAME_MODE.ringFling, runsOfPaint: ["base", "line", "base", "line", "base"] },
  ] as const;
  for (const testCase of cases) {
    it(testCase.it, () => {
      const style = STATION_SURFACE_STYLES[testCase.mode];
      const triangles = paintedTriangles(makeStationSurface(testCase.mode, style));
      const paints = { base: style.baseColour, line: style.edgeLineColour! };
      const probeX = cellCentresPastThePad(testCase.mode).find((x) => style.centreDashColour === null || isColour(triangleAt(triangles, x, 0), style.centreDashColour));
      assert.ok(probeX !== undefined, "an x where the centre line is painted");
      const colourNames = coloursAcrossLane(triangles, probeX, style.laneHalfWidth, Object.values(paints)).map((hex) => Object.entries(paints).find(([, painted]) => painted === hex)?.[0] ?? "unknown");
      assert.equal(colourNames.join(","), testCase.runsOfPaint.join(","), "paint runs across the lane");
    });
  }
});
