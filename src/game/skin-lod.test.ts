import * as THREE from "three";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeformableCar } from "./car.ts";

const PAINT = { body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" };
const DT = 1 / 60;
/** Mid-window (still crushing) and well after the crush window closes. */
const CONTACT = 24;
const SETTLED = 80;

/** Every attached mesh's position buffer in traversal order (body, bonnet, boot, skinned glass, ...). */
function meshPositions(c: DeformableCar): Float32Array[] {
  const out: Float32Array[] = [];
  c.group.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o.geometry.getAttribute("position").array as Float32Array);
  });
  return out;
}

const bodyPositions = (c: DeformableCar) => c.body.geometry.getAttribute("position").array as Float32Array;

function maxDiff(a: Float32Array[], b: Float32Array[]): number {
  assert.equal(a.length, b.length);
  let d = 0;
  for (let k = 0; k < a.length; k++) for (let i = 0; i < a[k]!.length; i++) d = Math.max(d, Math.abs(a[k]![i]! - b[k]![i]!));
  return d;
}

/** A 14 m/s nose hit: 24 contact frames, then quiet frames up to `frames`. `defer` holds the LoD gate shut. */
function crashFront(c: DeformableCar, defer: boolean, frames: number): void {
  const d = c.deform;
  c.crashed = true;
  c.group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, 14);
  d.beginCrush(new THREE.Vector3(0, 0.38, 2.06), new THREE.Vector3(0, 0, -1), 14, 14, c.group, vel, new THREE.Vector3());
  const fl = d.masses.find((m) => m.name === "bumperFL")!;
  for (let i = 0; i < frames; i++) {
    if (i < CONTACT) {
      d.notifyContact();
      d.feedOverlap(fl.world, new THREE.Vector3(0, 0, -1), 0.1, 14, DT);
    }
    d.stepStructure(DT);
    d.followGroup(c.group, vel, new THREE.Vector3(), DT);
    d.skinDeferred = defer;
    c.updateDeform(DT);
  }
}

describe("deform LoD: deferred skin is owed, never lost", () => {
  it("good: an off-screen crash leaves the mesh at rest, then the catch-up writes the full dent", () => {
    const ref = new DeformableCar(PAINT, new THREE.Scene());
    const lod = new DeformableCar(PAINT, new THREE.Scene());
    const rest = [bodyPositions(lod).slice()];
    crashFront(ref, false, CONTACT);
    crashFront(lod, true, CONTACT);

    assert.ok(maxDiff([bodyPositions(ref)], rest) > 0.05, "reference car never dented");
    assert.equal(maxDiff([bodyPositions(lod)], rest), 0, "deferred car's body moved while off-screen");
    assert.equal(lod.deform.skinOwed, true);

    lod.flushDeferredSkin();
    assert.equal(lod.deform.skinOwed, false);
    assert.ok(maxDiff(meshPositions(lod), meshPositions(ref)) < 1e-6, "catch-up pose differs from the always-skinned car");
  });

  it("good: lifting the gate mid-crush settles the owed skin on the next deform update", () => {
    const ref = new DeformableCar(PAINT, new THREE.Scene());
    const lod = new DeformableCar(PAINT, new THREE.Scene());
    crashFront(ref, false, CONTACT);
    crashFront(lod, true, CONTACT);
    lod.deform.skinDeferred = false;
    lod.updateDeform(DT);
    ref.updateDeform(DT);
    assert.equal(lod.deform.skinOwed, false);
    assert.ok(maxDiff(meshPositions(lod), meshPositions(ref)) < 1e-6);
  });

  it("good: a crush window that closes while deferred freezes the same final pose, nothing left owed", () => {
    const ref = new DeformableCar(PAINT, new THREE.Scene());
    const lod = new DeformableCar(PAINT, new THREE.Scene());
    crashFront(ref, false, SETTLED);
    crashFront(lod, true, SETTLED);
    assert.equal(lod.deform.skinOwed, false);
    assert.ok(maxDiff(meshPositions(lod), meshPositions(ref)) < 1e-6, "deferred car froze a different dent");
  });

  it("edge: a visual reset clears an owed skin so the rebuilt car is not re-dented", () => {
    const lod = new DeformableCar(PAINT, new THREE.Scene());
    const rest = [bodyPositions(lod).slice()];
    crashFront(lod, true, CONTACT);
    lod.resetVisual();
    assert.equal(lod.deform.skinOwed, false);
    lod.deform.skinDeferred = false;
    lod.updateDeform(DT);
    assert.ok(maxDiff([bodyPositions(lod)], rest) < 1e-6);
  });
});
