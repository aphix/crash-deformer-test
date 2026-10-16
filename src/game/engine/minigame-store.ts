import type { MinigameMode } from "../scenes/minigame-constants.ts";
import type { MinigameBestPair, MinigameBests } from "../scenes/minigame-session.ts";

/** `localStorage` key prefix of the minigame bests (scores as text). Preferences only, like the Survival best (survival-store.ts). */
const KEY_PREFIX = "crush.minigame.best.";
/** Last key segment of a mode's best over every car type; a car type's own best ends in the car type instead. */
const OVERALL_SUFFIX = "overall";

/** `<prefix><mode>[.<throwsPerSet>].<suffix>`: only the Ring Fling's keys carry a set length. */
function bestKey(mode: MinigameMode, throwsPerSet: number | null, suffix: string): string {
  return KEY_PREFIX + mode + (throwsPerSet === null ? "" : `.${throwsPerSet}`) + "." + suffix;
}

/** The score kept under `key`, null when none, or when the browser's storage is off or holds something else. */
function load(key: string): number | null {
  try {
    const score = Number(localStorage.getItem(key));
    return Number.isFinite(score) && score > 0 ? score : null;
  } catch {
    return null;
  }
}

/** A blocked or full storage keeps nothing: the HUD still shows the attempt's own result. */
function save(key: string, score: number): void {
  try {
    localStorage.setItem(key, String(score));
  } catch {
    /* storage unavailable */
  }
}

/** Keep `score` under `key` when it beats what is kept; true when it does. Reads storage on every call, so a reload sees it. */
function keepIfBest(key: string, score: number): boolean {
  const previous = load(key);
  if (previous !== null && score <= previous) return false;
  save(key, score);
  return true;
}

/** The bests in the browser's `localStorage`. */
export function minigameStore(): MinigameBests {
  return {
    bestFor(mode, throwsPerSet, carType): MinigameBestPair {
      return { thisCar: load(bestKey(mode, throwsPerSet, carType)), overall: load(bestKey(mode, throwsPerSet, OVERALL_SUFFIX)) };
    },
    record(mode, throwsPerSet, carType, score) {
      if (!(score > 0)) return false;
      const newCarBest = keepIfBest(bestKey(mode, throwsPerSet, carType), score);
      const newOverallBest = keepIfBest(bestKey(mode, throwsPerSet, OVERALL_SUFFIX), score);
      return newCarBest || newOverallBest;
    },
  };
}
