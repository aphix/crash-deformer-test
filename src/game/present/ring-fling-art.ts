import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  RING_BACKSTOP,
  RING_BOARD_BOUNDS,
  RING_CUPS,
  RING_CUP_PROFILE,
  RING_MESH_STEP,
  RING_POCKETS,
  RING_RAIL_PROFILE,
  ringBoardMesh,
  ringBoardPlaneHeight,
  ringHeightAt,
  type RingZone,
} from "../scenes/minigame-ring.ts";
import { canvasTexture } from "./lab-art.ts";
import { makeStationSurface, STATION_SURFACE_STYLES } from "./minigame-surface-art.ts";

/**
 * The Ring Fling station in station-local coordinates (+x throw, x = 0 the lip, z = 0 the lane centre, y from the pad): the dark
 * lane's surface, the target board (one vertex-coloured mesh sampled from `ringHeightAt`: cream board, white cups, pockets and rim,
 * darker cup floors), a numeral on every cup and pocket floor, and the tall black backboard with the red title and a lit score strip
 * (the physics backstop stands where `RING_BACKSTOP` puts it). The surface is one draw; the board, skirt, numerals, backboard and face are five more.
 */

/** Most draws the whole station may cost: the surface, the board, its wooden skirt, the numerals, the backboard and its face. */
export const RING_FLING_DRAW_BUDGET = 10;

const BOARD_COLOUR = 0xe6d8b8;
const CUP_WHITE = 0xf5f5f1;
const CUP_FLOOR_COLOUR = 0xd2d2cb;
const SKIRT_COLOUR = 0x8c6a43;
const BACKBOARD_COLOUR = 0x16171b;
/** A vertex this much (m) over the bare board plane belongs to a cup wall, a rim or a skirt, not the board itself. */
const RAISED_THRESHOLD = 0.001;
const BOARD_ROUGHNESS = 0.45;

/** The numerals' atlas: one 2:1 cell per score, left to right then down, black on transparent. */
const NUMERAL_CELL_WIDTH = 256;
const NUMERAL_CELL_HEIGHT = 128;
const NUMERAL_ATLAS_COLUMNS = 3;
/** A numeral's quad is this many cup floor radii wide; at 2:1 its corners then stay inside the floor circle. */
const NUMERAL_FLOOR_RADII_WIDE = 1.6;
/** Height (m) a numeral hovers over its cup floor: clear of z-fighting. */
const NUMERAL_LIFT = 0.02;
const NUMERAL_FONT_PER_CELL_HEIGHT = 0.8;
const NUMERAL_TEXT_PER_CELL_WIDTH = 0.9;

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

function isOnCupFloor(localX: number, localZ: number): boolean {
  return ZONES.some((zone) => Math.hypot(localX - zone.centreX, localZ - zone.centreZ) <= zone.radius - RING_CUP_PROFILE.wallFootWidth);
}

function boardColour(localX: number, height: number, localZ: number): number {
  if (isOnCupFloor(localX, localZ)) return CUP_FLOOR_COLOUR;
  return height - ringBoardPlaneHeight(localX) > RAISED_THRESHOLD ? CUP_WHITE : BOARD_COLOUR;
}

/** The board: `ringBoardMesh`'s lattice (the ragdoll's own triangles), each vertex coloured by what stands there. */
function makeBoardGeometry(): THREE.BufferGeometry {
  const { vertices, indices } = ringBoardMesh(RING_MESH_STEP);
  const colours = new Float32Array(vertices.length);
  const paint = new THREE.Color();
  for (let at = 0; at < vertices.length; at += COMPONENTS) {
    paint.setHex(boardColour(vertices[at]!, vertices[at + 1]!, vertices[at + 2]!));
    colours.set([paint.r, paint.g, paint.b], at);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, COMPONENTS));
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, COMPONENTS));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** The board's wooden sides and back: a wall from every edge sample of `ringHeightAt` (front edge excepted: it starts at pad height) down to the pad. */
function makeSkirtGeometry(): THREE.BufferGeometry {
  const { minX, maxX, minZ, maxZ } = RING_BOARD_BOUNDS;
  const corners = [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
  const positions: number[] = [];
  for (let side = 0; side < corners.length - 1; side++) {
    const from = corners[side]!;
    const to = corners[side + 1]!;
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / RING_MESH_STEP);
    for (let step = 0; step < steps; step++) {
      const nearX = from.x + ((to.x - from.x) * step) / steps;
      const nearZ = from.z + ((to.z - from.z) * step) / steps;
      const farX = from.x + ((to.x - from.x) * (step + 1)) / steps;
      const farZ = from.z + ((to.z - from.z) * (step + 1)) / steps;
      const nearTop = [nearX, ringHeightAt(nearX, nearZ), nearZ];
      const farTop = [farX, ringHeightAt(farX, farZ), farZ];
      const nearFoot = [nearX, 0, nearZ];
      const farFoot = [farX, 0, farZ];
      positions.push(...nearTop, ...nearFoot, ...farTop, ...farTop, ...nearFoot, ...farFoot);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, COMPONENTS));
  geometry.computeVertexNormals();
  return geometry;
}

