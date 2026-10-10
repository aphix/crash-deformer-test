import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { launch, makeCar, makeWorld, strikeReach, tickWorld, type WallApproach } from "./crash-scenarios.test-util.ts";
import { BARRIER_HALF, BARRIER_TOP } from "./sat.ts";
import { drawnTriangles } from "../vehicle/drawn-body.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * docs/UNIFIED_CONTACT.md stage 3: what the player sees of a crushed car stays out of the solid it hit. The owner's clip
 * (WallPass4: muy7bjjp2c, race wall box 0.6 m wide, 77.7 km/h, closing 8.8 m/s) left a drawn vertex of the crushed nose
 * 0.376 m inside the wall while every physics point stayed outside. Here the same hit on the held jersey slab (the one solid
 * a headless world has): the deepest drawn vertex past the slab's face, over the whole run, held to the cage tolerance.
 */
const SLAB_FACE_X = BARRIER_HALF.x;
const DEEPEST_INSIDE_M = 0.05;
const RUN_SECONDS = 4;

const _v = new THREE.Vector3();

/** How far (m) the deepest drawn vertex of `car` is inside the slab's box (its +x face, ends at ±`BARRIER_HALF.z`, its top): 0 when none is. */
function deepestInside(car: DeformableCar): number {
  const tris = drawnTriangles(car);
  let depth = 0;
  for (let k = 0; k + 2 < tris.length; k += 3) {
    _v.set(tris[k]!, tris[k + 1]!, tris[k + 2]!).applyMatrix4(car.group.matrixWorld);
    if (Math.abs(_v.z) > BARRIER_HALF.z || _v.y > BARRIER_TOP || _v.x < -SLAB_FACE_X) continue;
    depth = Math.max(depth, SLAB_FACE_X - _v.x);
  }
  return depth;
}

const wallHits = [
  { it: "when it hits the slab square at 56 km/h", approach: "front", kph: 56 },
  { it: "when it hits the slab square at 78 km/h", approach: "front", kph: 78 },
  { it: "when it backs into the slab square at 56 km/h", approach: "rear", kph: 56 },
  { it: "when it hits the slab square at 100 km/h", approach: "front", kph: 100 },
] as const satisfies readonly { it: string; approach: WallApproach; kph: number }[];

for (const testCase of wallHits) {
  describe("given a sedan driving at the jersey slab", () => {
    it(`${testCase.it}, then no drawn vertex of its body is ever more than ${DEEPEST_INSIDE_M * 100} cm inside the slab`, (t) => {
      const car = makeCar();
      const yaw = testCase.approach === "front" ? -Math.PI / 2 : Math.PI / 2;
      launch(car, SLAB_FACE_X + 2 + strikeReach(car, testCase.approach), 0, yaw, -testCase.kph / 3.6, 0);
      const w = makeWorld([car], true, false);
      let deepest = 0;
      for (let f = 0; f < RUN_SECONDS * 60; f++) {
        tickWorld(w, 1 / 60);
        deepest = Math.max(deepest, deepestInside(car));
      }
      t.diagnostic(`deepest drawn vertex inside the slab ${deepest.toFixed(3)} m`);
      assert.ok(deepest <= DEEPEST_INSIDE_M, `a drawn vertex is ${deepest.toFixed(3)} m inside the slab`);
    });
  });
}
