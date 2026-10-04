import { physicsSlice } from "../contact/sat.ts";

/** Steps one frame may run before it gives up catching the sim up to its time. */
const MAX_STEPS = 8;
/** Sim seconds still owed under this (1 µs) are float noise, not a step. */
const EPS = 1e-6;
/** The slowest time scale that still shortens a step with it (`SimPacer.run`). */
const MIN_SCALE = 1 / 64;

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
 */
export class SimPacer {
  /** Sim seconds still to step: at most `EPS` after a frame, below `-lastStep` when the frame ran dry. */
  private owed = 0;
  private lastStep = 1 / 240;
  /** Where the frame's time sits between the sim's last two states: 0 the one before the last step, 1 the one it left. */
  alpha = 1;
  /** Sim seconds given up so far (a frame stopped before it caught up). */
  lost = 0;
  /** Frames stopped early so far. */
  cut = 0;
  /** Steps the last frame ran. */
  steps = 0;

  /**
   * One frame: `simDt` sim seconds (the frame's wall time at the time scale `scale`) in steps of `vmax`'s slice, each handed
   * to `step`. `deadline` (a `performance.now()` ms) ends the loop once two steps have run.
   */
  run(simDt: number, scale: number, vmax: number, deadline: number, step: (h: number) => void): void {
    // float32, as the highlight recorder stores it: a replay runs the live step.
    const h = Math.fround(physicsSlice(Infinity, vmax) * Math.min(1, Math.max(scale, MIN_SCALE)));
    this.owed += simDt;
    let steps = 0;
    while (this.owed > EPS && steps < MAX_STEPS) {
      step(h);
      this.lastStep = h;
      this.owed -= h;
      steps++;
      if (steps >= 2 && this.owed > EPS && performance.now() > deadline) break;
    }
    this.steps = steps;
    if (this.owed > EPS) {
      this.lost += this.owed;
      this.cut++;
      this.owed = 0;
    }
    this.alpha = Math.min(1, Math.max(0, 1 + this.owed / this.lastStep));
  }
}
