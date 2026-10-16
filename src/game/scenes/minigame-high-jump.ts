/**
 * The High jump's model: where the posts stand, how tall the frame is, the height boards, the cardboard box piles and the net, and
 * the capture that reads the score. Station-local frame: +x is the throw direction, x = 0 the ramp's lip, z = 0 the lane centre,
 * y from the pad (world y = 0). Heights scored and drawn on boards are measured from the lip (y = lipY), lip = 0.
 * Every layout number derives from a measurement (`HighJumpMeasured`) the sizing lane takes; none is committed here.
 */

/** Metres between two height boards. */
export const BOARD_STEP = 2;
/** Every this many boards (counting from the lip board) the board is a big labelled one: with a 2 m step, every 10 m. */
export const MAJOR_BOARD_EVERY = 5;
/** The frame stands this many boards taller than the best measured apex. */
export const FRAME_EXTRA_BOARDS = 1;
/** The net hangs this far (m) past the posts. */
export const NET_DISTANCE_PAST_POSTS = 30;

/** Half the distance (m) between the two posts. */
export const POST_HALF_SPAN = 3;
/** A post's square cross-section side (m). */
export const POST_THICKNESS = 0.4;
/** A height board's thickness (m) along the throw. */
export const FRAME_BOARD_THICKNESS = 0.15;

/** The score counts when he passes the posts' plane this far (m) beside the posts: "he doesn't need to be between the posts". */
export const CAPTURE_MARGIN_BESIDE_POSTS = 3;
export const CAPTURE_HALF_WIDTH = POST_HALF_SPAN + CAPTURE_MARGIN_BESIDE_POSTS;

export const BOX_COUNT = 48;
export const BOX_SIZE_MIN = 0.8;
export const BOX_SIZE_MAX = 1.4;
/** The piles start this far (m) before the posts, and end this far past the measured landing, never nearer the net than `BOX_NET_CLEARANCE`. */
export const BOX_PILE_LEAD = 3;
export const BOX_PILE_TRAIL = 4;
export const BOX_NET_CLEARANCE = 3;
/** The piles reach this far (m) either side of the lane centre: as wide as the capture band. */
export const BOX_PILE_HALF_WIDTH = CAPTURE_HALF_WIDTH;
/** Boxes are stacked about this many high; fewer cells than that need force taller stacks. */
export const BOX_STACK_LAYERS_TARGET = 2;
/** Square cell (m) one stack stands in: the bounding diameter of the largest box at any yaw, so no two stacks can touch. */
export const BOX_CELL_PITCH = BOX_SIZE_MAX * Math.SQRT2;
/** A box wanders from its cell's centre by this share of the room its bounding circle leaves in the cell. */
const BOX_JITTER_SHARE = 0.5;

/** What the sizing lane measures: for the best-case throw, in station-local metres (apex height above the lip). */
export type HighJumpMeasured = { apexHeight: number; apexDistance: number; landingDistance: number };

export type HeightBoard = { heightAboveLip: number; y: number; major: boolean };

/** One cardboard box: `y` is the centre height above the pad, `yaw` turns about the vertical. */
export type BoxPlacement = { x: number; y: number; z: number; yaw: number; width: number; height: number; depth: number };

export type HighJumpLayout = {
  postsX: number;
  /** Height of the frame's top above the lip. */
  frameTop: number;
  boards: readonly HeightBoard[];
  netX: number;
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

function heightBoards(frameTop: number, lipY: number): HeightBoard[] {
  const boardCount = Math.ceil(frameTop / BOARD_STEP);
  return Array.from({ length: boardCount }, (_, boardIndex) => {
    const heightAboveLip = boardIndex * BOARD_STEP;
    return { heightAboveLip, y: lipY + heightAboveLip, major: boardIndex % MAJOR_BOARD_EVERY === 0 };
  });
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

/** The frame, boards, net and box piles for a measured best-case throw; `lipY` is the lip's height above the pad. */
export function highJumpLayout(measured: HighJumpMeasured, lipY: number): HighJumpLayout {
  const postsX = measured.apexDistance;
  const frameTop = measured.apexHeight + FRAME_EXTRA_BOARDS * BOARD_STEP;
  const netX = postsX + NET_DISTANCE_PAST_POSTS;
  const pileEndX = Math.min(measured.landingDistance + BOX_PILE_TRAIL, netX - BOX_NET_CLEARANCE);
  return {
    postsX,
    frameTop,
    boards: heightBoards(frameTop, lipY),
    netX,
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
