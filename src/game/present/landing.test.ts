import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { LANDING, LandingWatch } from "./landing.ts";

type Body = { airborne: boolean; wheelsDown: number; velocity: THREE.Vector3 };

function body(airborne: boolean, vy: number, wheelsDown = 15): Body {
  return { airborne, wheelsDown, velocity: new THREE.Vector3(0, vy, 0) };
}

/** Flies `air` s at `vy`, then touches down on all four wheels; returns the touchdown frame's result. */
function jump(watch: LandingWatch, air: number, vy: number, wheelsDown = 15): number {
  const dt = 1 / 60;
  for (let t = 0; t < air; t += dt) watch.step(body(true, vy), dt);
  return watch.step(body(false, 0, wheelsDown), dt);
}

describe("given a landing watch (the camera's wobble and the audio's thud share it)", () => {
  it("when the car falls fast after a long flight and lands on four wheels, then it reports the fall speed", () => {
    assert.equal(jump(new LandingWatch(), LANDING.minAir + 0.2, -9), 9);
  });
  it("when the flight was a hop shorter than the minimum, then it reports nothing", () => {
    assert.equal(jump(new LandingWatch(), LANDING.minAir / 2, -9), 0);
  });
  it("when the fall was gentler than the threshold, then it reports nothing", () => {
    assert.equal(jump(new LandingWatch(), 1, -(LANDING.fall - 1)), 0);
  });
  it("when a wheel is still off the ground, then it reports nothing", () => {
    assert.equal(jump(new LandingWatch(), 1, -9, 7), 0);
  });
  it("when the car drives on the ground, then it reports nothing and one landing is one report", () => {
    const watch = new LandingWatch();
    assert.equal(watch.step(body(false, 0), 1 / 60), 0);
    assert.equal(jump(watch, 1, -9), 9);
    assert.equal(watch.step(body(false, 0), 1 / 60), 0);
  });
  it("when the watch is reset in flight, then the air clock restarts and a short remainder reports nothing", () => {
    const watch = new LandingWatch();
    for (let t = 0; t < 1; t += 1 / 60) watch.step(body(true, -9), 1 / 60);
    watch.reset();
    assert.equal(watch.step(body(false, 0), 1 / 60), 0);
  });
  it("when the nose lands first and the hull has eaten the fall, then the four wheels down a few frames on report the fastest fall of the flight", () => {
    const watch = new LandingWatch();
    for (let t = 0; t < 1; t += 1 / 60) watch.step(body(true, -9), 1 / 60);
    assert.equal(watch.step(body(false, -3, 0), 1 / 60), 0);
    assert.equal(watch.step(body(false, -4, 3), 1 / 60), 0);
    assert.equal(watch.step(body(false, -4, 15), 1 / 60), 9);
    assert.equal(watch.step(body(false, 0, 15), 1 / 60), 0);
  });
  it("when the four wheels are not down within the settle time, then it reports nothing, even when they come down later", () => {
    const watch = new LandingWatch();
    for (let t = 0; t < 1; t += 1 / 60) watch.step(body(true, -9), 1 / 60);
    for (let t = 0; t <= LANDING.settleS + 0.1; t += 1 / 60) assert.equal(watch.step(body(false, 0, 3), 1 / 60), 0);
    assert.equal(watch.step(body(false, 0, 15), 1 / 60), 0);
  });
  it("when the car bounces back into the air before the four are down, then the next flight is judged on its own fall", () => {
    const watch = new LandingWatch();
    for (let t = 0; t < 1; t += 1 / 60) watch.step(body(true, -9), 1 / 60);
    assert.equal(watch.step(body(false, -3, 3), 1 / 60), 0);
    for (let t = 0; t < 0.5; t += 1 / 60) watch.step(body(true, -2), 1 / 60);
    assert.equal(watch.step(body(false, 0, 15), 1 / 60), 0);
  });
});
