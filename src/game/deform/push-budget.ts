import { satPushCap } from "./physics-util.ts";

/**
 * Fastest (m/s) position corrections may depenetrate two slow cars: a solver's push-out speed limit. At the longest
 * slice (1/60 s) it is 3.3 cm a step, which leaves 1.7 cm of the zip bound's 5 cm for the pose re-fit after it.
 */
export const PUSH_SPEED = 2;
/** Extra push-out speed per m/s of the faster of two touching cars: the overlap a hit makes in a slice grows with it. */
const TOUCH_GAIN = 2;

/**
 * One car's position corrections within one slice: the pair pushes (`takePush`), the mass-sphere shifts
 * (`collideWith`) and the wall and bowl translations (`translateMasses`) all debit the same net translation of
 * its centroid, so their sum stays within `PUSH_SPEED·dt` plus twice the touching speed's travel by construction.
 * What a correction does not get this slice is left overlapping and resolved by the next ones, as a solver's
 * iteration budget does. Before it, the pushes of one slice shared one `satPushCap` and the other two sources
 * stacked on top: a wedged wreck moved 0.04–0.05 m a step from pushes alone, against a derby zip bound of
 * 3·v·h + 0.05 m.
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

  /**
   * The part of a push `amount` (m) along the unit (nx, nz) this slice still allows: the most that keeps the net
   * translation inside the cap. A push against what was taken already is cheap (the squeezed wreck's two sides cancel),
   * and nothing is left once the corrections fill the cap. `touchSpeed` is the faster of the touching cars.
   */
  take(elapsed: number, nx: number, nz: number, amount: number, dt: number, touchSpeed: number): number {
    this.open(elapsed);
    const cap = Math.min(satPushCap(dt), (PUSH_SPEED + TOUCH_GAIN * touchSpeed) * dt);
    const dn = this.x * nx + this.z * nz;
    const left = cap * cap - this.x * this.x - this.z * this.z;
    const ok = left <= 0 ? 0 : Math.max(0, Math.min(amount, Math.sqrt(dn * dn + left) - dn));
    this.x += nx * ok;
    this.z += nz * ok;
    return ok;
  }
}
