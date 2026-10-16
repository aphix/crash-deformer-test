/**
 * The Ring Fling target board: a skee-ball machine's ring board scaled up until the cups hold a lying dummy. Station-local
 * frame: +x is the throw direction, x = 0 is the lip, z = 0 the lane centre, y is measured from the pad. The board starts
 * `RING_BOARD_START_X` past the lip at pad height and rises toward the back; five raised cups (10 largest and lowest at the
 * front, 50 smallest and highest) stand on its centreline; two 100 pockets sit in the two back corners, each cradled by the
 * curve of the raised rim that runs down both sides and rounds the back. Every length is a real-machine inch measured off
 * the reference picture times `SKEE_SCALE`; nothing else sets a size.
 */

/**
 * Metres per real inch: one scale for the whole board. A real ball is 3 in, so the ball is 1.14 m here. Ball = torso width
 * (x12) would leave the 50 cup 1.9 m across, narrower than the 2.0 m lying dummy; x15 is the least whole scale at which the
 * smallest of the five cups (7 in across) holds him with a tenth of clearance.
 */
export const SKEE_SCALE = 15;
const METRES_PER_REAL_INCH = 0.0254;

function scaledMetres(realInches: number): number {
  return realInches * METRES_PER_REAL_INCH * SKEE_SCALE;
}

/** The lane position (m past the lip) where the board begins: where the hump ends, at pad height. A 15 m/s throw at 35 degrees first meets the board 20 m out (22 m/s: 43 m), so any start up to about 19 m catches the slowest throw. */
export const RING_BOARD_START_X = 6;
/** The narrowest window (m across) a 100 pocket's scoring circle may offer: wide enough that a precise line and speed can land him in one. */
export const POCKET_AIM_WINDOW = 1.2;
/** Mesh sample spacing (m) the ground lane samples the board at: fine enough for the rim's thinnest wall to hold a section. */
export const RING_MESH_STEP = 0.2;

const REAL_LANE_WIDTH_INCHES = 27;
/** The board's rise per metre run (about 3.4 degrees): steep enough to read as a skee-ball lane, shallow enough for a dummy thrown 15-22 m/s to land on it. */
const BOARD_SLOPE = 0.06;
/** Distance (real inches) from the board's front edge to the front of the 10 cup's rim. */
const REAL_FIRST_CUP_FRONT_INCHES = 36;
const REAL_CUP_RADII_INCHES = [
  { score: 10, radiusInches: 5 },
  { score: 20, radiusInches: 4.5 },
  { score: 30, radiusInches: 4.1 },
  { score: 40, radiusInches: 3.8 },
  { score: 50, radiusInches: 3.5 },
] as const;
const REAL_POCKET_SCORE = 100;
const REAL_POCKET_RADIUS_INCHES = 3;
/** The pockets sit this far (real inches) behind the 50 cup's centre. */
const REAL_POCKET_BEHIND_FIFTY_INCHES = 6;
/** The back corners of the rim: the arc radius, which is also how far each pocket's centre stands off the side and the back wall. */
const REAL_CORNER_RADIUS_INCHES = 7;

/** A cup's cross-section (real inches): the inner wall's footprint, the rim's flat top, the outside skirt down to the board, and the wall's height over the floor. */
const REAL_WALL_FOOT_INCHES = 0.5;
const REAL_RIM_TOP_INCHES = 1;
const REAL_SKIRT_INCHES = 1;
const REAL_WALL_HEIGHT_INCHES = 2;
/** Each higher score stands this much (real inches) taller on its terrace than the one before, over the highest board under it. */
const REAL_TERRACE_RISE_INCHES = 0.3;

/** The side rim: its flat top's thickness, its inner slope's footprint, its height over the board, the run it ramps up over, and where it starts before the first cup. */
const REAL_RAIL_TOP_INCHES = 1.5;
const REAL_RAIL_SLOPE_INCHES = 0.5;
const REAL_RAIL_HEIGHT_INCHES = 3;
const REAL_RAIL_RAMP_INCHES = 8;
const REAL_RAIL_LEAD_INCHES = 10;

/** The backboard behind the board: its height over the pad and its thickness on the real machine (real inches). */
const REAL_BACKBOARD_HEIGHT_INCHES = 50;
const REAL_BACKBOARD_THICKNESS_INCHES = 1;

/** One scoring cup or pocket: radius is the rim crest's inner circle, the edge of its scoring zone. */
export type RingZone = {
  score: number;
  centreX: number;
  centreZ: number;
  radius: number;
  floorHeight: number;
  rimHeight: number;
};

/** Cross-section widths (m) every cup and pocket shares, for art to build the same shape the height function samples. */
export const RING_CUP_PROFILE = {
  wallFootWidth: scaledMetres(REAL_WALL_FOOT_INCHES),
  rimTopWidth: scaledMetres(REAL_RIM_TOP_INCHES),
  skirtWidth: scaledMetres(REAL_SKIRT_INCHES),
  wallHeight: scaledMetres(REAL_WALL_HEIGHT_INCHES),
} as const;

