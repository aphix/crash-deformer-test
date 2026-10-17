/** The slots of a step's time, in the order the step reaches them (`PHASE_NAMES` names them on the bench card). */
export const PHASE = { drive: 0, plan: 1, integrate: 2, wreck: 3, pairs: 4, structure: 5, course: 6, bake: 7, rules: 8, settle: 9 } as const;
export const PHASE_NAMES = ["drive", "plan", "integrate", "wreck", "pairs", "structure", "course", "bake", "rules", "settle"] as const;
export const PHASE_COUNT = PHASE_NAMES.length;

/** The slots of the step's work counters: amounts, not times. */
export const WORK = { slices: 0, liveCarSlices: 1, wreckCarSlices: 2, asleepCarSlices: 3, pairTests: 4, pairContacts: 5, partContacts: 6 } as const;
export const WORK_NAMES = ["slices", "liveCarSlices", "wreckCarSlices", "asleepCarSlices", "pairTests", "pairContacts", "partContacts"] as const;
export const WORK_COUNT = WORK_NAMES.length;

/**
 * Where the sim's main-thread time goes, by phase of a step. Each `lap` reads the clock once and adds the time since the
 * previous `lap` to its slot, so the phases tile the step with one clock read per boundary. A browser that rounds the clock
 * (Firefox: 1 ms) still gives unbiased sums over thousands of laps (a phase's start is uncorrelated with the tick), which is why
 * the slots are sums and never per-call maxima. Off (`on` false, every run but a bench's measured window) a `lap` is one branch.
 * The work counters are plain counts, kept always: one add each.
 */
export class SimPhases {
  on = false;
  last = 0;
  readonly ms = new Float64Array(PHASE_COUNT);
  readonly work = new Float64Array(WORK_COUNT);
}

/** Starts the laps: the first `lap` after it is the time since now. */
export function startLaps(phases: SimPhases): void {
  if (phases.on) phases.last = performance.now();
}

/** Adds the time since the last `lap` (or `startLaps`) to `slot`. */
export function lap(phases: SimPhases, slot: number): void {
  if (!phases.on) return;
  const now = performance.now();
  phases.ms[slot] = phases.ms[slot]! + (now - phases.last);
  phases.last = now;
}
