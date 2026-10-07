import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import type { CarStyleId } from "./car-variants.ts";
import { sunCoverage, uncovered } from "./shadow-cover.test-util.ts";
import { DT, paint } from "./test-support.ts";

/**
 * A car's hood, boot lid, doors and bumpers lie on the body's own shell until a crash moves them, so the sun's shadow of an
 * undamaged car is the body's. They draw into the shadow map only once the car has been hit, a door is open, or a part is
 * off: 7 shadow draws a car become 1 on the phone, with the shadow unchanged to a fraction of a texel row.
 */

/** The share of the whole car's shadow the body alone may leave lit (the bumpers stand a texel proud of the body). */
const UNDAMAGED_MISSING_MAX = 0.012;

const standingCar = (style: CarStyleId): DeformableCar => {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, style);
  car.deform.setMode("shape");
  car.spawn(8, 12, 12);
  car.group.updateMatrixWorld(true);
  car.updateSkin();
  return car;
};

/** Every mesh of the car that is drawn into the sun's shadow map right now. */
const castingMeshes = (car: DeformableCar): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  car.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.castShadow) out.push(mesh);
  });
  return out;
};

/** The hit's contact held for `frames` frames, the engine's own per-frame calls. */
function hitAndSettle(car: DeformableCar, side: "nose" | "tail" | "right", speed: number, frames: number): void {
  const dir = side === "right" ? car.right : car.forward;
  const sign = side === "tail" ? -1 : 1;
  const at = car.group.position.clone().addScaledVector(dir, side === "right" ? 0.9 : 2.05 * sign);
  at.y = 0.5;
  const inward = dir.clone().multiplyScalar(side === "tail" ? 1 : -1);
  car.applyImpact(at, inward, speed, speed);
  for (let i = 0; i < frames; i++) {
    car.deform.notifyContact();
    car.deform.feedOverlap(at, inward, 0.1, 14, DT);
    car.deform.stepStructure(DT);
    car.syncPose(DT);
    car.stepBreakage(DT);
    car.updateSkin();
  }
}

const styleCases = [
  { it: "sedan", style: "sedan", bar: false },
  { it: "hatchback", style: "hatchback", bar: false },
  { it: "wagon", style: "wagon", bar: false },
  { it: "coupe", style: "coupe", bar: false },
  { it: "pickup", style: "pickup", bar: false },
  { it: "police car", style: "police", bar: true },
] as const;

describe("given a car that has not been in a crash", () => {
  for (const testCase of styleCases) {
    it(`when it is a ${testCase.it}, then only its body${testCase.bar ? " and its light bar cast" : " casts"} a shadow and the shadow covers the ground the whole car's would, to within 1.2 %`, () => {
      const car = standingCar(testCase.style);
      const casting = castingMeshes(car);
      assert.equal(casting.length, testCase.bar ? 2 : 1, `${casting.length} meshes cast`);
      assert.ok(casting.includes(car.body), "the body casts");
      const whole = [...casting, ...car.flushCasters];
      const gap = uncovered(sunCoverage(whole, car.group.position), sunCoverage(casting, car.group.position));
      assert.ok(gap.of > 2000, `the whole car fills ${gap.of} texels`);
      assert.ok(gap.missing / gap.of <= UNDAMAGED_MISSING_MAX, `${gap.missing} of ${gap.of} texels left lit`);
    });
  }
});

const hitCases = [
  { it: "its nose is hit at 40 m/s", side: "nose", speed: 40, frames: 50 },
  { it: "its tail is hit at 30 m/s", side: "tail", speed: 30, frames: 45 },
  { it: "its right side is hit at 28 m/s", side: "right", speed: 28, frames: 45 },
] as const;

describe("given a car", () => {
  for (const testCase of hitCases) {
    it(`when ${testCase.it}, then its hood, boot lid, doors and bumpers cast shadows as they are`, () => {
      const car = standingCar("sedan");
      hitAndSettle(car, testCase.side, testCase.speed, testCase.frames);
      const casting = castingMeshes(car);
      for (const part of car.flushCasters) assert.ok(casting.includes(part), `${part.name || "a part"} does not cast after the hit`);
    });
  }

  it("when a door is swung open, then its hood, boot lid, doors and bumpers cast shadows as they are", () => {
    const car = standingCar("sedan");
    car.setDoorOpen(1, 0.6);
    car.updateSkin();
    const casting = castingMeshes(car);
    for (const part of car.flushCasters) assert.ok(casting.includes(part), `${part.name || "a part"} does not cast with a door open`);
  });

  it("when it is hit and then put back on the grid, then only its body casts a shadow again", () => {
    const car = standingCar("sedan");
    hitAndSettle(car, "nose", 40, 50);
    car.spawn(8, 12, 12);
    car.group.updateMatrixWorld(true);
    car.updateSkin();
    const casting = castingMeshes(car);
    assert.ok(casting.length === 1 && casting[0] === car.body, `${casting.length} meshes cast`);
  });
});
