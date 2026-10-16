/**
 * The High jump's model: where the posts stand, how tall the frame is, the height boards, the cardboard box piles and the net, and
 * the capture that reads the score. Station-local frame: +x is the throw direction, x = 0 the ramp's lip, z = 0 the lane centre,
 * y from the pad (world y = 0). Heights scored and drawn on boards are measured from the lip (y = lipY), lip = 0.
 * Every layout number derives from a measurement (`HighJumpMeasured`) the sizing lane takes; none is committed here.
 */

/** Height boards stand every this many metres up to `BOARD_FINE_UNTIL` above the lip, every `BOARD_COARSE_STEP` beyond it. */
export const BOARD_FINE_STEP = 5;
export const BOARD_FINE_UNTIL = 50;
export const BOARD_COARSE_STEP = 10;
/** A big labelled board stands at every multiple of this many metres above the lip (it divides both steps and `BOARD_FINE_UNTIL`). */
export const MAJOR_BOARD_EVERY_METRES = 50;
/** The frame's top is the best measured crossing height times this, rounded up to a board: a perfect run falls well short of it. */
export const FRAME_HEADROOM_FACTOR = 1.3;
/**
 * The posts stand this far (m) past the lip, always: the slowest class's 70% run lands 12.0 m out in the sizing table, so every
 * run of 70% or better crosses the posts' plane (posts at the best run's apex would leave slower runs short of them, scoring 0).
 */
export const POSTS_DISTANCE = 11;
/** The net hangs this far (m) past the posts. */
const NET_DISTANCE_PAST_POSTS = 30;
/** The net is at least this tall (m), and at least this share of the best crossing height: the descent in the piles is that high. */
const NET_MIN_HEIGHT = 30;
const NET_CROSSING_SHARE = 0.5;

/** Half the distance (m) between the two posts. */
export const POST_HALF_SPAN = 3;
/** A post's square cross-section side (m). */
export const POST_THICKNESS = 0.4;
/** A height board's thickness (m) along the throw. */
export const FRAME_BOARD_THICKNESS = 0.15;

/** The score counts when he passes the posts' plane this far (m) beside the posts: "he doesn't need to be between the posts". */
const CAPTURE_MARGIN_BESIDE_POSTS = 3;
export const CAPTURE_HALF_WIDTH = POST_HALF_SPAN + CAPTURE_MARGIN_BESIDE_POSTS;

/** How many cardboard boxes the landing piles hold (the art's box pool is sized from this same number). */
export const BOX_COUNT = 48;
/** Smallest box edge (m): boxes are sized between this and `BOX_SIZE_MAX`, about dummy-sized (a lying dummy is 2.0 x 0.6 m) so he reads as landing among boxes, not on crates beside 200 m posts. */
export const BOX_SIZE_MIN = 1.6;
/** Largest box edge (m): also sets `BOX_CELL_PITCH`, the room one stack needs. */
export const BOX_SIZE_MAX = 2.6;
/** The piles start this far (m) before the posts, and end this far past the measured landing, never nearer the net than `BOX_NET_CLEARANCE`. */
export const BOX_PILE_LEAD = 3;
export const BOX_PILE_TRAIL = 4;
export const BOX_NET_CLEARANCE = 3;
/** The piles reach this far (m) either side of the lane centre: as wide as the capture band. */
export const BOX_PILE_HALF_WIDTH = CAPTURE_HALF_WIDTH;
/** Boxes are stacked about this many high; fewer cells than that need force taller stacks. */
const BOX_STACK_LAYERS_TARGET = 2;
/** Square cell (m) one stack stands in: the bounding diameter of the largest box at any yaw, so no two stacks can touch. */
export const BOX_CELL_PITCH = BOX_SIZE_MAX * Math.SQRT2;
/** A box wanders from its cell's centre by this share of the room its bounding circle leaves in the cell. */
const BOX_JITTER_SHARE = 0.5;

