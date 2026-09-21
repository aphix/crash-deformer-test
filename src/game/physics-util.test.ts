import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  CRASH,
  applyGroundFriction,
  leftoverCrumple,
  round4,
  snapshotPoints,
  vec3,
  clampSpeed,
  separateSphereFromAabb,
  separateSphereFromBounds,
  regionSoftness,
  crushGate,
  dtImpulseScale,
  closingKeScale,
  forceTransfer,
  regionCrushBands,
  leftoverPass,
  TRANSFER,
  cancelClosing,
  satPushCap,
} from "./physics-util.ts";

describe("CRASH constants (researched sedan / NCAP)", () => {
  it("good: pulse, crush, and tire μ sit in the published bands", () => {
    assert.ok(CRASH.pulseSec >= 0.09 && CRASH.pulseSec <= 0.16);
    assert.ok(CRASH.crushMeters >= 0.45 && CRASH.crushMeters <= 0.75);
    assert.equal(CRASH.muPeak, 0.9);
    assert.equal(CRASH.muSlide, 0.75);
    assert.equal(CRASH.muScuff, 0.4);
  });

  it("bad: crumple is not a bounce — restitution of the structure is not baked into μ", () => {
    assert.ok(CRASH.muScuff < CRASH.muSlide, "scuff must be slippier than a sliding tire");
    assert.ok(CRASH.muSlide < CRASH.muPeak);
  });

  it("edge: graze cutoff is above walking speed and below a parking-lot bump", () => {
    assert.ok(CRASH.grazeMps > 1 && CRASH.grazeMps < 3);
    assert.ok(CRASH.maxMassMps > 40 && CRASH.maxMassMps < 80);
  });

  it("close-but-wrong: crushMeters is remaining-zone scale (~0.65m), not the 1.5m leftover divisor", () => {
    // leftoverCrumple uses /1.5 because rest nose-cell is ~1.6m. Using crushMeters as
    // that divisor would saturate leftover to 1 after only 0.65m of remaining length.
    assert.notEqual(CRASH.crushMeters, 1.5);
    assert.ok(leftoverCrumple(1.5) === 1);
    assert.ok(leftoverCrumple(CRASH.crushMeters) < 0.5);
  });
});

describe("clampSpeed", () => {
  it("bad: NaN and 1e6 m/s both die, a 20 m/s crash speed is kept", () => {
    const a = new THREE.Vector3(Number.NaN, 0, 4);
    clampSpeed(a);
    assert.equal(a.length(), 0);
    const b = new THREE.Vector3(0, 0, 1e6);
    clampSpeed(b);
    assert.ok(Math.abs(b.length() - CRASH.maxMassMps) < 1e-6);
    const c = new THREE.Vector3(0, 0, 20);
    clampSpeed(c);
    assert.equal(c.z, 20);
  });
});

describe("leftoverCrumple", () => {
  it("good: 1 at a full zone, 0 when the cabin is on the cabin", () => {
    assert.equal(leftoverCrumple(1.5), 1);
    assert.equal(leftoverCrumple(0), 0);
  });

  it("bad: inverted leftover (1 - travel/1.5) would read 0 at rest-scale 1.5", () => {
    assert.equal(leftoverCrumple(1.5), 1);
    assert.ok(leftoverCrumple(0.3) < leftoverCrumple(1.2));
  });

  it("edge: negatives and oversize values clamp, not NaN", () => {
    assert.equal(leftoverCrumple(-4), 0);
    assert.equal(leftoverCrumple(99), 1);
  });

  it("close-but-wrong: 1.499 is not yet a full zone (strict /1.5, not round-to-1)", () => {
    const a = leftoverCrumple(1.499);
    assert.ok(a < 1 && a > 0.99, `got ${a}`);
  });
});

describe("applyGroundFriction", () => {
  it("good: Coulomb drop is μ g dt on XZ", () => {
    const v = new THREE.Vector3(10, 3, 0);
    applyGroundFriction(v, 0.1, 1, true);
    // drop = 1 * 9.81 * 0.1 = 0.981, speed was 10
    assert.ok(Math.abs(v.x - (10 * (10 - 0.981)) / 10) < 1e-6);
    assert.equal(v.y, 3);
    assert.equal(v.z, 0);
  });

  it("bad: airborne or dt<=0 must not bleed speed", () => {
    const a = new THREE.Vector3(5, 1, 2);
    applyGroundFriction(a, 0.2, 0.9, false);
    assert.deepEqual({ x: a.x, y: a.y, z: a.z }, { x: 5, y: 1, z: 2 });
    const b = new THREE.Vector3(5, 1, 2);
    applyGroundFriction(b, 0, 0.9, true);
    assert.deepEqual({ x: b.x, y: b.y, z: b.z }, { x: 5, y: 1, z: 2 });
  });

  it("edge: sub-threshold speed zeros XZ only", () => {
    const v = new THREE.Vector3(1e-6, -4, -1e-6);
    applyGroundFriction(v, 0.016, 0.75, true);
    assert.equal(v.x, 0);
    assert.equal(v.z, 0);
    assert.equal(v.y, -4);
  });

  it("close-but-wrong: friction must not scale Y (a 3D Coulomb would sink the car)", () => {
    const v = new THREE.Vector3(0, 8, 6);
    applyGroundFriction(v, 1 / 60, CRASH.muSlide, true);
    assert.equal(v.y, 8);
    assert.ok(v.z < 6 && v.z > 5.8);
  });
});

