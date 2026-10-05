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
 * The solid's hit against the slab's. The driver is thrown out alike and the health is within `HEALTH_BAND`. Death is a threshold
 * on that health, and the slab itself kills a default sedan by 0.004 m of block travel (0.454 against the 0.45 kill), so
 * `alive` has to agree only when one of them is clearly alive (health at or over `HEALTH_BAND`): two hits both within the
 * band of the kill line may fall either side of it.
 */
function matches(label: string, solid: readonly Outcome[], slab: readonly Outcome[]): void {
  assert.equal(solid.length, slab.length);
  solid.forEach((o, k) => {
    const ref = slab[k]!;
    const at = `${label}, hit ${k + 1}: ${JSON.stringify(o)} against the slab's ${JSON.stringify(ref)}`;
    assert.equal(o.ejected, ref.ejected, `driver: ${at}`);
    assert.ok(Math.abs(o.health - ref.health) <= HEALTH_BAND, `crush: ${at}`);
    if (Math.max(o.health, ref.health) >= HEALTH_BAND) assert.equal(o.alive, ref.alive, `drivetrain: ${at}`);
  });
}

/** What the slab does, from CRUSH_CALIBRATION.md's barrier table: the reference of the reference. */
describe("the jersey barrier, the reference", () => {
  for (const cls of ["sedan", "truck", "monster"] as const) {
    it(`${cls}: ${SURVIVABLE} m/s dents it and leaves the engine and the driver; ${LETHAL} m/s packs the block past the realistic kill and throws the driver`, () => {
      const [easy] = strike("barrier", cls, SURVIVABLE);
      assert.ok(easy!.alive && easy!.health > 0.95 && !easy!.ejected, JSON.stringify(easy));
      const [hard] = strike("barrier", cls, LETHAL);
      assert.ok(hard!.ejected && hard!.health < 0.5, JSON.stringify(hard));
    });
  }
});

describe("every fixed solid hurts a car as the barrier does", () => {
  const CELLS: [Target, VehicleClassId[]][] = [
    // Course walls (`RaceField.wall`), solid box props (`props`): a rim block, a thin wall; a solid circle: a monument, a palm.
    ["oval", ["sedan", "truck", "monster"]],
    ["rally", ["sedan"]],
    ["stucco", ["sedan", "monster"]],
    ["wall", ["sedan", "truck"]],
    ["monument", ["sedan", "truck"]],
    ["palm", ["sedan", "truck"]],
  ];
  for (const [target, classes] of CELLS) {
    for (const cls of classes) {
      for (const speed of [SURVIVABLE, LETHAL]) {
        it(`${cls} into ${target} at ${speed} m/s`, () => {
          matches(`${cls} ${target} ${speed}`, strike(target, cls, speed), strike("barrier", cls, speed));
        });
      }
    }
  }
  for (const target of ["oval", "stucco", "monument"] as const) {
    it(`a sedan sent back at ${target} twice at 30 m/s: the second hit is the barrier's too`, () => {
      matches(`sedan ${target} 30 x2`, strike(target, "sedan", 30, 2), strike("barrier", "sedan", 30, 2));
    });
  }
});
