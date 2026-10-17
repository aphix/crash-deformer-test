import { hypot2 } from "../kernel/physics-core.js";
import { ALL_FACES, BOTH_SIDES, END_FACES, FACE_SIZE, NOSE_FACE, TOP_FACE, type PenFace, type RivalPattern, type RivalPen } from "./rival-pen.ts";

/** The organic rival patterns: flames, tiger and zebra stripes, camouflage, a tribal swoosh and scallops. Pure: only the pen's stream is random. */

type Point = readonly [number, number];

const NOSE_U = FACE_SIZE.left.u;
const FLANK_HEIGHT = FACE_SIZE.left.v;
const TOP_WIDTH = FACE_SIZE.top.v;
const TOP_CENTRE = TOP_WIDTH / 2;
const END_WIDTH = FACE_SIZE.front.u;

/** Points per curve: enough that the straight segments between them read as one smooth stroke at a 0.02-0.15 m radius. */
const CURVE_SEGMENTS = 16;
/** Seeds the index hash: the classic sin-hash constants, any pair of big odd-looking numbers scrambles an integer index just as well. */
const HASH_MULTIPLIER = 12.9898;
const HASH_SCALE = 43758.5453;
/** Added to a stripe's index so its second jitter draw (lean, length) is unrelated to its first. */
const SECOND_DRAW_OFFSET = 50;
/** Added to a side's index so the left and right flank do not repeat each other's jitter. */
const SIDE_INDEX_STRIDE = 100;
const HALF_TURN = Math.PI;
const FULL_TURN = Math.PI * 2;

/** A repeatable 0..1 value from an index, standing in for the random source a pattern does not have. */
const jitter = (index: number) => {
  const scrambled = Math.sin(index * HASH_MULTIPLIER) * HASH_SCALE;
  return scrambled - Math.floor(scrambled);
};

const lerp = (from: number, to: number, fraction: number) => from + (to - from) * fraction;

/** `curve` sampled evenly from fraction 0 to `lastFraction`. */
const sampleCurve = (curve: (fraction: number) => Point, lastFraction = 1) =>
  Array.from({ length: CURVE_SEGMENTS + 1 }, (_, index) => curve((index / CURVE_SEGMENTS) * lastFraction));

/** A stroke through `points` whose can radius shrinks (or grows) evenly from `startRadius` to `endRadius`. */
function taperedPath(pen: RivalPen, faces: readonly PenFace[], ink: number, points: readonly Point[], startRadius: number, endRadius: number): void {
  const lastSegment = points.length - 2;
  for (let index = 0; index <= lastSegment; index++) {
    const [fromU, fromV] = points[index]!;
    const [toU, toV] = points[index + 1]!;
    pen.stroke(faces, ink, fromU, fromV, toU, toV, lerp(startRadius, endRadius, index / lastSegment));
  }
}

// ---- flames ----

/** Outer flame: a fat base tapering to a thin tip; the inner flame is the same spine, shorter and narrower. */
const FLAME_BASE_RADIUS = 0.2;
const FLAME_TIP_RADIUS = 0.03;
const FLAME_INNER_BASE_RADIUS = 0.09;
const FLAME_INNER_TIP_RADIUS = 0.02;
/** How far along its spine the inner flame reaches, so the outer colour shows round it and past its end. */
const FLAME_INNER_REACH = 0.6;
/** Ripple riding the spine so a tongue licks rather than runs straight. */
const FLAME_WAVE = 0.1;
const FLAME_WAVE_TURNS = 1.25;

const FLANK_TONGUES = 4;
const FLANK_TONGUE_FIRST_HEIGHT = 0.25;
const FLANK_TONGUE_HEIGHT_STEP = 0.35;
/** Slight rise of a flank tongue toward its tip (direction per metre rearward), so the tongues fan up as flames do. */
const FLANK_TONGUE_RISE = 0.14;
const FLANK_TONGUE_MIN_LENGTH = 1.2;
const FLANK_TONGUE_LENGTH_SPREAD = 1.6;
const FLANK_TONGUE_CURL = 0.7;
const FLANK_TONGUE_NOSE_INSET = 0.05;

