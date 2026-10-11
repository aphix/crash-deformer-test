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
  regionSoftness,
  crushGate,
  dtImpulseScale,
  closingKeScale,
  forceTransfer,
  regionCrushBands,
  leftoverPass,
  TRANSFER,
  satPushCap,
  hypot2,
  hypot3,
} from "./physics-util.ts";
import { separateSphereFromBounds } from "./physics-util.test-util.ts";

describe("given the CRASH constants (the tuned crash-physics numbers, researched for a sedan and from NCAP crash tests)", () => {
  it("when the pulse length, crush distance and tyre friction values are read, then they sit in the published bands (pulse 0.09–0.16 s, crush 0.45–0.75 m, friction 0.9 at peak, 0.75 sliding, 0.4 scuffing)", () => {
    assert.ok(CRASH.pulseSec >= 0.09 && CRASH.pulseSec <= 0.16);
    assert.ok(CRASH.crushMeters >= 0.45 && CRASH.crushMeters <= 0.75);
    assert.equal(CRASH.muPeak, 0.9);
    assert.equal(CRASH.muSlide, 0.75);
    assert.equal(CRASH.muScuff, 0.4);
  });

  it("when the scuff, slide and peak tyre-friction values are compared, then a scuffing tyre is slipperier than a sliding one, which is slipperier than peak grip", () => {
    assert.ok(CRASH.muScuff < CRASH.muSlide, "scuff must be slippier than a sliding tire");
    assert.ok(CRASH.muSlide < CRASH.muPeak);
  });

  it("when the graze cutoff and the top mass speed are read, then the graze cutoff is between 1 and 3 m/s (above walking speed, below a parking-lot bump) and the top speed is between 40 and 80 m/s", () => {
    assert.ok(CRASH.grazeMps > 1 && CRASH.grazeMps < 3);
    assert.ok(CRASH.maxMassMps > 40 && CRASH.maxMassMps < 80);
  });

  it("when the crush distance is compared with the 1.5 m full leftover zone, then the two differ, a full 1.5 m zone reads fully left over and a crush-distance-long zone reads under half", () => {
    // leftoverCrumple uses /1.5 because rest nose-cell is ~1.6m. Using crushMeters as
    // that divisor would saturate leftover to 1 after only 0.65m of remaining length.
    assert.notEqual(CRASH.crushMeters, 1.5);
    assert.ok(leftoverCrumple(1.5) === 1);
    assert.ok(leftoverCrumple(CRASH.crushMeters) < 0.5);
  });
});

