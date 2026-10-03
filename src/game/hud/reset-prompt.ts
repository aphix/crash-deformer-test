import type { RaceView } from "../match/types.ts";

/** Wheels off at which the reset prompt comes up: two gone and the car is a crawling wreck. */
const PROMPT_WHEELS_OFF = 2;

/** What the player resets with: the keyboard's R, the pad's D-pad ↓ (`engine-input.ts`: KeyR, `PAD_BUTTON.down`), or the thumb pad's button. */
export type ResetInput = "keyboard" | "pad" | "touch";

/**
 * The control the player resets with now; null when none is on screen: a touch screen only has the reset
 * button while driving (following, the thumb pad is the stick and the camera buttons). A connected pad wins.
 */
export function resetInput(pad: boolean, touch: boolean, driving: boolean): ResetInput | null {
  if (pad) return "pad";
  if (!touch) return "keyboard";
  return driving ? "touch" : null;
}

/**
 * What the prompt names for `input` (the touch button's caption, which differs between a race's Respawn and a
 * derby's Recover); null when it stays down: fewer than two wheels off, or a reset the game would refuse.
 */
export function resetPromptLabel(view: RaceView, input: ResetInput, race: boolean): string | null {
  if (view.wheelsOff < PROMPT_WHEELS_OFF || !view.canReset) return null;
  if (input === "keyboard") return "R";
  if (input === "pad") return "D-pad ↓";
  return race ? "Respawn" : "Recover";
}
