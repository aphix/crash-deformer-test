import * as THREE from "three";
import { detAtan2, detCos, hypot2 } from "../kernel/physics-core.js";

/** Procedural `DataTexture`s of the derby arena (no canvas: node tests build them), seeded so every build is identical. */
/** Row 0 is the bottom (v = 0), column 0 the left (u = 0); sRGB, linear magnification, mipmapped. */
export type Texel = readonly number[];
type Wrap = { horizontal: THREE.Wrapping; vertical: THREE.Wrapping };

export const TEXTURE_WRAP = {
  repeat: { horizontal: THREE.RepeatWrapping, vertical: THREE.RepeatWrapping },
  clamp: { horizontal: THREE.ClampToEdgeWrapping, vertical: THREE.ClampToEdgeWrapping },
  repeatAcross: { horizontal: THREE.RepeatWrapping, vertical: THREE.ClampToEdgeWrapping },
} as const;

/** Largest 8-bit channel value: a texel without a fourth number is this opaque. */
const OPAQUE = 255;
/** Rubber and tyres are a touch blue (blue channel multiplier). */
const COOL_TINT = 1.06;

/** Small integer generator behind every "random" look (the arena's own generator). */
const RANDOM_MULTIPLIER = 1664525;
const RANDOM_INCREMENT = 1013904223;
const RANDOM_RANGE = 2 ** 32;
const SEEDS = { plank: 91, corrugated: 7731, tyre: 5, rubber: 23, wall: 2718, barrier: 77, glass: 31 } as const;

const FULL_TURN = 2 * Math.PI;
/** Planks: texture size, the tile (m, a 1 m board), planks across a tile (0.25 m each), dark gap (texels, each side of an edge: 1.5 cm), nail size and inset from a board end (texels). */
const PLANK_SIZE = 256;
const PLANK_COUNT = 4;
const PLANK_TEXELS = PLANK_SIZE / PLANK_COUNT;
const PLANK_GAP_HALF = 2;
const PLANK_NAIL_RADIUS = 3;
const PLANK_NAIL_INSET = 22;
/** Plank grain: streak cells along and across a tile, and how strongly it modulates the wood (share). */
const PLANK_GRAIN_CELLS = { along: 3, across: 48 };
const PLANK_GRAIN_SPREAD = 0.4;
/** The fine grain over the streaks: its cells are this many times the streak cells, and it is this share of the grain. */
const PLANK_FINE_SCALE = 2;
const PLANK_FINE_SHARE = 0.3;
/** Where each plank's butt joint sits along the tile (texels): staggered so the joints do not line up. */
const PLANK_JOINTS = [20, 150, 80, 210] as const;
const PLANK_WOOD_LIGHT = [158, 128, 92];
const PLANK_WOOD_MID = [132, 106, 76];
const PLANK_WOOD_DARK = [112, 92, 70];
const PLANK_SHADES = [PLANK_WOOD_LIGHT, PLANK_WOOD_MID, PLANK_WOOD_DARK, PLANK_WOOD_MID];
const PLANK_GAP_COLOUR = [26, 20, 14];
const PLANK_NAIL_COLOUR = [58, 52, 48];

/** Corrugated metal: texture size, ribs across the 1 m tile (one per 0.2 m), rib depth (share of the shade lost in a trough). */
const CORRUGATED_SIZE = 128;
const CORRUGATED_RIBS = 5;
const CORRUGATED_RIB_DEPTH = 0.5;
const CORRUGATED_GRAIN = 0.015;
const CORRUGATED_BASE = [228, 228, 226];
/** Door-end seam (column, texels wide) and its locking bar (columns). */
const CORRUGATED_SEAM_COLUMN = 64;
const CORRUGATED_SEAM_HALF = 1;
const CORRUGATED_BAR_COLUMNS = { first: 54, last: 59 };
const CORRUGATED_SEAM_SHADE = 0.3;
const CORRUGATED_BAR_SHADE = 1.18;
/** Rust streaks running down: count, width range, length range (texels). */
const RUST_STREAK_COUNT = 8;
const RUST_WIDTH = { least: 3, spread: 6 };
const RUST_LENGTH = { least: 30, spread: 80 };
/** Rust tint (channel multipliers): dark enough to read on the blue, red and rusted instance colours alike. */
const RUST_TINT = [0.58, 0.32, 0.18];
const RUST_BLOTCH_CELLS = 9;
const RUST_BLOTCH_FROM = 0.75;
const RUST_BLOTCH_TO = 0.93;
/** A streak's top starts at least this share up the tile; it fades over the part of its length beyond this fraction. */
const RUST_TOP_FROM = 0.5;
const RUST_FADE_FROM = 0.4;

