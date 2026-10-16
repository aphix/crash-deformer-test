import * as THREE from "three";
import { LANDING_HEIGHT, START_HILL, STATION_HALF_WIDTH, type MinigameMode } from "../scenes/minigame-constants.ts";
import { floorHeightAt, stationBackX, stationFrontX } from "../scenes/minigame-profile.ts";
import { groundMesh } from "../scenes/ground-stack.ts";

/**
 * A station's whole band (the lane's `STATION_HALF_WIDTH` either side, the part of the sim ground that follows `floorHeightAt`) is one
 * vertex-coloured mesh: terrain colour with the painted strip down its middle, and a wall at each side from the floor to the pad's level
 * wherever the floor is not level with it, so a trench has walls and a kicker a solid flank. The pad around the bands is the flat ground
 * (`makeFlatGround`); both share the terrain colour and meet edge to edge, so nothing overlaps and nothing floats over a void.
 */

/** Most draws one station's surface may cost (the surface and whatever a station adds to it). */
export const SURFACE_DRAW_CALL_BUDGET = 4;

/** Along the run, cells are this long (m): the tightest bends (the high jump's kicker near its lip, Ring Fling's hop) then leave a chord error under 2 mm. */
export const SURFACE_STEP = 0.2;
/** Break points closer than this (m) are one. */
const BREAKPOINT_MERGE_DISTANCE = 1e-6;
/** A floor within this many metres of the pad's level counts as level with it: no side wall there. */
const SKIRT_MIN_HEIGHT = 1e-4;

/** The centre line's dashes: on for `DASH_ON_STEPS` cells of every `DASH_PERIOD_STEPS`. */
const DASH_ON_STEPS = 12;
const DASH_PERIOD_STEPS = 24;
const CENTRE_LINE_WIDTH = 0.25;
const EDGE_LINE_WIDTH = 0.2;
/** Gap (m) between a lane's side and its edge line. */
const EDGE_LINE_INSET = 0.3;
/** The start pad's bars: this long (m) across the lane, alternating bar and bare floor from the pad's back end. */
const PAD_BAR_LENGTH = 1;

/** Dark grey concrete: the ground beside the strips and around the stations, and the side walls of the bands. */
export const SURFACE_TERRAIN_COLOUR = 0x696c70;
const SURFACE_ROUGHNESS = 0.9;

/** A station surface's look: lane half width (m, within the station's), its paint, each paint absent as null. */
type StationSurfaceStyle = {
  laneHalfWidth: number;
  baseColour: number;
  centreDashColour: number | null;
  edgeLineColour: number | null;
  startPadBarColour: number | null;
};

/** The three stations' surfaces: grey asphalt with white lines and a yellow-barred pad, the red run-up strip, the dark lane. */
export const STATION_SURFACE_STYLES: Readonly<Record<MinigameMode, StationSurfaceStyle>> = {
  longJump: { laneHalfWidth: 5, baseColour: 0x4d5056, centreDashColour: 0xe9e9e2, edgeLineColour: 0xe9e9e2, startPadBarColour: 0xe3b61f },
  highJump: { laneHalfWidth: 4, baseColour: 0x9b2c24, centreDashColour: 0xf2f2ec, edgeLineColour: 0xf2f2ec, startPadBarColour: null },
  ringFling: { laneHalfWidth: 3, baseColour: 0x25282d, centreDashColour: null, edgeLineColour: 0xcfd3d8, startPadBarColour: null },
};

/** A rectangle on the ground plan (m). */
export type GroundRectangle = { minX: number; maxX: number; minZ: number; maxZ: number };

/** A point (x, y, z). */
type Corner = readonly [number, number, number];
/** Triangles written out one after the other: three corners each, and the colour of each corner. */
type TriangleSoup = { positions: number[]; colours: number[] };

function addTriangle(soup: TriangleSoup, paint: THREE.Color, first: Corner, second: Corner, third: Corner): void {
  for (const corner of [first, second, third]) {
    soup.positions.push(...corner);
    soup.colours.push(paint.r, paint.g, paint.b);
  }
}

/** The quad of corners `a`, `b` (down the first edge) and `c`, `d` (down the opposite one) as two triangles: (a, b, c) and (c, b, d). */
function addQuad(soup: TriangleSoup, paint: THREE.Color, a: Corner, b: Corner, c: Corner, d: Corner): void {
  addTriangle(soup, paint, a, b, c);
  addTriangle(soup, paint, c, b, d);
}

/** The station's band in its own frame: from the back of the pad to the front of the back drop, `STATION_HALF_WIDTH` either side of the lane's middle. */
export function stationBandBounds(mode: MinigameMode): GroundRectangle {
  return { minX: stationBackX(mode), maxX: stationFrontX(mode), minZ: -STATION_HALF_WIDTH, maxZ: STATION_HALF_WIDTH };
}

