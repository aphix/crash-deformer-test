import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { FLIGHT } from "../vehicle/car-flight.ts";
import { assertSameDigest, assertSameNumbers } from "../vehicle/test-support.ts";
import { CLIP_NO_CAR, INPUT_BYTES, MEMORY, type HighlightClip } from "../match/highlights.ts";
import { SQUAD_ALARM, SQUAD_DOWN, SQUAD_SHOT, SQUAD_TARGET } from "../scenes/lawn-guard.ts";
import { makeCarFrame, makeSnapshot, snapshotMaxBytes, writeSnapshot, Writer } from "./codec.ts";
import { carLayout, readCarPose } from "./car-pose.ts";
import { FINE_HZ } from "../kernel/constants.ts";

/** A keyframe's knocked props (bits), and each car's course memory (`MEMORY` doubles: the road segment of its projection hint). */
const KNOCKS = [0b101, 0, 0b10000001];
const MEMORY_A = [-1];
const MEMORY_B = [392];

/** Two cars, one a wreck (a crushed nose): a clip whose first keyframe carries a wreck section, and a later one only the second car (put on a spot in its step). */
export function makeClip(): { clip: HighlightClip; car: DeformableCar } {
  const scene = new THREE.Scene();
  const a = new DeformableCar({ body: 0xff0000, accent: 0, name: "a" }, scene);
  const b = new DeformableCar({ body: 0x00ff00, accent: 0, name: "b" }, scene);
  a.spawnFacing(0, 0, 0, 0);
  b.spawnFacing(4, 2, 1.2, 9);
  a.applyImpact(new THREE.Vector3(0, 0.5, 2.2), new THREE.Vector3(0, 0, -1), 18, 14);
  for (let i = 0; i < 30; i++) a.step(1 / FINE_HZ);
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
        own: true,
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
    stirs: [
      { step: 241, car: 0, slice: 0 },
      { step: 241, car: 1, slice: 3 },
      { step: 500, car: 1, slice: 7 },
    ],
    partStirs: [
      { step: 0, car: 0, body: 3, slice: 0, slices: 1500 },
      { step: 300, car: 1, body: 17, slice: 5, slices: 65535 },
    ],
    strikes: [
      { step: 120, s: { guard: 4, car: 0, x: 12.5, y: 0.25, z: -30.75, faceX: 0.5, faceZ: -0.875, vx: 9.5, vy: 1.5, vz: -4.25, wx: 0.75, wy: 0, wz: 2.125 } },
      { step: 361, s: { guard: -1, car: 1, x: -3.5, y: 0.125, z: 8, faceX: 0, faceZ: 1, vx: -6, vy: 0.5, vz: 11.25, wx: -1.5, wy: 0, wz: 0.25 } },
    ],
    // Three guards: one at his post aiming at clip car 1, one running out, one run down; then a hit shot at car 1, the run-down of guard 1, the target lost and the alarm lowered.
    squad: {
      state: Float32Array.of(1.5, 1, 2, 10.5, -20.25, 0.5, -0.875, 1, 11.25, -18, 0, 1, 4, 0, 0, 0, 1),
      events: [
        { step: 3, kind: SQUAD_SHOT, a: 0, b: 1, c: 1 },
        { step: 120, kind: SQUAD_DOWN, a: 1, b: 0, c: 0 },
        { step: 200, kind: SQUAD_TARGET, a: CLIP_NO_CAR, b: 0, c: 0 },
        { step: 300, kind: SQUAD_ALARM, a: 0, b: 0, c: 0 },
      ],
    },
    // The VIP out of the car at the clip's start, in clip car 1's passenger seat from step 90 until its driver's throw.
    vip: { start: CLIP_NO_CAR, events: [{ step: 90, car: 1 }, { step: 330, car: CLIP_NO_CAR }] },
    peakKph: 96,
    hitKph: 48,
    deform: 1.25,
    hits: [
      { t: 1.5, x: 3, y: 0.5, z: -7, a: 0, b: 1 },
      { t: 2, x: 5.5, y: 0.75, z: -9, a: 1, b: -1 },
    ],
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
    h: new Float32Array(steps).fill(1 / FINE_HZ),
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
  for (const k of ["score", "peakKph", "hitKph", "deform", "x", "z"] as const) assert.equal(got[k], Math.fround(want[k]), k);
  assert.equal(got.cars.length, want.cars.length);
  for (const [i, c] of got.cars.entries()) {
    for (const k of ["slot", "style", "cls", "name"] as const) assert.equal(c[k], want.cars[i]![k], `car ${i} ${k}`);
  }
  assertSameNumbers(got.h, want.h, "step dt");
  assertSameNumbers(got.shape, want.shape, "step schedule");
  assertSameNumbers(got.inputs, want.inputs, "inputs");
  assertSameNumbers(got.keyStep, want.keyStep, "keyframe steps");
  assertSameNumbers(got.keyCars, want.keyCars, "keyframe car masks");
  assert.equal(got.keys.length, want.keys.length);
  for (const [i, k] of got.keys.entries()) assertSameNumbers(k, want.keys[i]!, `keyframe ${i} bytes`);
  assert.equal(got.ejections.length, want.ejections.length);
  for (const [i, x] of got.ejections.entries()) {
    const w = want.ejections[i]!;
    assert.equal(x.step, w.step, `ejection ${i} step`);
    assert.equal(x.own, w.own, `ejection ${i} own`);
    assertSameDigest({ ...x.e, pos: x.e.pos.toArray(), local: x.e.local.toArray(), dir: x.e.dir.toArray(), quat: x.e.quat.toArray(), rel: x.e.rel.toArray(), carVel: x.e.carVel.toArray(), spin: x.e.spin.toArray() }, { ...w.e, pos: w.e.pos.toArray(), local: w.e.local.toArray(), dir: w.e.dir.toArray(), quat: w.e.quat.toArray(), rel: w.e.rel.toArray(), carVel: w.e.carVel.toArray(), spin: w.e.spin.toArray() }, `ejection ${i}`);
  }
  assert.deepEqual(got.knocks, want.knocks, "knocked props");
  assert.deepEqual(got.stirs, want.stirs, "stirred wrecks");
  assert.deepEqual(got.partStirs, want.partStirs, "stirred parts");
  assert.equal(got.strikes.length, want.strikes.length);
  for (const [i, x] of got.strikes.entries()) {
    const w = want.strikes[i]!;
    assert.equal(x.step, w.step, `strike ${i} step`);
    for (const k of ["guard", "car", "x", "y", "z", "faceX", "faceZ", "vx", "vy", "vz", "wx", "wy", "wz"] as const) assert.equal(x.s[k], w.s[k], `strike ${i} ${k}`);
  }
  assert.deepEqual(got.squad && { state: Array.from(got.squad.state), events: got.squad.events }, want.squad && { state: Array.from(want.squad.state), events: want.squad.events }, "squad");
  assert.equal(got.hits.length, want.hits.length);
  for (const [i, p] of got.hits.entries()) {
    const w = want.hits[i]!;
    assert.deepEqual(p, { t: w.t, x: Math.fround(w.x), y: Math.fround(w.y), z: Math.fround(w.z), a: w.a, b: w.b }, `scope hit ${i}`);
  }
}
