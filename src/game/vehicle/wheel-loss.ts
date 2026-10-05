/** `DeformableCar.wheelsOnMask` bits: a wheel still on its hub. */
const WHEEL_FL = 1;
const WHEEL_FR = 2;
export const WHEEL_RL = 4;
export const WHEEL_RR = 8;

/** Body scraping where a wheel was (m/s² per wheel lost): the sill on the road, about 0.05 g. */
const SCRAPE_DECEL = 0.5;
/** Grip a bare axle keeps (the body on the road); each wheel on gives half of the rest. */
const BARE_GRIP = 0.35;
/** Front brakes' share of the braking (the rest is the rear's), as a road car's 60 / 40 split. */
const FRONT_BRAKE = 0.6;

/** `wheelLoss`' out: [0] steering authority, [1] drive share, [2] brake share, [3] front grip, [4] rear grip, [5] scrape (m/s²), [6] rear wheels on. */
export const LOSS_SIZE = 7;

const bits = (m: number, a: number, b: number): number => ((m & a) !== 0 ? 1 : 0) + ((m & b) !== 0 ? 1 : 0);

/**
 * What the wheels still on the car (`mask`) leave of each control, one rule for the player and the AI (both go
 * through `applyDrive`). Every class drives all four wheels (the classes carry no driveline), so:
 * - steering comes from the front wheels alone: both gone and the wheel does nothing, one gone half the lock;
 * - thrust comes from the wheels on, a quarter each;
 * - the brakes are the wheels on, the fronts taking 60 %: what is not braked has only the scrape and the road's drag;
 * - an axle's grip falls to a bare body's `BARE_GRIP` with both its wheels off, linearly between;
 * - every wheel gone scrapes the body along the road for `SCRAPE_DECEL`;
 * - the handbrake needs a rear wheel to lock (`out[6]`).
 */
export function wheelLoss(mask: number, out: Float64Array): Float64Array {
  const front = bits(mask, WHEEL_FL, WHEEL_FR);
  const rear = bits(mask, WHEEL_RL, WHEEL_RR);
  out[0] = front / 2;
  out[1] = (front + rear) / 4;
  out[2] = (FRONT_BRAKE * front + (1 - FRONT_BRAKE) * rear) / 2;
  out[3] = BARE_GRIP + ((1 - BARE_GRIP) * front) / 2;
  out[4] = BARE_GRIP + ((1 - BARE_GRIP) * rear) / 2;
  out[5] = SCRAPE_DECEL * (4 - front - rear);
  out[6] = rear;
  return out;
}
