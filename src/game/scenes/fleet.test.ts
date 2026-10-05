import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FLEET_MIN_SEP, MAX_CARS, fleetClass, fleetStyle, layoutDerby, layoutFleet, slotType } from "./fleet.ts";
import { scatterRampBalls, type RampBall } from "./engine-props.ts";
import { mulberry32 } from "../world/placements.ts";

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("given a player's car pick, hatchback", () => {
  const hatchback = { cls: "sedan", style: "hatchback" } as const;
  it("when a field outside the stack is built, then only slot 0 is the pick and the rest are the fleet's cycle", () => {
    assert.deepEqual(slotType(0, hatchback, false), hatchback);
    for (let i = 1; i < 12; i++) assert.deepEqual(slotType(i, hatchback, false), { cls: fleetClass(i), style: fleetStyle(i) });
  });
  it("when the stack is built, then every slot is the pick", () => {
    for (let i = 0; i < 20; i++) assert.deepEqual(slotType(i, hatchback, true), hatchback);
  });
});

const fixedSpeedCases = [
  { it: "when the speed range is 0 to 0, then all 6 cars spawn parked at speed 0", count: 6, minSpeed: 0, maxSpeed: 0, seed: 3, expectedSpeed: 0 },
  { it: "when the speed range is 14 to 14, then all 5 cars spawn at exactly 14, not at a random speed between 0 and the maximum", count: 5, minSpeed: 14, maxSpeed: 14, seed: 9, expectedSpeed: 14 },
] as const;

describe("given a fleet of cars laid out around the arena (where each car spawns and how fast it moves)", () => {
  it("when 1 car and then 2 cars are laid out, then the single car spawns away from the centre and the pair sit opposite each other, more than twice the minimum separation apart", () => {
    const one = layoutFleet(1, 10, 10, rngFrom(1));
    assert.equal(one.length, 1);
    assert.ok(Math.hypot(one[0]!.x, one[0]!.z) > 8);

    const two = layoutFleet(2, 8, 12, rngFrom(2));
    assert.equal(two.length, 2);
    const d = Math.hypot(two[0]!.x - two[1]!.x, two[0]!.z - two[1]!.z);
    assert.ok(d > FLEET_MIN_SEP * 2, `head-on pair only ${d.toFixed(2)} m apart`);
  });

  it("when 8 cars are laid out, then every pair spawns at least the minimum separation apart (within 5 cm)", () => {
    const slots = layoutFleet(8, 0, 20, rngFrom(7));
    assert.equal(slots.length, 8);
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i]!.x - slots[j]!.x, slots[i]!.z - slots[j]!.z);
        assert.ok(d >= FLEET_MIN_SEP - 0.05, `pair ${i},${j} at ${d.toFixed(2)} m`);
      }
    }
  });

  for (const testCase of fixedSpeedCases) {
    it(testCase.it, () => {
      const slots = layoutFleet(testCase.count, testCase.minSpeed, testCase.maxSpeed, rngFrom(testCase.seed));
      assert.ok(slots.every((s) => s.speed === testCase.expectedSpeed));
    });
  }

  it("when 99 cars and then 0 cars are asked for, then the fleet is capped at the maximum car count and never drops below 1 car", () => {
    assert.equal(layoutFleet(99, 1, 2, rngFrom(4)).length, MAX_CARS);
    assert.equal(layoutFleet(0, 1, 2, rngFrom(4)).length, 1);
  });
});

describe("given a layout built from a seeded random source", () => {
  it("when it is laid out twice with the same seed and once with the next seed, then the same seed gives the same spawns and the next seed gives different ones, for 1, 2, 3, 8 and the maximum number of cars", () => {
    const spawns = (n: number, seed: number): string => JSON.stringify(layoutFleet(n, 10, 32, mulberry32(seed)));
    for (const n of [1, 2, 3, 8, MAX_CARS]) {
      const first = spawns(n, 0x3fa2c1);
      assert.equal(spawns(n, 0x3fa2c1), first, `${n} cars, same seed`);
      assert.notEqual(spawns(n, 0x3fa2c2), first, `${n} cars, next seed`);
    }
  });

  it("when the derby's start bearing and the ramp balls are scattered twice with seed 7 and once with seed 8, then seed 7 repeats itself and seed 8 differs, for both", () => {
    const bowl = (seed: number): string => JSON.stringify(layoutDerby(6, 40, mulberry32(seed)));
    assert.equal(bowl(7), bowl(7));
    assert.notEqual(bowl(7), bowl(8));
    const balls: RampBall[] = Array.from({ length: 3 }, () => ({ mesh: new THREE.Mesh(), radius: 0.78, intact: true, kicked: new Set<string>() }));
    const ring = (seed: number): string => {
      scatterRampBalls(balls, true, mulberry32(seed));
      return JSON.stringify(balls.map((b) => [b.radius, b.mesh.position.toArray()]));
    };
    assert.equal(ring(7), ring(7));
    assert.notEqual(ring(7), ring(8));
  });
});
