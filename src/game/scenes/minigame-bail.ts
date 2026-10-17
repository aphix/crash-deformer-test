/**
 * The Long jump's timed bail: the player presses the Boost control (the only meaning it has there) as the car meets the barrier, and
 * how close the press is to the hit sets the launch angle of the thrown driver. Pure, in game (sim) seconds: the engine stamps each
 * press and the hit and reads back the verdict. Ragdoll-side only: the sim's ejection is unchanged.
 *
 * Offsets are press minus hit: negative is early, positive late. A press more than `BAIL_WINDOW_SECONDS` before the hit is a wasted
 * bail. The throw is held up to `BAIL_WINDOW_SECONDS` after the hit for a late press, and goes without a bail when none comes.
 */

import { detSin } from "../kernel/physics-core.js";

/** How far from the hit (s) a press still counts; the throw waits this long after the hit for a late one. A quarter of a second is two or three beats of the barrier's approach in the slow-mo before the hit: easy to land inside, hard to land in the middle. */
export const BAIL_WINDOW_SECONDS = 0.25;

/** A press this close to the hit (s) is a perfect bail: the launch angle is the best one, with no fade. About two frames at 60 Hz, a press a good player can repeat. */
export const BAIL_PERFECT_SECONDS = 0.03;

/**
 * The launch's elevation (deg) at the two ends of the fade. The range of a throw at speed v is v^2 sin(2 elevation) / g, so 45 is the
 * longest throw. A flatter throw than 30 skims and skips on the sand, so where it rests is a lottery (measured: a 15 degree throw that
 * lands at 55 m rests anywhere from 64 to 93 m); from 30 up a throw rests within a few metres of where it lands.
 */
export const BAIL_ELEVATION_DEGREES = { none: 30, perfect: 45 } as const;

/** A run with no bail lands this share of a perfect bail's range (mid-field, about 50 m of 100). */
export const BAIL_NO_PRESS_RANGE_SHARE = 0.5;

const DEGREES_TO_RADIANS = Math.PI / 180;

type BailKind = "perfect" | "early" | "late" | "tooEarly" | "tooLate" | "none";

/** What a bail was: its kind, the press minus the hit in seconds (null when there was no press), and the share of the best launch it earned. */
export type BailVerdict = { kind: BailKind; offsetSeconds: number | null; quality: number };

/** The verdict of a press `offsetSeconds` from the hit (null: no press). The quality is 1 inside the perfect band and falls in a straight line to 0 at the window's edge. */
export function bailVerdict(offsetSeconds: number | null): BailVerdict {
  if (offsetSeconds === null) return { kind: "none", offsetSeconds: null, quality: 0 };
  const distance = Math.abs(offsetSeconds);
  if (distance <= BAIL_PERFECT_SECONDS) return { kind: "perfect", offsetSeconds, quality: 1 };
  if (distance >= BAIL_WINDOW_SECONDS) return { kind: offsetSeconds < 0 ? "tooEarly" : "tooLate", offsetSeconds, quality: 0 };
  const quality = 1 - (distance - BAIL_PERFECT_SECONDS) / (BAIL_WINDOW_SECONDS - BAIL_PERFECT_SECONDS);
  return { kind: offsetSeconds < 0 ? "early" : "late", offsetSeconds, quality };
}

/** The launch a bail earns, on top of a base release (`THROW_BOOST.longJump`): its forward scale and the elevation (rad) the whole release is aimed at. */
type BailRelease = { forward: number; upward: number; elevation: number | null };

/**
 * The release a bail of `quality` earns on top of `base`. The elevation runs in a straight line from `BAIL_ELEVATION_DEGREES.none` to
 * the perfect one; the release speed is scaled so the throw's range (speed squared times sin(2 elevation)) runs in a straight line from
 * `BAIL_NO_PRESS_RANGE_SHARE` of the perfect throw's to all of it: the metres fade evenly with the quality, whatever the angle does.
 */
export function bailRelease(base: BailRelease, quality: number): BailRelease {
  const elevation = (BAIL_ELEVATION_DEGREES.none + quality * (BAIL_ELEVATION_DEGREES.perfect - BAIL_ELEVATION_DEGREES.none)) * DEGREES_TO_RADIANS;
  const rangeShare = BAIL_NO_PRESS_RANGE_SHARE + quality * (1 - BAIL_NO_PRESS_RANGE_SHARE);
  return { forward: base.forward * Math.sqrt(rangeShare / detSin(2 * elevation)), upward: base.upward, elevation };
}

/** One attempt's bail: the first press, the hit, and the verdict once the throw has gone. */
export class LongJumpBail {
  private pressedAt: number | null = null;
  private hitAt: number | null = null;
  private settled: BailVerdict | null = null;

  /** A new attempt: no press, no hit, no verdict. */
  reset(): void {
    this.pressedAt = null;
    this.hitAt = null;
    this.settled = null;
  }

  /** The verdict, once the throw has gone; null before. A first press after the throw makes it `tooLate`. */
  get verdict(): BailVerdict | null {
    return this.settled;
  }

  /** The bail has been pressed this attempt. */
  get pressed(): boolean {
    return this.pressedAt !== null;
  }

  /** The throw is waiting for a late press. */
  get holding(): boolean {
    return this.hitAt !== null && this.settled === null;
  }

  /** A press at game time `now`; only the first of an attempt counts. */
  press(now: number): void {
    if (this.pressedAt !== null) return;
    this.pressedAt = now;
    if (this.settled !== null && this.hitAt !== null) this.settled = bailVerdict(now - this.hitAt);
  }

  /** The barrier hit threw the driver at game time `now`; only the first of an attempt counts. */
  hit(now: number): void {
    this.hitAt ??= now;
  }

  /** The verdict the held throw launches with at game time `now`, or null while it waits for a late press. */
  launchDue(now: number): BailVerdict | null {
    if (this.hitAt === null || this.settled !== null) return null;
    if (this.pressedAt !== null) {
      this.settled = bailVerdict(this.pressedAt - this.hitAt);
      return this.settled;
    }
    if (now - this.hitAt < BAIL_WINDOW_SECONDS) return null;
    this.settled = bailVerdict(null);
    return this.settled;
  }
}
