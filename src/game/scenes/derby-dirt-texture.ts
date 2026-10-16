import { detCos, detSin, hypot2 } from "../kernel/physics-core.js";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { DERBY_ARENA } from "./constants.ts";
import { TEXTURE_WRAP, makeSeededRandom, makeTexture, makeValueNoise, ramp } from "./derby-textures.ts";

/** Compacted dirt of the derby floor: a grey texture over the square `2 x (radius + 1)` m (the floor reaches one metre past the radius); column = +x, row = +z. */
const DIRT_SIZE = 1024;
export const DIRT_EXTENT = DERBY_ARENA.radius + 1;
const DIRT_SEED = 4117;
/** Coarse grids laid over the same square: the soft lanes and tone (0.3 m cells) and the ruts and clods (0.15 m cells), upsampled when painted. */
export const LANE_GRID = 256;
export const RUT_GRID = 512;
const FULL_TURN = 2 * Math.PI;

/** Pale warm dirt in grey (0-255): the floor's vertex colour (tan) multiplies it; the driven ring drags the mean down to about 0.88 of white. */
export const DIRT_BASE_GREY = 244;
const DIRT_GRIT_SPREAD = 8;
/** Smooth layers: cells across the whole square (blotches 16 m, mottling 6 m, patches 2 m) and their spread (channel levels); clods (0.6 m cells) live on the fine grid. */
const DIRT_NOISE_LAYERS = [
  { cells: 5, spread: 26 },
  { cells: 13, spread: 18 },
  { cells: 40, spread: 12 },
] as const;
const DIRT_CLODS = { cells: 130, spread: 12 };
/** Patches that scale the dirt by `1 + effect x ramp(from, to, noise)`: damp dark ones 1-3 m and 12 m, pale dry dust ones 3 m and 12 m. Each is two octaves, so its edges are not square. */
const DIRT_PATCHES = [
  { cells: 29, from: 0.5, to: 0.8, effect: -0.16 },
  { cells: 7, from: 0.5, to: 0.8, effect: -0.1 },
  { cells: 23, from: 0.5, to: 0.8, effect: 0.1 },
  { cells: 6, from: 0.5, to: 0.8, effect: 0.07 },
] as const;
const PATCH_SECOND_OCTAVE = { cellsFactor: 2.7, share: 0.4 };

/** Pebbles: count, radius range (m: 0.05-0.15), and the levels they lighten or darken a texel by; half of them are light, half dark. */
const PEBBLE_COUNT = 9000;
const PEBBLE_RADIUS = { least: 0.05, most: 0.15 };
const PEBBLE_LEVELS = { least: 22, most: 55 };
const PEBBLE_SEED = 777;

