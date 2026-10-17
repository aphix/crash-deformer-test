import type { BailVerdict } from "../scenes/minigame-bail.ts";
import { boostPadButton, DRIVE_KEYS } from "../vehicle/drive-input.ts";
import { padButtonName, type PadFamily } from "../vehicle/gamepad.ts";

/** The thumb pad's button on a touch screen: it is labelled Boost. */
const TOUCH_BUTTON_NAME = "Boost";

/** What a keyboard calls the key behind a `KeyboardEvent.code`: both Shift keys are "Shift". */
function keyName(code: string): string {
  return code.replace(/(Left|Right)$/, "");
}

/**
 * The name of the control that bails, for the input in use: a connected pad's face button as that pad's family calls it (the button
 * `readIntent` binds to Boost, read back from it, never a letter written here), else the touch pad's Boost button on a touch screen,
 * else the keyboard's boost key. The Long jump has one input meaning for it: the car's own boost is off there.
 */
export function bailControlName(padFamily: PadFamily | null, touch: boolean): string {
  if (padFamily !== null) {
    const button = boostPadButton();
    return button === null ? TOUCH_BUTTON_NAME : padButtonName(padFamily, button);
  }
  if (touch) return TOUCH_BUTTON_NAME;
  return keyName(DRIVE_KEYS.boost[0]!);
}

/** The prompt before the throw: what to press, and when. */
export function bailPromptText(controlName: string, pressed: boolean): string {
  return pressed ? "Bail pressed" : `Press ${controlName} as you hit the barrier`;
}

/** The timing after the throw: "Perfect", "Early 0.12 s", "Late 0.08 s", or why there was no bail. */
export function bailResultText(verdict: BailVerdict): string {
  const seconds = verdict.offsetSeconds === null ? "" : Math.abs(verdict.offsetSeconds).toFixed(2);
  if (verdict.kind === "perfect") return "Perfect";
  if (verdict.kind === "early") return `Early ${seconds} s`;
  if (verdict.kind === "late") return `Late ${seconds} s`;
  if (verdict.kind === "tooEarly") return `Too early (${seconds} s): no bail`;
  if (verdict.kind === "tooLate") return `Too late (${seconds} s): no bail`;
  return "No bail";
}
