import { detCos, detSin, hypot2 } from "../kernel/physics-core.js";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { DERBY_ARENA } from "./constants.ts";
import { TEXTURE_WRAP, makeSeededRandom, makeTexture, makeValueNoise, ramp } from "./derby-textures.ts";

/** Compacted dirt of the derby floor: a grey texture over the square `2 x (radius + 1)` m (the floor reaches one metre past the radius); column = +x, row = +z. */
const DIRT_SIZE = 1024;
export const DIRT_EXTENT = DERBY_ARENA.radius + 1;
const DIRT_METRES_PER_TEXEL = (2 * DIRT_EXTENT) / DIRT_SIZE;
const DIRT_SEED = 4117;
/** Pale warm dirt in grey (0-255, about 0.87 of white): the floor's vertex colour (tan) multiplies it. */
const DIRT_BASE_GREY = 222;
const DIRT_GRIT_SPREAD = 8;
/** Smooth layers: cells across the whole square (blotches 16 m, mottling 6 m, patches 2 m, clods 0.6 m) and their spread (channel levels). */
const DIRT_NOISE_LAYERS = [
  { cells: 5, spread: 30 },
  { cells: 13, spread: 22 },
  { cells: 40, spread: 14 },
  { cells: 130, spread: 12 },
] as const;
/** Pale dry and dark damp patches: noise cells across the square, the noise band they appear in, the share of the dirt they lighten or darken. */
const DIRT_DRY = { cells: 6, from: 0.62, to: 0.85, lift: 0.1 };
const DIRT_DAMP = { cells: 8, from: 0.6, to: 0.85, darken: 0.13 };

/** Wheel ruts 0.55 m wide, a pair `2 x CAR_HALF.x` apart, in a trodden lane 2.4 m wide whose pushed-up ridge (0.45 m) lies outside it. */
export const TRACK_RUT_WIDTH = 0.55;
export const TRACK_GAUGE = 2 * CAR_HALF.x;
export const TRACK_LANE_WIDTH = 2.4;
export const TRACK_RIDGE_WIDTH = 0.45;
const TRACK_RUT_HALF = TRACK_RUT_WIDTH / 2;
const TRACK_LANE_HALF = TRACK_LANE_WIDTH / 2;
/** Share of a half width (from the middle) that stays fully dark before the soft edge: the lane is softer than a rut. */
const TRACK_RUT_CORE_SHARE = 0.5;
const TRACK_LANE_CORE_SHARE = 0.15;
/** Share of the dirt a full-strength lane and a full-strength rut darken; the lift (channel levels) of the ridge. */
const TRACK_LANE_DARKEN = 0.26;
const TRACK_RUT_DARKEN = 0.45;
const TRACK_RIDGE_LIFT = 22;
/** Stamp spacing along a path (m): under one texel for the ruts; the soft lane is stamped every this many samples. */
const TRACK_STEP = 0.07;
const TRACK_LANE_EVERY = 3;
/** A track fades along its length: noise cells across the square, the noise band, the share left at the weakest; an open path fades over this share of its length at each end. */
const TRACK_FADE_CELLS = 12;
const TRACK_FADE_BAND = [0.38, 0.62] as const;
const TRACK_FADE_FLOOR = 0.25;
const TRACK_END_FADE = 0.08;
/** A path drifts sideways (its `wander`, m) this many cycles along its length. */
const TRACK_WANDER_CYCLES = 3;
const TRACK_PAIR_SIDES = [-1, 1] as const;
const FULL_TURN = 2 * Math.PI;

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
};

