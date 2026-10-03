import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { fleetStyle, MAX_CARS } from "../scenes/fleet.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { CrashRecorder } from "./engine-record.ts";

const H = 1 / 240;
/**
 * A minute of racing: the 2 Hz keyframe encode (`writeSnapshot`) is cold code, so V8 runs it in the
 * interpreter, where every double is boxed, for its first ~20 s; the test measures the steady state after
 * it tiers up. Measured after 10 s: 26–30 B/step (the codec, a few KB per keyframe until tier-up).
 */
const WARM = 14400;
const MEASURE = 4800;
/**
 * Heap growth allowed per recorded step (B), summed over positive deltas: JIT and test noise, not a buffer per step,
 * plus each wreck's keyframe solver state (`simState`): its scalar fields are read by name, and V8 boxes every double
 * read that way (measured 280 B a wreck, 3.1 KB a keyframe at 11 wrecks; 26 B/step here).
 */
const BOUND_B = 16 + (Math.ceil(MAX_CARS / 3) * 320 * 2) / 240;

describe("highlight recorder", () => {
  it(`bad: recording a ${MAX_CARS}-car race with wrecks, contacts and twice-a-second keyframes must not allocate per step`, () => {
    const scene = new THREE.Scene();
    const cars = Array.from({ length: MAX_CARS }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i)));
    cars.forEach((c, i) => c.spawnFacing(i * 6, 0, 0, 10));
    // A third are wrecks: every keyframe encodes their netplay wreck section.
    for (let i = 0; i < MAX_CARS; i += 3) cars[i]!.applyImpact(new THREE.Vector3(i * 6, 0.5, 2.2), new THREE.Vector3(0, 0, -1), 16, 12);
    const rec = new CrashRecorder();
    rec.begin("oval", 0.35, false, () => "x");
    // Grinding contact under the impact bar: the contact path runs, no cluster ever opens.
    const grind: ContactHit = { impulse: 2, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) };
    const step = (): void => {
      rec.startStep(cars);
      for (let i = 0; i + 1 < MAX_CARS; i += 2) rec.pairHit(i, i + 1, grind, true);
      rec.wallHit(5, 1, 0, 0);
      rec.endStep(cars, H);
    };
    for (let s = 0; s < WARM; s++) step();
    // Read the heap once a recorded second (`memoryUsage` allocates its own result), positive deltas only.
    let grown = 0;
    let last = process.memoryUsage().heapUsed;
    for (let s = 0; s < MEASURE; s++) {
      step();
      if (s % 240 !== 239) continue;
      const now = process.memoryUsage().heapUsed;
      if (now > last) grown += now - last;
      last = now;
    }
    const perStep = grown / MEASURE;
    if (process.env.ALLOC_PRINT) console.log(`recorder: ${perStep.toFixed(1)} B/step`);
    assert.equal(rec.ledger.open.length, 0, "no cluster opened: this measures the steady state");
    assert.ok(perStep <= BOUND_B, `${perStep.toFixed(1)} B per recorded step > ${BOUND_B}: the recorder allocates in steady state`);
  });
});
