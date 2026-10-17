import * as THREE from "three";
import { once } from "../kernel/scalar.ts";

/**
 * The procedural car finish: waviness, orange peel and metal flake on the paint, a grain on the bumper trim. Two tileable
 * height maps built in code (no canvas, no `Math.random`), sampled in the fragment shader by the object-space position in
 * three planes (the body, lids, doors and torn panels share no uv set, and the shells have none), turned into a normal by
 * screen-space derivatives. Which materials draw it follows the FX tier (`finishForTier`, `applyCarFinish`).
 */

type FinishTierName = "off" | "minimal" | "low" | "high" | "ultra";

const FINISH_TIERS: readonly FinishTierName[] = ["high", "ultra"];

/** Whether an FX tier draws the finish: `high` and `ultra` do; `low`, `minimal` and `off` draw today's plain paint. */
export function finishForTier(tier: FinishTierName): boolean {
  return FINISH_TIERS.includes(tier);
}

// --- the maps ----------------------------------------------------------------------------------------------------------

/** Paint finish map edge (texels): 256 keeps the 3 heights at 0.47 mm a texel over `GRAIN_TILE_M`, 256 kB with its mips. */
const PAINT_MAP_SIZE = 256;
/** Trim grain map edge (texels): one channel at 0.6 mm a texel over `TRIM_TILE_M`; a stipple needs no more. */
const TRIM_MAP_SIZE = 128;
/** Anisotropic filtering on both maps: a flank is seen at a grazing angle, where plain trilinear blurs the relief away. Three clamps it to the GPU's limit. */
const MAP_ANISOTROPY = 8;

/** One layer of value noise: `cells` lattice cells across the tile, each added at `weight`. */
type NoiseOctave = { readonly cells: number; readonly weight: number };

/** Broad panel waviness (R): 2 cells across the broad tile is a 1.2 m wavelength (a door or a fender in one swell), a 4-cell octave under it at a third of the weight. The first shots at 4 and 8 cells (0.3 and 0.15 m) crinkled instead of bending the reflection. Tuned from shots. */
const WAVE_OCTAVES: readonly NoiseOctave[] = [
  { cells: 2, weight: 1 },
  { cells: 4, weight: 0.35 },
];
/** Orange peel (G): 8 cells across the grain tile is a 15 mm wavelength (the real peel is 1 to 5 mm, drawn larger so it survives the pixel size at game distances), a 16-cell octave breaks the regularity. Starting values, tuned from shots. */
const PEEL_OCTAVES: readonly NoiseOctave[] = [
  { cells: 8, weight: 1 },
  { cells: 16, weight: 0.45 },
];
/** Metal flake (B): texels per flake edge; each flake is one flat facet tilted at random, so its edge is a hard step in the height. 4 texels is 1.9 mm, the size flake shows at in a close shot. */
const FLAKE_CELL_TEXELS = 4;
/** Rubber grain (trim): 32 cells across the trim tile is a 5 mm stipple, a 64-cell octave under it. Starting values, tuned from shots. */
const TRIM_GRAIN_OCTAVES: readonly NoiseOctave[] = [
  { cells: 32, weight: 1 },
  { cells: 64, weight: 0.5 },
];

/** Lattice seeds: any distinct integers; fixed, so every build of a map is byte-identical (netplay peers and every run draw the same paint). */
const SEED_WAVE = 11;
const SEED_PEEL = 23;
const SEED_FLAKE_TILT_X = 37;
const SEED_FLAKE_TILT_Y = 41;
const SEED_TRIM_GRAIN = 53;

/** The three lattice hash multipliers and the avalanche constants of murmur3's 32-bit finaliser: integer arithmetic only, so every JS engine gives the same bits. */
const HASH_X = 0x27d4eb2d;
const HASH_Y = 0x165667b1;
const HASH_SEED = 0x9e3779b1;
const MIX_FIRST = 0x85ebca6b;
const MIX_SECOND = 0xc2b2ae35;
const MIX_SHIFT_FIRST = 15;
const MIX_SHIFT_SECOND = 13;
const MIX_SHIFT_LAST = 16;
const UINT32_RANGE = 0x100000000;