const HOOD_TONGUES = 4;
const HOOD_TONGUE_FIRST_OFFSET = 0.35;
const HOOD_TONGUE_STEP = 0.4;
const HOOD_TONGUE_MIN_LENGTH = 0.8;
const HOOD_TONGUE_LENGTH_SPREAD = 1.2;
/** Fraction of its distance from the centreline that a hood or nose tongue bends back toward it. */
const HOOD_TONGUE_CONVERGE = 0.5;

const NOSE_TONGUES = 4;
const NOSE_TONGUE_FIRST_OFFSET = 0.3;
const NOSE_TONGUE_STEP = 0.45;
const NOSE_TONGUE_MIN_LENGTH = 0.5;
const NOSE_TONGUE_LENGTH_SPREAD = 0.4;

/** One tongue: outer flame in ink 0 along a spine from (startU, startV) heading (directionU, directionV), inner flame in ink 1. */
function flameTongue(pen: RivalPen, faces: readonly PenFace[], startU: number, startV: number, directionU: number, directionV: number, length: number, curl: number): void {
  const norm = hypot2(directionU, directionV);
  const alongU = directionU / norm;
  const alongV = directionV / norm;
  const sidewaysU = alongV;
  const sidewaysV = -alongU;
  const spine = (fraction: number): Point => {
    const bend = curl * fraction * fraction + FLAME_WAVE * Math.sin(fraction * FULL_TURN * FLAME_WAVE_TURNS) * (1 - fraction);
    return [startU + alongU * length * fraction + sidewaysU * bend, startV + alongV * length * fraction + sidewaysV * bend];
  };
  taperedPath(pen, faces, 0, sampleCurve(spine), FLAME_BASE_RADIUS, FLAME_TIP_RADIUS);
  taperedPath(pen, faces, 1, sampleCurve(spine, FLAME_INNER_REACH), FLAME_INNER_BASE_RADIUS, FLAME_INNER_TIP_RADIUS);
}

function drawFlames(pen: RivalPen): void {
  for (let tongue = 0; tongue < FLANK_TONGUES; tongue++) {
    const length = FLANK_TONGUE_MIN_LENGTH + FLANK_TONGUE_LENGTH_SPREAD * jitter(tongue);
    flameTongue(pen, BOTH_SIDES, NOSE_U - FLANK_TONGUE_NOSE_INSET, FLANK_TONGUE_FIRST_HEIGHT + tongue * FLANK_TONGUE_HEIGHT_STEP, -1, FLANK_TONGUE_RISE, length, FLANK_TONGUE_CURL);
  }
  for (let tongue = 0; tongue < HOOD_TONGUES; tongue++) {
    const startV = HOOD_TONGUE_FIRST_OFFSET + tongue * HOOD_TONGUE_STEP;
    const length = HOOD_TONGUE_MIN_LENGTH + HOOD_TONGUE_LENGTH_SPREAD * jitter(tongue + SECOND_DRAW_OFFSET);
    flameTongue(pen, TOP_FACE, NOSE_U, startV, -1, 0, length, (TOP_CENTRE - startV) * HOOD_TONGUE_CONVERGE);
  }
  for (let tongue = 0; tongue < NOSE_TONGUES; tongue++) {
    const startU = NOSE_TONGUE_FIRST_OFFSET + tongue * NOSE_TONGUE_STEP;
    const length = NOSE_TONGUE_MIN_LENGTH + NOSE_TONGUE_LENGTH_SPREAD * jitter(tongue + SECOND_DRAW_OFFSET * 2);
    flameTongue(pen, NOSE_FACE, startU, 0, 0, 1, length, (END_WIDTH / 2 - startU) * HOOD_TONGUE_CONVERGE);
  }
}

