import { BOTH_SIDES, END_FACES, FACE_SIZE, TOP_FACE, type PenFace, type RivalPen, type RivalPattern } from "./rival-pen.ts";

/** The band patterns: stripes, sashes, chevrons and a checker run along or across the car, drawn with the rivals' pen. */

const LENGTH = FACE_SIZE.left.u;
const FLANK_HEIGHT = FACE_SIZE.left.v;
const CAR_WIDTH = FACE_SIZE.top.v;
const CENTRE_ACROSS = CAR_WIDTH / 2;

/** Belt line height on a flank: the door's mid-height, where the side bands ride. */
const BELT_V = 0.7;

/** Rows of a filled band sit this many radii apart: puffs are dense in the middle but speckled at the rim, so half a radius apart leaves no bare texels. */
const RIBBON_ROW_SPACING = 0.5;

/** A thin line: two overlapping strokes this far either side of its centre, radius `LINE_RADIUS`, about three texels across on a flank so it still reads at 10 m. */
const LINE_HALF_WIDTH = 0.03;
const LINE_RADIUS = 0.065;

/** A filled band's stroke radius: small, so the band's edge is the puff's short speckled rim and not a wide ragged fringe. */
const FILL_RADIUS = 0.07;

// racing-stripes
/** Distance of each stripe's centre from the car's centre line: leaves a clear gap between the pair. */
const STRIPE_OFFSET = 0.27;
/** Half the stripe's width: 0.24 m, like a real pair of rally stripes. */
const STRIPE_HALF_WIDTH = 0.12;
/** Gap from a stripe's centre to its pinline: just clear of the stripe's speckled rim. */
const STRIPE_PINLINE_GAP = 0.3;

// side-stripe
/** Half the side band's width: 0.34 m wide, bold from a chase camera. */
const SIDE_BAND_HALF_WIDTH = 0.17;
/** Gap from the side band's centre to its edge lines: just clear of the speckled rim. */
const SIDE_EDGE_GAP = 0.34;

// pinstripe
/** Height of the flank pinstripe: the belt line. */
const PINSTRIPE_FLANK_V = 0.95;
/** How far in from each side of the roof the roof-edge pinstripes run. */
const PINSTRIPE_ROOF_INSET = 0.14;

// checker-band
/** One checker square, metres: 6 texels along the car (0.037 m a texel), 4 up a flank (0.053 m a texel). */
const CHECKER_SQUARE = 0.22;
/** Rows of squares: two, so the band reads as a checkerboard and not a dashed line. */
const CHECKER_ROWS = 2;
/** Height of the checker band's lower edge on a flank. */
const CHECKER_BOTTOM_V = 0.5;
/** Radius of the strokes that fill one square. */
const CHECKER_FILL_RADIUS = 0.04;
/** A puff is solid to about half its radius and speckled beyond: strokes centred this fraction of a radius inside an edge fill up to it without spilling past. */
const PUFF_CORE_FRACTION = 0.5;

// two-tone-split
/** Height of the split on a flank and the nose/tail: belt line, with everything above in ink 0. */
const SPLIT_V = 0.95;
/** Radius of the fill strokes: big, so a handful of rows cover the panel. */
const SPLIT_FILL_RADIUS = 0.2;
/** Radius of the boundary strokes: small, so the split edge is clean and not a wide speckled fringe. */
const SPLIT_EDGE_RADIUS = 0.05;

// diagonal-sash
/** The sash's run along the flank, rear to nose: rises at 45 degrees up the door. */
const SASH_FLANK_FROM: readonly [number, number] = [1.3, 0];
const SASH_FLANK_TO: readonly [number, number] = [2.9, FLANK_HEIGHT];
/** The sash's run across the roof, left to right, carrying the flank's climb over the top. */
const SASH_TOP_FROM: readonly [number, number] = [1.9, 0];
const SASH_TOP_TO: readonly [number, number] = [3.4, CAR_WIDTH];
/** Half the sash's width along `u` (the band's across-the-lean width is less): bold. */
const SASH_HALF_WIDTH = 0.3;
/** Sideways shift of each sash edge line from the sash's centre line, along `u`: clear of the sash's speckled rim. */
const SASH_EDGE_SHIFT = 0.58;

// chevrons
const CHEVRON_COUNT = 3;
/** Spacing between nested chevrons along the car, metres. */
const CHEVRON_PITCH = 0.6;
/** How far behind its apex each chevron's arms end, and how far out across the roof or up the flank they reach. */
const CHEVRON_TOP_BACK = 0.8;
const CHEVRON_TOP_REACH = 0.82;
const CHEVRON_FLANK_BACK = 0.55;
const CHEVRON_FLANK_REACH = 0.55;
/** Where the first chevron's apex sits along the car on the top and on a flank (nose end). */
const CHEVRON_TOP_APEX = 4.2;
const CHEVRON_FLANK_APEX = 4.2;
/** Height of the chevron apex on a flank. */
const CHEVRON_FLANK_V = 0.8;
const CHEVRON_RADIUS = 0.13;