/** Lattice point (x, y) of `seed`'s noise, 0 up to (not including) 1. */
function latticeValue(x: number, y: number, seed: number): number {
  let h = Math.imul(x, HASH_X) ^ Math.imul(y, HASH_Y) ^ Math.imul(seed, HASH_SEED);
  h = Math.imul(h ^ (h >>> MIX_SHIFT_FIRST), MIX_FIRST);
  h = Math.imul(h ^ (h >>> MIX_SHIFT_SECOND), MIX_SECOND);
  h ^= h >>> MIX_SHIFT_LAST;
  return (h >>> 0) / UINT32_RANGE;
}

/** Perlin's quintic ease: flat derivative at every lattice point, so the noise shows no grid. */
function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise at (u, v) in the unit torus, `cells` cells across: the lattice wraps, so the map tiles. 0 up to 1. */
function valueNoise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const easeX = quintic(x - cellX);
  const easeY = quintic(y - cellY);
  const x1 = (cellX + 1) % cells;
  const y1 = (cellY + 1) % cells;
  const top = latticeValue(cellX, cellY, seed) + (latticeValue(x1, cellY, seed) - latticeValue(cellX, cellY, seed)) * easeX;
  const bottom = latticeValue(cellX, y1, seed) + (latticeValue(x1, y1, seed) - latticeValue(cellX, y1, seed)) * easeX;
  return top + (bottom - top) * easeY;
}

function octaveNoise(u: number, v: number, octaves: readonly NoiseOctave[], seed: number): number {
  let sum = 0;
  for (const octave of octaves) sum += valueNoise(u, v, octave.cells, seed) * octave.weight;
  return sum;
}

/** One flake: a plane through the cell's middle tilted at random in x and y, so a texel's height is its place on that plane. */
function flakeHeight(u: number, v: number, cellsAcross: number): number {
  const x = u * cellsAcross;
  const y = v * cellsAcross;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const tiltX = latticeValue(cellX, cellY, SEED_FLAKE_TILT_X) - 0.5;
  const tiltY = latticeValue(cellX, cellY, SEED_FLAKE_TILT_Y) - 0.5;
  return tiltX * (x - cellX - 0.5) + tiltY * (y - cellY - 0.5);
}

/** An 8-bit texel channel's top value: the normalised heights are stretched onto 0..255. */
const BYTE_MAX = 255;

/** `heights` stretched so its lowest is 0 and its highest 255, written into channel `channel` of every `channels`-wide texel of `texels`. */
function writeNormalisedChannel(texels: Uint8Array, heights: Float64Array, channel: number, channels: number): void {
  let lowest = Infinity;
  let highest = -Infinity;
  for (const height of heights) {
    lowest = Math.min(lowest, height);
    highest = Math.max(highest, height);
  }
  const span = highest - lowest;
  for (let i = 0; i < heights.length; i++) texels[i * channels + channel] = Math.round(((heights[i]! - lowest) / span) * BYTE_MAX);
}

/** The height of every texel of a `size` x `size` map, `heightAt` given the texel's centre in the unit torus. */
function sampleMap(size: number, heightAt: (u: number, v: number) => number): Float64Array {
  const heights = new Float64Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) heights[y * size + x] = heightAt((x + 0.5) / size, (y + 0.5) / size);
  return heights;
}

function tiledMap(texels: Uint8Array, size: number, format: THREE.PixelFormat): THREE.DataTexture {
  const texture = new THREE.DataTexture(texels, size, size, format);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = MAP_ANISOTROPY;
  texture.userData.shared = true;
  texture.needsUpdate = true;
  return texture;
}

/** The paint map is RGBA8: waviness, peel and flake heights in R, G, B and an opaque alpha. */
const PAINT_CHANNELS = 4;
const CHANNEL_WAVE = 0;
const CHANNEL_PEEL = 1;
const CHANNEL_FLAKE = 2;
const CHANNEL_ALPHA = 3;

