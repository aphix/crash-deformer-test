import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carDoorPass, carFront, carSandwich, crushMismatch, pistonFront, pressUntil, ramDoorPass, shortening, type CarState } from "./contact-parity.test-util.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";

// docs/CONTACT_PARITY.md: one hit, two deliveries (scene rig vs other cars), same outcome.
const CAR_KG = 858;
const PENDING = "contact parity: scene rigs and car-car still take different paths (docs/CONTACT_PARITY.md)";

function sameParts(x: CarState, y: CarState, what: string): void {
  assertSameDigest(x.detached, y.detached, `${what}: parts off car [${x.detached}] vs rig [${y.detached}]`);
  assert.ok(Math.abs(x.doorDeg - y.doorDeg) <= 3, `${what}: door ${x.doorDeg.toFixed(1)}° vs ${y.doorDeg.toFixed(1)}°`);
  assert.equal(x.latched, y.latched, `${what}: latch`);
  assert.ok(Math.abs(x.mirrorFoldDeg - y.mirrorFoldDeg) <= 3, `${what}: mirror fold ${x.mirrorFoldDeg.toFixed(1)}° vs ${y.mirrorFoldDeg.toFixed(1)}°`);
  assert.equal(x.drivetrainAlive, y.drivetrainAlive, `${what}: drivetrain`);
}

function sameCrush(x: CarState, y: CarState, what: string): void {
  const off = crushMismatch(x, y);
  assert.deepEqual(off, [], `${what}: particle crush (car/rig mm) ${off.join(", ")}`);
  assert.ok(Math.abs(x.cabinMm - y.cabinMm) <= Math.max(10, 0.15 * Math.max(x.cabinMm, y.cabinMm)), `${what}: cabin ${x.cabinMm} vs ${y.cabinMm} mm`);
}

describe("given the Doors ram lane's three scenes (mirror: the striker grazes a shut door's mirror; overOpen: it drives an open door past its stop; shut: it drives an open door shut)", () => {
  for (const scenario of ["mirror", "overOpen", "shut"] as const) {
    it(`when a ${CAR_KG} kg car at 12 km/h runs the ${scenario} scene instead of the ${CAR_KG} kg ram, then the same parts come off and the door, latch, mirror fold, drivetrain and crush match the ram's`, () => {
      const car = carDoorPass(scenario, 12).a;
      // Same striker geometry: a ram head shaped like the car body on the same lane (the scene's
      // 0.5 m head on the C lane runs under the mirror, a car body does not).
      const ram = ramDoorPass(scenario, 12, CAR_KG, true);
      sameParts(car, ram, scenario);
      sameCrush(car, ram, scenario);
    });
  }
});

describe("given two cars driving into the nose and tail of a middle car, and a press closed to the same shortening", () => {
  it("when each car hits at 20 km/h, then the middle car's parts and crush match the press's", { todo: PENDING }, () => {
    const s = carSandwich(20);
    const press = pressUntil((p) => shortening(p.car!) * 1000 >= s.a.shortenMm).state;
    sameParts(s.a, press, "sandwich");
    sameCrush(s.a, press, "sandwich");
  });
});

describe("given a piston and a car of the same mass and speed striking a crushable face", () => {
  for (const kph of [20, 40]) {
    // A car's crushable nose takes its share of the closing (pair-contact EBS split): for equal
    // masses the struck car gets half the reduced-mass energy, the piston's hardness 0.5. Each at
    // main's squash 0.4 and the calibrated 0.32: at 0.32 the 40 km/h block sank 72 mm under a car's
    // nose vs 61 mm under the piston, a bounce frozen when the shorter car-car contact closed the solve.
    it(`when a ${CAR_KG} kg car and a ${CAR_KG} kg piston each hit at ${kph} km/h at crush softness 0.4 and 0.32, then the car's parts and crush match the piston's`, { todo: kph === 20 ? PENDING : undefined }, () => {
      for (const squash of [0.4, 0.32]) {
        const car = carFront(kph, squash).a;
        const piston = pistonFront(kph, CAR_KG, 0.5, squash);
        sameParts(car, piston, `front, squash ${squash}`);
        sameCrush(car, piston, `front, squash ${squash}`);
      }
    });
  }
});
