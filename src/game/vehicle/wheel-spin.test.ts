import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { assignClass, CLASSES, HANDLING, type VehicleClassId } from "./vehicle-classes.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { DT, paint } from "./test-support.ts";

/**
 * The drawn wheels turn with the ground: the rate is the car's travel along its nose over the tyre's drawn radius
 * (the class's wheel scale), so reversing turns them back, a sideways slide turns nothing, and a monster's big
 * wheels turn slower than a sedan's at the same speed. Checked against the distance the car actually moved.
 */

function makeCar(cls: VehicleClassId): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  assignClass(car, cls);
  car.spawnFacing(0, 0, 0, 0);
  return car;
}

/** Roll at (vx, vz) for `secs` with the velocity held; the wheel's angle (rad) and the distance moved along the nose (m). */
function roll(car: DeformableCar, vx: number, vz: number, secs: number): { angle: number; along: number } {
  const z0 = car.group.position.z;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    car.velocity.set(vx, 0, vz);
    car.integrate(DT);
  }
  return { angle: car.wheels[0]!.rotation.x, along: car.group.position.z - z0 };
}

const radius = (cls: VehicleClassId) => TYRE_R * CLASSES[cls].wheelScale;

for (const cls of ["sedan", "monster"] as const) {
  describe(`given a ${cls} whose drawn wheels turn with the ground (the distance the car moves along its nose over the tyre's drawn radius)`, () => {
    it("when it drives 10 m/s forward and 3 m/s back for 1 s, then the wheel turns +10/r rad forward and −3/r rad back (r is the class's own tyre radius)", () => {
      const fwd = roll(makeCar(cls), 0, 10, 1);
      assert.ok(Math.abs(fwd.angle - 10 / radius(cls)) < 0.02 * (10 / radius(cls)), `forward ${fwd.angle.toFixed(3)} rad vs ${(10 / radius(cls)).toFixed(3)}`);
      const rev = roll(makeCar(cls), 0, -3, 1);
      assert.ok(Math.abs(rev.angle + 3 / radius(cls)) < 0.02 * (3 / radius(cls)), `reverse ${rev.angle.toFixed(3)} rad vs ${(-3 / radius(cls)).toFixed(3)}`);
    });

    it("when it rolls at 10, −10, −3 and 25 m/s for 1 s, then the wheel's rolled distance is the distance the car moved, signed, within 2 %, not the speed's magnitude", () => {
      for (const v of [10, -10, -3, 25]) {
        const r = roll(makeCar(cls), 0, v, 1);
        assert.ok(Math.abs(r.angle * radius(cls) - r.along) < 0.02 * Math.abs(r.along), `${v} m/s: rolled ${(r.angle * radius(cls)).toFixed(3)} m, moved ${r.along.toFixed(3)} m`);
      }
    });

    it("when it slides purely sideways and when it slides at 60° to its nose, then the sideways slide turns the wheel not at all and the 60° slide turns it by its 5 m component along the nose", () => {
      assert.equal(roll(makeCar(cls), 10, 0, 1).angle, 0);
      const slant = roll(makeCar(cls), 10 * Math.sin(Math.PI / 3), 10 * Math.cos(Math.PI / 3), 1);
      assert.ok(Math.abs(slant.angle * radius(cls) - 5) < 0.1, `rolled ${(slant.angle * radius(cls)).toFixed(3)} m of a 5 m component`);
    });
  });
}

describe("given a sedan under the real drive with the throttle held in reverse", () => {
  it("when it reverses for 3 s, then the wheels turn back and stay back once it rolls, rolling the distance it moved within 5 %", () => {
    const car = makeCar("sedan");
    const z0 = car.group.position.z;
    for (let i = 0; i < 180; i++) {
      applyDrive(car, { throttle: -1, steer: 0, brake: 0, ebrake: false, boost: false }, DT);
      car.integrate(DT);
    }
    const along = car.group.position.z - z0;
    assert.ok(car.velocity.dot(car.forward) < -2, `not reversing: ${car.velocity.dot(car.forward).toFixed(2)} m/s`);
    assert.ok(car.wheels[0]!.rotation.x < 0, `wheels turned forward ${car.wheels[0]!.rotation.x.toFixed(2)} rad reversing`);
    assert.ok(Math.abs(car.wheels[0]!.rotation.x * TYRE_R - along) < 0.05 * Math.abs(along), `rolled ${(car.wheels[0]!.rotation.x * TYRE_R).toFixed(2)} m, moved ${along.toFixed(2)} m`);
  });
});