/** Paint finish map: RGBA8, R broad waviness, G orange peel, B metal flake heights (0 low, 255 high), A opaque. Shared, never disposed. */
const paintFinishMap = once((): THREE.DataTexture => {
  const texels = new Uint8Array(PAINT_MAP_SIZE * PAINT_MAP_SIZE * PAINT_CHANNELS);
  const flakeCells = PAINT_MAP_SIZE / FLAKE_CELL_TEXELS;
  writeNormalisedChannel(texels, sampleMap(PAINT_MAP_SIZE, (u, v) => octaveNoise(u, v, WAVE_OCTAVES, SEED_WAVE)), CHANNEL_WAVE, PAINT_CHANNELS);
  writeNormalisedChannel(texels, sampleMap(PAINT_MAP_SIZE, (u, v) => octaveNoise(u, v, PEEL_OCTAVES, SEED_PEEL)), CHANNEL_PEEL, PAINT_CHANNELS);
  writeNormalisedChannel(texels, sampleMap(PAINT_MAP_SIZE, (u, v) => flakeHeight(u, v, flakeCells)), CHANNEL_FLAKE, PAINT_CHANNELS);
  for (let i = CHANNEL_ALPHA; i < texels.length; i += PAINT_CHANNELS) texels[i] = BYTE_MAX;
  return tiledMap(texels, PAINT_MAP_SIZE, THREE.RGBAFormat);
});

/** Trim grain map: one 8-bit height channel of stipple. Shared, never disposed. */
const trimGrainMap = once((): THREE.DataTexture => {
  const texels = new Uint8Array(TRIM_MAP_SIZE * TRIM_MAP_SIZE);
  writeNormalisedChannel(texels, sampleMap(TRIM_MAP_SIZE, (u, v) => octaveNoise(u, v, TRIM_GRAIN_OCTAVES, SEED_TRIM_GRAIN)), 0, 1);
  return tiledMap(texels, TRIM_MAP_SIZE, THREE.RedFormat);
});

// --- the shader --------------------------------------------------------------------------------------------------------

/** Edge (m) of one repeat of the broad waviness sample: 2.4 m holds two 1.2 m waves. Tuned from shots. */
const WAVE_TILE_M = 2.4;
/** Edge (m) of one repeat of the orange peel and flake sample: 0.12 m holds eight 15 mm peel waves. Starting value, tuned from shots. */
const GRAIN_TILE_M = 0.12;
/** Edge (m) of one repeat of the trim grain: 0.16 m holds thirty-two 5 mm stipple cells. Starting value, tuned from shots. */
const TRIM_TILE_M = 0.16;

/**
 * One multiplier on every layer's height below: 1 is the look as tuned from the first GPU shots, 0 is flat, 2 doubles the relief.
 * The knob to turn when a shot reads too weak or too strong; the layer figures keep their proportions.
 */
const FINISH_STRENGTH = 1;

/**
 * Peak-to-peak heights (m) of the three paint layers and of the trim grain, before `FINISH_STRENGTH`. Real figures: a stamped panel
 * waves about 0.5 mm over its width, orange peel stands about 10 um over a 1 to 5 mm wavelength, flake is a few um. The first shots
 * at 4.5 m showed the real-scale and 8x-scaled figures as flat plastic; the second, with the peel at 1.6 mm and the flake at 0.8 mm,
 * as sandpaper at 2.4 m and speckle at 9 m. Drawn now 26, 50, 15 and 15 times the real figures (waves 13 mm, peel 0.5 mm, flake
 * 0.15 mm, trim grain 0.6 mm; the waves were 20 mm until the lumpy side of the pickup and the monster truck showed it): the waves bend the
 * reflection across a door, the peel reads as a fine skin, the flake only twinkles
 * close. Tuned from shots.
 */
const WAVE_HEIGHT_M = 0.013 * FINISH_STRENGTH;
const PEEL_HEIGHT_M = 0.0005 * FINISH_STRENGTH;
const FLAKE_HEIGHT_M = 0.00015 * FINISH_STRENGTH;
const TRIM_GRAIN_HEIGHT_M = 0.0006 * FINISH_STRENGTH;

/**
 * View distances (m) over which each layer fades from full to nothing, so it is gone before it aliases: a pixel spans about
 * 0.9 mm a metre, so the 15 mm peel is 2 pixels a wave at 8 m and 1 pixel at 16 m, the 1.9 mm flake a pixel at 2 m; the 1.2 m wave
 * carries to 90 m. The second shots had the peel to 30 m and the flake to 8 m, which read as dirt at 9 m. Tuned from shots.
 */