type Ribbon = {
  readonly faces: readonly PenFace[];
  readonly ink: number;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  /** Which axis the parallel strokes of the ribbon are shifted along: "v" for a band that runs along `u`, "u" for one that runs up or aslant. */
  readonly shiftAxis: "u" | "v";
  readonly halfWidth: number;
  readonly radius: number;
};

/** A band of `halfWidth` either side of the line `from` to `to`, solid with ink: parallel strokes `RIBBON_ROW_SPACING` radii apart. */
function ribbon(pen: RivalPen, { faces, ink, from, to, shiftAxis, halfWidth, radius }: Ribbon): void {
  const rowCount = Math.max(1, Math.ceil((halfWidth * 2) / (radius * RIBBON_ROW_SPACING)));
  for (let row = 0; row <= rowCount; row++) {
    const shift = -halfWidth + (halfWidth * 2 * row) / rowCount;
    const shiftU = shiftAxis === "u" ? shift : 0;
    const shiftV = shiftAxis === "v" ? shift : 0;
    pen.stroke(faces, ink, from[0] + shiftU, from[1] + shiftV, to[0] + shiftU, to[1] + shiftV, radius);
  }
}

/** A thin line down the middle of `from` to `to`. */
function line(pen: RivalPen, faces: readonly PenFace[], ink: number, from: readonly [number, number], to: readonly [number, number], shiftAxis: "u" | "v"): void {
  ribbon(pen, { faces, ink, from, to, shiftAxis, halfWidth: LINE_HALF_WIDTH, radius: LINE_RADIUS });
}

/** A nested chevron: a V with its apex at (apexU, apexV), arms trailing back by `back` and out by `reach` either side. */
function chevronPoints(apexU: number, apexV: number, back: number, reach: number): readonly (readonly [number, number])[] {
  return [
    [apexU - back, apexV - reach],
    [apexU, apexV],
    [apexU - back, apexV + reach],
  ];
}

const racingStripes: RivalPattern = {
  name: "racing-stripes",
  inks: 2,
  draw(pen) {
    for (const side of [-1, 1]) {
      const stripeAcross = CENTRE_ACROSS + side * STRIPE_OFFSET;
      const pinlineAcross = stripeAcross + side * STRIPE_PINLINE_GAP;
      ribbon(pen, { faces: TOP_FACE, ink: 0, from: [0, stripeAcross], to: [LENGTH, stripeAcross], shiftAxis: "v", halfWidth: STRIPE_HALF_WIDTH, radius: FILL_RADIUS });
      ribbon(pen, { faces: END_FACES, ink: 0, from: [stripeAcross, 0], to: [stripeAcross, FLANK_HEIGHT], shiftAxis: "u", halfWidth: STRIPE_HALF_WIDTH, radius: FILL_RADIUS });
      line(pen, TOP_FACE, 1, [0, pinlineAcross], [LENGTH, pinlineAcross], "v");
      line(pen, END_FACES, 1, [pinlineAcross, 0], [pinlineAcross, FLANK_HEIGHT], "u");
    }
  },
};

const sideStripe: RivalPattern = {
  name: "side-stripe",
  inks: 2,
  draw(pen) {
    ribbon(pen, { faces: BOTH_SIDES, ink: 0, from: [0, BELT_V], to: [LENGTH, BELT_V], shiftAxis: "v", halfWidth: SIDE_BAND_HALF_WIDTH, radius: FILL_RADIUS });
    for (const side of [-1, 1]) {
      const edgeV = BELT_V + side * SIDE_EDGE_GAP;
      line(pen, BOTH_SIDES, 1, [0, edgeV], [LENGTH, edgeV], "v");
    }
  },
};

const pinstripe: RivalPattern = {
  name: "pinstripe",
  inks: 1,
  draw(pen) {
    line(pen, BOTH_SIDES, 0, [0, PINSTRIPE_FLANK_V], [LENGTH, PINSTRIPE_FLANK_V], "v");
    for (const acrossV of [PINSTRIPE_ROOF_INSET, CAR_WIDTH - PINSTRIPE_ROOF_INSET]) {
      line(pen, TOP_FACE, 0, [0, acrossV], [LENGTH, acrossV], "v");
    }
  },
};

