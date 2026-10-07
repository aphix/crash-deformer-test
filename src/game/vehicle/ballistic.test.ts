import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { beginFakeFall, type DeformableCar } from "./car.ts";
import { COM_Y, G, readContact } from "./car-air.ts";
import { makeCar } from "./ground-probe.test-util.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";

/**
 * A body that touches nothing is moved by gravity alone: its centre follows the parabola of the velocity it was launched with, and its
 * orientation turns at the spin it had. The reference is closed-form (`y0 + vy t - g t^2 / 2`, `x0 + vx t`, a rotation by `spin t`); the
 * bound is float error, the rounding of one step's sum (at most `Number.EPSILON` of the largest coordinate it adds to) over every step.
 */
const RATES_HZ = [60, 144, 240] as const;
const FLIGHT_S = 1.8;
const HEIGHT = 100;
const LAUNCH = new THREE.Vector3(10, 5, 3);
const SPIN = new THREE.Vector3(0.4, -1.1, 0.7);
const NO_PEDALS: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)] as const;

function launch(spin: THREE.Vector3) {
  const car = makeCar("sedan");
  car.spawnFacing(0, 0, 0, 0);
  car.group.position.set(0, HEIGHT, 0);
  car.velocity.copy(LAUNCH);
  car.angular.copy(spin);
  readContact(car);
  return car;
}

/** The car's centre of mass: the group's origin `COM_Y` up its own axis. */
function centre(car: DeformableCar, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, COM_Y, 0).applyQuaternion(car.group.quaternion).add(car.group.position);
}

/** Step `car` for `FLIGHT_S` at `hz` with the drive run every slice; the worst distance (m) of its centre from the parabola, and of its body axes from the turn. */
function fly(car: DeformableCar, hz: number, spin: THREE.Vector3): { centreError: number; axesError: number; bound: number } {
  const start = centre(car, new THREE.Vector3());
  const q0 = car.group.quaternion.clone();
  const world = newWorld([car], null);
  const dt = 1 / hz;
  const steps = Math.round(FLIGHT_S * hz);
  const extent = HEIGHT + LAUNCH.length() * FLIGHT_S + 0.5 * G * FLIGHT_S ** 2;
  const now = new THREE.Vector3();
  const want = new THREE.Vector3();
  const turned = new THREE.Quaternion();
  let centreError = 0;
  let axesError = 0;
  for (let k = 1; k <= steps; k++) {
    applyDrive(car, NO_PEDALS, dt);
    stepWorld(world, dt);
    const t = k * dt;
    want.copy(start).addScaledVector(LAUNCH, t);
    want.y -= 0.5 * G * t * t;
    centreError = Math.max(centreError, centre(car, now).distanceTo(want));
    const turn = spin.length() * t;
    turned.setFromAxisAngle(turn > 0 ? spin.clone().normalize() : AXES[1], turn).multiply(q0);
    for (const axis of AXES) axesError = Math.max(axesError, axis.clone().applyQuaternion(car.group.quaternion).distanceTo(axis.clone().applyQuaternion(turned)));
  }
  return { centreError, axesError, bound: Number.EPSILON * extent * steps };
}

describe("given a car spawned 100 m up with a velocity and no spin, touching nothing, the drive run every slice with no pedals", () => {
  for (const hz of RATES_HZ) {
    it(`when it is stepped ${FLIGHT_S} s at ${hz} Hz, then its centre is on the closed-form parabola of its launch velocity, within float error, and it has no spin`, () => {
      const car = launch(new THREE.Vector3());
      const r = fly(car, hz, new THREE.Vector3());
      assert.ok(r.centreError <= r.bound, `centre ${r.centreError} m off the parabola (float error ${r.bound})`);
      assert.ok(r.axesError <= r.bound, `axes ${r.axesError} off the identity turn (float error ${r.bound})`);
      assert.equal(car.angular.length(), 0);
    });
  }
});

describe("given a car launched with a velocity and a spin that is swapped for the fake fall at launch, touching nothing", () => {
  for (const hz of RATES_HZ) {
    it(`when it is stepped ${FLIGHT_S} s at ${hz} Hz, then its centre is on the closed-form parabola and its body turns at its spin, within float error`, () => {
      const car = launch(SPIN);
      beginFakeFall(car);
      const r = fly(car, hz, SPIN);
      assert.ok(car.falling);
      assert.ok(r.centreError <= r.bound, `centre ${r.centreError} m off the parabola (float error ${r.bound})`);
      assert.ok(r.axesError <= r.bound, `axes ${r.axesError} off the spin's turn (float error ${r.bound})`);
    });
  }
});