/** Wheel ruts 0.55 m wide, a pair `2 x CAR_HALF.x` apart, in a trodden lane 2.4 m wide whose pushed-up ridge (0.45 m) lies outside it. */
const TRACK_RUT_WIDTH = 0.55;
export const TRACK_GAUGE = 2 * CAR_HALF.x;
export const TRACK_LANE_WIDTH = 2.4;
const TRACK_RIDGE_WIDTH = 0.45;
const TRACK_RUT_HALF = TRACK_RUT_WIDTH / 2;
const TRACK_LANE_HALF = TRACK_LANE_WIDTH / 2;
/** Share of a half width (from the middle) that stays fully dark before the soft edge: the lane is softer than a rut. */
const TRACK_RUT_CORE_SHARE = 0.5;
const TRACK_LANE_CORE_SHARE = 0.15;
/** Stamps add up (overlapping passes darken, saturating as `1 - exp(-sum)`): the sum one pass leaves at the middle of a lane and of a rut. */
const TRACK_LANE_GAIN = 0.18;
const TRACK_RUT_GAIN = 0.26;
/** Share of the dirt a saturated lane, rut and tread block darken (light enough that single arcs stay apart where many overlap), and the lift (channel levels) of the ridge. */
const TRACK_LANE_DARKEN = 0.3;
const TRACK_RUT_DARKEN = 0.26;
const TRACK_TREAD_DARKEN = 0.2;
/** No texel gets darker than the ceiling (a share of the base grey): darkness past the knee is squeezed by `1 - exp(-excess / room)`, so it only approaches the ceiling. */
const DIRT_DARKNESS_KNEE = 0.2;
const DIRT_DARKNESS_CEILING = 0.5;
const TRACK_RIDGE_LIFT = 20;
/** Stamp spacing along a path (m); the lane and the tread are stamped every this many samples. */
const TRACK_STEP = 0.12;
const TRACK_LANE_EVERY = 3;
const TRACK_TREAD_EVERY = 3;
/** A tread chevron: seven dots across a rut (shares of its half width), the outer ones trailing by this share of it. */
const TREAD_CHEVRON_ACROSS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1] as const;
const TREAD_CHEVRON_WIDTH_SHARE = 0.85;
const TREAD_CHEVRON_TRAIL_SHARE = 0.6;
/** A track fades along its length: noise cells across the square, the noise band, the share left at the weakest. */
const TRACK_FADE_CELLS = 12;
const TRACK_FADE_BAND = [0.38, 0.62] as const;
const TRACK_FADE_FLOOR = 0.25;
const TRACK_FADE_SEED = 31;
/** A path drifts sideways (its `wander`, m) this many cycles along its length. */
const TRACK_WANDER_CYCLES = 3;
const TRACK_PAIR_SIDES = [-1, 1] as const;

export type TrackPath = {
  shape: "ellipse" | "eight" | "line";
  x: number;
  z: number;
  radiusX: number;
  radiusZ: number;
  tilt: number;
  startRadians: number;
  sweepRadians: number;
  strength: number;
  wander: number;
  /** Metres over which an open path fades to nothing at each end. */
  feather: number;
};

type Range = { least: number; most: number };

/** Derby traffic as ranges (m, radians, shares): a path is drawn from each family's ranges by a seeded generator; `radius` is a line's half length. */
const PATH_SEED = 5150;
/** Paths whose centreline comes within this many metres of the middle are thinned: every third of them (in generation order) is dropped, except donut rings. */
export const MIDDLE_THINNING_RADIUS = 12;
const MIDDLE_THINNING_EVERY = 3;
const MIDDLE_SAMPLES = 240;
const PATH_FEATHER: Range = { least: 5, most: 8 };
const PATH_FAMILIES = [
  { shape: "ellipse", thin: true, count: 16, centreDistance: { least: 0, most: 8 }, radius: { least: 20, most: 33 }, squash: { least: 0.8, most: 1 }, sweep: { least: 1.5, most: FULL_TURN }, fullTurnShare: 0.2, strength: { least: 0.3, most: 1 }, wander: { least: 0.15, most: 0.4 } },
  { shape: "ellipse", thin: true, count: 12, centreDistance: { least: 2, most: 14 }, radius: { least: 6, most: 20 }, squash: { least: 0.75, most: 1 }, sweep: { least: 1.5, most: FULL_TURN }, fullTurnShare: 0.25, strength: { least: 0.3, most: 1 }, wander: { least: 0.1, most: 0.3 } },
  { shape: "ellipse", thin: true, count: 6, centreDistance: { least: 10, most: 18 }, radius: { least: 24, most: 34 }, squash: { least: 0.8, most: 1 }, sweep: { least: 1.2, most: 3.5 }, fullTurnShare: 0, strength: { least: 0.4, most: 1 }, wander: { least: 0.15, most: 0.35 } },
  { shape: "ellipse", thin: false, count: 4, centreDistance: { least: 2, most: 14 }, radius: { least: 3, most: 6 }, squash: { least: 0.9, most: 1 }, sweep: { least: FULL_TURN, most: FULL_TURN }, fullTurnShare: 1, strength: { least: 0.8, most: 1 }, wander: { least: 0.05, most: 0.1 } },
  { shape: "eight", thin: true, count: 4, centreDistance: { least: 8, most: 20 }, radius: { least: 10, most: 15 }, squash: { least: 0.45, most: 0.55 }, sweep: { least: FULL_TURN, most: FULL_TURN }, fullTurnShare: 1, strength: { least: 0.6, most: 1 }, wander: { least: 0.1, most: 0.2 } },
  { shape: "line", thin: true, count: 10, centreDistance: { least: 6, most: 26 }, radius: { least: 4, most: 10 }, squash: { least: 0, most: 0 }, sweep: { least: 0, most: 0 }, fullTurnShare: 0, strength: { least: 0.6, most: 1 }, wander: { least: 0.05, most: 0.15 } },
] as const;

