import * as THREE from "three";
import { MAX_CARS } from "../scenes/fleet.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { carClass, carRpm, damageStage, VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";
import { approach } from "./audio-mix.ts";
import { easeLoad, engineLawGain } from "./engine-law.ts";
import { accelLoad, channelGains, damageTone, DIE_DOWN_S, MOTOR_OUTPUT_GAIN, motorLoad, motorRev, motorRpm, TONE_COUNT, toneMessages, toneOptions, type ToneMessage, type ToneOptions } from "./motor-tone.ts";
import { VoicePool } from "./motor-voices.ts";

const WORKLET_URL = `${import.meta.env?.BASE_URL ?? "/"}audio/motor-worklet.js`;
const PROCESSOR_NAME = "engine-sound-processor";
const FALLBACK_WAVE = "sawtooth";
const PANNING_MODEL = "equalpower";
const DISTANCE_MODEL = "inverse";
const FILTER_TYPE = "lowpass";
/** The engine voices' parameters update at this rate (positions every frame): a 1/30 s tick keeps `setTargetAtTime` events few. */
const AUDIO_TICK_S = 1 / 30;
/** A car farther than this (m) from the camera is never given a voice, unless it is the priority car. */
const VOICE_MAX_DISTANCE = 70;
/** A car that already holds a voice keeps it out to this (m): a car dithering around 70 m would otherwise swap its slot every few frames. */
const VOICE_KEEP_DISTANCE = 77;
/** Panner: full level inside 6 m (the chase camera sits about that far behind the player's car), `inverse` rolloff 2 beyond (a car 12 m out is -9.5 dB, 20 m -15 dB), silent past `VOICE_MAX_DISTANCE`. HRTF costs too much on phones. */
const REF_DISTANCE = 6;
const ROLLOFF_FACTOR = 2;
/** A slot that changes car fades its voice out this long (s) before the new car's tuning is posted. */
const SWAP_FADE_S = 0.12;
/** Time constant (s) of every voice parameter ramp. */
const PARAM_TAU_S = 0.05;
/** A misfire dips the voice gain to this share of its current level, for `MISFIRE_DIP_S`, then lets it back with `MISFIRE_RECOVER_TAU_S`. */
const MISFIRE_DIP_SHARE = 0.1;
const MISFIRE_DIP_S = 0.04;
const MISFIRE_RECOVER_TAU_S = 0.02;
/** The fallback sawtooth's gain: a unit saw has an RMS of 0.58, the generator's three channels sum to about 1.1, so the fallback is as loud as the real engine. */
const FALLBACK_LEVEL = 2;
/** A dead or stalled voice's gain and rpm ramp with this time constant: DIE_DOWN_S / 5 leaves 0.7% (-43 dB) when the rpm is cut to 0. */
const DIE_TAU_S = DIE_DOWN_S / 5;
/** Smoothing (s) of the acceleration-derived load, and of the player's engine level that ducks the music. */
const ACCEL_TAU_S = 0.15;
const PLAYER_LEVEL_TAU_S = 0.3;

/** One engine voice: the generator (or its oscillator fallback) through three channel gains, a fade gain and a damage lowpass into a panner. */
interface Voice {
  /** The worklet's port, null for the oscillator fallback. */
  port: MessagePort | null;
  /** The worklet's rpm, or the oscillator's frequency. */
  rpm: AudioParam;
  intake: GainNode;
  block: GainNode;
  outlet: GainNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  positional: THREE.PositionalAudio;
}

/** A lowpass filter at `hz`: the slow-mo bus filter and each voice's damage muffler. */
export function lowpass(context: AudioContext, hz: number): BiquadFilterNode {
  const filter = context.createBiquadFilter();
  filter.type = FILTER_TYPE;
  filter.frequency.value = hz;
  return filter;
}

