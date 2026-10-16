import * as THREE from "three";
import { hypot2 } from "../kernel/physics-core.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  RING_BACKSTOP,
  RING_BOARD_BOUNDS,
  RING_CUPS,
  RING_CUP_PROFILE,
  RING_POCKETS,
  RING_RAIL_PROFILE,
  RING_RAIL_START_X,
  ringBoardPlaneHeight,
  ringHeightAt,
  type RingZone,
} from "../scenes/minigame-ring.ts";
import { MINIGAME_MODE } from "../scenes/minigame-constants.ts";
import { CANVAS_WHITE, canvasTexture } from "./lab-art.ts";
import { makeStationSurface, STATION_SURFACE_STYLES } from "./minigame-surface-art.ts";

/**
 * The Ring Fling station in station-local coordinates (+x throw, x = 0 the lip, z = 0 the lane centre, y from the pad): the dark
 * lane's surface; the target board built analytically from the model's own numbers (a sloped wood plane with a wooden skirt, and in
 * glossy white a smooth round cup or pocket at each `RING_CUPS` / `RING_POCKETS` entry swept from `RING_CUP_PROFILE`, and the raised
 * rim swept from `RING_RAIL_PROFILE` along both sides and round the back corners); a numeral plate inside every cup and pocket
 * floor; and the tall black backboard with the red title and a lit score strip (the physics backstop stands where `RING_BACKSTOP`
 * puts it). Six draws.
 */

/** Most draws the whole station may cost: the surface, the wood board, the white cups and rim, the numerals, the backboard and its face. */
export const RING_FLING_DRAW_BUDGET = 10;

/** The wood board is a mid tone, clearly darker than the glossy white cups and rim; the cup floors are darker still, the lane darker again. */
const WOOD_BOARD_COLOUR = 0x9a6a3a;
const WOOD_SKIRT_COLOUR = 0x73502e;
const WHITE_COLOUR = 0xf4f4f0;
const CUP_FLOOR_COLOUR = 0x34363b;
const BACKBOARD_COLOUR = 0x16171b;
const WOOD_ROUGHNESS = 0.7;
const GLOSSY_WHITE_ROUGHNESS = 0.25;

/** Steps round a cup (a lathe's segments): the polygon's sag at the largest wall is 2 mm, so a wall's slope turns it into under 1 cm of height. */
const CUP_SEGMENTS = 64;
/** Steps round one rim corner's quarter circle, and along the rim's ramp (so its bilinear rise stays within 2 cm of the model). */
const CORNER_ARC_SEGMENTS = 32;
const RIM_RAMP_STEPS = 24;

/** The numerals' atlas: one 2:1 cell per score, left to right then down, a white plate with the black numeral on it. */
const NUMERAL_CELL_WIDTH = 256;
const NUMERAL_CELL_HEIGHT = 128;
const NUMERAL_ATLAS_COLUMNS = 3;
/** A numeral plate's corners reach this share of its cup's floor radius from the cup's centre: the plate lies wholly inside the floor circle. */
const NUMERAL_PLATE_CORNER_REACH = 0.95;
/** Height (m) a numeral plate hovers over its cup floor: clear of z-fighting. */
const NUMERAL_LIFT = 0.02;
const NUMERAL_FONT_PER_CELL_HEIGHT = 0.8;
const NUMERAL_TEXT_PER_CELL_WIDTH = 0.9;
const NUMERAL_PLATE_COLOUR = "#f7f7f2";
const NUMERAL_INK_COLOUR = "#000000";

/** The backboard's face: how far (m) it hovers in front of the panel, and its texture's width (px; the height follows the panel's proportions). */
const FACE_LIFT = 0.02;
const FACE_CANVAS_WIDTH = 512;
const TITLE_TEXT = "RING FLING";
const TITLE_RED = "#d11f1f";
const SCORE_PANEL_TEXT = "HIGH SCORE";
const SCORE_PANEL_DIGITS = "000";
/** Face layout as fractions of the panel: the score strip's box, the title's centre line and the size of the title and the strip's digits. */
const SCORE_STRIP = { left: 0.2, right: 0.8, top: 0.04, bottom: 0.2 } as const;
const TITLE_CENTRE_Y = 0.36;
const TITLE_FONT_PER_WIDTH = 0.13;
const TITLE_TEXT_PER_WIDTH = 0.86;
/** The strip's two lines, each a font size and a baseline as fractions of the strip's height: the small label over the big digits. */
const SCORE_LABEL_LINE = { fontPerHeight: 0.25, centreYPerHeight: 0.28 } as const;
const SCORE_DIGITS_LINE = { fontPerHeight: 0.5, centreYPerHeight: 0.68 } as const;

