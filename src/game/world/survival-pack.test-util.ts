import { chase, type Chase, type CopTamper, type Fleer } from "./survival-players.test-util.ts";
import { ARENA } from "./survival-arena.test-util.ts";

/**
 * The Survival pack chasing a scripted player in the closed arena (`survival-arena.test-util.ts`: Havana's plaza inside a square of its
 * own stucco, 160 m across): the player cannot leave, so the pack has to catch it. The formation is held until `release(seed)`, spread
 * evenly from `RELEASE_FIRST` to `RELEASE_LAST` over seeds 1-24, so each seed's pack meets the player somewhere else. A pool runs
 * `SEEDS` (every third of the 24: the same releases the 24-seed pools measured) and stops once its verdict is settled.
 */
export const ARENA_T = 120;
const RELEASE_FIRST = 8.1;
const RELEASE_LAST = 12.1;
const RELEASE_SPREAD = 24;
export const SEEDS = [1, 4, 7, 10, 13, 16, 19, 22];
/** The controls only show a bar can fail: a few seeds. */
export const CONTROL_SEEDS = [1, 4, 7];

/** The race second seed `seed`'s formation is let go. */
export const release = (seed: number): number => RELEASE_FIRST + ((RELEASE_LAST - RELEASE_FIRST) * (seed - 1)) / (RELEASE_SPREAD - 1);

/** Why `c` is not a run the pack ended (null: it is): still running, ended by something else (or by anything but `only`), or, when `packWins`, a run that ended itself with no powered cop touching. */
export function miss(c: Chase, packWins: boolean, by: number, only: string | null = null): string | null {
  if (!c.ended) return `still running after ${by} s (${c.touches} cop contacts, the last at ${c.lastTouch.toFixed(0)} s)`;
  if (c.cause !== "busted" && c.cause !== "wrecked") return `ended by ${c.cause}`;
  if (only !== null && c.cause !== only) return `ended ${c.cause}, not ${only}`;
  if (packWins && c.time - c.lastTouch >= 2) return `no cop touched the player in the last ${(c.time - c.lastTouch).toFixed(1)} s: it ended itself`;
  return null;
}

/** A pool of `fleer`'s runs over `seeds` against bar `bar` (runs the pack must end, as `only` when given): how many ran, and why each that the pack did not end was not. */
export function arena(fleer: Fleer, seeds: readonly number[], bar: number, tamper?: CopTamper, only: string | null = null): { ran: number; bad: string[] } {
  const bad: string[] = [];
  let ran = 0;
  for (const seed of seeds) {
    if (ran - bad.length >= bar || bad.length > seeds.length - bar) break;
    const at = release(seed);
    const why = miss(chase(fleer, seed, at + ARENA_T, ARENA, { tamper, release: at }), only === null, ARENA_T, only);
    if (why !== null) bad.push(`seed ${seed}, released at ${at.toFixed(1)} s: ${why}`);
    ran++;
  }
  return { ran, bad };
}
