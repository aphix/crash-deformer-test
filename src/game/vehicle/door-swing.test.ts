import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { makeCar, runWall } from "../contact/crash-scenarios.test-util.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { DeformableCar } from "./car.ts";
import { DOOR_AJAR, DOOR_OPEN_MAX } from "./car-core.ts";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { swingAccel } from "./car-wear.ts";
import { DT, paint } from "./test-support.ts";

/**
 * An unlatched door is a pendulum on its hinge, driven by the car's own acceleration in the car frame (docs/PANEL_FLAP.md):
 * braking swings it forward (open), accelerating shuts it, the outside of a turn opens it and the inside shuts it. It latches
 * through the same `closeDoor` rule as the Doors ram.
 */

const D2R = Math.PI / 180;
const H = 1 / 240;

/** Open `deg` on `side`, then `steps` of `H` with the car-frame acceleration (`ax` right, `az` forward, m/s²). */
function push(car: DeformableCar, ax: number, az: number, seconds: number): void {
  const r = car.rightFlat;
  const f = car.fwdFlat;
  for (let t = 0; t < seconds - 1e-9; t += H) {
    car.velocity.x += (ax * r.x + az * f.x) * H;
    car.velocity.z += (ax * r.z + az * f.z) * H;
    car.swingDoors(H);
  }
}

function open(deg: number, side: -1 | 1 = 1, yaw = 0, v0 = 0): DeformableCar {
  const car = makeCar();
  car.spawnFacing(0, 0, yaw, v0);
  car.setDoorOpen(side, deg * D2R);
  return car;
}

const deg = (car: DeformableCar, side: -1 | 1 = 1): number => car.doorHinge(side).theta / D2R;

describe("the door pendulum's drive", () => {
  it("good: braking opens a door of either side, accelerating shuts it", () => {
    for (const sx of [-1, 1]) {
      assert.ok(swingAccel(sx, 0.5, 0, -6, 0, 0) > 0, `side ${sx} braking`);
      assert.ok(swingAccel(sx, 0.5, 0, 6, 0, 0) < 0, `side ${sx} accelerating`);
    }
  });

  it("good: the outside of a turn opens its door, the inside shuts it; one law, mirrored", () => {
    // A turn toward +x pushes the frame's contents toward −x: the −x (left) door opens, the +x one shuts.
    assert.ok(swingAccel(-1, 0.6, 8, 0, 0, 0) > 0 && swingAccel(1, 0.6, 8, 0, 0, 0) < 0);
    for (const [ax, az, w, al] of [
      [5, -3, 0.4, 0.2],
      [-2, 4, 1, -3],
    ] as const) assert.ok(Math.abs(swingAccel(-1, 0.7, -ax, az, w, -al) - swingAccel(1, 0.7, ax, az, w, al)) < 1e-9, "mirror");
  });

  it("good: a shut door is not moved by braking (the force is along its slab)", () => {
    assert.equal(swingAccel(1, 0, 0, -9, 0, 0), 0);
  });
});