const COMPONENTS = 3;

const ZONES: readonly RingZone[] = [...RING_CUPS, ...RING_POCKETS];
/** Each distinct score (10 ... 50, 100), one atlas cell apiece, in the order the zones list them. */
const NUMERAL_SCORES = [...new Set(ZONES.map((zone) => zone.score))];
const NUMERAL_ATLAS_ROWS = Math.ceil(NUMERAL_SCORES.length / NUMERAL_ATLAS_COLUMNS);

/** The radius (m) of a cup's flat floor: where its inner wall's foot starts. */
function floorRadiusOf(zone: RingZone): number {
  return zone.radius - RING_CUP_PROFILE.wallFootWidth;
}

/** Whether a triangle with this winding normal and centroid faces the way the surface is lit and seen from. */
type Facing = (normal: THREE.Vector3, centroid: THREE.Vector3) => boolean;

/** The board's cups, plane and rim are all graphs over the ground: they face up. */
const facesUp: Facing = (normal) => normal.y > 0;

/**
 * One smooth surface between consecutive polylines (`lines[k]` runs along the sweep; `closed` joins each line's last point to its
 * first). Vertices are shared along the sweep for smooth normals and not shared with other strips, so a strip's edges stay crisp.
 * Every triangle is wound to face `facing`, one `colour` throughout.
 */
function sweepStrip(lines: readonly (readonly THREE.Vector3[])[], closed: boolean, colour: number, facing: Facing): THREE.BufferGeometry {
  const pointsPerLine = lines[0]!.length;
  const positions = new Float32Array(lines.length * pointsPerLine * COMPONENTS);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    for (let pointIndex = 0; pointIndex < pointsPerLine; pointIndex++) {
      const point = lines[lineIndex]![pointIndex]!;
      positions.set([point.x, point.y, point.z], (lineIndex * pointsPerLine + pointIndex) * COMPONENTS);
    }
  }
  const paint = new THREE.Color(colour);
  const colours = new Float32Array(positions.length);
  for (let at = 0; at < colours.length; at += COMPONENTS) colours.set([paint.r, paint.g, paint.b], at);
  const cellsAlong = closed ? pointsPerLine : pointsPerLine - 1;
  const indices: number[] = [];
  const cornerOne = new THREE.Vector3();
  const cornerTwo = new THREE.Vector3();
  const cornerThree = new THREE.Vector3();
  const edgeOne = new THREE.Vector3();
  const edgeTwo = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const addTriangle = (firstIndex: number, secondIndex: number, thirdIndex: number): void => {
    cornerOne.fromArray(positions, firstIndex * COMPONENTS);
    cornerTwo.fromArray(positions, secondIndex * COMPONENTS);
    cornerThree.fromArray(positions, thirdIndex * COMPONENTS);
    normal.crossVectors(edgeOne.subVectors(cornerTwo, cornerOne), edgeTwo.subVectors(cornerThree, cornerOne));
    centroid.copy(cornerOne).add(cornerTwo).add(cornerThree).divideScalar(3);
    if (facing(normal, centroid)) indices.push(firstIndex, secondIndex, thirdIndex);
    else indices.push(firstIndex, thirdIndex, secondIndex);
  };
  for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex++) {
    for (let along = 0; along < cellsAlong; along++) {
      const nearThis = lineIndex * pointsPerLine + along;
      const nearNext = lineIndex * pointsPerLine + ((along + 1) % pointsPerLine);
      const farThis = (lineIndex + 1) * pointsPerLine + along;
      const farNext = (lineIndex + 1) * pointsPerLine + ((along + 1) % pointsPerLine);
      addTriangle(nearThis, nearNext, farThis);
      addTriangle(nearNext, farNext, farThis);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, COMPONENTS));
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, COMPONENTS));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function mergedAndDisposed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  return merged;
}

