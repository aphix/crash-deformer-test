import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { HEAD, LampLights, POOL_HEAD } from "./lamp-lights.ts";
import { paint } from "./test-support.ts";

const DT = 1 / 60;
/** A lamp's pool may change by this much of its full brightness per frame (the fade is 0.3 s, so 1/18 at 60 Hz). */
const STEP = 0.1;
const HEADS = [0, 1] as const;
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Headlamp `i` of `car`: its real spot's share of full intensity, and its painted decal's share of full colour, this frame. */
function shares(lights: LampLights, car: DeformableCar, i: number): { real: number; painted: number } {
  car.lampWorld(i, _p, _d);
  let real = 0;
  for (const s of lights.spots) if (_p.distanceTo(s.position) < 1e-6) real += s.intensity / HEAD.intensity;
  let painted = 0;
  const m = lights.pools.instanceMatrix.array;
  const c = lights.pools.instanceColor!.array;
  for (let k = 0; k < lights.pools.count; k++) {
    if (Math.abs(m[k * 16 + 12]! - _p.x) < 1e-4 && Math.abs(m[k * 16 + 14]! - _p.z) < 1e-4) painted += c[k * 3]! / POOL_HEAD[0];
  }
  return { real, painted };
}

const lightCount = (scene: THREE.Scene): number => {
  let n = 0;
  scene.traverseVisible((o) => void (o instanceof THREE.Light && n++));
  return n;
};

describe("given 4 cars in a row and a camera orbiting them slowly at night", () => {
  it("when the camera goes round twice, then every headlamp's real and painted pool each change by under a tenth per frame and always sum to one, and the light count never moves", () => {
    const scene = new THREE.Scene();
    const cars: DeformableCar[] = [];
    for (let c = 0; c < 4; c++) {
      const car = new DeformableCar(paint(), scene);
      car.spawnFacing((c - 1.5) * 7, 0, 0, 0);
      car.group.updateMatrixWorld(true);
      cars.push(car);
    }
    const lights = new LampLights(scene, 16);
    const cam = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 400);
    const lit = lightCount(scene);
    const prev: { real: number; painted: number }[] = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let f = 0; f <= 1440; f++) {
      const a = (f * 0.5 * Math.PI) / 180;
      cam.position.set(Math.sin(a) * 16, 3, Math.cos(a) * 16);
      cam.lookAt(0, 0.5, 0);
      cam.updateMatrixWorld(true);
      lights.update(cars, cam, null, f * DT, undefined, DT);
      assert.equal(lightCount(scene), lit, `the light count changed at frame ${f}`);
      assert.equal(lights.spots.length + lights.points.length, 8);
      for (let c = 0; c < 4; c++) {
        for (const i of HEADS) {
          const s = shares(lights, cars[c]!, i);
          const k = c * 2 + i;
          assert.ok(Math.abs(s.real + s.painted - 1) < 0.02, `car ${c} head ${i} shows ${(s.real + s.painted).toFixed(3)} of a pool at frame ${f}`);
          if (f > 0) {
            assert.ok(Math.abs(s.real - prev[k]!.real) <= STEP, `car ${c} head ${i} real light jumped ${prev[k]!.real.toFixed(2)} -> ${s.real.toFixed(2)} at frame ${f}`);
            assert.ok(Math.abs(s.painted - prev[k]!.painted) <= STEP, `car ${c} head ${i} decal jumped ${prev[k]!.painted.toFixed(2)} -> ${s.painted.toFixed(2)} at frame ${f}`);
          }
          prev[k] = s;
          lo = Math.min(lo, s.real);
          hi = Math.max(hi, s.real);
        }
      }
    }
    assert.ok(lo < 0.05 && hi > 0.95, `the orbit never took a lamp across the whole scale (${lo.toFixed(2)}..${hi.toFixed(2)})`);
  });
});

describe("given a fixed camera and one car driving across the frame", () => {
  for (const dir of [1, -1]) {
    it(`when the car crosses ${dir > 0 ? "left to right" : "right to left"}, then a headlamp's real light ramps up to the middle and back down, never jumping, and the painted pool is the rest`, () => {
      const scene = new THREE.Scene();
      const car = new DeformableCar(paint(), scene);
      const lights = new LampLights(scene, 4);
      const cam = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 400);
      cam.position.set(0, 2, 14);
      cam.lookAt(0, 0.5, 0);
      cam.updateMatrixWorld(true);
      const yaw = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      const real: number[] = [];
      for (let f = 0; f <= 400; f++) {
        car.spawnFacing(dir * (-20 + f * 0.1), 0, yaw, 0);
        car.group.updateMatrixWorld(true);
        lights.update([car], cam, null, f * DT, undefined, DT);
        const s = shares(lights, car, 0);
        assert.ok(Math.abs(s.real + s.painted - 1) < 0.02, `a pool of ${(s.real + s.painted).toFixed(3)} at frame ${f}`);
        real.push(s.real);
      }
      const peak = real.indexOf(Math.max(...real));
      assert.ok(real[peak]! > 0.95, `the lamp only reached ${real[peak]!.toFixed(2)} real in the middle`);
      assert.ok(real[0]! < 0.01 && real[400]! < 0.01, "the lamp was real at the edge of the frame");
      for (let f = 1; f <= 400; f++) {
        assert.ok(Math.abs(real[f]! - real[f - 1]!) <= STEP, `real light jumped ${real[f - 1]!.toFixed(2)} -> ${real[f]!.toFixed(2)} at frame ${f}`);
        if (f <= peak) assert.ok(real[f]! >= real[f - 1]! - 1e-6, `real light dipped on the way in at frame ${f}`);
        else assert.ok(real[f]! <= real[f - 1]! + 1e-6, `real light rose again on the way out at frame ${f}`);
      }
    });
  }
});
