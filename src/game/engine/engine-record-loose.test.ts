import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import { Reader, Writer } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { clipBytes, readClip, writeClip } from "../net/reel-codec.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import type { HighlightClip } from "../match/highlights.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import { CrashRecorder } from "./engine-record.ts";
import { ClipSim } from "./engine-replay.ts";
import { PoseBlend } from "../present/pose-blend.ts";
import { FINE_HZ } from "../kernel/constants.ts";

/**
 * A car whose parts are torn off before its clip begins (owner flag KGXD-SC0N, 2026-10-15: a replay "begins with all those parts being thrown off the
 * car"). A head-on pair makes the clip; a parked car 25 m off its hit rides in it as a bystander with a door, a quarter panel and a wheel off from the
 * first step and its hood torn 30 steps before the clip's keyframe, in the air when the keyframe is taken.
 */
const H = Math.fround(1 / FINE_HZ);
const STEPS = 10 * FINE_HZ;
const A = 0;
const B = 1;
const PARKED = 2;
const IMPACT_X = 130;
const PARKED_Z = 25;
/** Steps before the clip's keyframe the hood comes off (in the air at the keyframe), and the popped wheel's. */
const HOOD_BEFORE_KEY = 30;
const WHEEL_BEFORE_KEY = 20;
/** A loose body's row in `looseBodies`: its slot, position, orientation, velocity, spin, drawn, dents, asleep; and where the position, the dents and the sleep flag are in it. */
const ROW = 17;
const ROW_POSITION = 1;
const ROW_DENTS = 15;
const ROW_ASLEEP = 16;

/** The clip as a peer decodes it, the cars of the world it was recorded in, and the world's trace of the parked car's loose bodies after every step. */
interface Recorded {
  clip: HighlightClip;
  cars: DeformableCar[];
  trace: Float64Array[];
  dress: (car: DeformableCar) => void;
}

/** Per loose body of `car` (a part by its slot, then a wheel): its slot, position, orientation, velocity, spin, whether it is drawn and (a part) its dents' count. */
function looseBodies(car: DeformableCar): Float64Array {
  const rows: number[] = [];
  for (const [i, p] of car["parts"].entries()) {
    if (p.detached) rows.push(i, ...p.object.position.toArray(), ...p.object.quaternion.toArray(), ...p.velocity.toArray(), ...p.angular.toArray(), p.object.visible ? 1 : 0, p.dent.count, p.shape.asleep ? 1 : 0);
  }
  for (const [i, w] of car["looseWheels"].entries()) {
    if (w.loose) rows.push(100 + i, ...w.object.position.toArray(), ...w.object.quaternion.toArray(), ...w.velocity.toArray(), ...w.angular.toArray(), w.object.visible ? 1 : 0, 0, w.shape.asleep ? 1 : 0);
  }
  return Float64Array.from(rows);
}

/** A head-on in a flat field with a parked car beside it. `keyStep`, the step of the clip's keyframe (-1 while it is not known: a first pass finds it), is when the parked car's hood and wheel are torn, that long before it. */
function record(keyStep: number): Recorded {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const make = (i: number): DeformableCar => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    return car;
  };
  const cars = [A, B, PARKED].map(make);
  cars[A]!.spawnFacing(0, 0, Math.PI / 2, 15);
  cars[B]!.spawnFacing(2 * IMPACT_X, 0, -Math.PI / 2, 15);
  cars[PARKED]!.spawnFacing(IMPACT_X, PARKED_Z, 0, 0);
  const rec = new CrashRecorder({ recall: (_i, out) => out.set([-1]), knocks: () => new Uint8Array(16) });
  rec.begin("flat", HANDLING.realism, false, 4, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit) => rec.pairHit(a, b, hit);
  world.partTouch = (a, b) => rec.touch(a, b);
  const parked = cars[PARKED]!;
  const part = (name: string) => parked["parts"].find((p) => p.name === name)!;
  const trace: Float64Array[] = [];
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  for (let s = 0; s < STEPS; s++) {
    if (s === 0) {
      parked["detachPart"](part("doorL"), 12);
      parked["detachPart"](part("quarterL"), 12);
    }
    if (keyStep > 0 && s === keyStep - HOOD_BEFORE_KEY) parked["detachPart"](part("hood"), 20);
    if (keyStep > 0 && s === keyStep - WHEEL_BEFORE_KEY) parked["dropWheel"](0, "hubFL");
    rec.startStep(cars);
    for (const [i, car] of cars.entries()) {
      input.throttle = i === PARKED ? 0 : 1;
      applyDrive(car, input, H);
    }
    stepWorld(world, H);
    rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
    trace.push(looseBodies(parked));
  }
  rec.end();
  assert.ok(rec.ledger.kept.length >= 1, "the head-on crash did not rank as a highlight");
  const kept = rec.ledger.kept[0]!;
  const w = new Writer(clipBytes(kept));
  writeClip(w, kept);
  return { clip: readClip(new Reader().reset(w.done()), carLayout(cars[0]!)), cars, trace, dress };
}