/** A ring of `CUP_SEGMENTS` points at `radius` round (`centreX`, `centreZ`), each at `heightAt(x, z)`. */
function ringOfPoints(zone: RingZone, radius: number, heightAt: (x: number, z: number) => number): THREE.Vector3[] {
  return Array.from({ length: CUP_SEGMENTS }, (_, step) => {
    const angle = (2 * Math.PI * step) / CUP_SEGMENTS;
    const x = zone.centreX + radius * Math.cos(angle);
    const z = zone.centreZ + radius * Math.sin(angle);
    return new THREE.Vector3(x, heightAt(x, z), z);
  });
}

/**
 * One cup or pocket as four crisp strips swept round its centre from the model's profile: the dark flat floor, the white inner
 * wall rising to the rim, the flat rim top, and the outside skirt falling to the sloped board (so the skirt's foot follows the board's
 * slope, the one place a lathe's rings are not level).
 */
function makeCupStrips(zone: RingZone): THREE.BufferGeometry[] {
  const floorRadius = floorRadiusOf(zone);
  const rimEndRadius = zone.radius + RING_CUP_PROFILE.rimTopWidth;
  const skirtEndRadius = rimEndRadius + RING_CUP_PROFILE.skirtWidth;
  const atHeight = (height: number) => () => height;
  const centre = Array.from({ length: CUP_SEGMENTS }, () => new THREE.Vector3(zone.centreX, zone.floorHeight, zone.centreZ));
  return [
    sweepStrip([centre, ringOfPoints(zone, floorRadius, atHeight(zone.floorHeight))], true, CUP_FLOOR_COLOUR, facesUp),
    sweepStrip([ringOfPoints(zone, floorRadius, atHeight(zone.floorHeight)), ringOfPoints(zone, zone.radius, atHeight(zone.rimHeight))], true, WHITE_COLOUR, facesUp),
    sweepStrip([ringOfPoints(zone, zone.radius, atHeight(zone.rimHeight)), ringOfPoints(zone, rimEndRadius, atHeight(zone.rimHeight))], true, WHITE_COLOUR, facesUp),
    sweepStrip([ringOfPoints(zone, rimEndRadius, atHeight(zone.rimHeight)), ringOfPoints(zone, skirtEndRadius, (x) => ringBoardPlaneHeight(x))], true, WHITE_COLOUR, facesUp),
  ];
}

/** A board point's height from the model, the point held within the board's plan so an arc's last float digit cannot read as off the board. */
function modelHeightOnBoard(x: number, z: number): number {
  const { minX, maxX, minZ, maxZ } = RING_BOARD_BOUNDS;
  return ringHeightAt(Math.min(maxX, Math.max(minX, x)), Math.min(maxZ, Math.max(minZ, z)));
}

/** One point of the rim's outline (its outer edge) and the unit direction pointing in toward the board's middle. */
type RimStation = { x: number; z: number; inwardX: number; inwardZ: number };

/**
 * The rim's corner on the `side` (-1 left, +1 right) of the lane as stations on a quarter circle from the side's tangent point to
 * the back's: centred on that side's 100 pocket, its radius the pocket's distance to the back edge, as `minigame-ring.ts` measures
 * the rim's depth.
 */
function rimCornerStations(side: -1 | 1): RimStation[] {
  const cornerCentreX = RING_POCKETS[0]!.centreX;
  const cornerCentreZ = RING_POCKETS[1]!.centreZ;
  const cornerRadius = RING_BOARD_BOUNDS.maxX - cornerCentreX;
  return Array.from({ length: CORNER_ARC_SEGMENTS + 1 }, (_, step) => {
    const angle = ((Math.PI / 2) * step) / CORNER_ARC_SEGMENTS;
    return {
      x: cornerCentreX + cornerRadius * Math.sin(angle),
      z: side * (cornerCentreZ + cornerRadius * Math.cos(angle)),
      inwardX: -Math.sin(angle),
      inwardZ: -side * Math.cos(angle),
    };
  });
}