// ---- tiger stripes ----

const TIGER_PITCH = 0.36;
const TIGER_MARGIN = 0.2;
const TIGER_BASE_RADIUS = 0.1;
const TIGER_TIP_RADIUS = 0.02;
/** Stripes growing from the sill are shorter and finer than the ones hanging from the roof edge. */
const TIGER_SILL_BASE_RADIUS = 0.08;
const TIGER_SILL_MIN_LENGTH = 0.3;
const TIGER_SILL_LENGTH_SPREAD = 0.3;
const TIGER_MIN_LENGTH = 0.6;
const TIGER_LENGTH_SPREAD = 0.7;
/** Sideways drift of a stripe's tip, ± half this, so no two lean the same way. */
const TIGER_LEAN_SPREAD = 0.25;
const TIGER_BOW = 0.04;
/** The sill stripes sit this far along from the roof-edge ones, between them. */
const TIGER_SILL_SHIFT = 0.15;
/** Hood and roof stripes start at the car's edge and reach this far toward the centre line. */
const TIGER_TOP_MIN_LENGTH = 0.4;
const TIGER_TOP_LENGTH_SPREAD = 0.5;
const TIGER_END_MIN_LENGTH = 0.3;
const TIGER_END_LENGTH_SPREAD = 0.4;

/** A tapering stripe from (startU, startV) heading (directionU, directionV) for `length`, its tip leaning `lean` sideways and bowing a little on the way. */
function tigerStripe(pen: RivalPen, face: PenFace, ink: number, startU: number, startV: number, directionU: number, directionV: number, length: number, lean: number, baseRadius: number): void {
  const spine = (fraction: number): Point => {
    const sideways = lean * fraction + TIGER_BOW * Math.sin(fraction * HALF_TURN);
    return [startU + directionU * length * fraction + directionV * sideways, startV + directionV * length * fraction - directionU * sideways];
  };
  taperedPath(pen, [face], ink, sampleCurve(spine), baseRadius, TIGER_TIP_RADIUS);
}

function drawTigerStripes(pen: RivalPen): void {
  const lean = (index: number) => (jitter(index + SECOND_DRAW_OFFSET) - 0.5) * TIGER_LEAN_SPREAD;
  for (const [sideIndex, side] of BOTH_SIDES.entries()) {
    for (let stripe = 0, startU = TIGER_MARGIN; startU < NOSE_U; stripe++, startU += TIGER_PITCH) {
      const index = stripe + sideIndex * SIDE_INDEX_STRIDE;
      tigerStripe(pen, side, 0, startU, FLANK_HEIGHT, 0, -1, TIGER_MIN_LENGTH + TIGER_LENGTH_SPREAD * jitter(index), lean(index), TIGER_BASE_RADIUS);
      const sillIndex = index + SIDE_INDEX_STRIDE * 2;
      tigerStripe(pen, side, 0, startU + TIGER_SILL_SHIFT, 0, 0, 1, TIGER_SILL_MIN_LENGTH + TIGER_SILL_LENGTH_SPREAD * jitter(sillIndex), lean(sillIndex), TIGER_SILL_BASE_RADIUS);
    }
  }
  for (let stripe = 0, startU = TIGER_MARGIN; startU < NOSE_U; stripe++, startU += TIGER_PITCH) {
    const leftIndex = stripe + SIDE_INDEX_STRIDE * 3;
    const rightIndex = stripe + SIDE_INDEX_STRIDE * 4;
    tigerStripe(pen, "top", 0, startU, 0, 0, 1, TIGER_TOP_MIN_LENGTH + TIGER_TOP_LENGTH_SPREAD * jitter(leftIndex), lean(leftIndex), TIGER_BASE_RADIUS);
    tigerStripe(pen, "top", 0, startU + TIGER_SILL_SHIFT, TOP_WIDTH, 0, -1, TIGER_TOP_MIN_LENGTH + TIGER_TOP_LENGTH_SPREAD * jitter(rightIndex), lean(rightIndex), TIGER_BASE_RADIUS);
  }
  for (const [endIndex, end] of END_FACES.entries()) {
    for (let stripe = 0, startU = TIGER_MARGIN; startU < END_WIDTH; stripe++, startU += TIGER_PITCH) {
      const index = stripe + SIDE_INDEX_STRIDE * (5 + endIndex);
      tigerStripe(pen, end, 0, startU, FLANK_HEIGHT, 0, -1, TIGER_END_MIN_LENGTH + TIGER_END_LENGTH_SPREAD * jitter(index), lean(index), TIGER_BASE_RADIUS);
    }
  }
}

