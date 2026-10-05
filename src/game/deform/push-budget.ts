import { satPushCap } from "./physics-util.ts";

/**
 * Fastest (m/s) position corrections may depenetrate two slow cars: a solver's push-out speed limit. At the longest
 * slice (1/60 s) it is 3.3 cm a step, which leaves 1.7 cm of the zip bound's 5 cm for the pose re-fit after it.
 */
export const PUSH_SPEED = 2;
/** Extra push-out speed per m/s of the faster of two touching cars: the overlap a hit makes in a slice grows with it. */
const TOUCH_GAIN = 2;
/**
 * The most (m) a slice's position corrections may move a centroid whatever the cap: the structure step's and the
 * re-fits' drift (`settleDrift`) is held to it. The derby's zip bound is 3·v·h + 0.05 m, and `PUSH_SPEED` keeps a
 * slow wreck's pushes under 0.033 m; 5 mm of the 0.05 m are left for what the bound sees outside the budget.
 */
export const STEP_CEIL = 0.045;

/**
 * One car's position corrections within one world slice (`beginSlice`): the pair pushes (`takePush`), the structure
 * step's and the re-fits' drift of the centroid (`settleDrift`) take from the same net translation of its centroid,
 * and the mass-sphere shifts (`collideWith`) and the wall and bowl translations (`translateMasses`) debit it, so their
 * sum stays within `PUSH_SPEED·dt` plus twice the touching speed's travel by construction, the walls' and the
 * shifts' own aside. What a correction does not get this slice is left overlapping and resolved by the next ones, as a
 * solver's iteration budget does. Before it, the pushes of one slice shared one `satPushCap` and the structure step,
 * the re-fits and the clip came after them, each debited to the next slice's: a wedged wreck moved 0.04–0.05 m a step
 * from pushes alone, and a derby `o6` 0.066 m with the pushes at the cap, against a zip bound of 3·v·h + 0.05 m.
 */
export class PushBudget {
  /** Net translation (m) taken at sim time `at`. */
  x = 0;
  z = 0;
  at = -1;

  reset(): void {
    this.x = 0;
    this.z = 0;
    this.at = -1;
  }

  private open(elapsed: number): void {
    if (this.at === elapsed) return;
    this.at = elapsed;
    this.x = 0;
    this.z = 0;
  }

  /** A correction that already moved the centroid by (dx, dz). */
  debit(elapsed: number, dx: number, dz: number): void {
    this.open(elapsed);
    this.x += dx;
    this.z += dz;
  }

  /** The most (m) a slice's net translation reaches by pushes, at slice length `dt` with the touching cars at `touchSpeed`. */
  private static reach(dt: number, touchSpeed: number): number {
    return Math.min(satPushCap(dt), (PUSH_SPEED + TOUCH_GAIN * touchSpeed) * dt);
  }

  /**
   * The part of a push `amount` (m) along the unit (nx, nz) this slice still allows: the most that keeps the net
   * translation inside the cap. A push against what was taken already is cheap (the squeezed wreck's two sides cancel),
   * and nothing is left once the corrections fill the cap. `touchSpeed` is the faster of the touching cars.
   */
  take(elapsed: number, nx: number, nz: number, amount: number, dt: number, touchSpeed: number): number {
    this.open(elapsed);
    const cap = PushBudget.reach(dt, touchSpeed);
    const dn = this.x * nx + this.z * nz;
    const left = cap * cap - this.x * this.x - this.z * this.z;
    const ok = left <= 0 ? 0 : Math.max(0, Math.min(amount, Math.sqrt(dn * dn + left) - dn));
    this.x += nx * ok;
    this.z += nz * ok;
    return ok;
  }

  /**
   * The part of a drift `amount` (m) of the centroid along the unit (nx, nz) the slice still allows: a move no solver
   * chose (the structure step's, a re-fit's: `settleDrift`). Like `take` against the larger of the cap and `STEP_CEIL`, but
   * a drift against the net translation is never refused, whatever the net: it brings it in.
   */
  settle(elapsed: number, nx: number, nz: number, amount: number, dt: number, touchSpeed: number): number {
    this.open(elapsed);
    const cap = Math.max(STEP_CEIL, PushBudget.reach(dt, touchSpeed));
    const dn = this.x * nx + this.z * nz;
    const left = Math.max(0, cap * cap - this.x * this.x - this.z * this.z);
    const ok = Math.max(0, Math.min(amount, Math.sqrt(dn * dn + left) - dn));
    this.x += nx * ok;
    this.z += nz * ok;
    return ok;
  }
}
