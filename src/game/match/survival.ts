import { detCos, detSin } from "../kernel/physics-core.js";

/**
 * Survival's own rules (Driver 2's mode; docs/SURVIVAL.md). The race stack runs the rest: `RaceSession` with its `survival`
 * option (the BUST rule at this hold time, no laps), `judge` (driver out / engine dead / flipped), the pack in `ai/hunter.ts`.
 */
export const SURVIVAL = {
  /** Seconds held slow beside a chasing cop before the bust: the owner's "10-15 seconds". */
  bustTime: 12,
  /**
   * The humans of a hosted run start abreast on the course's start anchor, `humanGap` m apart, four to a row (the first on the anchor
   * itself, then one to its right, one to its left, one two to the right); each further row stands `rowGap` m ahead (the cops' formation is behind the anchor).
   */
  humanGap: 4,
  rowGap: 8,
} as const;

const LANES = [0, 1, -1, 2] as const;

/** Where human `k` (0-based, in the order the run seats them) starts, given the course's start anchor (yaw 0 faces +z). */
export function humanSlot(start: { x: number; z: number; yaw: number }, k: number): { x: number; z: number; yaw: number } {
  const ahead = Math.floor(k / LANES.length) * SURVIVAL.rowGap;
  const lateral = LANES[k % LANES.length]! * SURVIVAL.humanGap;
  const fx = detSin(start.yaw);
  const fz = detCos(start.yaw);
  return { x: start.x + fx * ahead + fz * lateral, z: start.z + fz * ahead - fx * lateral, yaw: start.yaw };
}

/** A finished run's time against the best before it (`prev`, null: none): the new best, and whether this run set it. */
export function settleRun(prev: number | null, time: number): { best: number; isNew: boolean } {
  return prev === null || time > prev ? { best: time, isNew: true } : { best: prev, isNew: false };
}