describe("an open door swings with the car", () => {
  it("good: braking swings it forward: 30° opens past 50° in 0.4 s (it was fixed at 30° for ever)", () => {
    for (const side of [-1, 1] as const) {
      const car = open(30, side);
      push(car, 0, -6, 0.4);
      assert.ok(deg(car, side) > 50, `side ${side} at ${deg(car, side).toFixed(1)}°`);
      assert.ok(!car.doorHinge(side).latched);
    }
  });

  it("good: accelerating swings it back and latches it; the door stays on", () => {
    for (const side of [-1, 1] as const) {
      const car = open(30, side);
      push(car, 0, 6, 0.7);
      const h = car.doorHinge(side);
      assert.ok(h.latched && h.theta === 0, `side ${side}: ${deg(car, side).toFixed(1)}° latched ${h.latched}`);
      assert.ok(!car.partOff(side < 0 ? "doorL" : "doorR"), "the door tore off");
    }
  });

  it("good: a push too soft to shut it leaves it open, a gentle one does not move it at all", () => {
    const brief = open(60);
    push(brief, 0, 6, 0.1);
    push(brief, 0, 0, 3);
    assert.ok(deg(brief) > 20 && deg(brief) < 55 && !brief.doorHinge(1).latched, `brief push left it at ${deg(brief).toFixed(1)}°`);
    const long = open(60);
    push(long, 0, 6, 0.1);
    push(long, 0, 6, 0.9);
    assert.ok(long.doorHinge(1).latched, `a long push left it at ${deg(long).toFixed(1)}°`);
    const gentle = open(30);
    push(gentle, 0, 1, 3);
    assert.ok(Math.abs(deg(gentle) - 30) < 1e-6, "1 m/s² moved a door the hinge friction holds");
  });

  it("good: in a turn the outside door swings open and the inside door slams shut and latches", () => {
    const out = open(40, -1);
    push(out, 8, 0, 0.5);
    assert.ok(deg(out, -1) > 60, `outside door at ${deg(out, -1).toFixed(1)}°`);
    const inside = open(40, 1);
    push(inside, 8, 0, 0.5);
    assert.ok(inside.doorHinge(1).latched && !inside.partOff("doorR"), "the inside door should latch");
  });

  it("good: only the car-frame acceleration counts: turned any way, or carried at 30 m/s, the swing is the same", () => {
    const at = (yaw: number, v0: number) => {
      const car = open(35, 1, yaw, v0);
      const trace: number[] = [];
      for (let k = 0; k < 8; k++) {
        push(car, -2, -5, 0.05);
        trace.push(deg(car));
      }
      return trace;
    };
    const base = at(0, 0);
    assert.ok(base[7]! > 50, "the base case did not swing");
    for (const [yaw, v0] of [
      [Math.PI / 2, 0],
      [2.2, 0],
      [0, 30],
    ] as const) {
      const other = at(yaw, v0);
      for (let k = 0; k < 8; k++) assert.ok(Math.abs(other[k]! - base[k]!) < 1e-6, `yaw ${yaw} v0 ${v0} step ${k}: ${other[k]} vs ${base[k]}`);
    }
  });

  it("good: a crash's spike saturates: a 15 m/s jolt in one step does not tear the door", () => {
    const car = open(30);
    car.velocity.z -= 15;
    for (let k = 0; k < 60; k++) car.swingDoors(H);
    assert.ok(!car.partOff("doorR"));
    assert.ok(deg(car) <= DOOR_OPEN_MAX / D2R + 1e-9);
  });

  it("good: the car's swing shuts through the Doors ram's rule: past SLAM_TEAR_J the door leaves, below it latches", () => {
    // The rule is `closeDoor`, door-rig.test.ts "slam overload" pins its energies; here the car's own swing reaches it.
    for (const [omega, off] of [
      [-15, false],
      [-17.5, true],
    ] as const) {
      const car = open(30);
      car.doorHinge(1).omega = omega;
      for (let k = 0; k < 240; k++) car.swingDoors(H);
      assert.equal(car.partOff("doorR"), off, `${omega} rad/s`);
      if (!off) assert.ok(car.doorHinge(1).latched);
    }
  });
});

describe("driven for real", () => {
  const IDLE: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  function drive(v0: number, deg0: number, input: Partial<DriveInput>, seconds: number): DeformableCar {
    const car = new DeformableCar(paint(), new THREE.Scene());
    car.deform.setMode("shape");
    car.spawnFacing(0, 0, 0, v0);
    car.group.updateMatrixWorld(true);
    car.setDoorOpen(1, deg0 * D2R);
    const w = newWorld([car], null);
    let acc = 0;
    for (let t = 0; t < seconds; t += DT) {
      acc = Math.min(0.05, acc + DT);
      while (acc > 1e-5) {
        const h = physicsSlice(acc, sliceSpeed(w.cars));
        applyDrive(car, { ...IDLE, ...input }, h);
        stepWorld(w, h);
        acc -= h;
      }
      car.updateDeform(DT);
    }
    return car;
  }

  it("good: full braking from 25 m/s throws a 30° door onto its stop, which it holds", () => {
    const car = drive(25, 30, { brake: 1 }, 3);
    assert.ok(Math.abs(deg(car) - DOOR_OPEN_MAX / D2R) < 0.5, `${deg(car)}°`);
    assert.ok(!car.partOff("doorR"));
  });

  it("good: a launch swings a 60° door shut", () => {
    const car = drive(3, 60, { throttle: 1 }, 3);
    assert.ok(car.doorHinge(1).latched && !car.partOff("doorR"), `${deg(car)}°`);
  });

  it("good: a turn shuts the door on its inside", () => {
    const car = drive(15, 40, { throttle: 0.6, steer: 1 }, 3);
    assert.ok(car.doorHinge(1).latched, `${deg(car)}°`);
  });
});

class Probe extends DeformableCar {
  jam(side: -1 | 1): number {
    return this.doorParts[side < 0 ? 0 : 1]!.hingeT;
  }
}

describe("a door a side hit has sprung swings with the car", () => {
  it("good: a 40 km/h side wall leaves the struck door unlatched, at least as far open as its crash jam", () => {
    const car = new Probe(paint(), new THREE.Scene());
    car.deform.setMode("shape");
    runWall(40, 1, "side", { car });
    const sides = ([-1, 1] as const).filter((s) => !car.doorHinge(s).latched);
    assert.equal(sides.length, 1, `unlatched doors: ${sides.length}`);
    const jam = car.jam(sides[0]!);
    assert.ok(jam > DOOR_AJAR, `jam ${jam}`);
    assert.ok(car.doorHinge(sides[0]!).theta >= Math.min(jam * 1.45, DOOR_OPEN_MAX) - 1e-9, "the door hangs shut past its jam");
  });
});
