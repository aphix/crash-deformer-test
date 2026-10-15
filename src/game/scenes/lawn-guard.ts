import { hypot2 } from "../kernel/physics-core.js";
import type { DeformableCar } from "../vehicle/car.ts";
import { mulberry32 } from "../world/placements.ts";
import { insidePolygon } from "../world/terrain.ts";
import type { GuardSpec } from "../world/track-schema.ts";

/** Seconds from the alarm until the guards are out of the doors and firing (guessed: a few strides out of the porticos). */
export const GUARD_DEPLOY_S = 2.5;
/** Seconds between the squad's shots, every gun together (owner, 2026-10-14: the guards "rapidly" destroy the car; guessed). */
const FIRE_EVERY = 0.12;
/** Share of the squad's shots that hit the car (guessed: marksmen at lawn range). */
const HIT_SHARE = 0.8;
/** A car's engine dies at its 10th to 15th hit (owner, 2026-10-14: "after 10-15 shots"): the least, and how many counts past it. */
const KILL_HITS_MIN = 10;
const KILL_HITS_SPREAD = 6;
/** The guns' reach (m) from the doors' middle (guessed: the grounds and the streets round them). */
const RANGE = 160;
/** Seconds the alarm stays up once no car is on the grounds (guessed: the squad waits a while before it goes back in). */
const STAND_DOWN_S = 6;
/** No car: the squad has no target. */
export const NO_TARGET = -1;
/** Shots the ring keeps for the art to draw (`shots` counts them all): at `FIRE_EVERY` it covers over 7 s. */
export const SHOT_RING = 64;

/**
 * The guards of a house's grounds (`GuardSpec`): a car driving onto the lawn raises the alarm, and once the squad is out
 * (`GUARD_DEPLOY_S`) it fires on that car while it stays alive and within `RANGE`, `FIRE_EVERY` s a shot, `HIT_SHARE` of them hits;
 * the 10th to 15th hit kills its engine (`DeformableCar.disable`, which the recorder keys, so a replay holds the kill). SIM state:
 * `step` runs once per fixed step, after the world, on a stream seeded per race, so the same steps give the same shots. With
 * `standDown` (the course's secret is out: the VIP comes out instead) nobody fires. The art reads the alarm, the target and the
 * shot ring (guard, car, hit per shot).
 */
export class LawnGuard {
  readonly spec: GuardSpec;
  /** The VIP is out (the course's secret): the squad stays in and the alarm stays down. */
  standDown = false;
  /** Seconds since the alarm went up; -1 while it is down. */
  alarm = -1;
  /** The car the squad fires on (`NO_TARGET`: none). */
  target = NO_TARGET;
  /** Shots fired since the race began: shot `k` is the ring's `k % SHOT_RING`. */
  shots = 0;
  readonly shotGuard = new Int32Array(SHOT_RING);
  readonly shotCar = new Int32Array(SHOT_RING);
  readonly shotHit = new Uint8Array(SHOT_RING);
  private readonly hits: Int32Array;
  private readonly lethal: Int32Array;
  private readonly midX: number;
  private readonly midZ: number;
  private quiet = 0;
  private fireIn = 0;
  private rand = mulberry32(0);

  constructor(spec: GuardSpec, maxCars: number) {
    this.spec = spec;
    this.hits = new Int32Array(maxCars);
    this.lethal = new Int32Array(maxCars);
    this.midX = spec.doors.reduce((a, d) => a + d.x, 0) / spec.doors.length;
    this.midZ = spec.doors.reduce((a, d) => a + d.z, 0) / spec.doors.length;
  }

  /** A race starts: no alarm, no hits, the shot stream seeded from the race's `seed`. */
  reset(seed: number): void {
    this.rand = mulberry32(Math.imul(seed + 1, 0x9e3779b1));
    this.alarm = -1;
    this.target = NO_TARGET;
    this.quiet = 0;
    this.fireIn = 0;
    this.shots = 0;
    this.hits.fill(0);
    for (let i = 0; i < this.lethal.length; i++) this.lethal[i] = this.rollLethal();
  }

  /** Whether (x, z) is on the guarded grounds. */
  onGrounds(x: number, z: number): boolean {
    return insidePolygon(this.spec.lawn, x, z);
  }

  /** One fixed step of `dt` s, after the world moved the cars. */
  step(cars: readonly DeformableCar[], dt: number): void {
    if (this.standDown) {
      this.alarm = -1;
      this.target = NO_TARGET;
      return;
    }
    const intruder = this.intruder(cars);
    if (intruder !== NO_TARGET) {
      if (this.alarm < 0) {
        this.alarm = 0;
        this.fireIn = GUARD_DEPLOY_S;
      }
      this.quiet = 0;
      if (!this.inSights(cars, this.target)) this.target = intruder;
    } else if (this.alarm >= 0) {
      this.quiet += dt;
      if (this.quiet > STAND_DOWN_S) {
        this.alarm = -1;
        this.target = NO_TARGET;
        this.hits.fill(0);
        return;
      }
    }
    if (this.alarm < 0) return;
    this.alarm += dt;
    if (!this.inSights(cars, this.target)) this.target = NO_TARGET;
    if (this.target === NO_TARGET) return;
    this.fireIn -= dt;
    while (this.fireIn <= 0 && this.target !== NO_TARGET) {
      this.fireIn += FIRE_EVERY;
      this.fire(cars[this.target]!);
    }
  }

  /** The car on the grounds the squad should fire on: the one it is already on, else the lowest slot there; `NO_TARGET` for none. */
  private intruder(cars: readonly DeformableCar[]): number {
    let found = NO_TARGET;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (!this.running(car) || !this.onGrounds(car.group.position.x, car.group.position.z)) continue;
      if (i === this.target) return i;
      if (found === NO_TARGET) found = i;
    }
    return found;
  }

  /** Car `i` is one to fire on: alive and within the guns' reach. */
  private inSights(cars: readonly DeformableCar[], i: number): boolean {
    if (i === NO_TARGET || i >= cars.length) return false;
    const car = cars[i]!;
    return this.running(car) && hypot2(car.group.position.x - this.midX, car.group.position.z - this.midZ) <= RANGE;
  }

  private running(car: DeformableCar): boolean {
    return car.deform.drivetrainAlive && !car.falling && !car.vaporized && car.group.visible;
  }

  /** One shot at the target: into the ring, and at its `lethal` hit the car's engine dies and the squad has no target. */
  private fire(car: DeformableCar): void {
    const k = this.shots % SHOT_RING;
    const i = this.target;
    const hit = this.rand() < HIT_SHARE;
    this.shotGuard[k] = this.shots % this.spec.count;
    this.shotCar[k] = i;
    this.shotHit[k] = hit ? 1 : 0;
    this.shots++;
    if (!hit) return;
    this.hits[i] = this.hits[i]! + 1;
    if (this.hits[i]! < this.lethal[i]!) return;
    car.disable();
    this.hits[i] = 0;
    this.lethal[i] = this.rollLethal();
    this.target = NO_TARGET;
  }

  private rollLethal(): number {
    return KILL_HITS_MIN + Math.floor(this.rand() * KILL_HITS_SPREAD);
  }
}
