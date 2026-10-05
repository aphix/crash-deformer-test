import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { fleetStyle } from "../scenes/fleet.ts";
import { JerseyBarrier } from "../scenes/engine-props.ts";
import { TraceRecorder, type TraceClock, type TraceSetup } from "./engine-trace.ts";

const setup: TraceSetup = {
  barrier: true,
  barrierYaw: 0.3,
  squash: 1,
  buckle: 1,
  fxDensity: 0.7,
  balls: false,
  ramps: true,
  compactor: false,
  compactFace: 0,
  carCount: 2,
  speedMin: 0,
  speedMax: 32,
  scene: "fleet",
  seed: 0x3fa2c1,
  night: true,
  wet: false,
  realism: 0.35,
  fxTier: "high",
  loop: true,
  autoSlomo: true,
  userTimeScale: null,
  deformMode: "shape",
  playerClass: "sedan",
  viewW: 1280,
  viewH: 720,
  pixelRatio: 1.5,
  dpr: 2,
};

const none = { snapshot: () => ({ count: 0, items: [] }) };

function rig() {
  const scene = new THREE.Scene();
  const cars = [0, 1].map((i) => new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i)));
  cars.forEach((c, i) => c.spawnFacing(i * 6, 0, 0, 10));
  const camera = new THREE.PerspectiveCamera(46, 16 / 9);
  camera.position.set(10.12345, 6, 16);
  camera.lookAt(0, 0.7, 0);
  const trace = new TraceRecorder({
    barrier: new JerseyBarrier(scene, new THREE.Group()),
    balls: [],
    sparks: none,
    smoke: none,
    debris: none,
  });
  const clock: TraceClock = { wall: 1, sim: 0.5, phase: "approach", timeScale: 0.35, closing: 8, barrierHit: false, camera, rig: "orbit", follow: "c1" };
  return { cars, camera, trace, clock };
}

const nums = (v: unknown, n: number): number[] => {
  assert.ok(Array.isArray(v) && v.length === n);
  for (const x of v) assert.ok(typeof x === "number" && Number.isFinite(x));
  return v;
};

describe("given the trace recorder (the debug recording of a crash run) begun on two cars and an orbit camera following the second", () => {
  it("when it takes its first sample, then the sample carries the camera's position, rotation, unit forward direction and field of view, the camera rig in charge and the followed car", () => {
    const { cars, camera, trace, clock } = rig();
    trace.begin(setup, cars, clock);
    const cam = trace.samples[0]!.camera as Record<string, unknown>;
    assert.equal(cam.rig, "orbit");
    assert.equal(cam.follow, "c1");
    assert.equal(cam.fov, 46);
    assert.deepEqual(nums(cam.pos, 3), [10.123, 6, 16]);
    nums(cam.quat, 4);
    const dir = nums(cam.dir, 3);
    assert.ok(Math.abs(Math.hypot(...dir) - 1) < 2e-3);
    // dir is the camera's forward: it points at the target it was aimed at.
    const toTarget = new THREE.Vector3(0, 0.7, 0).sub(camera.position).normalize();
    assert.ok(new THREE.Vector3(...dir).dot(toTarget) > 0.999);
  });

  it("when the setup and the trace are written out, then both carry every HUD setting and keep the existing fields", () => {
    const { cars, trace, clock } = rig();
    trace.begin(setup, cars, clock);
    const want = { scene: "fleet", night: true, wet: false, realism: 0.35, fxTier: "high", loop: true, autoSlomo: true, timeScale: null, deformMode: "shape", playerClass: "sedan", pixelRatio: 1.5, dpr: 2, viewport: { w: 1280, h: 720 }, carCount: 2, speedMin: 0, speedMax: 32, squash: 1, buckle: 1, fxDensity: 0.7, ramps: true, barrier: true, balls: false };
    const shown: Record<string, unknown>[] = [JSON.parse(trace.setupJson(setup)), JSON.parse(trace.traceJson(setup)), trace.initial!];
    for (const doc of shown) {
      for (const [k, v] of Object.entries(want)) assert.equal(JSON.stringify(doc[k]), JSON.stringify(v), k);
    }
  });

  it("when the first sample is written out, then the camera adds under 200 bytes to it", () => {
    const { cars, trace, clock } = rig();
    trace.begin(setup, cars, clock);
    assert.ok(JSON.stringify(trace.samples[0]!.camera).length < 200);
  });
});
