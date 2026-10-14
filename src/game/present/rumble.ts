import { LANDING } from "./landing.ts";
import { joltLevel } from "./engine-camera.ts";
import type { Rumble } from "../vehicle/gamepad.ts";

/**
 * The pad's rumble for what the driver feels: each rule fills `out` (a pooled `Rumble`) and says whether there is an effect to play.
 * Impacts scale by the closing speed the camera's jolt scales by (`joltLevel`), so a hit the view ignores the pad ignores too.
 */

/** A hit at `closing` m/s: a sharp tick from the light motor at a nudge, the heavy motor and a longer effect (80–400 ms) as it nears a head-on. */
export function impactRumble(closing: number, out: Rumble): boolean {
  const t = joltLevel(closing);
  if (t <= 0) return false;
  out.strong = t;
  out.weak = 0.4 + 0.6 * t;
  out.ms = 80 + 320 * t;
  return true;
}

/** Fall speed (m/s) past the landing floor (`LANDING.fall`) at which a landing is as hard as it gets. */
const LAND_SPAN = 10;

/** A landing that fell `fall` m/s (a `LandingWatch` landing, so `fall` is above its floor): a thud that grows with the drop, 120–380 ms. */
export function landingRumble(fall: number, out: Rumble): void {
  const t = Math.min(1, Math.max(0, (fall - LANDING.fall) / LAND_SPAN));
  out.strong = 0.3 + 0.7 * t;
  out.weak = 0.3 + 0.5 * t;
  out.ms = 120 + 260 * t;
}

/** Slide (`drive.slide`, 0–1) under which the pad stays quiet. */
const SLIDE_FROM = 0.3;
/** How often (s) the engine re-sends the slide's effect: a little under its length, so it runs on unbroken. */
export const SLIDE_EVERY = 0.1;

/** A slide's light buzz, 0.1–0.25 of the light motor only, nothing under `SLIDE_FROM`. Each effect lasts `SLIDE_EVERY` plus a margin. */
export function slideRumble(slide: number, out: Rumble): boolean {
  if (slide <= SLIDE_FROM) return false;
  out.strong = 0;
  out.weak = 0.1 + (0.15 * (slide - SLIDE_FROM)) / (1 - SLIDE_FROM);
  out.ms = 150;
  return true;
}