// ---- zebra stripes ----

/** Stripe centre-to-centre distance: a stripe is about 0.2 m wide and the bare gap a little more, 5-6 texels each on a flank. */
const ZEBRA_PITCH = 0.42;
const ZEBRA_MARGIN = 0.15;
const ZEBRA_RADIUS = 0.095;
const ZEBRA_WAVE_AMPLITUDE = 0.075;
/** Wave length 0.8 m divides the flank height twice, so a flank stripe meets the matching roof stripe at the roof edge in phase. */
const ZEBRA_WAVELENGTH = 0.8;

function drawZebraStripes(pen: RivalPen): void {
  for (const face of ALL_FACES) {
    const { u: width, v: height } = FACE_SIZE[face];
    for (let startU = ZEBRA_MARGIN; startU < width; startU += ZEBRA_PITCH) {
      const stripe = sampleCurve((fraction): Point => [startU + ZEBRA_WAVE_AMPLITUDE * Math.sin((fraction * height * FULL_TURN) / ZEBRA_WAVELENGTH), fraction * height]);
      pen.path([face], 0, stripe, ZEBRA_RADIUS);
    }
  }
}

// ---- camo blotches ----

/** One blotch per cell of this size, centred somewhere inside it; with the dots' reach they overlap into an irregular mass. */
const CAMO_CELL = 0.7;
const CAMO_DOT_MIN_RADIUS = 0.12;
const CAMO_DOT_MAX_RADIUS = 0.3;
const CAMO_DOTS_PER_BLOTCH = 4;
/** How far a blotch's dots stray from its centre. */
const CAMO_DOT_SCATTER = 0.35;
/** The second ink's blotches are smaller so the first ink stays the main mass. */
const CAMO_SECOND_INK_SCALE = 0.7;
/** The second ink's cells are shifted by this fraction of a cell, so its blotches land between and over the first ink's. */
const CAMO_SECOND_INK_SHIFT = 0.5;
/** A blotch centre stays this fraction of a cell clear of the cell's edge, so neighbours rarely merge into one slab. */
const CAMO_CENTRE_MARGIN = 0.2;
/** Per face, per ink, per cell: gives every blotch its own hash index. */
const CAMO_FACE_STRIDE = 10000;
const CAMO_INK_STRIDE = 5000;
const CAMO_COLUMN_STRIDE = 37;

