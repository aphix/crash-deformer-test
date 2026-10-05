import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { guardContact } from "./contact-guard.ts";

/** A car at (`x`, `z`) doing `speed` m/s along +z (`dir` 1) or −z (−1). */
function car(id: number, x: number, z: number, speed: number, dir: 1 | -1 = 1): AiCar {
  return { ...blankAiCar(id), x, z, yaw: dir === 1 ? 0 : Math.PI, vz: speed * dir };
}

/** What the guard makes of the plan "full throttle, straight on" for `self` among `others` (class brake 20 m/s², lead brake 11 m/s², lock 1.5 rad/s). */
function guarded(self: AiCar, others: AiCar[], spare = new Uint8Array(32)): DriveInput {
  const out: DriveInput = { ...idleDrive(), throttle: 1 };
  guardContact(self, [self, ...others], others.length + 1, spare, 20, 11, 1.5, out);
  return out;
}

/** The plan's three pedals as `guarded` hands them back. */
const pedals = (out: DriveInput) => [out.throttle, out.brake, out.steer];

describe("given a driver planning full throttle straight on at 30 m/s, with the contact guard (the AI's last-moment collision avoidance) checking that plan", () => {
  const me = car(0, 0, 0, 30);

  it("when another car comes head-on at 30 m/s, then at 70 m it steers clear without braking, at 40 m it brakes instead, and at 300 m (out of the time it looks ahead) it leaves the plan alone", () => {
    const clear = guarded(me, [car(1, 0, 70, 30, -1)]);
    assert.ok(Math.abs(clear.steer) > 0.1 && clear.brake === 0, `70 m off: steer ${clear.steer.toFixed(2)}, brake ${clear.brake.toFixed(2)}`);
    const close = guarded(me, [car(1, 0, 40, 30, -1)]);
    assert.ok(close.throttle < 0.2 && close.brake > 0.5, `40 m off: throttle ${close.throttle.toFixed(2)}, brake ${close.brake.toFixed(2)}`);
    assert.deepEqual(pedals(guarded(me, [car(1, 0, 300, 30, -1)])), [1, 0, 0], "300 m off, closing at 60 m/s: 90 m in the time looked ahead");
  });

  it("when a stopped car is 47 m or 60 m dead ahead, then the guard steers away from the one at 47 m (the reach of its zone about 1.5 s ahead) and leaves the plan alone for the one at 60 m", () => {
    const met = guarded(me, [car(1, 0, 47, 0)]);
    assert.ok(met.steer !== 0, `47 m: steer ${met.steer}`);
    assert.deepEqual(pedals(guarded(me, [car(1, 0, 60, 0)])), [1, 0, 0], "60 m: out of the zone through the time ahead");
  });

  it("when cars far out of reach are added around a car it is about to meet, then the pedals and steering stay exactly what they were with that car alone", () => {
    const meets = car(1, 0.8, 40, 30, -1);
    const alone = guarded(me, [meets]);
    assert.ok(alone.brake > 0.5, `the car in reach is braked for: ${alone.brake.toFixed(2)}`);
    const withFar = guarded(me, [car(2, -40, 500, 10, -1), meets, car(3, 30, -400, 25)]);
    assertSameNumbers(pedals(withFar), pedals(alone), "pedals with cars out of reach about");
  });

  it("when the car coming head-on at 40 m is one the driver means to hit, then the guard leaves the plan alone", () => {
    const spare = new Uint8Array(32);
    spare[1] = 1;
    assert.deepEqual(pedals(guarded(me, [car(1, 0, 40, 30, -1)], spare)), [1, 0, 0]);
  });
});
