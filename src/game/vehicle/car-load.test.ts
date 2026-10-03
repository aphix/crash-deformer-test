import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { DeformableCar } from "./car.ts";
import { assignClass, VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { DriveCam } from "../present/engine-camera.ts";

const FRAME = 1 / 60;
const DEG = 180 / Math.PI;
const IDLE: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };

/** Most the drawn body may pitch (deg) in a launch or a stop, per class: a few degrees, the monster more. */
const PITCH_MAX: Record<VehicleClassId, number> = { sedan: 3, muscle: 3, police: 3, truck: 4.5, monster: 6 };
const ROLL_MAX = 6.5;

type Sample = { pitch: number; roll: number; speed: number };

/** One car on the flat from `v0` under `input` for `seconds`, as the engine steps it; the drawn body's pitch (+ nose up) and roll (+ the +x side up) each frame. */
function drive(cls: VehicleClassId, v0: number, input: (speed: number) => Partial<DriveInput>, seconds: number): Sample[] {
  const car = new DeformableCar(paint(), new THREE.Scene());
  assignClass(car, cls);
  const w = newWorld([car], null);
  car.spawnFacing(0, 0, 0, v0);
  const body = car.group.getObjectByName("classLift")!;
  const out: Sample[] = [];
  let acc = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      applyDrive(car, { ...IDLE, ...input(car.speed) }, h);
      stepWorld(w, h);
      acc -= h;
    }
    car.updateDeform(FRAME);
    out.push({ pitch: -body.rotation.x * DEG, roll: body.rotation.z * DEG, speed: car.speed });
  }
  car.dispose();
  return out;
}

/** The sample furthest from level on `axis`. */
function peak(s: Sample[], axis: "pitch" | "roll"): number {
  return s.reduce((m, x) => (Math.abs(x[axis]) > Math.abs(m) ? x[axis] : m), 0);
}

describe("load transfer: the drawn body squats, dives and leans", () => {
  for (const cls of VEHICLE_CLASS_IDS) {
    it(`good: ${cls} launches nose up, brakes nose down, within a few degrees`, () => {
      const launch = peak(drive(cls, 0, () => ({ throttle: 1 }), 3), "pitch");
      assert.ok(launch > 1 && launch <= PITCH_MAX[cls], `launch pitch ${launch.toFixed(2)}°`);
      const stop = peak(drive(cls, 25, () => ({ brake: 1 }), 3), "pitch");
      assert.ok(stop < -1 && stop >= -PITCH_MAX[cls], `braking pitch ${stop.toFixed(2)}°`);
    });

    it(`good: ${cls} leans outward in a steady turn, mirrored each way, within ${ROLL_MAX}°`, () => {
      // Steer +1 swings the nose left: the +x side is the inside and rises.
      const hold = (steer: number) => drive(cls, 20, (v) => ({ throttle: v < 20 ? 0.6 : 0.1, steer }), 4);
      const left = hold(1);
      const right = hold(-1);
      const r = left[left.length - 1]!.roll;
      assert.ok(r > 2 && peak(left, "roll") <= ROLL_MAX, `left turn rolls ${r.toFixed(2)}°`);
      assert.ok(Math.abs(right[right.length - 1]!.roll + r) < 0.05, `right turn rolls ${right[right.length - 1]!.roll.toFixed(2)}°`);
    });
  }

  it("good: a stopped car is level, and one braked to a stop settles level", () => {
    for (const cls of VEHICLE_CLASS_IDS) {
      const rest = drive(cls, 0, () => ({}), 1);
      assert.ok(Math.abs(peak(rest, "pitch")) + Math.abs(peak(rest, "roll")) < 0.01, `${cls} at rest`);
    }
    const stop = drive("sedan", 20, () => ({ brake: 1 }), 6);
    const end = stop[stop.length - 1]!;
    assert.ok(end.speed < 0.05 && Math.abs(end.pitch) < 0.02 && Math.abs(end.roll) < 0.02, `stopped at ${end.speed.toFixed(2)} m/s, ${end.pitch.toFixed(3)}° / ${end.roll.toFixed(3)}°`);
  });
});

describe("camera ride", () => {
  const H = 1 / 60;
  function rig(ride: boolean) {
    const cam = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 180);
    const drive = new DriveCam();
    drive.ride = ride;
    return { cam, drive };
  }

  /** Two rigs over one car, the second riding its body: after `seconds` with the springs at `offsets`, how the second sits against the first. */
  function against(offsets: number[], seconds: number, look?: [number, number]): { dy: number; tilt: number } {
    const car = new DeformableCar(paint(), new THREE.Scene());
    assignClass(car, "sedan");
    car.spawnFacing(0, 0, 0, 20);
    car.group.updateMatrixWorld(true);
    const [a, b] = [rig(false), rig(true)];
    const step = () => {
      for (const r of [a, b]) {
        r.drive.update(r.cam, car, "third", H, 0, 0);
        r.cam.updateMatrixWorld();
      }
    };
    for (let t = 0; t < 1; t += H) step();
    car.suspension.offset.set(offsets);
    if (look) for (const r of [a, b]) r.drive.nudge(look[0], look[1]);
    for (let t = 0; t < seconds; t += H) step();
    return { dy: b.cam.position.y - a.cam.position.y, tilt: a.cam.quaternion.angleTo(b.cam.quaternion) * DEG };
  }

  it("good: a squat drops the eye and tips it up, a dive lifts and tips it down, a bump drops it; each under 4 cm and 0.6°", () => {
    // Offsets well past the springs' stops (a sedan's are 6.5 cm): the bound holds for any input.
    const squat = against([0.2, 0.2, -0.2, -0.2], 2);
    assert.ok(squat.dy < -0.02 && squat.dy > -0.04, `squat drop ${(squat.dy * 100).toFixed(2)} cm`);
    assert.ok(squat.tilt > 0.3 && squat.tilt <= 0.6, `squat tilt ${squat.tilt.toFixed(3)}°`);
    const dive = against([-0.2, -0.2, 0.2, 0.2], 2);
    assert.ok(dive.dy > 0.02 && dive.dy < 0.04, `dive lift ${(dive.dy * 100).toFixed(2)} cm`);
    assert.ok(dive.tilt > 0.3 && dive.tilt <= 0.6, `dive tilt ${dive.tilt.toFixed(3)}°`);
    const bump = against([-0.065, -0.065, -0.065, -0.065], 2);
    assert.ok(bump.dy < -0.01 && bump.dy > -0.04 && bump.tilt < 0.01, `bump ${(bump.dy * 100).toFixed(2)} cm, ${bump.tilt.toFixed(3)}°`);
  });

  it("good: a look offset the player holds is their own framing: the ride lets go of it", () => {
    const held = against([0.2, 0.2, -0.2, -0.2], 0.7, [100, 0]);
    assert.ok(Math.abs(held.dy) < 0.001 && held.tilt < 0.02, `held look: ${(held.dy * 100).toFixed(3)} cm, ${held.tilt.toFixed(3)}°`);
  });
});