function drawCamoBlotches(pen: RivalPen): void {
  for (const [faceIndex, face] of ALL_FACES.entries()) {
    const { u: width, v: height } = FACE_SIZE[face];
    const columns = Math.max(1, Math.round(width / CAMO_CELL));
    const rows = Math.max(1, Math.round(height / CAMO_CELL));
    for (const ink of [0, 1]) {
      const shift = ink * CAMO_SECOND_INK_SHIFT;
      const scale = ink === 0 ? 1 : CAMO_SECOND_INK_SCALE;
      for (let column = 0; column < columns; column++) {
        for (let row = 0; row < rows; row++) {
          const cell = faceIndex * CAMO_FACE_STRIDE + ink * CAMO_INK_STRIDE + column * CAMO_COLUMN_STRIDE + row;
          const centreU = ((column + shift + CAMO_CENTRE_MARGIN + (1 - 2 * CAMO_CENTRE_MARGIN) * jitter(cell)) * width) / columns;
          const centreV = ((row + shift + CAMO_CENTRE_MARGIN + (1 - 2 * CAMO_CENTRE_MARGIN) * jitter(cell + SECOND_DRAW_OFFSET)) * height) / rows;
          for (let dotIndex = 0; dotIndex < CAMO_DOTS_PER_BLOTCH; dotIndex++) {
            const dot = cell * CAMO_DOTS_PER_BLOTCH + dotIndex + SIDE_INDEX_STRIDE;
            const radius = lerp(CAMO_DOT_MIN_RADIUS, CAMO_DOT_MAX_RADIUS, jitter(dot)) * scale;
            pen.dot([face], ink, centreU + (jitter(dot + SECOND_DRAW_OFFSET) - 0.5) * CAMO_DOT_SCATTER, centreV + (jitter(dot + SECOND_DRAW_OFFSET * 2) - 0.5) * CAMO_DOT_SCATTER, radius);
          }
        }
      }
    }
  }
}

// ---- tribal swoosh ----

/** A swoosh leaves the front wheel arch and sweeps up and back, ending in a point near the tail. */
const SWOOSH_START_U = 3.7;
const SWOOSH_END_U = 0.5;
const SWOOSH_START_HEIGHT = 0.3;
const SWOOSH_END_HEIGHT = 1.25;
const SWOOSH_BASE_RADIUS = 0.3;
const SWOOSH_TIP_RADIUS = 0.012;
/** Ripple along the sweep so the swoosh flows rather than runs as a straight diagonal. */
const SWOOSH_WAVE = 0.12;
/** The companion stroke trails below the main one, finer and shorter, for the layered tribal look. */
const SWOOSH_COMPANION_DROP = 0.3;
const SWOOSH_COMPANION_REACH = 0.7;
const SWOOSH_COMPANION_BASE_RADIUS = 0.14;
/** Hood swooshes leave the nose edge and sweep back and in toward the centre line. */
const HOOD_SWOOSH_START_V = 0.1;
const HOOD_SWOOSH_END_V = 0.8;
const HOOD_SWOOSH_END_U = 2.9;
const HOOD_SWOOSH_BASE_RADIUS = 0.24;

/** Eases fast at first then flattens: the sweep climbs steeply from the arch and settles along the belt line. */
const easeOut = (fraction: number) => 1 - (1 - fraction) * (1 - fraction);

function drawTribalSwoosh(pen: RivalPen): void {
  const flankSwoosh = (heightDrop: number) => (fraction: number): Point => [
    lerp(SWOOSH_START_U, SWOOSH_END_U, fraction),
    lerp(SWOOSH_START_HEIGHT, SWOOSH_END_HEIGHT, easeOut(fraction)) - heightDrop + SWOOSH_WAVE * Math.sin(fraction * FULL_TURN) * (1 - fraction),
  ];
  taperedPath(pen, BOTH_SIDES, 0, sampleCurve(flankSwoosh(0)), SWOOSH_BASE_RADIUS, SWOOSH_TIP_RADIUS);
  taperedPath(pen, BOTH_SIDES, 0, sampleCurve(flankSwoosh(SWOOSH_COMPANION_DROP), SWOOSH_COMPANION_REACH), SWOOSH_COMPANION_BASE_RADIUS, SWOOSH_TIP_RADIUS);
  const hoodSwoosh = (mirror: boolean) => (fraction: number): Point => {
    const acrossCar = lerp(HOOD_SWOOSH_START_V, HOOD_SWOOSH_END_V, easeOut(fraction)) + SWOOSH_WAVE * Math.sin(fraction * FULL_TURN) * (1 - fraction);
    return [lerp(NOSE_U, HOOD_SWOOSH_END_U, fraction), mirror ? TOP_WIDTH - acrossCar : acrossCar];
  };
  for (const mirror of [false, true]) taperedPath(pen, TOP_FACE, 0, sampleCurve(hoodSwoosh(mirror)), HOOD_SWOOSH_BASE_RADIUS, SWOOSH_TIP_RADIUS);
}

