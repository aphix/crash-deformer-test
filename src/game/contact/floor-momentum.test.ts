import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CLASSES } from "../vehicle/vehicle-classes.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { holdThrottle, launch, makeCar, makeWorld, Probe, run, tickWorld, type CrashWorld } from "./crash-scenarios.test-util.ts";

const FRAME = 1 / 60;

/** Mass-weighted centroid (x, z) of a car's masses: what they have done. */
function centroid(c: DeformableCar): [number, number] {
  let x = 0;
  let z = 0;
  let m = 0;
  for (const q of c.deform.masses) {
    x += q.world.x * q.mass;
    z += q.world.z * q.mass;
    m += q.mass;
  }
  return [x / m, z / m];
}

describe("the COM-gap floor moves a struck car by its velocity", () => {
  // The calibration's 53 km/h t-bone, coasting: the bullet drives its nose into the resting car's right door.
  it("bad: the struck car reports most of the speed its masses travel at: its centroid's travel over the crash is its reported speed's integral", () => {
    const struck = makeCar();
    const bullet = makeCar();
    launch(struck, 0, 0, 0, 0, 0);
    launch(bullet, 6, 0, -Math.PI / 2, -53 / 3.6, 0);
    const w = makeWorld([struck, bullet], false, false);
    let travel = 0;
    let reported = 0;
    let before = centroid(struck);
    let started = false;
    for (let frame = 0; frame < 60 * 4; frame++) {
      const scale = w.clock.timeScale;
      tickWorld(w);
      const simDt = (FRAME * (scale + w.clock.timeScale)) / 2;
      const after = centroid(struck);
      if (started) {
        travel += Math.hypot(after[0] - before[0], after[1] - before[1]);
        reported += struck.velocity.length() * simDt;
      }
      started ||= struck.crashed;
      before = after;
    }
    assert.ok(travel > 2, `the struck car did not travel (${travel.toFixed(2)} m): the scene is not the shove`);
    assert.ok(reported >= 0.7 * travel, `the struck car travelled ${travel.toFixed(2)} m at a reported ${reported.toFixed(2)} m of speed`);
  });
});

describe("a held throttle is the engine's impulse and no more", () => {
  /** Two 30 km/h cars head-on, both holding the throttle for `pulse` s from first contact. */
  function headOn(pulse: number): { nose: number; engine: number; added: number[] } {
    const a = makeCar();
    const b = makeCar();
    launch(a, -5, 0, Math.PI / 2, 30 / 3.6, 0);
    launch(b, 5, 0, -Math.PI / 2, -30 / 3.6, 0);
    const w = makeWorld([a, b], false, false);
    const added = holdThrottle(w, [a, b], pulse);
    const pa = new Probe(a, new THREE.Vector3(1, 0, 0));
    const pb = new Probe(b, new THREE.Vector3(-1, 0, 0));
    run(w, [pa, pb], 1.5);
    const r = pa.finish();
    return { nose: (r.noseShortL + r.noseShortR) / 2, engine: r.engineTravel, added };
  }

  it("bad: holding the throttle through the 0.12 s pulse adds no more than the first gear's thrust over it, and crushes the noses as a coast does", () => {
    const coast = headOn(0);
    const held = headOn(0.12);
    const thrust = CLASSES.sedan.gears[0]![1];
    for (const dv of held.added) assert.ok(dv > 0 && dv <= thrust * 0.12 * 1.01, `the drive added ${dv.toFixed(2)} m/s over 0.12 s (first gear ${thrust} m/s²)`);
    assert.ok(Math.abs(held.nose - coast.nose) <= Math.max(0.03, 0.15 * coast.nose), `nose ${held.nose.toFixed(3)} m held, ${coast.nose.toFixed(3)} m coasting`);
    assert.ok(Math.abs(held.engine - coast.engine) <= 0.005, `engine block ${held.engine.toFixed(3)} m held, ${coast.engine.toFixed(3)} m coasting`);
  });
});

