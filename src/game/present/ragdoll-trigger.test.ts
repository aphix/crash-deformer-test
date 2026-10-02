import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import { EjectionWatch, type ExitPane } from "./ragdoll-trigger.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;

/** Run the crash 2.5 s through the engine's frame, watching every car: each throw as [car, exit, pre-hit speed]. */
function throws(cars: DeformableCar[], barrier = false): [number, ExitPane, number][] {
  const w = makeWorld(cars, barrier, false);
  const watch = new EjectionWatch();
  const out: [number, ExitPane, number][] = [];
  for (let f = 0; f < 150; f++) {
    tickWorld(w);
    watch.update(cars, FRAME, (i, exit, pre) => out.push([i, exit, pre.length()]));
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A derby wreck one hit from done: its wear limit is below a single hit's cap (36 m²/s²). */
function worn(car: DeformableCar): DeformableCar {
  car.deform.wreckEnergy = 20;
  return car;
}

describe("a disabling head-on or side hit throws the driver out, nothing else does", () => {
  it("bad: a 2×56 km/h head-on kills both engines and throws both drivers through the windshield at their pre-hit speed", () => {
    const a = makeCar();
    const b = makeCar();
    launch(a, -5, 0, Math.PI / 2, 56 / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -56 / 3.6, 0);
    const out = throws([a, b]);
    assert.ok(!a.deform.drivetrainAlive && !b.deform.drivetrainAlive, "the head-on disabled both");
    assert.deepEqual(out.map(([i, exit]) => [i, exit]), [[0, "windshield"], [1, "windshield"]]);
    for (const [, , speed] of out) assert.ok(Math.abs(speed - 56 / 3.6) < 0.5, `thrown from ${speed.toFixed(2)} m/s`);
  });

  it("bad: a T-bone that finishes a worn wreck throws its driver out of the struck (right) side's window; the bullet keeps its own", () => {
    const struck = worn(makeCar());
    const bullet = makeCar();
    launch(struck, 0, 0, 0, 0, 0);
    launch(bullet, 6, 0, -Math.PI / 2, -50 / 3.6, 0);
    const out = throws([struck, bullet]);
    assert.ok(!struck.deform.drivetrainAlive, "the T-bone disabled the worn car");
    assert.deepEqual(out.map(([i, exit]) => [i, exit]), [[0, "doorR"]]);
  });

  it("bad: a 2×28 km/h head-on that leaves both engines running throws nobody", () => {
    const a = makeCar();
    const b = makeCar();
    launch(a, -5, 0, Math.PI / 2, 28 / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -28 / 3.6, 0);
    const out = throws([a, b]);
    assert.ok(a.deform.drivetrainAlive && b.deform.drivetrainAlive, "the hit did not disable");
    assert.deepEqual(out, []);
  });

  it("bad: a 50 km/h rear hit that finishes a worn wreck throws nobody", () => {
    const car = worn(makeCar());
    launch(car, BARRIER_HALF.x + 6.2, 0, Math.PI / 2, -50 / 3.6, 0);
    const out = throws([car], true);
    assert.ok(!car.deform.drivetrainAlive, "the rear hit disabled the worn car");
    assert.ok(car.deform.impactInward.z > Math.abs(car.deform.impactInward.x), "it was struck from behind");
    assert.deepEqual(out, []);
  });
});

describe("thrown drivers are cosmetic: the cars move the same, and only the sandbox asks for the ride-along slow-mo", () => {
  for (const sandbox of [true, false]) {
    it(`${sandbox ? "good: the sandbox" : "bad: a race or a derby"} after a 2×56 km/h head-on that throws both drivers`, async () => {
      const cars = [makeCar(), makeCar()];
      const plain = [makeCar(), makeCar()];
      for (const [a, b] of [cars, plain]) {
        launch(a!, -5, 0, Math.PI / 2, 56 / 3.6, 0);
        launch(b!, 5, 0, -Math.PI / 2, -56 / 3.6, 0);
      }
      const scene = new THREE.Scene();
      const rideAlong: number[] = [];
      const ragdolls = new RagdollSystem(scene, (i) => rideAlong.push(i));
      await ragdolls.preload();
      const w = makeWorld(cars, false, false);
      const wPlain = makeWorld(plain, false, false);
      for (let f = 0; f < 150; f++) {
        tickWorld(w);
        tickWorld(wPlain);
        ragdolls.update(FRAME, cars, true, sandbox, 0, null);
      }
      assert.ok(scene.getObjectByName("ragdolls")!.visible, "the dummies fly in every mode");
      ragdolls.dispose();
      const poses = (set: DeformableCar[]) => set.flatMap((c) => [...c.group.position.toArray(), ...c.group.quaternion.toArray(), ...c.velocity.toArray()]);
      assertSameNumbers(poses(cars), poses(plain), "car poses and velocities with dummies vs without");
      assert.equal(rideAlong.join(), sandbox ? "0,1" : "", "ride-along / slow-mo requests");
    });
  }
});
