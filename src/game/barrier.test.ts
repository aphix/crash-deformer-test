import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { leftoverCrumple } from "./physics-util.ts";
import { BARRIER_HALF, clipCarToBarrier, physicsSlice, satCarBarrier } from "./sat.ts";
import type { DeformMode } from "./streamed-deform.ts";

const ORIGIN = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();

function paint() {
  return { name: "Test", body: 0xffffff, accent: 0x444444 };
}

function mass(car: DeformableCar, name: string) {
  const m = car.deform.masses.find((n) => n.name === name);
  assert.ok(m, name);
  return m;
}

/** Jersey slab along Z, thin in X. Car drives -X into the +X face. */
function spawnAtBarrier(z: number, speed: number, mode: DeformMode): DeformableCar {
  const scene = new THREE.Scene();
  const car = new DeformableCar(paint(), scene);
  car.deform.setMode(mode);
  car.deform.squash = 0.4;
  car.deform.buckle = 0.45;
  car.group.position.set(6.2, 0, z);
  car.group.rotation.set(0, -Math.PI / 2, 0, "YXZ");
  car.refreshBasis();
  car.velocity.set(-speed, 0, 0);
  car.speed = speed;
  car.spawnSpeed = speed;
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
  return car;
}

function stepBarrier(car: DeformableCar, dt: number, yaw = 0): void {
  if (!car.deform.massActive) car.integrate(dt);
  else car.syncPose(dt);
  car.refreshBasis();
  clipCarToBarrier(car, yaw, ORIGIN, BARRIER_HALF.x, leftoverCrumple(car.deform.crumpleTravelCorner()));
  const crushHit = satCarBarrier(car, yaw, ORIGIN, BARRIER_HALF.x, _cn, _cp, car.crushHulls());
  const overlap = satCarBarrier(car, yaw, ORIGIN, BARRIER_HALF.x, _n, _p, car.hulls());
  if (!crushHit && !overlap) return;
  car.deform.notifyContact();
  const n = crushHit ? _cn : _n;
  const p = crushHit ? _cp : _p;
  const closing = -car.velocity.dot(n);
  if (closing > 0.2 && (crushHit ?? overlap ?? 0) > 0.004 && !car.crashed) {
    car.applyImpact(p.clone(), n.clone(), closing);
  }
  if (crushHit && crushHit > 0 && car.deform.massActive) {
    car.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
  }
  if (overlap) {
    const leftover = leftoverCrumple(car.deform.crumpleTravelCorner());
    const incoming = Math.max(0, -car.velocity.dot(_n)) * dt;
    const maxPen = car.deform.massActive ? leftover * 0.4 : 0.015;
    const extra = Math.max(0, overlap - maxPen);
    const push = car.deform.massActive
      ? Math.min(extra + 0.004, 0.12)
      : Math.min(Math.max(overlap, incoming) + 0.012, 0.22);
    car.group.position.addScaledVector(_n, push);
    car.group.updateMatrixWorld();
    car.refreshBasis();
    if (!car.deform.massActive) car.deform.bindKinematic(car.group, car.velocity, car.angular);
    if (closing > 0.3 && leftover > 0.05) {
      car.velocity.addScaledVector(_n, closing * leftover * 0.35);
    }
  }
  clipCarToBarrier(car, yaw, ORIGIN, BARRIER_HALF.x, leftoverCrumple(car.deform.crumpleTravelCorner()));
  if (car.deform.massActive) {
    car.deform.stepStructure(dt);
    car.syncPose(dt);
    car.updateDeform(dt);
  }
}

function runFor(car: DeformableCar, simSec: number, frameDt: number): void {
  let t = 0;
  while (t < simSec) {
    const h = physicsSlice(Math.min(frameDt, simSec - t), car.speed);
    stepBarrier(car, h);
    t += h;
  }
}

