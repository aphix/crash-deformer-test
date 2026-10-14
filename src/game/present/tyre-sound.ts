import { hypot2 } from "../kernel/physics-core.js";
import type { DeformableCar } from "../vehicle/car.ts";
import { squealHz, squealLevel, thudGain, TYRE } from "./audio-mix.ts";
import { LandingWatch } from "./landing.ts";
import { bandpass, lowpass } from "./motor-sound.ts";

/** The squeal's parameters follow the car at this rate (s), like the engine voices'. */
const TICK_S = 1 / 30;
/** Time constant (s) of the squeal's pitch following the car's speed. */
const HZ_TAU_S = 0.05;
/** The shared noise buffer's length (s). */
const BUFFER_S = 2;

/**
 * The focus car's tyre voices on `bus` (`TYRE` in `audio-mix.ts`): a squeal that follows its slide state, and a thud on each landing (`LandingWatch`,
 * the camera's own landing). One noise buffer feeds both. Audio only reads the car.
 */
export class TyreSound {
  private readonly context: AudioContext;
  private readonly bus: AudioNode;
  private readonly noise: AudioBuffer;
  private readonly band: BiquadFilterNode;
  private readonly squeal: GainNode;
  private readonly watch = new LandingWatch();
  private car: DeformableCar | null = null;
  private tickS = 0;

  constructor(context: AudioContext, bus: AudioNode) {
    this.context = context;
    this.bus = bus;
    this.noise = context.createBuffer(1, Math.round(context.sampleRate * BUFFER_S), context.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    this.band = bandpass(context, TYRE.hzLow, TYRE.bandQ);
    this.squeal = context.createGain();
    this.squeal.gain.value = 0;
    source.connect(this.band).connect(this.squeal).connect(bus);
    source.start();

    const lfo = context.createOscillator();
    lfo.frequency.value = TYRE.wobbleHz;
    const depth = context.createGain();
    depth.gain.value = TYRE.wobbleCents;
    lfo.connect(depth).connect(this.band.detune);
    lfo.start();
  }

  /** One frame: a landing thuds at once; the squeal retunes every `TICK_S`. `car` is the focus car (null: none, the squeal fades out). */
  frame(dt: number, car: DeformableCar | null): void {
    if (car !== this.car) {
      this.car = car;
      this.watch.reset();
    }
    if (car) {
      const fall = this.watch.step(car, dt);
      if (fall > 0) this.thud(thudGain(fall));
    }
    this.tickS += dt;
    if (this.tickS < TICK_S) return;
    this.tickS = 0;
    const now = this.context.currentTime;
    let level = 0;
    let speed = 0;
    if (car) {
      const d = car.drive;
      speed = hypot2(car.velocity.x, car.velocity.z);
      level = squealLevel(d.slide, d.lock, d.spin, speed, !car.airborne && car.wheelsDown !== 0);
    }
    this.squeal.gain.setTargetAtTime(level * TYRE.squealGain, now, TYRE.fadeTau);
    this.band.frequency.setTargetAtTime(squealHz(speed), now, HZ_TAU_S);
  }

  /** A low sine sweeping down under a short dark noise burst (a few nodes per landing; landings are rare). */
  private thud(gain: number): void {
    const context = this.context;
    const t = context.currentTime;
    const body = context.createOscillator();
    const bodyGain = context.createGain();
    body.frequency.setValueAtTime(TYRE.thudStartHz, t);
    body.frequency.exponentialRampToValueAtTime(TYRE.thudEndHz, t + TYRE.thudS);
    bodyGain.gain.setValueAtTime(gain, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + TYRE.thudS);
    body.connect(bodyGain).connect(this.bus);
    body.start(t);
    body.stop(t + TYRE.thudS);

    const burst = context.createBufferSource();
    burst.buffer = this.noise;
    const dark = lowpass(context, TYRE.noiseHz);
    const burstGain = context.createGain();
    burstGain.gain.setValueAtTime(gain * TYRE.noiseShare, t);
    burstGain.gain.exponentialRampToValueAtTime(0.001, t + TYRE.noiseS);
    burst.connect(dark).connect(burstGain).connect(this.bus);
    burst.start(t, Math.random() * (BUFFER_S - TYRE.noiseS));
    burst.stop(t + TYRE.noiseS);
  }
}
