import { hypot2 } from "../kernel/physics-core.js";
import { CAR_HALF, type DeformableCar } from "../vehicle/car.ts";
import type { PredictedHit } from "../scenes/engine-props.ts";

/** The sandbox crash's phases: driving in, the hit, the slow-mo look, the wreck settling at 1×. */
export type CrashPhase = "approach" | "impact" | "slowmo" | "aftermath";

/** Auto slow-mo's time scale from the hit on. */
const IMPACT_SCALE = 0.032;
/** Reduced motion: a gentler slow-mo, and held for less. */
const CALM_SCALE = 0.16;
/** Wall seconds of slow-mo before the hand-back to 1× (`CALM_HOLD` under reduced motion). */
export const SLOMO_HOLD = 6.5;
const CALM_HOLD = 1.4;
/**
 * Wall seconds a highlight reel's slow-mo holds past the cars meeting, and past each driver thrown out while it runs (owner,
 * 2026-10-07: collisions "a little longer", ejections "about twice as long", in the viewer's real time): +40 % and 2× of the
 * 4.50 s and 3.65 s the browser timed on main. It hands back to 1× when the last of them is up.
 */
export const CONTACT_HOLD = 6.3;
export const THROW_HOLD = 7.3;
/** Sim seconds a reel's slow-mo plays over a thrown driver's hold: how far past his throw a recording must run to show it whole. */
export const THROW_HOLD_SIM = THROW_HOLD * IMPACT_SCALE;
/**
 * The auto slow-mo starts easing in this long (sim s) before contact: the sandbox from its contact ETA, a highlight reel
 * before the recorded impact. A driver's reaction time (owner, 2026-10-09: 150–250 ms), game time, so the slow-mo's own
 * wall time for it is longer; the ease reaches the slow scale by the hit (`easeTimeScale`).
 */
export const PRE_IMPACT_LEAD = 0.2;
/** Wall s between the sparks and dust the engine and the reel put at the predicted contact point while the slow-mo eases in, before the cars meet. */
export const FUDGE_GAP = 0.08;
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
  /** Wall seconds after the hit at which the slow-mo hands back to 1×: `SLOMO_HOLD`, or what a highlight reel's clip sets. */
  hold: number;
  /**
   * Sim second by which the hit that dropped the slow-mo in before it (`preImpact`) is due: its predicted time plus one
   * step. NaN: none pending; Infinity: one just failed to come, so the same pass doesn't slow again.
   */
  preImpactBy: number;
};

export function phaseClock(): PhaseClock {
  return { phase: "approach", timeScale: 1, targetScale: 1, wallSinceImpact: 0, userTimeScale: null, reduceMotion: false, slomoAt: 0, hold: SLOMO_HOLD, preImpactBy: NaN };
}

/** Auto slow-mo's scale for this clock. */
export function impactScale(c: PhaseClock): number {
  return c.reduceMotion ? CALM_SCALE : IMPACT_SCALE;
}

/** How near the slow scale (× it) the time scale is when the pre-impact ease has run its `PRE_IMPACT_LEAD` (and `beginImpact` snaps the rest). */
const REACH = 1.2;

/**
 * The rate (1/s of wall) at which the time scale eases from 1× down to `target` so it is within `REACH`× of it as the
 * `PRE_IMPACT_LEAD` sim s run out. An exponential ease at rate k covers (target·ln(1/r) + (1 − target)(1 − r)) / k sim s
 * while the scale falls to `REACH`·target, r = what is left of the drop then.
 */
function onsetRate(target: number): number {
  const r = Math.min(0.5, Math.max(1e-6, ((REACH - 1) * target) / (1 - target)));
  return (target * Math.log(1 / r) + (1 - target) * (1 - r)) / PRE_IMPACT_LEAD;
}

/**
 * Ease the time scale toward its target: into the auto slow-mo before a hit (approach, the user's scale not set) at the
 * rate that reaches the slow scale by the hit, whatever the frame rate; fast into slow-mo after it, slow back out in the aftermath.
 */
export function easeTimeScale(c: PhaseClock, wallDt: number): void {
  if (c.phase === "approach" && c.userTimeScale == null && c.targetScale < c.timeScale) {
    c.timeScale += (c.targetScale - c.timeScale) * (1 - Math.exp(-wallDt * onsetRate(c.targetScale)));
    return;
  }
  c.timeScale += (c.targetScale - c.timeScale) * Math.min(1, wallDt * (c.phase === "aftermath" ? 1.15 : 3.2));
}

