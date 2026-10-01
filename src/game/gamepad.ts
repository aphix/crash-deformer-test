/**
 * Gamepad API reader for the W3C "standard" mapping (Xbox, DualSense/DualShock in
 * Chromium, Firefox and Safari). Polled once per frame into a pooled `PadState`.
 */

/** Standard-mapping button indices (Xbox name / PlayStation name). */
export const PAD_BUTTON = {
  /** A / Cross */
  south: 0,
  /** B / Circle */
  east: 1,
  /** X / Square */
  west: 2,
  /** Y / Triangle */
  north: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  /** Back / View / Create */
  back: 8,
  /** Start / Menu / Options */
  start: 9,
  l3: 10,
  r3: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

export const PAD_DEAD = {
  /** Radial stick deadzone; worn Xbox/DualSense sticks rest around 0.08–0.12. */
  stick: 0.15,
  trigger: 0.05,
  /** >1 softens the centre for fine steering; full deflection still reaches 1. */
  curve: 1.7,
};

/** The read surface of a DOM `Gamepad`, so the mapping runs in node tests. */
export type PadSource = {
  readonly connected: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
};

export type PadState = {
  connected: boolean;
  /** Sticks after deadzone + curve, DOM signs: +x right, +y down. */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** Triggers 0..1 after deadzone. */
  lt: number;
  rt: number;
  /** Held buttons, bit `1 << PAD_BUTTON.*`. */
  held: number;
  /** Buttons that went down on this poll. */
  pressed: number;
};

export function blankPad(): PadState {
  return { connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, held: 0, pressed: 0 };
}

/**
 * Scale for a stick sample: multiply both axes by it. Radial deadzone (no square
 * corners), rescaled so output starts at 0 just past the deadzone, magnitude
 * capped at 1, then a power curve for fine control near the centre.
 */
export function stickScale(x: number, y: number): number {
  const m = Math.hypot(x, y);
  if (m <= PAD_DEAD.stick) return 0;
  const n = Math.min(1, (m - PAD_DEAD.stick) / (1 - PAD_DEAD.stick));
  return Math.pow(n, PAD_DEAD.curve) / m;
}

export function triggerValue(v: number): number {
  if (!(v > PAD_DEAD.trigger)) return 0;
  return Math.min(1, (v - PAD_DEAD.trigger) / (1 - PAD_DEAD.trigger));
}

/** Copy one pad into `out`; `pressed` = buttons down now and up on the previous read. */
export function readPad(src: PadSource | null, out: PadState): void {
  const prev = out.held;
  if (!src || !src.connected) {
    out.connected = false;
    out.lx = out.ly = out.rx = out.ry = out.lt = out.rt = 0;
    out.held = 0;
    out.pressed = 0;
    return;
  }
  out.connected = true;
  const a = src.axes;
  const lx = a[0] ?? 0;
  const ly = a[1] ?? 0;
  const ls = stickScale(lx, ly);
  out.lx = lx * ls;
  out.ly = ly * ls;
  const rx = a[2] ?? 0;
  const ry = a[3] ?? 0;
  const rs = stickScale(rx, ry);
  out.rx = rx * rs;
  out.ry = ry * rs;
  const b = src.buttons;
  out.lt = triggerValue(b[PAD_BUTTON.lt]?.value ?? 0);
  out.rt = triggerValue(b[PAD_BUTTON.rt]?.value ?? 0);
  let held = 0;
  const n = Math.min(b.length, 17);
  for (let i = 0; i < n; i++) {
    const btn = b[i]!;
    if (btn.pressed || btn.value > 0.5) held |= 1 << i;
  }
  out.held = held;
  out.pressed = held & ~prev;
}

/** Short HUD label from a `Gamepad.id` (vendor 045e Microsoft, 054c Sony). */
export function padLabel(id: string): string {
  if (/xbox|xinput|045e/i.test(id)) return "Xbox controller";
  if (/dualsense|dualshock|playstation|054c/i.test(id)) return "PlayStation controller";
  return "Controller";
}

type PadEvent = Event & { readonly gamepad: { readonly index: number } };

/**
 * Hot-plugged pad: `gamepadconnected`/`gamepaddisconnected` pick the active index,
 * `poll()` reads it once per frame. Browsers only expose a pad after its first
 * button press, so the HUD label appears then.
 */
export class GamepadInput {
  readonly state = blankPad();
  /** HUD label of the active pad, null when none is connected. */
  label: string | null = null;
  private index = -1;
  private onChange: () => void = () => {};

  attach(onChange: () => void): void {
    this.onChange = onChange;
    window.addEventListener("gamepadconnected", this.onConnect);
    window.addEventListener("gamepaddisconnected", this.onDisconnect);
  }

  detach(): void {
    window.removeEventListener("gamepadconnected", this.onConnect);
    window.removeEventListener("gamepaddisconnected", this.onDisconnect);
  }

  poll(): PadState {
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : null;
    let pad: Gamepad | null = null;
    if (pads) {
      const held = this.index >= 0 ? pads[this.index] : null;
      if (held && held.connected) pad = held;
      else {
        for (let i = 0; i < pads.length; i++) {
          const p = pads[i];
          if (p && p.connected && (pad === null || (p.mapping === "standard" && pad.mapping !== "standard"))) pad = p;
        }
        this.index = pad ? pad.index : -1;
      }
    }
    readPad(pad, this.state);
    const label = pad ? padLabel(pad.id) : null;
    if (label !== this.label) {
      this.label = label;
      this.onChange();
    }
    return this.state;
  }

  private onConnect = (e: Event): void => {
    if (this.index < 0) this.index = (e as PadEvent).gamepad.index;
  };

  private onDisconnect = (e: Event): void => {
    if ((e as PadEvent).gamepad.index === this.index) this.index = -1;
  };
}
