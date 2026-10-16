import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  RING_BACKSTOP,
  RING_BOARD_BOUNDS,
  RING_CUPS,
  RING_CUP_PROFILE,
  RING_POCKETS,
  RING_RAIL_PROFILE,
  RING_RAIL_START_X,
  SKEE_SCALE,
  ringBoardPlaneHeight,
  ringHeightAt,
  type RingZone,
} from "../scenes/minigame-ring.ts";
import { STATION_SURFACE_STYLES } from "./minigame-surface-art.ts";
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
/** How closely the art's smooth cups and rim follow the model's piecewise profile: the polygon's chord sag over the steepest wall and the rim ramp's bilinear rise both stay under 1.5 cm. */
const SURFACE_TOLERANCE = 0.02;
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
/** The lying dummy's width (m), as in minigame-ring.test.ts (present/ragdoll-body.ts PARTS): a numeral plate wider than it in both directions cannot be wholly covered by a dummy lying either way across the cup. */
const DUMMY_LYING_WIDTH = 0.58;

const RAY_START_HEIGHT = 100;
/** The grid the board is read on: steps (m) that fit no cup, rim or wall, so probes land at varied phases of every curve. */
const GRID_STEP_X = 0.41;
const GRID_STEP_Z = 0.37;
const MIN_GRID_PROBES = 500;
/** Directions (rad) a cup is probed along: across the lane, where no neighbouring cup or pocket overlaps its skirt. */
const PROBE_ANGLES = [Math.PI / 2, (3 * Math.PI) / 2];
/** A round rim has at least this many vertices on each of its circles (a vertex every 7.5 degrees). */
const MIN_RIM_VERTICES_PER_CIRCLE = 48;
const NORMAL_TOLERANCE = 0.02;
/** Red of the white cup walls in the mesh's colours, against the dark floor's: tells a wall vertex from a floor vertex at the same place. */
const WALL_COLOUR_MIN_RED = 0.5;
/** Distances (m) to probe clear of a rim feature: in front of its start, just inside its slope; and beyond the corner arc. */
const RIM_CLEAR_MARGIN = 0.3;
const CORNER_CUT_OFF_PROBE = 0.3;
const BOARD_TO_WHITE_LIGHTNESS_MAX = 0.6;

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
  art.updateMatrixWorld(true);
  const wood = meshNamed(art, "ring-board-wood");
  const white = meshNamed(art, "ring-board-white");
  const whiteVertices = verticesOf(white);
  const raycaster = new THREE.Raycaster();

  /** The art's top surface at a plan point and the colour painted there: a ray straight down from far above, its nearest hit. */
  function surfaceAt(x: number, z: number): { height: number; colour: THREE.Color } {
    raycaster.set(new THREE.Vector3(x, RAY_START_HEIGHT, z), new THREE.Vector3(0, -1, 0));
    const hit = raycaster.intersectObjects([wood, white], false)[0];
    assert.ok(hit?.face, `nothing is drawn at (${x}, ${z})`);
    const colours = (hit.object as THREE.Mesh).geometry.getAttribute("color");
    return { height: hit.point.y, colour: new THREE.Color(colours.getX(hit.face.a), colours.getY(hit.face.a), colours.getZ(hit.face.a)) };
  }

  it("when the board is read on a grid over its whole plan, then its surface stands on ringHeightAt within 2 cm everywhere", () => {
    const { minX, maxX, minZ, maxZ } = RING_BOARD_BOUNDS;
    let probes = 0;
    for (let x = minX + GRID_STEP_X / 2; x < maxX; x += GRID_STEP_X) {
      for (let z = minZ + GRID_STEP_Z / 2; z < maxZ; z += GRID_STEP_Z) {
        assert.ok(Math.abs(surfaceAt(x, z).height - ringHeightAt(x, z)) <= SURFACE_TOLERANCE, `(${x}, ${z}) is ${surfaceAt(x, z).height}, the model says ${ringHeightAt(x, z)}`);
        probes++;
      }
    }
    assert.ok(probes > MIN_GRID_PROBES, `${probes} probes`);
  });

  it("when each cup and pocket is read along a line out from its centre, then its floor, wall, rim top and skirt stand at the model's radii and heights", () => {
    for (const zone of ZONES) {
      const floorRadius = zone.radius - RING_CUP_PROFILE.wallFootWidth;
      const rimEndRadius = zone.radius + RING_CUP_PROFILE.rimTopWidth;
      const skirtMiddleRadius = rimEndRadius + RING_CUP_PROFILE.skirtWidth / 2;
      for (const angle of PROBE_ANGLES) {
        const probe = (radius: number) => surfaceAt(zone.centreX + radius * Math.cos(angle), zone.centreZ + radius * Math.sin(angle)).height;
        const label = `${zone.score} cup at ${angle} rad`;
        assert.ok(Math.abs(probe(0) - zone.floorHeight) <= SURFACE_TOLERANCE, `${label}: floor centre ${probe(0)}`);
        assert.ok(Math.abs(probe(floorRadius / 2) - zone.floorHeight) <= SURFACE_TOLERANCE, `${label}: floor ${probe(floorRadius / 2)}`);
        assert.ok(Math.abs(probe(floorRadius + RING_CUP_PROFILE.wallFootWidth / 2) - (zone.floorHeight + RING_CUP_PROFILE.wallHeight / 2)) <= SURFACE_TOLERANCE, `${label}: wall middle ${probe(floorRadius + RING_CUP_PROFILE.wallFootWidth / 2)}`);
        assert.ok(Math.abs(probe(zone.radius + RING_CUP_PROFILE.rimTopWidth / 2) - zone.rimHeight) <= SURFACE_TOLERANCE, `${label}: rim top ${probe(zone.radius + RING_CUP_PROFILE.rimTopWidth / 2)}`);
        const skirtMiddleX = zone.centreX + skirtMiddleRadius * Math.cos(angle);
        const skirtMiddleZ = zone.centreZ + skirtMiddleRadius * Math.sin(angle);
        assert.ok(Math.abs(probe(skirtMiddleRadius) - ringHeightAt(skirtMiddleX, skirtMiddleZ)) <= SURFACE_TOLERANCE, `${label}: skirt middle ${probe(skirtMiddleRadius)}, the model says ${ringHeightAt(skirtMiddleX, skirtMiddleZ)}`);
      }
    }
  });

  it("when each cup's rim crest is read, then its vertices lie on two exact circles, closely enough spaced to read as round, and the wall's normals all tilt alike", () => {
    for (const zone of ZONES) {
      const rimEndRadius = zone.radius + RING_CUP_PROFILE.rimTopWidth;
      const crest = whiteVertices.filter((vertex) => Math.abs(vertex.y - zone.rimHeight) <= HEIGHT_TOLERANCE && Math.hypot(vertex.x - zone.centreX, vertex.z - zone.centreZ) < rimEndRadius + HEIGHT_TOLERANCE);
      assert.ok(crest.length >= 2 * MIN_RIM_VERTICES_PER_CIRCLE, `${zone.score} rim has ${crest.length} vertices`);
      for (const vertex of crest) {
        const radius = Math.hypot(vertex.x - zone.centreX, vertex.z - zone.centreZ);
        assert.ok(Math.abs(radius - zone.radius) <= HEIGHT_TOLERANCE || Math.abs(radius - rimEndRadius) <= HEIGHT_TOLERANCE, `${zone.score} rim vertex at radius ${radius}`);
      }
      const normals = white.geometry.getAttribute("normal");
      const colours = white.geometry.getAttribute("color");
      const wallFoot = whiteVertices
        .map((vertex, index) => ({ vertex, index }))
        .filter(({ vertex, index }) => Math.abs(vertex.y - zone.floorHeight) <= HEIGHT_TOLERANCE && colours.getX(index) > WALL_COLOUR_MIN_RED && Math.abs(Math.hypot(vertex.x - zone.centreX, vertex.z - zone.centreZ) - (zone.radius - RING_CUP_PROFILE.wallFootWidth)) <= HEIGHT_TOLERANCE);
      assert.ok(wallFoot.length >= MIN_RIM_VERTICES_PER_CIRCLE, `${zone.score} wall foot has ${wallFoot.length} vertices`);
      for (const { vertex, index } of wallFoot) {
        const inwardness = ((zone.centreX - vertex.x) * normals.getX(index) + (zone.centreZ - vertex.z) * normals.getZ(index)) / Math.hypot(vertex.x - zone.centreX, vertex.z - zone.centreZ);
        assert.ok(Math.abs(inwardness - Math.sqrt(1 - normals.getY(index) ** 2)) <= NORMAL_TOLERANCE, `${zone.score} wall normal (${normals.getX(index)}, ${normals.getY(index)}, ${normals.getZ(index)}) does not point to the centre`);
        assert.ok(Math.abs(normals.getY(index) - normals.getY(wallFoot[0]!.index)) <= NORMAL_TOLERANCE, `${zone.score} wall normals tilt differently`);
      }
    }
  });

  it("when the rim is read along its sides, back and corners, then it rises over its ramp, stands at the model's rim height with its top and slope where the profile puts them, and is solid in the corner cut-offs", () => {
    const { maxX, maxZ } = RING_BOARD_BOUNDS;
    const fullHeightX = RING_RAIL_START_X + RING_RAIL_PROFILE.rampLength + 1;
    const cornerCentreX = RING_POCKETS[0]!.centreX;
    const cornerCentreZ = RING_POCKETS[1]!.centreZ;
    const cornerRadius = maxX - cornerCentreX;
    const slopeMiddle = RING_RAIL_PROFILE.topWidth + RING_RAIL_PROFILE.slopeWidth / 2;
    const insideSlope = RING_RAIL_PROFILE.topWidth + RING_RAIL_PROFILE.slopeWidth + RIM_CLEAR_MARGIN;
    const aroundCorner = (radius: number) => ({ x: cornerCentreX + radius * Math.SQRT1_2, z: cornerCentreZ + radius * Math.SQRT1_2 });
    const probes = [
      { name: "no rim before its start", x: RING_RAIL_START_X - RIM_CLEAR_MARGIN, z: -maxZ + RING_RAIL_PROFILE.topWidth / 2, rise: 0 },
      { name: "halfway up its ramp", x: RING_RAIL_START_X + RING_RAIL_PROFILE.rampLength / 2, z: -maxZ + RING_RAIL_PROFILE.topWidth / 2, rise: RING_RAIL_PROFILE.height / 2 },
      { name: "left side top", x: fullHeightX, z: -maxZ + RING_RAIL_PROFILE.topWidth / 2, rise: RING_RAIL_PROFILE.height },
      { name: "right side top", x: fullHeightX, z: maxZ - RING_RAIL_PROFILE.topWidth / 2, rise: RING_RAIL_PROFILE.height },
      { name: "left side slope", x: fullHeightX, z: -maxZ + slopeMiddle, rise: RING_RAIL_PROFILE.height / 2 },
      { name: "left side, just inside the slope", x: fullHeightX, z: -maxZ + insideSlope, rise: 0 },
      { name: "back top", x: maxX - RING_RAIL_PROFILE.topWidth / 2, z: 0, rise: RING_RAIL_PROFILE.height },
      { name: "back slope", x: maxX - slopeMiddle, z: 0, rise: RING_RAIL_PROFILE.height / 2 },
      { name: "back, just inside the slope", x: maxX - insideSlope, z: 0, rise: 0 },
      { name: "right corner top", ...aroundCorner(cornerRadius - RING_RAIL_PROFILE.topWidth / 2), rise: RING_RAIL_PROFILE.height },
      { name: "right corner slope", ...aroundCorner(cornerRadius - slopeMiddle), rise: RING_RAIL_PROFILE.height / 2 },
      { name: "right corner cut-off beyond the arc", ...aroundCorner(cornerRadius + CORNER_CUT_OFF_PROBE), rise: RING_RAIL_PROFILE.height },
    ];
    for (const probe of probes) {
      const expected = ringBoardPlaneHeight(probe.x) + probe.rise;
      assert.ok(Math.abs(surfaceAt(probe.x, probe.z).height - expected) <= SURFACE_TOLERANCE, `${probe.name}: ${surfaceAt(probe.x, probe.z).height}, expected ${expected}`);
    }
    assert.ok(Math.abs(cornerCentreZ + cornerRadius - maxZ) <= HEIGHT_TOLERANCE, "the corner arc is tangent to the side");
  });

  it("when the board's wooden skirt is read, then each wall hangs from the model's height down to the pad", () => {
    const skirtVertices = verticesOf(wood).filter((vertex) => Math.abs(vertex.z) >= RING_BOARD_BOUNDS.maxZ - HEIGHT_TOLERANCE || vertex.x >= RING_BOARD_BOUNDS.maxX - HEIGHT_TOLERANCE);
    assert.ok(skirtVertices.length > 0, "a skirt exists");
    for (const vertex of skirtVertices) {
      const topHeight = ringHeightAt(vertex.x, vertex.z);
      assert.ok(Math.abs(vertex.y) <= HEIGHT_TOLERANCE || Math.abs(vertex.y - topHeight) <= HEIGHT_TOLERANCE || Math.abs(vertex.y - ringBoardPlaneHeight(vertex.x)) <= HEIGHT_TOLERANCE, `skirt vertex (${vertex.x}, ${vertex.z}) at ${vertex.y} is neither the pad nor ${topHeight}`);
    }
  });

  it("when the colours are read, then the board is a mid tone clearly darker than the glossy white cups and rim, the cup floors are darker than the board, and the lane is darker still", () => {
    const lightnessOf = (colour: THREE.Color) => colour.getHSL({ h: 0, s: 0, l: 0 }).l;
    const cup = RING_CUPS[0]!;
    const cupSkirtEdgeZ = cup.radius + RING_CUP_PROFILE.rimTopWidth + RING_CUP_PROFILE.skirtWidth;
    const railFootZ = RING_BOARD_BOUNDS.maxZ - RING_RAIL_PROFILE.topWidth - RING_RAIL_PROFILE.slopeWidth;
    const boardLightness = lightnessOf(surfaceAt(cup.centreX, (cupSkirtEdgeZ + railFootZ) / 2).colour);
    const rimLightness = lightnessOf(surfaceAt(cup.centreX - cup.radius - RING_CUP_PROFILE.rimTopWidth / 2, 0).colour);
    const sideRimLightness = lightnessOf(surfaceAt(RING_RAIL_START_X + RING_RAIL_PROFILE.rampLength + 1, -RING_BOARD_BOUNDS.maxZ + RING_RAIL_PROFILE.topWidth / 2).colour);
    const floorLightness = lightnessOf(surfaceAt(cup.centreX, cup.centreZ + (cup.radius - RING_CUP_PROFILE.wallFootWidth) / 2).colour);
    const laneLightness = lightnessOf(new THREE.Color(STATION_SURFACE_STYLES.ringFling.baseColour));
    assert.ok(boardLightness <= BOARD_TO_WHITE_LIGHTNESS_MAX * rimLightness, `board ${boardLightness} against cup rim ${rimLightness}`);
    assert.ok(boardLightness <= BOARD_TO_WHITE_LIGHTNESS_MAX * sideRimLightness, `board ${boardLightness} against side rim ${sideRimLightness}`);
    assert.ok(floorLightness < boardLightness, `cup floor ${floorLightness} against board ${boardLightness}`);
    assert.ok(laneLightness < boardLightness, `lane ${laneLightness} against board ${boardLightness}`);
  });

  it("when the numeral plates are read, then there is one per cup and pocket, centred on it, wholly inside its floor circle, and each reads its zone's score", () => {
    const numerals = meshNamed(art, "ring-numerals");
    const vertices = verticesOf(numerals);
    const uv = numerals.geometry.getAttribute("uv");
    const atlas = recordingCanvases.find((canvas) => canvas.drawnTexts.some((drawn) => drawn.text === "10"))!;
    assert.equal(vertices.length, ZONES.length * VERTICES_PER_QUAD, "one plate per zone");
    for (let zoneIndex = 0; zoneIndex < ZONES.length; zoneIndex++) {
      const zone = ZONES[zoneIndex]!;
      const corners = vertices.slice(zoneIndex * VERTICES_PER_QUAD, (zoneIndex + 1) * VERTICES_PER_QUAD);
      assert.ok(Math.abs(mean(corners.map((corner) => corner.x)) - zone.centreX) <= HEIGHT_TOLERANCE, `${zone.score} centre x`);
      assert.ok(Math.abs(mean(corners.map((corner) => corner.z)) - zone.centreZ) <= HEIGHT_TOLERANCE, `${zone.score} centre z`);
      const hover = mean(corners.map((corner) => corner.y)) - zone.floorHeight;
      assert.ok(hover > 0 && hover <= DECAL_HOVER_MAX, `${zone.score} hovers ${hover} m over its floor`);
      const floorRadius = zone.radius - RING_CUP_PROFILE.wallFootWidth;
      for (const corner of corners) {
        const reach = Math.hypot(corner.x - zone.centreX, corner.z - zone.centreZ);
        assert.ok(reach <= floorRadius, `a ${zone.score} plate corner is ${reach} m out, the floor circle is ${floorRadius} m`);
      }
      const alongThrow = Math.max(...corners.map((corner) => corner.x)) - Math.min(...corners.map((corner) => corner.x));
      const acrossLane = Math.max(...corners.map((corner) => corner.z)) - Math.min(...corners.map((corner) => corner.z));
      assert.ok(Math.min(alongThrow, acrossLane) > DUMMY_LYING_WIDTH, `a ${zone.score} plate is ${alongThrow} x ${acrossLane} m: a dummy ${DUMMY_LYING_WIDTH} m wide, either way round, would cover all of it`);
      const atlasX = mean(Array.from({ length: VERTICES_PER_QUAD }, (_, corner) => uv.getX(zoneIndex * VERTICES_PER_QUAD + corner))) * atlas.width;
      const atlasY = (1 - mean(Array.from({ length: VERTICES_PER_QUAD }, (_, corner) => uv.getY(zoneIndex * VERTICES_PER_QUAD + corner)))) * atlas.height;
      const [readText] = [...atlas.drawnTexts].sort((first, second) => Math.hypot(first.x - atlasX, first.y - atlasY) - Math.hypot(second.x - atlasX, second.y - atlasY));
      assert.equal(readText!.text, String(zone.score), `the plate at the ${zone.score} zone reads ${readText!.text}`);
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
