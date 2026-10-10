import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classCar } from "./ejection.test-util.ts";
import { launch, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";

/**
 * The rigid step's rows meet a car's top with the other car's body points, and what the rows' impulse takes out of the pair is that
 * contact's crush (docs/UNIFIED_CONTACT.md): one contact, armed once, at the kernel's barrier speed for the closing it met.
 */

/** Closing speed (m/s) of each car's nose in the head-on: each car drives this fast at the other. */
const HEAD_ON_MPS = 40;
/** Equal-mass cars share a plastic exchange evenly: each takes half the closing, here the speed of one of them. */
const EQUAL_MASS_SHARE = HEAD_ON_MPS;
/** How far a car's barrier speed may sit from its share (the first slice's closing is read before the exchange, the cars' masses differ by their class). */
const SHARE_TOLERANCE = 0.1;
/** A T-bone's striker meets the flank of the car it hits: it must not climb it. The cage's own fit (cm) is the most a crush may lift it. */
const MOST_LIFT_M = 0.05;

describe("given a sedan driving head-on into a monster truck, each at 40 m/s", () => {
  it("when the nose meets the truck's bonnet, then each car's crush is armed at its share of the closing (the speed it would crush a rigid wall with)", () => {
    const sedan = classCar("sedan");
    const truck = classCar("monster");
    launch(sedan, -5, 0, Math.PI / 2, HEAD_ON_MPS, 0);
    launch(truck, 5, 0, -Math.PI / 2, -HEAD_ON_MPS, 0);
    const world = makeWorld([sedan, truck], false, false);
    for (let frame = 0; frame < 6; frame++) tickWorld(world);
    for (const [name, car] of [["sedan", sedan], ["truck", truck]] as const) {
      const armed = car.deform["hitSpeed"];
      assert.ok(Math.abs(armed - EQUAL_MASS_SHARE) <= SHARE_TOLERANCE * EQUAL_MASS_SHARE, `${name}'s hit read ${armed.toFixed(1)} m/s, its share is ${EQUAL_MASS_SHARE} m/s`);
    }
  });
});

describe("given a sedan driving its nose into a parked sedan's door at 55 m/s", () => {
  it("when the nose is inside the door's side, then the striker is not carried up the flank", () => {
    const struck = classCar("sedan");
    const striker = classCar("sedan");
    launch(struck, 0, 0, 0, 0, 0);
    launch(striker, 6, 0, -Math.PI / 2, -55, 0);
    const world = makeWorld([striker, struck], false, false);
    let highest = 0;
    for (let frame = 0; frame < 12; frame++) {
      tickWorld(world);
      highest = Math.max(highest, striker.group.position.y);
    }
    assert.ok(highest <= MOST_LIFT_M, `the striker rose ${highest.toFixed(3)} m`);
  });
});