function draw(random: () => number, range: Range): number {
  return range.least + random() * (range.most - range.least);
}

/** How near the middle the centreline of a path comes (m): the least distance over `MIDDLE_SAMPLES` points along it. */
export function nearestApproachToMiddle(path: TrackPath): number {
  let nearest = Infinity;
  for (let sample = 0; sample <= MIDDLE_SAMPLES; sample++) {
    const point = pointOnPath(path, sample / MIDDLE_SAMPLES);
    nearest = Math.min(nearest, hypot2(point.x, point.z));
  }
  return nearest;
}

function generateTrackPaths(): TrackPath[] {
  const random = makeSeededRandom(PATH_SEED);
  const paths: TrackPath[] = [];
  let crossingTheMiddle = 0;
  for (const family of PATH_FAMILIES) {
    for (let index = 0; index < family.count; index++) {
      const bearing = random() * FULL_TURN;
      const distance = draw(random, family.centreDistance);
      const radiusX = draw(random, family.radius);
      const path = {
        shape: family.shape,
        x: distance * detCos(bearing),
        z: distance * detSin(bearing),
        radiusX,
        radiusZ: radiusX * draw(random, family.squash),
        tilt: random() * FULL_TURN,
        startRadians: random() * FULL_TURN,
        sweepRadians: random() < family.fullTurnShare ? FULL_TURN : draw(random, family.sweep),
        strength: draw(random, family.strength),
        wander: draw(random, family.wander),
        feather: draw(random, PATH_FEATHER),
      };
      const isThinned = family.thin && nearestApproachToMiddle(path) < MIDDLE_THINNING_RADIUS && crossingTheMiddle++ % MIDDLE_THINNING_EVERY === MIDDLE_THINNING_EVERY - 1;
      if (!isThinned) paths.push(path);
    }
  }
  return paths;
}

export const DIRT_TRACK_PATHS = generateTrackPaths();

/** A point of a driving line at `fraction` (0-1) along it, drifted by its wander, with the unit heading of the line. */
export function pointOnPath(path: TrackPath, fraction: number) {
  const angle = path.startRadians + path.sweepRadians * fraction;
  const isEight = path.shape === "eight";
  const isLine = path.shape === "line";
  const localX = isLine ? path.radiusX * (2 * fraction - 1) : path.radiusX * detSin(angle);
  const localZ = isLine ? 0 : isEight ? path.radiusZ * detSin(2 * angle) : path.radiusZ * detCos(angle);
  const slopeX = isLine ? 1 : path.radiusX * detCos(angle);
  const slopeZ = isLine ? 0 : isEight ? 2 * path.radiusZ * detCos(2 * angle) : -path.radiusZ * detSin(angle);
  const cosine = detCos(path.tilt);
  const sine = detSin(path.tilt);
  const slope = hypot2(slopeX, slopeZ);
  const headingX = (slopeX * cosine - slopeZ * sine) / slope;
  const headingZ = (slopeX * sine + slopeZ * cosine) / slope;
  const sideways = path.wander * detSin(FULL_TURN * TRACK_WANDER_CYCLES * fraction);
  return {
    x: path.x + localX * cosine - localZ * sine - headingZ * sideways,
    z: path.z + localX * sine + localZ * cosine + headingX * sideways,
    headingX,
    headingZ,
  };
}

