import type { DetachPart } from "./car-core.ts";

/** Netplay part slots: the most parts any style has (8, six body panels, plus the police light bar), so every car shares one layout. */
export const PART_SLOTS = 15;
/** Numbers in a `CarParts.partState` block: ten for the car, then nine per part slot. */
const PART_STATE_HEAD = 10;
const PART_STATE_EACH = 9;
export const PART_STATE = PART_STATE_HEAD + PART_SLOTS * PART_STATE_EACH;

/** What `partState` reads and writes of a car. */
export interface PartStateCar {
  /** The car's velocity (x, z) and yaw rate at the last door-swing sample, and the pendulum's drive. */
  readonly motion: Float64Array;
  readonly swingDrive: Float64Array;
  quietPrev: number;
  flapClock: number;
  flapSpeed: number;
}

/**
 * Highlight keyframes (docs/HIGHLIGHTS.md): what the netplay part state (float32 on the wire, and no rates or clocks) leaves
 * out or rounds, `PART_STATE` numbers into `buf`, or with `write` restored from it: the door-swing drive (the last motion
 * sample and the pendulum's drive), the contact timing and the flutter, and per part slot whether it is folding, its
 * hinge value and cap, its wind wear and its door swing's angle, rate, load, mirror fold and latch. A door that a sideswipe
 * is still swinging, or a panel half bent, slows the next striker by what it holds: the replay is the sim that recorded
 * it only if it starts from the same doubles. Which parts are on the car and which are off stays the net state's.
 */
export function partState(car: PartStateCar, parts: readonly DetachPart[], buf: Float64Array, write: boolean): void {
  const m = car.motion;
  const d = car.swingDrive;
  if (write) {
    for (let i = 0; i < 3; i++) m[i] = buf[i]!;
    for (let i = 0; i < 4; i++) d[i] = buf[3 + i]!;
    car.quietPrev = buf[7]!;
    car.flapClock = buf[8]!;
    car.flapSpeed = buf[9]!;
  } else {
    for (let i = 0; i < 3; i++) buf[i] = m[i]!;
    for (let i = 0; i < 4; i++) buf[3 + i] = d[i]!;
    buf[7] = car.quietPrev;
    buf[8] = car.flapClock;
    buf[9] = car.flapSpeed;
  }
  for (let i = 0; i < PART_SLOTS; i++) {
    const o = PART_STATE_HEAD + i * PART_STATE_EACH;
    const p = parts[i];
    if (!p) {
      if (!write) buf.fill(0, o, o + PART_STATE_EACH);
      continue;
    }
    const s = p.swing;
    if (write) {
      p.folding = buf[o]! !== 0;
      p.hingeT = buf[o + 1]!;
      p.hingeMax = buf[o + 2]!;
      p.fatigue = buf[o + 3]!;
      if (s) {
        s.theta = buf[o + 4]!;
        s.omega = buf[o + 5]!;
        s.load = buf[o + 6]!;
        s.mirrorFold = buf[o + 7]!;
        s.latched = buf[o + 8]! !== 0;
      }
    } else {
      buf[o] = p.folding ? 1 : 0;
      buf[o + 1] = p.hingeT;
      buf[o + 2] = p.hingeMax;
      buf[o + 3] = p.fatigue;
      buf[o + 4] = s ? s.theta : 0;
      buf[o + 5] = s ? s.omega : 0;
      buf[o + 6] = s ? s.load : 0;
      buf[o + 7] = s ? s.mirrorFold : 0;
      buf[o + 8] = s?.latched ? 1 : 0;
    }
  }
}