/** Cell boundaries along the run, ascending: the station's two ends exactly, then the lip, the pad's end and bars, and every `SURFACE_STEP` from the lip. */
function alongRunBreakpoints(mode: MinigameMode): number[] {
  const backX = stationBackX(mode);
  const frontX = stationFrontX(mode);
  const padEndX = backX + START_HILL.padLength;
  const padBarEdges = Array.from({ length: Math.floor(START_HILL.padLength / PAD_BAR_LENGTH) }, (_, index) => backX + (index + 1) * PAD_BAR_LENGTH);
  const stepEdges = Array.from({ length: Math.floor((frontX - backX) / SURFACE_STEP) + 1 }, (_, index) => (Math.ceil(backX / SURFACE_STEP) + index) * SURFACE_STEP);
  const interior = [0, padEndX, ...padBarEdges, ...stepEdges]
    .filter((x) => x > backX + BREAKPOINT_MERGE_DISTANCE && x < frontX - BREAKPOINT_MERGE_DISTANCE)
    .sort((a, b) => a - b)
    .filter((x, index, sorted) => index === 0 || x - sorted[index - 1]! > BREAKPOINT_MERGE_DISTANCE);
  return [backX, ...interior, frontX];
}

/** Cell boundaries across the band, ascending: its two sides, the strip's sides and the edges of each line the style paints. */
function acrossBandBreakpoints(style: StationSurfaceStyle): number[] {
  const edgeLineOuter = style.laneHalfWidth - EDGE_LINE_INSET;
  const halfOffsets = [
    style.laneHalfWidth,
    ...(style.edgeLineColour === null ? [] : [edgeLineOuter, edgeLineOuter - EDGE_LINE_WIDTH]),
    ...(style.centreDashColour === null ? [] : [CENTRE_LINE_WIDTH / 2]),
  ];
  const inner = [...halfOffsets.map((offset) => -offset), ...halfOffsets].sort((a, b) => a - b);
  return [-STATION_HALF_WIDTH, ...inner, STATION_HALF_WIDTH];
}

/** Whether the cell centred at `centreX` lies in a dash of the centre line (dashes start on the lip's grid). */
function isInDash(centreX: number): boolean {
  const stepIndex = Math.floor(centreX / SURFACE_STEP);
  return (((stepIndex % DASH_PERIOD_STEPS) + DASH_PERIOD_STEPS) % DASH_PERIOD_STEPS) < DASH_ON_STEPS;
}

/** The colour (hex) of the cell centred at (`centreX`, `centreZ`): terrain beside the strip, the strip's paint on it. */
function cellColour(mode: MinigameMode, style: StationSurfaceStyle, centreX: number, centreZ: number): number {
  const acrossLane = Math.abs(centreZ);
  if (acrossLane > style.laneHalfWidth) return SURFACE_TERRAIN_COLOUR;
  const edgeLineOuter = style.laneHalfWidth - EDGE_LINE_INSET;
  if (style.centreDashColour !== null && acrossLane < CENTRE_LINE_WIDTH / 2 && isInDash(centreX)) return style.centreDashColour;
  if (style.edgeLineColour !== null && acrossLane > edgeLineOuter - EDGE_LINE_WIDTH && acrossLane < edgeLineOuter) return style.edgeLineColour;
  const intoPad = centreX - stationBackX(mode);
  const isOnPadBar = intoPad < START_HILL.padLength && Math.floor(intoPad / PAD_BAR_LENGTH) % 2 === 0;
  if (style.startPadBarColour !== null && isOnPadBar) return style.startPadBarColour;
  return style.baseColour;
}

/** The floor's cells: a quad per boundary pair, its corners on `heights[column][row]`, painted by `cellColour`. */
function addFloorCells(soup: TriangleSoup, mode: MinigameMode, style: StationSurfaceStyle, xs: readonly number[], zs: readonly number[], heights: readonly (readonly number[])[]): void {
  const paint = new THREE.Color();
  for (let column = 0; column < xs.length - 1; column++) {
    for (let row = 0; row < zs.length - 1; row++) {
      paint.setHex(cellColour(mode, style, (xs[column]! + xs[column + 1]!) / 2, (zs[row]! + zs[row + 1]!) / 2));
      const nearLeft: Corner = [xs[column]!, heights[column]![row]!, zs[row]!];
      const nearRight: Corner = [xs[column]!, heights[column]![row + 1]!, zs[row + 1]!];
      const farLeft: Corner = [xs[column + 1]!, heights[column + 1]![row]!, zs[row]!];
      const farRight: Corner = [xs[column + 1]!, heights[column + 1]![row + 1]!, zs[row + 1]!];
      addQuad(soup, paint, nearLeft, nearRight, farLeft, farRight);
    }
  }
}

/**
 * The walls of the band: along each side edge, a quad per pair of columns from the floor down (or up) to the pad's level, left out
 * where the floor is level with it. Wound so the visible face is the one outside a raised floor and the one inside a trench.
 */
