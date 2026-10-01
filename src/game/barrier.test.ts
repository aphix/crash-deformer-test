import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { leftoverCrumple } from "./physics-util.ts";
import { BARRIER_HALF, clipCarToBarrier, physicsSlice, satCarBarrier } from "./sat.ts";
import type { DeformMode } from "./streamed-deform.ts";
import { mass, paint } from "./test-support.ts";
import { runWall } from "./crash-scenarios.test-util.ts";

const ORIGIN = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();

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
    car.applyImpact(p.clone(), n.clone(), closing, closing);
  }
  if (crushHit && crushHit > 0 && car.deform.massActive) {
    car.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
  }
  car.deform.projectOutOfBox(ORIGIN.x, ORIGIN.z, BARRIER_HALF.x, BARRIER_HALF.z, yaw);
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
      mass(fast.deform, "bumperFL").local.z + mass(fast.deform, "bumperFR").local.z
        - (mass(slow.deform, "bumperFL").local.z + mass(slow.deform, "bumperFR").local.z),
    );
    assert.ok(dz < 0.55, `slomo/full crush diverged Δz=${dz.toFixed(3)}`);
  });

  it("good: an offset +Z hit crushes the corner that is actually on the slab", () => {
    const car = spawnAtBarrier(1.88, 20, "shape");
    runFor(car, 0.5, 1 / 60);
    const fl = mass(car.deform, "bumperFL").local.z;
    const fr = mass(car.deform, "bumperFR").local.z;
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

/** NCAP/IIHS full-frontal sedan [09]: 0.35–0.55 m dynamic, 0.25–0.45 m permanent, 90–140 ms. */
describe("rigid wall crush matches a sedan", () => {
  const wall56 = runWall(56);

  it("good: a 56 km/h square wall leaves 0.25–0.50 m of permanent nose crush on both corners", () => {
    for (const short of [wall56.noseShortL, wall56.noseShortR]) {
      assert.ok(short >= 0.25 && short <= 0.5, `nose L=${wall56.noseShortL.toFixed(3)} R=${wall56.noseShortR.toFixed(3)}`);
    }
  });

  it("good: no control particle centre ends up past the slab face", () => {
    assert.ok(wall56.maxCentrePastFace <= 0.05, `mass centre ${wall56.maxCentrePastFace.toFixed(3)} m past the face`);
  });

  it("good: the car travels 0.35–0.60 m after contact and the pulse lasts 60–150 ms", () => {
    assert.ok(wall56.comTravel >= 0.35 && wall56.comTravel <= 0.6, `COM travel ${wall56.comTravel.toFixed(3)}`);
    assert.ok(wall56.pulseMs >= 60 && wall56.pulseMs <= 150, `pulse ${wall56.pulseMs.toFixed(0)} ms`);
  });

  it("good: a square hit stays centred — FL and FR shorten within 25 % of each other", () => {
    const lo = Math.min(wall56.noseShortL, wall56.noseShortR);
    const hi = Math.max(wall56.noseShortL, wall56.noseShortR);
    assert.ok(lo >= hi * 0.75, `FL=${wall56.noseShortL.toFixed(3)} FR=${wall56.noseShortR.toFixed(3)}`);
  });

  it("close-but-wrong: crush travel grows with speed (35 < 56 < 80 km/h)", () => {
    const t35 = runWall(35).comTravel;
    const t80 = runWall(80).comTravel;
    assert.ok(t35 < wall56.comTravel && wall56.comTravel < t80, `35=${t35.toFixed(3)} 56=${wall56.comTravel.toFixed(3)} 80=${t80.toFixed(3)}`);
  });

  it("bad: reversing into the wall at 50 km/h crushes the tail, not the nose", () => {
    const r = runWall(50, 1, "rear");
    assert.ok(r.tailShort >= 0.15, `tail ${r.tailShort.toFixed(3)}`);
    assert.ok(Math.max(r.noseShortL, r.noseShortR) <= 0.03, `nose L=${r.noseShortL.toFixed(3)} R=${r.noseShortR.toFixed(3)}`);
  });

  it("good: the tail is softer with a shorter stroke — 0.6–1.0× the 50 km/h nose, cell intact", () => {
    const front = runWall(50);
    const rear = runWall(50, 1, "rear");
    const nose = Math.max(front.noseShortL, front.noseShortR);
    assert.ok(rear.tailShort >= 0.6 * nose && rear.tailShort <= nose, `tail ${rear.tailShort.toFixed(3)} vs nose ${nose.toFixed(3)}`);
    assert.ok(rear.cabinIntrusion < 0.06, `cabin intrusion ${rear.cabinIntrusion.toFixed(3)}`);
  });

  it("good: a 50 km/h side slide dents the door 0.12–0.28 m and leaves both ends", () => {
    const s = runWall(50, 1, "side");
    assert.ok(s.doorMaxL >= 0.12 && s.doorMaxL <= 0.28, `doorL ${s.doorMaxL.toFixed(3)}`);
    assert.ok(Math.max(s.noseShortL, s.noseShortR) < 0.1 && s.tailShort < 0.1, `nose L=${s.noseShortL.toFixed(3)} R=${s.noseShortR.toFixed(3)} tail=${s.tailShort.toFixed(3)}`);
    assert.ok(s.cellShift < 0.12, `cell moved ${s.cellShift.toFixed(3)}`);
  });
});
