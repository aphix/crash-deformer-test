import type { DeformableCar } from "./car.ts";
import { CLIMB_NY } from "./car-air-body.ts";
import { BITE_FULL_FACING, FLIPPED_UP_Y } from "./constants.ts";
import { C_NX, C_NY, C_NZ, HIT_SIZE } from "../world/surfaces.ts";

/** Smoothstep of `x` over [`lo`, `hi`]: 0 at and under `lo`, 1 at and over `hi`, no corner at either end. */
function ramp(x: number, lo: number, hi: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * The share (0..1) of its drive a car's standing tyres keep: the best, over the wheels in contact (`wheelsDown`), of two smooth fades, each 1 on ground a car drives on. The best, not the mean: one tyre
 * with purchase drives the car whole, as one wheel down always has (`applyDrive` reads the axle's standing wheel), and a wheel brushing another car's side or a wall while the others stand on the floor costs it nothing.
 * - Facing: the contact normal against the body's up, the cosine between the wheel's under-axis (its springs, the way its footprint is found) and the surface. A tyre standing
 *   on the surface has 1; the surface edge-on to the tread (a sidewall on the floor under a car on its side) 0; a roof's tyres (a surface on the wheel's top) less. It fades
 *   from `FLIPPED_UP_Y` to `BITE_FULL_FACING`, so a car banked with its surface (a normal along its up) keeps its tyres however steep the bank, and a car leaning off it loses them smoothly.
 * - Load: the contact normal's up component, the share of the car's weight the surface bears under the tyre (a surface at an angle bears weight times the cosine; a wall bears none, so
 *   a tyre pressed to one has nothing to push against, and a truck lying against the arena wall cannot drive itself through it). It is whole from `CLIMB_NY`, the slope
 *   at which the contact solver stops treating a face as a floor and pushes along its normal instead, down to nothing on the vertical.
 * 0 when no wheel is in contact.
 */
export function standingBite(car: DeformableCar): number {
  const q = car.group.quaternion;
  const upX = 2 * (q.x * q.y - q.w * q.z);
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  const upZ = 2 * (q.y * q.z + q.w * q.x);
  const hit = car.wheelHit;
  const down = car.wheelsDown;
  let bite = 0;
  for (let i = 0; i < 4; i++) {
    if ((down & (1 << i)) === 0) continue;
    const o = i * HIT_SIZE;
    const load = hit[o + C_NY]!;
    bite = Math.max(bite, ramp(hit[o + C_NX]! * upX + load * upY + hit[o + C_NZ]! * upZ, FLIPPED_UP_Y, BITE_FULL_FACING) * ramp(load, 0, CLIMB_NY));
  }
  return bite;
}
