/** Spokes on the drawn rim: the wheel looks the same every `SPOKE_PERIOD` rad. */
const SPOKES = 5;
export const SPOKE_PERIOD = (2 * Math.PI) / SPOKES;
/** The rim's spokes start to smear at this share of a spoke period turned in one drawn frame, and are gone by the second. */
const SMEAR_FROM = 0.2;
const SMEAR_FULL = 0.4;

/**
 * How much of the spokes' look is smeared into the disc behind them (0 sharp .. 1 smeared) for a wheel that turned
 * `step` rad between two drawn frames. A rim that repeats every 72° shows its true turn only below half a period: past
 * that the eye reads the nearest spoke, so at 60 Hz a sedan above 12 m/s looks slow or turning backwards. A camera's
 * shutter smears such a rim into a soft disc; this is that, fading in before the spokes start to lie.
 */
export function spokeSmear(step: number): number {
  const t = Math.min(1, Math.max(0, (Math.abs(step) / SPOKE_PERIOD - SMEAR_FROM) / (SMEAR_FULL - SMEAR_FROM)));
  return t * t * (3 - 2 * t);
}
