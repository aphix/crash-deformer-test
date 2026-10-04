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

describe("contact guard", () => {
  const me = car(0, 0, 0, 30);

  it("meets a car head-on within 1.5 s: with time to move sideways it steers clear, without it brakes; one it cannot reach in that time it leaves alone", () => {
    const clear = guarded(me, [car(1, 0, 70, 30, -1)]);
    assert.ok(Math.abs(clear.steer) > 0.1 && clear.brake === 0, `70 m off: steer ${clear.steer.toFixed(2)}, brake ${clear.brake.toFixed(2)}`);
    const close = guarded(me, [car(1, 0, 40, 30, -1)]);
    assert.ok(close.throttle < 0.2 && close.brake > 0.5, `40 m off: throttle ${close.throttle.toFixed(2)}, brake ${close.brake.toFixed(2)}`);
    assert.deepEqual(pedals(guarded(me, [car(1, 0, 300, 30, -1)])), [1, 0, 0], "300 m off, closing at 60 m/s: 90 m in the time looked ahead");
  });

  it("meets a stopped car the zone's reach ahead of where it will be in about a second and a half: 47 m on at 30 m/s is met, 60 m on is not", () => {
    const met = guarded(me, [car(1, 0, 47, 0)]);
    assert.ok(met.steer !== 0, `47 m: steer ${met.steer}`);
    assert.deepEqual(pedals(guarded(me, [car(1, 0, 60, 0)])), [1, 0, 0], "60 m: out of the zone through the time ahead");
  });

  it("a car out of reach changes nothing about the ones in reach", () => {
    const meets = car(1, 0.8, 40, 30, -1);
    const alone = guarded(me, [meets]);
    assert.ok(alone.brake > 0.5, `the car in reach is braked for: ${alone.brake.toFixed(2)}`);
    const withFar = guarded(me, [car(2, -40, 500, 10, -1), meets, car(3, 30, -400, 25)]);
    assertSameNumbers(pedals(withFar), pedals(alone), "pedals with cars out of reach about");
  });

  it("spares the cars the driver means to hit", () => {
    const spare = new Uint8Array(32);
    spare[1] = 1;
    assert.deepEqual(pedals(guarded(me, [car(1, 0, 40, 30, -1)], spare)), [1, 0, 0]);
  });
});
