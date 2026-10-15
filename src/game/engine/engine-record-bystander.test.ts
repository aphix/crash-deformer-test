import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { crownY, keelY } from "../vehicle/car-cage-rig.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { fleetClass, fleetStyle } from "../scenes/fleet.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
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

/** The engine's step is a float32 (`Math.fround`), which the recorder stores whole: the replay runs the very step the live sim ran. */
const H = Math.fround(1 / FINE_HZ);
/** The pair meets about 3.3 s in; the clip's post-roll (3 s) closes it before this. */
const STEPS = 7 * 240;
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
/** 50 m from the hit until a respawn 5 s in, after the first impact: the clip puts it there again (a keyframe of that step). */
const JUMPER = 4;
/** 300 m out, touching nobody. */
const FAR = 5;
/** 45 m from the hit with a mirror snapped off and no crash: no wreck, yet its net state rides the keyframe and so must its solver state. */
const MIRROR = 20;
/** Wrecks (a solver state in the clip's first keyframe: the costly kind of car) 50 to 74 m out, in two columns 6 m apart: the clip has room for some. */
const WRECKS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
/** The pair meets at x = `IMPACT_X` about 3.3 s in, so the clip's pre-roll holds a full 3 s of keyframes. */
const IMPACT_X = 60;
const ALL = 21;
/** 4 s in, inside the clip: `FAR` (outside it) knocks prop `OUTSIDE_PROP` off its spot, and `NEAR` (in it) prop `INSIDE_PROP`. */
const KNOCK_STEP = 4 * 240;
const OUTSIDE_PROP = 7;
const INSIDE_PROP = 9;

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
  cars[MIRROR]!.spawnFacing(IMPACT_X, 45, Math.PI / 2, 12);
  cars[MIRROR]!.breakMirror(-1, new THREE.Vector3(1, 1, 0));
  assert.ok(!cars[MIRROR]!.crashed && cars[MIRROR]!.hasLoosePart(), "the mirror car has a part off and is no wreck");
  for (const [k, i] of WRECKS.entries()) {
    const car = cars[i]!;
    car.spawnFacing(IMPACT_X + 6 * (k & 1), 50 + 4 * (k >> 1), Math.PI / 2, 12);
    car.applyImpact(new THREE.Vector3(car.group.position.x + 2.2, 0.5, car.group.position.z), new THREE.Vector3(-1, 0, 0), 16, 12);
    assert.ok(car.crashed, `car ${i} is a wreck`);
  }
  // A course (the race's road-segment hint and 128 props, none knocked at the start): every keyframe reads them, a replay restores them.
  const rec = new CrashRecorder({ recall: (_i, out) => out.set([-1]), knocks: () => new Uint8Array(16) });
  rec.begin("flat", HANDLING.realism, false, ALL, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit) => rec.pairHit(a, b, hit);
  const graze: ContactHit = { impulse: 2, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) };
  const trace: Float64Array[] = [];
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  let t = 0;
  for (let s = 0; s < STEPS; s++) {
    if (s === JUMP_STEP) cars[JUMPER]!.spawnFacing(IMPACT_X, -400, Math.PI / 2, 12);
    rec.startStep(cars);
    if (s === TOUCH_STEP) rec.pairHit(NEAR, TOUCHER, graze);
    if (s === KNOCK_STEP) {
      rec.knock(OUTSIDE_PROP, FAR);
      rec.knock(INSIDE_PROP, NEAR);
    }
    for (const [i, car] of cars.entries()) {
      input.throttle = i === A || i === B ? 1 : 0.6;
      input.steer = i === NEAR ? 0.3 * Math.sin(t * 4) : 0;
      applyDrive(car, input, H);
    }
    stepWorld(world, H);
    rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
    trace.push(Float64Array.from(cars.flatMap((c) => c.group.position.toArray())));
    t += H;
  }
  rec.end();
  assert.ok(rec.ledger.kept.length >= 1, "the head-on crash did not rank as a highlight");
  const kept = rec.ledger.kept[0]!;
  const w = new Writer(clipBytes(kept));
  writeClip(w, kept);
  return { clip: readClip(new Reader().reset(w.done()), carLayout(cars[0]!)), cars, trace, dress };
}

