import { MAX_CARS } from "../scenes/fleet.ts";
import type { DriveInput } from "../vehicle/car-drive.ts";
import type { AiCar } from "./derby-ai.ts";

/**
 * Opening caution (owner 10-04): until `OPEN_S` s into a heat or this car's own first aggressive hit, a driver does not
 * drive its nose into a rival at a high closing speed: it lifts and brakes, so the first meetings are glancing or
 * rear-first (the tail-first strikes and sideswipes still run) and not a nose trade. Wheels off now cost steering, thrust
 * and brakes (`wheelLoss`), so a car that loses one in a 40 m/s head-on is crippled: derby seed 17 lost an engine at 7.1 s.
 */
const OPEN_S = 8;
/** Closing speed (m/s) above which the nose is lifted off a rival ahead. */
const OPEN_CLOSING = 7;
/** Only a rival this close (m) is worth lifting for. */
const OPEN_RANGE = 24;
/** A rival counts as "ahead" within this cosine of the nose (about 60 degrees). */
const OPEN_CONE = 0.5;
/** Brake held while it closes too fast. */
const OPEN_BRAKE = 0.7;

/** Lift and brake `out` (in place) when `self`'s nose is closing too fast on a live rival; no-op once the opening is over. */
function openingCaution(out: DriveInput, self: AiCar, others: readonly AiCar[], seconds: number, hit: boolean): void {
  if (hit || seconds >= OPEN_S || out.throttle <= 0) return;
  const fx = Math.sin(self.yaw);
  const fz = Math.cos(self.yaw);
  for (const o of others) {
    if (o.id === self.id || !o.alive) continue;
    const dx = o.x - self.x;
    const dz = o.z - self.z;
    const d = Math.hypot(dx, dz);
    if (d > OPEN_RANGE || d < 1e-3) continue;
    if ((fx * dx + fz * dz) / d < OPEN_CONE) continue;
    const closing = -((o.vx - self.vx) * dx + (o.vz - self.vz) * dz) / d;
    if (closing <= OPEN_CLOSING) continue;
    out.throttle = 0;
    out.brake = OPEN_BRAKE;
    out.boost = false;
    return;
  }
}

/** Per driver: whether it has landed its first aggressive hit (`self.idle` dropped), which ends its opening caution. */
export class OpeningWatch {
  private readonly idleWas = new Float64Array(MAX_CARS);
  private readonly hitOnce = new Uint8Array(MAX_CARS);

  reset(): void {
    this.idleWas.fill(0);
    this.hitOnce.fill(0);
  }

  /** Track `self`'s hit state and cool `out` while its opening caution holds; `seconds` is the driver's age in the heat. */
  apply(out: DriveInput, self: AiCar, others: readonly AiCar[], seconds: number): void {
    const i = self.id;
    if (self.idle < this.idleWas[i]!) this.hitOnce[i] = 1;
    this.idleWas[i] = self.idle;
    openingCaution(out, self, others, seconds, this.hitOnce[i] === 1);
  }
}