/** Flat-data driving lines (m, radians): five loops, arcs and one figure-eight of radius 8-26 m around the open bowl, two straight skid runs (`radiusX` is a line's half length). */
export const DIRT_TRACK_PATHS: readonly TrackPath[] = [
  { shape: "ellipse", x: 0, z: 0, radiusX: 26, radiusZ: 24, tilt: 0.4, startRadians: 0, sweepRadians: FULL_TURN, strength: 1, wander: 0.25 },
  { shape: "ellipse", x: -2, z: 3, radiusX: 18, radiusZ: 16, tilt: -0.3, startRadians: 0.9, sweepRadians: 3.6, strength: 0.9, wander: 0.2 },
  { shape: "ellipse", x: 3, z: -3, radiusX: 15, radiusZ: 13, tilt: 0, startRadians: 3.9, sweepRadians: 3, strength: 1, wander: 0.2 },
  { shape: "ellipse", x: -12, z: -12, radiusX: 9, radiusZ: 8, tilt: 0.8, startRadians: 0, sweepRadians: FULL_TURN, strength: 1, wander: 0.15 },
  { shape: "eight", x: 14, z: 12, radiusX: 12, radiusZ: 8, tilt: 0.9, startRadians: 0, sweepRadians: FULL_TURN, strength: 0.9, wander: 0.15 },
  { shape: "line", x: -20, z: -2, radiusX: 9, radiusZ: 0, tilt: 1.2, startRadians: 0, sweepRadians: 0, strength: 1, wander: 0.1 },
  { shape: "line", x: 20, z: -14, radiusX: 8, radiusZ: 0, tilt: 2.6, startRadians: 0, sweepRadians: 0, strength: 0.9, wander: 0.1 },
];

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

type TrackLayers = { lane: Float32Array; rut: Float32Array; ridge: Float32Array };

/** The texels within `reachMetres` of a world point, and the point's own position in texels. */
function texelWindow(worldX: number, worldZ: number, reachMetres: number) {
  const centreColumn = (worldX + DIRT_EXTENT) / DIRT_METRES_PER_TEXEL;
  const centreRow = (worldZ + DIRT_EXTENT) / DIRT_METRES_PER_TEXEL;
  const reach = Math.ceil(reachMetres / DIRT_METRES_PER_TEXEL);
  return {
    centreColumn,
    centreRow,
    firstColumn: Math.max(0, Math.floor(centreColumn) - reach),
    lastColumn: Math.min(DIRT_SIZE - 1, Math.floor(centreColumn) + reach),
    firstRow: Math.max(0, Math.floor(centreRow) - reach),
    lastRow: Math.min(DIRT_SIZE - 1, Math.floor(centreRow) + reach),
  };
}

/** The trodden lane and its pushed-up ridge around a centreline point, each keeping its strongest stamp. */
function stampLane(layers: TrackLayers, worldX: number, worldZ: number, strength: number): void {
  const reachMetres = TRACK_LANE_HALF + TRACK_RIDGE_WIDTH;
  const ridgePeak = TRACK_LANE_HALF + TRACK_RIDGE_WIDTH / 2;
  const window = texelWindow(worldX, worldZ, reachMetres);
  for (let row = window.firstRow; row <= window.lastRow; row++) {
    for (let column = window.firstColumn; column <= window.lastColumn; column++) {
      const distance = hypot2(column + 0.5 - window.centreColumn, row + 0.5 - window.centreRow) * DIRT_METRES_PER_TEXEL;
      if (distance > reachMetres) continue;
      const index = row * DIRT_SIZE + column;
      const lane = strength * (1 - ramp(TRACK_LANE_HALF * TRACK_LANE_CORE_SHARE, TRACK_LANE_HALF, distance));
      const ridge = strength * Math.max(0, 1 - Math.abs(distance - ridgePeak) / (TRACK_RIDGE_WIDTH / 2));
      if (lane > layers.lane[index]) layers.lane[index] = lane;
      if (ridge > layers.ridge[index]) layers.ridge[index] = ridge;
    }
  }
}

/** One wheel's rut around a world point, keeping its strongest stamp. */
function stampRut(layers: TrackLayers, worldX: number, worldZ: number, strength: number): void {
  const window = texelWindow(worldX, worldZ, TRACK_RUT_HALF);
  for (let row = window.firstRow; row <= window.lastRow; row++) {
    for (let column = window.firstColumn; column <= window.lastColumn; column++) {
      const distance = hypot2(column + 0.5 - window.centreColumn, row + 0.5 - window.centreRow) * DIRT_METRES_PER_TEXEL;
      if (distance > TRACK_RUT_HALF) continue;
      const index = row * DIRT_SIZE + column;
      const rut = strength * (1 - ramp(TRACK_RUT_HALF * TRACK_RUT_CORE_SHARE, TRACK_RUT_HALF, distance));
      if (rut > layers.rut[index]) layers.rut[index] = rut;
    }
  }
}

