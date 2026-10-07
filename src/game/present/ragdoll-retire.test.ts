import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { GROUND_REACH, RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;
const STILL = new THREE.Vector3();
/** Face down, as a thrown driver comes to rest. */
const LYING = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const _p = new THREE.Vector3();

/** `seconds` of the dummies' frames in a race beside `cars`. */
function run(r: RagdollSystem, cars: readonly DeformableCar[], seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) r.update(FRAME, cars, true, false, 0, null);
}

describe("given the dummies' world, where a car's stand-in is taken out while it is still moving", () => {
  it("when a car rolling beside a dummy is moved off out of his reach and another dummy drops onto the spot the car left, then that dummy comes down to the ground", async () => {
    const r = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await r.preload();
    const car = makeCar();
    car.spawnFacing(0, 0, 0, 3);
    assert.equal(r.place(_p.set(0, 0.3, 5), LYING, STILL, STILL, 10, 1), 1);
    // The car rolls toward him at 3 m/s, so its stand-in moves every step; then it is somewhere else entirely.
    for (let z = 0; z < 0.5; z += 3 * FRAME) {
      car.spawnFacing(0, z, 0, 3);
      run(r, [car], FRAME);
    }
    car.spawnFacing(60, 0, 0, 0);
    run(r, [car], FRAME);
    assert.equal(r.place(_p.set(0, 3, 0.5), LYING, STILL, STILL, 10, 0), 0);
    run(r, [car], 3);
    assert.ok(r.torso(0, _p, null));
    assert.ok(_p.y < GROUND_REACH, `the dummy's torso rests ${_p.y.toFixed(2)} m up, on nothing there`);
    r.dispose();
  });
});
