import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { RigidBody } from "@dimforge/rapier3d-simd";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { blankEjection } from "../vehicle/ejection.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

/**
 * A 32-car field: every car drives a ring around the middle (no car physics; the dummies only read the cars' poses),
 * and drivers are thrown up out of their windshields. Heap growth is summed per frame, positive deltas only: a
 * frame with a scavenge counts as 0, so this only undercounts.
 */
const CARS = 32;
const FRAME = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);

function field(): { cars: DeformableCar[]; drive: (t: number) => void } {
  const cars: DeformableCar[] = [];
  for (let i = 0; i < CARS; i++) cars.push(makeCar());
  const drive = (t: number) => {
    for (let i = 0; i < CARS; i++) {
      const c = cars[i]!;
      const r = 12 + (i % 8) * 4;
      const w = (14 / r) * (i % 2 ? 1 : -1);
      const a = w * t + (i * 2 * Math.PI) / CARS;
      c.group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      c.velocity.set(-Math.sin(a) * r * w, 0, Math.cos(a) * r * w);
      c.group.quaternion.setFromAxisAngle(UP, Math.atan2(c.velocity.x, c.velocity.z));
      c.group.updateMatrixWorld();
    }
  };
  return { cars, drive };
}

/** Car `i`'s driver out of the windshield, 6 m/s up and 3 m/s ahead of the car. */
function throwOut(ragdolls: RagdollSystem, cars: DeformableCar[], i: number): void {
  const c = cars[i]!;
  const e = blankEjection();
  e.car = i;
  e.dir.set(0, 0, 1).applyQuaternion(c.group.quaternion);
  e.pos.copy(c.group.position).addScaledVector(UP, 1.3).addScaledVector(e.dir, 0.6);
  e.quat.copy(c.group.quaternion);
  e.rel.copy(e.dir).multiplyScalar(3).addScaledVector(UP, 6);
  e.carVel.copy(c.velocity);
  e.spin.set(3, 0, 0);
  ragdolls.launch(e, cars);
}

const flightAllocCases = [
  { it: "when one driver is thrown and flies for 40 frames, then the dummies allocate at most 75 KB of heap per frame", thrown: 1, boundKb: 75 },
  { it: "when four drivers are thrown and fly for 40 frames, then the dummies allocate at most 125 KB of heap per frame", thrown: 4, boundKb: 125 },
] as const;

describe("given 32 cars driving around the middle of an open field and drivers thrown out of their windshields", () => {
  for (const testCase of flightAllocCases) {
    it(testCase.it, async () => {
      const { cars, drive } = field();
      const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
      drive(0);
      await ragdolls.preload();
      const run = (frames: number, perFrame: (f: number) => void) => {
        ragdolls.reset();
        drive(0);
        for (let k = 0; k < testCase.thrown; k++) throwOut(ragdolls, cars, k);
        for (let f = 0; f < frames; f++) {
          drive((f + 1) * FRAME);
          ragdolls.update(FRAME, cars, true, false, 60, null);
          perFrame(f);
        }
      };
      for (let warm = 0; warm < 6; warm++) run(50, () => {});
      const dolls = ragdolls["dolls"];
      let grown = 0;
      let lowestTorso = Infinity;
      let before = process.memoryUsage().heapUsed;
      run(44, (f) => {
        const now = process.memoryUsage().heapUsed;
        if (f >= 4) grown += Math.max(0, now - before);
        before = now;
        if (f >= 4) for (let k = 0; k < testCase.thrown; k++) lowestTorso = Math.min(lowestTorso, dolls[k]!.cur[1]!);
      });
      ragdolls.dispose();
      assert.ok(lowestTorso > 1.5, `the dummies were down to ${lowestTorso.toFixed(2)} m: not a flight`);
      const kb = grown / 40 / 1024;
      assert.ok(kb <= testCase.boundKb, `${kb.toFixed(1)} KB per frame`);
    });
  }

  it("when a car comes at a dummy lying 40 m ahead of it at 25 m/s, then it strikes him and shoves him at least 3 m", async () => {
    const car = makeCar("shape", 0.32, 0.45);
    launch(car, -40, 0, Math.PI / 2, 0, 0);
    const w = makeWorld([car], false, false);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    const frame = () => {
      tickWorld(w);
      ragdolls.update(FRAME, [car], true, false, 0, null);
    };
    frame();
    ragdolls["spawn"]({ car: 5, p: new THREE.Vector3(0, 0.3, 0), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), v: new THREE.Vector3(), w: new THREE.Vector3(), age: 0, cop: false, rides: true });
    const torso: RigidBody = ragdolls["dolls"][0]!.bodies[0]!;
    for (let f = 0; f < 30; f++) frame();
    launch(car, -40, 0, Math.PI / 2, 25, 0);
    for (let f = 0; f < 180; f++) frame();
    const x = torso.translation().x;
    ragdolls.dispose();
    assert.ok(x > 3, `the car shoved him ${x.toFixed(1)} m`);
  });
});
