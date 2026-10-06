import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { CAGES, type BodyPartName } from "../kernel/rig-spec.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { paint } from "../vehicle/test-support.ts";

const DT = 1 / 240;
const NAMES = CAGES.map((c) => c.name);

/** A car whose nose took a 40 m/s hit 2 m ahead, then 50 steps on: cages moved, sensors compressed. */
function crashed(): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene());
  car.spawn(0, 0, 0);
  car.group.updateMatrixWorld(true);
  const hit = car.group.position.clone().addScaledVector(car.forward, 2.05);
  hit.y = 0.4;
  car.applyImpact(hit, car.forward.clone().negate(), 40, 40);
  for (let i = 0; i < 50; i++) car.step(DT);
  return car;
}

/** The plain definitions the memoised ones replaced, read off the car's own cages and sensors. */
function plainStrain(car: DeformableCar, name: BodyPartName): number {
  const cage = car.deform["cageByPart"].get(name)!;
  let max = 0;
  for (let a = 0; a < 8; a++) {
    for (let b = a + 1; b < 8; b++) max = Math.max(max, Math.abs(cage.corners[a]!.distanceTo(cage.corners[b]!) - cage.restCorners[a]!.distanceTo(cage.restCorners[b]!)));
  }
  return max;
}

function plainCompression(car: DeformableCar, name: BodyPartName): number {
  let max = 0;
  for (const s of car.deform["sensors"]) if (car.deform["cages"][s.partIndex]?.spec.name === name && s.compression > max) max = s.compression;
  return max;
}

describe("given a car that has taken a hard nose hit", () => {
  test("when every cage's strain and every part's compression are read, then each equals the plain definition, bit for bit, on the first read and on repeats", () => {
    const car = crashed();
    let moved = 0;
    for (const name of NAMES) {
      const strain = plainStrain(car, name);
      if (strain > 0.001) moved++;
      for (let again = 0; again < 3; again++) {
        assert.equal(car.deform.cageStrain(name), strain, `strain of ${name}`);
        assert.equal(car.deform.partCompression(name), plainCompression(car, name), `compression of ${name}`);
      }
    }
    assert.ok(moved >= 2, `${moved} cages strained: the hit moved nothing`);
    assert.ok(NAMES.some((name) => car.deform.partCompression(name) > 0.05), "no part is compressed: the hit did nothing");
  });

  test("when a cage's corner moves between two reads, then the second read measures the new corners, not the memo", () => {
    const car = crashed();
    const name: BodyPartName = "doorLeft";
    const before = car.deform.cageStrain(name);
    const corner = car.deform["cageByPart"].get(name)!.corners[3]!;
    corner.x += 0.07;
    const after = car.deform.cageStrain(name);
    assert.equal(after, plainStrain(car, name));
    assert.notEqual(after, before, "a moved corner leaves the strain as it was");
    corner.x -= 0.07;
    assert.equal(car.deform.cageStrain(name), before, "back where it was, the same answer");
  });

  test("when a corner reads NaN, then the strain is whatever the plain definition says, on every read", () => {
    const car = crashed();
    const name: BodyPartName = "bonnet";
    car.deform["cageByPart"].get(name)!.corners[0]!.y = NaN;
    for (let i = 0; i < 3; i++) assert.equal(Object.is(car.deform.cageStrain(name), plainStrain(car, name)), true);
  });

  test("when a part name no cage has is asked for, then the strain and the compression are 0", () => {
    const car = crashed();
    assert.equal(car.deform.cageStrain("nope" as BodyPartName), 0);
    assert.equal(car.deform.partCompression("nope" as BodyPartName), 0);
  });
});
