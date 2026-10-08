import type { RaceHud } from "../match/types.ts";
import type { CrashHudState } from "./hud-store.ts";

/** The Debug section's Submit: drawn only while a JSON trace capture is on and has recorded samples (the capture it sends). */
export function captureSubmitShown(hud: Pick<CrashHudState, "captureTrace" | "traceSamples">): boolean {
  return hud.captureTrace && hud.traceSamples > 0;
}

/**
 * The [!] flag: drawn over the results reel and over a solo view, bound to the clip on screen when it was drawn
 * (`RaceHud.shown`, one id for the clip through every loop of the reel). During the flight between clips no clip is
 * on screen: it stays drawn, with no clip to press.
 */
export function flagButton(race: Pick<RaceHud, "reel" | "solo" | "shown"> | null): { visible: boolean; clip: number | null } {
  if (race === null || (race.reel === null && race.solo === null)) return { visible: false, clip: null };
  return { visible: true, clip: race.shown };
}

/** The update notice: a newer build is deployed, and no race is under way. A countdown or a race (paused too) holds it until the race is over; every other scene shows it at once. */
export function updateNoticeShown(newer: string | null, race: Pick<RaceHud, "phase"> | null): boolean {
  return newer !== null && race?.phase !== "countdown" && race?.phase !== "racing";
}
