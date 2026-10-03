import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar, FLIGHT } from "../vehicle/car.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { INPUT_BYTES, type HighlightClip } from "../match/highlights.ts";
import { makeCarFrame, makeSnapshot, NET_VERSION, Q, snapshotMaxBytes, writeSnapshot, Writer } from "./codec.ts";
import { carLayout, readCarPose } from "./car-pose.ts";
import { decodeSaved, encodeSaved, packReel, REEL_MSG_MAX, unpackReel } from "./reel-codec.ts";

/** Two cars, one a wreck (a crushed nose): a clip whose keyframes carry a wreck section. */
function makeClip(): { clip: HighlightClip; car: DeformableCar } {
  const scene = new THREE.Scene();
  const a = new DeformableCar({ body: 0xff0000, accent: 0, name: "a" }, scene);
  const b = new DeformableCar({ body: 0x00ff00, accent: 0, name: "b" }, scene);
  a.spawnFacing(0, 0, 0, 0);
  b.spawnFacing(4, 2, 1.2, 9);
  a.applyImpact(new THREE.Vector3(0, 0.5, 2.2), new THREE.Vector3(0, 0, -1), 18, 14);
  for (let i = 0; i < 30; i++) a.step(1 / 240);
  const L = carLayout(a);
  const keys = [0, 1].map((k) => {
    const frames = [a, b].map((car) => {
      const f = makeCarFrame(L);
      readCarPose(car, f);
      f.wreck = car.crashed;
      if (f.wreck) {
        car.deform.readNetState(f.deform);
        car.readPartNetState(f.parts);
      }
      return f;
    });
    const sim = new Float32Array(a.deform.simSize());
    const fly = new Float32Array(FLIGHT);
    const w = new Writer(snapshotMaxBytes(2, L) + 4 + 2 * (FLIGHT * 4 + 2 + sim.length * 4));
    writeSnapshot(w, { ...makeSnapshot(), time: k, count: 2, cars: frames }, L);
    w.q16(0.25 * k, Q.fine);
    w.q16(0, Q.fine);
    // As `CrashRecorder.encodeKey`: each car's flight block, then a wreck's solver state.
    for (const car of [a, b]) {
      car.flight(fly, 0, false);
      w.f32s(fly, FLIGHT);
      const n = car.crashed ? sim.length : 0;
      if (n > 0) car.deform.simState(sim, false);
      w.u16(n);
      w.f32s(sim, n);
    }
    return w.done().slice();
  });
  const steps = 600;
  const clip: HighlightClip = {
    trackId: "city",
    score: 12.5,
    impacts: 3,
    kills: 1,
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
    cars: [
      { slot: 3, style: a.style.id, cls: "sedan", name: "Ayla" },
      { slot: 7, style: b.style.id, cls: "truck", name: "Bo" },
    ],
    h: new Float32Array(steps).fill(Math.round(1e6 / 240) / 1e6),
    inputs: new Uint8Array(steps * 2 * INPUT_BYTES).map((_, i) => (i * 37) & 255),
    keyStep: Uint32Array.of(0, 240),
    keys,
  };
  assert.ok(a.crashed, "car a is a wreck");
  return { clip, car: a };
}

function sameClip(got: HighlightClip, want: HighlightClip): void {
  for (const k of ["trackId", "impacts", "kills", "firstStep", "focus", "firstA", "firstB", "bleed", "t0", "firstImpact", "lastImpact", "realism"] as const) {
    assert.equal(got[k], want[k], k);
  }
  for (const k of ["score", "peakKph", "x", "z"] as const) assert.equal(got[k], Math.fround(want[k]), k);
  assert.equal(got.cars.length, want.cars.length);
  got.cars.forEach((c, i) => {
    for (const k of ["slot", "style", "cls", "name"] as const) assert.equal(c[k], want.cars[i]![k], `car ${i} ${k}`);
  });
  assertSameNumbers(got.h, want.h, "step dt");
  assertSameNumbers(got.inputs, want.inputs, "inputs");
  assertSameNumbers(got.keyStep, want.keyStep, "keyframe steps");
  assert.equal(got.keys.length, want.keys.length);
  got.keys.forEach((k, i) => assertSameNumbers(k, want.keys[i]!, `keyframe ${i} bytes`));
}

describe("highlight codec", () => {
  it("bad: a reel must come back from MSG.reel byte for byte, with its seed and start time", async () => {
    const { clip, car } = makeClip();
    const { msg, clips } = await packReel({ seed: 0xdeadbeef, clips: [clip, clip] }, 1234.5);
    assert.equal(clips, 2);
    assert.ok(msg.length < REEL_MSG_MAX);
    const got = await unpackReel(msg, carLayout(car));
    assert.equal(got.reel.seed, 0xdeadbeef);
    assert.equal(got.startAt, 1234.5);
    assert.equal(got.reel.clips.length, 2);
    sameClip(got.reel.clips[1]!, clip);
  });

  it("bad: a saved clip must decode to the same clip", async () => {
    const { clip, car } = makeClip();
    const got = await decodeSaved(await encodeSaved(clip), carLayout(car));
    assert.notEqual(typeof got, "string", `decoded as ${String(got)}`);
    sameClip(got as HighlightClip, clip);
  });

  it("bad: a clip saved by another build must be refused as 'version', a damaged one as 'corrupt'", async () => {
    const { clip, car } = makeClip();
    const L = carLayout(car);
    const bytes = Uint8Array.from(atob(await encodeSaved(clip)), (c) => c.charCodeAt(0));
    const recode = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
    const edited = (at: number, v: number): string => {
      const b = bytes.slice();
      b[at] = v;
      return recode(b);
    };
    assert.equal(await decodeSaved(edited(4, bytes[4]! + 1), L), "version", "another REPLAY_VERSION");
    assert.equal(await decodeSaved(edited(6, NET_VERSION + 1), L), "version", "another NET_VERSION");
    assert.equal(await decodeSaved(edited(7, bytes[7]! ^ 0xff), L), "version", "another sim fingerprint");
    assert.equal(await decodeSaved(edited(0, 0), L), "corrupt", "not a clip");
    assert.equal(await decodeSaved(recode(bytes.subarray(0, bytes.length - 40)), L), "corrupt", "truncated");
    assert.equal(await decodeSaved("%%%", L), "corrupt", "not base64");
  });
});