/** The calibration's 53 km/h t-bone: the bullet drives its nose into the resting car's right door. */
function tBone(): { struck: DeformableCar; bullet: DeformableCar; w: CrashWorld } {
  const struck = makeCar();
  const bullet = makeCar();
  launch(struck, 0, 0, 0, 0, 0);
  launch(bullet, 6, 0, -Math.PI / 2, -53 / 3.6, 0);
  return { struck, bullet, w: makeWorld([struck, bullet], false, false) };
}

describe("the COM-gap floor holds a pair once the crush along the contact is spent", () => {
  // The floor stood at 2.15 m + 0.28 m of each car's FRONTAL leftover crumple. A car hit on its flank counted its untouched
  // nose, so the floor fired 30 ms into the coasting t-bone at 2.64 m against 2.69 m with the door at 48 % of its stroke:
  // the rigid exchange then rang the crush (a driven bullet's nose ended at 0.06 m against 0.20 m coasting).
  it("bad: the struck car's masses take the pair's speed only once its door has crushed its stroke (strokeUsed reads the door on a flank)", () => {
    const { struck, w } = tBone();
    const inner = w.world.beforeSlice!;
    let used = -1;
    w.world.beforeSlice = (h) => {
      if (used < 0) {
        let p = 0;
        let m = 0;
        for (const q of struck.deform.masses) {
          p += q.vel.x * q.mass;
          m += q.mass;
        }
        if (Math.abs(p / m) > 2) used = struck.deform.strokeUsed();
      }
      return inner(h);
    };
    for (let frame = 0; frame < 60; frame++) tickWorld(w);
    assert.ok(used >= 0, "the struck car never took the pair's speed: the scene is not the exchange");
    assert.ok(used >= 0.8, `the struck car's masses took the pair's speed with its door at ${(used * 100).toFixed(0)} % of its stroke`);
  });

  /** The t-bone's final dents with the bullet holding the throttle for `hold` s from first contact. */
  function dents(hold: number): { bulletNose: number; struckNose: number; door: number; engine: number } {
    const { struck, bullet, w } = tBone();
    holdThrottle(w, [bullet], hold);
    const ps = new Probe(struck, new THREE.Vector3(-1, 0, 0));
    const pb = new Probe(bullet, new THREE.Vector3(-1, 0, 0));
    run(w, [ps, pb], 2.5);
    const a = ps.finish();
    const b = pb.finish();
    return { bulletNose: (b.noseShortL + b.noseShortR) / 2, struckNose: a.noseShortR, door: a.doorMaxR, engine: a.engineTravel };
  }

  it("bad: a bullet driven through the t-bone crushes its nose, the struck door and the engine block as a coast does (the 0.12 s pulse, and full throttle)", () => {
    const coast = dents(0);
    for (const hold of [0.12, Infinity]) {
      const held = dents(hold);
      const where = `${hold} s of throttle`;
      assert.ok(Math.abs(held.bulletNose - coast.bulletNose) <= Math.max(0.03, 0.15 * coast.bulletNose), `${where}: bullet nose ${held.bulletNose.toFixed(3)} m, ${coast.bulletNose.toFixed(3)} m coasting`);
      assert.ok(Math.abs(held.door - coast.door) <= Math.max(0.03, 0.15 * coast.door), `${where}: struck door ${held.door.toFixed(3)} m, ${coast.door.toFixed(3)} m coasting`);
      assert.ok(Math.abs(held.engine - coast.engine) <= 0.005, `${where}: struck engine block ${held.engine.toFixed(3)} m, ${coast.engine.toFixed(3)} m coasting`);
    }
    // The struck nose is no dent: the full-throttle shove accelerates the struck car for seconds and its nose lags (7 cm), so the pulse only.
    const pulse = dents(0.12);
    assert.ok(Math.abs(pulse.struckNose - coast.struckNose) <= 0.03, `struck nose ${pulse.struckNose.toFixed(3)} m driven, ${coast.struckNose.toFixed(3)} m coasting`);
  });
});