function pathMetres(path: TrackPath): number {
  if (path.shape === "line") return 2 * path.radiusX;
  return path.sweepRadians * Math.max(path.radiusX, path.shape === "eight" ? 2 * path.radiusZ : path.radiusZ);
}

/** 1 along a closed loop; on an open path, rising from 0 at each end to 1 over its feather (no longer than half the path). */
export function endFadeAt(path: TrackPath, fraction: number): number {
  if (path.shape !== "line" && path.sweepRadians >= FULL_TURN) return 1;
  const metres = pathMetres(path);
  const feather = Math.min(path.feather, metres / 2);
  return Math.min(ramp(0, feather, fraction * metres), ramp(0, feather, (1 - fraction) * metres));
}

function strengthAt(path: TrackPath, fraction: number, fadeNoise: number): number {
  const noiseFade = TRACK_FADE_FLOOR + (1 - TRACK_FADE_FLOOR) * ramp(TRACK_FADE_BAND[0], TRACK_FADE_BAND[1], fadeNoise);
  return path.strength * endFadeAt(path, fraction) * noiseFade;
}

/** Bilinear read of a square grid laid over the dirt square at unit coordinates (0-1, 0-1), clamped at its edges. */
export function sampleField(field: Float32Array, size: number, u: number, v: number): number {
  const x = Math.min(size - 1, Math.max(0, u * size - 0.5));
  const y = Math.min(size - 1, Math.max(0, v * size - 0.5));
  const column = Math.min(size - 2, Math.floor(x));
  const row = Math.min(size - 2, Math.floor(y));
  const blendX = x - column;
  const blendY = y - row;
  const lower = field[row * size + column] * (1 - blendX) + field[row * size + column + 1] * blendX;
  const upper = field[(row + 1) * size + column] * (1 - blendX) + field[(row + 1) * size + column + 1] * blendX;
  return lower + (upper - lower) * blendY;
}

/** The cells of a `size` grid within `reachMetres` of a world point, and the point's own position in cells. */
function gridWindow(size: number, worldX: number, worldZ: number, reachMetres: number) {
  const cellMetres = (2 * DIRT_EXTENT) / size;
  const centreColumn = (worldX + DIRT_EXTENT) / cellMetres;
  const centreRow = (worldZ + DIRT_EXTENT) / cellMetres;
  const reach = Math.ceil(reachMetres / cellMetres);
  return {
    cellMetres,
    centreColumn,
    centreRow,
    firstColumn: Math.max(0, Math.floor(centreColumn) - reach),
    lastColumn: Math.min(size - 1, Math.floor(centreColumn) + reach),
    firstRow: Math.max(0, Math.floor(centreRow) - reach),
    lastRow: Math.min(size - 1, Math.floor(centreRow) + reach),
  };
}

/** The index of the cell of a `size` grid holding a world point, or -1 off the square. */
function cellIndexAt(size: number, worldX: number, worldZ: number): number {
  const cellMetres = (2 * DIRT_EXTENT) / size;
  const column = Math.floor((worldX + DIRT_EXTENT) / cellMetres);
  const row = Math.floor((worldZ + DIRT_EXTENT) / cellMetres);
  if (column < 0 || row < 0 || column >= size || row >= size) return -1;
  return row * size + column;
}

type TrackSums = { lane: Float32Array; ring: Float32Array; rut: Float32Array; tread: Float32Array };

