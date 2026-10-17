import { BOTH_SIDES, TOP_FACE, type PenFace, type RivalPattern, type RivalPen } from "./rival-pen.ts";

/** Shape patterns: bold, simple figures (roundels, stars, rays, dots, hearts, bolts) at the door, hood and roof. */

/** Where the figures sit, in metres from each face's lower corner (flanks and top: u along the car, rear 0 to nose 4.7). */
const DOOR_CENTRE_U = 2.4;
const BELT_LINE_V = 0.75;
const HOOD_CENTRE_U = 3.9;
const ROOF_AND_HOOD_CENTRE_U = 3.1;
const TOP_CENTRE_V = 0.95;

const FULL_TURN = Math.PI * 2;

/** A puff's rim is speckled, so a solid disc is concentric rings of this brush radius, one brush apart, ending a brush inside the edge. */
const FILL_BRUSH_RADIUS = 0.06;

// number-roundel
const ROUNDEL_FLANK_RING_RADIUS = 0.45;
const ROUNDEL_HOOD_RING_RADIUS = 0.55;
const ROUNDEL_RING_WIDTH = 0.08;
const ROUNDEL_DISC_SHARE = 0.62;

// stars
const STAR_POINTS = 5;
const STAR_INNER_SHARE = 0.4;
const STAR_FLANK_RADIUS = 0.3;
const STAR_HOOD_RADIUS = 0.5;
const STAR_FLANK_COUNT = 4;
const STAR_FLANK_SPACING = 0.95;
const STAR_FLANK_FIRST_U = 0.85;
const STAR_STROKE_WIDTH = 0.045;
const STAR_FILL_WIDTH = 0.07;

// sunburst
const SUNBURST_RAY_COUNT = 12;
const SUNBURST_HOOD_DISC_RADIUS = 0.3;
const SUNBURST_HOOD_RAY_START = 0.42;
const SUNBURST_HOOD_RAY_END = 0.9;
const SUNBURST_FLANK_DISC_RADIUS = 0.16;
const SUNBURST_FLANK_RAY_START = 0.24;
const SUNBURST_FLANK_RAY_END = 0.6;
const SUNBURST_RAY_WIDTH = 0.065;
const SUNBURST_SHORT_RAY_SHARE = 0.65;

// hood-circle
const HOOD_CIRCLE_RING_RADIUS = 0.8;
const HOOD_CIRCLE_RING_WIDTH = 0.12;
const HOOD_CIRCLE_DISC_RADIUS = 0.55;

// dots
const DOT_RADIUS = 0.13;
const DOT_SPACING = 0.42;
const DOT_FLANK_ROW_HEIGHTS = [0.3, 0.75, 1.2];
const DOT_TOP_ROW_ACROSS = [0.4, 0.95, 1.5];
const DOT_FIRST_U = 0.35;
const DOT_LAST_U = 4.4;

// hearts-band: a heart is two filled lobes over a fan of strokes down to the tip, about 0.6 m wide
const HEART_COUNT = 6;
const HEART_SPACING = 0.7;
const HEART_FIRST_U = 0.85;
const HEART_LOBE_RADIUS = 0.14;
const HEART_LOBE_OFFSET = 0.16;
const HEART_LOBE_RISE = 0.1;
const HEART_TIP_DROP = 0.32;
const HEART_FAN_STROKES = 9;
const HEART_FAN_WIDTH = 0.05;

// lightning-bolt: the bolt's corners, down-rear, steeply up toward the nose, down-rear again (the top face crosses the car, so its heights run wider)
const BOLT_FLANK_CORNERS: readonly (readonly [number, number])[] = [
  [4.5, 1.35],
  [2.9, 0.45],
  [3.6, 1.1],
  [0.8, 0.2],
];
const BOLT_TOP_CORNERS: readonly (readonly [number, number])[] = [
  [4.5, 1.55],
  [2.9, 0.55],
  [3.6, 1.3],
  [0.8, 0.35],
];
const BOLT_WIDTH = 0.1;
const BOLT_OUTLINE_WIDTH = 0.17;

