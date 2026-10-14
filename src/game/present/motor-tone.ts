import { REV_IDLE, VEHICLE_CLASS_IDS, type DamageStage, type VehicleClassId } from "../vehicle/vehicle-classes.ts";

/** Share of the gas that revs a standing or airborne car above idle (`motorRev`): the gauge's fake revs know only speed. */
const FREE_REV_SHARE = 0.35;
/** Forward acceleration (m/s²) that reads as full load on a car with no pedal (a netplay client's cars carry no `drive`). */
const LOAD_ACCEL = 4;
/** Slow-mo pitches the engines down by the presented-time rate, but no lower than this share of their pitch. */
const SLOWMO_PITCH_FLOOR = 0.25;
/**
 * The three generator channels summed (class tilt applied) swing up to +-9 (the noise in them varies run to run) and sit at an RMS
 * of 0.7-2.1; full scale is 1, and the demo's own master slider is 10%. This scales the sum so the loudest moment of any class,
 * stage or rev stays under -6 dBFS (10 x 0.05) and a redline peaks near -12 dBFS (`motor-level.test.ts` measures both through the
 * real worklet). The sum is never clipped.
 */
export const MOTOR_OUTPUT_GAIN = 0.05;
/** Seconds a dead or stalled engine takes to wind down to rpm 0. */
export const DIE_DOWN_S = 0.8;

/** The engine sound's credit (MIT licence): the credits dialog shows it. The same licence text ships in `kernels/motor/LICENSE`. */
export const MOTOR_SOUND_CREDIT = {
  name: "engine-sound-generator",
  author: "Antonio-R1",
  url: "https://github.com/Antonio-R1/engine-sound-generator",
  license: "MIT",
  licenseUrl: "https://github.com/Antonio-R1/engine-sound-generator/blob/main/LICENSE",
  notice: "Copyright (c) 2021-2022 Antonio-R1",
} as const;

/** The generator's waveguide lengths are in samples at this rate (the upstream demo's); other rates scale them. */
const TONE_SAMPLE_RATE = 44100;
/** Reflection factors the generator's demo uses for every class: open ends reflect little, closed ends nearly all. */
const OPEN_REFLECTION = 0.01;
const CLOSED_REFLECTION = 0.95;

/** One class's engine: the generator's parameters (lengths in samples at `TONE_SAMPLE_RATE`), its rpm range and its channel mix. */
interface ClassTone {
  cylinders: number;
  idleRpm: number;
  redlineRpm: number;
  intake: number;
  exhaust: number;
  extractor: number;
  ignition: number;
  straightPipe: number;
  mufflers: readonly number[];
  action: number;
  outlet: number;
  /** Intake, engine block and outlet channel levels (before `MOTOR_OUTPUT_GAIN`). */
  gains: readonly [number, number, number];
}

/** The upstream demo's defaults (sounds_worklet_wasm.htm, its "muscle-y, beefy" setup; lengths in samples): what every class is a factor of. */
const BASELINE = {
  cylinders: 4,
  intake: 100,
  exhaust: 100,
  extractor: 100,
  ignition: 0.016,
  straightPipe: 128,
  mufflers: [10, 15, 20, 25],
  action: 0.1,
  outlet: 5,
  channelGain: 1,
} as const;

/** One class as factors on `BASELINE` (1 = the demo's value) and the rpm range, which the demo leaves to a slider. */
interface ClassFactors {
  idleRpm: number;
  redlineRpm: number;
  cylinders: number;
  intake: number;
  exhaust: number;
  extractor: number;
  ignition: number;
  straightPipe: number;
  mufflers: number;
  action: number;
  outlet: number;
  gains: readonly [number, number, number];
}

/** The class table: sedan a bit lighter, police near the demo, muscle a bit beefier, truck and monster deeper (longer pipes, slower ignition). */
const CLASS_FACTORS: Readonly<Record<VehicleClassId, ClassFactors>> = {
  sedan: { idleRpm: 850, redlineRpm: 6800, cylinders: 1, intake: 0.9, exhaust: 0.9, extractor: 0.9, ignition: 0.9, straightPipe: 0.85, mufflers: 0.9, action: 0.9, outlet: 0.8, gains: [1.1, 0.8, 0.9] },
  police: { idleRpm: 800, redlineRpm: 7000, cylinders: 1, intake: 0.95, exhaust: 1, extractor: 1.05, ignition: 0.95, straightPipe: 1.05, mufflers: 1, action: 1, outlet: 1, gains: [1.05, 1, 1] },
  muscle: { idleRpm: 700, redlineRpm: 6200, cylinders: 1, intake: 1.05, exhaust: 1.1, extractor: 1.1, ignition: 1.1, straightPipe: 1.2, mufflers: 1.1, action: 1.1, outlet: 1.2, gains: [0.9, 1.1, 1.1] },
  truck: { idleRpm: 650, redlineRpm: 5000, cylinders: 1, intake: 1.2, exhaust: 1.25, extractor: 1.2, ignition: 1.25, straightPipe: 1.5, mufflers: 1.3, action: 0.85, outlet: 1.6, gains: [0.8, 1.2, 1] },
  monster: { idleRpm: 600, redlineRpm: 5500, cylinders: 1.5, intake: 1.3, exhaust: 1.4, extractor: 1.3, ignition: 1.4, straightPipe: 1.8, mufflers: 1.5, action: 1.2, outlet: 2, gains: [0.8, 1.3, 1.1] },
};