// ---- scallops ----

/** An arc is a half circle bulging the way the scallop points; rows overlap like fish scales, alternating inks. */
const SCALLOP_RADIUS = 0.2;
const SCALLOP_WIDTH = 0.05;
const SCALLOP_ARC_SEGMENTS = 10;
const SCALLOP_PITCH = SCALLOP_RADIUS * 2;
/** Each row sits half a pitch along from the one below, as scales do. */
const SCALLOP_ROW_SHIFT = SCALLOP_PITCH / 2;
/** Row positions: height up the flank and end faces, distance back from the nose on the hood. Arcs hang below (or behind) their row line, so rows sit a radius above the edge they cover. */
const FLANK_SCALLOP_ROWS = [0.95, 0.7, 0.45, 0.2] as const;
const END_SCALLOP_ROWS = [0.7, 0.45, 0.2] as const;
const HOOD_SCALLOP_ROWS = [NOSE_U - 0.3, NOSE_U - 0.55, NOSE_U - 0.8, NOSE_U - 1.05] as const;

type Direction = readonly [number, number];

/** A half circle of `SCALLOP_RADIUS` round (centreU, centreV) bulging toward `bulge` (a unit vector). */
function scallop(pen: RivalPen, face: PenFace, ink: number, centreU: number, centreV: number, bulge: Direction): void {
  const [bulgeU, bulgeV] = bulge;
  const points = Array.from({ length: SCALLOP_ARC_SEGMENTS + 1 }, (_, index): Point => {
    const angle = (index / SCALLOP_ARC_SEGMENTS - 0.5) * HALF_TURN;
    const forward = Math.cos(angle) * SCALLOP_RADIUS;
    const sideways = Math.sin(angle) * SCALLOP_RADIUS;
    return [centreU + bulgeU * forward - bulgeV * sideways, centreV + bulgeV * forward + bulgeU * sideways];
  });
  pen.path([face], ink, points, SCALLOP_WIDTH);
}

/** Rows of scales over a face: row k sits at `rowAt[k]` along `rowAxis`, scales spaced across the other axis of length `span`. */
function scallopRows(pen: RivalPen, face: PenFace, rowAt: readonly number[], span: number, bulge: Direction, rowsRunAlongU: boolean): void {
  for (const [rowIndex, rowPosition] of rowAt.entries()) {
    const ink = rowIndex % 2;
    const shift = (rowIndex % 2) * SCALLOP_ROW_SHIFT;
    for (let across = SCALLOP_RADIUS + shift; across < span; across += SCALLOP_PITCH) {
      if (rowsRunAlongU) scallop(pen, face, ink, across, rowPosition, bulge);
      else scallop(pen, face, ink, rowPosition, across, bulge);
    }
  }
}

function drawScallops(pen: RivalPen): void {
  for (const side of BOTH_SIDES) scallopRows(pen, side, FLANK_SCALLOP_ROWS, NOSE_U, [0, -1], true);
  for (const end of END_FACES) scallopRows(pen, end, END_SCALLOP_ROWS, END_WIDTH, [0, -1], true);
  scallopRows(pen, "top", HOOD_SCALLOP_ROWS, TOP_WIDTH, [-1, 0], false);
}

export const ORGANIC_PATTERNS: readonly RivalPattern[] = [
  { name: "flames", inks: 2, draw: drawFlames },
  { name: "tiger-stripes", inks: 1, draw: drawTigerStripes },
  { name: "zebra-stripes", inks: 1, draw: drawZebraStripes },
  { name: "camo-blotches", inks: 2, draw: drawCamoBlotches },
  { name: "tribal-swoosh", inks: 1, draw: drawTribalSwoosh },
  { name: "scallops", inks: 2, draw: drawScallops },
];