const checkerBand: RivalPattern = {
  name: "checker-band",
  inks: 2,
  draw(pen) {
    const columnCount = Math.floor(LENGTH / CHECKER_SQUARE);
    const bandLength = columnCount * CHECKER_SQUARE;
    const bandHeight = CHECKER_ROWS * CHECKER_SQUARE;
    const bandMiddleV = CHECKER_BOTTOM_V + bandHeight / 2;
    const inset = CHECKER_FILL_RADIUS * PUFF_CORE_FRACTION;
    const squareHalfCentres = CHECKER_SQUARE / 2 - inset;
    ribbon(pen, { faces: BOTH_SIDES, ink: 1, from: [inset, bandMiddleV], to: [bandLength - inset, bandMiddleV], shiftAxis: "v", halfWidth: bandHeight / 2 - inset, radius: CHECKER_FILL_RADIUS });
    for (let row = 0; row < CHECKER_ROWS; row++) {
      for (let column = 0; column < columnCount; column++) {
        if ((row + column) % 2 === 1) continue;
        const centreU = (column + 0.5) * CHECKER_SQUARE;
        const centreV = CHECKER_BOTTOM_V + (row + 0.5) * CHECKER_SQUARE;
        ribbon(pen, { faces: BOTH_SIDES, ink: 0, from: [centreU - squareHalfCentres, centreV], to: [centreU + squareHalfCentres, centreV], shiftAxis: "v", halfWidth: squareHalfCentres, radius: CHECKER_FILL_RADIUS });
      }
    }
  },
};

const twoToneSplit: RivalPattern = {
  name: "two-tone-split",
  inks: 1,
  draw(pen) {
    const reach = SPLIT_FILL_RADIUS;
    ribbon(pen, { faces: TOP_FACE, ink: 0, from: [-reach, CENTRE_ACROSS], to: [LENGTH + reach, CENTRE_ACROSS], shiftAxis: "v", halfWidth: CENTRE_ACROSS + reach, radius: SPLIT_FILL_RADIUS });
    const fillLowV = SPLIT_V + SPLIT_FILL_RADIUS;
    const fillHighV = FLANK_HEIGHT + reach;
    const edgeLowV = SPLIT_V + SPLIT_EDGE_RADIUS * PUFF_CORE_FRACTION;
    for (const [faces, faceWidth] of [
      [BOTH_SIDES, LENGTH],
      [END_FACES, FACE_SIZE.front.u],
    ] as const) {
      ribbon(pen, { faces, ink: 0, from: [-reach, (fillLowV + fillHighV) / 2], to: [faceWidth + reach, (fillLowV + fillHighV) / 2], shiftAxis: "v", halfWidth: (fillHighV - fillLowV) / 2, radius: SPLIT_FILL_RADIUS });
      ribbon(pen, { faces, ink: 0, from: [-reach, (edgeLowV + fillLowV) / 2], to: [faceWidth + reach, (edgeLowV + fillLowV) / 2], shiftAxis: "v", halfWidth: (fillLowV - edgeLowV) / 2, radius: SPLIT_EDGE_RADIUS });
    }
  },
};

const diagonalSash: RivalPattern = {
  name: "diagonal-sash",
  inks: 2,
  draw(pen) {
    for (const [faces, from, to] of [
      [BOTH_SIDES, SASH_FLANK_FROM, SASH_FLANK_TO],
      [TOP_FACE, SASH_TOP_FROM, SASH_TOP_TO],
    ] as const) {
      ribbon(pen, { faces, ink: 0, from, to, shiftAxis: "u", halfWidth: SASH_HALF_WIDTH, radius: FILL_RADIUS });
      for (const side of [-1, 1]) {
        const shift = side * SASH_EDGE_SHIFT;
        line(pen, faces, 1, [from[0] + shift, from[1]], [to[0] + shift, to[1]], "u");
      }
    }
  },
};

const chevrons: RivalPattern = {
  name: "chevrons",
  inks: 2,
  draw(pen) {
    for (let index = 0; index < CHEVRON_COUNT; index++) {
      const ink = index % 2;
      const topApex = CHEVRON_TOP_APEX - index * CHEVRON_PITCH;
      const flankApex = CHEVRON_FLANK_APEX - index * CHEVRON_PITCH;
      pen.path(TOP_FACE, ink, chevronPoints(topApex, CENTRE_ACROSS, CHEVRON_TOP_BACK, CHEVRON_TOP_REACH), CHEVRON_RADIUS);
      pen.path(BOTH_SIDES, ink, chevronPoints(flankApex, CHEVRON_FLANK_V, CHEVRON_FLANK_BACK, CHEVRON_FLANK_REACH), CHEVRON_RADIUS);
    }
  },
};

export const BAND_PATTERNS: readonly RivalPattern[] = [racingStripes, sideStripe, pinstripe, checkerBand, twoToneSplit, diagonalSash, chevrons];