function pathMetres(path: TrackPath): number {
  if (path.shape === "line") return 2 * path.radiusX;
  return path.sweepRadians * Math.max(path.radiusX, path.shape === "eight" ? 2 * path.radiusZ : path.radiusZ);
}

/** The strength (0-1) of a path at a point of it: its own, faded by noise along the way and, for an open path, at both ends. */
function strengthAt(path: TrackPath, fraction: number, fadeNoise: number): number {
  const isOpen = path.shape === "line" || path.sweepRadians < FULL_TURN;
  const endFade = isOpen ? Math.min(ramp(0, TRACK_END_FADE, fraction), ramp(0, TRACK_END_FADE, 1 - fraction)) : 1;
  const noiseFade = TRACK_FADE_FLOOR + (1 - TRACK_FADE_FLOOR) * ramp(TRACK_FADE_BAND[0], TRACK_FADE_BAND[1], fadeNoise);
  return path.strength * endFade * noiseFade;
}

/** Every path as a lane with a pair of ruts `TRACK_GAUGE` apart, faded along its length by `fade`. */
function paintTracks(fade: (u: number, v: number) => number): TrackLayers {
  const texels = DIRT_SIZE * DIRT_SIZE;
  const layers = { lane: new Float32Array(texels), rut: new Float32Array(texels), ridge: new Float32Array(texels) };
  for (const path of DIRT_TRACK_PATHS) {
    const samples = Math.ceil(pathMetres(path) / TRACK_STEP);
    for (let sample = 0; sample <= samples; sample++) {
      const fraction = sample / samples;
      const point = pointOnPath(path, fraction);
      const fadeNoise = fade((point.x + DIRT_EXTENT) / (2 * DIRT_EXTENT), (point.z + DIRT_EXTENT) / (2 * DIRT_EXTENT));
      const strength = strengthAt(path, fraction, fadeNoise);
      if (sample % TRACK_LANE_EVERY === 0) stampLane(layers, point.x, point.z, strength);
      for (const side of TRACK_PAIR_SIDES) {
        stampRut(layers, point.x - point.headingZ * side * (TRACK_GAUGE / 2), point.z + point.headingX * side * (TRACK_GAUGE / 2), strength);
      }
    }
  }
  return layers;
}

/** Pale compacted dirt in grey: blotches, dry and damp patches, clods, fine grit and the lanes, ruts and ridges of `DIRT_TRACK_PATHS`. */
export function makeDirtTexture() {
  const random = makeSeededRandom(DIRT_SEED);
  const layers = DIRT_NOISE_LAYERS.map(({ cells, spread }) => ({ noise: makeValueNoise(random, cells, cells), spread }));
  const dry = makeValueNoise(random, DIRT_DRY.cells, DIRT_DRY.cells);
  const damp = makeValueNoise(random, DIRT_DAMP.cells, DIRT_DAMP.cells);
  const tracks = paintTracks(makeValueNoise(random, TRACK_FADE_CELLS, TRACK_FADE_CELLS));
  return makeTexture(
    DIRT_SIZE,
    DIRT_SIZE,
    (column, row) => {
      const u = (column + 0.5) / DIRT_SIZE;
      const v = (row + 0.5) / DIRT_SIZE;
      let level = DIRT_BASE_GREY + (random() - 0.5) * DIRT_GRIT_SPREAD;
      for (const layer of layers) level += (layer.noise(u, v) - 0.5) * layer.spread;
      level *= 1 + ramp(DIRT_DRY.from, DIRT_DRY.to, dry(u, v)) * DIRT_DRY.lift - ramp(DIRT_DAMP.from, DIRT_DAMP.to, damp(u, v)) * DIRT_DAMP.darken;
      const index = row * DIRT_SIZE + column;
      const lane = tracks.lane[index];
      level = level * (1 - lane * TRACK_LANE_DARKEN) * (1 - tracks.rut[index] * TRACK_RUT_DARKEN) + tracks.ridge[index] * (1 - lane) * TRACK_RIDGE_LIFT;
      return [level, level, level];
    },
    TEXTURE_WRAP.clamp,
  );
}