describe("given a sedan in the air whose wheels were spun up by driving at 10 m/s", () => {
  it("when it coasts for 0.5 s, then its wheels keep 60 to 85 % of their rate (bearing drag) and are under 20 % after 3 s, while 0.5 s of gas winds them up above the coasting rate and reverse throttle slows them below it", () => {
    const rateAfter = (throttle: number, secs: number): number => {
      const car = makeCar("sedan");
      roll(car, 0, 10, 0.5);
      const spun = car.wheelRate[0]!;
      car.group.position.y = 80;
      car.airborne = true;
      car.airThrottle = throttle;
      for (let i = 0; i < Math.round(secs / DT); i++) car.integrate(DT);
      assert.ok(car.airborne, "landed");
      return car.wheelRate[0]! / spun;
    };
    const coast = rateAfter(0, 0.5);
    assert.ok(coast > 0.6 && coast < 0.85, `0.5 s of drag left ${coast.toFixed(2)} of the rate`);
    assert.ok(rateAfter(0, 3) < 0.2, "still spinning at full rate 3 s on");
    assert.ok(rateAfter(1, 0.5) > coast + 0.1, "throttle did not spin the wheels up");
    assert.ok(rateAfter(-1, 0.5) < coast - 0.1, "reverse throttle did not slow them");
  });
});

describe("given a sedan with a wheel that has left the car", () => {
  it("when the car rolls at 10 m/s for 0.5 s, then the loose wheel is not turned by it while a wheel still on the car turns", () => {
    const car = makeCar("sedan");
    car["looseWheels"][0]!.loose = true;
    roll(car, 0, 10, 0.5);
    assert.equal(car.wheels[0]!.rotation.x, 0);
    assert.ok(car.wheels[1]!.rotation.x > 1, "a wheel on the car stopped turning");
  });
});

describe("given a crashed sedan with a dead drivetrain", () => {
  it("when it rolls at 10 m/s forward and at 4 m/s back, then its wheels still freewheel at the ground's pace, signed, within 3 % of the distance moved", () => {
    for (const v of [10, -4]) {
      const car = makeCar("sedan");
      car.crashed = true;
      car.deform.drivetrainAlive = false;
      const r = roll(car, 0, v, 1);
      assert.ok(Math.abs(r.angle * radius("sedan") - r.along) < 0.03 * Math.abs(r.along), `${v} m/s: rolled ${(r.angle * radius("sedan")).toFixed(3)} m, moved ${r.along.toFixed(3)} m`);
    }
  });
});

describe("given a netplay client's sedan, whose velocity comes from a snapshot", () => {
  it("when a frame run turns its wheels for 1 s at 10 m/s forward and at 3 m/s back, then they turn the same way as a driven car's, signed, within 2 % of the snapshot velocity's turn", () => {
    for (const v of [10, -3]) {
      const car = makeCar("sedan");
      car.velocity.set(0, 0, v);
      car.refreshBasis();
      for (let i = 0; i < 60; i++) car.netFrame(DT);
      const want = v / radius("sedan");
      assert.ok(Math.abs(car.wheels[0]!.rotation.x - want) < 0.02 * Math.abs(want), `${v} m/s: ${car.wheels[0]!.rotation.x.toFixed(3)} rad vs ${want.toFixed(3)}`);
    }
  });
});