/** The soft trodden lane and, beside its edge, the ring its pushed-up ridge rises in, added around a centreline point. */
function stampLane(sums: TrackSums, worldX: number, worldZ: number, strength: number): void {
  const reachMetres = TRACK_LANE_HALF + TRACK_RIDGE_WIDTH;
  const ridgePeak = TRACK_LANE_HALF + TRACK_RIDGE_WIDTH / 2;
  const window = gridWindow(LANE_GRID, worldX, worldZ, reachMetres);
  for (let row = window.firstRow; row <= window.lastRow; row++) {
    for (let column = window.firstColumn; column <= window.lastColumn; column++) {
      const distance = hypot2(column + 0.5 - window.centreColumn, row + 0.5 - window.centreRow) * window.cellMetres;
      if (distance > reachMetres) continue;
      const index = row * LANE_GRID + column;
      sums.lane[index] += strength * TRACK_LANE_GAIN * (1 - ramp(TRACK_LANE_HALF * TRACK_LANE_CORE_SHARE, TRACK_LANE_HALF, distance));
      sums.ring[index] += strength * TRACK_LANE_GAIN * Math.max(0, 1 - Math.abs(distance - ridgePeak) / (TRACK_RIDGE_WIDTH / 2));
    }
  }
}

/** One wheel's rut, added around a world point. */
function stampRut(sums: TrackSums, worldX: number, worldZ: number, strength: number): void {
  const window = gridWindow(RUT_GRID, worldX, worldZ, TRACK_RUT_HALF);
  for (let row = window.firstRow; row <= window.lastRow; row++) {
    for (let column = window.firstColumn; column <= window.lastColumn; column++) {
      const distance = hypot2(column + 0.5 - window.centreColumn, row + 0.5 - window.centreRow) * window.cellMetres;
      if (distance > TRACK_RUT_HALF) continue;
      sums.rut[row * RUT_GRID + column] += strength * TRACK_RUT_GAIN * (1 - ramp(TRACK_RUT_HALF * TRACK_RUT_CORE_SHARE, TRACK_RUT_HALF, distance));
    }
  }
}

/** A tread chevron (a V trailing behind the heading) pressed into one wheel's rut, one dot per texel. */
function stampChevron(sums: TrackSums, worldX: number, worldZ: number, headingX: number, headingZ: number, strength: number): void {
  for (const across of TREAD_CHEVRON_ACROSS) {
    const sideways = across * TRACK_RUT_HALF * TREAD_CHEVRON_WIDTH_SHARE;
    const along = -Math.abs(across) * TRACK_RUT_HALF * TREAD_CHEVRON_TRAIL_SHARE;
    const index = cellIndexAt(DIRT_SIZE, worldX + headingX * along - headingZ * sideways, worldZ + headingZ * along + headingX * sideways);
    if (index >= 0 && strength > sums.tread[index]) sums.tread[index] = strength;
  }
}

function layPath(sums: TrackSums, path: TrackPath, fade: (u: number, v: number) => number): void {
  const samples = Math.ceil(pathMetres(path) / TRACK_STEP);
  for (let sample = 0; sample <= samples; sample++) {
    const fraction = sample / samples;
    const point = pointOnPath(path, fraction);
    const unitX = Math.min(0.999, Math.max(0, (point.x + DIRT_EXTENT) / (2 * DIRT_EXTENT)));
    const unitZ = Math.min(0.999, Math.max(0, (point.z + DIRT_EXTENT) / (2 * DIRT_EXTENT)));
    const strength = strengthAt(path, fraction, fade(unitX, unitZ));
    if (strength <= 0) continue;
    if (sample % TRACK_LANE_EVERY === 0) stampLane(sums, point.x, point.z, strength);
    for (const side of TRACK_PAIR_SIDES) {
      const wheelX = point.x - point.headingZ * side * (TRACK_GAUGE / 2);
      const wheelZ = point.z + point.headingX * side * (TRACK_GAUGE / 2);
      stampRut(sums, wheelX, wheelZ, strength);
      if (sample % TRACK_TREAD_EVERY === 0) stampChevron(sums, wheelX, wheelZ, point.headingX, point.headingZ, strength);
    }
  }
}

/** What the paths leave in the dirt: the lane and rut (0-1, saturated), the ridge beside the lane (0-1), and tread blocks per texel (0-1). */
export type TrackFields = { lane: Float32Array; ridge: Float32Array; rut: Float32Array; tread: Float32Array };

