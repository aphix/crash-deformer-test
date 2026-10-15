import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FRAME_HZ } from "../kernel/constants.ts";
import { FREEWHEEL, launch, makeWorld, PARKED, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { FLAT_GROUND, Ground, setGround } from "../world/ground.ts";
import { layOnGround } from "./car-air-points.ts";
import type { DeformableCar } from "./car.ts";
import { buildCar } from "./drawn-body.test-util.ts";
import type { VehicleClassId } from "./vehicle-classes.ts";

/**
 * A wreck rests on its own crushed underside. A head-on crush pushes a sill or a fender down in the car's frame, which moves a body
 * point into the ground with no speed of the rigid body's; the wreck then sat on its tyres with that point 4-19 cm in the road (the
 * owner's clips: wrecks 0.13-0.47 m sunk). Bar: no drawn point (tyres included) more than 3 cm in the ground under it. The cage the
 * rigid step rests on is the drawn skin to a few cm (`SKIN`), and 2.6 cm of the drawn rocker under the ground is what it measures
 * of that after the fix; before it, 4-7 cm.
 */
const SINK_M = 0.03;
const DEG = 180 / Math.PI;
const SETTLE_MAX_S = 12;
/** Brakes on from here: a wreck left in neutral slides off a slope for good. */
const PARK_AFTER_S = 2;

/** The plane `heightAt` = x·tan(pitch) (degrees): a car facing +x sees `pitch` as its slope. */
class Slope extends Ground {
  constructor(pitchDeg: number) {
    super();
    const tp = Math.tan(pitchDeg / DEG);
    const e = 1e4;
    this.addGrid({ nu: 2, nv: 2, step: 2 * e, stepV: 2 * e, u0: -e, v0: -e, heights: new Float32Array([-e * tp, e * tp, -e * tp, e * tp]), ox: 0, oy: 0, oz: 0, reach: Infinity });
  }
}

type Hit = { name: string; a: VehicleClassId; b: VehicleClassId; kphA: number; kphB: number; offset: number; yawB: number };

/** Head-on hits (the second car's heading yawed, its nose offset across) that left a wreck with its crushed underside in the ground. */
const HITS: Hit[] = [
  { name: "a muscle car at 104 km/h into a police car at 90 km/h", a: "muscle", b: "police", kphA: 103.6, kphB: 89.9, offset: 0.45, yawB: -0.19 },
  { name: "a police car at 150 km/h into a sedan at 46 km/h", a: "police", b: "sedan", kphA: 150.5, kphB: 45.7, offset: -0.26, yawB: 0.13 },
  { name: "a truck at 121 km/h into a monster at 142 km/h", a: "truck", b: "monster", kphA: 121.4, kphB: 141.8, offset: 0.35, yawB: 0.21 },
  { name: "a sedan at 125 km/h into a sedan at 125 km/h", a: "sedan", b: "sedan", kphA: 124.6, kphB: 124.6, offset: 0.36, yawB: -0.46 },
];

const _v = new THREE.Vector3();

/** The drawn body's lowest point over the ground under it (m; negative: in the ground), every visible mesh of the car, tyres included, and the mesh it is on. */
function lowestDrawn(car: DeformableCar, ground: Ground): { clearance: number; mesh: string } {
  car.flushDeferredSkin();
  car.updateSkin();
  car.group.updateMatrixWorld(true);
  const inverse = car.group.matrixWorld.clone().invert();
  const lowest = { clearance: Infinity, mesh: "" };
  car.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name === "deform-rig" || !p.visible) return;
    const position = o.geometry.getAttribute("position");
    if (!position) return;
    for (let k = 0; k < position.count; k++) {
      _v.fromBufferAttribute(position, k).applyMatrix4(o.matrixWorld);
      const clearance = _v.y - ground.heightAt(_v.x, _v.z, _v.y);
      if (clearance >= lowest.clearance) continue;
      lowest.clearance = clearance;
      lowest.mesh = `${o.name || o.geometry.type} of ${o.parent?.name || o.parent?.type} at ${_v.clone().applyMatrix4(inverse).toArray().map((n) => n.toFixed(2))}`;
    }
  });
  return lowest;
}

/** Stages `hit` on `ground` and runs it until both cars sleep (or `SETTLE_MAX_S`): the cars the hit left wrecks, at rest. */
function wrecksAtRest(hit: Hit, ground: Ground): DeformableCar[] {
  setGround(ground);
  const cars = [buildCar(hit.a === "monster" || hit.a === "truck" ? "pickup" : "sedan", hit.a), buildCar(hit.b === "monster" || hit.b === "truck" ? "pickup" : "sedan", hit.b)] as const;
  const [a, b] = cars;
  launch(a, -5, 0, Math.PI / 2, hit.kphA / 3.6, 0);
  launch(b, 5, hit.offset, -Math.PI / 2 + hit.yawB, (-hit.kphB / 3.6) * Math.cos(hit.yawB), (-hit.kphB / 3.6) * Math.sin(hit.yawB));
  for (const car of cars) {
    car.group.position.y = ground.heightAt(car.group.position.x, car.group.position.z, 1);
    layOnGround(car);
  }
  const world = makeWorld([a, b], false, false);
  for (const car of cars) world.pedals.set(car, FREEWHEEL);
  for (let f = 0; f < SETTLE_MAX_S * FRAME_HZ && !(a.asleep && b.asleep); f++) {
    if (f === PARK_AFTER_S * FRAME_HZ) for (const car of cars) world.pedals.set(car, PARKED);
    tickWorld(world, 1 / FRAME_HZ);
  }
  return cars.filter((car) => car.deform.massActive);
}

describe("given two cars crushed head-on, left to rest on the ground", () => {
  afterEach(() => setGround(null));

  for (const [site, pitch] of [["flat ground", 0], ["a 10° slope", 10]] as const) {
    for (const hit of HITS) {
      it(`when ${hit.name} on ${site}, then no point of either wreck is drawn more than 3 cm in the ground under it`, () => {
        const ground = pitch === 0 ? FLAT_GROUND : new Slope(pitch);
        const wrecks = wrecksAtRest(hit, ground);
        assert.ok(wrecks.length > 0, "the hit left no wreck");
        for (const wreck of wrecks) {
          const { clearance, mesh } = lowestDrawn(wreck, ground);
          assert.ok(clearance >= -SINK_M, `lowest drawn point ${(clearance * 100).toFixed(1)} cm over the ground (negative: in it), on ${mesh}; asleep ${wreck.asleep}`);
        }
      });
    }
  }
});
