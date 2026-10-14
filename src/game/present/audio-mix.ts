/** The loudest the music slider goes, whatever the share link says (the bus sits a further `MUSIC_TRIM` under it). Engines must stay audible above it. */
export const MUSIC_MAX_GAIN = 0.6;
/** How far the player's engine at full load pulls the music down: x(1 - 0.35). */
const ENGINE_DUCK_DEPTH = 0.35;
/** A crash drops the music to this share, holds it for `CRASH_HOLD_S`, then lets it back with time constant `CRASH_RECOVER_TAU_S`. */
const CRASH_DUCK = 0.4;
const CRASH_HOLD_S = 0.3;
const CRASH_RECOVER_TAU_S = 0.5;
/** The slow-mo lowpass on the engine bus: closed to `SLOWMO_FLOOR_HZ` at standstill, open (20 kHz) at normal speed, following the square root of the rate. */
const SLOWMO_FLOOR_HZ = 700;
const SLOWMO_SPAN_HZ = 19300;

/**
 * The engine bus gain at a full slider: unity. A redline voice peaks near -12 dBFS at unity (`MOTOR_OUTPUT_GAIN`), so a full slider
 * is the loudest a lone engine gets before the master chain; the 0.25 default is x0.25 (-12 dB).
 */
const ENGINE_FULL_GAIN = 1;

/** The engine bus gain: the slider (0..1), linear to `ENGINE_FULL_GAIN`. */
export function engineBusGain(volume: number): number {
  return Math.min(1, Math.max(0, volume)) * ENGINE_FULL_GAIN;
}

/**
 * Master chain: a gentle glue compressor (2:1, wide soft knee, slow enough to keep transients), a peak limiter, then a ceiling that
 * no sample passes. A browser compressor adds its own make-up gain (about +3.6 dB for `MASTER_GLUE`), which `GLUE_TRIM` takes back
 * so the glue changes dynamics, not loudness.
 */
export const MASTER_GLUE = { threshold: -12, knee: 12, ratio: 2, attack: 0.02, release: 0.3 } as const;
export const GLUE_TRIM = 0.66;
export const MASTER_LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 } as const;
/** The output ceiling: -1 dBFS. */
export const CEILING = 10 ** (-1 / 20);
/** The ceiling curve is linear up to this share of the ceiling, then bends smoothly (tanh) onto it: no hard clip edge. */
const CEILING_KNEE = 0.8;

/**
 * The crash hit: a sine thump under a band of noise, through a short room. The noise sits low and dark (300 Hz, 0.5 s decay, soft
 * attack) so it blends with the engines and music instead of popping above them; the thump starts at 65 Hz where ordinary
 * speakers can play it. `busGain` is -3 dB from the old 0.6. The room is a decaying noise impulse (`roomS`, -60 dB at its end)
 * lowpassed at `roomDampHz`, sent back at `roomWet` into the master beside the dry hit.
 */
export const IMPACT = {
  busGain: 0.42,
  thumpStartHz: 65,
  thumpEndHz: 28,
  noiseHz: 300,
  noiseQ: 0.8,
  noiseAttackS: 0.012,
  noiseDecayS: 0.5,
  roomWet: 0.45,
  roomS: 1,
  roomDampHz: 1800,
} as const;

/**
 * The focus car's tyres (masterclass 22:48, 31:18, 32:30), both through the engine bus so the Engines slider, the pause fade and the slow-mo
 * lowpass carry them. Squeal: a looped noise through a bandpass (`bandQ`) centred `hzLow`..`hzHigh` by ground speed, wobbled `wobbleCents` at `wobbleHz`,
 * at up to `squealGain`; `fadeTau` s is the gain's time constant (95% in 3x: ~75 ms). It starts at `slideFrom` of `drive.slide` (full at
 * `slideTo`), `speedFrom`..`speedTo` m/s gates a slide by speed, and a locked brake or wheelspin squeal at `lockShare` / `spinShare` of their 0..1.
 * Thud: a sine `thudStartHz` -> `thudEndHz` over `thudS` plus a lowpassed noise burst (`noiseHz`, `noiseS`, `noiseShare` of the sine), at
 * `thudPerMs` per m/s of the fall, at most `thudMax`.
 */