/** A class's generator parameters: the baseline times its factors. Cylinders round to a whole engine. */
function tone(f: ClassFactors): ClassTone {
  const b = BASELINE;
  return {
    cylinders: Math.round(b.cylinders * f.cylinders),
    idleRpm: f.idleRpm,
    redlineRpm: f.redlineRpm,
    intake: b.intake * f.intake,
    exhaust: b.exhaust * f.exhaust,
    extractor: b.extractor * f.extractor,
    ignition: b.ignition * f.ignition,
    straightPipe: b.straightPipe * f.straightPipe,
    mufflers: b.mufflers.map((m) => m * f.mufflers),
    action: b.action * f.action,
    outlet: b.outlet * f.outlet,
    gains: [b.channelGain * f.gains[0], b.channelGain * f.gains[1], b.channelGain * f.gains[2]],
  };
}

const CLASS_TONE: Readonly<Record<VehicleClassId, ClassTone>> = {
  sedan: tone(CLASS_FACTORS.sedan),
  police: tone(CLASS_FACTORS.police),
  muscle: tone(CLASS_FACTORS.muscle),
  truck: tone(CLASS_FACTORS.truck),
  monster: tone(CLASS_FACTORS.monster),
};

/**
 * What a damage stage does to the sound, as offsets on top of the class: misfires per second, rpm jitter (share), the muffling
 * lowpass (Hz), the ignition-time and muffler-action multipliers, and which of the `TONE_STAGES` generator tunings it plays (a dented
 * engine sounds like a healthy one: no re-tune, no click).
 */
interface DamageTone {
  misfirePerS: number;
  rpmJitter: number;
  cutoffHz: number;
  ignitionScale: number;
  actionScale: number;
  toneIndex: number;
}

/** A healthy engine is clean; a dead one is never heard (it winds down to silence), its row only keeps the table total. */
const DAMAGE_TONE: Readonly<Record<DamageStage, DamageTone>> = {
  healthy: { misfirePerS: 0, rpmJitter: 0, cutoffHz: 20000, ignitionScale: 1, actionScale: 1, toneIndex: 0 },
  dented: { misfirePerS: 0, rpmJitter: 0, cutoffHz: 20000, ignitionScale: 1, actionScale: 1, toneIndex: 0 },
  damaged: { misfirePerS: 0.6, rpmJitter: 0.02, cutoffHz: 9000, ignitionScale: 1.25, actionScale: 0.8, toneIndex: 1 },
  limping: { misfirePerS: 3, rpmJitter: 0.06, cutoffHz: 3500, ignitionScale: 1.6, actionScale: 0.6, toneIndex: 2 },
  dead: { misfirePerS: 0, rpmJitter: 0, cutoffHz: 3500, ignitionScale: 1.6, actionScale: 0.6, toneIndex: 2 },
};

/** The stage each generator tuning (`DamageTone.toneIndex`) is built from. */
const TONE_STAGES: readonly DamageStage[] = ["healthy", "damaged", "limping"];
/** How many tunings a class has: `toneMessages` holds `class index * TONE_STAGES.length + toneIndex`. */
export const TONE_COUNT = TONE_STAGES.length;

/** The generator's `processorOptions` (camelCase), lengths scaled to the context's sample rate. */
export interface ToneOptions {
  cylinders: number;
  intakeWaveguideLength: number;
  exhaustWaveguideLength: number;
  extractorWaveguideLength: number;
  intakeOpenReflectionFactor: number;
  intakeClosedReflectionFactor: number;
  exhaustOpenReflectionFactor: number;
  exhaustClosedReflectionFactor: number;
  ignitionTime: number;
  straightPipeWaveguideLength: number;
  straightPipeReflectionFactor: number;
  mufflerElementsLength: number[];
  action: number;
  outletWaveguideLength: number;
  outletReflectionFactor: number;
}

/** The generator's port message (snake_case): the same parameters. The worklet keeps one generator per message (keyed by its JSON, so keep the key order), and a re-tune swaps it in. */
export interface ToneMessage {
  cylinder_count: number;
  intake_waveguide_length: number;
  exhaust_waveguide_length: number;
  extractor_waveguide_length: number;
  intake_open_reflection_factor: number;
  intake_closed_reflection_factor: number;
  exhaust_open_reflection_factor: number;
  exhaust_closed_reflection_factor: number;
  ignition_time: number;
  straight_pipe_waveguide_length: number;
  straight_pipe_reflection_factor: number;
  muffler_elements_length: number[];
  action: number;
  outlet_waveguide_length: number;
  outlet_reflection_factor: number;
}