/** Tyre stack: texture size, tyre pitch (0.5 m tyres, tyres per row, odd rows shifted half a tyre), and radii (texels) of the whole tyre, its tread ring and its hole. */
const TYRE_SIZE = 128;
const TYRE_PITCH = 64;
const TYRES_ACROSS = TYRE_SIZE / TYRE_PITCH;
const TYRE_RADIUS = 32;
const TYRE_TREAD_FROM = 23;
const TYRE_HOLE_RADIUS = 11;
const TYRE_RUBBER = 30;
const TYRE_TREAD = 66;
const TYRE_HOLE_COLOUR = [6, 6, 7];
const TYRE_GAP_COLOUR = [2, 2, 3];
/** Grain spread (levels), the top-lit gradient (share of a tyre's height), the spread of each tyre's own grey (share, seeded). */
const TYRE_GRAIN = 8;
const TYRE_LIGHT = 0.3;
const TYRE_GREY_SPREAD = 0.36;
/** Tread blocks round the outer band: count, the share of each that is a dark groove and its shade; the dusty upper-left highlight on a sidewall (levels); the dark rim (texels and shade lost). */
const TYRE_BLOCKS = 28;
const TYRE_GROOVE_SHARE = 0.3;
const TYRE_GROOVE_SHADE = 0.45;
const TYRE_HIGHLIGHT = 60;
const TYRE_RIM = { texels: 3, shade: 0.5 };

/** Rubber: texture size, grain spread and base (levels), edge band (texels) and lift, stud spacing and radius (texels) and lift. */
const RUBBER_SIZE = 64;
const RUBBER_BASE = 30;
const RUBBER_GRAIN = 8;
const RUBBER_EDGE = 6;
const RUBBER_EDGE_LIFT = 18;
const RUBBER_STUD_PITCH = 16;
const RUBBER_STUD_RADIUS = 3;
const RUBBER_STUD_LIFT = 22;

/** Concrete wall: texture size, panel width (m, repeat) and wall height (m, clamp), the hazard band at the top (m) and its stripe width (m: ten per panel keeps the repeat seamless). */
const WALL_SIZE = 256;
const WALL_PANEL_METRES = 3;
export const WALL_HEIGHT_METRES = 3.5;
export const HAZARD_BAND_METRES = 0.6;
const HAZARD_STRIPE_METRES = 0.3;
const HAZARD_YELLOW = [244, 190, 24];
const HAZARD_BLACK = [26, 26, 26];
const WALL_CONCRETE = [190, 187, 180];
/** Seam half widths (texels), where the horizontal panel joint sits (texel row), and how much of the concrete a seam keeps. */
const WALL_SEAM_HALF = 1.6;
const WALL_JOINT_ROW = 120;
const WALL_SEAM_SHADE = 0.55;
/** Form-tie holes: columns and rows (texels), radius; they are marked like cracks (`WALL_CRACK_SHADE`). */
const WALL_TIE_COLUMNS = [64, 192];
const WALL_TIE_ROWS = [52, 160];
const WALL_TIE_RADIUS = 3;
/** Hairline cracks: count, steps each, sideways jitter (texels per step), the share of the concrete they keep. */
const WALL_CRACK_COUNT = 4;
const WALL_CRACK_STEPS = 90;
const WALL_CRACK_JITTER = 2.2;
const WALL_CRACK_SHADE = 0.55;
/** Stains: streak cells across and down the panel, strongest darkening, and the grime near the ground (share lost at the foot). */
const WALL_STAIN_CELLS = { across: 36, down: 3 };
const WALL_STAIN_DARKEN = 0.14;
const WALL_FOOT_GRIME = 0.28;
const WALL_MOTTLE_SPREAD = 0.1;
const WALL_MOTTLE_CELLS = 16;
const WALL_GRAIN = 0.05;
const WALL_STAIN_BAND = [0.5, 0.9] as const;
const WALL_CRACK_RADIUS = 0.7;

