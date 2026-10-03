import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Witness } from "./witness.ts";

/** Camera at the origin looking down -z: near 0.1, far 200, 50° vertical, 16:9. */
function cam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
  c.position.set(0, 0, 0);
  c.lookAt(0, 0, -1);
  return c;
}

const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("Witness: the camera cone every cosmetic skip asks", () => {
  it("good: a sphere poking into the view at the frustum edge is witnessed, one clear of it by the margin is not", () => {
    const w = new Witness();
    w.aim(cam());
    // At z = -10 the right edge is 10·tan(25°)·16/9 = 8.29 m out: a 1 m ball centred 0.5 m outside still pokes in.
    const edge = 10 * Math.tan(THREE.MathUtils.degToRad(25)) * (16 / 9);
    assert.equal(w.mayWitness(at(edge + 0.5, 0, -10), 1), true);
    assert.equal(w.mayWitness(at(edge + 20, 0, -10), 1), false);
  });

  it("good: far behind the camera is not witnessed; just behind the near plane, inside the margin, is", () => {
    const w = new Witness();
    w.aim(cam());
    assert.equal(w.mayWitness(at(0, 0, 60), 2), false);
    assert.equal(w.mayWitness(at(0, 0, 0.5), 1), true);
  });

  it("edge: past the far plane by more than radius plus margin is not witnessed", () => {
    const w = new Witness();
    w.aim(cam());
    assert.equal(w.mayWitness(at(0, 0, -199), 2), true);
    assert.equal(w.mayWitness(at(0, 0, -260), 2), false);
  });

  it("edge: before the first aim, or switched off, everything is witnessed", () => {
    const w = new Witness();
    assert.equal(w.mayWitness(at(0, 0, 500), 1), true);
    w.aim(cam());
    assert.equal(w.mayWitness(at(0, 0, 500), 1), false);
    w.enabled = false;
    assert.equal(w.mayWitness(at(0, 0, 500), 1), true);
  });

  it("good: the cone follows the camera the last aim read", () => {
    const w = new Witness();
    const c = cam();
    w.aim(c);
    assert.equal(w.mayWitness(at(0, 0, 80), 2), false);
    c.position.set(0, 0, 100);
    w.aim(c);
    assert.equal(w.mayWitness(at(0, 0, 80), 2), true);
  });

  it("good: `sees` counts what it refused and what it let through; with the gate off it lets all through", () => {
    const w = new Witness();
    w.aim(cam());
    assert.equal(w.sees(at(0, 0, -10), 4), true);
    assert.equal(w.sees(at(0, 0, 80), 4), false);
    assert.deepEqual([w.allowed, w.skipped], [1, 1]);
    w.gateFx = false;
    assert.equal(w.sees(at(0, 0, 80), 4), true);
  });

  it("never misses: over random cameras and boxes, a box with a corner in the viewport is always witnessed", () => {
    // mulberry32: the same 4000 trials every run.
    let s = 0x9e3779b9;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const w = new Witness();
    const c = new THREE.PerspectiveCamera(30 + rnd() * 60, 1 + rnd(), 0.1, 300);
    const half = new THREE.Vector3(1, 0.8, 2.3);
    const radius = half.length();
    const corner = new THREE.Vector3();
    const pv = new THREE.Matrix4();
    let visible = 0;
    for (let n = 0; n < 4000; n++) {
      c.fov = 30 + rnd() * 60;
      c.aspect = 1 + rnd();
      c.updateProjectionMatrix();
      c.position.set((rnd() - 0.5) * 80, 1 + rnd() * 30, (rnd() - 0.5) * 80);
      c.lookAt((rnd() - 0.5) * 80, 0, (rnd() - 0.5) * 80);
      w.aim(c);
      pv.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
      const centre = at((rnd() - 0.5) * 160, rnd() * 3, (rnd() - 0.5) * 160);
      const yaw = rnd() * Math.PI * 2;
      let inView = false;
      for (let k = 0; k < 8 && !inView; k++) {
        corner.set(k & 1 ? half.x : -half.x, k & 2 ? half.y : -half.y, k & 4 ? half.z : -half.z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw).add(centre);
        const p4 = new THREE.Vector4(corner.x, corner.y, corner.z, 1).applyMatrix4(pv);
        inView = p4.w > 0 && Math.abs(p4.x) <= p4.w && Math.abs(p4.y) <= p4.w && Math.abs(p4.z) <= p4.w;
      }
      if (!inView) continue;
      visible++;
      assert.equal(w.mayWitness(centre, radius), true, `trial ${n}: a visible corner, not witnessed`);
    }
    assert.ok(visible > 200, `only ${visible} of 4000 trials had the box in view: the property was barely exercised`);
  });
});
