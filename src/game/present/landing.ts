import type { DeformableCar } from "../vehicle/car.ts";

/**
 * What counts as a landing, for everything that reacts to one (the chase camera's wobble, the audio's thud): the car's four wheels meet the
 * ground after `minAir` s in the air, having fallen faster than `fall` m/s at the fastest (masterclass 31:18 gives no speed: playtest). A nose-first
 * landing takes its wheels down over a few frames, so the four may be down up to `settleS` s after the flight ended. Mutable: the camera's debug knob.
 */
export const LANDING = { minAir: 0.3, fall: 5, settleS: 0.3 };

/**
 * Watches one car frame by frame for landings. One per follower: each keeps its own flight. The fall it reports is the fastest the flight fell,
 * not the speed at the last frame: the touchdown has already eaten most of that (the hull or the first tyres met the ground a frame before the four were down).
 */
export class LandingWatch {
  private airS = 0;
  /** The fastest fall (m/s, positive) of this flight; a landing is armed from the flight's end until the four wheels are down. */
  private peak = 0;
  private armed = false;
  private settleS = 0;

  /** The car changed or was moved: the flight restarts. */
  reset(): void {
    this.airS = 0;
    this.peak = 0;
    this.armed = false;
  }

  /** Steps one frame; returns the fall speed (m/s, positive) when the car landed this frame, else 0. */
  step(car: Pick<DeformableCar, "airborne" | "wheelsDown" | "velocity">, dt: number): number {
    if (car.airborne) {
      if (this.armed) {
        this.armed = false;
        this.peak = 0;
      }
      this.peak = Math.max(this.peak, -car.velocity.y);
      this.airS += dt;
      this.settleS = 0;
      return 0;
    }
    if (this.airS >= LANDING.minAir && this.peak > LANDING.fall) this.armed = true;
    this.airS = 0;
    let fall = 0;
    if (this.armed) {
      this.settleS += dt;
      if ((car.wheelsDown & 15) === 15) {
        fall = this.peak;
        this.armed = false;
      } else if (this.settleS > LANDING.settleS) this.armed = false;
    }
    if (!this.armed) this.peak = 0;
    return fall;
  }
}