/** Each clip car's worst distance (m) from where the world's trace had it, over every step of the clip read back and replayed as a peer does. */
function replayWorst({ clip, cars, trace, dress }: Recorded): Map<number, number> {
  // The recorder's clock sums `H` as the record loop did, so the clip's first step is the trace step at `t0`.
  const s0 = Math.round(clip.t0 / H);
  const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, blend: new PoseBlend() });
  sim.restart();
  const worst = new Map<number, number>();
  while (!sim.done) {
    sim.advanceTo(sim.time + 1e-6);
    const row = trace[s0 + sim.step - 1]!;
    for (const { slot } of clip.cars) {
      const p = cars[slot]!.group.position;
      worst.set(slot, Math.max(worst.get(slot) ?? 0, Math.hypot(p.x - row[slot * 3]!, p.y - row[slot * 3 + 1]!, p.z - row[slot * 3 + 2]!)));
    }
  }
  return worst;
}

describe("given a flat-field head-on recorded as a highlight with 19 bystander cars around it (near, far, touching, respawned, wrecked, torn-mirror)", () => {
  let run: Recorded;
  before(() => {
    run = record();
  });

  it("when the clip is read back and replayed, then cars near the hit (and one a bystander touched, and one respawned after the hit) are in the clip and match the sim at every step, and a car 300 m away is not in it", (t) => {
    const { clip } = run;
    const slots = clip.cars.map((c) => c.slot);
    t.diagnostic(`clip cars: ${slots.join(",")} (${(clipBytes(clip) / 1024).toFixed(0)} KB)`);
    assert.ok(slots.includes(A) && slots.includes(B), "the head-on pair is in the clip");
    assert.ok(slots.includes(NEAR), "a car 40 m from the hit is in the clip");
    assert.ok(slots.includes(TOUCHER), "a car that touched a bystander since the clip's start is in the clip, wherever it is");
    assert.ok(slots.includes(JUMPER), "a car 50 m from the hit is in the clip though it is respawned after the impact: a keyframe puts it there");
    assert.ok(!slots.includes(FAR), "a car 300 m away is not in the clip");
    // The recorder's clock sums `H` as this loop did, so the clip's first step is the trace step at `t0`.
    const s0 = Math.round(clip.t0 / H);
    assert.ok(Math.abs(s0 * H - clip.t0) < 1e-9, "the clip starts on a step of the trace");
    const jump = clip.keyStep.indexOf(JUMP_STEP - s0);
    assert.ok(jump > 0 && ((clip.keyCars[jump]! >>> slots.indexOf(JUMPER)) & 1) === 1 && clip.keyCars[jump] === 1 << slots.indexOf(JUMPER), "the respawn has a keyframe of its own, with the respawned car alone");
    const worst = replayWorst(run);
    t.diagnostic([...worst].map(([slot, d]) => `car ${slot}: ${d} m off`).join("\n"));
    assert.deepEqual([...worst.values()].filter((d) => d !== 0), [], "every car of the clip is where the sim had it at every step");
  });

  it("when the clip's byte share is spent on the wrecks 50 to 74 m out, then it takes the nearer wrecks and drops the farther ones", (t) => {
    const taken = WRECKS.filter((i) => run.clip.cars.some((c) => c.slot === i));
    t.diagnostic(`wrecks taken: ${taken.join(",")} of ${WRECKS.join(",")} (${(clipBytes(run.clip) / 1024).toFixed(0)} KB)`);
    assert.ok(taken.length >= 1, "the nearest wreck (50 m) is in the clip");
    assert.ok(taken.length < WRECKS.length, "the farthest wreck (74 m) would take the clip past its share");
    assert.ok(taken.every((slot, k) => slot === WRECKS[k]), "the wrecks taken are the nearest ones");
  });

  it("when the clip is restored, then a car with a torn mirror and no crash gets back its own hit direction, not the zeroed one of its network state", () => {
    const { clip, cars, dress } = run;
    assert.ok(clip.cars.some((c) => c.slot === MIRROR), "the mirror car (45 m from the hit) is in the clip");
    const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, blend: new PoseBlend() });
    sim.restart();
    assert.deepEqual(cars[MIRROR]!.deform.impactInward.toArray(), [0, 0, -1]);
  });

  it("when the clip is restored, then a car with a torn mirror and no crash is drawn in its rest skin, not collapsed by the zero skin inputs of its network state (no bake ever ran for it)", () => {
    const { clip, cars, dress } = run;
    const car = cars[MIRROR]!;
    const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, blend: new PoseBlend() });
    sim.restart();
    assert.ok(car.hasLoosePart() && !car.crashed, "the mirror car is restored with its mirror off and no wreck");
    const drawn = car.body.geometry.getAttribute("position").array as Float32Array;
    const rest = car.deform.restSkin;
    let off = 0;
    for (let i = 0; i < rest.length; i++) off = Math.max(off, Math.abs(drawn[i]! - rest[i]!));
    assert.equal(off, 0, `the body skin is ${off} m off its rest shape at the clip's first frame`);
  });

  it("when the clip is replayed, then a prop that a car outside the clip knocked off its spot is in the clip's knocks and is knocked again at that step, while a clip car's own knock is not", () => {
    const { clip, cars, dress } = run;
    const s0 = Math.round(clip.t0 / H);
    assert.ok(clip.cars.some((c) => c.slot === NEAR) && !clip.cars.some((c) => c.slot === FAR), "NEAR is in the clip and FAR is not");
    const want = JSON.stringify([{ step: KNOCK_STEP - s0, prop: OUTSIDE_PROP }]);
    assert.equal(JSON.stringify(clip.knocks), want);
    const heard: { step: number; prop: number }[] = [];
    const sim: ClipSim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), {
      dress,
      collide: () => {},
      knocks: (bits) => {
        for (let p = 0; p < bits.length * 8; p++) if ((bits[p >> 3]! >> (p & 7)) & 1) heard.push({ step: sim.step, prop: p });
      },
      blend: new PoseBlend(),
    });
    sim.restart();
    assert.equal(heard.length, 0, "no prop is knocked in the first keyframe");
    while (!sim.done) sim.advanceTo(sim.time + 1e-6);
    assert.equal(JSON.stringify(heard), want, "the replay knocks the prop the step the record did, before it runs");
  });
});

