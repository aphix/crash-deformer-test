import type { DriveInput } from "./car-drive.ts";
import { SLIDE_SPEED } from "./constants.ts";
import { PAD_BUTTON, type PadState } from "./gamepad.ts";

/** One frame of player intent, keyboard and pad merged, in player-visible signs. */
type DriveIntent = {
  /** 0..1 — W / ↑ / RT. */
  gas: number;
  /** 0..1 — S / ↓ / LT: brakes while rolling forward, reverses once stopped. */
  brake: number;
  /** -1..1 steering wheel, +1 = LEFT (A / ← / left stick left). */
  wheel: number;
  /** Space / X (Square). */
  handbrake: boolean;
  /** Shift / A (Cross). */
  boost: boolean;
  /** The winning value came from a pad axis (slew-limited, not keyboard-ramped). */
  analogWheel: boolean;
  analogGas: boolean;
  analogBrake: boolean;
  /** Both keyboard wheel keys are down: the wheel holds where it is (A + D). */
  wheelLock: boolean;
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
    wheelLock: false,
  };
}

/** Every key `readIntent` reads (`KeyboardEvent.code`), by control: no key here may also switch scenes (`engine-keys.ts`). */
export const DRIVE_KEYS = {
  gas: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  handbrake: ["Space"],
  boost: ["ShiftLeft", "ShiftRight"],
};

export function anyHeld(keys: ReadonlySet<string>, codes: readonly string[]): boolean {
  for (let i = 0; i < codes.length; i++) if (keys.has(codes[i]!)) return true;
  return false;
}

/** Ramped wheel and pedals carried between physics slices, plus the brake-tap drift pulse (`brakeHeld` s down, `pulse` s left). */
export type DriveFeel = { wheel: number; gas: number; brake: number; brakeHeld: number; pulse: number };

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
  /** With keyboard steering, a brake held no longer than this (s) and released with the wheel past `tapWheel` at speed is a drift request: the handbrake is asked for `tapPulseMin` s after the shortest tap up to `tapPulse` s after one `tapBrake` long (the car ramps its grip in over `DRIVE.ebrakeIn`, so the shortest tap kicks gently and a full one flicks). An analog wheel (pad stick, a scripted driver) brakes into corners on purpose and keeps the handbrake button. */
  tapBrake: 0.25,
  tapWheel: 0.6,
  tapPulseMin: 0.04,
  tapPulse: 0.12,
};

/**
 * A keydown the game may take: not already consumed (an overlay that handled it, e.g. a popover closing on Esc,
 * calls preventDefault, so one press never does two things), no Ctrl / Cmd / Alt chord (those stay the browser's:
 * Ctrl+R reloads, Ctrl+C copies; Shift is boost), and not typed into a text field, select or contentEditable
 * (a focused range slider still drives).
 */
export function gameKey(e: Pick<KeyboardEvent, "defaultPrevented" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target as Partial<HTMLInputElement> | null;
  if (t?.tagName === "TEXTAREA" || t?.tagName === "SELECT" || t?.isContentEditable) return false;
  return !(t?.tagName === "INPUT" && t.type !== "range");
}

/** Merge keyboard and pad per axis: the larger magnitude wins, so either can drive at any time. */
export function readIntent(keys: ReadonlySet<string>, pad: PadState | null, out: DriveIntent): DriveIntent {
  const kGas = anyHeld(keys, DRIVE_KEYS.gas) ? 1 : 0;
  const kBrake = anyHeld(keys, DRIVE_KEYS.brake) ? 1 : 0;
  const left = anyHeld(keys, DRIVE_KEYS.left);
  const right = anyHeld(keys, DRIVE_KEYS.right);
  const kWheel = (left ? 1 : 0) - (right ? 1 : 0);
  out.wheelLock = left && right;
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
  out.handbrake = anyHeld(keys, DRIVE_KEYS.handbrake) || (held & (1 << PAD_BUTTON.west)) !== 0;
  out.boost = anyHeld(keys, DRIVE_KEYS.boost) || (held & (1 << PAD_BUTTON.south)) !== 0;
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
  else if (intent.wheelLock) {
    /* both keys held: the wheel stays where it is */
  } else {
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

  if (intent.brake > 0.5) feel.brakeHeld += dt;
  else {
    if (!intent.analogWheel && feel.brakeHeld > 0 && feel.brakeHeld <= FEEL.tapBrake && Math.abs(feel.wheel) > FEEL.tapWheel && along > SLIDE_SPEED) {
      // The longer the tap, the longer the window the handbrake is asked for; `applyDrive` ramps its grip in and out over it (`DRIVE.ebrakeIn`), so a short tap gets a small kick and a long one the full flick.
      feel.pulse = FEEL.tapPulseMin + (FEEL.tapPulse - FEEL.tapPulseMin) * (feel.brakeHeld / FEEL.tapBrake);
    }
    feel.brakeHeld = 0;
  }
  feel.pulse = Math.max(0, feel.pulse - dt);

  out.throttle = 0;
  out.brake = 0;
  out.ebrake = intent.handbrake || feel.pulse > 0;
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
