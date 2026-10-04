/** `localStorage` key of a course's best Survival time (seconds, as text). Preferences only: nothing here picks a scene or a room (engine-share.ts). */
const KEY = "crush.survival.best.";

/** The best time kept for course `trackId` (s), null when none, or when the browser's storage is off or holds something else. */
export function loadBest(trackId: string): number | null {
  try {
    const t = Number(localStorage.getItem(KEY + trackId));
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Keep `time` as the course's best. A blocked or full storage keeps nothing: the HUD still shows the run's own result. */
export function saveBest(trackId: string, time: number): void {
  try {
    localStorage.setItem(KEY + trackId, String(time));
  } catch {
    /* storage unavailable */
  }
}
