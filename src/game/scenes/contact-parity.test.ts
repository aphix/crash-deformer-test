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

describe("contact parity: a car on the Doors ram lane does what the ram does", () => {
  for (const scenario of ["mirror", "overOpen", "shut"] as const) {
    it(`${scenario}: a ${CAR_KG} kg car at 12 km/h vs the ${CAR_KG} kg ram`, () => {
      const car = carDoorPass(scenario, 12).a;
      // Same striker geometry: a ram head shaped like the car body on the same lane (the scene's
      // 0.5 m head on the C lane runs under the mirror, a car body does not).
      const ram = ramDoorPass(scenario, 12, CAR_KG, true);
      sameParts(car, ram, scenario);
      sameCrush(car, ram, scenario);
    });
  }
});

describe("contact parity: two cars into nose and tail vs the press at matched travel", () => {
  it("20 km/h each: the press closed to the middle car's shortening", { todo: PENDING }, () => {
    const s = carSandwich(20);
    const press = pressUntil((p) => shortening(p.car!) * 1000 >= s.a.shortenMm).state;
    sameParts(s.a, press, "sandwich");
    sameCrush(s.a, press, "sandwich");
  });
});

describe("contact parity: a piston vs a car of the same mass and speed", () => {
  for (const kph of [20, 40]) {
    // A car's crushable nose takes its share of the closing (pair-contact EBS split): for equal
    // masses the struck car gets half the reduced-mass energy, the piston's hardness 0.5. Each at
    // main's squash 0.4 and the calibrated 0.32: at 0.32 the 40 km/h block sank 72 mm under a car's
    // nose vs 61 mm under the piston, a bounce frozen when the shorter car-car contact closed the solve.
    it(`${kph} km/h, ${CAR_KG} kg, crushable face`, { todo: kph === 20 ? PENDING : undefined }, () => {
      for (const squash of [0.4, 0.32]) {
        const car = carFront(kph, squash).a;
        const piston = pistonFront(kph, CAR_KG, 0.5, squash);
        sameParts(car, piston, `front, squash ${squash}`);
        sameCrush(car, piston, `front, squash ${squash}`);
      }
    });
  }
});