function fillDisc(pen: RivalPen, faces: readonly PenFace[], ink: number, u: number, v: number, radius: number) {
  const brushRadius = Math.min(FILL_BRUSH_RADIUS, radius / 2);
  pen.dot(faces, ink, u, v, brushRadius);
  for (let ringRadius = brushRadius; ringRadius <= radius - brushRadius; ringRadius += brushRadius) {
    pen.ring(faces, ink, u, v, ringRadius, brushRadius);
  }
}

function drawRoundel(pen: RivalPen, faces: readonly PenFace[], u: number, v: number, ringRadius: number) {
  pen.ring(faces, 0, u, v, ringRadius, ROUNDEL_RING_WIDTH);
  fillDisc(pen, faces, 1, u, v, ringRadius * ROUNDEL_DISC_SHARE);
}

const numberRoundel: RivalPattern = {
  name: "number-roundel",
  inks: 2,
  draw(pen) {
    drawRoundel(pen, BOTH_SIDES, DOOR_CENTRE_U, BELT_LINE_V, ROUNDEL_FLANK_RING_RADIUS);
    drawRoundel(pen, TOP_FACE, HOOD_CENTRE_U, TOP_CENTRE_V, ROUNDEL_HOOD_RING_RADIUS);
  },
};

function starCorners(centreU: number, centreV: number, radius: number) {
  return Array.from({ length: STAR_POINTS * 2 }, (_, index): [number, number] => {
    const angle = Math.PI / 2 + (index / (STAR_POINTS * 2)) * FULL_TURN;
    const reach = index % 2 === 0 ? radius : radius * STAR_INNER_SHARE;
    return [centreU + Math.cos(angle) * reach, centreV + Math.sin(angle) * reach];
  });
}

function drawStar(pen: RivalPen, faces: readonly PenFace[], ink: number, centreU: number, centreV: number, radius: number) {
  const corners = starCorners(centreU, centreV, radius);
  for (let index = 0; index < corners.length; index += 2) {
    const [tipU, tipV] = corners[index]!;
    pen.stroke(faces, ink, centreU, centreV, tipU, tipV, STAR_FILL_WIDTH);
  }
  fillDisc(pen, faces, ink, centreU, centreV, radius * STAR_INNER_SHARE * 1.4);
  pen.path(faces, ink, corners, STAR_STROKE_WIDTH, true);
}

const stars: RivalPattern = {
  name: "stars",
  inks: 2,
  draw(pen) {
    for (let index = 0; index < STAR_FLANK_COUNT; index++) {
      drawStar(pen, BOTH_SIDES, index % 2, STAR_FLANK_FIRST_U + index * STAR_FLANK_SPACING, BELT_LINE_V, STAR_FLANK_RADIUS);
    }
    drawStar(pen, TOP_FACE, 0, HOOD_CENTRE_U, TOP_CENTRE_V, STAR_HOOD_RADIUS);
  },
};

function drawBurst(pen: RivalPen, faces: readonly PenFace[], centreU: number, centreV: number, discRadius: number, rayStart: number, rayEnd: number) {
  fillDisc(pen, faces, 0, centreU, centreV, discRadius);
  for (let index = 0; index < SUNBURST_RAY_COUNT; index++) {
    const angle = (index / SUNBURST_RAY_COUNT) * FULL_TURN;
    const isLongRay = index % 2 === 0;
    const end = isLongRay ? rayEnd : rayStart + (rayEnd - rayStart) * SUNBURST_SHORT_RAY_SHARE;
    const [cosine, sine] = [Math.cos(angle), Math.sin(angle)];
    pen.stroke(faces, isLongRay ? 0 : 1, centreU + cosine * rayStart, centreV + sine * rayStart, centreU + cosine * end, centreV + sine * end, SUNBURST_RAY_WIDTH);
  }
}

