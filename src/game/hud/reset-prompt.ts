import type { RaceHud, RaceView } from "../match/types.ts";

/** Wheels off at which the reset prompt comes up, and the reset controls glow: two gone and the car is a crawling wreck. */
const PROMPT_WHEELS_OFF = 2;

/** The wreck the player should reset: two or more wheels off and a reset the game would accept. The one rule behind the prompt and the glow. */
export function needsReset(view: RaceView): boolean {
  return view.wheelsOff >= PROMPT_WHEELS_OFF && view.canReset;
}

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
  if (!needsReset(view)) return null;
  if (input === "keyboard") return "R";
  if (input === "pad") return "D-pad ↓";
  return race ? "Respawn" : "Recover";
}

/**
 * Whether the reset controls themselves (the thumb pad's wrench, the R hint, the dock's reset) glow: the
 * viewed car of the scene in play needs a reset (`needsReset`). A race has its own view; outside one a derby
 * driver's or a fleet driver's. `canReset` is the game's own verdict, so no glow where it would refuse.
 */
export function resetGlow(s: { race: Pick<RaceHud, "view"> | null; derbyView: RaceView | null; fleetView: RaceView | null }): boolean {
  const view = s.race ? s.race.view : (s.derbyView ?? s.fleetView);
  return view !== null && needsReset(view);
}

/**
 * What the player does to go back on the road keeping the damage, named for `input` ("hold R", "hold D-pad ↓", "hold Respawn": the thumb pad's
 * button); null where no control is on screen. A hold works in a no-reset race too.
 */
export function holdResetLabel(input: ResetInput | null): string | null {
  if (input === "keyboard") return "hold R";
  if (input === "pad") return "hold D-pad ↓";
  if (input === "touch") return "hold Respawn";
  return null;
}

/**
 * The missed-checkpoint banner's text: the checkpoints are invisible, so it says what to do, not just that one was missed: hold the reset
 * control and the car goes back to where it last was on the road before the first checkpoint it owes. Without a hold (the view's
 * `canHold` is off, or no control is on screen) it only says one was missed.
 */
export function missedCheckpointText(view: Pick<RaceView, "canHold"> | null, input: ResetInput | null): string {
  const hold = view?.canHold ? holdResetLabel(input) : null;
  return hold === null ? "Missed checkpoint" : `Missed checkpoint: ${hold} to go back`;
}