/** A bandpass filter at `hz` with quality `q`: the crash hit's noise band and the tyre squeal. */
export function bandpass(context: AudioContext, hz: number, q: number): BiquadFilterNode {
  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = hz;
  filter.Q.value = q;
  return filter;
}

/**
 * The engine voices: a pool of `slots` voices that follow the priority car and its nearest neighbours (`VoicePool`). Each
 * runs the vendored engine-sound-generator worklet, tuned per vehicle class and damage stage, and is panned in 3D from the
 * camera's listener. Where there is no AudioWorklet (an insecure page) or it fails to load, each voice is a sawtooth
 * oscillator at the engine's firing frequency instead. Audio only reads the cars.
 */
export class MotorSound {
  /** The player's engine level (load x revs, smoothed, 0..1): the music ducks under it. */
  playerLevel = 0;
  /** Seconds the last parameter tick covered (valid when `update` returned true). */
  tickDt = 0;
  private readonly slots: number;
  private readonly pool: VoicePool;
  private readonly distSq = new Float64Array(MAX_CARS);
  private readonly gains = new Float64Array(3);
  /** Per slot: the car its voice voices (-1 none), seconds of fade-out left, the class and tone it is tuned to, its last speed along its heading, its smoothed acceleration load, seconds silenced. */
  private readonly voiced: Int32Array;
  private readonly fadeLeftS: Float64Array;
  private readonly classIndex: Int8Array;
  private readonly toneIndex: Int8Array;
  private readonly prevAlong: Float64Array;
  private readonly accel: Float64Array;
  private readonly silentS: Float64Array;
  /** Per slot: 1 while the fade gain is aimed at full, and 1 once a silenced voice's rpm was cut to 0. */
  private readonly gainOn: Uint8Array;
  private readonly rpmCut: Uint8Array;
  /** Per slot: 1 until its voice has driven a car since its last fade-out (the speed history then restarts, and no misfire dip hides the re-tune). */
  private readonly fresh: Uint8Array;
  /** Per slot: the load the engine law's loudness follows (the pedal's load eased quick-attack, slow-release, `easeLoad`), and seconds a misfire dip still holds the gain down. */
  private readonly lawLoad: Float64Array;
  private readonly dipS: Float64Array;
  /** True for the generator worklet (its output follows `naturalDb`), false for the flat oscillator fallback. */
  private worklet = true;
  private voices: Voice[] = [];
  private messages: ToneMessage[] = [];
  /** Oscillator fallback: firing Hz per rpm of each class (cylinders / 120); 0 for the worklet. */
  private hzPerRpm = new Float64Array(VEHICLE_CLASS_IDS.length);
  private context: AudioContext | null = null;
  private ready = false;
  private disposed = false;
  private tickS = 0;
  private levelTarget = 0;

  constructor(slots: number) {
    this.slots = slots;
    this.pool = new VoicePool(slots);
    this.voiced = new Int32Array(slots).fill(-1);
    this.fadeLeftS = new Float64Array(slots);
    this.classIndex = new Int8Array(slots).fill(-1);
    this.toneIndex = new Int8Array(slots).fill(-1);
    this.prevAlong = new Float64Array(slots);
    this.accel = new Float64Array(slots);
    this.silentS = new Float64Array(slots);
    this.gainOn = new Uint8Array(slots);
    this.rpmCut = new Uint8Array(slots);
    this.fresh = new Uint8Array(slots).fill(1);
    this.lawLoad = new Float64Array(slots);
    this.dipS = new Float64Array(slots);
  }

