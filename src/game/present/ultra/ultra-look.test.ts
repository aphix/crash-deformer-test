import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { envYaw, LOOK } from "./ultra-look.ts";

/** Smallest signed turn (rad) from azimuth `a` to `b`. */
const turn = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));

describe("given the sky's sun disc and a sun light (the stage's, a course's) at any azimuth", () => {
  const lights = [new THREE.Vector3(-10, 22, 9), new THREE.Vector3(1, 5, 0), new THREE.Vector3(0.3, 1, -4), new THREE.Vector3(0, 3, 0.01), new THREE.Vector3(7, 2, -7)];
  for (const sun of lights) {
    it(`when the environment is turned by envYaw for a light at (${sun.x}, ${sun.y}, ${sun.z}), then three's environment rotation takes the sky's sun to the light's azimuth`, () => {
      const el = THREE.MathUtils.degToRad(45);
      const skySun = new THREE.Vector3(Math.cos(el) * Math.cos(LOOK.skySunAzimuth), Math.sin(el), Math.cos(el) * Math.sin(LOOK.skySunAzimuth));
      // A material samples the environment at the inverse of this rotation, so the world direction of the sky's sun is the rotation applied to it.
      const world = skySun.clone().applyEuler(new THREE.Euler(0, envYaw(sun), 0));
      assert.ok(Math.abs(turn(Math.atan2(sun.z, sun.x), Math.atan2(world.z, world.x))) < 1e-9, `azimuth off by ${turn(Math.atan2(sun.z, sun.x), Math.atan2(world.z, world.x))} rad`);
      assert.ok(Math.abs(world.y - skySun.y) < 1e-12, "the rotation moved the sun's height");
    });
  }
});