describe("jersey barrier full-speed vs slomo", () => {
  it("good: a 22 m/s full-speed hit does not tunnel through the slab", () => {
    const car = spawnAtBarrier(0, 22, "shape");
    runFor(car, 0.55, 1 / 60);
    assert.ok(car.group.position.x > 0.45, `tunneled to x=${car.group.position.x.toFixed(3)}`);
    assert.equal(car.crashed, true);
  });

  it("good: slomo (tiny wall frames) also stops on the slab", () => {
    const car = spawnAtBarrier(0, 22, "shape");
    runFor(car, 0.55, 1 / 240);
    assert.ok(car.group.position.x > 0.45, `slomo tunneled to x=${car.group.position.x.toFixed(3)}`);
    assert.equal(car.crashed, true);
  });

  it("close-but-wrong: full-speed and slomo leave the nose on the same side of the wall", () => {
    const fast = spawnAtBarrier(0, 22, "shape");
    const slow = spawnAtBarrier(0, 22, "shape");
    runFor(fast, 0.5, 1 / 60);
    runFor(slow, 0.5, 1 / 240);
    assert.ok(fast.group.position.x > 0.45 && slow.group.position.x > 0.45);
    const dz = Math.abs(
      mass(fast, "bumperFL").local.z + mass(fast, "bumperFR").local.z
        - (mass(slow, "bumperFL").local.z + mass(slow, "bumperFR").local.z),
    );
    assert.ok(dz < 0.55, `slomo/full crush diverged Δz=${dz.toFixed(3)}`);
  });

  it("good: an offset +Z hit crushes the corner that is actually on the slab", () => {
    const car = spawnAtBarrier(1.88, 20, "shape");
    runFor(car, 0.5, 1 / 60);
    const fl = mass(car, "bumperFL").local.z;
    const fr = mass(car, "bumperFR").local.z;
    const hit = car.deform.impactLocal;
    // yaw=-π/2: right is +Z, so FR hangs off the +Z end of the jersey; FL is on the slab.
    assert.ok(
      fl < fr - 0.04,
      `wrong corner FL.z=${fl.toFixed(3)} FR.z=${fr.toFixed(3)} impactLocal=(${hit.x.toFixed(2)},${hit.z.toFixed(2)})`,
    );
    assert.ok(hit.x < -0.2, `contact sat on the centerline x=${hit.x.toFixed(2)}`);
  });

  it("bad: lattice full-speed must not pass through either", () => {
    const car = spawnAtBarrier(0, 22, "lattice");
    runFor(car, 0.55, 1 / 60);
    assert.ok(car.group.position.x > 0.4, `lattice tunneled x=${car.group.position.x.toFixed(3)}`);
  });
});

/**
 * ESV 98S3P12: a rigid full-width barrier overloads the front above ~50 km/h.
 * The block sits at the nose, so a tail-first hit has to cross the cabin first
 * and the same travel only kills around ~80 km/h.
 */
const FRONT_DISABLE_MPS = 50 / 3.6;
const REAR_DISABLE_MPS = 80 / 3.6;

describe("engine disable speeds", () => {
  it("good: frontal wall under 50 km/h leaves the car driveable", () => {
    const car = spawnAtBarrier(0, FRONT_DISABLE_MPS * 0.7, "shape");
    runFor(car, 1.3, 1 / 60);
    assert.equal(car.deform.drivetrainAlive, true, "35 km/h wall should not kill the block");
  });

  it("good: frontal wall over 50 km/h kills the engine", () => {
    const car = spawnAtBarrier(0, FRONT_DISABLE_MPS * 1.25, "shape");
    runFor(car, 1.5, 1 / 60);
    assert.equal(car.deform.drivetrainAlive, false, "62 km/h wall should kill the block");
  });

  it("good: backing into the wall well under 80 km/h does not kill the block", () => {
    const speed = REAR_DISABLE_MPS * 0.5;
    const car = spawnAtBarrier(0, speed, "shape");
    car.yaw = Math.PI / 2;
    car.group.rotation.set(0, car.yaw, 0, "YXZ");
    car.refreshBasis();
    car.velocity.set(-speed, 0, 0);
    car.deform.bindKinematic(car.group, car.velocity, car.angular);
    runFor(car, 1.3, 1 / 60);
    assert.equal(car.deform.drivetrainAlive, true, "40 km/h tail-first wall should still drive");
  });
});