/** The stack scene's slots after the head-on pair: a car and, at the higher slot, a car standing on its roof, 300 m from the hit. */
const UNDER = 2;
const ON_TOP = 3;

/** The head-on of `record` with only a two-car stack 300 m out; the head-on's `A` grazes the top car once, inside the clip, so it is dragged in. */
function recordStack(): Recorded {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const cars = Array.from({ length: 4 }, (_, i) => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    return car;
  });
  cars[A]!.spawnFacing(0, 0, Math.PI / 2, 15);
  cars[B]!.spawnFacing(2 * IMPACT_X, 0, -Math.PI / 2, 15);
  const under = cars[UNDER]!;
  const top = cars[ON_TOP]!;
  under.spawnFacing(IMPACT_X, 300, Math.PI / 2, 0);
  top.spawnFacing(IMPACT_X, 300, Math.PI / 2, 0);
  // Its belly 2 cm over the drawn roof below: it settles onto that roof in its first slices and stands there.
  top.group.position.y = under.group.position.y + crownY(under) - keelY(top) + 0.02;
  // What it touches read off that pose, as a scene that places a car reads it (`layOnGround`), and as a keyframe restore does.
  top.restoreContact();
  const rec = new CrashRecorder({ recall: (_i, out) => out.set([-1]), knocks: () => new Uint8Array(16) });
  rec.begin("flat", HANDLING.realism, false, cars.length, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit) => rec.pairHit(a, b, hit);
  // As the race wires it (`RaceDirector.partTouch`).
  world.partTouch = (a, b) => rec.touch(a, b);
  const graze: ContactHit = { impulse: 2, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) };
  const trace: Float64Array[] = [];
  const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
  for (let s = 0; s < STEPS; s++) {
    rec.startStep(cars);
    if (s === TOUCH_STEP) rec.pairHit(A, ON_TOP, graze);
    // Every car takes its input each step, as in a race (and as the replay drives every clip car): the pair full throttle, the stack none.
    for (const [i, car] of cars.entries()) {
      input.throttle = i === A || i === B ? 1 : 0;
      applyDrive(car, input, H);
    }
    stepWorld(world, H);
    rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
    trace.push(Float64Array.from(cars.flatMap((c) => c.group.position.toArray())));
  }
  rec.end();
  assert.ok(rec.ledger.kept.length >= 1, "the head-on crash did not rank as a highlight");
  const kept = rec.ledger.kept[0]!;
  const w = new Writer(clipBytes(kept));
  writeClip(w, kept);
  return { clip: readClip(new Reader().reset(w.done()), carLayout(cars[0]!)), cars, trace, dress };
}

