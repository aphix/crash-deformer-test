import type { CSSProperties } from "react";

/** Boost level at which the bottle's glow is full (of the soft glow): a burst of more than a quarter second is in it. */
const NITRO_USABLE = 0.15;
/** The glow level (0..1) of a full, idle meter; burning is 1. */
const SOFT = 0.6;

/**
 * How bright a boost meter glows, 0..1: it grows with the meter's fill up to `SOFT` (a burst of more than a quarter second in it),
 * and the boost's thrust (0..1, ramped by the car) lifts it from there to 1; the element's CSS transition eases it further.
 */
function nitroGlowLevel(boost: number, boosting: number): number {
  const idle = SOFT * Math.min(1, boost / NITRO_USABLE);
  return idle + (1 - idle) * boosting;
}

/**
 * The boost meter's glow for the bottle (a shadow over its border one) and the compact bar (a drop shadow): a continuous
 * function of `nitroGlowLevel`, not three classes (masterclass 23:34); undefined for a car with no nitrous.
 */
export function nitroGlowStyle(shape: "bottle" | "bar", boost: number | null, boosting: number): CSSProperties | undefined {
  if (boost === null) return undefined;
  const level = nitroGlowLevel(boost, boosting);
  if (shape === "bar") return { filter: `drop-shadow(0 0 ${(8 * level).toFixed(2)}px var(--color-accent))` };
  const spread = (0.25 * Math.max(0, level - SOFT)) / (1 - SOFT);
  return { boxShadow: `var(--shadow-border), 0 0 ${(1.4 * level).toFixed(2)}em ${spread.toFixed(2)}em var(--color-scene-race)` };
}