export const TYRE = {
  squealGain: 0.06,
  hzLow: 1000,
  hzHigh: 2500,
  hzFullSpeed: 40,
  bandQ: 3,
  wobbleHz: 6,
  wobbleCents: 70,
  fadeTau: 0.025,
  slideFrom: 0.3,
  slideTo: 0.9,
  speedFrom: 2,
  speedTo: 8,
  lockShare: 0.8,
  spinShare: 0.8,
  thudStartHz: 60,
  thudEndHz: 35,
  thudS: 0.25,
  noiseHz: 400,
  noiseS: 0.12,
  noiseShare: 0.4,
  thudPerMs: 0.015,
  thudMax: 0.2,
} as const;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * The squeal's level (0..1) from the car's drive state: `slide` (drift or sideways slip, 0..1) past `slideFrom`, only at speed; `lock` (brakes
 * locked) and `spin` (wheelspin) as they come. The loudest of the three; none with a wheel off the ground.
 */
export function squealLevel(slide: number, lock: number, spin: number, speed: number, grounded: boolean): number {
  if (!grounded) return 0;
  const s = clamp01((slide - TYRE.slideFrom) / (TYRE.slideTo - TYRE.slideFrom)) * clamp01((speed - TYRE.speedFrom) / (TYRE.speedTo - TYRE.speedFrom));
  return clamp01(Math.max(s, TYRE.lockShare * lock, TYRE.spinShare * spin));
}

/** The squeal's bandpass centre (Hz): `hzLow` at a standstill to `hzHigh` at `hzFullSpeed` m/s of ground speed. */
export function squealHz(speed: number): number {
  return TYRE.hzLow + (TYRE.hzHigh - TYRE.hzLow) * clamp01(speed / TYRE.hzFullSpeed);
}

/** The landing thud's peak gain for a landing at `fall` m/s of vertical speed. */
export function thudGain(fall: number): number {
  return Math.min(TYRE.thudMax, Math.max(0, fall) * TYRE.thudPerMs);
}

/** The ceiling's WaveShaper curve over inputs -1..1 (`n` points): unity below the knee, never past `CEILING`. */
export function ceilingCurve(n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(n * 4));
  const k = CEILING * CEILING_KNEE;
  const span = CEILING - k;
  for (let i = 0; i < n; i++) {
    const x = (2 * i) / (n - 1) - 1;
    const a = Math.abs(x);
    out[i] = Math.sign(x) * (a <= k ? a : k + span * Math.tanh((a - k) / span));
  }
  return out;
}

/** NCS masters run hot (near 0 dBFS RMS on the loud sections), so the music bus sits 6 dB under its slider. */
const MUSIC_TRIM = 0.5;

/** The music bus gain: the slider, capped, trimmed, under the engine duck and the crash duck (each 0..1). */
export function musicGain(volume: number, engineDuck: number, crashDuck: number): number {
  return Math.min(MUSIC_MAX_GAIN, volume) * MUSIC_TRIM * engineDuck * crashDuck;
}

/** The music's duck for the player's engine at `playerLevel` (load x revs, 0..1). */
export function engineDuck(playerLevel: number): number {
  return 1 - ENGINE_DUCK_DEPTH * playerLevel;
}

/** The music's duck `sinceImpactS` seconds after a crash: down at once, held, then recovering. Infinity (no crash yet) is 1. */
export function crashDuck(sinceImpactS: number): number {
  if (sinceImpactS <= CRASH_HOLD_S) return CRASH_DUCK;
  return 1 - (1 - CRASH_DUCK) * Math.exp(-(sinceImpactS - CRASH_HOLD_S) / CRASH_RECOVER_TAU_S);
}

/** The engine bus lowpass cutoff (Hz) at the presented-time `rate` (1 = normal, clamped to 0..1). */
export function slowmoCutoff(rate: number): number {
  return SLOWMO_FLOOR_HZ + SLOWMO_SPAN_HZ * Math.sqrt(Math.min(1, Math.max(0, rate)));
}

/** `current` moved toward `target` by `dt` seconds of a first-order lag with time constant `tauS`. */
export function approach(current: number, target: number, dt: number, tauS: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tauS));
}
