import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import { armKill, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { EjectionWatch, type ExitPane } from "./ragdoll-trigger.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;

/** Run the crash 2.5 s through the engine's frame, watching every car: each throw as [car, exit, pre-hit speed]. */
function throws(cars: DeformableCar[], barrier = false): [number, ExitPane, number][] {
  const w = makeWorld(cars, barrier, false);
  const watch = new EjectionWatch();
  const out: [number, ExitPane, number][] = [];
  for (let f = 0; f < 150; f++) {
    tickWorld(w);
    watch.update(cars, FRAME, "default", (i, exit, pre) => out.push([i, exit, pre.length()]));
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A derby wreck one hit from done: its wear limit is below a single hit's cap (36 m²/s²). */
function worn(car: DeformableCar): DeformableCar {
  car.deform.wreckEnergy = 20;
  return car;
}

/** A sedan armed as the fleet arms it (`dressCar`): the HUD's default realism, no wear limit. */
function fleetCar(): DeformableCar {
  const car = makeCar("shape", 0.32, 0.45);
  armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
  return car;
}

/** Two fleet sedans 10 m apart, head-on at `mps` each. */
function headOn(mps: number): [DeformableCar, DeformableCar] {
  const a = fleetCar();
  const b = fleetCar();
  launch(a, -5, 0, Math.PI / 2, mps, 0);
  launch(b, 5, 0, -Math.PI / 2, -mps, 0);
  return [a, b];
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

/** Every car's whole sim state: pose, velocities, each mass, the drivetrain. */
function simState(cars: readonly DeformableCar[]): number[] {
  return cars.flatMap((c) => [
    ...c.group.position.toArray(),
    ...c.group.quaternion.toArray(),
    ...c.velocity.toArray(),
    ...c.angular.toArray(),
    ...c.deform.masses.flatMap((m) => [...m.world.toArray(), ...m.vel.toArray()]),
    c.deform.drivetrainAlive ? 1 : 0,
    c.deform.engineTravel,
  ]);
}

describe("thrown drivers are cosmetic: the cars move the same, and only the sandbox asks for the ride-along slow-mo", () => {
  const crashes = [
    { label: "a 2×56 km/h head-on that kills both engines", pair: () => {
      const [a, b] = [makeCar(), makeCar()];
      launch(a, -5, 0, Math.PI / 2, 56 / 3.6, 0);
      launch(b, 5, 0, -Math.PI / 2, -56 / 3.6, 0);
      return [a, b];
    } },
    { label: "a fleet 2×72 km/h head-on whose cars run on", pair: () => headOn(20) },
  ];
  for (const { label, pair } of crashes) {
    for (const sandbox of [true, false]) {
      it(`${sandbox ? "good: the sandbox" : "bad: a race or a derby"} after ${label}, both drivers thrown`, async () => {
        const cars = pair();
        const plain = pair();
        const scene = new THREE.Scene();
        const rideAlong: number[] = [];
        const ragdolls = new RagdollSystem(scene, (i) => rideAlong.push(i));
        await ragdolls.preload();
        const w = makeWorld(cars, false, false);
        const wPlain = makeWorld(plain, false, false);
        for (let f = 0; f < 240; f++) {
          tickWorld(w);
          tickWorld(wPlain);
          ragdolls.update(FRAME, cars, true, sandbox, 0, null);
        }
        assert.ok(scene.getObjectByName("ragdolls")!.visible, "the dummies fly in every mode");
        ragdolls.dispose();
        assertSameDigest(simState(cars), simState(plain), "every car's sim state with dummies vs without");
        assert.equal(rideAlong.join(), sandbox ? "0,1" : "", "ride-along / slow-mo requests");
      });
    }
  }
});

describe("a throw judged before Rapier has loaded", () => {
  /** The fleet head-on with Rapier loading `late` frames in (the hit lands about 0.2 s in): dummies out at the end. */
  async function thrownAfterLoad(late: number): Promise<boolean> {
    const cars = headOn(20);
    const scene = new THREE.Scene();
    const ragdolls = new RagdollSystem(scene, () => {});
    const w = makeWorld(cars, false, false);
    for (let f = 0; f < 150; f++) {
      if (f === late) await ragdolls.preload();
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
    }
    const out = scene.getObjectByName("ragdolls")!.visible;
    ragdolls.dispose();
    return out;
  }

  it("good: still throws the driver when Rapier is in 0.5 s later", async () => {
    assert.equal(await thrownAfterLoad(42), true);
  });

  it("bad: is dropped when Rapier comes more than a second after the hit", async () => {
    assert.equal(await thrownAfterLoad(120), false);
  });
});

describe("a thrown dummy hits other cars", () => {
  it("bad: in a fleet head-on each driver flies into the other car and never ends up inside its cabin", async () => {
    const cars = headOn(20);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {});
    await ragdolls.preload();
    const w = makeWorld(cars, false, false);
    const local = new THREE.Vector3();
    const inv = new THREE.Quaternion();
    const inside: string[] = [];
    for (let f = 0; f < 120; f++) {
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
      // Slots fill in car order (car 0's driver first): each torso against the OTHER car's cabin (it never crushes;
      // the crushed nose in front of it is not where the rest-size box says).
      ragdolls["dolls"].forEach((d, s) => {
        if (!d.live) return;
        const other = cars[1 - s]!;
        const t = d.bodies[0]!.translation();
        local.set(t.x, t.y, t.z).sub(other.group.position).applyQuaternion(inv.copy(other.group.quaternion).invert());
        if (Math.abs(local.x) < 0.7 && local.y > 0.8 && local.y < 1.34 && local.z > -0.75 && local.z < 0.61) inside.push(`frame ${f} driver ${s} at ${local.toArray().map((v) => v.toFixed(2))}`);
      });
    }
    ragdolls.dispose();
    assert.deepEqual(inside, [], "a torso inside the other car's cabin");
  });
});
