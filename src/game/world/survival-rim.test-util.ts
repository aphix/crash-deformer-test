import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { applyDrive, idleDrive } from "../vehicle/car-drive.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import { activeGround, setGround } from "./ground.ts";
import { FRAME, makeWorld } from "./race-world.test-util.ts";
import { armedCar } from "./solid-parity.test-util.ts";

/**
 * A Survival course's rim (the closed city's ring of blocks), met by a car at speed. The car is the player's (a sedan, as slot 0 of the fleet) with the pedals flat, stepped
 * by the engine's `stepWorld` in the course's own walls and props with the race director's `courseHit` as its end-of-slice hook: the rim's contact is the whole of the
 * claim, so no run (no grid, no countdown, no pack) stands before it. Not a test file itself.
 */

/** One launch: where the car starts, which way it faces, and what it is (for a failure message). */
export type Launch = { name: string; x: number; z: number; yaw: number };

const FLAT_OUT = { ...idleDrive(), throttle: 1 };
/** The speed (m/s) a launch starts at, and the seconds it plays (from 45 m out the car is at the rim in under a second). */
export const LAUNCH_SPEED = 60;
const SECONDS = 2;

/** For each launch, how far (m) the car's centre got past the rim at its worst (`past` of the car's position: positive = through), on the course `course`. */
export function rimReach(course: string, launches: readonly Launch[], past: (x: number, z: number) => number): { name: string; far: number }[] {
  const w = makeWorld();
  w.race.showLobby(course);
  try {
    return launches.map((l) => {
      const car = armedCar("sedan");
      car.spawnFacing(l.x, l.z, l.yaw, LAUNCH_SPEED);
      // spawnFacing puts the car at y = 0: the ground under it, where the course's is not level.
      const y = activeGround().heightAt(l.x, l.z);
      if (Number.isFinite(y)) {
        car.group.position.y = y;
        for (const m of car.deform.masses) m.world.y += y;
      }
      const world = newWorld([car]);
      world.ejection = new EjectionWatch();
      world.collide = (c, i, h) => w.race.courseHit(c, i, h);
      let far = -Infinity;
      let acc = 0;
      for (let n = 0; n < SECONDS / FRAME; n++) {
        const vmax = sliceSpeed(world.cars);
        acc = Math.min(0.05, acc + FRAME);
        for (let steps = 0; acc > 1e-5 && steps < 8; steps++) {
          const h = Math.fround(physicsSlice(acc, vmax));
          applyDrive(car, FLAT_OUT, h);
          stepWorld(world, h);
          settleStep(world.cars, h, false);
          acc -= h;
        }
        far = Math.max(far, past(car.group.position.x, car.group.position.z));
      }
      return { name: l.name, far };
    });
  } finally {
    setGround(null);
  }
}
