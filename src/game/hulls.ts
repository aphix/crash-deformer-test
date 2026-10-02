/** The car's SAT hull data (body frame): the deform context reads it, the vehicle and contact contexts use it. */

/** Tight cabin hulls, split L/R so a corner hit is not a full-width box. */
export type Hull = { cx: number; cz: number; hx: number; hz: number };
export const HULLS: Hull[] = [
  { cx: -0.38, cz: 1.22, hx: 0.34, hz: 0.34 },
  { cx: 0.38, cz: 1.22, hx: 0.34, hz: 0.34 },
  { cx: 0, cz: 0.12, hx: 0.86, hz: 0.92 },
  { cx: -0.38, cz: -1.22, hx: 0.34, hz: 0.34 },
  { cx: 0.38, cz: -1.22, hx: 0.34, hz: 0.34 },
];

/** Bumper-inclusive hulls, also L/R split so SAT contact sits on the hit corner. */
export const CRUSH_HULLS: Hull[] = [
  { cx: -0.42, cz: 1.72, hx: 0.36, hz: 0.5 },
  { cx: 0.42, cz: 1.72, hx: 0.36, hz: 0.5 },
  { cx: 0, cz: 0.12, hx: 0.86, hz: 0.92 },
  { cx: -0.42, cz: -1.6, hx: 0.36, hz: 0.58 },
  { cx: 0.42, cz: -1.6, hx: 0.36, hz: 0.58 },
];