/**
 * What the sizing measurement gives: the best run's (best class, full throttle) torso height above the lip at the posts' plane, and
 * the largest landing distance (m past the lip) over every class's best run.
 */
export type HighJumpMeasured = { crossingHeight: number; landingDistance: number };

export type HeightBoard = { heightAboveLip: number; y: number; major: boolean };

/** One cardboard box: `y` is the centre height above the pad, `yaw` turns about the vertical. */
export type BoxPlacement = { x: number; y: number; z: number; yaw: number; width: number; height: number; depth: number };

export type HighJumpLayout = {
  postsX: number;
  /** Height of the frame's top above the lip. */
  frameTop: number;
  boards: readonly HeightBoard[];
  netX: number;
  /** Height of the catching net above the pad: tall enough for a dummy coming down anywhere in the piles. */
  netHeight: number;
  boxes: readonly BoxPlacement[];
};

/** Each box property reads a different irrational's multiples, so the properties do not follow one another. */
const WIDTH_BASIS = Math.sqrt(2);
const HEIGHT_BASIS = Math.sqrt(3);
const DEPTH_BASIS = Math.sqrt(5);
const YAW_BASIS = Math.sqrt(7);
const JITTER_X_BASIS = Math.sqrt(11);
const JITTER_Z_BASIS = Math.sqrt(13);

function deterministicFraction(boxIndex: number, irrationalBasis: number): number {
  const scaled = (boxIndex + 1) * irrationalBasis;
  return scaled - Math.floor(scaled);
}

function boxSide(boxIndex: number, irrationalBasis: number): number {
  return BOX_SIZE_MIN + deterministicFraction(boxIndex, irrationalBasis) * (BOX_SIZE_MAX - BOX_SIZE_MIN);
}

function boardStepAt(heightAboveLip: number): number {
  return heightAboveLip < BOARD_FINE_UNTIL ? BOARD_FINE_STEP : BOARD_COARSE_STEP;
}

/** The lowest board height at or above `height`: boards stand every fine step up to `BOARD_FINE_UNTIL`, every coarse step beyond. */
function roundUpToBoard(height: number): number {
  if (height <= BOARD_FINE_UNTIL) return Math.ceil(height / BOARD_FINE_STEP) * BOARD_FINE_STEP;
  return BOARD_FINE_UNTIL + Math.ceil((height - BOARD_FINE_UNTIL) / BOARD_COARSE_STEP) * BOARD_COARSE_STEP;
}

/** The frame's top above the lip: the best crossing height times the headroom (and never under one board over it), on a board's height. */
function frameTopFor(crossingHeight: number): number {
  return roundUpToBoard(Math.max(crossingHeight * FRAME_HEADROOM_FACTOR, crossingHeight + boardStepAt(crossingHeight)));
}

/** One board per height from the lip line up to, not including, the frame top. */
function heightBoards(frameTop: number, lipY: number): HeightBoard[] {
  const boards: HeightBoard[] = [];
  for (let heightAboveLip = 0; heightAboveLip < frameTop; heightAboveLip += boardStepAt(heightAboveLip)) {
    boards.push({ heightAboveLip, y: lipY + heightAboveLip, major: heightAboveLip % MAJOR_BOARD_EVERY_METRES === 0 });
  }
  return boards;
}

