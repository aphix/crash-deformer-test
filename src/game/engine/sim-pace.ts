import { physicsSlice } from "../contact/sat.ts";

/** Steps one frame may run before it gives up catching the sim up to its time. */
const MAX_STEPS = 8;
/** Sim seconds still owed under this (1 µs) are float noise, not a step. */
const EPS = 1e-6;
/** The slowest time scale that still shortens a step with it (`SimPacer.run`). */
const MIN_SCALE = 1 / 64;
/** Wall ms a frame may spend stepping (the engine's deadline is this far from the frame's first step). */
export const PACE_BUDGET_MS = 8;
/** The shortest step (s) the pacer takes on a device that keeps up, and the one it falls back to when it doesn't. */
const FINE_SLICE = 1 / 240;
const COARSE_SLICE = 1 / 120;
/** Go coarse when a frame's fine steps are predicted to take more than this share of the budget; come back under this share. */
const COARSE_ABOVE = 0.9;
const FINE_BELOW = 0.5;
/** Wall seconds a mode holds before it may change, so one slow frame never flaps it. */
const DWELL = 1;
/** A step's cost and a frame's demand join their running means at this weight, a sample counting for at most this many means: a hitch (a GC pause, a long frame) moves a mean a little, a slow device all the way. */
const MEAN_WEIGHT = 0.1;
const MEAN_CAP = 2;

/**
 * The sim's clock against the frames'. Each frame's sim time (`simDt`) is stepped in whole slices of the same size, the
 * last one running on past the frame's time by up to one slice: the sim stands ahead of what is drawn, and `PoseBlend`
 * draws the frame's time inside that last step (`alpha`). A frame's pose is then the sim's own motion at the frame's
 * time whatever the display rate or its jitter (no short remainder steps, so what the sim does no longer depends on where
 * the frames fall), and a lower display or sim rate shows no stepping.
 *
 * A slice is `physicsSlice`'s (at least 1/240 s, at most 7 cm of travel) shortened by the time scale: in slow motion each
 * step covers less sim time, so the wall-clock step rate holds and a crush still animates every frame.
 *
 * When a frame cannot afford its steps (`MAX_STEPS`, or `deadline` passed after two; the caller counts the deadline from the
 * frame's first step, so a frame that began late still steps its own time): it stops, and the sim time it did not step is given up, never carried to the next frame to be caught up in a burst. An overloaded sim therefore runs
 * slow by the same share every frame, and one late frame costs that frame alone. What was given up is counted in `lost`.
 *
 * `adaptive` spends less before it gives time up. A step costs about the same at 1/240 s as at 1/120 s (contact is solved at its own
 * rate inside it, `stepWorld`), so when the mean step cost says a frame's 1/240 s steps would not fit `PACE_BUDGET_MS`, the
 * floor of the slice goes to 1/120 s: half the steps per sim second, the same sim speed on a device twice as slow. It comes back
 * when the fine steps would fit with room. The mode is chosen once per frame, before its first step, and held for `DWELL` sim
 * seconds; the cost is measured on the pacer's own steps, so a device that keeps up never leaves 1/240 s.
 */
export class SimPacer {
  /** Sim seconds still to step: at most `EPS` after a frame, below `-lastStep` when the frame ran dry. */
  private owed = 0;
  private lastStep = FINE_SLICE;
  /** Where the frame's time sits between the sim's last two states: 0 the one before the last step, 1 the one it left. */
  alpha = 1;
  /** Sim seconds given up so far (a frame stopped before it caught up). */
  lost = 0;
  /** Frames stopped early so far. */
  cut = 0;
  /** Steps the last frame ran. */
  steps = 0;
  /** Steps taken so far, and how many of them at the coarse floor. */
  total = 0;
  coarseSteps = 0;
  /** The slice floor is 1/120 s right now. */
  coarse = false;
  /** The slice (s) the 1/240 s floor takes for the frame under way, whichever floor steps: the longest slice a hit about to land is solved in (`World.fine`), so the coarse floor's hit lands on the slices the fine floor takes. */
  fine = FINE_SLICE;
  /** The bench page's A/B: true holds the 1/120 s floor, false the 1/240 s, whatever the step costs; null (the engine's own) adapts. */
  pin: boolean | null = null;
  /** Running means: wall ms of a step, and the 1/240 s steps a frame calls for (0 until the first). */
  private cost = 0;
  private need = 0;
  private dwell = 0;
  private readonly adaptive: boolean;
  private readonly now: () => number;

  /** `now` is the clock the step costs and the deadline are read from (ms). */
  constructor(adaptive = false, now: () => number = () => performance.now()) {
    this.adaptive = adaptive;
    this.now = now;
  }

  /**
   * One frame: `simDt` sim seconds (the frame's wall time at the time scale `scale`) in steps of `vmax`'s slice, each handed
   * to `step`. `deadline` (a `now()` ms) ends the loop once two steps have run.
   */
  run(simDt: number, scale: number, vmax: number, deadline: number, step: (h: number) => void): void {
    const k = Math.min(1, Math.max(scale, MIN_SCALE));
    if (this.pin !== null) this.coarse = this.pin;
    else if (this.adaptive) this.choose(simDt / k, simDt / (physicsSlice(Infinity, vmax, FINE_SLICE) * k));
    // float32, as the highlight recorder stores it: a replay runs the live step.
    this.fine = Math.fround(physicsSlice(Infinity, vmax, FINE_SLICE) * k);
    const h = this.coarse ? Math.fround(physicsSlice(Infinity, vmax, COARSE_SLICE) * k) : this.fine;
    this.owed += simDt;
    let steps = 0;
    let t = this.now();
    while (this.owed > EPS && steps < MAX_STEPS) {
      step(h);
      this.lastStep = h;
      this.owed -= h;
      steps++;
      const t1 = this.now();
      this.cost = smooth(this.cost, t1 - t);
      t = t1;
      if (steps >= 2 && this.owed > EPS && t1 > deadline) break;
    }
    this.steps = steps;
    this.total += steps;
    if (this.coarse) this.coarseSteps += steps;
    if (this.owed > EPS) {
      this.lost += this.owed;
      this.cut++;
      this.owed = 0;
    }
    this.alpha = Math.min(1, Math.max(0, 1 + this.owed / this.lastStep));
  }

  /** Pick the slice floor for this frame: `wall` is its wall time (s), `need` the steps that time calls for at 1/240 s. */
  private choose(wall: number, need: number): void {
    this.need = smooth(this.need, need);
    this.dwell += wall;
    if (this.cost === 0 || this.dwell < DWELL) return;
    const coarse = this.need * this.cost > (this.coarse ? FINE_BELOW : COARSE_ABOVE) * PACE_BUDGET_MS;
    if (coarse === this.coarse) return;
    this.coarse = coarse;
    this.dwell = 0;
  }
}

/** `mean` moved toward `sample` at `MEAN_WEIGHT`, a sample counting for at most `MEAN_CAP` means (0 = no mean yet: the sample is it). */
function smooth(mean: number, sample: number): number {
  return mean === 0 ? sample : mean + MEAN_WEIGHT * (Math.min(sample, mean * MEAN_CAP) - mean);
}