  /** Loads the worklet and builds the voices. `update` does nothing until this resolves. */
  async load(context: AudioContext, listener: THREE.AudioListener): Promise<void> {
    if (this.slots === 0) return;
    let worklet = true;
    try {
      if (!context.audioWorklet) throw new Error("no AudioWorklet (an insecure page has none)");
      await context.audioWorklet.addModule(WORKLET_URL);
    } catch (reason) {
      worklet = false;
      console.warn("motor sound: oscillator fallback", reason);
    }
    if (this.disposed) return;
    const options = VEHICLE_CLASS_IDS.map((cls) => toneOptions(cls, context.sampleRate));
    this.messages = toneMessages(context.sampleRate);
    this.worklet = worklet;
    for (let c = 0; c < options.length; c++) this.hzPerRpm[c] = worklet ? 1 : options[c]!.cylinders / 120;
    for (let s = 0; s < this.slots; s++) this.voices.push(this.buildVoice(context, listener, worklet ? options[0]! : null));
    this.context = context;
    this.ready = true;
  }

  /** The per-voice chain; `options` null builds the oscillator fallback. */
  private buildVoice(context: AudioContext, listener: THREE.AudioListener, options: ToneOptions | null): Voice {
    const intake = context.createGain();
    const block = context.createGain();
    const outlet = context.createGain();
    const gain = context.createGain();
    gain.gain.value = 0;
    const filter = lowpass(context, damageTone("healthy").cutoffHz);
    let port: MessagePort | null = null;
    let node: AudioWorkletNode | null = null;
    let rpm: AudioParam;
    if (options) {
      node = new AudioWorkletNode(context, PROCESSOR_NAME, { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [1, 1, 1], processorOptions: options });
      const param = node.parameters.get("rpm");
      if (!param) throw new Error(`${PROCESSOR_NAME} has no rpm parameter`);
      rpm = param;
      port = node.port;
      node.connect(intake, 0);
      node.connect(block, 1);
      node.connect(outlet, 2);
    } else {
      // A saw into the outlet channel; `FALLBACK_LEVEL` lifts its RMS to the worklet's (about 1.1 summed).
      const oscillator = context.createOscillator();
      oscillator.type = FALLBACK_WAVE;
      oscillator.frequency.value = 0;
      const level = context.createGain();
      level.gain.value = FALLBACK_LEVEL;
      oscillator.connect(level);
      level.connect(outlet);
      oscillator.start();
      rpm = oscillator.frequency;
    }
    // The three channels sum into the voice gain (`MOTOR_OUTPUT_GAIN`): the sum is scaled, never clipped.
    intake.connect(gain);
    block.connect(gain);
    outlet.connect(gain);
    gain.connect(filter);
    const positional = new THREE.PositionalAudio(listener);
    positional.setDistanceModel(DISTANCE_MODEL);
    positional.setRefDistance(REF_DISTANCE);
    positional.setRolloffFactor(ROLLOFF_FACTOR);
    positional.setMaxDistance(VOICE_MAX_DISTANCE);
    positional.panner.panningModel = PANNING_MODEL;
    positional.setNodeSource(filter);
    const voice: Voice = { port, rpm, intake, block, outlet, gain, filter, positional };
    const dead = node;
    if (dead) {
      // A processor that threw (an abort, a full heap) fires this on every render quantum: cut it off and stop posting to it.
      dead.onprocessorerror = () => {
        dead.disconnect();
        voice.port = null;
        console.warn("motor sound: a voice's processor failed; the voice is dropped");
      };
    }
    return voice;
  }