/** Lays `paths` (each as a lane with a pair of ruts `TRACK_GAUGE` apart, tread chevrons in the ruts) and saturates the overlaps. */
export function paintTracks(paths: readonly TrackPath[]): TrackFields {
  const sums = { lane: new Float32Array(LANE_GRID * LANE_GRID), ring: new Float32Array(LANE_GRID * LANE_GRID), rut: new Float32Array(RUT_GRID * RUT_GRID), tread: new Float32Array(DIRT_SIZE * DIRT_SIZE) };
  const fade = makeValueNoise(makeSeededRandom(TRACK_FADE_SEED), TRACK_FADE_CELLS, TRACK_FADE_CELLS);
  for (const path of paths) layPath(sums, path, fade);
  const ridge = new Float32Array(sums.lane.length);
  for (let index = 0; index < sums.lane.length; index++) {
    ridge[index] = 1 - Math.exp(-Math.max(0, sums.ring[index] - sums.lane[index]));
    sums.lane[index] = 1 - Math.exp(-sums.lane[index]);
  }
  for (let index = 0; index < sums.rut.length; index++) sums.rut[index] = 1 - Math.exp(-sums.rut[index]);
  return { lane: sums.lane, ridge, rut: sums.rut, tread: sums.tread };
}

/** Two octaves of noise (0-1 around 0.5) on the lane grid: the cells given and a finer second octave. */
function bakePatchNoise(random: () => number, cells: number): Float32Array {
  const first = bakeNoise(makeValueNoise(random, cells, cells), LANE_GRID, 1);
  const fineCells = Math.round(cells * PATCH_SECOND_OCTAVE.cellsFactor);
  const second = bakeNoise(makeValueNoise(random, fineCells, fineCells), LANE_GRID, 1);
  for (let index = 0; index < first.length; index++) first[index] = 0.5 + first[index] * (1 - PATCH_SECOND_OCTAVE.share) + second[index] * PATCH_SECOND_OCTAVE.share;
  return first;
}

/** A noise layer sampled at the cell centres of a `size` grid, centred on zero and scaled to `spread`. */
function bakeNoise(noise: (u: number, v: number) => number, size: number, spread: number): Float32Array {
  const baked = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) baked[row * size + column] = (noise((column + 0.5) / size, (row + 0.5) / size) - 0.5) * spread;
  }
  return baked;
}

/** The soft tone on the lane grid: blotches and ridge lifts (levels, added) and damp, dry and lane scaling (shares, multiplied). */
function makeToneGrids(random: () => number, tracks: TrackFields) {
  const layers = DIRT_NOISE_LAYERS.map(({ cells, spread }) => bakeNoise(makeValueNoise(random, cells, cells), LANE_GRID, spread));
  const patches = DIRT_PATCHES.map(({ cells }) => bakePatchNoise(random, cells));
  const add = new Float32Array(LANE_GRID * LANE_GRID);
  const scale = new Float32Array(LANE_GRID * LANE_GRID);
  for (let index = 0; index < add.length; index++) {
    add[index] = DIRT_BASE_GREY + tracks.ridge[index] * TRACK_RIDGE_LIFT;
    for (const layer of layers) add[index] += layer[index];
    let patchScale = 1 - tracks.lane[index] * TRACK_LANE_DARKEN;
    for (let patch = 0; patch < DIRT_PATCHES.length; patch++) {
      const { from, to, effect } = DIRT_PATCHES[patch];
      patchScale *= 1 + effect * ramp(from, to, patches[patch][index]);
    }
    scale[index] = patchScale;
  }
  return { add, scale };
}

