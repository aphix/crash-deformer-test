import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import type { DetachPart } from "./car-core.ts";
import { assignClass, CLASSES, type VehicleClassId } from "./vehicle-classes.ts";
import { PANEL_NAMES } from "./car-panels.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { assertSameNumbers, DT, paint } from "./test-support.ts";

/**
 * A hinged panel's shell is drawn where its patch of body is: in the body's own frame, which carries the class lift,
 * the suspension pose and a lost wheel's sag. A torn shell starts from where it hung.
 */

class Probe extends DeformableCar {
  part(name: string): DetachPart {
    return this.parts.find((p) => p.name === name)!;
  }
  /** Hinge the panel to `t` through the game's own posing. */
  hang(name: string, t: number): DetachPart {
    const p = this.part(name);
    p.hingeT = t;
    this.posePart(p);
    return p;
  }
  tear(name: string): void {
    this.detachPart(this.part(name), 20);
  }
}

const HUBS = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;

/** A wreck of class `cls` that has lost wheel `lost` (if any) and settled on it for 3 s. */
function wreck(cls: VehicleClassId, lost: number | null): Probe {
  const car = new Probe(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  car.deform.setMode("shape");
  assignClass(car, cls);
  car.spawnFacing(0, 0, 0, 0);
  car.group.updateMatrixWorld(true);
  car.applyImpact(car.group.position.clone().addScaledVector(car.forward, 2.05), car.forward.clone().negate(), 0.5, 0.5);
  if (lost !== null) car.deform.popHub(car.deform.masses.find((m) => m.name === HUBS[lost])!);
  const w = newWorld([car]);
  for (let f = 0; f < 180; f++) {
    stepWorld(w, DT);
    car.updateDeform(DT);
  }
  car.group.updateMatrixWorld(true);
  return car;
}

/** Where a mesh's vertices (all, or only `verts`) are in the world, averaged. */
function centre(mesh: THREE.Mesh, verts?: readonly number[]): THREE.Vector3 {
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.getAttribute("position");
  const ids = verts ?? Array.from({ length: pos.count }, (_, k) => k);
  const sum = new THREE.Vector3();
  for (const k of ids) sum.add(new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld));
  return sum.divideScalar(ids.length);
}

const CASES: readonly (readonly [VehicleClassId, number | null])[] = [
  ["sedan", null],
  ["sedan", 0],
  ["sedan", 3],
  ["truck", null],
  ["truck", 1],
  ["monster", null],
  ["monster", 2],
];

describe("a hinged panel's shell rides the body it is cut from", () => {
  for (const [cls, lost] of CASES) {
    const tag = `${cls}${lost === null ? "" : ` minus ${HUBS[lost]}`}`;

    it(`good: ${tag}: the shell's hinge line stands on the body skin (4 mm proud), whatever the lift and sag`, () => {
      const car = wreck(cls, lost);
      for (const name of PANEL_NAMES) {
        const p = car.hang(name, 0.5);
        const shell = p.object as THREE.Mesh;
        shell.updateWorldMatrix(true, false);
        car.body.updateWorldMatrix(true, false);
        const r = p.region!;
        const pos = car.body.geometry.getAttribute("position");
        const held = r.verts.reduce((a, _, k) => (r.w[k]! < r.w[a]! ? k : a), 0);
        const body = new THREE.Vector3().fromBufferAttribute(pos, r.verts[held]!).applyMatrix4(car.body.matrixWorld);
        const hinge = new THREE.Vector3().fromBufferAttribute(shell.geometry.getAttribute("position"), held).applyMatrix4(shell.matrixWorld);
        assert.ok(hinge.distanceTo(body) < 0.01, `${name}: shell hinge ${(hinge.distanceTo(body) * 100).toFixed(1)} cm off its body vertex`);
      }
    });

    it(`good: ${tag}: a torn panel starts on its patch of body (0.14 m out, 0.08 m up), not at the stock ride`, () => {
      const car = wreck(cls, lost);
      for (const name of ["quarterR", "archFL"]) {
        const p = car.hang(name, 0.05);
        const patch = centre(car.body, [...p.region!.verts]);
        car.tear(name);
        const d = centre(p.object as THREE.Mesh).sub(patch);
        assert.ok(Math.abs(d.y - 0.08) < 0.03, `${name}: torn shell starts ${(d.y * 100).toFixed(1)} cm above its patch of body (launch lift 8 cm)`);
        assert.ok(Math.hypot(d.x, d.z) < 0.2, `${name}: torn shell starts ${Math.hypot(d.x, d.z).toFixed(2)} m sideways of its patch of body`);
      }
    });
  }
});

/** The vertex buffer's upload count: the shell is rebuilt (and re-uploaded) once per `needsUpdate`. */
const uploads = (p: DetachPart) => ((p.object as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute).version;

describe("a panel shell is rebuilt when it changes, not every frame", () => {
  it("good: a settled wreck's hinged shells are not rebuilt, and one whose hinge moves is", () => {
    const car = wreck("sedan", null);
    const open = ["quarterR", "archRL"].map((n) => car.hang(n, 0.5));
    for (let f = 0; f < 30; f++) car.updateDeform(DT);
    const before = open.map(uploads);
    for (let f = 0; f < 30; f++) car.updateDeform(DT);
    assertSameNumbers(open.map(uploads), before, "shell uploads over 30 settled frames");
    open[0]!.hingeT = 0.8;
    car.updateDeform(DT);
    assert.ok(uploads(open[0]!) > before[0]!, "a shell whose hinge moved stayed as it was");
    assert.equal(uploads(open[1]!), before[1], "the other shell was rebuilt");
  });

  it("good: a shell torn past the two a car draws stops where it was hidden, the drawn ones lie down", () => {
    const car = new Probe(paint(), new THREE.Scene(), null, "sedan");
    car.deform.setMode("shape");
    const names = ["quarterL", "quarterR", "archFL"];
    for (const n of names) car.tear(n);
    const [hidden, ...drawn] = names.map((n) => car.part(n));
    assert.ok(!hidden!.object.visible && drawn.every((p) => p.object.visible), "the oldest of three torn shells is the hidden one");
    const at = hidden!.object.position.clone();
    const was = drawn.map((p) => p.object.position.y);
    for (let f = 0; f < 120; f++) car.step(DT);
    assert.equal(hidden!.object.position.distanceTo(at), 0, "a hidden shell kept moving");
    assert.ok(drawn.every((p, i) => p.object.position.y < was[i]! - 0.05), "a drawn shell did not fall");
  });
});