export function damageTone(stage: DamageStage): DamageTone {
  return DAMAGE_TONE[stage];
}

/** Revs 0-1 of the dial: the gauge's, lifted by the gas so a standing or airborne car still revs. */
export function motorRev(gaugeRev: number, load: number): number {
  return Math.max(gaugeRev, REV_IDLE + FREE_REV_SHARE * load);
}

/** A car's forward acceleration (m/s²) as load 0-1, from two samples of its speed along its heading `dt` apart. */
export function accelLoad(along: number, prevAlong: number, dt: number): number {
  return Math.min(1, Math.max(0, (along - prevAlong) / dt / LOAD_ACCEL));
}

/** Engine load 0-1: the boost's thrust (`drive.boostK`, 0-1) if it is more than the pedal (reverse too), else how hard the car is being accelerated. */
export function motorLoad(throttle: number, boost: number, accel: number): number {
  return Math.max(boost, Math.abs(throttle), accel);
}

/** Real engine rpm for the generator: the class's idle at `REV_IDLE` up to its redline at 1, pitched down by slow-mo's `rate`. */
export function motorRpm(cls: VehicleClassId, rev: number, rate: number): number {
  const tone = CLASS_TONE[cls];
  const rpm = tone.idleRpm + ((tone.redlineRpm - tone.idleRpm) * (rev - REV_IDLE)) / (1 - REV_IDLE);
  return rpm * Math.max(SLOWMO_PITCH_FLOOR, rate);
}

/** Writes the class's intake, engine-block and outlet levels into `out[0..2]`: the demo's 100% each, tilted per class. Set once per tuning, ahead of `MOTOR_OUTPUT_GAIN`. */
export function channelGains(out: Float64Array, cls: VehicleClassId): void {
  const gains = CLASS_TONE[cls].gains;
  out[0] = gains[0];
  out[1] = gains[1];
  out[2] = gains[2];
}

function samples(length: number, sampleRate: number): number {
  return Math.max(1, Math.round((length * sampleRate) / TONE_SAMPLE_RATE));
}

/** The class's `processorOptions` for a context at `sampleRate`. Built once per class at unlock. */
export function toneOptions(cls: VehicleClassId, sampleRate: number): ToneOptions {
  const t = CLASS_TONE[cls];
  return {
    cylinders: t.cylinders,
    intakeWaveguideLength: samples(t.intake, sampleRate),
    exhaustWaveguideLength: samples(t.exhaust, sampleRate),
    extractorWaveguideLength: samples(t.extractor, sampleRate),
    intakeOpenReflectionFactor: OPEN_REFLECTION,
    intakeClosedReflectionFactor: CLOSED_REFLECTION,
    exhaustOpenReflectionFactor: OPEN_REFLECTION,
    exhaustClosedReflectionFactor: CLOSED_REFLECTION,
    ignitionTime: t.ignition,
    straightPipeWaveguideLength: samples(t.straightPipe, sampleRate),
    straightPipeReflectionFactor: OPEN_REFLECTION,
    mufflerElementsLength: t.mufflers.map((m) => samples(m, sampleRate)),
    action: t.action,
    outletWaveguideLength: samples(t.outlet, sampleRate),
    outletReflectionFactor: OPEN_REFLECTION,
  };
}

/** The port message that retunes a voice to the class at the damage stage (a worn engine fires slower). Built once per pair at unlock. */
export function toneMessage(cls: VehicleClassId, stage: DamageStage, sampleRate: number): ToneMessage {
  const t = CLASS_TONE[cls];
  return {
    cylinder_count: t.cylinders,
    intake_waveguide_length: samples(t.intake, sampleRate),
    exhaust_waveguide_length: samples(t.exhaust, sampleRate),
    extractor_waveguide_length: samples(t.extractor, sampleRate),
    intake_open_reflection_factor: OPEN_REFLECTION,
    intake_closed_reflection_factor: CLOSED_REFLECTION,
    exhaust_open_reflection_factor: OPEN_REFLECTION,
    exhaust_closed_reflection_factor: CLOSED_REFLECTION,
    ignition_time: t.ignition * DAMAGE_TONE[stage].ignitionScale,
    straight_pipe_waveguide_length: samples(t.straightPipe, sampleRate),
    straight_pipe_reflection_factor: OPEN_REFLECTION,
    muffler_elements_length: t.mufflers.map((m) => samples(m, sampleRate)),
    action: t.action * DAMAGE_TONE[stage].actionScale,
    outlet_waveguide_length: samples(t.outlet, sampleRate),
    outlet_reflection_factor: OPEN_REFLECTION,
  };
}

/** Every tuning message, built once at unlock: index `class index (VEHICLE_CLASS_IDS) * TONE_COUNT + DamageTone.toneIndex`. */
export function toneMessages(sampleRate: number): ToneMessage[] {
  const messages: ToneMessage[] = [];
  for (const cls of VEHICLE_CLASS_IDS) {
    for (const stage of TONE_STAGES) messages.push(toneMessage(cls, stage, sampleRate));
  }
  return messages;
}