/** The tone and tracks folded onto the fine grid: the level a texel starts from (add) and what multiplies it (scale: patches, lane, ruts). */
function makeFineGrids(random: () => number, tracks: TrackFields) {
  const tone = makeToneGrids(random, tracks);
  const clods = bakeNoise(makeValueNoise(random, DIRT_CLODS.cells, DIRT_CLODS.cells), RUT_GRID, DIRT_CLODS.spread);
  const add = new Float32Array(RUT_GRID * RUT_GRID);
  const scale = new Float32Array(RUT_GRID * RUT_GRID);
  for (let row = 0; row < RUT_GRID; row++) {
    for (let column = 0; column < RUT_GRID; column++) {
      const index = row * RUT_GRID + column;
      const u = (column + 0.5) / RUT_GRID;
      const v = (row + 0.5) / RUT_GRID;
      add[index] = sampleField(tone.add, LANE_GRID, u, v) + clods[index];
      scale[index] = sampleField(tone.scale, LANE_GRID, u, v) * (1 - tracks.rut[index] * TRACK_RUT_DARKEN);
    }
  }
  return { add, scale };
}

/** Light and dark pebbles scattered over the texels (levels, added). */
function scatterPebbles(): Float32Array {
  const random = makeSeededRandom(PEBBLE_SEED);
  const cellMetres = (2 * DIRT_EXTENT) / DIRT_SIZE;
  const pebbles = new Float32Array(DIRT_SIZE * DIRT_SIZE);
  for (let pebble = 0; pebble < PEBBLE_COUNT; pebble++) {
    const centreColumn = random() * DIRT_SIZE;
    const centreRow = random() * DIRT_SIZE;
    const radius = Math.max(draw(random, PEBBLE_RADIUS) / cellMetres, Math.SQRT1_2);
    const level = (random() < 0.5 ? -1 : 1) * draw(random, PEBBLE_LEVELS);
    const reach = Math.ceil(radius);
    for (let row = Math.max(0, Math.floor(centreRow) - reach); row <= Math.min(DIRT_SIZE - 1, Math.floor(centreRow) + reach); row++) {
      for (let column = Math.max(0, Math.floor(centreColumn) - reach); column <= Math.min(DIRT_SIZE - 1, Math.floor(centreColumn) + reach); column++) {
        if (hypot2(column + 0.5 - centreColumn, row + 0.5 - centreRow) <= radius) pebbles[row * DIRT_SIZE + column] = level;
      }
    }
  }
  return pebbles;
}

/** A level with its darkness below the base grey kept as is up to `DIRT_DARKNESS_KNEE` and squeezed under `DIRT_DARKNESS_CEILING` beyond it; lighter levels pass through. */
function squeezeDarkness(level: number): number {
  const darkness = 1 - level / DIRT_BASE_GREY;
  if (darkness <= DIRT_DARKNESS_KNEE) return level;
  const room = DIRT_DARKNESS_CEILING - DIRT_DARKNESS_KNEE;
  return DIRT_BASE_GREY * (1 - DIRT_DARKNESS_KNEE - room * (1 - Math.exp(-(darkness - DIRT_DARKNESS_KNEE) / room)));
}

/** Heavily driven pale dirt in grey: blotches, damp and dry patches, clods, grit, pebbles, and the lanes, ruts, ridges and tread of `DIRT_TRACK_PATHS`. */
export function makeDirtTexture() {
  const random = makeSeededRandom(DIRT_SEED);
  const tracks = paintTracks(DIRT_TRACK_PATHS);
  const fine = makeFineGrids(random, tracks);
  const pebbles = scatterPebbles();
  return makeTexture(
    DIRT_SIZE,
    DIRT_SIZE,
    (column, row) => {
      const u = (column + 0.5) / DIRT_SIZE;
      const v = (row + 0.5) / DIRT_SIZE;
      const index = row * DIRT_SIZE + column;
      const grit = (random() - 0.5) * DIRT_GRIT_SPREAD;
      const level = squeezeDarkness((sampleField(fine.add, RUT_GRID, u, v) + grit) * sampleField(fine.scale, RUT_GRID, u, v) * (1 - tracks.tread[index] * TRACK_TREAD_DARKEN) + pebbles[index]);
      return [level, level, level];
    },
    TEXTURE_WRAP.clamp,
  );
}
