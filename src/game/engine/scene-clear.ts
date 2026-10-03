import type { DeformableCar } from "../vehicle/car.ts";
import { resetLampPoles, type LampPole } from "../scenes/engine-props.ts";

/** Anything with a reset that empties it back to the pool it draws from. */
type Clearable = { reset(): void };

/**
 * Everything in the scene that a run leaves behind. A scene change, a loop and a manual reset all go through
 * `clearTransients`, so a system listed here is emptied on every one of them; scene furniture (the course, the
 * barrier, the ramps, the pooled meshes themselves) stays and is re-laid by the scene's own spawn.
 */
export interface Transients {
  /** Every built car, hidden ones past the live count too: their torn parts and loose wheels hang in the scene root. */
  readonly cars: readonly DeformableCar[];
  readonly poles: readonly LampPole[];
  readonly debris: Clearable;
  readonly sparks: Clearable;
  readonly glassDots: Clearable;
  readonly smoke: Clearable;
  readonly ragdolls: Clearable;
  readonly rangeRun: Clearable;
  readonly cine: Clearable;
}

/** Runs before the scene spawns its cars, so the spawn starts from clean cars. */
export function clearTransients(t: Transients): void {
  for (const car of t.cars) car.resetVisual();
  resetLampPoles(t.poles);
  t.debris.reset();
  t.sparks.reset();
  t.glassDots.reset();
  t.smoke.reset();
  t.ragdolls.reset();
  t.rangeRun.reset();
  t.cine.reset();
}
