import { STRAIGHT_CURV } from "./constants.ts";
import { BRAKE_SHARE, CORNER_MARGIN, sampleAt } from "./race-ai.ts";
import type { TrackPath } from "../world/track.ts";
import { cornerSpeed, type ClassStats } from "../vehicle/vehicle-classes.ts";

/** Metres between the look-ahead's samples (the AI's own spacing). */
const CUE_STEP = 3;
/** Extra look-ahead (m) beyond the planned braking distance. */
const CUE_MARGIN = 12;
/** The share of the allowed speed the car may be over it before the cue is full: the tint grows from 0 at the plan's speed to 1 this far over it (masterclass 23:34, fade over a parameter). */
const CUE_BAND = 0.3;

/**
 * The braking cue (0..1): a car `along` m/s forward at `s` m along `pp` is going faster than the AI's braking plan allows for
 * a corner ahead (`plan`: the corner speed there plus what `BRAKE_SHARE` of the class brake sheds over the distance). 0 at or
 * under the plan; it rises with the overshoot, linearly to 1 at `CUE_BAND` over it, for the worst corner in reach.
 */
export function brakeCueAt(pp: TrackPath, cls: ClassStats, s: number, along: number, grip: number): number {
  if (along <= 0) return 0;
  const decel = cls.brake * BRAKE_SHARE;
  const reach = (along * along) / (2 * decel) + CUE_MARGIN;
  let cue = 0;
  for (let d = 0; d <= reach; d += CUE_STEP) {
    const curv = Math.abs(pp.curv[sampleAt(pp, s + d)]!);
    if (curv <= STRAIGHT_CURV) continue;
    const corner = cornerSpeed(cls, CORNER_MARGIN / curv, grip);
    const allowed = Math.sqrt(corner * corner + 2 * decel * d);
    cue = Math.max(cue, (along / allowed - 1) / CUE_BAND);
  }
  return Math.min(1, cue);
}
