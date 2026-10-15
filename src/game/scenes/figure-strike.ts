import { hypot2 } from "../kernel/physics-core.js";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * Slowest car speed (m/s) that fells a standing figure: the 4 m/s a dummy's part must change velocity by in a step to count as
 * hit (`HIT_DV`); under it a bumper only leans on a man who steps aside.
 */
export const STRIKE_SPEED = 4;
/** A figure's body for a car's footprint to meet: a post of this radius (m: his arms' reach) and this height (m) over the ground. */
const BODY_RADIUS = 0.3;
const BODY_HEIGHT = 1.8;
/**
 * How his launch takes the car's motion (`fell`): its horizontal velocity, a lift of `LIFT_PER_MPS` per m/s of its speed up to
 * `LIFT_MAX` (m/s), a kick away from the car's centre line of `KICK_PER_MPS` per m/s up to `KICK_MAX` (the car goes on at speed
 * whatever it hit, so he is thrown clear of its path), and a turn of `TUMBLE_PER_MPS` rad/s per m/s up to `TUMBLE_MAX`, legs
 * ahead of his head (guessed, set by eye).
 */
const LIFT_PER_MPS = 0.2;
const LIFT_MAX = 5;
const KICK_PER_MPS = 0.3;
const KICK_MAX = 6;
const TUMBLE_PER_MPS = 0.3;
const TUMBLE_MAX = 8;

/**
 * A standing figure a car ran down: who (`guard`: the squad's index, -1 for the VIP), the car, where his feet stood and which way
 * he faced (a unit vector on the ground), and how he is launched (world velocity and spin). Every number is f32-exact (`Math.fround`),
 * so the copy a clip stored is the launch the live race made.
 */
export type FigureStrike = {
  guard: number;
  car: number;
  x: number;
  y: number;
  z: number;
  faceX: number;
  faceZ: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
};

/** A fresh record (decoders fill it). */
export function blankStrike(): FigureStrike {
  return { guard: 0, car: 0, x: 0, y: 0, z: 0, faceX: 0, faceZ: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
}

/** `car`'s right-hand unit direction on the ground (x, z), and the ground point (x, z) in its frame: across (along the right) and ahead (along the forward). */
const _frame = { rightX: 0, rightZ: 0, across: 0, ahead: 0 };

/** `_frame` for the ground point (x, z) against `car`'s pose. */
function inCarFrame(car: DeformableCar, x: number, z: number): void {
  const { x: qx, y: qy, z: qz, w: qw } = car.group.quaternion;
  const dx = x - car.group.position.x;
  const dz = z - car.group.position.z;
  _frame.rightX = 1 - 2 * (qy * qy + qz * qz);
  _frame.rightZ = 2 * (qx * qz - qw * qy);
  _frame.across = dx * _frame.rightX + dz * _frame.rightZ;
  _frame.ahead = dx * 2 * (qx * qz + qw * qy) + dz * (1 - 2 * (qx * qx + qy * qy));
}

/**
 * Does `car`, moving at `STRIKE_SPEED` or more, meet a figure standing with his feet at (x, groundY, z)? Its cage's plan box (as
 * crushed) grown by his body's radius, in the car's own frame; its origin no higher over the ground than he stands tall.
 */
export function runsDown(car: DeformableCar, x: number, z: number, groundY: number): boolean {
  if (car.falling || car.vaporized || !car.group.visible || car.group.position.y - groundY > BODY_HEIGHT) return false;
  if (hypot2(car.velocity.x, car.velocity.z) < STRIKE_SPEED) return false;
  inCarFrame(car, x, z);
  const plan = car.cage.fields.planBox;
  return _frame.across >= plan[0]! - BODY_RADIUS && _frame.across <= plan[1]! + BODY_RADIUS && _frame.ahead >= plan[2]! - BODY_RADIUS && _frame.ahead <= plan[3]! + BODY_RADIUS;
}

/**
 * `out` as the launch of the figure `car` (slot `carIndex`) just ran down (`runsDown`): at the car's velocity with a lift, a kick to
 * the side of its centre line he stood on and a tumble that grow with its speed, his legs swept ahead and his head left behind.
 */
export function fell(car: DeformableCar, carIndex: number, guard: number, x: number, groundY: number, z: number, faceX: number, faceZ: number, out: FigureStrike): FigureStrike {
  const speed = hypot2(car.velocity.x, car.velocity.z);
  const dirX = car.velocity.x / speed;
  const dirZ = car.velocity.z / speed;
  const turn = Math.min(TUMBLE_MAX, TUMBLE_PER_MPS * speed);
  inCarFrame(car, x, z);
  const kick = (_frame.across < 0 ? -1 : 1) * Math.min(KICK_MAX, KICK_PER_MPS * speed);
  out.guard = guard;
  out.car = carIndex;
  out.x = Math.fround(x);
  out.y = Math.fround(groundY);
  out.z = Math.fround(z);
  out.faceX = Math.fround(faceX);
  out.faceZ = Math.fround(faceZ);
  out.vx = Math.fround(car.velocity.x + _frame.rightX * kick);
  out.vy = Math.fround(Math.min(LIFT_MAX, LIFT_PER_MPS * speed));
  out.vz = Math.fround(car.velocity.z + _frame.rightZ * kick);
  out.wx = Math.fround(-dirZ * turn);
  out.wy = 0;
  out.wz = Math.fround(dirX * turn);
  return out;
}