/** K-rail barrier: texture size, concrete, seam half width (texels), the darker base (rows, share kept at the foot), chips, and the sloped shoulder row. */
const BARRIER_SIZE = 128;
const BARRIER_CONCRETE = [188, 185, 178];
const BARRIER_SEAM_HALF = 1.2;
const BARRIER_SEAM_SHADE = 0.55;
const BARRIER_BASE_ROWS = 28;
const BARRIER_BASE_SHADE = 0.68;
const BARRIER_CHIP_COUNT = 16;
const BARRIER_CHIP_RADIUS = { least: 0.9, spread: 1.6 };
const BARRIER_CHIP_SHADE = 0.78;
const BARRIER_SHOULDER_ROW = 84;
const BARRIER_SHOULDER_LIFT = 1.09;
const BARRIER_SHOULDER_HALF = 1;
const BARRIER_GRAIN = 0.1;

/** Glass wall: texture size, panel width (m, repeat) and glass height (m, clamp: wall height less the concrete). */
const GLASS_SIZE = 256;
const GLASS_PANEL_METRES = 3;
const GLASS_HEIGHT_METRES = 8.5;
/** Steel frame: mullion and transom width (m), transom spacing (m). */
const GLASS_FRAME_METRES = 0.12;
const GLASS_TRANSOM_METRES = 2.8;
const GLASS_FRAME = [88, 98, 108];
const GLASS_FRAME_GRAIN = 0.1;
/** Glass cell colour and alpha (plan ~0.18), reflection streak colour and alpha (~0.30). */
const GLASS_CELL = [170, 190, 205];
export const GLASS_CELL_ALPHA = 46;
const GLASS_STREAK = [226, 236, 246];
export const GLASS_STREAK_ALPHA = 77;
/** The streak bands as phases of one panel along a 45 degree diagonal: [from, full from, full to, to] for the broad band and the thin one. */
const GLASS_STREAK_BROAD = [0.28, 0.33, 0.43, 0.48] as const;
const GLASS_STREAK_THIN = [0.51, 0.52, 0.54, 0.55] as const;
const GLASS_STREAK_THIN_SHARE = 0.5;

export function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, RANDOM_MULTIPLIER) + RANDOM_INCREMENT) >>> 0;
    return state / RANDOM_RANGE;
  };
}

/** A `DataTexture` painted texel by texel; a texel carries red, green, blue and optionally alpha (0-255). */
export function makeTexture(width: number, height: number, texelAt: (column: number, row: number) => Texel, wrap: Wrap): THREE.DataTexture {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const [red, green, blue, alpha = OPAQUE] = texelAt(column, row);
      const offset = (row * width + column) * 4;
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = alpha;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.wrapS = wrap.horizontal;
  texture.wrapT = wrap.vertical;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function wrapped(value: number, period: number): number {
  return ((value % period) + period) % period;
}

function wrapDistance(first: number, second: number, period: number): number {
  const apart = wrapped(first - second, period);
  return Math.min(apart, period - apart);
}

/** 0 below `from`, 1 above `to`, smooth between. */
export function ramp(from: number, to: number, value: number): number {
  const share = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return share * share * (3 - 2 * share);
}

function scaled(colour: readonly number[], factor: number): Texel {
  return [colour[0] * factor, colour[1] * factor, colour[2] * factor];
}

/** Smooth value noise over the unit square, wrapping at its edges so a tile stays seamless; `at(u, v)` is 0-1. */
export function makeValueNoise(random: () => number, cellsAcross: number, cellsDown: number): (u: number, v: number) => number {
  const lattice = Float32Array.from({ length: cellsAcross * cellsDown }, random);
  return (u, v) => {
    const x = u * cellsAcross;
    const y = v * cellsDown;
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);
    const blendX = ramp(0, 1, x - cellX);
    const blendY = ramp(0, 1, y - cellY);
    const left = cellX % cellsAcross;
    const right = (cellX + 1) % cellsAcross;
    const bottom = (cellY % cellsDown) * cellsAcross;
    const top = ((cellY + 1) % cellsDown) * cellsAcross;
    const lower = lattice[bottom + left] + (lattice[bottom + right] - lattice[bottom + left]) * blendX;
    const upper = lattice[top + left] + (lattice[top + right] - lattice[top + left]) * blendX;
    return lower + (upper - lower) * blendY;
  };
}