describe("given a flat-field head-on recorded as a highlight while 300 m away a car stands parked on another car's roof, and a car of the head-on grazes the top car", () => {
  it("when the clip is read back and replayed, then the car under the top car is in it with the top car, and both are where the sim had them at every step", (t) => {
    const run = recordStack();
    const slots = run.clip.cars.map((c) => c.slot);
    t.diagnostic(`clip cars: ${slots.join(",")}`);
    assert.ok(slots.includes(ON_TOP), "the grazed top car is in the clip");
    assert.ok(slots.includes(UNDER), "the car the top car stands on is in the clip, 300 m from the hit");
    const worst = replayWorst(run);
    t.diagnostic([...worst].map(([slot, d]) => `car ${slot}: ${d} m off`).join("\n"));
    assert.deepEqual([...worst.values()].filter((d) => d !== 0), [], "every car of the clip is where the sim had it at every step");
  });
});

/** The slots of the arrival scene after the head-on pair: three parked cars 30 to 45 m from the hit, then a pile of six wrecks. */
const PARKED = [2, 3, 4];
const PILE = [5, 6, 7, 8, 9, 10];
/** Where `A` meets `B` (about 4.2 s in: `B` from x = 120 under throttle is at x = 43 when `A` is put on the road at x = 0, 3 s in), and the pile `A` stands in until then: 300 m out. */
const ARRIVE_X = 10;
const PILE_Z = 300;
const ARRIVE_STEP = 3 * 240;
/** The pair meets about 4.2 s in; the clip's post-roll (3 s) closes it before this. */
const ARRIVE_STEPS = 8 * 240;

