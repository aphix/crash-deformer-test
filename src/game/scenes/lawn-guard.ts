import { detCos, detSin, hypot2 } from "../kernel/physics-core.js";
import type { DeformableCar } from "../vehicle/car.ts";
import { activeGround } from "../world/ground.ts";
import { mulberry32 } from "../world/placements.ts";
import { insidePolygon } from "../world/terrain.ts";
import type { GuardSpec } from "../world/track-schema.ts";
import { blankStrike, fell, runsDown, type FigureStrike } from "./figure-strike.ts";

/** Seconds from the alarm until the guards are out of the doors and firing (guessed: a few strides out of the porticos). */
export const GUARD_DEPLOY_S = 2.5;
/** Seconds between the squad's shots with every guard up, every gun together (owner, 2026-10-14: the guards "rapidly" destroy the car; guessed); with fewer standing it grows in proportion. */
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

/** A guard's state (`LawnGuard.mode`): inside the house, running out of it, at his post aiming, running back in, or run down by a car and out of the squad until the next race. */
export const GUARD_IN = 0;
export const GUARD_RUNNING_OUT = 1;
export const GUARD_AT_POST = 2;
export const GUARD_RUNNING_IN = 3;
export const GUARD_DOWN = 4;

/** The guards' run out and back (m/s, guessed: a sprint in kit). */
const GUARD_RUN = 4.5;
/** Their posts off a door: the first rank this far out (m), the next ranks `RANK_GAP` further, `FILE_GAP` apart across a rank. */
const LINE_OUT = 7;
const RANK_GAP = 4;
const FILE_GAP = 4.5;
/** Seconds between one guard coming out of a door and the next (two a beat); how far (m) inside the door he appears, under the portico. */
const STAGGER_S = 0.18;
const PORTICO_DEPTH = 3;
/** A guard this close (m) to where he is going is there. */
const ARRIVE = 0.3;
/** A car's plan box reaches no further than this (m) from its origin (a truck's far corner is under 5): the cars nearer than it are tested against a guard. */
const CAR_REACH = 6.5;

/** No strikes pending (shared, never written). */
const NONE: readonly FigureStrike[] = [];