function addSideWalls(soup: TriangleSoup, xs: readonly number[], zs: readonly number[], heights: readonly (readonly number[])[]): void {
  const paint = new THREE.Color(SURFACE_TERRAIN_COLOUR);
  for (const side of [-1, 1] as const) {
    const edgeRow = side === 1 ? zs.length - 1 : 0;
    const z = zs[edgeRow]!;
    for (let column = 0; column < xs.length - 1; column++) {
      const topNear = heights[column]![edgeRow]!;
      const topFar = heights[column + 1]![edgeRow]!;
      if (Math.max(Math.abs(topNear), Math.abs(topFar)) <= SKIRT_MIN_HEIGHT) continue;
      const top: Corner = [xs[column]!, topNear, z];
      const farTop: Corner = [xs[column + 1]!, topFar, z];
      const foot: Corner = [xs[column]!, LANDING_HEIGHT, z];
      const farFoot: Corner = [xs[column + 1]!, LANDING_HEIGHT, z];
      if (side === 1) addQuad(soup, paint, top, foot, farTop, farFoot);
      else addQuad(soup, paint, top, farTop, foot, farFoot);
    }
  }
}

function terrainMesh(soup: TriangleSoup): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(soup.positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(soup.colours, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: SURFACE_ROUGHNESS, metalness: 0 });
  const mesh = groundMesh(geometry, material, "terrain");
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * The surface of station `mode` in station-local coordinates (+x throw, x = 0 the lip, y from the pad): its band (`stationBandBounds`,
 * the back drop behind the high jump's and Ring Fling's lip included) as one mesh whose every floor vertex lies on `floorHeightAt`,
 * the strip painted down the middle and the side walls at both edges.
 */
export function makeStationSurface(mode: MinigameMode, style: StationSurfaceStyle): THREE.Group {
  const xs = alongRunBreakpoints(mode);
  // ponytail: columns are the paint's edges only, since the floor is the same across the lane; add a lateral step if a floor ever banks.
  const zs = acrossBandBreakpoints(style);
  const heights = xs.map((x) => zs.map((z) => floorHeightAt(mode, x, z)));
  const soup: TriangleSoup = { positions: [], colours: [] };
  addFloorCells(soup, mode, style, xs, zs, heights);
  addSideWalls(soup, xs, zs, heights);
  const group = new THREE.Group();
  group.name = `station-surface:${mode}`;
  group.add(terrainMesh(soup));
  if (group.children.length > SURFACE_DRAW_CALL_BUDGET) throw new Error(`station surface ${mode} draws ${group.children.length} meshes, over the budget of ${SURFACE_DRAW_CALL_BUDGET}`);
  return group;
}

/** Ascending, merged edges: `lowest`, `highest` and the `inside` values between them, none closer than `BREAKPOINT_MERGE_DISTANCE`. */
function tileEdges(lowest: number, highest: number, inside: readonly number[]): number[] {
  return [lowest, ...inside.filter((edge) => edge > lowest && edge < highest), highest]
    .sort((a, b) => a - b)
    .filter((edge, index, sorted) => index === 0 || edge - sorted[index - 1]! > BREAKPOINT_MERGE_DISTANCE);
}

/**
 * `extent` cut into rectangles that leave `holes` bare: the grid of every edge of the extent and the holes, minus the cells whose
 * middle is in a hole. A hole's side is then always a tile's side, so tiles meet the hole's rim exactly.
 */
export function flatGroundTiles(extent: GroundRectangle, holes: readonly GroundRectangle[]): GroundRectangle[] {
  const xs = tileEdges(extent.minX, extent.maxX, holes.flatMap((hole) => [hole.minX, hole.maxX]));
  const zs = tileEdges(extent.minZ, extent.maxZ, holes.flatMap((hole) => [hole.minZ, hole.maxZ]));
  const tiles: GroundRectangle[] = [];
  for (let column = 0; column < xs.length - 1; column++) {
    for (let row = 0; row < zs.length - 1; row++) {
      const centreX = (xs[column]! + xs[column + 1]!) / 2;
      const centreZ = (zs[row]! + zs[row + 1]!) / 2;
      const isInHole = holes.some((hole) => centreX > hole.minX && centreX < hole.maxX && centreZ > hole.minZ && centreZ < hole.maxZ);
      if (!isInHole) tiles.push({ minX: xs[column]!, maxX: xs[column + 1]!, minZ: zs[row]!, maxZ: zs[row + 1]! });
    }
  }
  return tiles;
}

/** One mesh of flat terrain at the pad's level over `tiles`, in world coordinates, one draw. */
export function makeFlatGround(name: string, tiles: readonly GroundRectangle[]): THREE.Mesh {
  const soup: TriangleSoup = { positions: [], colours: [] };
  const paint = new THREE.Color(SURFACE_TERRAIN_COLOUR);
  for (const tile of tiles) {
    addQuad(
      soup,
      paint,
      [tile.minX, LANDING_HEIGHT, tile.minZ],
      [tile.minX, LANDING_HEIGHT, tile.maxZ],
      [tile.maxX, LANDING_HEIGHT, tile.minZ],
      [tile.maxX, LANDING_HEIGHT, tile.maxZ],
    );
  }
  const ground = terrainMesh(soup);
  ground.name = name;
  return ground;
}