describe("given clampSpeed (limits a velocity to the top speed a part of the car may have)", () => {
  it("when it is given a NaN velocity, a 1e6 m/s velocity and a 20 m/s velocity, then the NaN one is zeroed, the huge one is cut to the top speed and the 20 m/s crash speed is kept", () => {
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

describe("given leftoverCrumple (the fraction of the crush zone still unused, from the remaining nose length in metres)", () => {
  it("when the remaining length is 1.5 m or 0 m, then a full zone reads 1 and no remaining length reads 0", () => {
    assert.equal(leftoverCrumple(1.5), 1);
    assert.equal(leftoverCrumple(0), 0);
  });

  it("when the remaining length is 1.5 m, 0.3 m and 1.2 m, then 1.5 m reads 1 and 0.3 m reads less than 1.2 m, so more remaining length is more crumple left", () => {
    assert.equal(leftoverCrumple(1.5), 1);
    assert.ok(leftoverCrumple(0.3) < leftoverCrumple(1.2));
  });

  it("when the remaining length is negative or oversize, then the fraction clamps to 0 or 1 instead of becoming NaN", () => {
    assert.equal(leftoverCrumple(-4), 0);
    assert.equal(leftoverCrumple(99), 1);
  });

  it("when the remaining length is 1.499 m, then the fraction reads just under 1 (above 0.99) instead of rounding up to a full zone", () => {
    const a = leftoverCrumple(1.499);
    assert.ok(a < 1 && a > 0.99, `got ${a}`);
  });
});

describe("given hypot2 and hypot3 (two- and three-term vector lengths that replays and contact digests depend on)", () => {
  it("when they are compared with Math.hypot over special values (signs, ±0, NaN, Infinity, extremes) and 20000 seeded random triples, then every result is bit-identical to Math.hypot's", () => {
    const special = [0, -0, 1, -1, 3, 4, 1e-300, 5e-324, 1.7e308, -1.7e308, Infinity, -Infinity, NaN, 0.1, 1 / 3];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 10 ** ((seed % 13) - 6);
    };
    const cases: number[][] = [];
    for (const a of special) for (const b of special) cases.push([a, b, special[(cases.length * 7) % special.length]!]);
    for (let i = 0; i < 20000; i++) cases.push([rnd(), rnd(), rnd()]);
    for (const [a, b, c] of cases) {
      assert.ok(Object.is(hypot2(a!, b!), Math.hypot(a!, b!)), `hypot2(${a}, ${b}) ${hypot2(a!, b!)} vs ${Math.hypot(a!, b!)}`);
      assert.ok(Object.is(hypot3(a!, b!, c!), Math.hypot(a!, b!, c!)), `hypot3(${a}, ${b}, ${c}) ${hypot3(a!, b!, c!)} vs ${Math.hypot(a!, b!, c!)}`);
    }
  });
});

describe("given applyGroundFriction (slows the ground-plane part of a velocity by Coulomb friction)", () => {
  it("when a car moving 10 m/s along x and 3 m/s up slides for 0.1 s with friction coefficient 1, then its ground speed drops by μ·g·dt = 0.981 m/s and its vertical speed is unchanged", () => {
    const v = new THREE.Vector3(10, 3, 0);
    applyGroundFriction(v, 0.1, 1, true);
    // drop = 1 * 9.81 * 0.1 = 0.981, speed was 10
    assert.ok(Math.abs(v.x - (10 * (10 - 0.981)) / 10) < 1e-6);
    assert.equal(v.y, 3);
    assert.equal(v.z, 0);
  });

  it("when the car is airborne, or the time step is zero, then its velocity is left unchanged", () => {
    const a = new THREE.Vector3(5, 1, 2);
    applyGroundFriction(a, 0.2, 0.9, false);
    assert.deepEqual({ x: a.x, y: a.y, z: a.z }, { x: 5, y: 1, z: 2 });
    const b = new THREE.Vector3(5, 1, 2);
    applyGroundFriction(b, 0, 0.9, true);
    assert.deepEqual({ x: b.x, y: b.y, z: b.z }, { x: 5, y: 1, z: 2 });
  });

  it("when the ground speed is below the stopping threshold, then the ground-plane speed is zeroed and the vertical speed is kept", () => {
    const v = new THREE.Vector3(1e-6, -4, -1e-6);
    applyGroundFriction(v, 0.016, 0.75, true);
    assert.equal(v.x, 0);
    assert.equal(v.z, 0);
    assert.equal(v.y, -4);
  });

  it("when a car moving 8 m/s up and 6 m/s along the ground slides for 1/60 s with sliding friction, then only its ground speed drops (to between 5.8 and 6 m/s) and its vertical speed stays 8", () => {
    const v = new THREE.Vector3(0, 8, 6);
    applyGroundFriction(v, 1 / 60, CRASH.muSlide, true);
    assert.equal(v.y, 8);
    assert.ok(v.z < 6 && v.z > 5.8);
  });
});

describe("given round4 (rounds a number to four decimals, halves upward)", () => {
  it("when 1.23444 and 1.23445 are rounded, then they give 1.2344 and 1.2345", () => {
    assert.equal(round4(1.23444), 1.2344);
    assert.equal(round4(1.23445), 1.2345);
  });
});

describe("given vec3 (snapshots a vector as plain x, y, z numbers rounded to four decimals)", () => {
  it("when a vector (0.12345, -2, 8) is snapshotted, then it gives x 0.1235, y -2 and z 8", () => {
    assert.deepEqual(vec3(new THREE.Vector3(0.12345, -2, 8)), { x: 0.1235, y: -2, z: 8 });
  });
});

describe("given snapshotPoints (turns particle position and life arrays into the list of live particles, up to a cap)", () => {
  it("when two of three particles are alive but the cap is 1, then it reports only the first live particle, with its x and remaining life", () => {
    const r = snapshotPoints([1, 2, 3], [4, 5, 6], [7, 8, 9], [0.2, 0, 0.9], false, 1);
    assert.equal(r.count, 1);
    assert.equal(r.items[0]!.x, 1);
    assert.equal(r.items[0]!.life, 0.2);
  });

  it("when the positions come packed as interleaved x, y, z values, then the particles read as (10, 20, 30) and x 40, not as parallel arrays", () => {
    const r = snapshotPoints([10, 20, 30, 40, 50, 60], null, null, [1, 1], true, 8);
    assert.equal(r.items[0]!.x, 10);
    assert.equal(r.items[0]!.y, 20);
    assert.equal(r.items[0]!.z, 30);
    assert.equal(r.items[1]!.x, 40);
  });

  it("when every particle is dead, then the count is 0 and the item list is empty", () => {
    const r = snapshotPoints([1], [2], [3], [0], false, 16);
    assert.equal(r.count, 0);
    assert.equal(r.items.length, 0);
  });

  it("when two packed particles are given and only the second is alive, then it reads at (9, 8, 7), the index counted in steps of three", () => {
    const r = snapshotPoints([1, 2, 3, 9, 8, 7], null, null, [0, 1], true, 8);
    assert.equal(r.count, 1);
    assert.equal(r.items[0]!.x, 9);
    assert.equal(r.items[0]!.y, 8);
    assert.equal(r.items[0]!.z, 7);
  });
});

describe("given separateSphereFromBounds (push a sphere out of a wall limit on one axis)", () => {
  it("when a 0.2 m sphere past the +0.62 wall limit is moving in at 3 m/s, then it is pushed back inside the limit, its inbound speed is cancelled and a hit is reported", () => {
    const pos = new THREE.Vector3(0, 0.4, 0.9);
    const vel = new THREE.Vector3(0, 0, 3);
    assert.equal(separateSphereFromBounds(pos, vel, 0.2, "z", -0.62, 0.62), true);
    assert.ok(pos.z <= 0.62 - 0.2 + 1e-9);
    assert.equal(vel.z, 0);
  });

  it("when a sphere past the -0.62 limit is already moving out at 2 m/s, then its outward speed is kept, not reversed into a bounce launch", () => {
    const pos = new THREE.Vector3(0, 0.4, -0.9);
    const vel = new THREE.Vector3(0, 0, 2);
    separateSphereFromBounds(pos, vel, 0.2, "z", -0.62, 0.62);
    assert.ok(vel.z > 0, "killed the remaining forward speed");
  });

  it("when the sphere is already inside the gap between the limits, then no hit is reported and its position and velocity are untouched", () => {
    const pos = new THREE.Vector3(0, 0.4, 0);
    const vel = new THREE.Vector3(1, 0, -1);
    assert.equal(separateSphereFromBounds(pos, vel, 0.2, "z", -0.62, 0.62), false);
    assert.equal(pos.z, 0);
    assert.equal(vel.z, -1);
  });
});

describe("given a sedan's crash zones (soft bumper and rails over a rigid high-strength-steel cabin cage)", () => {
  it("when each region's softness is compared, then the bumper is more than 0.6 softer than the cabin, the rail is softer than the roof, the wheel hub is under 0.15 and the engine is between the rail and the cabin", () => {
    assert.ok(regionSoftness("bumperFL") > regionSoftness("cell") + 0.6);
    assert.ok(regionSoftness("railL") > regionSoftness("roof"));
    assert.ok(regionSoftness("hubFL") < 0.15);
    assert.ok(regionSoftness("engineL") < regionSoftness("railL"));
    assert.ok(regionSoftness("engineL") > regionSoftness("cell"));
  });

  it("when a 5 m/s tap hits, then the cabin does not yield at all but the bumper may yield a little", () => {
    assert.equal(crushGate(5, regionSoftness("cell")), 0);
    assert.ok(crushGate(5, regionSoftness("bumperFL")) > 0);
  });

  it("when the closing speed is 20 m/s instead of 5 m/s, then the energy scale is more than 8 times larger and a 1/240 s step gets under 30 % of the impulse scale of a 1/60 s step", () => {
    assert.ok(closingKeScale(20) > closingKeScale(5) * 8);
    assert.ok(dtImpulseScale(1 / 240) < dtImpulseScale(1 / 60) * 0.3);
  });
});

describe("given force transfer bands (the crush distances at which a region passes more of a hit on to the cabin)", () => {
  it("when the bumper's bands are compared with the cabin's, then the bumper's max is over twice the cabin's, its middle is larger, and its yield lies below its middle and its middle below its max", () => {
    const bumper = regionCrushBands("bumperFL");
    const cell = regionCrushBands("cell");
    assert.ok(bumper.max > cell.max * 2);
    assert.ok(bumper.middle > cell.middle);
    assert.ok(bumper.yield < bumper.middle && bumper.middle < bumper.max);
  });

  it("when the crush is read at rest, just under the middle, at the middle, just under the max, at the max, and packed, then the transfer steps 0.1, 0.1, 0.5, 0.5, 0.62, and 1 when packed", () => {
    const b = regionCrushBands("bumperFL");
    assert.equal(forceTransfer(0, b, false), TRANSFER.belowMiddle);
    assert.equal(forceTransfer(b.middle - 1e-4, b, false), TRANSFER.belowMiddle);
    assert.equal(forceTransfer(b.middle, b, false), TRANSFER.atMiddle);
    assert.equal(forceTransfer(b.max - 1e-4, b, false), TRANSFER.atMiddle);
    assert.equal(forceTransfer(b.max, b, false), TRANSFER.above);
    assert.equal(forceTransfer(0, b, true), TRANSFER.packed);
    assert.equal(forceTransfer(b.max * 4, b, true), TRANSFER.packed);
  });

  it("when a region is packed (fully compressed), then all of the force goes through (1), while an unpacked region at max crush passes less than that", () => {
    const b = regionCrushBands("railL");
    assert.equal(forceTransfer(0, b, true), 1);
    assert.ok(forceTransfer(b.max, b, false) < 1);
  });

  it("when the crush is just under the middle (0.999 of it), then the transfer is the 0.1 step, and exactly at the middle it is the 0.5 step", () => {
    const b = regionCrushBands("wingFL");
    assert.equal(forceTransfer(b.middle * 0.999, b, false), TRANSFER.belowMiddle);
    assert.equal(forceTransfer(b.middle, b, false), TRANSFER.atMiddle);
  });
});

describe("given leftoverPass (the share of the closing speed that a crushed region passes on, by transfer step)", () => {
  it("when 20 m/s of closing meets each transfer step, then it passes 2 below the middle, 10 at the middle, 12.4 above the max and all 20 when packed", () => {
    assert.equal(leftoverPass(20, TRANSFER.belowMiddle), 2);
    assert.equal(leftoverPass(20, TRANSFER.atMiddle), 10);
    assert.equal(leftoverPass(20, TRANSFER.above), 12.4);
    assert.equal(leftoverPass(20, TRANSFER.packed), 20);
  });

  it("when the remaining closing is negative, then nothing is passed on, so there is no rebound impulse", () => {
    assert.equal(leftoverPass(-8, 1), 0);
  });

  it("when the transfer fraction is 1 versus 0.1, then the larger fraction passes more, and a fraction of 2 passes at most the full 10 m/s", () => {
    assert.ok(leftoverPass(10, 1) > leftoverPass(10, 0.1));
    assert.equal(leftoverPass(10, 2), 10);
  });
});

describe("given satPushCap (the cap on one step's push), where slow motion must not rocket the cars", () => {
  it("when the step is 1/240 s instead of 1/60 s, then the push cap is under 35 % of the 1/60 s step's", () => {
    assert.ok(satPushCap(1 / 240) < satPushCap(1 / 60) * 0.35);
  });
});
