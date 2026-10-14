import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";
import type { DamageStage, VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { channelGains, motorRpm, MOTOR_OUTPUT_GAIN, toneMessage, toneOptions } from "./motor-tone.ts";

/** Test harness: renders the shipped worklet block by block in node (no browser) and measures a voice's level at a rev and throttle. */
export const SAMPLE_RATE = 44100;
const BLOCK = 128;
const SETTLE_BLOCKS = 200;
const MEASURE_BLOCKS = 400;
const WORKLET = readFileSync(new URL("../../../public/audio/motor-worklet.js", import.meta.url), "utf8");
/**
 * The wasm generator seeds its noise from the wall clock in whole seconds (`__emscripten_date_now`), so a voice's peak moved with the second
 * the test ran in: over 480 seconds a police redline read 0.24-0.43 against the 0.4 band edge (1 in 480 over it, a red gate on a green tree;
 * over 2000 seconds the sedan reached 0.44 and the truck 0.41). The stub's clock stands still at the second whose peaks sit within 4 % of
 * their medians for all five classes (measured over those 480 seconds), so a level change moves a peak from the middle of the spread, and a run is the same as the last.
 */
const NOISE_CLOCK_MS = 1760002068 * 1000;

interface Processor {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  soundGenerator: unknown;
  process(inputs: unknown[], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
type ProcessorClass = new (options: { processorOptions: unknown }) => Processor;

/** Runs the shipped worklet file in a stub of an AudioWorkletGlobalScope: the real wasm synthesis, block by block. */
function loadProcessor(): { Processor: ProcessorClass; scope: { currentFrame: number } } {
  let registered: ProcessorClass | null = null;
  const scope = {
    AudioWorkletProcessor: class {
      port = { onmessage: null };
    },
    registerProcessor: (_name: string, processor: ProcessorClass) => {
      registered = processor;
    },
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    console,
    WebAssembly,
    TextDecoder,
    TextEncoder,
    setTimeout,
    performance,
    URL,
    Date: { now: () => NOISE_CLOCK_MS },
  };
  vm.createContext(scope);
  vm.runInContext(WORKLET, scope);
  if (!registered) throw new Error("the worklet registered no processor");
  return { Processor: registered, scope };
}

const { Processor, scope } = loadProcessor();

export interface Level {
  /** Peak and RMS of the voice's output (the class-tilted sum x `MOTOR_OUTPUT_GAIN`), 0..1 = full scale. */
  peak: number;
  rms: number;
}

/** One operating point to render: the dial's rev (0..1) and the worklet's throttle parameter (0..1). */
export interface Point {
  rev: number;
  throttle: number;
}

/** The voice output of `cls` tuned to `stage`, one `Level` per point (in order), after the settle time the generator needs. */
export async function voiceLevels(cls: VehicleClassId, stage: DamageStage, points: readonly Point[]): Promise<Level[]> {
  const processor = new Processor({ processorOptions: toneOptions(cls, SAMPLE_RATE) });
  const out = [[new Float32Array(BLOCK)], [new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
  const idle = { rpm: new Float32Array(BLOCK), throttle: new Float32Array(BLOCK) };
  // The wasm initialises asynchronously: the processor is silent and builds its generator on the first block after it.
  while (processor.soundGenerator === null) {
    await nextTurn();
    processor.process([], out, idle);
  }
  processor.port.onmessage?.({ data: toneMessage(cls, stage, SAMPLE_RATE) });
  const tilt = new Float64Array(3);
  channelGains(tilt, cls);
  const levels: Level[] = [];
  for (const point of points) {
    const parameters = { rpm: new Float32Array(BLOCK).fill(motorRpm(cls, point.rev, 1)), throttle: new Float32Array(BLOCK).fill(point.throttle) };
    let peak = 0;
    let squares = 0;
    for (let block = 0; block < SETTLE_BLOCKS + MEASURE_BLOCKS; block++) {
      scope.currentFrame += BLOCK;
      processor.process([], out, parameters);
      if (block < SETTLE_BLOCKS) continue;
      for (let i = 0; i < BLOCK; i++) {
        const sample = (out[0]![0]![i]! * tilt[0]! + out[1]![0]![i]! * tilt[1]! + out[2]![0]![i]! * tilt[2]!) * MOTOR_OUTPUT_GAIN;
        peak = Math.max(peak, Math.abs(sample));
        squares += sample * sample;
      }
    }
    levels.push({ peak, rms: Math.sqrt(squares / (MEASURE_BLOCKS * BLOCK)) });
  }
  return levels;
}