const WAVE_FADE_START_M = 30;
const WAVE_FADE_END_M = 90;
const PEEL_FADE_START_M = 5;
const PEEL_FADE_END_M = 18;
const FLAKE_FADE_START_M = 1.5;
const FLAKE_FADE_END_M = 5;
const TRIM_FADE_START_M = 4;
const TRIM_FADE_END_M = 16;

/** The weight of each plane is |object normal| to this power, normalised: 4 keeps a plane's blend to the corners where two planes meet. */
const PLANE_BLEND_SHARPNESS = 4;

/** A number as a GLSL float literal. */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

/** The heights of the three layers (m; x waviness, y peel, z flake) at object-space point `p`, planes weighted by `w`, for the paint map. */
const PAINT_HEIGHTS = /* glsl */ `
vec3 finishTriplanar(vec3 p, vec3 w, float tileMetres) {
  vec3 q = p / tileMetres;
  return w.x * texture2D(finishMap, q.zy).rgb + w.y * texture2D(finishMap, q.xz).rgb + w.z * texture2D(finishMap, q.xy).rgb;
}
vec3 finishHeights(vec3 p, vec3 w) {
  vec3 broad = finishTriplanar(p, w, ${glslFloat(WAVE_TILE_M)});
  vec3 grain = finishTriplanar(p, w, ${glslFloat(GRAIN_TILE_M)});
  return (vec3(broad.r, grain.g, grain.b) - 0.5) * vec3(${glslFloat(WAVE_HEIGHT_M)}, ${glslFloat(PEEL_HEIGHT_M)}, ${glslFloat(FLAKE_HEIGHT_M)});
}
const vec3 finishFadeStart = vec3(${glslFloat(WAVE_FADE_START_M)}, ${glslFloat(PEEL_FADE_START_M)}, ${glslFloat(FLAKE_FADE_START_M)});
const vec3 finishFadeEnd = vec3(${glslFloat(WAVE_FADE_END_M)}, ${glslFloat(PEEL_FADE_END_M)}, ${glslFloat(FLAKE_FADE_END_M)});`;

/** The same three outputs for the trim: only the peel slot carries the grain. */
const TRIM_HEIGHTS = /* glsl */ `
vec3 finishHeights(vec3 p, vec3 w) {
  vec3 q = p / ${glslFloat(TRIM_TILE_M)};
  float grain = w.x * texture2D(finishMap, q.zy).r + w.y * texture2D(finishMap, q.xz).r + w.z * texture2D(finishMap, q.xy).r;
  return vec3(0.0, (grain - 0.5) * ${glslFloat(TRIM_GRAIN_HEIGHT_M)}, 0.0);
}
const vec3 finishFadeStart = vec3(${glslFloat(TRIM_FADE_START_M)});
const vec3 finishFadeEnd = vec3(${glslFloat(TRIM_FADE_END_M)});`;

/**
 * Mikkelsen's screen-space bump (three's `perturbNormalArb`, bump_pars_fragment) on `surfaceNormal` (view space): the height
 * slopes `heightSlope` are the height's steps over one pixel right and down. Unlike three's it does not normalise the surface
 * steps, so heights in metres give true slopes and the strength does not depend on the screen size.
 */
const FINISH_FUNCTIONS = /* glsl */ `
uniform sampler2D finishMap;
varying vec3 vFinishPos;
varying vec3 vFinishNormal;
vec3 finishPlaneWeights(vec3 objectSpaceNormal) {
  vec3 w = pow(abs(objectSpaceNormal), vec3(${glslFloat(PLANE_BLEND_SHARPNESS)}));
  return w / max(w.x + w.y + w.z, 0.0001);
}
vec3 finishPerturbedNormal(vec3 surfaceNormal, vec2 heightSlope, float faceDirection) {
  vec3 stepX = dFdx(-vViewPosition);
  vec3 stepY = dFdy(-vViewPosition);
  vec3 crossY = cross(stepY, surfaceNormal);
  vec3 crossX = cross(surfaceNormal, stepX);
  float determinant = dot(stepX, crossY) * faceDirection;
  vec3 surfaceGradient = sign(determinant) * (heightSlope.x * crossY + heightSlope.y * crossX);
  return normalize(abs(determinant) * surfaceNormal - surfaceGradient);
}`;