/** The hit: the clock restarts and time drops to the user's fixed scale, auto slow-mo (at once, or `slomoAt` on), or 1×. */
export function beginImpact(c: PhaseClock, autoSlomo: boolean): void {
  c.phase = "impact";
  c.wallSinceImpact = 0;
  c.preImpactBy = NaN;
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
 * The auto slow-mo before a hit, once a frame in approach (`CrashEngine.maybePreSlowmo`): it starts easing in (`easeTimeScale`
 * reaches the slow scale as the hit lands) when the contact predicted `eta` sim s ahead is within `lead` sim s, or is held for
 * his exit (`THROW_ONSET`) when the hit will throw a driver (`throwing`, asked only then). `simT`: the sim clock; `step`: one
 * sim step. A hit still missing one step past its predicted time (a flick that misses, a pair that passes or turns apart)
 * hands time back to 1×, and the slow-mo waits for a fresh prediction: one that first went out of reach.
 */
export function preImpact(c: PhaseClock, eta: number, simT: number, lead: number, step: number, throwing: () => boolean): void {
  const scale = impactScale(c);
  if (c.phase !== "approach" || c.userTimeScale != null) return;
  if (c.targetScale <= scale || c.slomoAt > 0) {
    if (simT > c.preImpactBy) {
      c.timeScale = 1;
      c.targetScale = 1;
      c.slomoAt = 0;
      c.preImpactBy = Infinity;
    }
    return;
  }
  if (!(eta <= lead)) {
    c.preImpactBy = NaN;
    return;
  }
  if (c.preImpactBy === Infinity) return;
  c.preImpactBy = simT + eta + step;
  if (throwing()) {
    c.slomoAt = THROW_ONSET;
    return;
  }
  // The ease takes it from here: `timeScale` stays where it is.
  c.targetScale = scale;
}

/**
 * Sim seconds until the first pair of `cars` closing in plan meets (each footprint taken along the line between their
 * centres; `refreshBasis` current), Infinity if none: the hit `preImpact` slows for. A pair a car's height apart
 * vertically passes over and never counts: a Lab throw arcing over the house of cards' lower car to its top one held
 * the pre-impact slow-mo (3 %) for 6 s of wall before the real hit. `hit`, when given, gets where that first pair's
 * footprints touch (the near car's footprint edge as it will be then) and their line.
 */
export function pairEta(cars: readonly DeformableCar[], hit?: PredictedHit): number {
  let eta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i]!;
      const b = cars[j]!;
      if (Math.abs(a.group.position.y - b.group.position.y) >= 2 * CAR_HALF.y) continue;
      const dx = b.group.position.x - a.group.position.x;
      const dz = b.group.position.z - a.group.position.z;
      const dist = hypot2(dx, dz);
      if (dist <= 0.001) continue;
      const nx = dx / dist;
      const nz = dz / dist;
      const closing = -((b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz);
      if (closing <= 0.35) continue;
      const halfA = Math.abs(a.right.x * nx + a.right.z * nz) * CAR_HALF.x + Math.abs(a.forward.x * nx + a.forward.z * nz) * CAR_HALF.z;
      const halfB = Math.abs(b.right.x * nx + b.right.z * nz) * CAR_HALF.x + Math.abs(b.forward.x * nx + b.forward.z * nz) * CAR_HALF.z;
      const t = Math.max(0, dist - halfA - halfB) / closing;
      if (t < eta && hit) {
        hit.x = a.group.position.x + a.velocity.x * t + nx * halfA;
        hit.y = (a.group.position.y + b.group.position.y) / 2 + 0.4;
        hit.z = a.group.position.z + a.velocity.z * t + nz * halfA;
        hit.nx = nx;
        hit.nz = nz;
      }
      eta = Math.min(eta, t);
    }
  }
  return eta;
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
    if (c.wallSinceImpact > (c.reduceMotion ? CALM_HOLD : c.hold)) {
      if (c.userTimeScale == null) c.targetScale = 1;
      c.phase = "aftermath";
    }
  } else if (c.wallSinceImpact > 8.2 && c.userTimeScale == null) {
    c.targetScale = 1;
  }
}
