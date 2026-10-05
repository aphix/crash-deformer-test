import { DERBY_RULES } from "./derby-ai.ts";

/**
 * Scoot: a live car pacing back and forth in one spot without landing a hit (owner's derby capture
 * `derby-scoot-2026-10-04`: four live cars, 17-25 gear reversals in 12.8 s, 5-20 m net, no contact for 20 s).
 * A car's window is scooting when, over `WINDOW` s, its forward speed (read every `SAMPLE` s) changes
 * sign `REVERSALS` or more times past ±`DEAD` m/s, it ends within `REACH` m of where it began, and no hit
 * (`DerbyMatch.noteHit`) involved it from `HIT_PAD` s before to `HIT_PAD` s after. The same definition run on
 * the capture's 0.5 s samples flags 43 of its 50 contact-free car windows.
 */
export const SCOOT = { WINDOW: 10, SAMPLE: 0.5, STEP: 1, DEAD: 0.3, REVERSALS: 6, REACH: 12, HIT_PAD: 0.5, LIVE_MIN: 3, LIVE_MAX: 5 } as const;

type CarSample = { alive: boolean; x: number; z: number; fwd: number };

export type ScootShare = { windows: number; flagged: number };

/** Per-car samples every `SAMPLE` s and the match times of the hits that involved each car. */
export class ScootWatch {
  private readonly frames: CarSample[][] = [];
  private readonly times: number[] = [];
  private readonly hitAt: number[][];
  private next = 0;

  constructor(cars: number) {
    this.hitAt = Array.from({ length: cars }, () => []);
  }

  hit(a: number, b: number, t: number): void {
    this.hitAt[a]!.push(t);
    this.hitAt[b]!.push(t);
  }

  /** Whether `t` is the next sample time (start lights run on negative time and are not sampled). */
  due(t: number): boolean {
    return t >= this.next;
  }

  /** Take this step's sample (match time `t`, due), spaced `SAMPLE` s apart. */
  sample(t: number, cars: readonly CarSample[]): void {
    this.next = Math.max(this.next, 0) + SCOOT.SAMPLE;
    this.times.push(t);
    this.frames.push(cars.map((c) => ({ ...c })));
  }

  /** Car windows with 3-5 cars alive at their start (a late heat), and how many of them scoot. */
  share(): ScootShare {
    const per = Math.round(SCOOT.WINDOW / SCOOT.SAMPLE);
    const every = Math.round(SCOOT.STEP / SCOOT.SAMPLE);
    const out = { windows: 0, flagged: 0 };
    for (let a = 0; a + per < this.frames.length; a += every) {
      const b = a + per;
      const live = this.frames[a]!.filter((c) => c.alive).length;
      if (live < SCOOT.LIVE_MIN || live > SCOOT.LIVE_MAX) continue;
      for (let i = 0; i < this.hitAt.length; i++) {
        if (!this.whole(i, a, b)) continue;
        out.windows++;
        if (this.scoots(i, a, b)) out.flagged++;
      }
    }
    return out;
  }

  /** The car lived through frames a…b. */
  private whole(i: number, a: number, b: number): boolean {
    for (let k = a; k <= b; k++) if (!this.frames[k]![i]!.alive) return false;
    return true;
  }

  private scoots(i: number, a: number, b: number): boolean {
    const t0 = this.times[a]!;
    const t1 = this.times[b]!;
    let reversals = 0;
    let last = 0;
    for (let k = a; k <= b; k++) {
      const f = this.frames[k]![i]!.fwd;
      const sign = f > SCOOT.DEAD ? 1 : f < -SCOOT.DEAD ? -1 : 0;
      if (sign === 0) continue;
      if (last !== 0 && sign !== last) reversals++;
      last = sign;
    }
    if (reversals < SCOOT.REVERSALS) return false;
    const from = this.frames[a]![i]!;
    const to = this.frames[b]![i]!;
    if (Math.hypot(to.x - from.x, to.z - from.z) >= SCOOT.REACH) return false;
    return !this.hitAt[i]!.some((h) => h >= t0 - SCOOT.HIT_PAD && h <= t1 + SCOOT.HIT_PAD);
  }
}

/** A hit that counts as aggressive in the rules (`DERBY_RULES.hitSpeed`). */
export function aggressive(closing: number): boolean {
  return closing >= DERBY_RULES.hitSpeed;
}
