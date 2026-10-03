import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import type { ExitPane } from "./car-core.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import { ejectionVelocity, THROW_OUT, type Ejection } from "./ejection.ts";
import { fleetCar, headOn, worn } from "./ejection.test-util.ts";

/** Run the crash 2.5 s through the engine's frame: each throw as [car, exit, pre-hit speed]. */
function throws(cars: DeformableCar[], barrier = false): [number, ExitPane, number][] {
  const w = makeWorld(cars, barrier, false);
  for (let f = 0; f < 150; f++) tickWorld(w);
  return w.ejections
    .map((e): [number, ExitPane, number] => {
      // His own velocity is the car's pre-hit one plus the throw out of the pane (the way out, `THROW_OUT` along `dir`).
      const v = ejectionVelocity(e, new THREE.Vector3());
      return [e.car, e.exit, Math.hypot(v.x - e.dir.x * THROW_OUT, v.z - e.dir.z * THROW_OUT)];
    })
    .sort((a, b) => a[0] - b[0]);
}

describe("a disabling head-on or side hit throws the driver out (sim state), nothing else does", () => {
  it("bad: a 2×56 km/h head-on kills both engines and throws both drivers through the windshield at their pre-hit speed", () => {
    const a = makeCar();
    const b = makeCar();
    launch(a, -5, 0, Math.PI / 2, 56 / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -56 / 3.6, 0);
    const out = throws([a, b]);
    assert.ok(!a.deform.drivetrainAlive && !b.deform.drivetrainAlive, "the head-on disabled both");
    assert.deepEqual(out.map(([i, exit]) => [i, exit]), [[0, "windshield"], [1, "windshield"]]);
    for (const [, , speed] of out) assert.ok(Math.abs(speed - 56 / 3.6) < 0.5, `thrown from ${speed.toFixed(2)} m/s`);
    assert.equal(a.driverOut, "windshield", "the car carries the flag");
    assert.equal(b.driverOut, "windshield");
  });

  it("bad: a T-bone that finishes a worn wreck throws its driver out of the struck (right) side's window; the bullet keeps its own", () => {
    const struck = worn(makeCar());
    const bullet = makeCar();
    launch(struck, 0, 0, 0, 0, 0);
    launch(bullet, 6, 0, -Math.PI / 2, -50 / 3.6, 0);
    const out = throws([struck, bullet]);
    assert.ok(!struck.deform.drivetrainAlive, "the T-bone disabled the worn car");
    assert.deepEqual(out.map(([i, exit]) => [i, exit]), [[0, "doorR"]]);
    assert.equal(bullet.driverOut, null, "the bullet's driver stays in");
  });

  it("bad: a 2×28 km/h head-on that leaves both engines running throws nobody", () => {
    const a = makeCar();
    const b = makeCar();
    launch(a, -5, 0, Math.PI / 2, 28 / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -28 / 3.6, 0);
    const out = throws([a, b]);
    assert.ok(a.deform.drivetrainAlive && b.deform.drivetrainAlive, "the hit did not disable");
    assert.deepEqual(out, []);
    assert.equal(a.driverOut, null);
  });

  it("bad: a fleet head-on at 2×72 km/h (the HUD's 0–32 m/s launch range) throws both drivers, though at the default realism neither car dies", () => {
    const [a, b] = headOn(20);
    const out = throws([a, b]);
    assert.ok(a.deform.drivetrainAlive && b.deform.drivetrainAlive, "the default realism leaves both engines running");
    assert.deepEqual(out.map(([i, exit]) => [i, exit]), [[0, "windshield"], [1, "windshield"]]);
  });

  it("bad: an 80 km/h scrape down the barrier's flank that finishes a worn wreck throws nobody", () => {
    const car = worn(fleetCar());
    // Angled 12° into the barrier's +x face, the left flank 0.3 m off it: the front-left corner meets it near z = 0.
    const v = 80 / 3.6;
    const a = (12 * Math.PI) / 180;
    const t = 0.3 / (v * Math.sin(a));
    launch(car, BARRIER_HALF.x + 1.2, -v * Math.cos(a) * t - 2.2, -a, -v * Math.sin(a), v * Math.cos(a));
    const out = throws([car], true);
    assert.ok(!car.deform.drivetrainAlive, "the scrape finished the worn car");
    assert.ok(Math.abs(car.deform.impactInward.x) > 4 * Math.abs(car.deform.impactInward.z), "struck along its flank");
    assert.deepEqual(out, []);
    assert.equal(car.driverOut, null);
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

describe("the ejection event is the throw: everything a dummy needs to be launched again", () => {
  /** The 2×56 km/h head-on, each throw checked against the car as the sim had it that very step. */
  function observed(): { seen: Ejection[]; checked: number } {
    const a = makeCar();
    const b = makeCar();
    launch(a, -5, 0, Math.PI / 2, 56 / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -56 / 3.6, 0);
    const w = makeWorld([a, b], false, false);
    const seen: Ejection[] = [];
    let checked = 0;
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    w.onEject = (e) => {
      seen.push(e);
      const car = w.cars[e.car]!;
      // The car-local position is the world one in the car's frame, at the step he left in.
      p.copy(e.local).applyQuaternion(q.copy(car.group.quaternion)).add(car.group.position);
      assert.ok(p.distanceTo(e.pos) < 1e-4, `local ${e.local.toArray()} is not world ${e.pos.toArray()} in the car's frame (${p.distanceTo(e.pos)} m)`);
      // Out of the pane: unit, and level for a windshield exit.
      assert.ok(Math.abs(e.dir.length() - 1) < 1e-6, "unit direction");
      // His own velocity is the car's plus the relative one: the car's own, as the sim has it that step, is in the event.
      assert.ok(e.carVel.distanceTo(car.velocity) < 1e-5, "the car's own velocity rides along");
      assert.equal(e.cop, false);
      checked++;
    };
    for (let f = 0; f < 150; f++) tickWorld(w);
    return { seen, checked };
  }

  it("bad: each event's local and world exit agree in the car's frame, its direction is unit and its numbers are f32-exact", () => {
    const { seen, checked } = observed();
    assert.equal(checked, 2);
    for (const e of seen) {
      for (const v of [e.pos, e.local, e.dir, e.rel, e.carVel, e.spin]) for (const x of v.toArray()) assert.equal(Math.fround(x), x, "f32-exact");
      for (const x of e.quat.toArray()) assert.equal(Math.fround(x), x, "f32-exact");
    }
  });

  it("bad: the same crash twice gives the very same events (the decision is deterministic sim state)", () => {
    const run = (): string => JSON.stringify(observed().seen);
    assert.equal(run(), run());
  });

  it("bad: a car whose driver is already out is not thrown again by a later hit, but the other car's driver is", () => {
    const a = makeCar();
    const b = makeCar();
    launch(a, -5, 0, Math.PI / 2, 56 / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -56 / 3.6, 0);
    a.driverOut = "windshield";
    const w = makeWorld([a, b], false, false);
    for (let f = 0; f < 150; f++) tickWorld(w);
    assert.deepEqual(w.ejections.map((e) => e.car), [1]);
  });

  it("good: putting the car back (a respawn) puts the driver back in", () => {
    const a = fleetCar();
    a.driverOut = "doorL";
    a.spawnFacing(0, 0, 0, 0);
    assert.equal(a.driverOut, null);
  });
});
