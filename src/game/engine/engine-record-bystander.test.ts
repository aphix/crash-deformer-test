import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { makeSnapshot, Reader, readSnapshot, Writer } from "../net/codec.ts";
import { carLayout } from "../net/car-pose.ts";
import { clipBytes, readClip, writeClip } from "../net/reel-codec.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { REHIT_S, type HighlightClip } from "../match/highlights.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import { CrashRecorder } from "./engine-record.ts";
import { ClipSim } from "./engine-replay.ts";

const H = 1 / 240;
/** Acceptance bounds of docs/HIGHLIGHTS.md, as `engine-replay.test.ts`: the first impact within 0.2 s, a car within 1.5 m of its recorded spot. */
const TIME_TOL = 0.2;
const POS_TOL = 1.5;
const STEPS = 9 * 240;
/** The respawn of `JUMPER`: 5 s in, after the first impact. */
const JUMP_STEP = 5 * 240;
/** `NEAR` touches `TOUCHER`: 2 s in, inside the clip. */
const TOUCH_STEP = 2 * 240;
/** The slots of the scene (a flat field, y = 0): a head-on pair, then the bystanders, named by their distance from the hit. */
const A = 0;
const B = 1;
/** 40 m from the hit, steering the whole time (its replay only matches if its recorded inputs are replayed). */
const NEAR = 2;
/** 250 m out, never in view of the hit; it touches `NEAR` (a contact the recorder sees) once, so it is dragged in. */
const TOUCHER = 3;
/** 50 m from the hit until a respawn 3 s in: the replay cannot place a car (clips keep keyframes only to the first impact). */
const JUMPER = 4;
/** 300 m out, touching nobody. */
const FAR = 5;
/** Wrecks (a solver state in every keyframe: the costly kind of car) 50 to 74 m out, 4 m apart: the clip has room for some. */
const WRECKS = [6, 7, 8, 9, 10, 11, 12];
/** The pair meets at x = `IMPACT_X` about 3.3 s in, so the clip's pre-roll holds a full 3 s of keyframes. */
const IMPACT_X = 60;
const ALL = 13;

/** The clip as a peer decodes it, the cars of the world it was recorded in, and the world's trace of every car. */
interface Recorded {
  clip: HighlightClip;
  cars: DeformableCar[];
  trace: Float64Array[];
  dress: (car: DeformableCar) => void;
}

/** A flat-field head-on crash with bystanders, recorded. */
function record(): Recorded {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const cars = Array.from({ length: ALL }, (_, i) => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    return car;
  });
  cars[A]!.spawnFacing(0, 0, Math.PI / 2, 15);
  cars[B]!.spawnFacing(2 * IMPACT_X, 0, -Math.PI / 2, 15);
  cars[NEAR]!.spawnFacing(IMPACT_X, 40, Math.PI / 2, 12);
  cars[TOUCHER]!.spawnFacing(IMPACT_X, 250, Math.PI / 2, 12);
  cars[JUMPER]!.spawnFacing(IMPACT_X, -50, Math.PI / 2, 12);
  cars[FAR]!.spawnFacing(IMPACT_X, -300, Math.PI / 2, 12);
  WRECKS.forEach((i, k) => {
    const car = cars[i]!;
    car.spawnFacing(IMPACT_X, 50 + 4 * k, Math.PI / 2, 12);
    car.applyImpact(new THREE.Vector3(car.group.position.x + 2.2, 0.5, car.group.position.z), new THREE.Vector3(-1, 0, 0), 16, 12);
    assert.ok(car.crashed, `car ${i} is a wreck`);
  });
  const rec = new CrashRecorder();
  rec.begin("flat", HANDLING.realism, false, ALL, (i) => `c${i}`);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit, first) => rec.pairHit(a, b, hit, first);
  const graze: ContactHit = { impulse: 2, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) };
  const trace: Float64Array[] = [];
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  let t = 0;
  for (let s = 0; s < STEPS; s++) {
    if (s === JUMP_STEP) cars[JUMPER]!.spawnFacing(IMPACT_X, -400, Math.PI / 2, 12);
    rec.startStep(cars);
    if (s === TOUCH_STEP) rec.pairHit(NEAR, TOUCHER, graze, true);
    cars.forEach((car, i) => {
      input.throttle = i === A || i === B ? 1 : 0.6;
      input.steer = i === NEAR ? 0.3 * Math.sin(t * 4) : 0;
      applyDrive(car, input, H);
    });
    stepWorld(world, H);
    rec.endStep(cars, H);
    settleStep(cars, H, false);
    trace.push(Float64Array.from(cars.flatMap((c) => [c.group.position.x, c.group.position.z])));
    t += H;
  }
  rec.end();
  assert.ok(rec.ledger.kept.length >= 1, "the head-on crash did not rank as a highlight");
  const kept = rec.ledger.kept[0]!;
  const w = new Writer(clipBytes(kept));
  writeClip(w, kept);
  return { clip: readClip(new Reader().reset(w.done()), carLayout(cars[0]!)), cars, trace, dress };
}