/** The side rim's cross-section (m): flat top thickness, inner slope footprint, height over the board, and the run it ramps up over. */
export const RING_RAIL_PROFILE = {
  topWidth: scaledMetres(REAL_RAIL_TOP_INCHES),
  slopeWidth: scaledMetres(REAL_RAIL_SLOPE_INCHES),
  height: scaledMetres(REAL_RAIL_HEIGHT_INCHES),
  rampLength: scaledMetres(REAL_RAIL_RAMP_INCHES),
} as const;

const HALF_WIDTH = scaledMetres(REAL_LANE_WIDTH_INCHES) / 2;
const CORNER_RADIUS = scaledMetres(REAL_CORNER_RADIUS_INCHES);

/** The bare sloped board (m over the pad) under a station-local x: zero at `RING_BOARD_START_X`, rising toward the back. */
export function ringBoardPlaneHeight(localX: number): number {
  return (localX - RING_BOARD_START_X) * BOARD_SLOPE;
}

function buildZone(score: number, centreX: number, centreZ: number, radius: number, terraceTier: number): RingZone {
  const floorHeight = ringBoardPlaneHeight(centreX + radius) + terraceTier * scaledMetres(REAL_TERRACE_RISE_INCHES);
  return { score, centreX, centreZ, radius, floorHeight, rimHeight: floorHeight + RING_CUP_PROFILE.wallHeight };
}

function buildCupsAlongTheCentreline(): { cups: RingZone[]; fiftyCentreAlongInches: number } {
  const cups: RingZone[] = [];
  let frontOfNextRimInches = REAL_FIRST_CUP_FRONT_INCHES;
  let centreAlongInches = 0;
  for (const spec of REAL_CUP_RADII_INCHES) {
    const outerRimRadiusInches = spec.radiusInches + REAL_RIM_TOP_INCHES;
    centreAlongInches = frontOfNextRimInches + outerRimRadiusInches;
    frontOfNextRimInches = centreAlongInches + outerRimRadiusInches;
    cups.push(buildZone(spec.score, RING_BOARD_START_X + scaledMetres(centreAlongInches), 0, scaledMetres(spec.radiusInches), cups.length + 1));
  }
  return { cups, fiftyCentreAlongInches: centreAlongInches };
}

const centreline = buildCupsAlongTheCentreline();
/** The five cups, 10 (largest, lowest, nearest the lip) to 50 (smallest, highest), tangent along z = 0. */
export const RING_CUPS: readonly RingZone[] = centreline.cups;

const POCKET_ALONG_INCHES = centreline.fiftyCentreAlongInches + REAL_POCKET_BEHIND_FIFTY_INCHES;
const BOARD_MAX_X = RING_BOARD_START_X + scaledMetres(POCKET_ALONG_INCHES + REAL_CORNER_RADIUS_INCHES);
const POCKET_CENTRE_X = BOARD_MAX_X - CORNER_RADIUS;
const POCKET_CENTRE_Z = HALF_WIDTH - CORNER_RADIUS;
const POCKET_RADIUS = scaledMetres(REAL_POCKET_RADIUS_INCHES);
const POCKET_TERRACE_TIER = REAL_CUP_RADII_INCHES.length + 1;
/** The two 100 pockets, in the back corners (z < 0 first), mirror images across z = 0. */
export const RING_POCKETS: readonly RingZone[] = [-POCKET_CENTRE_Z, POCKET_CENTRE_Z].map((centreZ) =>
  buildZone(REAL_POCKET_SCORE, POCKET_CENTRE_X, centreZ, POCKET_RADIUS, POCKET_TERRACE_TIER),
);

const RING_ZONES: readonly RingZone[] = [...RING_CUPS, ...RING_POCKETS];

/** The board's plan rectangle (m, station-local). */
export const RING_BOARD_BOUNDS = {
  minX: RING_BOARD_START_X,
  maxX: BOARD_MAX_X,
  minZ: -HALF_WIDTH,
  maxZ: HALF_WIDTH,
} as const;

/**
 * The backboard (and the physics backstop built from the same numbers) behind the board: its front face stands `distancePastBoard`
 * m past `RING_BOARD_BOUNDS.maxX`, a clear gap so it never overlaps the rim's back curve, its top is `height` m over the pad, and it
 * is `thickness` m deep. It is the real machine's 50 in x `SKEE_SCALE`, so a throw that overshoots the board (design speeds 15-22
 * m/s) hits the panel instead of leaving the station.
 */
export const RING_BACKSTOP = {
  distancePastBoard: 0.3,
  height: scaledMetres(REAL_BACKBOARD_HEIGHT_INCHES),
  thickness: scaledMetres(REAL_BACKBOARD_THICKNESS_INCHES),
} as const;

const RAIL_START_X = RING_BOARD_START_X + scaledMetres(REAL_FIRST_CUP_FRONT_INCHES - REAL_RAIL_LEAD_INCHES);

