import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { paint } from "../vehicle/test-support.ts";
import { makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { placeDrop, StackRig, stackLoads } from "./stack-rig.ts";

/**
 * The stack scene's drops at its defaults (`STACK_DEFAULTS`: the values of vehicle/stack-crush.test.ts), stepped as the
 * engine steps them (`stepStack`: `StackRig.step` then `placeDrop`), read as the HUD panel reads them (`stackLoads`).
 */
describe("stack scene: cars dropped one at a time", () => {
  it("bad: the bottom roof is not crushed more with each car dropped on it, or the top car's roof reads a load", () => {
    const rig = new StackRig();
    const cars = Array.from({ length: rig.config.cars }, () => new DeformableCar(paint(), new THREE.Scene()));
    cars.forEach((c, i) => c.spawnFacing(i === 0 ? 0 : 48 + i * 4, i === 0 ? 0 : 48, 0, 0));
    const w = makeWorld(cars, false, false);
    const bottom: number[] = [];
    const load: number[] = [];
    let done = false;
    for (let f = 0; f < 60 * 60 && !done; f++) {
      const act = rig.step(f / 60);
      if (act === "loop") done = true;
      else if (act === "drop") {
        const r = stackLoads(cars, rig.dropped - 1);
        bottom.push(r.crushMm[0]!);
        load.push(r.loadKn[0]!);
        placeDrop(cars, rig.dropped - 1, rig.config.drop);
      }
      tickWorld(w, 1 / 60);
    }
    assert.ok(done, "the finished stack never settled into its loop restart");
    const end = stackLoads(cars, rig.dropped);
    bottom.push(end.crushMm[0]!);
    load.push(end.loadKn[0]!);
    // One, two, three and four cars in the stack: the bottom roof's crush and load, read before each next drop and at the end.
    for (let i = 1; i < bottom.length; i++) {
      assert.ok(bottom[i]! > bottom[i - 1]! + 10, `bottom roof ${bottom.map((m) => m.toFixed(0)).join(" / ")} mm: not increasing with a car added at step ${i}`);
      assert.ok(load[i]! > load[i - 1]! + 1, `bottom load ${load.map((m) => m.toFixed(1)).join(" / ")} kN: not increasing at step ${i}`);
    }
    assert.ok(end.loadKn[rig.dropped - 1] === 0 && end.crushMm[rig.dropped - 1]! < 2, `the top car carries ${end.loadKn[rig.dropped - 1]!.toFixed(1)} kN and its roof reads ${end.crushMm[rig.dropped - 1]!.toFixed(1)} mm`);
    for (const c of cars) assert.ok(Math.hypot(c.group.position.x, c.group.position.z) < 0.05, "a car slid off the stack");
    // A car that has left the column (slid off, or rolled on its side) carries and reads no load, and the cars under it lose its weight.
    const standing = stackLoads(cars, rig.dropped);
    cars[2]!.group.position.x += 3;
    cars[2]!.group.updateMatrixWorld(true);
    const slid = stackLoads(cars, rig.dropped);
    assert.ok(slid.loadKn[2] === null && slid.loadKn[3] === null, "a car off the column still reads a load");
    assert.ok(Math.abs(slid.loadKn[0]! - (standing.loadKn[0]! - standing.loadKn[1]!)) < 1e-6 && slid.loadKn[1] === 0, `a stack cut above car 1 reads ${slid.loadKn.map((v) => v?.toFixed(1)).join("/")} kN, was ${standing.loadKn.map((v) => v?.toFixed(1)).join("/")}`);
    cars[2]!.group.position.x -= 3;
    cars[2]!.group.rotation.z = Math.PI / 2;
    cars[2]!.group.updateMatrixWorld(true);
    assert.ok(stackLoads(cars, rig.dropped).loadKn[2] === null, "a car on its side still reads a load");
  });
});