describe("round4 / vec3 / snapshotPoints", () => {
  it("good: round4 is half-up at 1e-4", () => {
    assert.equal(round4(1.23444), 1.2344);
    assert.equal(round4(1.23445), 1.2345);
  });

  it("good: vec3 snapshots a THREE vector", () => {
    assert.deepEqual(vec3(new THREE.Vector3(0.12345, -2, 8)), { x: 0.1235, y: -2, z: 8 });
  });

  it("good: unpacked snapshot skips dead particles and honors cap", () => {
    const r = snapshotPoints([1, 2, 3], [4, 5, 6], [7, 8, 9], [0.2, 0, 0.9], false, 1);
    assert.equal(r.count, 1);
    assert.equal(r.items[0]!.x, 1);
    assert.equal(r.items[0]!.life, 0.2);
  });

  it("bad: packed layout is xyz-interleaved, not parallel arrays", () => {
    const r = snapshotPoints([10, 20, 30, 40, 50, 60], null, null, [1, 1], true, 8);
    assert.equal(r.items[0]!.x, 10);
    assert.equal(r.items[0]!.y, 20);
    assert.equal(r.items[0]!.z, 30);
    assert.equal(r.items[1]!.x, 40);
  });

  it("edge: all-dead buffer is empty; cap 0 still reports via items length", () => {
    const r = snapshotPoints([1], [2], [3], [0], false, 16);
    assert.equal(r.count, 0);
    assert.equal(r.items.length, 0);
  });

  it("close-but-wrong: packed index is i*3, so particle 1 is not px[1]", () => {
    const r = snapshotPoints([1, 2, 3, 9, 8, 7], null, null, [0, 1], true, 8);
    assert.equal(r.count, 1);
    assert.equal(r.items[0]!.x, 9);
    assert.equal(r.items[0]!.y, 8);
    assert.equal(r.items[0]!.z, 7);
  });
});

describe("separateSphereFromBounds / Aabb (same response for plates, cars, ground)", () => {
  it("good: a sphere past +hi is projected back and inbound speed dies", () => {
    const pos = new THREE.Vector3(0, 0.4, 0.9);
    const vel = new THREE.Vector3(0, 0, 3);
    assert.equal(separateSphereFromBounds(pos, vel, 0.2, "z", -0.62, 0.62), true);
    assert.ok(pos.z <= 0.62 - 0.2 + 1e-9);
    assert.equal(vel.z, 0);
  });

  it("bad: outbound speed (already leaving the wall) is not reversed into a bounce launch", () => {
    const pos = new THREE.Vector3(0, 0.4, -0.9);
    const vel = new THREE.Vector3(0, 0, 2);
    separateSphereFromBounds(pos, vel, 0.2, "z", -0.62, 0.62);
    assert.ok(vel.z > 0, "killed the remaining forward speed");
  });

  it("edge: already inside the gap is a no-op", () => {
    const pos = new THREE.Vector3(0, 0.4, 0);
    const vel = new THREE.Vector3(1, 0, -1);
    assert.equal(separateSphereFromBounds(pos, vel, 0.2, "z", -0.62, 0.62), false);
    assert.equal(pos.z, 0);
    assert.equal(vel.z, -1);
  });

  it("good: AABB push uses the smallest overlap axis", () => {
    const pos = new THREE.Vector3(0, 0.4, 0.7);
    const vel = new THREE.Vector3(0, 0, -2);
    separateSphereFromAabb(pos, vel, 0.1, 0, 0.4, 0.5, 1, 1, 0.2);
    assert.ok(pos.z >= 0.5 + 0.2 + 0.1 - 1e-6 || pos.z <= 0.5 - 0.2 - 0.1 + 1e-6);
    assert.equal(vel.z, 0);
  });

  it("close-but-wrong: grazing the +Z face of a plate must not also shove X", () => {
    const pos = new THREE.Vector3(0.05, 0.4, 0.71);
    const vel = new THREE.Vector3(1, 0, -1);
    const x0 = pos.x;
    separateSphereFromAabb(pos, vel, 0.1, 0, 0.4, 0.5, 1.8, 1, 0.2);
    assert.equal(pos.x, x0);
  });
});

