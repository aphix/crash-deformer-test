import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { RING_BACKSTOP, RING_BOARD_BOUNDS, RING_CUPS, RING_POCKETS, RING_RAIL_PROFILE, SKEE_SCALE, ringHeightAt, type RingZone } from "../scenes/minigame-ring.ts";
import { makeRingFlingArt, RING_FLING_DRAW_BUDGET } from "./ring-fling-art.ts";

/** A canvas that is only a recorder: the art's canvas textures are drawn into it, and the text it was told to draw is kept (there is no `document` in node). */
type DrawnText = { text: string; x: number; y: number };
type RecordingCanvas = { width: number; height: number; drawnTexts: DrawnText[]; getContext: () => unknown };
const recordingCanvases: RecordingCanvas[] = [];

function makeRecordingCanvas(): RecordingCanvas {
  const drawnTexts: DrawnText[] = [];
  const settings = {
    fillText: (text: string, x: number, y: number) => {
      drawnTexts.push({ text, x, y });
    },
  };
  const context = new Proxy(settings, { get: (target, property) => (property in target ? target[property as keyof typeof target] : () => undefined) });
  const canvas: RecordingCanvas = { width: 0, height: 0, drawnTexts, getContext: () => context };
  recordingCanvases.push(canvas);
  return canvas;
}

Object.defineProperty(globalThis, "document", { value: { createElement: makeRecordingCanvas }, configurable: true });

const HEIGHT_TOLERANCE = 0.001;
const ZONES: readonly RingZone[] = [...RING_CUPS, ...RING_POCKETS];
const VERTICES_PER_QUAD = 4;
const REAL_INCH_SCALED = 0.0254 * SKEE_SCALE;
const REAL_BACKBOARD_HEIGHT_INCHES = 50;
/** The throw the board is designed for (as in minigame-ring.test.ts): up to 22 m/s at 35 degrees from the lip. */
const DESIGN_THROW_SPEED_MAX = 22;
const DESIGN_THROW_PITCH = (35 * Math.PI) / 180;
const GRAVITY = 9.80665;
const BACKSTOP_RIM_CLEARANCE_FACTOR = 3;
/** A numeral lies on its cup floor: over it, but by no more than this (m). */
const DECAL_HOVER_MAX = 0.1;

type Vertex = { x: number; y: number; z: number };

function meshNamed(art: THREE.Group, name: string): THREE.Mesh {
  const found = art.getObjectByName(name);
  assert.ok(found instanceof THREE.Mesh, `a mesh named ${name}`);
  return found;
}

function allMeshes(art: THREE.Group): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  art.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