/** Writes `value` into every mask cell within `radius` texels of a point, wrapping at the edges (tileable marks). */
function stampDisc(mask: Float32Array, size: number, centreColumn: number, centreRow: number, radius: number): void {
  const reach = Math.ceil(radius);
  for (let row = Math.floor(centreRow) - reach; row <= Math.floor(centreRow) + reach; row++) {
    for (let column = Math.floor(centreColumn) - reach; column <= Math.floor(centreColumn) + reach; column++) {
      if (hypot2(column + 0.5 - centreColumn, row + 0.5 - centreRow) > radius) continue;
      mask[wrapped(row, size) * size + wrapped(column, size)] = 1;
    }
  }
}

/** Four planks of a 1 m tile across (rows), staggered butt joints, dark gaps, grain along each board, a nail near each board end. */
export function makePlankTexture(): THREE.DataTexture {
  const random = makeSeededRandom(SEEDS.plank);
  const grain = makeValueNoise(random, PLANK_GRAIN_CELLS.along, PLANK_GRAIN_CELLS.across);
  const fineGrain = makeValueNoise(random, PLANK_GRAIN_CELLS.along * PLANK_FINE_SCALE, PLANK_GRAIN_CELLS.across * PLANK_FINE_SCALE);
  return makeTexture(
    PLANK_SIZE,
    PLANK_SIZE,
    (column, row) => {
      const plank = Math.floor(row / PLANK_TEXELS);
      const rowInPlank = row - plank * PLANK_TEXELS;
      const edgeDistance = Math.min(rowInPlank + 0.5, PLANK_TEXELS - rowInPlank - 0.5);
      const fromJoint = wrapped(column - PLANK_JOINTS[plank], PLANK_SIZE);
      if (edgeDistance < PLANK_GAP_HALF || fromJoint < PLANK_GAP_HALF * 2) return PLANK_GAP_COLOUR;
      const nailRow = rowInPlank + 0.5 - PLANK_TEXELS / 2;
      const nailDistance = Math.min(hypot2(fromJoint - PLANK_NAIL_INSET, nailRow), hypot2(fromJoint - (PLANK_SIZE - PLANK_NAIL_INSET), nailRow));
      if (nailDistance < PLANK_NAIL_RADIUS) return PLANK_NAIL_COLOUR;
      const u = (column + 0.5) / PLANK_SIZE;
      const v = (row + 0.5) / PLANK_SIZE;
      const streak = grain(u, v) * (1 - PLANK_FINE_SHARE) + fineGrain(u, v) * PLANK_FINE_SHARE;
      return scaled(PLANK_SHADES[plank], 1 - PLANK_GRAIN_SPREAD / 2 + streak * PLANK_GRAIN_SPREAD);
    },
    TEXTURE_WRAP.repeat,
  );
}

type RustStreak = { column: number; width: number; top: number; length: number };

function rustStreakAt(streak: RustStreak, column: number, row: number): number {
  const across = wrapDistance(column + 0.5, streak.column, CORRUGATED_SIZE) / (streak.width / 2);
  const down = (streak.top - row) / streak.length;
  if (across >= 1 || down < 0 || down >= 1) return 0;
  return (1 - across) * (1 - ramp(RUST_FADE_FROM, 1, down));
}

