import * as THREE from "three";
import { START_HILL, type MinigameMode } from "../scenes/minigame-constants.ts";
import { floorHeightAt, stationBackX, stationFrontX } from "../scenes/minigame-profile.ts";
import { groundMesh } from "../scenes/ground-stack.ts";

/**
 * Every station's driving surface is one vertex-coloured mesh: a grid over the floor function, a cell per colour patch (lane, dash,
 * edge line, pad bar), so the paint lies exactly on the floor and no texture, canvas or second draw is needed.
 */

/** Most draws one station's surface may cost (the surface and whatever a station adds to it). */
export const SURFACE_DRAW_CALL_BUDGET = 4;

/** Along the run, cells are this long (m): the tightest bends (the high jump's kicker near its lip, Ring Fling's hop) then leave a chord error under 2 mm. */
export const SURFACE_STEP = 0.2;
/** Break points closer than this (m) are one. */
const BREAKPOINT_MERGE_DISTANCE = 1e-6;

/** The centre line's dashes: on for `DASH_ON_STEPS` cells of every `DASH_PERIOD_STEPS`. */
const DASH_ON_STEPS = 12;
const DASH_PERIOD_STEPS = 24;
const CENTRE_LINE_WIDTH = 0.25;
const EDGE_LINE_WIDTH = 0.2;
/** Gap (m) between a lane's side and its edge line. */
const EDGE_LINE_INSET = 0.3;
/** The start pad's bars: this long (m) across the lane, alternating bar and bare floor from the pad's back end. */
const PAD_BAR_LENGTH = 1;

const COMPONENTS = 3;
const VERTICES_PER_CELL = 6;
/** A cell's two triangles, counter-clockwise from above: each corner as its (column, row) offset from the cell's first. */
const CELL_TRIANGLE_CORNERS = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

const FLOOR_ROUGHNESS = 0.95;

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

/** Cell boundaries across the lane, ascending: its sides, and the edges of each line the style paints. */
function acrossLaneBreakpoints(style: StationSurfaceStyle): number[] {
  const edgeLineOuter = style.laneHalfWidth - EDGE_LINE_INSET;
  const halfOffsets = [
    style.laneHalfWidth,
    ...(style.edgeLineColour === null ? [] : [edgeLineOuter, edgeLineOuter - EDGE_LINE_WIDTH]),
    ...(style.centreDashColour === null ? [] : [CENTRE_LINE_WIDTH / 2]),
  ];
  return [...halfOffsets.map((offset) => -offset), ...halfOffsets].sort((a, b) => a - b);
}

/** Whether the cell centred at `centreX` lies in a dash of the centre line (dashes start on the lip's grid). */
function isInDash(centreX: number): boolean {
  const stepIndex = Math.floor(centreX / SURFACE_STEP);
  return (((stepIndex % DASH_PERIOD_STEPS) + DASH_PERIOD_STEPS) % DASH_PERIOD_STEPS) < DASH_ON_STEPS;
}

/** The colour (hex) of the cell centred at (`centreX`, `centreZ`). */
function cellColour(mode: MinigameMode, style: StationSurfaceStyle, centreX: number, centreZ: number): number {
  const acrossLane = Math.abs(centreZ);
  const edgeLineOuter = style.laneHalfWidth - EDGE_LINE_INSET;
  if (style.centreDashColour !== null && acrossLane < CENTRE_LINE_WIDTH / 2 && isInDash(centreX)) return style.centreDashColour;
  if (style.edgeLineColour !== null && acrossLane > edgeLineOuter - EDGE_LINE_WIDTH && acrossLane < edgeLineOuter) return style.edgeLineColour;
  const intoPad = centreX - stationBackX(mode);
  const isOnPadBar = intoPad < START_HILL.padLength && Math.floor(intoPad / PAD_BAR_LENGTH) % 2 === 0;
  if (style.startPadBarColour !== null && isOnPadBar) return style.startPadBarColour;
  return style.baseColour;
}

/**
 * The surface of station `mode` in station-local coordinates (+x throw, x = 0 the lip, y from the pad): the floor from
 * `stationBackX` to `stationFrontX` (the drop behind the high jump's and Ring Fling's lip included), `style.laneHalfWidth` m either
 * side of the lane's middle, one mesh whose every vertex lies on `floorHeightAt`.
 */
export function makeStationSurface(mode: MinigameMode, style: StationSurfaceStyle): THREE.Group {
  const xs = alongRunBreakpoints(mode);
  // ponytail: columns are the paint's edges only, since the floor is the same across the lane; add a lateral step if a floor ever banks.
  const zs = acrossLaneBreakpoints(style);
  const heights = xs.map((x) => zs.map((z) => floorHeightAt(mode, x, z)));
  const cellCount = (xs.length - 1) * (zs.length - 1);
  const positions = new Float32Array(cellCount * VERTICES_PER_CELL * COMPONENTS);
  const colours = new Float32Array(positions.length);
  const paint = new THREE.Color();
  let cursor = 0;
  for (let column = 0; column < xs.length - 1; column++) {
    for (let row = 0; row < zs.length - 1; row++) {
      paint.setHex(cellColour(mode, style, (xs[column]! + xs[column + 1]!) / 2, (zs[row]! + zs[row + 1]!) / 2));
      for (const [columnOffset, rowOffset] of CELL_TRIANGLE_CORNERS) {
        const cornerColumn = column + columnOffset;
        const cornerRow = row + rowOffset;
        positions.set([xs[cornerColumn]!, heights[cornerColumn]![cornerRow]!, zs[cornerRow]!], cursor);
        colours.set([paint.r, paint.g, paint.b], cursor);
        cursor += COMPONENTS;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, COMPONENTS));
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, COMPONENTS));
  geometry.computeVertexNormals();
  const surface = groundMesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: FLOOR_ROUGHNESS, metalness: 0 }), "terrain");
  surface.receiveShadow = true;
  const group = new THREE.Group();
  group.name = `station-surface:${mode}`;
  group.add(surface);
  if (group.children.length > SURFACE_DRAW_CALL_BUDGET) throw new Error(`station surface ${mode} draws ${group.children.length} meshes, over the budget of ${SURFACE_DRAW_CALL_BUDGET}`);
  return group;
}
