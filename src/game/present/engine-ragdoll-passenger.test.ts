import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { FREEWHEEL, launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armKill, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import type { DriverLook } from "./driver-look.ts";
import { RagdollSystem, type Throw } from "./engine-ragdoll.ts";

const HEAD_ON_MPS = 20;
const SETTLE_FRAMES = 60;
const FIRST_WORKER_ID = 7;
const PASSENGER: DriverLook = { woman: false, shirt: 0x1f3463, pants: 0x1f3463, hair: 0xe8bf6c, hat: null, mustache: false, portly: true };

/** A fleet-armed sedan head-on pair, played until a driver is thrown: the cars and the ejections that came out. */
function headOnEjections() {
  const cars = [makeCar(), makeCar()];
  for (const car of cars) {
    car.deform.setMode("shape");
    car.deform.squash = 0.32;
    car.deform.buckle = 0.45;
    armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
  }
  launch(cars[0]!, -5, 0, Math.PI / 2, HEAD_ON_MPS, 0);
  launch(cars[1]!, 5, 0, -Math.PI / 2, -HEAD_ON_MPS, 0);
  const world = makeWorld(cars, false, false, FREEWHEEL);
  const ejections: Ejection[] = [];
  world.onEject = (e) => ejections.push(e);
  for (let f = 0; f < SETTLE_FRAMES; f++) tickWorld(world);
  return { cars, ejections };
}

/** A ragdoll system whose dummies' world is a worker that only records the throws sent to it (the worker mode of a race course). */
function systemWithWorker() {
  const sent: { t: Throw; purse: boolean }[] = [];
  const worker = {
    throwDummy: (t: Throw, purse: boolean) => {
      sent.push({ t: { ...t, p: t.p.clone(), v: t.v.clone() }, purse });
      return FIRST_WORKER_ID + sent.length - 1;
    },
  };
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  ragdolls["mode"] = "remote";
  Object.assign(ragdolls, { remote: worker });
  return { ragdolls, sent };
}

describe("given the dummies' world in the ragdoll worker (race courses) and a driver thrown from his car", () => {
  it("when his passenger is thrown with him, then the worker is sent a second dummy beside the driver at the driver's own velocity, dressed as the passenger", () => {
    const { cars, ejections } = headOnEjections();
    assert.ok(ejections.length >= 1, "a driver was thrown in the head-on");
    const { ragdolls, sent } = systemWithWorker();
    const e = ejections[0]!;
    ragdolls.launch(e, cars);
    ragdolls.throwPassenger(e.car, PASSENGER);
    assert.equal(sent.length, 2, "the driver's and his passenger's throws reached the worker");
    const driver = sent[0]!;
    const passenger = sent[1]!;
    const apart = driver.t.p.distanceTo(passenger.t.p);
    assert.ok(apart > 0.5 && apart < 1, `the passenger starts ${apart.toFixed(2)} m from the driver`);
    assert.ok(driver.t.v.distanceTo(passenger.t.v) < 1e-9, "he leaves at the driver's velocity");
    assert.equal(passenger.purse, false, "no purse for him");
    assert.equal(ragdolls["dressing"].get(FIRST_WORKER_ID + 1)?.look.portly, true, "the worker's slot for him is dressed as the passenger");
  });

  it("when a passenger is thrown with a car whose driver was not thrown, then nothing is sent", () => {
    const { cars, ejections } = headOnEjections();
    const { ragdolls, sent } = systemWithWorker();
    const e = ejections[0]!;
    ragdolls.launch(e, cars);
    ragdolls.throwPassenger(1 - e.car, PASSENGER);
    assert.equal(sent.length, 1, "only the driver's own throw");
  });

  it("when the other car's driver is thrown after his in the same frame, then his passenger is still thrown with him, beside him", () => {
    const { cars, ejections } = headOnEjections();
    assert.ok(ejections.length >= 2, "both drivers are thrown in the head-on");
    const { ragdolls, sent } = systemWithWorker();
    for (const e of ejections) ragdolls.launch(e, cars);
    const first = ejections[0]!;
    ragdolls.throwPassenger(first.car, PASSENGER);
    assert.equal(sent.length, ejections.length + 1, "every driver's throw and the passenger's reached the worker");
    const driver = sent[0]!;
    const passenger = sent[ejections.length]!;
    const apart = driver.t.p.distanceTo(passenger.t.p);
    assert.ok(apart > 0.5 && apart < 1, `the passenger starts ${apart.toFixed(2)} m from his own driver, not the later one`);
    assert.ok(driver.t.v.distanceTo(passenger.t.v) < 1e-9, "he leaves at his driver's velocity");
  });
});

describe("given the dummies' world on this thread (the fallback, and every scene that is not a race course) and a driver thrown from his car", () => {
  it("when his passenger is thrown with him, then two dummies are out in the one world, the second beside the first", async () => {
    const { cars, ejections } = headOnEjections();
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    const e = ejections[0]!;
    ragdolls.launch(e, cars);
    ragdolls.throwPassenger(e.car, PASSENGER);
    const dolls: { live: boolean; bodies: { translation(): THREE.Vector3Like }[] }[] = ragdolls["dolls"];
    const out = dolls.filter((d) => d.live);
    assert.equal(out.length, 2, "the driver and his passenger");
    const a = out[0]!.bodies[0]!.translation();
    const b = out[1]!.bodies[0]!.translation();
    const apart = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    assert.ok(apart > 0.5 && apart < 1, `the passenger starts ${apart.toFixed(2)} m from the driver`);
  });
});