/**
 * The guards of a house's grounds (`GuardSpec`): a car driving onto the lawn raises the alarm, and the squad runs out of the doors
 * to its posts, then once it is out (`GUARD_DEPLOY_S`) it fires on that car while it stays alive and within `RANGE`, a shot every
 * `FIRE_EVERY` s at full strength, `HIT_SHARE` of them hits; the 10th to 15th hit kills its engine (`DeformableCar.disable`, which
 * the recorder keys, so a replay holds the kill). A car moving over `STRIKE_SPEED` that meets a guard on the grounds runs him down
 * (`runsDown`): he is out of the squad until the next race (`GUARD_DOWN`, never the shooter, his gun gone from the rate), and the
 * strike is queued for the ragdoll (`takeStrikes`); the car feels nothing. SIM state: `step` runs once per fixed step, after the
 * world, on a stream seeded per race, so the same steps give the same shots, runs and strikes. With `standDown` (the course's secret
 * is out: the VIP comes out instead) nobody fires and the squad stays in. The art reads the alarm, the target, the guards' places and
 * modes and the shot ring (guard, car, hit per shot).
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
  /** Per guard: his state (`GUARD_IN` ... `GUARD_DOWN`), his place on the ground (m) and the unit vector on it he faces (while he is out). */
  readonly mode: Uint8Array;
  readonly guardX: Float64Array;
  readonly guardZ: Float64Array;
  readonly faceX: Float64Array;
  readonly faceZ: Float64Array;
  private readonly postX: Float64Array;
  private readonly postZ: Float64Array;
  private readonly homeX: Float64Array;
  private readonly homeZ: Float64Array;
  private readonly hits: Int32Array;
  private readonly lethal: Int32Array;
  private readonly midX: number;
  private readonly midZ: number;
  private quiet = 0;
  private fireIn = 0;
  /** Guards on their way out or at their posts (`GUARD_RUNNING_OUT`, `GUARD_AT_POST`): the guns the squad fires with. */
  private armed = 0;
  private struck: FigureStrike[] = [];
  private rand = mulberry32(0);

  constructor(spec: GuardSpec, maxCars: number) {
    this.spec = spec;
    this.hits = new Int32Array(maxCars);
    this.lethal = new Int32Array(maxCars);
    this.midX = spec.doors.reduce((a, d) => a + d.x, 0) / spec.doors.length;
    this.midZ = spec.doors.reduce((a, d) => a + d.z, 0) / spec.doors.length;
    const n = spec.count;
    this.mode = new Uint8Array(n);
    this.guardX = new Float64Array(n);
    this.guardZ = new Float64Array(n);
    this.faceX = new Float64Array(n);
    this.faceZ = new Float64Array(n).fill(1);
    this.postX = new Float64Array(n);
    this.postZ = new Float64Array(n);
    this.homeX = new Float64Array(n);
    this.homeZ = new Float64Array(n);
    this.layOutPosts();
  }

  /** Each guard's post in the ranks before his door and his home inside it. */
  private layOutPosts(): void {
    const { doors, count } = this.spec;
    const perRank = Math.ceil(Math.ceil(count / doors.length) / 2);
    for (let i = 0; i < count; i++) {
      const door = doors[i % doors.length]!;
      const j = Math.floor(i / doors.length);
      const fx = detSin(door.yaw);
      const fz = detCos(door.yaw);
      const out = LINE_OUT + Math.floor(j / perRank) * RANK_GAP;
      const across = ((j % perRank) - (perRank - 1) / 2) * FILE_GAP;
      this.postX[i] = door.x + fx * out + fz * across;
      this.postZ[i] = door.z + fz * out - fx * across;
      this.homeX[i] = door.x - fx * PORTICO_DEPTH;
      this.homeZ[i] = door.z - fz * PORTICO_DEPTH;
    }
  }

  /** A race starts: no alarm, no hits, every guard back inside and standing, the shot stream seeded from the race's `seed`. */
  reset(seed: number): void {
    this.rand = mulberry32(Math.imul(seed + 1, 0x9e3779b1));
    this.alarm = -1;
    this.target = NO_TARGET;
    this.quiet = 0;
    this.fireIn = 0;
    this.shots = 0;
    this.armed = 0;
    this.struck = [];
    this.mode.fill(GUARD_IN);
    this.hits.fill(0);
    for (let i = 0; i < this.lethal.length; i++) this.lethal[i] = this.rollLethal();
  }

  /** Whether (x, z) is on the guarded grounds. */
  onGrounds(x: number, z: number): boolean {
    return insidePolygon(this.spec.lawn, x, z);
  }

  /** The guards run down since the last call, oldest first (a shared empty array when there are none). */
  takeStrikes(): readonly FigureStrike[] {
    if (this.struck.length === 0) return NONE;
    const out = this.struck;
    this.struck = [];
    return out;
  }

  /** One fixed step of `dt` s, after the world moved the cars. */
  step(cars: readonly DeformableCar[], dt: number): void {
    this.alert(cars, dt);
    this.moveGuards(cars, dt);
  }

  /** The alarm, the target and the squad's fire for one step. */
  private alert(cars: readonly DeformableCar[], dt: number): void {
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
    while (this.fireIn <= 0 && this.target !== NO_TARGET && this.armed > 0) {
      this.fireIn += (FIRE_EVERY * this.mode.length) / this.armed;
      this.fire(cars[this.target]!);
    }
  }

  /** One step of every guard on the lawn: called out by the alarm (two a beat) he runs to his post and turns to the target, once it is down he runs home; a car moving fast enough over him runs him down. */
  private moveGuards(cars: readonly DeformableCar[], dt: number): void {
    const target = this.target !== NO_TARGET ? cars[this.target] : undefined;
    this.armed = 0;
    for (let i = 0; i < this.mode.length; i++) {
      if (this.mode[i] === GUARD_DOWN) continue;
      const called = this.alarm >= Math.floor(i / 2) * STAGGER_S;
      if (this.mode[i] === GUARD_IN) {
        if (!called) continue;
        this.guardX[i] = this.homeX[i]!;
        this.guardZ[i] = this.homeZ[i]!;
      }
      const dx = (called ? this.postX[i]! : this.homeX[i]!) - this.guardX[i]!;
      const dz = (called ? this.postZ[i]! : this.homeZ[i]!) - this.guardZ[i]!;
      const left = hypot2(dx, dz);
      if (!called && left < ARRIVE) {
        this.mode[i] = GUARD_IN;
        continue;
      }
      if (left >= ARRIVE) {
        const stride = Math.min(left, GUARD_RUN * dt);
        this.guardX[i] = this.guardX[i]! + (dx / left) * stride;
        this.guardZ[i] = this.guardZ[i]! + (dz / left) * stride;
        this.faceX[i] = dx / left;
        this.faceZ[i] = dz / left;
      } else if (target) {
        this.faceToward(i, target.group.position.x, target.group.position.z);
      }
      this.mode[i] = !called ? GUARD_RUNNING_IN : left >= ARRIVE ? GUARD_RUNNING_OUT : GUARD_AT_POST;
      this.runOver(cars, i);
      if (called && this.mode[i] !== GUARD_DOWN) this.armed++;
    }
  }

  /** Guard `i` faces the point (x, z). */
  private faceToward(i: number, x: number, z: number): void {
    const dx = x - this.guardX[i]!;
    const dz = z - this.guardZ[i]!;
    const away = hypot2(dx, dz);
    if (away < 1e-6) return;
    this.faceX[i] = dx / away;
    this.faceZ[i] = dz / away;
  }

  /** Is guard `i` under a car that is moving fast enough (`runsDown`)? Then he is down, and the strike waits for `takeStrikes`. */
  private runOver(cars: readonly DeformableCar[], i: number): void {
    const x = this.guardX[i]!;
    const z = this.guardZ[i]!;
    for (let c = 0; c < cars.length; c++) {
      const car = cars[c]!;
      if (hypot2(car.group.position.x - x, car.group.position.z - z) > CAR_REACH) continue;
      const y = activeGround().heightAt(x, z);
      if (!runsDown(car, x, z, y)) continue;
      this.knockDown(i, c, car, y);
      return;
    }
  }

  private knockDown(i: number, carIndex: number, car: DeformableCar, groundY: number): void {
    this.mode[i] = GUARD_DOWN;
    this.struck.push(fell(car, carIndex, i, this.guardX[i]!, groundY, this.guardZ[i]!, this.faceX[i]!, this.faceZ[i]!, blankStrike()));
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
    this.shotGuard[k] = this.shooter();
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

  /** The guard whose gun fires shot number `shots`: the guns take turns, a guard down or inside skipped. */
  private shooter(): number {
    const n = this.mode.length;
    for (let k = 0; k < n; k++) {
      const g = (this.shots + k) % n;
      if (this.mode[g] === GUARD_RUNNING_OUT || this.mode[g] === GUARD_AT_POST) return g;
    }
    return 0;
  }

  private rollLethal(): number {
    return KILL_HITS_MIN + Math.floor(this.rand() * KILL_HITS_SPREAD);
  }
}
