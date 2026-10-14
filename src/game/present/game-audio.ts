import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { ceilingCurve, crashDuck, engineBusGain, engineDuck, GLUE_TRIM, IMPACT, MASTER_GLUE, MASTER_LIMITER, musicGain, slowmoCutoff } from "./audio-mix.ts";
import { bandpass, lowpass, MotorSound } from "./motor-sound.ts";
import { MusicPlayer } from "./music.ts";
import { musicBase } from "./music-manifest.ts";
import { TyreSound } from "./tyre-sound.ts";

const LATENCY_HINT = "interactive";
/** Time constant of the master gain ramp when audio is toggled. */
const MASTER_TAU_S = 0.05;
/** Time constant (s) of the engine bus's pause fade and of the slow-mo lowpass following the time rate. */
const BUS_TAU_S = 0.08;
/** The music's duck follows the engine fast enough to feel the throttle and a crash at once. */
const DUCK_TAU_S = 0.1;
const CRASH_DUCK_TAU_S = 0.02;
const THUMP_GAIN_PER_IMPULSE = 0.012;
/** `?voices=N` (0-8) overrides the engine voice count: the bench knob; 0 is no engine audio. */
const VOICES_PARAM = "voices";
const MAX_VOICES = 8;
/** Engine voices without the override: each is up to 38 waveguides of simple per-sample maths. The phone figure is calibrated (docs/TOOLCHAIN.md). */
const DESKTOP_VOICES = 6;
const PHONE_VOICES = 3;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** The engine voice count: the `?voices=` override, else by device (the same desktop flag as the lamp pool). */
function voiceSlots(desktop: boolean): number {
  const asked = Number.parseInt(new URLSearchParams(window.location.search).get(VOICES_PARAM) ?? "", 10);
  if (Number.isNaN(asked)) return desktop ? DESKTOP_VOICES : PHONE_VOICES;
  return Math.min(MAX_VOICES, Math.max(0, asked));
}

/**
 * The one audio façade: a single AudioContext, the three listener on the camera, and the busses
 *
 *   listener.gain -> engineBus -> slowmoFilter -> master -> glue -> trim -> limiter -> ceiling (-1 dBFS) -> destination
 *   tyre squeal and landing thud (the focus car) -> engineBus
 *   impact one-shots -> impactBus ------------/   (impactBus -> room convolver -> lowpass -> wet gain -> master)
 *   music -> musicBus ------------------------/
 *
 * Nothing is built until `unlock()` runs inside a user gesture. Audio is presentation: it reads the game, never writes it.
 */
export class GameAudio {
  readonly desktop: boolean;
  private readonly camera: THREE.PerspectiveCamera;
  private context: AudioContext | null = null;
  private listener: THREE.AudioListener | null = null;
  private master: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private slowmoFilter: BiquadFilterNode | null = null;
  private impactBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private motor: MotorSound | null = null;
  private tyres: TyreSound | null = null;
  private music: MusicPlayer | null = null;
  private on = false;
  /** Whether the game is running (not paused or held): a pause fades the engines out, the music plays on. */
  private live = true;
  /** Slider levels; the engine pushes the real ones with `setVolumes` right after construction. */
  private musicLevel = 0;
  private engineLevel = 0;
  /** Seconds since the last crash (the music's crash duck); Infinity before the first. */
  private sinceImpactS = Infinity;
  private readonly onVisibility = (): void => {
    const context = this.context;
    if (!context) return;
    if (document.visibilityState === "hidden") {
      void context.suspend();
      this.music?.pause();
    } else if (this.on) {
      void context.resume();
      this.music?.play();
    }
  };