describe("highlight recorder bystanders", () => {
  let run: Recorded;
  before(() => {
    run = record();
  });

  it("bad: cars near the hit (and a car one of them touched) are in the clip and replay within the replay bounds; far cars and a respawned car are not", (t) => {
    const { clip, cars, trace, dress } = run;
    const slots = clip.cars.map((c) => c.slot);
    t.diagnostic(`clip cars: ${slots.join(",")} (${(clipBytes(clip) / 1024).toFixed(0)} KB)`);
    assert.ok(slots.includes(A) && slots.includes(B), "the head-on pair is in the clip");
    assert.ok(slots.includes(NEAR), "a car 40 m from the hit is in the clip");
    assert.ok(slots.includes(TOUCHER), "a car that touched a bystander since the clip's start is in the clip, wherever it is");
    assert.ok(!slots.includes(JUMPER), "a car respawned after the first impact would replay where it never went");
    assert.ok(!slots.includes(FAR), "a car 300 m away is not in the clip");
    // Replay it as a peer does, and compare each car with the world's trace at the same step.
    const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, bounce: undefined });
    sim.watchFrom = Math.max(0, clip.firstImpact - REHIT_S);
    sim.restart();
    sim.advanceTo(clip.firstImpact + 2);
    assert.ok(sim.firstHit >= 0 && Math.abs(sim.firstHit - clip.firstImpact) <= TIME_TOL, `the replay's first impact ${sim.firstHit.toFixed(3)} s vs the record's ${clip.firstImpact.toFixed(3)} s (> ${TIME_TOL})`);
    // The recorder's clock sums `H` as this loop did, so the clip's first step is the trace step at `t0`.
    const s0 = Math.round(clip.t0 / H);
    assert.ok(Math.abs(s0 * H - clip.t0) < 1e-9, "the clip starts on a step of the trace");
    const at = s0 + sim.step - 1;
    const k = clip.keyStep.indexOf(sim.impactStep);
    assert.ok(k >= 0, "the clip keeps a keyframe at its first impact");
    const rec = makeSnapshot();
    readSnapshot(new Reader().reset(clip.keys[k]!), rec, carLayout(cars[0]!));
    const rows: string[] = [];
    for (let j = 0; j < clip.cars.length; j++) {
      const slot = clip.cars[j]!.slot;
      const before = Math.hypot(sim.preSnap[j * 3]! - rec.cars[j]!.x, sim.preSnap[j * 3 + 2]! - rec.cars[j]!.z);
      const after = Math.hypot(cars[slot]!.group.position.x - trace[at]![slot * 2]!, cars[slot]!.group.position.z - trace[at]![slot * 2 + 1]!);
      rows.push(`car ${slot}: ${before.toFixed(3)} m off before the impact correction, ${after.toFixed(3)} m off 2 s after the first impact`);
      if (slot === A || slot === B) continue;
      assert.ok(before <= POS_TOL, `bystander ${slot} ${before.toFixed(2)} m off its record at the first impact (> ${POS_TOL})\n${rows.join("\n")}`);
      assert.ok(after <= POS_TOL, `bystander ${slot} ${after.toFixed(2)} m off its record 2 s after the first impact (> ${POS_TOL})\n${rows.join("\n")}`);
    }
    t.diagnostic(rows.join("\n"));
  });

  it("bad: a clip at its byte share takes the nearer wrecks and drops the farther ones", (t) => {
    const taken = WRECKS.filter((i) => run.clip.cars.some((c) => c.slot === i));
    t.diagnostic(`wrecks taken: ${taken.join(",")} of ${WRECKS.join(",")} (${(clipBytes(run.clip) / 1024).toFixed(0)} KB)`);
    assert.ok(taken.length >= 1, "the nearest wreck (50 m) is in the clip");
    assert.ok(taken.length < WRECKS.length, "the farthest wreck (74 m) would take the clip past its share");
    assert.ok(taken.every((slot, k) => slot === WRECKS[k]), "the wrecks taken are the nearest ones");
  });
});