/** Vertical ribs every 0.2 m (lit and shaded flanks), a door-end seam with its locking bar, rust streaks and blotches. */
export function makeCorrugatedTexture(): THREE.DataTexture {
  const random = makeSeededRandom(SEEDS.corrugated);
  const blotches = makeValueNoise(random, RUST_BLOTCH_CELLS, RUST_BLOTCH_CELLS);
  const streaks = Array.from({ length: RUST_STREAK_COUNT }, () => ({
    column: random() * CORRUGATED_SIZE,
    width: RUST_WIDTH.least + random() * RUST_WIDTH.spread,
    top: CORRUGATED_SIZE * (RUST_TOP_FROM + random() * (1 - RUST_TOP_FROM)),
    length: RUST_LENGTH.least + random() * RUST_LENGTH.spread,
  }));
  return makeTexture(
    CORRUGATED_SIZE,
    CORRUGATED_SIZE,
    (column, row) => {
      const phase = ((column + 0.5) / CORRUGATED_SIZE) * CORRUGATED_RIBS;
      let shade = 1 - (CORRUGATED_RIB_DEPTH / 2) * (1 - detCos(phase * FULL_TURN));
      if (Math.abs(column + 0.5 - CORRUGATED_SEAM_COLUMN) < CORRUGATED_SEAM_HALF + 0.5) shade *= CORRUGATED_SEAM_SHADE;
      else if (column >= CORRUGATED_BAR_COLUMNS.first && column <= CORRUGATED_BAR_COLUMNS.last) shade *= CORRUGATED_BAR_SHADE;
      let rust = ramp(RUST_BLOTCH_FROM, RUST_BLOTCH_TO, blotches((column + 0.5) / CORRUGATED_SIZE, (row + 0.5) / CORRUGATED_SIZE));
      for (const streak of streaks) rust = Math.max(rust, rustStreakAt(streak, column, row));
      const grain = 1 + (random() - 0.5) * CORRUGATED_GRAIN;
      return [0, 1, 2].map((channel) => CORRUGATED_BASE[channel] * shade * grain * (1 - rust * (1 - RUST_TINT[channel])));
    },
    TEXTURE_WRAP.repeat,
  );
}

/** The tyre of the brick bond nearest a texel: its distance and offset from its middle (texels) and which of the tile's four tyres it is. */
function nearestTyre(column: number, row: number) {
  const rowIndex = Math.floor(row / TYRE_PITCH);
  let nearest = { distance: Infinity, offsetColumn: 0, offsetRow: 0, id: 0 };
  for (let candidate = rowIndex - 1; candidate <= rowIndex + 1; candidate++) {
    const shifted = column + 0.5 - wrapped(candidate, 2) * (TYRE_PITCH / 2);
    const offsetColumn = wrapped(shifted, TYRE_PITCH) - TYRE_PITCH / 2;
    const offsetRow = row + 0.5 - (candidate * TYRE_PITCH + TYRE_PITCH / 2);
    const distance = hypot2(offsetColumn, offsetRow);
    if (distance < nearest.distance) nearest = { distance, offsetColumn, offsetRow, id: wrapped(candidate, 2) * TYRES_ACROSS + wrapped(Math.floor(shifted / TYRE_PITCH), TYRES_ACROSS) };
  }
  return nearest;
}

/** Round tyres seen end-on in a brick bond: dusty highlight on each sidewall's upper left, tread blocks round the outer band, a dark rim, a hole, black between, each tyre its own grey. */
export function makeTyreStackTexture(): THREE.DataTexture {
  const random = makeSeededRandom(SEEDS.tyre);
  const greys = Array.from({ length: TYRES_ACROSS * TYRES_ACROSS }, () => 1 + (random() - 0.5) * TYRE_GREY_SPREAD);
  return makeTexture(
    TYRE_SIZE,
    TYRE_SIZE,
    (column, row) => {
      const tyre = nearestTyre(column, row);
      if (tyre.distance > TYRE_RADIUS) return TYRE_GAP_COLOUR;
      if (tyre.distance < TYRE_HOLE_RADIUS) return TYRE_HOLE_COLOUR;
      let level = TYRE_RUBBER + TYRE_HIGHLIGHT * Math.max(0, (tyre.offsetRow - tyre.offsetColumn) / (Math.SQRT2 * TYRE_TREAD_FROM));
      if (tyre.distance >= TYRE_TREAD_FROM) {
        const phase = wrapped((detAtan2(tyre.offsetRow, tyre.offsetColumn) / FULL_TURN) * TYRE_BLOCKS + 0.5, 1);
        level = phase < TYRE_GROOVE_SHARE ? TYRE_TREAD * TYRE_GROOVE_SHADE : TYRE_TREAD;
      }
      level *= (1 - (tyre.offsetRow / TYRE_RADIUS) * TYRE_LIGHT) * greys[tyre.id] * (1 - TYRE_RIM.shade * ramp(TYRE_RADIUS - TYRE_RIM.texels, TYRE_RADIUS, tyre.distance));
      const grained = level + (random() - 0.5) * TYRE_GRAIN;
      return [grained, grained, grained * COOL_TINT];
    },
    TEXTURE_WRAP.repeat,
  );
}