describe("region yield (sedan crash box vs UHSS cage)", () => {
  it("good: bumper is softer than the cabin", () => {
    assert.ok(regionSoftness("bumperFL") > regionSoftness("cell") + 0.6);
    assert.ok(regionSoftness("railL") > regionSoftness("roof"));
    assert.ok(regionSoftness("hubFL") < 0.15);
  });

  it("bad: a 5 m/s tap must not yield the cabin, but may nick the bumper", () => {
    assert.equal(crushGate(5, regionSoftness("cell")), 0);
    assert.ok(crushGate(5, regionSoftness("bumperFL")) > 0);
  });

  it("close-but-wrong: 20 m/s is not the same KE as 5 m/s", () => {
    assert.ok(closingKeScale(20) > closingKeScale(5) * 8);
    assert.ok(dtImpulseScale(1 / 240) < dtImpulseScale(1 / 60) * 0.3);
  });
});

describe("force transfer bands", () => {
  it("good: bumper middle is farther than cabin middle", () => {
    const bumper = regionCrushBands("bumperFL");
    const cell = regionCrushBands("cell");
    assert.ok(bumper.max > cell.max * 2);
    assert.ok(bumper.middle > cell.middle);
    assert.ok(bumper.yield < bumper.middle && bumper.middle < bumper.max);
  });

  it("good: rest / middle / max / packed match the 0.1 / 0.5 / 0.62 / 1 steps", () => {
    const b = regionCrushBands("bumperFL");
    assert.equal(forceTransfer(0, b, false), TRANSFER.belowMiddle);
    assert.equal(forceTransfer(b.middle - 1e-4, b, false), TRANSFER.belowMiddle);
    assert.equal(forceTransfer(b.middle, b, false), TRANSFER.atMiddle);
    assert.equal(forceTransfer(b.max - 1e-4, b, false), TRANSFER.atMiddle);
    assert.equal(forceTransfer(b.max, b, false), TRANSFER.above);
    assert.equal(forceTransfer(0, b, true), TRANSFER.packed);
    assert.equal(forceTransfer(b.max * 4, b, true), TRANSFER.packed);
  });

  it("bad: packed must not still dissipate — 100% goes through", () => {
    const b = regionCrushBands("railL");
    assert.equal(forceTransfer(0, b, true), 1);
    assert.ok(forceTransfer(b.max, b, false) < 1);
  });

  it("close-but-wrong: just-below-middle is 0.1, not 0.5 (strict < middle)", () => {
    const b = regionCrushBands("wingFL");
    assert.equal(forceTransfer(b.middle * 0.999, b, false), TRANSFER.belowMiddle);
    assert.equal(forceTransfer(b.middle, b, false), TRANSFER.atMiddle);
  });
});

describe("leftoverPass", () => {
  it("good: rest crumple (0.1) eats most of the closing, packed dumps it all", () => {
    assert.equal(leftoverPass(20, TRANSFER.belowMiddle), 2);
    assert.equal(leftoverPass(20, TRANSFER.atMiddle), 10);
    assert.equal(leftoverPass(20, TRANSFER.above), 12.4);
    assert.equal(leftoverPass(20, TRANSFER.packed), 20);
  });

  it("bad: a negative remain is not a rebound impulse", () => {
    assert.equal(leftoverPass(-8, 1), 0);
  });

  it("close-but-wrong: pass is a fraction, not leftover crumple (1 = packed, not 'still a full zone')", () => {
    assert.ok(leftoverPass(10, 1) > leftoverPass(10, 0.1));
    assert.equal(leftoverPass(10, 2), 10);
  });
});

describe("cancelClosing / satPushCap (slomo must not rocket)", () => {
  const inv = 1 / 1500 + 1 / 1500;

  it("good: one 1/60 step cannot reverse more than the remaining closing", () => {
    const j = cancelClosing(20, 1, inv, 1 / 60, 0);
    const dv = j * inv;
    assert.ok(dv <= 20 + 1e-6, `dv ${dv}`);
  });

  it("bad: 1/240 slomo substep is not a full wall hit", () => {
    const slow = cancelClosing(20, TRANSFER.belowMiddle, inv, 1 / 240, 0);
    const fast = cancelClosing(20, TRANSFER.belowMiddle, inv, 1 / 60, 0);
    assert.ok(slow < fast * 0.4, `slomo ${slow} vs 1/60 ${fast}`);
    assert.ok(satPushCap(1 / 240) < satPushCap(1 / 60) * 0.35);
  });

  it("close-but-wrong: rest crumple (0.1) cancels far less than packed (1)", () => {
    const rest = cancelClosing(20, TRANSFER.belowMiddle, inv, 1 / 60, 0);
    const packed = cancelClosing(20, TRANSFER.packed, inv, 1 / 60, 0);
    assert.ok(packed > rest * 5);
  });
});