function verticesOf(mesh: THREE.Mesh): Vertex[] {
  const positions = mesh.geometry.getAttribute("position");
  return Array.from({ length: positions.count }, (_, index) => ({ x: positions.getX(index), y: positions.getY(index), z: positions.getZ(index) }));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("given the Ring Fling station's art in station-local coordinates", () => {
  const art = makeRingFlingArt();
  const board = meshNamed(art, "ring-board");
  const boardVertices = verticesOf(board);

  it("when the board's vertices are read, then every one stands on ringHeightAt within 1 mm and the cups really rise", () => {
    for (const vertex of boardVertices) {
      assert.ok(Math.abs(vertex.y - ringHeightAt(vertex.x, vertex.z)) <= HEIGHT_TOLERANCE, `(${vertex.x}, ${vertex.z}) is ${vertex.y}, the model says ${ringHeightAt(vertex.x, vertex.z)}`);
    }
    assert.ok(Math.max(...boardVertices.map((vertex) => vertex.y)) > RING_CUPS[4]!.rimHeight - HEIGHT_TOLERANCE, "the highest cup's rim is in the mesh");
    assert.ok(Math.min(...boardVertices.map((vertex) => vertex.x)) <= RING_BOARD_BOUNDS.minX + HEIGHT_TOLERANCE, "the mesh starts at the board's front");
    assert.ok(Math.max(...boardVertices.map((vertex) => vertex.x)) >= RING_BOARD_BOUNDS.maxX - HEIGHT_TOLERANCE, "the mesh ends at the board's back");
  });

  it("when the board's wooden skirt is read, then each wall hangs from the model's height down to the pad", () => {
    const skirtVertices = verticesOf(meshNamed(art, "ring-board-skirt"));
    assert.ok(skirtVertices.length > 0, "a skirt exists");
    for (const vertex of skirtVertices) {
      const topHeight = ringHeightAt(vertex.x, vertex.z);
      assert.ok(Math.abs(vertex.y) <= HEIGHT_TOLERANCE || Math.abs(vertex.y - topHeight) <= HEIGHT_TOLERANCE, `skirt vertex (${vertex.x}, ${vertex.z}) at ${vertex.y} is neither the pad nor ${topHeight}`);
    }
  });

  it("when the floor of the 10 cup and its rim are read, then the floor is painted darker than the rim", () => {
    const colours = board.geometry.getAttribute("color");
    const [cup] = RING_CUPS;
    const nearest = (matches: (vertex: Vertex) => boolean, distanceFrom: (vertex: Vertex) => number) =>
      boardVertices.map((vertex, index) => ({ vertex, index })).filter(({ vertex }) => matches(vertex)).sort((first, second) => distanceFrom(first.vertex) - distanceFrom(second.vertex))[0]!;
    const floor = nearest(() => true, (vertex) => Math.hypot(vertex.x - cup!.centreX, vertex.z - cup!.centreZ));
    const rim = nearest((vertex) => Math.abs(vertex.y - cup!.rimHeight) <= HEIGHT_TOLERANCE, (vertex) => Math.hypot(vertex.x - cup!.centreX, vertex.z - cup!.centreZ));
    assert.ok(colours.getX(floor.index) < colours.getX(rim.index), `floor ${colours.getX(floor.index)} rim ${colours.getX(rim.index)}`);
  });

  it("when the numeral decals are read, then there is one per cup and pocket, centred on it, and each reads its zone's score", () => {
    const numerals = meshNamed(art, "ring-numerals");
    const vertices = verticesOf(numerals);
    const uv = numerals.geometry.getAttribute("uv");
    const atlas = recordingCanvases.find((canvas) => canvas.drawnTexts.some((drawn) => drawn.text === "10"))!;
    assert.equal(vertices.length, ZONES.length * VERTICES_PER_QUAD, "one quad per zone");
    for (let zoneIndex = 0; zoneIndex < ZONES.length; zoneIndex++) {
      const zone = ZONES[zoneIndex]!;
      const corners = vertices.slice(zoneIndex * VERTICES_PER_QUAD, (zoneIndex + 1) * VERTICES_PER_QUAD);
      assert.ok(Math.abs(mean(corners.map((corner) => corner.x)) - zone.centreX) <= HEIGHT_TOLERANCE, `${zone.score} centre x`);
      assert.ok(Math.abs(mean(corners.map((corner) => corner.z)) - zone.centreZ) <= HEIGHT_TOLERANCE, `${zone.score} centre z`);
      const hover = mean(corners.map((corner) => corner.y)) - zone.floorHeight;
      assert.ok(hover > 0 && hover <= DECAL_HOVER_MAX, `${zone.score} hovers ${hover} m over its floor`);
      const atlasX = mean(Array.from({ length: VERTICES_PER_QUAD }, (_, corner) => uv.getX(zoneIndex * VERTICES_PER_QUAD + corner))) * atlas.width;
      const atlasY = (1 - mean(Array.from({ length: VERTICES_PER_QUAD }, (_, corner) => uv.getY(zoneIndex * VERTICES_PER_QUAD + corner)))) * atlas.height;
      const [readText] = [...atlas.drawnTexts].sort((first, second) => Math.hypot(first.x - atlasX, first.y - atlasY) - Math.hypot(second.x - atlasX, second.y - atlasY));
      assert.equal(readText!.text, String(zone.score), `the decal at the ${zone.score} zone reads ${readText!.text}`);
    }
  });

  it("when the numerals' atlas and the backboard's face were drawn, then every score and the title were written", () => {
    const writtenTexts = recordingCanvases.flatMap((canvas) => canvas.drawnTexts.map((drawn) => drawn.text));
    for (const score of ["10", "20", "30", "40", "50", "100", "RING FLING"]) assert.ok(writtenTexts.includes(score), `"${score}" is drawn`);
  });

  it("when the backboard is read, then its front face stands at the backstop's distance with the stated height, thickness and a span wider than the board", () => {
    const slab = verticesOf(meshNamed(art, "ring-backboard"));
    const frontX = RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard;
    assert.ok(Math.abs(Math.min(...slab.map((vertex) => vertex.x)) - frontX) <= HEIGHT_TOLERANCE, "front face x");
    assert.ok(Math.abs(Math.max(...slab.map((vertex) => vertex.x)) - (frontX + RING_BACKSTOP.thickness)) <= HEIGHT_TOLERANCE, "back face x");
    assert.ok(Math.abs(Math.max(...slab.map((vertex) => vertex.y)) - RING_BACKSTOP.height) <= HEIGHT_TOLERANCE, "top");
    assert.ok(Math.abs(Math.min(...slab.map((vertex) => vertex.y))) <= HEIGHT_TOLERANCE, "foot on the pad");
    assert.ok(Math.min(...slab.map((vertex) => vertex.z)) <= RING_BOARD_BOUNDS.minZ - RING_RAIL_PROFILE.height + HEIGHT_TOLERANCE, "reaches past the board's left side");
    assert.ok(Math.max(...slab.map((vertex) => vertex.z)) >= RING_BOARD_BOUNDS.maxZ + RING_RAIL_PROFILE.height - HEIGHT_TOLERANCE, "reaches past the board's right side");
    const faceX = verticesOf(meshNamed(art, "ring-backboard-face")).map((vertex) => vertex.x);
    assert.ok(Math.max(...faceX) < frontX && frontX - Math.max(...faceX) < RING_BACKSTOP.thickness, "the face hovers a hair in front of the slab, facing the lip");
  });

  it("when the station is drawn, then it costs no more than the draw budget and the numerals are one merged mesh", () => {
    const meshes = allMeshes(art);
    assert.ok(meshes.length <= RING_FLING_DRAW_BUDGET, `${meshes.length} meshes, budget ${RING_FLING_DRAW_BUDGET}`);
    assert.equal(meshes.filter((mesh) => mesh.name === "ring-numerals").length, 1, "all numerals in one mesh");
    assert.equal(new Set(meshes.map((mesh) => mesh.material)).size, meshes.length, "each mesh has one material, none duplicated per cup");
  });
});

describe("given the Ring Fling backstop's constant", () => {
  const boardTop = Math.max(...RING_CUPS.map((cup) => cup.rimHeight), ...RING_POCKETS.map((pocket) => pocket.rimHeight));

  it("when it is read, then it is the real machine's 50 in backboard and 1 in thickness at the board's scale, with a positive gap", () => {
    assert.ok(RING_BACKSTOP.distancePastBoard > 0, "gap past the board");
    assert.ok(Math.abs(RING_BACKSTOP.height - REAL_BACKBOARD_HEIGHT_INCHES * REAL_INCH_SCALED) <= HEIGHT_TOLERANCE, "height");
    assert.ok(Math.abs(RING_BACKSTOP.thickness - REAL_INCH_SCALED) <= HEIGHT_TOLERANCE, "thickness");
  });

  it("when it is read against the board, then it stands over every rim and is at least 3 x the 50 cup's rim height", () => {
    assert.ok(RING_BACKSTOP.height > boardTop, "above the highest rim");
    assert.ok(
      RING_BACKSTOP.height >= BACKSTOP_RIM_CLEARANCE_FACTOR * RING_CUPS[4]!.rimHeight,
      `${RING_BACKSTOP.height} m is less than ${BACKSTOP_RIM_CLEARANCE_FACTOR} x the 50 cup's rim (${RING_CUPS[4]!.rimHeight} m)`,
    );
  });

  it("when a dummy leaves the highest rim at the fastest design throw, then his ballistic apex stays under the backstop's top", () => {
    const apexRise = (DESIGN_THROW_SPEED_MAX * Math.sin(DESIGN_THROW_PITCH)) ** 2 / (2 * GRAVITY);
    assert.ok(RING_BACKSTOP.height >= boardTop + apexRise, `top ${RING_BACKSTOP.height} m, a dummy at ${boardTop} m rises ${apexRise} m`);
  });
});
