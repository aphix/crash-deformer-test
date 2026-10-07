import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import { headOn } from "../vehicle/ejection.test-util.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;

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

describe("given thrown drivers (dummies that are cosmetic: the cars move the same with or without them)", () => {
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
      it(`when ${sandbox ? "the sandbox" : "a race or a derby"} runs ${label} and both drivers are thrown, then both dummies fly, the cars move as they do without dummies, and ${sandbox ? "the ride-along slow-mo is asked for both drivers" : "no ride-along slow-mo is asked"}`, async () => {
        const cars = pair();
        const plain = pair();
        const scene = new THREE.Scene();
        const rideAlong: number[] = [];
        const ragdolls = new RagdollSystem(scene, (i) => rideAlong.push(i), () => {});
        await ragdolls.preload();
        const w = makeWorld(cars, false, false);
        w.onEject = (e) => ragdolls.launch(e, cars);
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

describe("given a fleet 2×36 km/h head-on that crashes both cars, cracks their windshields and leaves the rest of their glass whole, and a dummy's torso that strikes their glass (each strike cracks a pane, the next shatters it)", () => {
  it("when every pane of both cars is struck twice in the second after the hit, then every pane ends shattered and the cars move exactly as they do with the glass left to the crash", () => {
    const cars = headOn(10);
    const plain = headOn(10);
    const w = makeWorld(cars, false, false);
    const wPlain = makeWorld(plain, false, false);
    const panes = ["windshield", "rear", "doorL", "doorR", "quarterL", "quarterR"] as const;
    const first = 24;
    for (let f = 0; f < 240; f++) {
      tickWorld(w);
      tickWorld(wPlain);
      // From 0.4 s (the hit lands about 0.3 s in), a strike every other frame: every pane of both cars twice over.
      const k = (f - first) / 2;
      if (Number.isInteger(k) && k >= 0 && k < 2 * 2 * panes.length) cars[k % 2]!.hitGlass(panes[(k >> 1) % panes.length]!);
    }
    assert.ok(cars.every((c) => c.crashed), "both cars crashed");
    let allShattered = 0;
    for (let p = 0; p < panes.length; p++) allShattered |= 2 << (2 * p);
    for (const [i, car] of cars.entries()) assert.equal(car.glassBits(), allShattered, `car ${i}: every pane struck twice is gone`);
    assert.ok(plain.some((c) => c.glassBits() !== allShattered), "the crash alone left some pane unshattered");
    assertSameDigest(simState(cars), simState(plain), "every car's sim state with struck glass vs without");
  });
});

describe("given a head-on crash between two fleet cars whose physics engine for the dummies loads late", () => {
  /** The fleet head-on with Rapier loading `late` frames in (the hit lands about 0.2 s in): dummies out at the end. */
  async function thrownAfterLoad(late: number): Promise<boolean> {
    const cars = headOn(20);
    const scene = new THREE.Scene();
    const ragdolls = new RagdollSystem(scene, () => {}, () => {});
    const w = makeWorld(cars, false, false);
    w.onEject = (e) => ragdolls.launch(e, cars);
    for (let f = 0; f < 150; f++) {
      if (f === late) await ragdolls.preload();
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
    }
    const out = scene.getObjectByName("ragdolls")!.visible;
    ragdolls.dispose();
    return out;
  }

  it("when the physics engine loads 0.5 s into the run, then the driver is still thrown", async () => {
    assert.equal(await thrownAfterLoad(42), true);
  });

  it("when the physics engine loads more than a second after the hit, then the throw is dropped and no dummy flies", async () => {
    assert.equal(await thrownAfterLoad(120), false);
  });
});

describe("given a fleet head-on crash that throws both drivers", () => {
  it("when the dummies fly for 2 s, then each driver flies into the other car and never ends up inside its cabin", async () => {
    const cars = headOn(20);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    const w = makeWorld(cars, false, false);
    w.onEject = (e) => ragdolls.launch(e, cars);
    const local = new THREE.Vector3();
    const inv = new THREE.Quaternion();
    const inside: string[] = [];
    for (let f = 0; f < 120; f++) {
      tickWorld(w);
      ragdolls.update(FRAME, cars, true, true, 0, null);
      // Slots fill in car order (car 0's driver first): each torso against the OTHER car's cabin (it never crushes;
      // the crushed nose in front of it is not where the rest-size box says).
      for (const [s, d] of ragdolls["dolls"].entries()) {
        if (!d.live) continue;
        const other = cars[1 - s]!;
        const t = d.bodies[0]!.translation();
        local.set(t.x, t.y, t.z).sub(other.group.position).applyQuaternion(inv.copy(other.group.quaternion).invert());
        if (Math.abs(local.x) < 0.7 && local.y > 0.8 && local.y < 1.34 && local.z > -0.75 && local.z < 0.61) inside.push(`frame ${f} driver ${s} at ${local.toArray().map((v) => v.toFixed(2))}`);
      }
    }
    ragdolls.dispose();
    assert.deepEqual(inside, [], "a torso inside the other car's cabin");
  });
});
