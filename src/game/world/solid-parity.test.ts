import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strike, type Outcome, type Target } from "./solid-parity.test-util.ts";
import type { VehicleClassId } from "../vehicle/vehicle-classes.ts";

/**
 * Owner, 2026-10-04: "environment and map components should not be doing anything different than hard walls like the
 * range jersey barrier with respect to a collision with a fixed / very-strong / very-hard-to-move object." Going full
 * speed into an oval wall left a car at 75 % with one wheel missing and no driver thrown, where the range's slab kills
 * the block and throws him. Every fixed solid is held to the slab (the reference the crush is calibrated on, with the
 * same class armed as a race car): the same driver thrown, the same order of crush, at a lethal and a survivable
 * speed, and on a second hit.
 */

/** How far apart (drivetrain health, 0 … 1) a solid's crush and the slab's may be: the same order of damage, not the same dents. */
const HEALTH_BAND = 0.2;
/** Clearly lethal for every class on the slab (55 m/s is a sedan's top speed), and clearly survivable (the slab at 8 m/s dents a bumper). */
const LETHAL = 55;
const SURVIVABLE = 8;

/**
 * The solid's hit against the slab's. The driver is thrown out alike, the health is within `HEALTH_BAND` and the car comes off no
 * faster (a pole the car drove round at 40 m/s read the same health). Death is a threshold
 * on that health, and the slab itself kills a default sedan by 0.004 m of block travel (0.454 against the 0.45 kill), so
 * `alive` has to agree only when one of them is clearly alive (health at or over `HEALTH_BAND`): two hits both within the
 * band of the kill line may fall either side of it.
 */
function matches(label: string, solid: readonly Outcome[], slab: readonly Outcome[]): void {
  assert.equal(solid.length, slab.length);
  for (const [k, o] of solid.entries()) {
    const ref = slab[k]!;
    const at = `${label}, hit ${k + 1}: ${JSON.stringify(o)} against the slab's ${JSON.stringify(ref)}`;
    assert.equal(o.ejected, ref.ejected, `driver: ${at}`);
    assert.ok(Math.abs(o.health - ref.health) <= HEALTH_BAND, `crush: ${at}`);
    assert.ok(o.speed <= ref.speed + 1, `speed after the hit: ${at}`);
    if (Math.max(o.health, ref.health) >= HEALTH_BAND) assert.equal(o.alive, ref.alive, `drivetrain: ${at}`);
  }
}

/** What the slab does, from CRUSH_CALIBRATION.md's barrier table: the reference of the reference. */
describe("given the jersey barrier (the range's slab, the reference every other fixed solid is held to)", () => {
  for (const cls of ["sedan", "truck", "monster"] as const) {
    it(`when a ${cls} hits it at ${SURVIVABLE} m/s and then at ${LETHAL} m/s, then the slow hit dents it and leaves the engine and driver alone, and the fast hit packs the crush block past the realistic kill and throws the driver`, () => {
      const [easy] = strike("barrier", cls, SURVIVABLE);
      assert.ok(easy!.alive && easy!.health > 0.95 && !easy!.ejected, JSON.stringify(easy));
      const [hard] = strike("barrier", cls, LETHAL);
      assert.ok(hard!.ejected && hard!.health < 0.5, JSON.stringify(hard));
    });
  }
});

describe("given a fixed solid (a course wall, a solid box prop, the flank of a monument's star arm or a palm's trunk) and the jersey barrier as the reference", () => {
  const CELLS: [Target, VehicleClassId[]][] = [
    // Course walls (`wallColliders` pieces, met like props), solid box props (`props`): a rim block, a thin wall; the flank of a monument's star arm (a box turned to the arm), a palm's trunk (a circle).
    ["oval", ["sedan", "truck", "monster"]],
    ["rally", ["sedan"]],
    ["stucco", ["sedan", "monster"]],
    ["wall", ["sedan", "truck"]],
    ["monument", ["sedan", "truck"]],
    ["palm", ["sedan", "truck"]],
  ];
  describe("when a car drives into it once", () => {
    for (const [target, classes] of CELLS) {
      for (const cls of classes) {
        for (const speed of [SURVIVABLE, LETHAL]) {
          it(`when a ${cls} drives into the ${target} at ${speed} m/s, then it throws the driver as the barrier does, crushes within ${HEALTH_BAND} of the barrier's drivetrain health, and the car comes off no faster`, () => {
            matches(`${cls} ${target} ${speed}`, strike(target, cls, speed), strike("barrier", cls, speed));
          });
        }
      }
    }
  });
  describe("when a sedan is sent back at it for a second hit", () => {
    for (const target of ["oval", "stucco", "monument"] as const) {
      it(`when a sedan hits the ${target} twice at 30 m/s, then the second hit hurts the car as the barrier's second hit does`, () => {
        matches(`sedan ${target} 30 x2`, strike(target, "sedan", 30, 2), strike("barrier", "sedan", 30, 2));
      });
    }
  });
  // A palm stands between a car's bumpers: its crush hulls reach the face before any particle does. Unless the hulls on the face count as
  // the hit's contact, the quiet clock runs out, the hit re-arms at 0.3 s and the tap reads 0.016 m of block travel (the slab's 0).
  describe("when the solid is a palm standing between the car's bumpers", () => {
    for (const cls of ["sedan", "truck"] as const) {
      it(`when a ${cls} taps the palm at ${SURVIVABLE} m/s, then the crush block stays where it was, as the slab's does, and the car's health and driver are untouched`, () => {
        const [tap] = strike("palm", cls, SURVIVABLE);
        assert.ok(tap!.travel < 0.002 && tap!.health > 0.99 && !tap!.ejected, JSON.stringify(tap));
      });
    }
  });
});
