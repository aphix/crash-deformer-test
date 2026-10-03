import type { DeformableCar } from "../vehicle/car.ts";
import { CAR_STYLE_IDS } from "../vehicle/car-variants.ts";
import { carClass, VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";
import type { CarFrame, NetLayout } from "./codec.ts";

/** A car's netplay array sizes (one layout for every car: the rig and `PART_SLOTS` are shared). */
export function carLayout(car: DeformableCar): NetLayout {
  const p = car.partNetSizes();
  return { ...car.deform.netSizes(), parts: p.parts, wheels: p.wheels };
}

/** A car's pose, motion and body into `f`, wreck section off (`wreck` false): a snapshot's frame, a highlight keyframe. */
export function readCarPose(car: DeformableCar, f: CarFrame): void {
  const g = car.group;
  f.x = g.position.x;
  f.y = g.position.y;
  f.z = g.position.z;
  f.pitch = g.rotation.x;
  f.yaw = g.rotation.y;
  f.roll = g.rotation.z;
  f.vx = car.velocity.x;
  f.vy = car.velocity.y;
  f.vz = car.velocity.z;
  f.wy = car.angular.y;
  f.crashed = car.crashed;
  f.vaporized = car.vaporized;
  f.falling = car.falling;
  f.sirens = car.sirens;
  f.style = CAR_STYLE_IDS.indexOf(car.style.id);
  f.cls = VEHICLE_CLASS_IDS.indexOf(carClass(car));
  f.wreck = false;
}
