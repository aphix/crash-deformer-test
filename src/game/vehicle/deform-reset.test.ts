import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { assertSameDigest, DT, paint } from "./test-support.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";

/**
 * Every field of a deform as plain data, nested and typed arrays included; −0, NaN and ±Infinity kept apart. The G / P
 * debug views (`helper`, `particleHelper`) are scene objects the view owns, not the deform's state.
 */
function fields(d: object): unknown {
  const num = (x: unknown) => (typeof x === "number" && (Object.is(x, -0) || !Number.isFinite(x)) ? String(Object.is(x, -0) ? "-0" : x) : x);
  const plain = (k: string, v: unknown) =>
    k === "helper" || k === "particleHelper" ? undefined : ArrayBuffer.isView(v) ? Array.from(v as Float64Array, num) : v instanceof Map ? [...v] : num(v);
  return JSON.parse(JSON.stringify(d, plain));
}

describe("deform reset", () => {
  it("bad: a car reset after a head-on crash has every deform field as built (hit clocks, pose, hulls, buffers, clusters)", () => {
    const scene = new THREE.Scene();
    const built = new DeformableCar(paint(), scene);
    const a = new DeformableCar(paint(), scene);
    const b = new DeformableCar(paint(), scene);
    a.spawnFacing(0, -6, 0, 20);
    b.spawnFacing(0, 6, Math.PI, 20);
    const w = newWorld([a, b]);
    for (let f = 0; f < 90; f++) {
      for (let acc = DT; acc > 1e-5; ) {
        const h = physicsSlice(acc, sliceSpeed(w.cars));
        stepWorld(w, h);
        acc -= h;
      }
      for (const car of w.cars) car.updateSkin();
    }
    assert.ok(a.crashed && a.deform.massActive, "the head-on never crashed the car");
    a.resetVisual();
    built.resetVisual();
    assertSameDigest(fields(a.deform), fields(built.deform), "deform after reset");
  });
});
