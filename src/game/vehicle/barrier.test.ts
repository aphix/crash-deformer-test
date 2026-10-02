import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { physicsSlice } from "../contact/sat.ts";
import type { DeformMode } from "../deform/deform-rig.ts";
import { mass, paint } from "./test-support.ts";
import { makeCar, makeWorld, runWall, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { CLASSES, VEHICLE_CLASS_IDS } from "./vehicle-classes.ts";
import { stepWorld } from "../engine/world-step.ts";

/** Engine-block travel toward the cabin at rest after a hit (m). */
function blockTravel(car: DeformableCar): number {
  return Math.max(mass(car.deform, "engineL").rest.z - mass(car.deform, "engineL").local.z, mass(car.deform, "engineR").rest.z - mass(car.deform, "engineR").local.z);
}

/** Nose-to-block length (m): 0.84 at rest, 0.54 packed (ENGINE_PACK_GAP: beam and radiator flat ahead of the block). */
function noseGap(car: DeformableCar): number {
  const d = car.deform;
  return Math.min(mass(d, "bumperFL").local.z, mass(d, "bumperFR").local.z) - Math.max(mass(d, "engineL").local.z, mass(d, "engineR").local.z);
}

// Owner's crumple model: a zone with stroke left absorbs the hit; one crushed to its packed length
// absorbs nothing more and passes the load to the next node (the block), so damage accumulates.
// Each runs at main's squash 0.4 and the calibrated 0.32 (lane/calib-defaults).
const SQUASHES = [0.4, 0.32];

describe("crumple absorbs while it has stroke, then passes the load on [shape]", () => {
  it("good: the block stays on its mounts until the nose has packed against it (20–43 km/h)", () => {
    for (const squash of SQUASHES) {
      for (const kph of [20, 25, 30, 35, 40, 43]) {
        const car = makeCar("shape", squash);
        runWall(kph, 1, "front", { car });
        if (noseGap(car) > 0.56) assert.ok(blockTravel(car) <= 0.045, `squash ${squash}, ${kph} km/h: block moved ${blockTravel(car).toFixed(4)} m with ${noseGap(car).toFixed(3)} m of nose left`);
      }
    }
  });

  // Fixture: the slowest hit that packs the nose at both squashes (52 km/h; 50 left 0.547 m at 0.32). A
  // wreck resting on the slab used to sit 0.47 m nose-to-block after the second hit: the face pushed the
  // bumpers back after the clamp's pack rule, so the packed nose crushed past its packed length.
  it("bad: a nose packed by a 52 km/h hit takes nothing of the next 35 km/h hit; the block does", () => {
    for (const squash of SQUASHES) {
      const car = makeCar("shape", squash);
      runWall(52, 1, "front", { car });
      const gap = noseGap(car);
      const block = blockTravel(car);
      assert.ok(gap <= 0.545, `squash ${squash} fixture: 52 km/h left ${gap.toFixed(3)} m of nose, not packed to 0.54`);
      runWall(35, 1, "front", { car });
      assert.ok(gap - noseGap(car) < 0.02, `squash ${squash}: the packed nose shortened ${(gap - noseGap(car)).toFixed(3)} m more`);
      assert.ok(blockTravel(car) - block > 0.04, `squash ${squash}: the block took ${(blockTravel(car) - block).toFixed(3)} m of the second hit`);
    }
  });

  // Basis: rearmHit adds each hit's EBS² to the struck end (a linear spring's energy), so n hits at v
  // carry one hit's energy at v·√n: two 35s ≈ 49.5 km/h, under the 52–54 km/h single-hit kill, three
  // ≈ 60.6 km/h, past it. Was hit 4 at squash 0.32 and hit 2 at 0.4 (geometric re-hit peaks).
  it("bad: repeated 35 km/h wall hits keep moving the block back and kill it on the third, at either squash", () => {
    for (const squash of SQUASHES) {
      const car = makeCar("shape", squash);
      const travel: number[] = [];
      let killedAt = 0;
      for (let k = 1; k <= 4; k++) {
        runWall(35, 1, "front", { car });
        travel.push(blockTravel(car));
        if (!car.deform.drivetrainAlive && !killedAt) killedAt = k;
      }
      const row = travel.map((t) => t.toFixed(3)).join(" ");
      for (let k = 1; k < travel.length; k++) assert.ok(travel[k]! >= travel[k - 1]! - 0.005, `squash ${squash}: block travel by hit ${row}`);
      assert.equal(killedAt, 3, `squash ${squash}: killed at hit ${killedAt || "never"}; block travel by hit ${row}`);
    }
  });

  it("good: one hit at two 35s' energy (49.5 km/h) leaves the block alive and one at three's (60.6 km/h) kills it, at either squash", () => {
    for (const squash of SQUASHES) {
      const alive = (kph: number) => {
        const car = makeCar("shape", squash);
        runWall(kph, 1, "front", { car });
        return car.deform.drivetrainAlive;
      };
      const [a, b] = [alive(49.5), alive(60.6)];
      assert.ok(a && !b, `squash ${squash}: 49.5 km/h alive ${a}, 60.6 km/h alive ${b}`);
    }
  });
});

/** Jersey slab along Z, thin in X. Car drives -X into the +X face. */
function spawnAtBarrier(z: number, speed: number, mode: DeformMode): DeformableCar {
  const scene = new THREE.Scene();
  const car = new DeformableCar(paint(), scene);
  car.deform.setMode(mode);
  car.group.position.set(6.2, 0, z);
  car.group.rotation.set(0, -Math.PI / 2, 0, "YXZ");
  car.refreshBasis();
  car.velocity.set(-speed, 0, 0);
  car.speed = speed;
  car.spawnSpeed = speed;
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
  return car;
}

/** `simSec` of the engine's step against the held slab, in steps of at most `frameDt` (tiny wall frames are slomo). */
function runFor(car: DeformableCar, simSec: number, frameDt: number): void {
  const w = makeWorld([car], true, false).world;
  let t = 0;
  while (t < simSec) {
    const h = physicsSlice(Math.min(frameDt, simSec - t), car.speed);
    stepWorld(w, h);
    car.updateDeform(h);
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
 * The fastest a driven car goes: every class's top speed × its boost top (200 km/h). A t-bone into a parked car
 * at 57–80 m/s ground the bullet through the struck car's side within 0.5 s (up to 7 m past); from 54 m/s about
 * one contact phase in eight does (none of 8 at 20–53 m/s): resolveCarPair's per-slice impulse cap shoves the
 * struck car at only ~10–15 m/s², so the bullet's leftover closing grinds on. Upgrade path: car-car through
 * external-contact's bodyContact (CONTACT_PARITY.md).
 */
const DRIVEN_TOP = Math.max(...VEHICLE_CLASS_IDS.map((id) => CLASSES[id].topSpeed * CLASSES[id].boostTop));
const TBONE_TODO = "pair contact: ~1 in 8 contact phases grinds through from 54 m/s (see DRIVEN_TOP)";

describe("no pass-through at the top driven speed", () => {
  it(`good: a ${(DRIVEN_TOP * 3.6).toFixed(0)} km/h hit stops on the slab, shape and lattice`, () => {
    for (const mode of ["shape", "lattice"] as const) {
      const car = spawnAtBarrier(0, DRIVEN_TOP, mode);
      runFor(car, 0.55, 1 / 60);
      assert.ok(car.group.position.x > 0.4, `${mode} tunneled to x=${car.group.position.x.toFixed(3)}`);
    }
  });

  for (const kind of ["head-on", "t-bone"] as const) {
    it(`good: a ${kind} at ${(DRIVEN_TOP * 3.6).toFixed(0)} km/h${kind === "head-on" ? " each" : " into a parked car"} never carries one car through the other, whatever slice the contact lands in`, { todo: kind === "t-bone" ? TBONE_TODO : undefined }, () => {
      // Along X: a heads +X from the left (head-on) or sits broadside at the origin (t-bone); b heads −X from the
      // right. b's start steps through 0.24 m (one 1/240 s slice at top speed) so contact lands at every phase.
      for (let start = 6; start < 6.24; start += 0.04) {
        const a = makeCar();
        const b = makeCar();
        a.spawnFacing(kind === "head-on" ? -6 : 0, 0, kind === "head-on" ? Math.PI / 2 : 0, 0);
        a.velocity.set(kind === "head-on" ? DRIVEN_TOP : 0, 0, 0);
        a.speed = a.velocity.length();
        b.spawnFacing(start, 0, -Math.PI / 2, 0);
        b.velocity.set(-DRIVEN_TOP, 0, 0);
        b.speed = DRIVEN_TOP;
        const w = makeWorld([a, b], false, false);
        let worst = Infinity;
        for (let f = 0; f < 90; f++) {
          tickWorld(w);
          worst = Math.min(worst, b.group.position.x - a.group.position.x);
        }
        assert.ok(worst > 0, `from x=${start.toFixed(2)}: b's origin crossed a's along the hit by ${(-worst).toFixed(2)} m`);
      }
    });
  }
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
