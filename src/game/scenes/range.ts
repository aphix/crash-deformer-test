/**
 * The ejection range, FlatOut's driver-flinging event: car A runs up `RANGE.run` m at `RANGE.kph` straight into the
 * jersey barrier (hood height) at the origin, its driver flies over it down +x into a sand field with a distance sign
 * every `RANGE.signStep` m, and the camera watches him until he lies still. Distances count from the wall's centre
 * line (x = 0). The dummy is cosmetic (`RagdollSystem`); nothing here feeds the sim.
 */
export const RANGE = {
  /** Run-up (m back from the wall) and speed: set by eye, a FlatOut-like hit that throws on every run. */
  run: 40,
  kph: 100,
  /** The field past the wall (m): length down +x and half-width; signs every `signStep` m, `signs` of them. */
  length: 110,
  halfWidth: 10,
  signStep: 10,
  signs: 10,
} as const;

/** Sim seconds the dummy lies still before his distance counts as the landing. */
const LANDED_STILL = 1;
/** Wall seconds the landing stays on screen before a looping range runs again. */
const SHOW_LANDING = 3;

/** One range run's throw: the distance so far, the landing, and when to run again. */
export class RangeRun {
  /** Metres past the wall: live while the driver flies and slides, final once `landed`; null before the throw. */
  distance: number | null = null;
  landed = false;
  private shown = 0;

  reset(): void {
    this.distance = null;
    this.landed = false;
    this.shown = 0;
  }

  /**
   * One frame: `still` is how long (sim s) the thrown driver has lain still, -1 while none is out; `x` his torso's
   * x. True once the landing has been shown long enough for the next run.
   */
  step(still: number, x: number, wallDt: number): boolean {
    if (still < 0) return false;
    if (!this.landed) this.distance = x;
    if (still >= LANDED_STILL) this.landed = true;
    if (this.landed) this.shown += wallDt;
    return this.shown > SHOW_LANDING;
  }
}
