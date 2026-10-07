import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { derbyRadius } from "../scenes/derby-arena.ts";
import { fleetStyle, layoutDerby } from "../scenes/fleet.ts";
import { resolveCarPair } from "./pair-contact.ts";
import { partContactPair } from "./external-contact.ts";
import { physicsSlice, sliceSpeed } from "./sat.ts";

/**
 * docs/PERF_HITCH.md "GC during races": physics garbage is what drives the race GC pauses. A warmed 24-car
 * pile-up in the engine's derby contact order (drive, integrate/sync, part contact, SAT passes, structure),
 * every car driving at the bowl centre. Heap growth is summed per frame, positive deltas only: a frame with
 * a scavenge counts as 0, so this only undercounts. 75bc12d: 2280–2300 KB per frame; f8821eb (boxing, iterator
 * and closure fixes): 657–672; with the split mass loops, typed-array outs and double-from-construction fields
 * (RIG_ANALYSIS §6.12): 421–425. The bound sits between, with room for JIT timing under a loaded runner.
 */
const CARS = 24;
const WARM = 600;
const MEASURE = 300;
const BOUND_KB = 540;

function pileUp(): { cars: DeformableCar[]; step: () => void } {
  const scene = new THREE.Scene();
  const cars = Array.from({ length: CARS }, (_, i) => new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: `c${i}` }, scene, null, fleetStyle(i)));
  let seed = 11;
  const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const slots = layoutDerby(CARS, derbyRadius(CARS), rng);
  for (const [i, c] of cars.entries()) c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, 12);
  const inputs: DriveInput[] = cars.map(() => ({ ...idleDrive(), throttle: 1 }));
  const step = () => {
    const h = physicsSlice(1 / 60, sliceSpeed(cars));
    for (let i = 0; i < CARS; i++) {
      const c = cars[i]!;
      // Steer at the centre: +1 swings the nose left, toward a centre on the left of the heading.
      const p = c.group.position;
      inputs[i]!.steer = c.fwdFlat.x * -p.z - c.fwdFlat.z * -p.x > 0 ? -1 : 1;
      applyDrive(c, inputs[i]!, h);
      if (c.deform.massActive) c.syncPose(h);
      else c.integrate(h);
    }
    for (let a = 0; a < CARS; a++) {
      for (let b = a + 1; b < CARS; b++) {
        const ca = cars[a]!;
        const cb = cars[b]!;
        if (ca.group.position.distanceToSquared(cb.group.position) > 28) continue;
        if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform, h);
        partContactPair(ca, cb);
      }
    }
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < CARS; i++) {
        if (cars[i]!.deform.massActive) cars[i]!.syncPose(0);
        else cars[i]!.refreshBasis();
      }
      let moved = false;
      for (let a = 0; a < CARS; a++) for (let b = a + 1; b < CARS; b++) if (resolveCarPair(cars[a]!, cars[b]!, k === 0, h)) moved = true;
      if (!moved) break;
    }
    for (let i = 0; i < CARS; i++) {
      const c = cars[i]!;
      if (c.deform.massActive) {
        c.deform.stepStructure(h);
        c.syncPose(h);
        if (!c.deform.drivetrainAlive) c.deform.cutDrive(h);
      }
      c.afterContacts(h);
    }
  };
  return { cars, step };
}

describe("given a warmed 24-car derby pile-up with every car driving at the bowl centre", () => {
  it(`when 300 frames are stepped, then physics allocates at most ${BOUND_KB} KB of heap per frame (boxed doubles, iterators and per-call arrays would show up as race GC pauses)`, () => {
    const { cars, step } = pileUp();
    for (let f = 0; f < WARM; f++) step();
    const crashed = cars.filter((c) => c.deform.massActive).length;
    assert.ok(crashed >= CARS / 2, `only ${crashed} of ${CARS} cars crashed: the pile-up no longer exercises the crush path`);
    let grown = 0;
    let last = process.memoryUsage().heapUsed;
    for (let f = 0; f < MEASURE; f++) {
      step();
      const now = process.memoryUsage().heapUsed;
      if (now > last) grown += now - last;
      last = now;
    }
    const kb = grown / 1024 / MEASURE;
    if (process.env.ALLOC_PRINT) console.log(`physics-alloc: ${kb.toFixed(1)} KB/frame, ${crashed} crashed`);
    assert.ok(kb <= BOUND_KB, `${kb.toFixed(0)} KB per frame > ${BOUND_KB}: a hot physics path allocates again (see docs/PERF_HITCH.md)`);
  });
});
