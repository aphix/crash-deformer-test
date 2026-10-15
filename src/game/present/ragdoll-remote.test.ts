import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { RagdollRemote } from "./ragdoll-remote.ts";
import { LAG, type FromWorker, type ResultMessage, type ToWorker } from "./ragdoll-wire.ts";

const FRAME = 1 / 60;
const WINDSHIELD = 0;
const CRACKED = 1;

/** A Worker that records what is posted to it and says only what the test has it say. */
class ScriptedWorker {
  static last: ScriptedWorker;
  readonly posted: ToWorker[] = [];
  onmessage: ((event: { data: FromWorker }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    ScriptedWorker.last = this;
  }

  postMessage(message: ToWorker): void {
    this.posted.push(message);
  }

  terminate(): void {}

  say(message: FromWorker): void {
    this.onmessage!({ data: message });
  }
}

/** The answer to frame `seq` of epoch 0: nothing out but a strike of the windshield of car 0 and a dummy still out. */
function answer(seq: number, hits: ResultMessage["hits"]): ResultMessage {
  return { type: "result", seq, epoch: 0, dolls: new Float32Array(0), alpha: 0, lastSlot: 0, purses: new Float32Array(0), props: new Float32Array(0), propsReset: false, spawned: [], hits, wanted: new Uint8Array(32), active: true, stepMs: new Float64Array(0), colliders: 0, bodies: 0 };
}

/** Frames posted until the strike in frame 1's answer shows on the car, the answer arriving `arrive` posts after frame 1; -1: not before the sim must have it. */
function glassAfterFrame(arrive: number, frames: number): number[] {
  Object.assign(globalThis, { Worker: ScriptedWorker });
  const remote = RagdollRemote.open(() => assert.fail("the worker failed"))!;
  const worker = ScriptedWorker.last;
  worker.say({ type: "ready" });
  const car = makeCar();
  const cars = [car];
  remote.knock(0, -1, 0, 0, 0);
  const seen: number[] = [];
  for (let frame = 1; frame <= frames; frame++) {
    if (frame === 1 + arrive) worker.say(answer(1, [{ car: 0, pane: WINDSHIELD }]));
    if (frame === LAG + 1 && arrive < 0) assert.equal(remote.behind(true), true, "the sim waits for the answer it is to hear");
    if (frame === LAG + 1 && arrive < 0) worker.say(answer(1, [{ car: 0, pane: WINDSHIELD }]));
    remote.post(FRAME, cars, true, false, 0);
    seen.push((car.glassBits() >> (2 * WINDSHIELD)) & 3);
  }
  remote.dispose();
  return seen;
}

/** The two sequences are as long and agree at every index; a failure names the first index they differ at and both values. */
function assertSame(actual: readonly number[], expected: readonly number[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: lengths`);
  const at = actual.findIndex((value, index) => value !== expected[index]);
  assert.equal(at, -1, `${label}: first difference at ${at}: ${actual[at]} against ${expected[at]}`);
}

describe("given the dummies' world in a worker whose answer to frame 1 struck a car's windshield", () => {
  it("when the answer arrives at different times, then the pane is struck on the car at the same frame, LAG frames after the one struck in", () => {
    const early = glassAfterFrame(0, 5);
    const justInTime = glassAfterFrame(LAG - 1, 5);
    const sim = glassAfterFrame(-1, 5);
    const expected = [0, 0, CRACKED, CRACKED, CRACKED];
    assertSame(early, expected, "answer in before frame 2");
    assertSame(justInTime, expected, "answer in before frame LAG");
    assertSame(sim, expected, "answer in only when the sim waited for it");
  });
});

describe("given the dummies' world has something out and its answer to a frame the sim is to hear is missing", () => {
  it("when the answer comes, then the sim stops waiting; a peer that does not own the glass never waits", () => {
    Object.assign(globalThis, { Worker: ScriptedWorker });
    const remote = RagdollRemote.open(() => assert.fail("the worker failed"))!;
    const worker = ScriptedWorker.last;
    worker.say({ type: "ready" });
    remote.knock(0, -1, 0, 0, 0);
    const cars = [makeCar()];
    for (let frame = 1; frame < LAG; frame++) remote.post(FRAME, cars, true, false, 0);
    assert.equal(remote.behind(true), false, "no answer is due yet");
    remote.post(FRAME, cars, true, false, 0);
    assert.equal(remote.behind(true), true, "answer to frame 1 is due");
    assert.equal(remote.behind(false), false, "a client's glass is the host's");
    worker.say(answer(1, []));
    assert.equal(remote.behind(true), false, "answer is in");
    remote.dispose();
  });
});
/** The same scripted strike (the dummies' world reports the windshield of car 0 struck in its first frame) in the main thread's own world: the glass after each frame. */
async function inlineGlassAfterFrame(frames: number): Promise<{ glass: number[]; digest: string }> {
  Reflect.deleteProperty(globalThis, "Worker");
  const world = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await world.preload();
  const car = makeCar();
  world.place(new THREE.Vector3(40, 3, 40), new THREE.Quaternion(), new THREE.Vector3(), new THREE.Vector3(), 10, 0);
  const glass: number[] = [];
  for (let frame = 1; frame <= frames; frame++) {
    if (frame === 1) world["proxies"].strikes.push({ car: 0, pane: WINDSHIELD });
    world.update(FRAME, [car], true, false, null);
    glass.push((car.glassBits() >> (2 * WINDSHIELD)) & 3);
  }
  const digest = `${car.glassBits()} ${car.group.position.toArray().join()}`;
  world.dispose();
  return { glass, digest };
}

describe("given the same scripted strike of a car's windshield in the dummies' world, run in the main thread and through a worker", () => {
  it("when both run the same frames, then the pane is struck on the car at the same frame in both, with equal car digests", async () => {
    const inline = await inlineGlassAfterFrame(5);
    const worker = glassAfterFrame(0, 5);
    const stalled = glassAfterFrame(-1, 5);
    assertSame(inline.glass, [0, 0, CRACKED, CRACKED, CRACKED], "main thread's own world");
    assertSame(inline.glass, worker, "worker, answer early");
    assertSame(inline.glass, stalled, "worker, sim stalled for the answer");
    assert.match(inline.digest, /^1 /, "the car ends with the windshield cracked and sits where it was");
  });
});
