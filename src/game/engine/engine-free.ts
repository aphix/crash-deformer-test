import { anyHeld, DRIVE_KEYS } from "../vehicle/drive-input.ts";
import { PAD_BUTTON, type PadState } from "../vehicle/gamepad.ts";
import type { FreeInput } from "../present/free-cam.ts";
import { SEAT_KEYS } from "./engine-keys.ts";

const FLY_UP_KEYS = [SEAT_KEYS.flyUp];
const FLY_DOWN_KEYS = [SEAT_KEYS.flyDown];

/** 1 while any of `codes` is held, else 0. */
function held(keys: ReadonlySet<string>, codes: readonly string[]): number {
  return anyHeld(keys, codes) ? 1 : 0;
}

/** The axis the player pushes harder, as driving merges a key and a stick. */
function stronger(key: number, stick: number): number {
  return Math.abs(stick) > Math.abs(key) ? stick : key;
}

/**
 * The free view's input this frame into `out`: the drive keys fly it (W / S forward and back, A / D strafe, the arrows too, Shift fast),
 * the page keys rise and sink it. The pad: left stick flies, right stick looks, RT rises, LT sinks, A (the boost button) is fast.
 * `hold` zeroes it all (a menu owns the keys).
 */
export function readFreeInput(keys: ReadonlySet<string>, pad: PadState, hold: boolean, out: FreeInput): FreeInput {
  if (hold) {
    out.forward = 0;
    out.strafe = 0;
    out.rise = 0;
    out.lookX = 0;
    out.lookY = 0;
    out.fast = false;
    return out;
  }
  out.forward = stronger(held(keys, DRIVE_KEYS.gas) - held(keys, DRIVE_KEYS.brake), -pad.ly);
  out.strafe = stronger(held(keys, DRIVE_KEYS.right) - held(keys, DRIVE_KEYS.left), pad.lx);
  out.rise = stronger(held(keys, FLY_UP_KEYS) - held(keys, FLY_DOWN_KEYS), pad.rt - pad.lt);
  out.lookX = pad.rx;
  out.lookY = pad.ry;
  out.fast = anyHeld(keys, DRIVE_KEYS.boost) || (pad.held & (1 << PAD_BUTTON.south)) !== 0;
  return out;
}