/** Black rubber grain, a lighter band along the tile edge, a faint stud pattern. */
export function makeRubberTexture(): THREE.DataTexture {
  const random = makeSeededRandom(SEEDS.rubber);
  return makeTexture(
    RUBBER_SIZE,
    RUBBER_SIZE,
    (column, row) => {
      const edge = Math.min(column + 0.5, RUBBER_SIZE - column - 0.5, row + 0.5, RUBBER_SIZE - row - 0.5);
      const studColumn = wrapped(column + 0.5, RUBBER_STUD_PITCH) - RUBBER_STUD_PITCH / 2;
      const studRow = wrapped(row + 0.5, RUBBER_STUD_PITCH) - RUBBER_STUD_PITCH / 2;
      const stud = 1 - ramp(RUBBER_STUD_RADIUS - 1, RUBBER_STUD_RADIUS, hypot2(studColumn, studRow));
      const level = RUBBER_BASE + (random() - 0.5) * RUBBER_GRAIN + RUBBER_EDGE_LIFT * (1 - ramp(0, RUBBER_EDGE, edge)) + RUBBER_STUD_LIFT * stud;
      return [level, level, level * COOL_TINT];
    },
    TEXTURE_WRAP.repeat,
  );
}

function hazardTexel(column: number, row: number): Texel {
  const metresAcross = ((column + 0.5) / WALL_SIZE) * WALL_PANEL_METRES;
  const metresUp = ((row + 0.5) / WALL_SIZE) * WALL_HEIGHT_METRES;
  return Math.floor((metresAcross + metresUp) / HAZARD_STRIPE_METRES) % 2 === 0 ? HAZARD_YELLOW : HAZARD_BLACK;
}

/** The cracks and form-tie holes of a wall panel as a mask (1 = mark). */
function paintWallMarks(random: () => number): Float32Array {
  const marks = new Float32Array(WALL_SIZE * WALL_SIZE);
  const bandRows = (HAZARD_BAND_METRES / WALL_HEIGHT_METRES) * WALL_SIZE;
  for (let crack = 0; crack < WALL_CRACK_COUNT; crack++) {
    let column = random() * WALL_SIZE;
    const start = random() * (WALL_SIZE - bandRows - WALL_CRACK_STEPS);
    for (let step = 0; step < WALL_CRACK_STEPS; step++) {
      column += (random() - 0.5) * WALL_CRACK_JITTER;
      stampDisc(marks, WALL_SIZE, column, start + step, WALL_CRACK_RADIUS);
    }
  }
  for (const tieRow of WALL_TIE_ROWS) {
    for (const tieColumn of WALL_TIE_COLUMNS) stampDisc(marks, WALL_SIZE, tieColumn, tieRow, WALL_TIE_RADIUS);
  }
  return marks;
}

/** A 3 m x 3.5 m concrete panel: seams, form ties, hairline cracks, stains, foot grime, a yellow/black hazard band over the top `HAZARD_BAND_METRES`. */
export function makeConcreteWallTexture(): THREE.DataTexture {
  const random = makeSeededRandom(SEEDS.wall);
  const mottle = makeValueNoise(random, WALL_MOTTLE_CELLS, WALL_MOTTLE_CELLS);
  const stains = makeValueNoise(random, WALL_STAIN_CELLS.across, WALL_STAIN_CELLS.down);
  const marks = paintWallMarks(random);
  return makeTexture(
    WALL_SIZE,
    WALL_SIZE,
    (column, row) => {
      if (((row + 0.5) / WALL_SIZE) * WALL_HEIGHT_METRES >= WALL_HEIGHT_METRES - HAZARD_BAND_METRES) return hazardTexel(column, row);
      const u = (column + 0.5) / WALL_SIZE;
      const v = (row + 0.5) / WALL_SIZE;
      let shade = 1 + (mottle(u, v) - 0.5) * WALL_MOTTLE_SPREAD + (random() - 0.5) * WALL_GRAIN;
      shade *= 1 - ramp(WALL_STAIN_BAND[0], WALL_STAIN_BAND[1], stains(u, v)) * WALL_STAIN_DARKEN;
      shade *= 1 - WALL_FOOT_GRIME * (1 - v) * (1 - v);
      if (wrapDistance(column + 0.5, 0, WALL_SIZE) < WALL_SEAM_HALF || Math.abs(row + 0.5 - WALL_JOINT_ROW) < WALL_SEAM_HALF) shade *= WALL_SEAM_SHADE;
      if (marks[row * WALL_SIZE + column] > 0) shade *= WALL_CRACK_SHADE;
      return scaled(WALL_CONCRETE, shade);
    },
    TEXTURE_WRAP.repeatAcross,
  );
}

