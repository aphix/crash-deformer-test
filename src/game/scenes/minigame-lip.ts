import type { DeformableCar } from "../vehicle/car.ts";
import type { EjectionWatch } from "../vehicle/ejection.ts";
import { LIP_CAR_SPEED_KEEP, STATION_ANCHORS, STATION_HALF_WIDTH, type MinigameMode } from "./minigame-constants.ts";

/** The stations that throw their driver at the lip; the long jump's jersey barrier throws him by a hit instead. */
export type LipMode = Exclude<MinigameMode, "longJump">;

/**
 * The High jump's and Ring Fling's forced throw: there is no wall on those ramps, so when a car reaches the ramp's lip its driver
 * leaves through the windshield at the car's full 3D velocity (`EjectionWatch.throwDriverNow`, the usual pop on top), and the car
 * is slowed to `LIP_CAR_SPEED_KEEP` of its speed so the driverless car falls short of the boxes and the board.
 *
 * `collide` is a `World.collide` hook (each car at the end of a slice). A car's position is its centre (`group.position`): it has
 * reached the lip when the centre crosses the lip plane, the station-local x = 0, going +x between two calls. The plane is tested
 * between the previous call's x and this one's, so a fast car whose slice steps over the plane (40 m/s in a 1/60 s slice is
 * 0.7 m) still triggers, and a plane crossed once triggers once however finely the step is sliced.
 */
export class LipThrow {
  private readonly anchor: { x: number; z: number };
  private readonly cars: readonly DeformableCar[];
  private readonly ejection: EjectionWatch;
  /** Each car's station-local x at its previous call: a car not seen yet has none, so it cannot have crossed. */
  private readonly previousLocalX: number[] = [];

  constructor(mode: LipMode, cars: readonly DeformableCar[], ejection: EjectionWatch) {
    this.anchor = STATION_ANCHORS[mode];
    this.cars = cars;
    this.ejection = ejection;
  }

  readonly collide = (car: DeformableCar, index: number): void => {
    const localX = car.group.position.x - this.anchor.x;
    const previousX = this.previousLocalX[index];
    this.previousLocalX[index] = localX;
    const crossedGoingForward = previousX !== undefined && previousX < 0 && localX >= 0;
    if (!crossedGoingForward || car.driverOut !== null) return;
    if (Math.abs(car.group.position.z - this.anchor.z) > STATION_HALF_WIDTH) return;
    this.ejection.throwDriverNow(this.cars, index);
    // A car that is falling or vaporized gives no throw, so there is nothing to cut either.
    if (car.driverOut === null) return;
    car.velocity.multiplyScalar(LIP_CAR_SPEED_KEEP);
    car.speed *= LIP_CAR_SPEED_KEEP;
  };
}
