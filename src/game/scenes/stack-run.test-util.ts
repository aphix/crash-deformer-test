import type { DeformableCar } from "../vehicle/car.ts";
import { FRAME } from "../vehicle/ground-probe.test-util.ts";
import { tickWorld, type CrashWorld } from "../contact/crash-scenarios.test-util.ts";
import { LEAD_S, placeDrop, type StackRig } from "./stack-rig.ts";

/** The stack's cars are standing still once every car's speed and spin stay under `STILL_SPEED` for `STILL_S`. */
export const STILL_SPEED = 1e-3;
export const STILL_S = 0.5;

/**
 * The stack scene's run as the engine steps it (`StackRig.step`, then `placeDrop`, in the one world step), for `seconds` of the
 * rig's clock. Once a car has dropped, a stack standing still has nothing to do until the rig's next drop (a gap of 8 s at the
 * defaults is time the rig only waits), so the clock then jumps to that drop, or to `seconds` once the last car is down, instead of
 * stepping the idle seconds frame by frame (a run whose stack never stands still, the owner's 11 cars a second apart, steps every
 * frame as the engine does). `before` runs just before each drop's car is placed; `each` after every stepped frame.
 */
export function runStack(
  cars: readonly DeformableCar[],
  rig: StackRig,
  w: CrashWorld,
  seconds: number,
  o: { before?: () => void; each?: () => void } = {},
): void {
  const end = Math.round(seconds / FRAME);
  let f = 0;
  let still = 0;
  while (f < end) {
    if (rig.step(f * FRAME) === "drop") {
      o.before?.();
      placeDrop(cars, rig.dropped - 1, rig.config.drop);
      still = 0;
    }
    tickWorld(w, FRAME);
    f++;
    o.each?.();
    still = cars.some((c) => c.velocity.length() + c.angular.length() > STILL_SPEED) ? 0 : still + 1;
    if (rig.dropped > 1 && still * FRAME >= STILL_S) {
      const next = rig.dropped < rig.config.cars ? Math.round((LEAD_S + (rig.dropped - 1) * rig.config.gap) / FRAME) : end;
      f = Math.min(end, Math.max(f, next));
    }
  }
}
