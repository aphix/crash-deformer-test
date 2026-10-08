import { hash01 } from "../kernel/scalar.ts";

export type Personality = {
  /** 0 … 1: how much this driver keeps the tail as its bumper and how early a crumpled nose turns it round. */
  reverse: number;
  /** Seconds of throttle without motion before backing out. */
  patience: number;
  /** Seconds a target is held before a merely-better one may replace it. */
  commit: number;
  /** Tie-break side for flanking and unsticking, so a field never mirrors itself. */
  side: number;
  /** Intercept lead multiplier. */
  lead: number;
  /** Throttle used once lined up. */
  cruise: number;
  /** Seconds braking and lining up at the horn; 0 = charges straight away. */
  hold: number;
};

/** Same id → same driver, every match. Aggression is not a trait: the match rolls it (`setAggression`). */
export function personality(id: number): Personality {
  return {
    reverse: hash01(id, 2),
    patience: 0.55 + 0.4 * hash01(id, 3),
    commit: 1 + 2 * hash01(id, 4),
    side: hash01(id, 5) < 0.5 ? -1 : 1,
    lead: 0.75 + 0.4 * hash01(id, 6),
    cruise: 0.82 + 0.18 * hash01(id, 7),
    hold: hash01(id, 9) < 0.45 ? 0 : 0.35 + 1.1 * hash01(id, 10),
  };
}