/** The cup's surface height at `distance` from its centre, or -Infinity past its skirt: floor, inner wall, rim top, skirt down to the board. */
function zoneSurfaceHeight(zone: RingZone, localX: number, distance: number): number {
  const wallFootStart = zone.radius - RING_CUP_PROFILE.wallFootWidth;
  if (distance <= wallFootStart) return zone.floorHeight;
  if (distance <= zone.radius) return zone.floorHeight + ((distance - wallFootStart) / RING_CUP_PROFILE.wallFootWidth) * RING_CUP_PROFILE.wallHeight;
  const rimEnd = zone.radius + RING_CUP_PROFILE.rimTopWidth;
  if (distance <= rimEnd) return zone.rimHeight;
  const skirtProgress = (distance - rimEnd) / RING_CUP_PROFILE.skirtWidth;
  if (skirtProgress >= 1) return -Infinity;
  const board = ringBoardPlaneHeight(localX);
  return zone.rimHeight + (board - zone.rimHeight) * skirtProgress;
}

/** How far inside the rim's curved outline (side lines joined by the two rounded back corners) a point is; negative in the corner cut-offs. */
function depthInsideRim(localX: number, localZ: number): number {
  const alongCorner = localX - POCKET_CENTRE_X;
  const acrossCorner = Math.abs(localZ) - POCKET_CENTRE_Z;
  if (alongCorner > 0 && acrossCorner > 0) return CORNER_RADIUS - Math.sqrt(alongCorner * alongCorner + acrossCorner * acrossCorner);
  return Math.min(HALF_WIDTH - Math.abs(localZ), BOARD_MAX_X - localX);
}

/** The raised rim's height over the board at a point: flat top at the outline, sloping down inside, rising from nothing over its ramp at the front. */
function railHeightOverBoard(localX: number, localZ: number): number {
  const depth = depthInsideRim(localX, localZ);
  const slopeProgress = (depth - RING_RAIL_PROFILE.topWidth) / RING_RAIL_PROFILE.slopeWidth;
  const crossSection = slopeProgress <= 0 ? 1 : Math.max(0, 1 - slopeProgress);
  const rampProgress = Math.min(1, Math.max(0, (localX - RAIL_START_X) / RING_RAIL_PROFILE.rampLength));
  return RING_RAIL_PROFILE.height * crossSection * rampProgress;
}

/** Board surface height (m over the pad) at a station-local point; 0 (the pad) off the board. Cups, pockets and the side rim sit on the sloped board. */
export function ringHeightAt(localX: number, localZ: number): number {
  if (localX < RING_BOARD_BOUNDS.minX || localX > RING_BOARD_BOUNDS.maxX || Math.abs(localZ) > HALF_WIDTH) return 0;
  const board = ringBoardPlaneHeight(localX);
  let height = board + railHeightOverBoard(localX, localZ);
  for (let zoneIndex = 0; zoneIndex < RING_ZONES.length; zoneIndex++) {
    const zone = RING_ZONES[zoneIndex]!;
    const deltaX = localX - zone.centreX;
    const deltaZ = localZ - zone.centreZ;
    const surface = zoneSurfaceHeight(zone, localX, Math.sqrt(deltaX * deltaX + deltaZ * deltaZ));
    if (surface > height) height = surface;
  }
  return height;
}

/** The score (10, 20, 30, 40, 50 or 100) of the cup or pocket whose crest circle holds the point; 0 anywhere else, board or not. */
export function ringScore(localX: number, localZ: number): number {
  for (let zoneIndex = 0; zoneIndex < RING_ZONES.length; zoneIndex++) {
    const zone = RING_ZONES[zoneIndex]!;
    const deltaX = localX - zone.centreX;
    const deltaZ = localZ - zone.centreZ;
    if (deltaX * deltaX + deltaZ * deltaZ <= zone.radius * zone.radius) return zone.score;
  }
  return 0;
}

/**
 * The board as one triangle mesh for the ragdoll's world: a lattice over `RING_BOARD_BOUNDS` whose vertices are
 * `ringHeightAt` samples, spaced evenly at no more than `step` metres apart in plan.
 */
export function ringBoardMesh(step: number): { vertices: Float32Array; indices: Uint32Array } {
  const columns = Math.ceil((RING_BOARD_BOUNDS.maxX - RING_BOARD_BOUNDS.minX) / step) + 1;
  const rows = Math.ceil((RING_BOARD_BOUNDS.maxZ - RING_BOARD_BOUNDS.minZ) / step) + 1;
  const spacingX = (RING_BOARD_BOUNDS.maxX - RING_BOARD_BOUNDS.minX) / (columns - 1);
  const spacingZ = (RING_BOARD_BOUNDS.maxZ - RING_BOARD_BOUNDS.minZ) / (rows - 1);
  const vertices = new Float32Array(columns * rows * 3);
  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const localX = RING_BOARD_BOUNDS.minX + column * spacingX;
      const localZ = RING_BOARD_BOUNDS.minZ + row * spacingZ;
      vertices.set([localX, ringHeightAt(localX, localZ), localZ], (row * columns + column) * 3);
    }
  }
  let writeAt = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const nearLeft = row * columns + column;
      const farLeft = nearLeft + columns;
      indices.set([nearLeft, farLeft, nearLeft + 1, nearLeft + 1, farLeft, farLeft + 1], writeAt);
      writeAt += 6;
    }
  }
  return { vertices, indices };
}