/**
 * The rim's outline: up the left side (-z) from where it starts, round the left corner, straight along the back, round the right
 * corner and down the right side. Side stations are spaced to cut the ramp into `RIM_RAMP_STEPS`, so the bilinear rise there stays
 * within 2 cm of the model.
 */
function rimOutline(): RimStation[] {
  const { maxZ } = RING_BOARD_BOUNDS;
  const sideXs = [...Array.from({ length: RIM_RAMP_STEPS + 1 }, (_, step) => RING_RAIL_START_X + (RING_RAIL_PROFILE.rampLength * step) / RIM_RAMP_STEPS), RING_POCKETS[0]!.centreX];
  const leftSide = sideXs.map((x): RimStation => ({ x, z: -maxZ, inwardX: 0, inwardZ: 1 }));
  const rightSide = sideXs.map((x): RimStation => ({ x, z: maxZ, inwardX: 0, inwardZ: -1 })).reverse();
  return [...leftSide, ...rimCornerStations(-1).slice(1), ...rimCornerStations(1).reverse(), ...rightSide.slice(1)];
}

/**
 * The raised rim: two strips swept along `rimOutline` (the flat top `topWidth` wide, then the inner slope `slopeWidth` wide down to
 * the board), each vertex at the model's height; and the solid fill in each back corner outside the arc, which the model holds at
 * the rim's full height.
 */
function makeRimStrips(): THREE.BufferGeometry[] {
  const insets = [0, RING_RAIL_PROFILE.topWidth, RING_RAIL_PROFILE.topWidth + RING_RAIL_PROFILE.slopeWidth];
  const [outerLine, innerTopLine, footLine] = insets.map((inset) =>
    rimOutline().map((station) => {
      const x = station.x + station.inwardX * inset;
      const z = station.z + station.inwardZ * inset;
      return new THREE.Vector3(x, modelHeightOnBoard(x, z), z);
    }),
  );
  const { maxX, maxZ } = RING_BOARD_BOUNDS;
  const fills = ([-1, 1] as const).map((side) => {
    const cornerPoint = new THREE.Vector3(maxX, modelHeightOnBoard(maxX, side * maxZ), side * maxZ);
    const arcLine = rimCornerStations(side).map((station) => new THREE.Vector3(station.x, modelHeightOnBoard(station.x, station.z), station.z));
    return sweepStrip([arcLine.map(() => cornerPoint), arcLine], false, WHITE_COLOUR, facesUp);
  });
  return [sweepStrip([outerLine!, innerTopLine!], false, WHITE_COLOUR, facesUp), sweepStrip([innerTopLine!, footLine!], false, WHITE_COLOUR, facesUp), ...fills];
}

/** All the glossy white: every cup and pocket, and the rim. */
function makeWhiteGeometry(): THREE.BufferGeometry {
  return mergedAndDisposed([...ZONES.flatMap((zone) => makeCupStrips(zone)), ...makeRimStrips()]);
}

/** The wood: the sloped board plane from the lip end to the back, and its skirt, a wall from the model's height along the sides and back down to the pad. */
function makeWoodGeometry(): THREE.BufferGeometry {
  const { minX, maxX, minZ, maxZ } = RING_BOARD_BOUNDS;
  const plane = sweepStrip(
    [
      [new THREE.Vector3(minX, ringBoardPlaneHeight(minX), minZ), new THREE.Vector3(minX, ringBoardPlaneHeight(minX), maxZ)],
      [new THREE.Vector3(maxX, ringBoardPlaneHeight(maxX), minZ), new THREE.Vector3(maxX, ringBoardPlaneHeight(maxX), maxZ)],
    ],
    false,
    WOOD_BOARD_COLOUR,
    facesUp,
  );
  // The rim's height is linear in x between these stations (flat before its start, rising over its ramp, then the board's own slope).
  const sideXs = [minX, RING_RAIL_START_X, RING_RAIL_START_X + RING_RAIL_PROFILE.rampLength, maxX];
  const outline = [...sideXs.map((x) => ({ x, z: minZ })), ...[...sideXs].reverse().map((x) => ({ x, z: maxZ }))];
  const top = outline.map((point) => new THREE.Vector3(point.x, modelHeightOnBoard(point.x, point.z), point.z));
  const foot = outline.map((point) => new THREE.Vector3(point.x, 0, point.z));
  const middleX = (minX + maxX) / 2;
  const facesOutward: Facing = (normal, centroid) => normal.x * (centroid.x - middleX) + normal.z * centroid.z > 0;
  return mergedAndDisposed([plane, sweepStrip([top, foot], false, WOOD_SKIRT_COLOUR, facesOutward)]);
}