/**
 * After the clear coat's normal is declared: each layer's height step one pixel right and down (`dFdx` / `dFdy` of the triplanar
 * heights: one sample set a pixel, not three), faded by view distance, then the base layer's normal takes waviness, peel and
 * flake, and the clear coat's takes waviness and peel only (the peel lives in the clear coat; the flake sits under it).
 */
const FINISH_NORMALS = /* glsl */ `
{
  vec3 finishPoint = vFinishPos;
  vec3 finishWeights = finishPlaneWeights(normalize(vFinishNormal));
  vec3 finishHere = finishHeights(finishPoint, finishWeights);
  vec3 finishFade = 1.0 - smoothstep(finishFadeStart, finishFadeEnd, vec3(length(vViewPosition)));
  vec3 finishStepX = dFdx(finishHere) * finishFade;
  vec3 finishStepY = dFdy(finishHere) * finishFade;
  vec2 coatSlope = vec2(finishStepX.x + finishStepX.y, finishStepY.x + finishStepY.y);
  vec2 baseSlope = coatSlope + vec2(finishStepX.z, finishStepY.z);
  normal = finishPerturbedNormal(normal, baseSlope, faceDirection);`;

/** The clear coat's share of `FINISH_NORMALS`: only the paint has a clear coat. */
const FINISH_COAT_NORMAL = /* glsl */ `
  #ifdef USE_CLEARCOAT
  clearcoatNormal = finishPerturbedNormal(clearcoatNormal, coatSlope, faceDirection);
  #endif`;

/** What a car material has to say about the finish: switched on or off by `applyCarFinish`, read by its compile hook and program key. */
type CarFinishState = { on: boolean };

function isCarFinishState(value: unknown): value is CarFinishState {
  return typeof value === "object" && value !== null && "on" in value && typeof value.on === "boolean";
}

/**
 * Patch `material` to draw the finish when it is switched on (`applyCarFinish`): it starts off, compiling and keyed exactly as it
 * was. On, its program key gains `|finish-<kind>` after whatever key it had (so a spray applied later, which chains this key,
 * follows the switch) and its shader samples the `kind` map. Chains the earlier compile hook, like `applySpray`.
 */
export function applyFinish<T extends THREE.MeshStandardMaterial>(material: T, kind: "paint" | "trim"): T {
  const state: CarFinishState = { on: false };
  material.userData.carFinish = state;
  const previousHook = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    previousHook.call(material, shader, renderer);
    if (!state.on) return;
    shader.uniforms.finishMap = { value: kind === "paint" ? paintFinishMap() : trimGrainMap() };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFinishPos;\nvarying vec3 vFinishNormal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFinishPos = position;\nvFinishNormal = objectNormal;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FINISH_FUNCTIONS}${kind === "paint" ? PAINT_HEIGHTS : TRIM_HEIGHTS}`)
      .replace("#include <clearcoat_normal_fragment_maps>", `#include <clearcoat_normal_fragment_maps>\n${FINISH_NORMALS}${kind === "paint" ? FINISH_COAT_NORMAL : ""}\n}`);
  };
  material.customProgramCacheKey = () => (state.on ? `${previousKey.call(material)}|finish-${kind}` : previousKey.call(material));
  return material;
}

/**
 * Switch the finish on or off on every finish-capable material under `root`, marking a material for a rebuild only where its
 * state changes. True when any changed. The tier's choice (`finishForTier`) is stored on the materials themselves, never in a module.
 */
export function applyCarFinish(root: THREE.Object3D, enabled: boolean): boolean {
  let changed = false;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of [object.material].flat()) {
      const state: unknown = material.userData.carFinish;
      if (!isCarFinishState(state) || state.on === enabled) continue;
      state.on = enabled;
      material.needsUpdate = true;
      changed = true;
    }
  });
  return changed;
}