  constructor(camera: THREE.PerspectiveCamera, desktop: boolean) {
    this.camera = camera;
    this.desktop = desktop;
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  get unlocked(): boolean {
    return this.context !== null;
  }

  /** Songs started so far (0 before the first) and the current one's "Artist – Title": the engine publishes both to the HUD's now-playing toast. */
  get trackSerial(): number {
    return this.music?.serial ?? 0;
  }

  get nowPlaying(): string {
    return this.music?.nowPlaying ?? "";
  }

  /** Builds the context and graph on the first call (a user gesture); later calls resume it. */
  unlock(): void {
    if (this.context) {
      void this.context.resume();
      return;
    }
    const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor({ latencyHint: LATENCY_HINT });
    THREE.AudioContext.setContext(context);
    const listener = new THREE.AudioListener();
    this.camera.add(listener);

    const ceiling = context.createWaveShaper();
    ceiling.curve = ceilingCurve(4097);
    ceiling.oversample = "4x";
    ceiling.connect(context.destination);
    const limiter = dynamics(context, MASTER_LIMITER);
    limiter.connect(ceiling);
    const trim = context.createGain();
    trim.gain.value = GLUE_TRIM;
    trim.connect(limiter);
    const glue = dynamics(context, MASTER_GLUE);
    glue.connect(trim);
    const master = context.createGain();
    master.gain.value = this.on ? 1 : 0;
    master.connect(glue);

    const slowmoFilter = lowpass(context, slowmoCutoff(1));
    slowmoFilter.connect(master);
    const engineBus = context.createGain();
    engineBus.gain.value = this.live ? engineBusGain(this.engineLevel) : 0;
    engineBus.connect(slowmoFilter);
    listener.gain.disconnect();
    listener.gain.connect(engineBus);
    const impactBus = context.createGain();
    impactBus.gain.value = IMPACT.busGain;
    impactBus.connect(master);
    const room = context.createConvolver();
    room.buffer = roomImpulse(context);
    const roomWet = context.createGain();
    roomWet.gain.value = IMPACT.roomWet;
    impactBus.connect(room).connect(lowpass(context, IMPACT.roomDampHz)).connect(roomWet).connect(master);
    const musicBus = context.createGain();
    musicBus.gain.value = musicGain(this.musicLevel, 1, 1);
    musicBus.connect(master);

    this.context = context;
    this.listener = listener;
    this.master = master;
    this.engineBus = engineBus;
    this.slowmoFilter = slowmoFilter;
    this.impactBus = impactBus;
    this.musicBus = musicBus;
    const motor = new MotorSound(voiceSlots(this.desktop));
    this.motor = motor;
    this.tyres = new TyreSound(context, engineBus);
    motor.load(context, listener).catch((reason: Error) => console.warn("motor sound: unavailable", reason));
    this.music = new MusicPlayer(context, musicBus, musicBase(import.meta.env));
    if (this.on) this.music.play();
    void context.resume();
  }

  /** Audio on ramps the master up and resumes the context; off ramps it down and suspends. */
  setOn(on: boolean): void {
    this.on = on;
    const context = this.context;
    if (!context || !this.master) return;
    this.master.gain.setTargetAtTime(on ? 1 : 0, context.currentTime, MASTER_TAU_S);
    if (on) {
      void context.resume();
      this.music?.play();
    } else {
      void context.suspend();
      this.music?.pause();
    }
  }

  /** The slider levels: the music bus (capped by `musicGain`) and the engine bus. The engine pushes them at construction and on every change. */
  setVolumes(music: number, engine: number): void {
    this.musicLevel = music;
    this.engineLevel = engine;
    const context = this.context;
    if (!context || !this.musicBus || !this.engineBus) return;
    this.musicBus.gain.setTargetAtTime(musicGain(music, 1, 1), context.currentTime, MASTER_TAU_S);
    this.engineBus.gain.setTargetAtTime(this.live ? engineBusGain(engine) : 0, context.currentTime, MASTER_TAU_S);
  }

  /**
   * The per-frame seam (the engine calls it with audio on): moves the engine voices, and on each voice tick sets the engine
   * bus (silent while `live` is false), the slow-mo lowpass from `rate`, and the music's duck under the player's engine and a crash.
   * `cars` are the ones drawn (the reel's, while it plays); `priority` is the car that always has a voice, and the one whose tyres squeal and land.
   */
  frame(dt: number, cars: readonly DeformableCar[], priority: DeformableCar | null, rate: number, live: boolean): void {
    const context = this.context;
    const motor = this.motor;
    if (!context || !motor || !this.engineBus || !this.slowmoFilter || !this.musicBus) return;
    this.sinceImpactS += dt;
    this.live = live;
    this.tyres?.frame(dt, priority);
    if (!motor.update(dt, cars, this.camera, priority, rate, this.engineLevel === 0)) return;
    const now = context.currentTime;
    this.engineBus.gain.setTargetAtTime(live ? engineBusGain(this.engineLevel) : 0, now, BUS_TAU_S);
    this.slowmoFilter.frequency.setTargetAtTime(slowmoCutoff(rate), now, BUS_TAU_S);
    this.musicBus.gain.setTargetAtTime(musicGain(this.musicLevel, engineDuck(motor.playerLevel), crashDuck(this.sinceImpactS)), now, DUCK_TAU_S);
  }

  /** A scene reset: every engine voice fades out and frees its slot. */
  releaseVoices(): void {
    this.motor?.releaseVoices();
  }

  impact(impulse: number): void {
    const context = this.context;
    if (!context || !this.impactBus) return;
    const t = context.currentTime;
    this.sinceImpactS = 0;
    this.musicBus?.gain.setTargetAtTime(musicGain(this.musicLevel, engineDuck(this.motor?.playerLevel ?? 0), crashDuck(0)), t, CRASH_DUCK_TAU_S);
    const dur = 0.35 + Math.min(0.4, impulse * 0.01);

    const thump = context.createOscillator();
    const thumpG = context.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(IMPACT.thumpStartHz, t);
    thump.frequency.exponentialRampToValueAtTime(IMPACT.thumpEndHz, t + dur);
    thumpG.gain.setValueAtTime(Math.min(0.7, 0.22 + impulse * THUMP_GAIN_PER_IMPULSE), t);
    thumpG.gain.exponentialRampToValueAtTime(0.001, t + dur);
    thump.connect(thumpG).connect(this.impactBus);
    thump.start(t);
    thump.stop(t + dur);

    const noise = context.createBufferSource();
    const nbuf = context.createBuffer(1, context.sampleRate * (IMPACT.noiseDecayS + 0.05), context.sampleRate);
    const data = nbuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    noise.buffer = nbuf;
    const ng = context.createGain();
    const bp = bandpass(context, IMPACT.noiseHz, IMPACT.noiseQ);
    ng.gain.setValueAtTime(0.001, t);
    ng.gain.exponentialRampToValueAtTime(Math.min(0.45, 0.12 + impulse * 0.008), t + IMPACT.noiseAttackS);
    ng.gain.exponentialRampToValueAtTime(0.001, t + IMPACT.noiseDecayS);
    noise.connect(bp).connect(ng).connect(this.impactBus);
    noise.start(t);
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.listener) this.camera.remove(this.listener);
    this.motor?.dispose();
    this.music?.dispose();
    void this.context?.close();
    this.context = null;
    this.listener = null;
    this.master = null;
    this.engineBus = null;
    this.slowmoFilter = null;
    this.impactBus = null;
    this.musicBus = null;
    this.motor = null;
    this.tyres = null;
    this.music = null;
    this.on = false;
    this.sinceImpactS = Infinity;
  }
}

/** A DynamicsCompressor set from one of the `audio-mix` presets. */
function dynamics(context: AudioContext, p: { threshold: number; knee: number; ratio: number; attack: number; release: number }): DynamicsCompressorNode {
  const node = context.createDynamicsCompressor();
  node.threshold.value = p.threshold;
  node.knee.value = p.knee;
  node.ratio.value = p.ratio;
  node.attack.value = p.attack;
  node.release.value = p.release;
  return node;
}

/** A stereo room impulse: independent noise per ear under an exponential decay that is -60 dB (x0.001) at `IMPACT.roomS`. */
function roomImpulse(context: AudioContext): AudioBuffer {
  const n = Math.round(context.sampleRate * IMPACT.roomS);
  const buffer = context.createBuffer(2, n, context.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / n);
  }
  return buffer;
}