/** One numeral per atlas cell: a near-white plate with the black score, centred in the cell. */
function drawNumeralAtlas(context: CanvasRenderingContext2D): void {
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `bold ${NUMERAL_CELL_HEIGHT * NUMERAL_FONT_PER_CELL_HEIGHT}px sans-serif`;
  for (let cell = 0; cell < NUMERAL_SCORES.length; cell++) {
    const left = (cell % NUMERAL_ATLAS_COLUMNS) * NUMERAL_CELL_WIDTH;
    const top = Math.floor(cell / NUMERAL_ATLAS_COLUMNS) * NUMERAL_CELL_HEIGHT;
    context.fillStyle = NUMERAL_PLATE_COLOUR;
    context.fillRect(left, top, NUMERAL_CELL_WIDTH, NUMERAL_CELL_HEIGHT);
    context.fillStyle = NUMERAL_INK_COLOUR;
    context.fillText(String(NUMERAL_SCORES[cell]), left + NUMERAL_CELL_WIDTH / 2, top + NUMERAL_CELL_HEIGHT / 2, NUMERAL_CELL_WIDTH * NUMERAL_TEXT_PER_CELL_WIDTH);
  }
}

/** One flat plate per zone at its centre, sized so its corners reach `NUMERAL_PLATE_CORNER_REACH` of the floor radius, reading upright from the lip (text up = +x), textured from the zone's score cell of the atlas. */
function makeNumeralGeometry(): THREE.BufferGeometry {
  const plateWidthPerReach = 1 / hypot2(1, NUMERAL_CELL_HEIGHT / NUMERAL_CELL_WIDTH);
  const plates = ZONES.map((zone) => {
    const width = 2 * NUMERAL_PLATE_CORNER_REACH * floorRadiusOf(zone) * plateWidthPerReach;
    const height = (width * NUMERAL_CELL_HEIGHT) / NUMERAL_CELL_WIDTH;
    const plate = new THREE.PlaneGeometry(width, height).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2).translate(zone.centreX, zone.floorHeight + NUMERAL_LIFT, zone.centreZ);
    const cell = NUMERAL_SCORES.indexOf(zone.score);
    const column = cell % NUMERAL_ATLAS_COLUMNS;
    const row = Math.floor(cell / NUMERAL_ATLAS_COLUMNS);
    const uv = plate.getAttribute("uv");
    for (let corner = 0; corner < uv.count; corner++) uv.setXY(corner, (column + uv.getX(corner)) / NUMERAL_ATLAS_COLUMNS, 1 - (row + 1 - uv.getY(corner)) / NUMERAL_ATLAS_ROWS);
    return plate;
  });
  return mergedAndDisposed(plates);
}

/** The backboard's face: the red title and the lit score strip on black. */
function drawBackboardFace(context: CanvasRenderingContext2D, widthPixels: number, heightPixels: number): void {
  context.fillStyle = "#08090b";
  context.fillRect(0, 0, widthPixels, heightPixels);
  const strip = {
    left: SCORE_STRIP.left * widthPixels,
    top: SCORE_STRIP.top * heightPixels,
    width: (SCORE_STRIP.right - SCORE_STRIP.left) * widthPixels,
    height: (SCORE_STRIP.bottom - SCORE_STRIP.top) * heightPixels,
  };
  context.fillStyle = "#1a2a1a";
  context.fillRect(strip.left, strip.top, strip.width, strip.height);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffe14d";
  context.font = `bold ${strip.height * SCORE_LABEL_LINE.fontPerHeight}px sans-serif`;
  context.fillText(SCORE_PANEL_TEXT, strip.left + strip.width / 2, strip.top + strip.height * SCORE_LABEL_LINE.centreYPerHeight, strip.width);
  context.fillStyle = CANVAS_WHITE;
  context.font = `bold ${strip.height * SCORE_DIGITS_LINE.fontPerHeight}px sans-serif`;
  context.fillText(SCORE_PANEL_DIGITS, strip.left + strip.width / 2, strip.top + strip.height * SCORE_DIGITS_LINE.centreYPerHeight, strip.width);
  context.fillStyle = TITLE_RED;
  context.font = `bold ${widthPixels * TITLE_FONT_PER_WIDTH}px sans-serif`;
  context.fillText(TITLE_TEXT, widthPixels / 2, TITLE_CENTRE_Y * heightPixels, widthPixels * TITLE_TEXT_PER_WIDTH);
}

