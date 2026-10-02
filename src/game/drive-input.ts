import type { DriveInput } from "./car-drive.ts";
import { PAD_BUTTON, type PadState } from "./gamepad.ts";

/** One frame of player intent, keyboard and pad merged, in player-visible signs. */
type DriveIntent = {
  /** 0..1 — W / ↑ / RT. */
  gas: number;
  /** 0..1 — S / ↓ / LT: brakes while rolling forward, reverses once stopped. */
  brake: number;
  /** -1..1 steering wheel, +1 = LEFT (A / ← / left stick left). */
  wheel: number;
  /** Space / A (Cross). */
  handbrake: boolean;
  /** Shift / X (Square). */
  boost: boolean;
  /** The winning value came from a pad axis (slew-limited, not keyboard-ramped). */
  analogWheel: boolean;
  analogGas: boolean;
  analogBrake: boolean;
};

export function blankIntent(): DriveIntent {
  return {
    gas: 0,
    brake: 0,
    wheel: 0,
    handbrake: false,
    boost: false,
    analogWheel: false,
    analogGas: false,
    analogBrake: false,
  };
}

/** Ramped wheel and pedals carried between physics slices. */
export type DriveFeel = { wheel: number; gas: number; brake: number };

export const FEEL = {
  /** Keyboard wheel slew (1/s): full lock in ~0.24 s, back to centre in ~0.14 s. */
  steerIn: 4.2,
  steerOut: 7,
  /** Pad wheel slew limit (1/s): a full flick in ~0.08 s, stick noise hidden. */
  steerPad: 12,
  /** Keyboard pedal ramp-in (1/s); releases and analog triggers pass straight through. */
  pedalIn: 7,
  /** Lock left at speed v: 1 / (1 + (v / steerFade)²), never below steerMin. */
  steerFade: 15,
  steerMin: 0.4,
  /** Wheel authority grows to full by this speed (m/s) and flips sign in reverse, like a real car. */
  rollSpeed: 2.2,
  /** Under this |forward speed| (m/s) the brake pedal engages reverse and gas leaves it. */
  stopSpeed: 0.6,
  /** Service-brake share applied with the handbrake. */
  handbrakeBrake: 0.55,
};

/**
 * A keydown the game may take: no Ctrl / Cmd / Alt chord (those stay the browser's: Ctrl+R reloads, Ctrl+C copies;
 * Shift is boost), and not typed into a text field, select or contentEditable (a focused range slider still drives).
 */
export function gameKey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target as Partial<HTMLInputElement> | null;
  if (t?.tagName === "TEXTAREA" || t?.tagName === "SELECT" || t?.isContentEditable) return false;
  return !(t?.tagName === "INPUT" && t.type !== "range");
}

/** Merge keyboard and pad per axis: the larger magnitude wins, so either can drive at any time. */
export function readIntent(keys: ReadonlySet<string>, pad: PadState | null, out: DriveIntent): DriveIntent {
  const kGas = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
  const kBrake = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
  const kWheel =
    (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0) - (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0);
  const p = pad && pad.connected ? pad : null;
  const pWheel = p ? -p.lx : 0;
  const pGas = p ? p.rt : 0;
  const pBrake = p ? p.lt : 0;
  out.analogWheel = Math.abs(pWheel) > Math.abs(kWheel);
  out.wheel = out.analogWheel ? pWheel : kWheel;
  out.analogGas = pGas > kGas;
  out.gas = Math.max(kGas, pGas);
  out.analogBrake = pBrake > kBrake;
  out.brake = Math.max(kBrake, pBrake);
  const held = p ? p.held : 0;
  out.handbrake = keys.has("Space") || (held & (1 << PAD_BUTTON.south)) !== 0;
  out.boost = keys.has("ShiftLeft") || keys.has("ShiftRight") || (held & (1 << PAD_BUTTON.west)) !== 0;
  return out;
}

function slew(cur: number, target: number, rate: number, dt: number): number {
  const step = rate * dt;
  return cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
}

/**
 * Intent → `DriveInput` for one slice at signed forward speed `along` (m/s).
 * Keyboard wheel/pedals ramp, the wheel loses lock with speed, and its yaw
 * authority scales with speed through zero (no pivoting on the spot; reverse
 * steers like a real car: wheel left backs the tail to the car's left).
 * Pedals follow GTA: brake slows a forward-rolling car and reverses once
 * stopped; gas brakes a reversing car and drives forward once stopped.
 */
export function shapeDrive(intent: DriveIntent, feel: DriveFeel, along: number, dt: number, out: DriveInput): DriveInput {
  const w = intent.wheel;
  if (intent.analogWheel) feel.wheel = slew(feel.wheel, w, FEEL.steerPad, dt);
  else {
    const outward = w !== 0 && Math.sign(w) === Math.sign(feel.wheel || w) && Math.abs(w) > Math.abs(feel.wheel);
    feel.wheel = slew(feel.wheel, w, outward ? FEEL.steerIn : FEEL.steerOut, dt);
  }
  feel.gas = intent.analogGas || intent.gas < feel.gas ? intent.gas : slew(feel.gas, intent.gas, FEEL.pedalIn, dt);
  feel.brake =
    intent.analogBrake || intent.brake < feel.brake ? intent.brake : slew(feel.brake, intent.brake, FEEL.pedalIn, dt);

  const speed = Math.abs(along);
  const fade = speed / FEEL.steerFade;
  const lock = intent.handbrake ? 1 : Math.max(FEEL.steerMin, 1 / (1 + fade * fade));
  const roll = Math.max(-1, Math.min(1, along / FEEL.rollSpeed));
  out.steer = feel.wheel * lock * roll;

  out.throttle = 0;
  out.brake = 0;
  out.ebrake = intent.handbrake;
  if (intent.handbrake) {
    out.brake = FEEL.handbrakeBrake;
  } else if (feel.gas >= feel.brake) {
    if (along < -FEEL.stopSpeed) out.brake = feel.gas;
    else out.throttle = feel.gas;
  } else if (along > FEEL.stopSpeed) {
    out.brake = feel.brake;
  } else {
    out.throttle = -feel.brake;
  }
  out.boost = intent.boost && out.throttle > 0;
  return out;
}