/** Black numerals on transparent, one per atlas cell, centred in it. */
function drawNumeralAtlas(context: CanvasRenderingContext2D): void {
  context.fillStyle = "#000000";
  context.font = `bold ${NUMERAL_CELL_HEIGHT * NUMERAL_FONT_PER_CELL_HEIGHT}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let cell = 0; cell < NUMERAL_SCORES.length; cell++) {
    const column = cell % NUMERAL_ATLAS_COLUMNS;
    const row = Math.floor(cell / NUMERAL_ATLAS_COLUMNS);
    context.fillText(
      String(NUMERAL_SCORES[cell]),
      (column + 0.5) * NUMERAL_CELL_WIDTH,
      (row + 0.5) * NUMERAL_CELL_HEIGHT,
      NUMERAL_CELL_WIDTH * NUMERAL_TEXT_PER_CELL_WIDTH,
    );
  }
}

/** One flat quad per zone at its centre, reading upright from the lip (text up = +x), textured from the zone's score cell of the atlas. */
function makeNumeralGeometry(): THREE.BufferGeometry {
  const quads = ZONES.map((zone) => {
    const width = (zone.radius - RING_CUP_PROFILE.wallFootWidth) * NUMERAL_FLOOR_RADII_WIDE;
    const height = (width * NUMERAL_CELL_HEIGHT) / NUMERAL_CELL_WIDTH;
    const quad = new THREE.PlaneGeometry(width, height).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2).translate(zone.centreX, zone.floorHeight + NUMERAL_LIFT, zone.centreZ);
    const cell = NUMERAL_SCORES.indexOf(zone.score);
    const column = cell % NUMERAL_ATLAS_COLUMNS;
    const row = Math.floor(cell / NUMERAL_ATLAS_COLUMNS);
    const uv = quad.getAttribute("uv");
    for (let corner = 0; corner < uv.count; corner++) uv.setXY(corner, (column + uv.getX(corner)) / NUMERAL_ATLAS_COLUMNS, 1 - (row + 1 - uv.getY(corner)) / NUMERAL_ATLAS_ROWS);
    return quad;
  });
  const merged = mergeGeometries(quads)!;
  for (const quad of quads) quad.dispose();
  return merged;
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
  context.fillStyle = "#ffffff";
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
  art.add(makeStationSurface("ringFling", STATION_SURFACE_STYLES.ringFling));
  art.add(meshOf("ring-board", makeBoardGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: BOARD_ROUGHNESS, metalness: 0 }), { cast: true, receive: true }));
  art.add(
    meshOf("ring-board-skirt", makeSkirtGeometry(), new THREE.MeshStandardMaterial({ color: SKIRT_COLOUR, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }), { cast: false, receive: true }),
  );
  const numeralTexture = clamped(canvasTexture(NUMERAL_CELL_WIDTH * NUMERAL_ATLAS_COLUMNS, NUMERAL_CELL_HEIGHT * NUMERAL_ATLAS_ROWS, drawNumeralAtlas));
  art.add(
    meshOf("ring-numerals", makeNumeralGeometry(), new THREE.MeshStandardMaterial({ map: numeralTexture, alphaTest: 0.5, roughness: BOARD_ROUGHNESS, metalness: 0 }), { cast: false, receive: true }),
  );
  for (const piece of makeBackboard()) art.add(piece);
  let draws = 0;
  art.traverse((object) => {
    if (object instanceof THREE.Mesh) draws++;
  });
  if (draws > RING_FLING_DRAW_BUDGET) throw new Error(`Ring Fling art draws ${draws} meshes, over the budget of ${RING_FLING_DRAW_BUDGET}`);
  return art;
}
