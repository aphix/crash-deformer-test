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
};

export function phaseClock(): PhaseClock {
  return { phase: "approach", timeScale: 1, targetScale: 1, wallSinceImpact: 0, userTimeScale: null, reduceMotion: false };
}

/** Auto slow-mo's scale for this clock. */
export function impactScale(c: PhaseClock): number {
  return c.reduceMotion ? CALM_SCALE : IMPACT_SCALE;
}

/** Ease the time scale toward its target: fast into slow-mo, slow back out in the aftermath. */
export function easeTimeScale(c: PhaseClock, wallDt: number): void {
  c.timeScale += (c.targetScale - c.timeScale) * Math.min(1, wallDt * (c.phase === "aftermath" ? 1.15 : 3.2));
}

/** The hit: the clock restarts and time drops to the user's fixed scale, auto slow-mo, or 1×. */
export function beginImpact(c: PhaseClock, autoSlomo: boolean): void {
  c.phase = "impact";
  c.wallSinceImpact = 0;
  if (c.userTimeScale != null) {
    c.targetScale = c.userTimeScale;
    c.timeScale = c.userTimeScale;
  } else if (autoSlomo) {
    const scale = impactScale(c);
    c.targetScale = scale;
    if (c.timeScale > scale * 1.15) c.timeScale = scale;
  } else {
    c.targetScale = 1;
    c.timeScale = 1;
  }
}

/** One wall frame after the hit: impact → slowmo after 0.12 s → aftermath after the hold, handing time back to 1×. */
export function stepPhase(c: PhaseClock, wallDt: number): void {
  if (c.phase === "approach") return;
  c.wallSinceImpact += wallDt;
  if (c.phase === "impact") {
    if (c.wallSinceImpact > 0.12) c.phase = "slowmo";
  } else if (c.phase === "slowmo") {
    if (c.wallSinceImpact > (c.reduceMotion ? CALM_HOLD : SLOMO_HOLD)) {
      if (c.userTimeScale == null) c.targetScale = 1;
      c.phase = "aftermath";
    }
  } else if (c.wallSinceImpact > 8.2 && c.userTimeScale == null) {
    c.targetScale = 1;
  }
}