/** How far apart (any number) two loose-body rows are: Infinity when they list other bodies. */
function gap(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k]! - b[k]!));
  return worst;
}

const first = record(-1);
const keyStep = Math.round(first.clip.t0 / H);
const run = record(keyStep);
const { clip, cars, trace, dress } = run;
const parkedSlot = clip.cars.findIndex((c) => c.slot === PARKED);

/** The parked car's loose bodies as a replay leaves them just restarted, and the worst gap to the live sim's trace at any step after, where the clip's step n is the trace's step `keyStep + n - 1` (0 gaps: to the bit). */
function replayAgainstLive(): { atStart: number; later: number } {
  const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, blend: new PoseBlend() });
  sim.restart();
  const parked = cars[PARKED]!;
  const atStart = gap(looseBodies(parked), trace[keyStep - 1]!);
  let later = 0;
  while (!sim.done) {
    sim.advanceTo(sim.time + 1e-6);
    later = Math.max(later, gap(looseBodies(parked), trace[keyStep + sim.step - 1]!));
  }
  return { atStart, later };
}

describe("given a parked car with a door, a quarter panel and a wheel off before a head-on's clip begins and its hood in the air when the clip's keyframe is taken", () => {
  it("when the clip is filed, then the parked car rides in it with its parts already off at the keyframe: some lying asleep, one still flying", () => {
    assert.ok(parkedSlot >= 0, "the parked car is a bystander of the clip");
    assert.ok(keyStep > HOOD_BEFORE_KEY, `the clip's keyframe is at step ${keyStep}`);
    const atKey = trace[keyStep - 1]!;
    const before = trace[keyStep - 2]!;
    assert.ok(atKey.length / ROW >= 4, `${atKey.length / ROW} loose bodies at the keyframe: door, quarter panel, hood and wheel`);
    const hoodSlot = cars[PARKED]!["parts"].findIndex((p) => p.name === "hood");
    const row = (bodies: Float64Array) => Array.from({ length: bodies.length / ROW }, (_, k) => bodies.subarray(ROW * k, ROW * k + ROW));
    const hood = row(atKey).find((r) => r[0] === hoodSlot)!;
    const hoodBefore = row(before).find((r) => r[0] === hoodSlot)!;
    assert.ok(gap(hood.subarray(ROW_POSITION, ROW_POSITION + 3), hoodBefore.subarray(ROW_POSITION, ROW_POSITION + 3)) > 1e-6, "the hood is still moving at the keyframe");
    assert.ok(row(atKey).some((r) => r[ROW_ASLEEP] === 1), "some torn part lies asleep at the keyframe");
    assert.ok(row(atKey).some((r) => r[ROW_DENTS]! > 0), "a part has been dented in its fall");
  });

  it("when the clip is replayed, then at its start every torn part and the popped wheel lie or fly where the live sim had them, to the bit, not thrown off the car afresh", () => {
    assert.equal(replayAgainstLive().atStart, 0);
  });

  it("when the clip is replayed, then at every step after they are where the live sim had them, the hood landing and the dents carved, to the bit", () => {
    assert.equal(replayAgainstLive().later, 0);
  });
});