/** The head-on of `record`, but `A` waits in a wreck pile 300 m out and is put on the road a second before the impact (a respawn into a crash). */
function recordArrival(): Recorded {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const cars = Array.from({ length: 11 }, (_, i) => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    return car;
  });
  cars[A]!.spawnFacing(ARRIVE_X, PILE_Z, Math.PI / 2, 0);
  cars[B]!.spawnFacing(120, 0, -Math.PI / 2, 15);
  for (const [k, i] of PARKED.entries()) cars[i]!.spawnFacing(ARRIVE_X, (k % 2 === 0 ? 30 : -30) + (k >> 1) * 15, Math.PI / 2, 0);
  for (const [k, i] of PILE.entries()) {
    const car = cars[i]!;
    car.spawnFacing(ARRIVE_X + 6 * (k & 1), PILE_Z + 5 + 4 * (k >> 1), Math.PI / 2, 12);
    car.applyImpact(new THREE.Vector3(car.group.position.x + 2.2, 0.5, car.group.position.z), new THREE.Vector3(-1, 0, 0), 16, 12);
    assert.ok(car.crashed, `car ${i} is a wreck`);
  }
  const rec = new CrashRecorder({ recall: (_i, out) => out.set([-1]), knocks: () => new Uint8Array(16) });
  rec.begin("flat", HANDLING.realism, false, cars.length, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit) => rec.pairHit(a, b, hit);
  const trace: Float64Array[] = [];
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  for (let s = 0; s < ARRIVE_STEPS; s++) {
    if (s === ARRIVE_STEP) cars[A]!.spawnFacing(0, 0, Math.PI / 2, 15);
    rec.startStep(cars);
    for (const [i, car] of cars.entries()) {
      input.throttle = i === B || (i === A && s >= ARRIVE_STEP) ? 1 : 0;
      applyDrive(car, input, H);
    }
    stepWorld(world, H);
    rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
    trace.push(Float64Array.from(cars.flatMap((c) => c.group.position.toArray())));
  }
  rec.end();
  assert.ok(rec.ledger.kept.length >= 1, "the head-on crash did not rank as a highlight");
  const kept = rec.ledger.kept[0]!;
  const w = new Writer(clipBytes(kept));
  writeClip(w, kept);
  return { clip: readClip(new Reader().reset(w.done()), carLayout(cars[0]!)), cars, trace, dress };
}

describe("given a head-on whose car A was put on the road a second before the impact, out of a pile of six wrecks 300 m away that it stood in for the clip's first two seconds", () => {
  let arrival: Recorded;
  before(() => {
    arrival = recordArrival();
  });
  it("when the clip is read back and replayed, then the cars parked near the hit are in it, the pile 300 m from the hit is not, and every car is where the sim had it at every step", (t) => {
    const run = arrival;
    const slots = run.clip.cars.map((c) => c.slot);
    t.diagnostic(`clip cars: ${slots.join(",")} (${(clipBytes(run.clip) / 1024).toFixed(0)} KB)`);
    assert.ok(PARKED.every((i) => slots.includes(i)), "the cars parked 30 to 45 m from the hit are in the clip");
    assert.deepEqual(PILE.filter((i) => slots.includes(i)), [], "no wreck of the pile A left is in the clip");
    const worst = replayWorst(run);
    t.diagnostic([...worst].map(([slot, d]) => `car ${slot}: ${d} m off`).join("\n"));
    assert.deepEqual([...worst.values()].filter((d) => d !== 0), [], "every car of the clip is where the sim had it at every step");
  });

  it("when the replay's scene knows where cars wait put away, then A is hidden there from the clip's start to the step its keyframe puts it on the road, and the shots frame a drawn car throughout", () => {
    const { clip, cars, dress } = arrival;
    const j = clip.cars.findIndex((c) => c.slot === A);
    const put = clip.keyStep.findIndex((s, i) => i > 0 && ((clip.keyCars[i]! >>> j) & 1) === 1);
    assert.ok(j >= 0 && put > 0, "A is in the clip and has a keyframe of its own: its respawn");
    const at = clip.keyStep[put]!;
    const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress, collide: () => {}, stored: (_slot, _x, z) => z > PILE_Z - 50, blend: new PoseBlend() });
    sim.restart();
    while (sim.step <= at) {
      assert.equal(cars[A]!.group.visible, false, `A is drawn at step ${sim.step}, before the step ${at} that puts it on the road`);
      assert.ok(sim.cars[sim.subject]!.group.visible, `the shots frame a hidden car at step ${sim.step}`);
      if (clip.focus === j) assert.notEqual(sim.subject, j, "the shots frame A while it waits");
      sim.advanceTo(sim.time + 1e-6);
    }
    assert.equal(cars[A]!.group.visible, true, `A is still hidden after step ${at}, which puts it on the road`);
    assert.equal(sim.subject, clip.focus, "the shots are on the clip's focus once it is on the road");
  });
});