function clamped(texture: THREE.CanvasTexture): THREE.CanvasTexture {
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function meshOf(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, shadows: { cast: boolean; receive: boolean }): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = shadows.cast;
  mesh.receiveShadow = shadows.receive;
  return mesh;
}

/** The backboard: a black slab whose front face stands at `RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard`, spanning the board plus the rim's height either side, with its face texture a hair in front. */
function makeBackboard(): THREE.Mesh[] {
  const width = RING_BOARD_BOUNDS.maxZ - RING_BOARD_BOUNDS.minZ + 2 * RING_RAIL_PROFILE.height;
  const frontX = RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard;
  const slab = meshOf(
    "ring-backboard",
    new THREE.BoxGeometry(RING_BACKSTOP.thickness, RING_BACKSTOP.height, width).translate(frontX + RING_BACKSTOP.thickness / 2, RING_BACKSTOP.height / 2, 0),
    new THREE.MeshStandardMaterial({ color: BACKBOARD_COLOUR, roughness: 0.6, metalness: 0 }),
    { cast: true, receive: true },
  );
  const faceCanvasHeight = Math.round((FACE_CANVAS_WIDTH * RING_BACKSTOP.height) / width);
  const faceTexture = clamped(canvasTexture(FACE_CANVAS_WIDTH, faceCanvasHeight, (context) => drawBackboardFace(context, FACE_CANVAS_WIDTH, faceCanvasHeight)));
  // A +z plane turned -90 degrees about y faces -x, back toward the lip, with its right edge on +z.
  const face = meshOf(
    "ring-backboard-face",
    new THREE.PlaneGeometry(width, RING_BACKSTOP.height).rotateY(-Math.PI / 2).translate(frontX - FACE_LIFT, RING_BACKSTOP.height / 2, 0),
    new THREE.MeshStandardMaterial({ map: faceTexture, emissiveMap: faceTexture, emissive: 0xffffff, roughness: 0.5, metalness: 0 }),
    { cast: false, receive: false },
  );
  return [slab, face];
}

export function makeRingFlingArt(): THREE.Group {
  const art = new THREE.Group();
  art.name = "ring-fling";
  art.add(makeStationSurface(MINIGAME_MODE.ringFling, STATION_SURFACE_STYLES.ringFling));
  art.add(meshOf("ring-board-wood", makeWoodGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: WOOD_ROUGHNESS, metalness: 0, side: THREE.DoubleSide }), { cast: false, receive: true }));
  art.add(meshOf("ring-board-white", makeWhiteGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: GLOSSY_WHITE_ROUGHNESS, metalness: 0 }), { cast: true, receive: true }));
  const numeralTexture = clamped(canvasTexture(NUMERAL_CELL_WIDTH * NUMERAL_ATLAS_COLUMNS, NUMERAL_CELL_HEIGHT * NUMERAL_ATLAS_ROWS, drawNumeralAtlas));
  art.add(meshOf("ring-numerals", makeNumeralGeometry(), new THREE.MeshStandardMaterial({ map: numeralTexture, roughness: WOOD_ROUGHNESS, metalness: 0 }), { cast: false, receive: true }));
  for (const piece of makeBackboard()) art.add(piece);
  let draws = 0;
  art.traverse((object) => {
    if (object instanceof THREE.Mesh) draws++;
  });
  if (draws > RING_FLING_DRAW_BUDGET) throw new Error(`Ring Fling art draws ${draws} meshes, over the budget of ${RING_FLING_DRAW_BUDGET}`);
  return art;
}
