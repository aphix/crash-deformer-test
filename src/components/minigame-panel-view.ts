import { MINIGAME_MODE, MINIGAME_MODES, MODE_LABELS, THROWS_PER_SET, type MinigameMode } from "../game/scenes/minigame-constants.ts";
import type { MinigameHudState } from "../game/scenes/minigame-session.ts";
import { bailPromptText, bailResultText } from "../game/hud/bail-prompt.ts";

const MODE_UNITS: Readonly<Record<MinigameMode, string>> = { longJump: "m", highJump: "m", ringFling: "pts" };

/** The caption of the live reading: what the number measures in each mode. */
const LIVE_CAPTIONS: Readonly<Record<MinigameMode, string>> = { longJump: "Distance", highJump: "Height", ringFling: "Ring:" };

function valueText(mode: MinigameMode, value: number): string {
  return mode === MINIGAME_MODE.ringFling ? `${Math.round(value)} ${MODE_UNITS[mode]}` : `${value.toFixed(1)} ${MODE_UNITS[mode]}`;
}

function bestText(mode: MinigameMode, best: number | null): string {
  return best === null ? "–" : valueText(mode, best);
}

type ThrowsStepperView = { value: number; canDecrease: boolean; canIncrease: boolean };

type MinigamePanelView = {
  title: string;
  /** The Long jump's prompt before the throw ("Press Shift as you hit the barrier"), else null. */
  bailPrompt: string | null;
  /** The Long jump's timing once he is thrown ("Perfect", "Early 0.12 s"), else null. */
  bailResult: string | null;
  /** The captioned reading while he is out (Distance 61.3 m, Height 2.1 m, Ring: 30), else null. */
  live: string | null;
  /** The big Score line once the attempt is scored (in a Ring Fling, the throw's score; after the set, the total), else null. */
  score: string | null;
  /** Ring Fling only: a scored throw of 0 reads "Short of the cups"; null otherwise. */
  scoreHint: string | null;
  /** Ring Fling only: "Throw n / N"; null in the other modes. */
  throwCounter: string | null;
  /** Ring Fling only: "Set: 10 · 30" over the set's throws other than the one the Score line shows; null when that list is empty. */
  setScores: string | null;
  /** Ring Fling only: the set total, labelled "Best" once the set is complete, else "Total". Null in the other modes. */
  total: string | null;
  totalLabel: string | null;
  bestThisCar: string;
  bestOverall: string;
  retryLabel: string;
  retryEnabled: boolean;
  resetEnabled: boolean;
  otherModes: { mode: MinigameMode; label: string }[];
  /** Ring Fling only, else null. Disabled mid-set (a set in progress keeps its length) so `canDecrease`/`canIncrease` are both false there. */
  stepper: ThrowsStepperView | null;
};

/** What the panel shows and which buttons work, from the session's card: pure, so the labels and enabled states are testable without a DOM. */
export function minigamePanelView(state: MinigameHudState, bailControl: string): MinigamePanelView {
  const { mode, phase } = state;
  const isRing = mode === MINIGAME_MODE.ringFling;
  const throwsPerSet = state.throwsPerSet ?? THROWS_PER_SET.default;
  const stepperOpen = (phase === "ready" && state.setScores.length === 0) || state.setComplete;
  const retryLabel = !isRing ? "Retry" : state.setComplete ? "New set" : "Next throw";
  const finishedScore = state.setComplete ? state.setTotal : state.lastScore;
  const scoreShown = phase === "scored" && !state.setComplete;
  const earlierScores = (scoreShown ? state.setScores.slice(0, -1) : state.setScores).map((score) => Math.round(score));
  const bail = state.bail;
  const bailBeforeThrow = bail !== null && bail.verdict === null && (phase === "ready" || phase === "running");
  return {
    title: MODE_LABELS[mode],
    bailPrompt: bail !== null && bailBeforeThrow ? bailPromptText(bailControl, bail.pressed) : null,
    bailResult: bail === null || bail.verdict === null ? null : bailResultText(bail.verdict),
    live: state.liveValue === null ? null : `${LIVE_CAPTIONS[mode]} ${isRing ? Math.round(state.liveValue) : valueText(mode, state.liveValue)}`,
    score: phase === "scored" && finishedScore !== null ? valueText(mode, finishedScore) : null,
    scoreHint: isRing && phase === "scored" && state.lastScore === 0 ? "Short of the cups" : null,
    throwCounter: isRing ? `Throw ${state.attempt} / ${throwsPerSet}` : null,
    setScores: isRing && earlierScores.length > 0 ? `Set: ${earlierScores.join(" · ")}` : null,
    total: isRing ? valueText(mode, state.setTotal) : null,
    totalLabel: isRing ? (state.setComplete ? "Best" : "Total") : null,
    bestThisCar: bestText(mode, state.best.thisCar),
    bestOverall: bestText(mode, state.best.overall),
    retryLabel,
    retryEnabled: phase === "scored",
    resetEnabled: phase === "ready" || phase === "running",
    otherModes: MINIGAME_MODES.filter((other) => other !== mode).map((other) => ({ mode: other, label: MODE_LABELS[other] })),
    stepper: isRing
      ? { value: throwsPerSet, canDecrease: stepperOpen && throwsPerSet > THROWS_PER_SET.min, canIncrease: stepperOpen && throwsPerSet < THROWS_PER_SET.max }
      : null,
  };
}
