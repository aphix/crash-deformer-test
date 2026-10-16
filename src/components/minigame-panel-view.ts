import { MINIGAME_MODES, MODE_LABELS, THROWS_PER_SET, type MinigameMode } from "../game/scenes/minigame-constants.ts";
import type { MinigameHudState } from "../game/scenes/minigame-session.ts";

const MODE_UNITS: Readonly<Record<MinigameMode, string>> = { longJump: "m", highJump: "m", ringFling: "pts" };

function valueText(mode: MinigameMode, value: number): string {
  return mode === "ringFling" ? `${Math.round(value)} ${MODE_UNITS[mode]}` : `${value.toFixed(1)} ${MODE_UNITS[mode]}`;
}

function bestText(mode: MinigameMode, best: number | null): string {
  return best === null ? "–" : valueText(mode, best);
}

export type ThrowsStepperView = { value: number; canDecrease: boolean; canIncrease: boolean };

export type MinigamePanelView = {
  title: string;
  /** The live reading while he flies (m past the lip, m above it, the ring zone under him), else null. */
  live: string | null;
  /** The big Score line once the attempt is scored (in a Ring Fling, the throw's score; after the set, the total), else null. */
  score: string | null;
  /** Ring Fling only: "Throw n / N"; null in the other modes. */
  throwCounter: string | null;
  /** Ring Fling only: the set's finished throw scores; null in the other modes. */
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
export function minigamePanelView(state: MinigameHudState): MinigamePanelView {
  const { mode, phase } = state;
  const isRing = mode === "ringFling";
  const throwsPerSet = state.throwsPerSet ?? THROWS_PER_SET.default;
  const stepperOpen = (phase === "ready" && state.setScores.length === 0) || state.setComplete;
  const retryLabel = !isRing ? "Retry" : state.setComplete ? "New set" : "Next throw";
  const finishedScore = state.setComplete ? state.setTotal : state.lastScore;
  return {
    title: MODE_LABELS[mode],
    live: state.liveValue === null ? null : valueText(mode, state.liveValue),
    score: phase === "scored" && finishedScore !== null ? valueText(mode, finishedScore) : null,
    throwCounter: isRing ? `Throw ${state.attempt} / ${throwsPerSet}` : null,
    setScores: isRing ? state.setScores.map((score) => valueText(mode, score)).join(" · ") : null,
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
