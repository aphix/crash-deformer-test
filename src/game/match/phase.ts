/** The sandbox crash's phases: driving in, the hit, the slow-mo look, the wreck settling at 1×. */
export type CrashPhase = "approach" | "impact" | "slowmo" | "aftermath";

/** Auto slow-mo's time scale from the hit on. */
const IMPACT_SCALE = 0.032;
/** Reduced motion: a gentler slow-mo, and held for less. */
const CALM_SCALE = 0.16;
/** Wall seconds of slow-mo before the hand-back to 1× (`CALM_HOLD` under reduced motion). */
const SLOMO_HOLD = 6.5;
const CALM_HOLD = 1.4;
/** Auto slow-mo starts this long (sim s) before contact: the sandbox from its contact ETA, a highlight reel before the recorded impact. */
export const PRE_IMPACT_LEAD = 0.07;
/**
 * Wall seconds a thrown driver's exit plays at 1× before the slow-mo: the owner's FlatOut onset (2026-10-02), so
 * nobody watches him slowly pass through the bonnet. Fleet head-ons judge the throw 17–50 ms into the hit.
 */
export const THROW_ONSET = 0.25;

/** The crash clock the engine and the headless harnesses step alike. */
export type PhaseClock = {
  phase: CrashPhase;
  timeScale: number;
  targetScale: number;
  /** Wall seconds since the hit (held at its last value in approach). */
  wallSinceImpact: number;
  /** The HUD's fixed time scale; null is automatic. */
  userTimeScale: number | null;
  reduceMotion: boolean;
  /**
   * Wall seconds after the hit at which the auto slow-mo starts, while a thrown driver's exit runs at 1×: set in
   * approach when the coming hit will throw one (`THROW_ONSET`), or by `holdForThrow`. 0: none pending.
   */
  slomoAt: number;
};

export function phaseClock(): PhaseClock {
  return { phase: "approach", timeScale: 1, targetScale: 1, wallSinceImpact: 0, userTimeScale: null, reduceMotion: false, slomoAt: 0 };
}

/** Auto slow-mo's scale for this clock. */
export function impactScale(c: PhaseClock): number {
  return c.reduceMotion ? CALM_SCALE : IMPACT_SCALE;
}

/** Ease the time scale toward its target: fast into slow-mo, slow back out in the aftermath. */
export function easeTimeScale(c: PhaseClock, wallDt: number): void {
  c.timeScale += (c.targetScale - c.timeScale) * Math.min(1, wallDt * (c.phase === "aftermath" ? 1.15 : 3.2));
}

/** The hit: the clock restarts and time drops to the user's fixed scale, auto slow-mo (at once, or `slomoAt` on), or 1×. */
export function beginImpact(c: PhaseClock, autoSlomo: boolean): void {
  c.phase = "impact";
  c.wallSinceImpact = 0;
  if (c.userTimeScale != null) {
    c.slomoAt = 0;
    c.targetScale = c.userTimeScale;
    c.timeScale = c.userTimeScale;
  } else if (autoSlomo && c.slomoAt === 0) {
    const scale = impactScale(c);
    c.targetScale = scale;
    if (c.timeScale > scale * 1.15) c.timeScale = scale;
  } else {
    if (!autoSlomo) c.slomoAt = 0;
    c.targetScale = 1;
    c.timeScale = 1;
  }
}

/**
 * A driver thrown out while the auto slow-mo runs (a later hit, or one nobody saw coming): 1× again for his exit,
 * the slow-mo back `THROW_ONSET` on.
 */
export function holdForThrow(c: PhaseClock): void {
  if (c.phase === "approach" || c.phase === "aftermath" || c.userTimeScale != null || c.targetScale >= 1) return;
  c.slomoAt = c.wallSinceImpact + THROW_ONSET;
  c.targetScale = 1;
  c.timeScale = 1;
}

/**
 * One wall frame after the hit: the held slow-mo drops in at `slomoAt`; impact → slowmo 0.12 s after the hit (or the
 * drop) → aftermath after the hold, handing time back to 1×.
 */
export function stepPhase(c: PhaseClock, wallDt: number): void {
  if (c.phase === "approach") return;
  c.wallSinceImpact += wallDt;
  if (c.slomoAt > 0 && c.wallSinceImpact >= c.slomoAt) {
    c.slomoAt = 0;
    if (c.userTimeScale == null && c.phase !== "aftermath") {
      c.targetScale = impactScale(c);
      c.timeScale = c.targetScale;
    }
  }
  if (c.phase === "impact") {
    if (c.wallSinceImpact > 0.12 && c.slomoAt === 0) c.phase = "slowmo";
  } else if (c.phase === "slowmo") {
    if (c.wallSinceImpact > (c.reduceMotion ? CALM_HOLD : SLOMO_HOLD)) {
      if (c.userTimeScale == null) c.targetScale = 1;
      c.phase = "aftermath";
    }
  } else if (c.wallSinceImpact > 8.2 && c.userTimeScale == null) {
    c.targetScale = 1;
  }
}