const sunburst: RivalPattern = {
  name: "sunburst",
  inks: 2,
  draw(pen) {
    drawBurst(pen, TOP_FACE, HOOD_CENTRE_U, TOP_CENTRE_V, SUNBURST_HOOD_DISC_RADIUS, SUNBURST_HOOD_RAY_START, SUNBURST_HOOD_RAY_END);
    drawBurst(pen, BOTH_SIDES, DOOR_CENTRE_U, BELT_LINE_V, SUNBURST_FLANK_DISC_RADIUS, SUNBURST_FLANK_RAY_START, SUNBURST_FLANK_RAY_END);
  },
};

const hoodCircle: RivalPattern = {
  name: "hood-circle",
  inks: 2,
  draw(pen) {
    pen.ring(TOP_FACE, 0, ROOF_AND_HOOD_CENTRE_U, TOP_CENTRE_V, HOOD_CIRCLE_RING_RADIUS, HOOD_CIRCLE_RING_WIDTH);
    fillDisc(pen, TOP_FACE, 1, ROOF_AND_HOOD_CENTRE_U, TOP_CENTRE_V, HOOD_CIRCLE_DISC_RADIUS);
  },
};

const dots: RivalPattern = {
  name: "dots",
  inks: 1,
  draw(pen) {
    const columns = Math.floor((DOT_LAST_U - DOT_FIRST_U) / DOT_SPACING) + 1;
    const drawRows = (faces: readonly PenFace[], rowHeights: readonly number[]) => {
      for (const [row, height] of rowHeights.entries()) {
        const stagger = row % 2 === 0 ? 0 : DOT_SPACING / 2;
        for (let column = 0; column < columns; column++) fillDisc(pen, faces, 0, DOT_FIRST_U + stagger + column * DOT_SPACING, height, DOT_RADIUS);
      }
    };
    drawRows(BOTH_SIDES, DOT_FLANK_ROW_HEIGHTS);
    drawRows(TOP_FACE, DOT_TOP_ROW_ACROSS);
  },
};

function drawHeart(pen: RivalPen, centreU: number, centreV: number) {
  const lobeV = centreV + HEART_LOBE_RISE;
  const tipV = centreV - HEART_TIP_DROP;
  fillDisc(pen, BOTH_SIDES, 0, centreU - HEART_LOBE_OFFSET, lobeV, HEART_LOBE_RADIUS);
  fillDisc(pen, BOTH_SIDES, 0, centreU + HEART_LOBE_OFFSET, lobeV, HEART_LOBE_RADIUS);
  const sideReach = HEART_LOBE_OFFSET + HEART_LOBE_RADIUS - HEART_FAN_WIDTH;
  for (let index = 0; index < HEART_FAN_STROKES; index++) {
    const across = -sideReach + (index / (HEART_FAN_STROKES - 1)) * sideReach * 2;
    pen.stroke(BOTH_SIDES, 0, centreU + across, lobeV, centreU, tipV, HEART_FAN_WIDTH);
  }
}

const heartsBand: RivalPattern = {
  name: "hearts-band",
  inks: 1,
  draw(pen) {
    for (let index = 0; index < HEART_COUNT; index++) drawHeart(pen, HEART_FIRST_U + index * HEART_SPACING, BELT_LINE_V);
  },
};

const lightningBolt: RivalPattern = {
  name: "lightning-bolt",
  inks: 2,
  draw(pen) {
    for (const [faces, corners] of [
      [BOTH_SIDES, BOLT_FLANK_CORNERS],
      [TOP_FACE, BOLT_TOP_CORNERS],
    ] as const) {
      pen.path(faces, 1, corners, BOLT_OUTLINE_WIDTH);
      pen.path(faces, 0, corners, BOLT_WIDTH);
    }
  },
};

export const SHAPE_PATTERNS: readonly RivalPattern[] = [numberRoundel, stars, sunburst, hoodCircle, dots, heartsBand, lightningBolt];