  /**
   * One audio frame: ranks the cars by distance from `camera` (the listener rides it; its matrix is current), seats them in
   * the pool, moves the voices, and every `AUDIO_TICK_S` retunes them. `rate` is the presented-time rate (slow-mo pitches the
   * engines down); `parked` holds every voice at rpm 0 (the engine volume is 0). Returns true on a tick frame.
   */
  update(dt: number, cars: readonly DeformableCar[], camera: THREE.Camera, priority: DeformableCar | null, rate: number, parked: boolean): boolean {
    const context = this.context;
    if (!this.ready || !context) return false;
    const e = camera.matrixWorld.elements;
    const lx = e[12]!;
    const ly = e[13]!;
    const lz = e[14]!;
    const n = Math.min(cars.length, MAX_CARS);
    let priorityIndex = -1;
    for (let i = 0; i < n; i++) {
      const car = cars[i]!;
      const isPriority = car === priority;
      if (isPriority) priorityIndex = i;
      const p = car.group.position;
      const d = (p.x - lx) * (p.x - lx) + (p.y - ly) * (p.y - ly) + (p.z - lz) * (p.z - lz);
      const range = this.pool.slotOf(i) >= 0 ? VOICE_KEEP_DISTANCE : VOICE_MAX_DISTANCE;
      const hearable = car.group.visible && !car.vaporized && (isPriority || (car.deform.drivetrainAlive && d <= range * range));
      this.distSq[i] = hearable ? d : Infinity;
    }
    this.pool.assign(this.distSq, n, priorityIndex, dt);
    for (let s = 0; s < this.slots; s++) {
      const v = this.voiced[s]!;
      if (v < 0 || v >= n) continue;
      const positional = this.voices[s]!.positional;
      positional.position.copy(cars[v]!.group.position);
      positional.updateMatrixWorld(true);
    }
    this.tickS += dt;
    if (this.tickS < AUDIO_TICK_S) return false;
    const tick = this.tickS;
    this.tickS = 0;
    this.tickDt = tick;
    const now = context.currentTime;
    this.levelTarget = 0;
    for (let s = 0; s < this.slots; s++) {
      if (this.pool.swapped[s]) {
        this.pool.swapped[s] = 0;
        if (this.voiced[s]! >= 0) this.fadeOut(s, now);
      }
      if (this.fadeLeftS[s]! > 0) {
        this.fadeLeftS[s]! -= tick;
        if (this.fadeLeftS[s]! > 0) continue;
        this.retire(s, now);
      }
      const want = this.pool.car[s]!;
      if (this.voiced[s]! < 0 && want >= 0 && want < n) this.voiced[s] = want;
      const v = this.voiced[s]!;
      if (v >= 0 && v < n) this.driveVoice(s, cars[v]!, v === priorityIndex, tick, rate, parked, now);
    }
    this.playerLevel = approach(this.playerLevel, this.levelTarget, tick, PLAYER_LEVEL_TAU_S);
    return true;
  }

  /** Aims the slot's fade gain at 0 and starts its fade-out clock. */
  private fadeOut(slot: number, now: number): void {
    this.voices[slot]!.gain.gain.setTargetAtTime(0, now, SWAP_FADE_S / 4);
    this.gainOn[slot] = 0;
    this.fadeLeftS[slot] = SWAP_FADE_S;
  }

  /** The fade-out is over: the voice is silent and free; it takes whichever car the pool holds in the slot next. It keeps its tuning, so a car of the same class and damage tone posts nothing. */
  private retire(slot: number, now: number): void {
    this.voiced[slot] = -1;
    this.fresh[slot] = 1;
    this.voices[slot]!.rpm.setValueAtTime(0, now);
    this.rpmCut[slot] = 1;
  }

