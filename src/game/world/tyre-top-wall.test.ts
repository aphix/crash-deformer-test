import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { assignClass } from "../vehicle/vehicle-classes.ts";
import { paint } from "../vehicle/test-support.ts";
import { makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armTops, C_H, C_OWNER, HIT_SIZE, PQ_SIZE, PQ_X, PQ_Y, PQ_Z, pointContact, wheelContact } from "./surfaces.ts";
import { SKIN } from "../vehicle/car-surfaces.ts";
import { setGround } from "./ground.ts";

/**
 * A tyre's footprint asks the surfaces from its hub's height: a face lower than the hub is the ground it sits in, a taller one is a wall
 * (`wheelContact`). A car's top has a skin of `SKIN` over a hull point, which a tyre must not take: derby seed 1 (docs/UNIFIED_CONTACT.md
 * 11.6), a car's front tyre met a flattened wreck's top 0.12 m over its hub, read it as ground 0.5 m above its tread and was lifted 0.1 m
 * past its spring stop in one 5 ms slice (a first-contact hop of 0.102 m against the bar 3·v·h + 2 cm = 0.093 m).
 */
const FRAME = 1 / 60;
/** How far over the hub the sedan's roof stands in the wall case: inside the roof's skin (`SKIN`), above the hub. */
const OVER = 0.12;
const out = new Float64Array(HIT_SIZE);
const hub = new Float64Array(3);
const axes = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
const q = new Float64Array(PQ_SIZE);

describe("given a sedan standing with a roof, and a tyre's hub over its crown", () => {
  afterEach(() => {
    armTops(null);
    setGround(null);
  });

  function roofAndWorld(): number {
    const sedan = new DeformableCar(paint(), new THREE.Scene());
    assignClass(sedan, "sedan");
    sedan.spawnFacing(0, 0, 0, 0);
    sedan.parked = true;
    const w = makeWorld([sedan], false, false);
    for (let f = 0; f < 30; f++) tickWorld(w, FRAME);
    // A world step disarms the tops when it ends: arm the roof it left, as a car's slice does.
    armTops(w.world.surfaces);
    q[PQ_X] = 0;
    q[PQ_Z] = 0;
    q[PQ_Y] = Infinity;
    pointContact(q, -1, out);
    return out[C_H]!;
  }

  it("when the hub is below the roof by less than its skin, then the roof is a wall: the tyre reads no rise from it", () => {
    const roof = roofAndWorld();
    assert.ok(roof > 1 && OVER < SKIN, `roof ${roof}`);
    hub[0] = 0;
    hub[1] = roof - OVER;
    hub[2] = 0;
    wheelContact(hub, axes, 1, -1, out);
    // The only ground left is the road far under the tread: a gap of more than the hub's height over it, not a roof 0.5 m up the tread.
    assert.ok(out[C_H]! < -0.5 || out[C_OWNER] === -1, `rise ${out[C_H]} owner ${out[C_OWNER]} over a roof ${OVER} m above the hub`);
    assert.ok(!(out[C_OWNER]! >= 0), `the tyre took the roof as ground: owner ${out[C_OWNER]}`);
  });

  it("when the hub is above the roof, then the tyre rests on it: the roof is its ground", () => {
    const roof = roofAndWorld();
    hub[0] = 0;
    hub[1] = roof + 0.2;
    hub[2] = 0;
    wheelContact(hub, axes, 1, -1, out);
    assert.ok(out[C_OWNER]! >= 0 && out[C_H]! > 0, `rise ${out[C_H]} owner ${out[C_OWNER]} over a roof 0.2 m under the hub`);
  });
});
