/**
 * Survival's own rules (Driver 2's mode; docs/SURVIVAL.md). The race stack runs the rest: `RaceSession` with its `survival`
 * option (the BUST rule at this hold time, no laps), `judge` (driver out / engine dead / flipped), the pack in `ai/hunter.ts`.
 */
export const SURVIVAL = {
  /** Seconds held slow beside a chasing cop before the bust: the owner's "10-15 seconds". */
  bustTime: 12,
} as const;

/** A finished run's time against the best before it (`prev`, null: none): the new best, and whether this run set it. */
export function settleRun(prev: number | null, time: number): { best: number; isNew: boolean } {
  return prev === null || time > prev ? { best: time, isNew: true } : { best: prev, isNew: false };
}