/** Each wheel's drawn roll (m) and the ground its own contact point covered along the nose, over a driven run at the 240 Hz step. */
function driveRun(cls: VehicleClassId, v0: number, secs: number, input: Partial<DriveInput>): { rolled: number[]; travel: number[]; car: DeformableCar } {
  const h = 1 / 240;
  const car = makeCar(cls);
  car.velocity.set(0, 0, v0);
  const R = radius(cls);
  const at = (i: number) => car.group.localToWorld(car.wheels[i]!.position.clone());
  const prev = [0, 1, 2, 3].map(at);
  const spin = car.wheels.map((w) => w.rotation.x);
  const rolled = [0, 0, 0, 0];
  const travel = [0, 0, 0, 0];
  for (let k = 0; k < Math.round(secs / h); k++) {
    applyDrive(car, { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false, ...input }, h);
    car.integrate(h);
    for (let i = 0; i < 4; i++) {
      rolled[i]! += (car.wheels[i]!.rotation.x - spin[i]!) * R;
      spin[i] = car.wheels[i]!.rotation.x;
      const p = at(i);
      travel[i]! += p.clone().sub(prev[i]!).dot(car.forward);
      prev[i] = p;
    }
  }
  return { rolled, travel, car };
}

describe("given each vehicle class driven at 20 m/s with half throttle and the steering at full lock", () => {
  for (const cls of ["sedan", "muscle", "truck", "monster", "police"] as const) {
    it(`when a ${cls} turns for 1.5 s, then every wheel rolls what its own contact point travels (within 1.5 %) and the two front wheels' paths differ by over 2 m, as the inner and outer wheel of a turn do`, () => {
      const r = driveRun(cls, 20, 1.5, { throttle: 0.5, steer: 1 });
      assert.ok(r.travel[0]! - r.travel[1]! > 2, `no inner/outer split in the travel: ${r.travel.map((t) => t.toFixed(1))}`);
      for (let i = 0; i < 4; i++) {
        assert.ok(Math.abs(r.rolled[i]! / r.travel[i]! - 1) < 0.015, `wheel ${i}: rolled ${r.rolled[i]!.toFixed(2)} m, its contact point went ${r.travel[i]!.toFixed(2)} m`);
      }
    });
  }
});

describe("given a sedan driven at 20 m/s with the handbrake held", () => {
  it("when it drives for 0.5 s, then it is still moving (over 5 m/s), the rear wheels stop turning (under 5 % of the distance their contact points travel) and the front wheels keep rolling (within 2 %)", () => {
    const r = driveRun("sedan", 20, 0.5, { ebrake: true });
    assert.ok(r.car.speed > 5, `stopped: ${r.car.speed.toFixed(1)} m/s`);
    assert.ok(Math.abs(r.rolled[2]!) < 0.05 * r.travel[2]! && Math.abs(r.rolled[3]!) < 0.05 * r.travel[3]!, `rear rolled ${r.rolled[2]!.toFixed(2)}, ${r.rolled[3]!.toFixed(2)} of ${r.travel[2]!.toFixed(2)} m`);
    assert.ok(Math.abs(r.rolled[0]! / r.travel[0]! - 1) < 0.02, `front rolled ${r.rolled[0]!.toFixed(2)} of ${r.travel[0]!.toFixed(2)} m`);
  });
});

describe("given a sedan driven at 30 m/s at the realistic end of the realism slider with a hard brake", () => {
  it("when it brakes for 0.3 s so the tyres lock (the drive's lock share is over 0.5), then every wheel turns less than 70 % of the distance its contact point travels", () => {
    const was = HANDLING.realism;
    HANDLING.realism = 1;
    try {
      const r = driveRun("sedan", 30, 0.3, { brake: 1 });
      assert.ok(r.car.drive.lock > 0.5, `no lock-up: ${r.car.drive.lock.toFixed(2)}`);
      for (let i = 0; i < 4; i++) assert.ok(r.rolled[i]! < 0.7 * r.travel[i]!, `wheel ${i} rolled ${r.rolled[i]!.toFixed(2)} of ${r.travel[i]!.toFixed(2)} m under a lock of ${r.car.drive.lock.toFixed(2)}`);
    } finally {
      HANDLING.realism = was;
    }
  });
});
