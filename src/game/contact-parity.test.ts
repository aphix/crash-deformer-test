import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carDoorPass, carFront, carSandwich, crushMismatch, pistonFront, pressUntil, ramDoorPass, shortening, type CarState } from "./contact-parity.test-util.ts";

// docs/CONTACT_PARITY.md: one hit, two deliveries (scene rig vs other cars), same outcome.
const CAR_KG = 858;
const PENDING = "contact parity: scene rigs and car-car still take different paths (docs/CONTACT_PARITY.md)";

function sameParts(x: CarState, y: CarState, what: string): void {
  assert.deepEqual(x.detached, y.detached, `${what}: parts off car [${x.detached}] vs rig [${y.detached}]`);
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
    it(`${scenario}: a ${CAR_KG} kg car at 12 km/h vs the ${CAR_KG} kg ram`, { todo: PENDING }, () => {
      const car = carDoorPass(scenario, 12).a;
      const ram = ramDoorPass(scenario, 12, CAR_KG);
      sameParts(car, ram, scenario);
      sameCrush(car, ram, scenario);
    });
  }
});

describe("contact parity: two cars into nose and tail vs the press at matched travel", () => {
  it("20 km/h each: the press closed to the middle car's shortening", { todo: PENDING }, () => {
    const s = carSandwich(20);
    const press = pressUntil((p) => shortening(p.car) * 1000 >= s.a.shortenMm).state;
    sameParts(s.a, press, "sandwich");
    sameCrush(s.a, press, "sandwich");
  });
});

describe("contact parity: a piston vs a car of the same mass and speed", () => {
  for (const kph of [20, 40]) {
    // A car's crushable nose takes its share of the closing (pair-contact EBS split): for equal
    // masses the struck car gets half the reduced-mass energy, the piston's hardness 0.5.
    it(`${kph} km/h, ${CAR_KG} kg, crushable face`, { todo: PENDING }, () => {
      const car = carFront(kph).a;
      const piston = pistonFront(kph, CAR_KG, 0.5);
      sameParts(car, piston, "front");
      sameCrush(car, piston, "front");
    });
  }
});
