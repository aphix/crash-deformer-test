/** Seconds the reset control (R, the pad's D-pad ↓, the thumb pad's button) is held before the car goes back keeping its damage. */
export const RESET_HOLD = 0.8;

/**
 * One reset control, from press to release: a press released before `RESET_HOLD` is a tap (a reset as it always was: repaired, after
 * its pause), one still down at `RESET_HOLD` is a hold (back on the road at once with its damage kept) and acts once, then the release
 * does nothing.
 */
export class ResetHold {
  private held = 0;
  private fired = false;

  /** How far the hold is, 0 to 1, while the control is down and the hold has not acted; the HUD's fill. */
  get fill(): number {
    return this.fired ? 0 : Math.min(1, this.held / RESET_HOLD);
  }

  /** Advance `dt` s with the control `down` or not: "hold" on the step the hold completes, "tap" on the release of a press that never did, else null. */
  step(down: boolean, dt: number): "tap" | "hold" | null {
    if (down) {
      this.held += dt;
      if (this.fired || this.held < RESET_HOLD) return null;
      this.fired = true;
      return "hold";
    }
    const tap = this.held > 0 && !this.fired;
    this.cancel();
    return tap ? "tap" : null;
  }

  /** The press is void (a menu opened, the race ended): neither a tap nor a hold. */
  cancel(): void {
    this.held = 0;
    this.fired = false;
  }
}
