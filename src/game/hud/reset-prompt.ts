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