/** K-rail concrete: a panel seam at the tile edge, a darker base, a lit shoulder, chips of exposed aggregate. */
export function makeBarrierTexture(): THREE.DataTexture {
  const random = makeSeededRandom(SEEDS.barrier);
  const chips = new Float32Array(BARRIER_SIZE * BARRIER_SIZE);
  for (let chip = 0; chip < BARRIER_CHIP_COUNT; chip++) {
    stampDisc(chips, BARRIER_SIZE, random() * BARRIER_SIZE, random() * BARRIER_SIZE, BARRIER_CHIP_RADIUS.least + random() * BARRIER_CHIP_RADIUS.spread);
  }
  return makeTexture(
    BARRIER_SIZE,
    BARRIER_SIZE,
    (column, row) => {
      let shade = 1 + (random() - 0.5) * BARRIER_GRAIN;
      shade *= BARRIER_BASE_SHADE + (1 - BARRIER_BASE_SHADE) * ramp(0, BARRIER_BASE_ROWS, row + 0.5);
      if (wrapDistance(column + 0.5, 0, BARRIER_SIZE) < BARRIER_SEAM_HALF) shade *= BARRIER_SEAM_SHADE;
      if (Math.abs(row - BARRIER_SHOULDER_ROW) < BARRIER_SHOULDER_HALF) shade *= BARRIER_SHOULDER_LIFT;
      if (chips[row * BARRIER_SIZE + column] > 0) shade *= BARRIER_CHIP_SHADE;
      return scaled(BARRIER_CONCRETE, shade);
    },
    TEXTURE_WRAP.repeat,
  );
}

/** 1 inside a trapezoid ramp `[from, full from, full to, to]` of `value`, 0 outside. */
function band(edges: readonly [number, number, number, number], value: number): number {
  return ramp(edges[0], edges[1], value) * (1 - ramp(edges[2], edges[3], value));
}

/** A steel frame (mullions every 3 m, a transom every 2.8 m) around pale blue-grey cells with a diagonal reflection streak. */
export function makeGlassTexture(): THREE.DataTexture {
  const random = makeSeededRandom(SEEDS.glass);
  return makeTexture(
    GLASS_SIZE,
    GLASS_SIZE,
    (column, row) => {
      const metresAcross = ((column + 0.5) / GLASS_SIZE) * GLASS_PANEL_METRES;
      const metresUp = ((row + 0.5) / GLASS_SIZE) * GLASS_HEIGHT_METRES;
      const onMullion = wrapDistance(metresAcross, 0, GLASS_PANEL_METRES) < GLASS_FRAME_METRES / 2;
      const onTransom = Math.abs(metresUp - Math.round(metresUp / GLASS_TRANSOM_METRES) * GLASS_TRANSOM_METRES) < GLASS_FRAME_METRES / 2;
      if (onMullion || onTransom) return scaled(GLASS_FRAME, 1 + (random() - 0.5) * GLASS_FRAME_GRAIN);
      const phase = wrapped((metresAcross - metresUp) / GLASS_PANEL_METRES, 1);
      const streak = Math.max(band(GLASS_STREAK_BROAD, phase), band(GLASS_STREAK_THIN, phase) * GLASS_STREAK_THIN_SHARE);
      const mix = (cell: number, bright: number) => cell + (bright - cell) * streak;
      return [mix(GLASS_CELL[0], GLASS_STREAK[0]), mix(GLASS_CELL[1], GLASS_STREAK[1]), mix(GLASS_CELL[2], GLASS_STREAK[2]), mix(GLASS_CELL_ALPHA, GLASS_STREAK_ALPHA)];
    },
    TEXTURE_WRAP.repeatAcross,
  );
}
