import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { makeCar, runWall } from "../contact/crash-scenarios.test-util.ts";
import { makeBox, strikeCar } from "../contact/external-contact.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { PLATE } from "./compactor.ts";
import { JerseyBarrier } from "./engine-props.ts";
import { firePiston } from "./piston-rig.test-util.ts";

/**
 * One car, one hard flat face, one closing speed, delivered by every striker the scenes have (docs/UNIFIED_CONTACT.md 13): the
 * range's slab held still with the car driving into it (the reference: a car against a solid), the piston, the moving slab, and
 * the press plate. Each leaves the nose crushed and the drivetrain at some health; "the same everywhere" is those healths agreeing.
 * Not a test file itself.
 */

/** The squash setting the calibration is made at (`docs/CRASH_CALIBRATION.md`). */
const SQUASH = 0.32;
/** Start the car 6 m from the struck face so no striker's approach is in the measurement. */
const RUN_UP = 6;
const SLICE = 1 / 120;
const SECONDS = 4;
/** The piston's mass (kg): 23 times the car's, so it is nearly the unmoving face the slab is. */
export const PISTON_KG = 20000;

export type Striker = "slab held still, car drives in" | "piston" | "moving slab" | "press plate";

export const STRIKERS: readonly Striker[] = ["slab held still, car drives in", "piston", "moving slab", "press plate"];

function parked(): DeformableCar {
  const car = makeCar("shape", SQUASH);
  car.spawnFacing(0, 0, 0, 0);
  return car;
}

/** The car's drivetrain health (1 whole, 0 dead) after `striker` met its nose at `kph`. */
export function healthAfter(striker: Striker, kph: number): number {
  const speed = kph / 3.6;
  if (striker === "slab held still, car drives in") {
    const car = makeCar("shape", SQUASH);
    runWall(kph, 1, "front", { car });
    return car.deform.drivetrainHealth;
  }
  const car = parked();
  if (striker === "piston") {
    firePiston(car, "front", { speedKph: kph, massKg: PISTON_KG, hardness: 1, after: 1.5 });
  } else if (striker === "moving slab") {
    // A held slab is a kinematic striker (`kg` Infinity): its speed is its own, whatever the car gives back.
    const slab = new JerseyBarrier(new THREE.Scene(), new THREE.Group());
    slab.kg = Infinity;
    slab.yaw = Math.PI / 2;
    slab.group.rotation.y = slab.yaw;
    slab.group.position.set(0, 0, RUN_UP);
    const world = newWorld([car], slab);
    for (let step = 0; step < SECONDS / SLICE; step++) {
      slab.vel.set(0, 0, -speed);
      slab.step(SLICE);
      stepWorld(world, SLICE);
    }
  } else {
    // The press plate: the compactor's own slab (`PLATE`, kinematic, hardness 1) closing at `speed` instead of the press's 0.55 m/s.
    const plate = makeBox();
    plate.hx = PLATE.hx;
    plate.hy = PLATE.hy;
    plate.hz = PLATE.hz;
    plate.y = PLATE.y;
    plate.yaw = Math.PI;
    plate.vz = -speed;
    let z = RUN_UP + PLATE.hz;
    for (let step = 0; step < SECONDS / SLICE; step++) {
      z -= speed * SLICE;
      plate.z = z;
      strikeCar(car, plate, SLICE, true);
      if (car.deform.massActive) {
        car.deform.stepStructure(SLICE);
        strikeCar(car, plate, SLICE, false);
        car.syncPose(SLICE);
      }
      car.afterContacts(SLICE);
      car.stepBreakage(SLICE);
    }
  }
  return car.deform.drivetrainHealth;
}
