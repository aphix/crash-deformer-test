import * as THREE from "three";
import { stepFree } from "./car-air.ts";
import type { DeformableCar } from "./car.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import type { VehicleClassId } from "./vehicle-classes.ts";
import { Ground } from "../world/ground.ts";

/** A wedge for the rigid step's rest and slope cases: flat road to x = `WEDGE_FOOT`, the face rising `WEDGE_RUN` m of x at the given angle, a flat top past it. Not a test file itself. */
export const WEDGE_FOOT = -10;
export const WEDGE_RUN = 20;
export const RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

export class Wedge extends Ground {
  readonly deg: number;

  constructor(deg: number) {
    super();
    this.deg = deg;
    const top = WEDGE_RUN * Math.tan(deg * RAD);
    this.addPlane(0, -1e4, WEDGE_FOOT, -1e4, 1e4, Infinity);
    this.addFace(WEDGE_FOOT, -1e4, 0, WEDGE_RUN, 2e4, 0, top, 0, top, Infinity);
    this.addPlane(top, WEDGE_FOOT + WEDGE_RUN, 1e4, -1e4, 1e4, Infinity);
  }
}

/** `cls` at the origin with its tyres on the face's plane (origin on the face), facing `yaw` about the face's normal; the stored pose follows. */
export function layOnWedge(cls: VehicleClassId, wedge: Wedge, yaw: number): DeformableCar {
  const car = makeCar(cls);
  car.spawnFacing(0, 0, 0, 0);
  const normal = new THREE.Vector3(-Math.sin(wedge.deg * RAD), Math.cos(wedge.deg * RAD), 0);
  car.group.quaternion.setFromUnitVectors(UP, normal).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  const euler = new THREE.Euler().setFromQuaternion(car.group.quaternion, "YXZ");
  car.yaw = euler.y;
  car.pitch = euler.x;
  car.roll = euler.z;
  car.group.position.set(0, wedge.heightAt(0, 0), 0);
  return car;
}

/** The rigid step alone (no drive, no world): `seconds` of slices at `hz`. */
export function stepSlices(car: DeformableCar, seconds: number, hz: number): void {
  for (let s = 0; s < Math.round(seconds * hz); s++) stepFree(car, 1 / hz);
}
