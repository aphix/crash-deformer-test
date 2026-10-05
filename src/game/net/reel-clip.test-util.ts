import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar, FLIGHT } from "../vehicle/car.ts";
import { assertSameDigest, assertSameNumbers } from "../vehicle/test-support.ts";
import { INPUT_BYTES, MEMORY, type HighlightClip } from "../match/highlights.ts";
import { makeCarFrame, makeSnapshot, snapshotMaxBytes, writeSnapshot, Writer } from "./codec.ts";
import { carLayout, readCarPose } from "./car-pose.ts";

/** A keyframe's knocked props (bits), and each car's course memory (`MEMORY` doubles: wall x and z, how far past a wall line, the road segment). */
const KNOCKS = [0b101, 0, 0b10000001];
const MEMORY_A = [Infinity, 0, 0, -1];
const MEMORY_B = [12.5, -7.25, 0.125, 392];

/** Two cars, one a wreck (a crushed nose): a clip whose first keyframe carries a wreck section, and a later one only the second car (put on a spot in its step). */
export function makeClip(): { clip: HighlightClip; car: DeformableCar } {
  const scene = new THREE.Scene();
  const a = new DeformableCar({ body: 0xff0000, accent: 0, name: "a" }, scene);
  const b = new DeformableCar({ body: 0x00ff00, accent: 0, name: "b" }, scene);
  a.spawnFacing(0, 0, 0, 0);
  b.spawnFacing(4, 2, 1.2, 9);
  a.applyImpact(new THREE.Vector3(0, 0.5, 2.2), new THREE.Vector3(0, 0, -1), 18, 14);
  for (let i = 0; i < 30; i++) a.step(1 / 240);
  const L = carLayout(a);
  const keys = [0, 1].map((k) => {
    const here = k === 0 ? [a, b] : [b];
    const frames = here.map((car) => {
      const f = makeCarFrame(L);
      readCarPose(car, f);
      f.wreck = car.crashed;
      if (f.wreck) {
        car.deform.readNetState(f.deform);
        car.readPartNetState(f.parts);
      }
      return f;
    });
    const sim = new Float64Array(a.deform.simSize());
    const fly = new Float64Array(FLIGHT);
    const w = new Writer(snapshotMaxBytes(2, L) + 2 + KNOCKS.length + here.length * (FLIGHT * 8 + MEMORY * 8 + 2 + sim.length * 8));
    writeSnapshot(w, { ...makeSnapshot(), time: k, count: here.length, cars: frames }, L);
    // As `CrashRecorder.encodeKey`: the knocked props' bits, then each car's flight block (doubles), course memory and a wreck's solver state.
    w.u16(KNOCKS.length);
    for (const v of KNOCKS) w.u8(v);
    for (const car of here) {
      car.flight(fly, 0, false);
      w.bytes.set(new Uint8Array(fly.buffer), w.off);
      w.off += FLIGHT * 8;
      for (const m of car === a ? MEMORY_A : MEMORY_B) w.f64(m);
      const n = car.crashed ? sim.length : 0;
      if (n > 0) car.deform.simState(sim, false);
      w.u16(n);
      w.bytes.set(new Uint8Array(sim.buffer, 0, n * 8), w.off);
      w.off += n * 8;
    }
    return w.done().slice();
  });
  const steps = 600;
  const clip: HighlightClip = {
    trackId: "city",
    score: 12.5,
    impacts: 3,
    kills: 1,
    ejects: 1,
    hit: 3,
    ejections: [
      {
        step: 361,
        e: {
          car: 1,
          exit: "windshield",
          cop: false,
          pos: new THREE.Vector3(1.5, 1.25, -2),
          local: new THREE.Vector3(-0.25, 1.125, 0.5),
          dir: new THREE.Vector3(0, 0, 1),
          quat: new THREE.Quaternion(0.25, 0.5, 0.25, 0.75),
          rel: new THREE.Vector3(3, 3.5, -1),
          carVel: new THREE.Vector3(10, 0, 4),
          spin: new THREE.Vector3(3, 0, 0),
        },
      },
    ],
    knocks: [
      { step: 100, prop: 3 },
      { step: 100, prop: 17 },
      { step: 432, prop: 200 },
    ],
    peakKph: 96,
    t0: 41.25,
    firstImpact: 1.5,
    lastImpact: 2.25,
    firstStep: 360,
    x: 3,
    z: -7,
    focus: 1,
    firstA: 0,
    firstB: 1,
    realism: 0.35,
    bleed: false,
    squash: 0.4,
    buckle: 0.55,
    deformMode: "lattice",
    look: 0xdeadbeef,
    cars: [
      { slot: 3, style: a.style.id, cls: "sedan", name: "Ayla" },
      { slot: 7, style: b.style.id, cls: "truck", name: "Bo" },
    ],
    h: new Float32Array(steps).fill(1 / 240),
    shape: new Uint32Array(steps).map((_, i) => (i % 5 === 0 ? (0b100111 << 3) | 2 : 0b1 << 3)),
    inputs: new Uint8Array(steps * 2 * INPUT_BYTES).map((_, i) => (i * 37) & 255),
    keyStep: Uint32Array.of(0, 240),
    keyCars: Uint32Array.of(0b11, 0b10),
    keys,
  };
  assert.ok(a.crashed, "car a is a wreck");
  return { clip, car: a };
}

/** `got` is `want` after the wire (floats fround). */
export function sameClip(got: HighlightClip, want: HighlightClip): void {
  for (const k of ["trackId", "impacts", "kills", "ejects", "hit", "firstStep", "focus", "firstA", "firstB", "bleed", "t0", "firstImpact", "lastImpact", "realism"] as const) {
    assert.equal(got[k], want[k], k);
  }
  for (const k of ["score", "peakKph", "x", "z"] as const) assert.equal(got[k], Math.fround(want[k]), k);
  assert.equal(got.cars.length, want.cars.length);
  got.cars.forEach((c, i) => {
    for (const k of ["slot", "style", "cls", "name"] as const) assert.equal(c[k], want.cars[i]![k], `car ${i} ${k}`);
  });
  assertSameNumbers(got.h, want.h, "step dt");
  assertSameNumbers(got.shape, want.shape, "step schedule");
  assertSameNumbers(got.inputs, want.inputs, "inputs");
  assertSameNumbers(got.keyStep, want.keyStep, "keyframe steps");
  assertSameNumbers(got.keyCars, want.keyCars, "keyframe car masks");
  assert.equal(got.keys.length, want.keys.length);
  got.keys.forEach((k, i) => assertSameNumbers(k, want.keys[i]!, `keyframe ${i} bytes`));
  assert.equal(got.ejections.length, want.ejections.length);
  got.ejections.forEach((x, i) => {
    const w = want.ejections[i]!;
    assert.equal(x.step, w.step, `ejection ${i} step`);
    assertSameDigest({ ...x.e, pos: x.e.pos.toArray(), local: x.e.local.toArray(), dir: x.e.dir.toArray(), quat: x.e.quat.toArray(), rel: x.e.rel.toArray(), carVel: x.e.carVel.toArray(), spin: x.e.spin.toArray() }, { ...w.e, pos: w.e.pos.toArray(), local: w.e.local.toArray(), dir: w.e.dir.toArray(), quat: w.e.quat.toArray(), rel: w.e.rel.toArray(), carVel: w.e.carVel.toArray(), spin: w.e.spin.toArray() }, `ejection ${i}`);
  });
  assert.deepEqual(got.knocks, want.knocks, "knocked props");
}