  /**
   * Retunes one voice to its car at a tick: class and damage tuning and the class's channel levels (a re-tune swaps in the
   * voice's kept generator for that tuning, so it happens under a fade or a misfire dip), rpm from the gauge's revs lifted by the load, misfires. A dead,
   * stalled or parked engine winds down to silence.
   */
  private driveVoice(slot: number, car: DeformableCar, isPriority: boolean, tick: number, rate: number, parked: boolean, now: number): void {
    const voice = this.voices[slot]!;
    if (!car.deform.drivetrainAlive || car.stalledS > 0 || parked) {
      this.silentS[slot]! += tick;
      if (this.gainOn[slot]) {
        voice.gain.gain.setTargetAtTime(0, now, DIE_TAU_S);
        this.gainOn[slot] = 0;
      }
      if (this.silentS[slot]! < DIE_DOWN_S) {
        voice.rpm.setTargetAtTime(0, now, DIE_TAU_S);
      } else if (!this.rpmCut[slot]) {
        voice.rpm.setValueAtTime(0, now);
        this.rpmCut[slot] = 1;
      }
      return;
    }
    this.silentS[slot] = 0;
    this.rpmCut[slot] = 0;
    const cls = carClass(car);
    const classIndex = VEHICLE_CLASS_IDS.indexOf(cls);
    const damage = damageTone(damageStage(car));
    const fresh = this.fresh[slot] === 1;
    if (fresh) {
      this.fresh[slot] = 0;
      this.prevAlong[slot] = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
      this.accel[slot] = 0;
    }

    const along = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
    const accel = approach(this.accel[slot]!, accelLoad(along, this.prevAlong[slot]!, tick), tick, ACCEL_TAU_S);
    this.accel[slot] = accel;
    this.prevAlong[slot] = along;
    const load = motorLoad(car.drive.throttle, car.drive.boost, accel);
    const rev = motorRev(carRpm(car), load);
    // The engine law's loudness follows the eased load (quick attack, slower release): `level` is the voice gain it asks for.
    this.lawLoad[slot] = fresh ? load : easeLoad(this.lawLoad[slot]!, load, tick);
    const level = MOTOR_OUTPUT_GAIN * engineLawGain(cls, rev, this.lawLoad[slot]!, this.worklet);
    if (this.dipS[slot]! > 0) this.dipS[slot]! -= tick;
    if (classIndex !== this.classIndex[slot] || damage.toneIndex !== this.toneIndex[slot]) {
      this.classIndex[slot] = classIndex;
      this.toneIndex[slot] = damage.toneIndex;
      // A live voice re-tunes under a misfire dip, a fresh one (silent after a fade) needs none: the swap to another kept generator clicks, the dip hides it.
      if (!fresh) this.dip(voice, level, slot, now);
      voice.port?.postMessage(this.messages[classIndex * TONE_COUNT + damage.toneIndex]);
      voice.filter.frequency.setTargetAtTime(damage.cutoffHz, now, PARAM_TAU_S);
      channelGains(this.gains, cls);
      voice.intake.gain.setValueAtTime(this.gains[0]!, now);
      voice.block.gain.setValueAtTime(this.gains[1]!, now);
      voice.outlet.gain.setValueAtTime(this.gains[2]!, now);
    }
    if (!this.gainOn[slot]) {
      voice.gain.gain.setTargetAtTime(level, now, PARAM_TAU_S);
      this.gainOn[slot] = 1;
    } else if (damage.misfirePerS > 0 && Math.random() < damage.misfirePerS * tick) {
      this.dip(voice, level, slot, now);
    } else if (this.dipS[slot]! <= 0) {
      voice.gain.gain.setTargetAtTime(level, now, PARAM_TAU_S);
    }
    let rpm = motorRpm(cls, rev, rate);
    if (damage.rpmJitter > 0) rpm *= 1 + damage.rpmJitter * (2 * Math.random() - 1);
    voice.rpm.setTargetAtTime(rpm * this.hzPerRpm[classIndex]!, now, PARAM_TAU_S);
    if (isPriority) this.levelTarget = load * rev;
  }

  /** Dips the voice gain to `MISFIRE_DIP_SHARE` of `level` for `MISFIRE_DIP_S`, then lets it back; the per-tick level waits out the dip (`dipS`). */
  private dip(voice: Voice, level: number, slot: number, now: number): void {
    voice.gain.gain.setValueAtTime(MISFIRE_DIP_SHARE * level, now);
    voice.gain.gain.setTargetAtTime(level, now + MISFIRE_DIP_S, MISFIRE_RECOVER_TAU_S);
    this.dipS[slot] = MISFIRE_DIP_S;
  }

  /** A scene reset: every slot fades out and frees. */
  releaseVoices(): void {
    this.pool.release();
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    this.context = null;
    this.voices = [];
  }
}