/** Box piles over the footprint from `pileStartX` to `pileEndX`: a grid of stacks, each in its own cell, spread evenly through the cells. */
function boxPiles(pileStartX: number, pileEndX: number): BoxPlacement[] {
  const rowCount = Math.floor((pileEndX - pileStartX) / BOX_CELL_PITCH);
  if (rowCount < 1) {
    throw new RangeError(`the box piles' footprint (${pileEndX - pileStartX} m) is narrower than one cell (${BOX_CELL_PITCH} m)`);
  }
  const columnCount = Math.floor((2 * BOX_PILE_HALF_WIDTH) / BOX_CELL_PITCH);
  const cellCount = rowCount * columnCount;
  const stackCount = Math.min(cellCount, Math.ceil(BOX_COUNT / BOX_STACK_LAYERS_TARGET));
  const gridStartX = pileStartX + (pileEndX - pileStartX - rowCount * BOX_CELL_PITCH) / 2;
  const stackTops = Array.from({ length: stackCount }, () => 0);
  return Array.from({ length: BOX_COUNT }, (_, boxIndex) => {
    const stackIndex = boxIndex % stackCount;
    const cellIndex = Math.floor((stackIndex * cellCount) / stackCount);
    const row = Math.floor(cellIndex / columnCount);
    const column = cellIndex % columnCount;
    const width = boxSide(boxIndex, WIDTH_BASIS);
    const height = boxSide(boxIndex, HEIGHT_BASIS);
    const depth = boxSide(boxIndex, DEPTH_BASIS);
    const jitterRange = ((BOX_CELL_PITCH - Math.sqrt(width * width + depth * depth)) / 2) * BOX_JITTER_SHARE;
    const y = stackTops[stackIndex] + height / 2;
    stackTops[stackIndex] += height;
    return {
      x: gridStartX + (row + 0.5) * BOX_CELL_PITCH + (2 * deterministicFraction(boxIndex, JITTER_X_BASIS) - 1) * jitterRange,
      y,
      z: (column + 0.5 - columnCount / 2) * BOX_CELL_PITCH + (2 * deterministicFraction(boxIndex, JITTER_Z_BASIS) - 1) * jitterRange,
      yaw: deterministicFraction(boxIndex, YAW_BASIS) * Math.PI,
      width,
      height,
      depth,
    };
  });
}

/** The frame, boards, net and box piles for the measured best throw; `lipY` is the lip's height above the pad. */
export function highJumpLayout(measured: HighJumpMeasured, lipY: number): HighJumpLayout {
  const postsX = POSTS_DISTANCE;
  const frameTop = frameTopFor(measured.crossingHeight);
  const netX = postsX + NET_DISTANCE_PAST_POSTS;
  const pileEndX = Math.min(measured.landingDistance + BOX_PILE_TRAIL, netX - BOX_NET_CLEARANCE);
  return {
    postsX,
    frameTop,
    boards: heightBoards(frameTop, lipY),
    netX,
    netHeight: Math.max(NET_MIN_HEIGHT, measured.crossingHeight * NET_CROSSING_SHARE),
    boxes: boxPiles(postsX - BOX_PILE_LEAD, pileEndX),
  };
}

/** One torso sample in the station-local frame; `still` is how long (sim s) the torso has barely moved. */
export type TorsoSample = { x: number; y: number; z: number; still: number };

/**
 * Reads the score: the torso's height above the lip where it first crosses the posts' plane going +x. The torso is ballistic and
 * sampled once per render frame, so the crossing is interpolated linearly between the two samples that straddle the plane.
 */
export class HighJumpCapture {
  private crossingSeen = false;
  private capturedHeight: number | null = null;

  get captured(): number | null {
    return this.capturedHeight;
  }

  reset(): void {
    this.crossingSeen = false;
    this.capturedHeight = null;
  }

  /** Metres above the lip at the first +x crossing of the plane x = postsX if it lies within the capture band, else null (also null on every later call). */
  step(previous: TorsoSample | null, current: TorsoSample, postsX: number, lipY: number): number | null {
    if (this.crossingSeen || previous === null) return null;
    if (previous.x >= postsX || current.x < postsX) return null;
    this.crossingSeen = true;
    const crossingShare = (postsX - previous.x) / (current.x - previous.x);
    const lateral = previous.z + (current.z - previous.z) * crossingShare;
    if (Math.abs(lateral) > CAPTURE_HALF_WIDTH) return null;
    const height = previous.y + (current.y - previous.y) * crossingShare;
    this.capturedHeight = Math.max(0, height - lipY);
    return this.capturedHeight;
  }
}
