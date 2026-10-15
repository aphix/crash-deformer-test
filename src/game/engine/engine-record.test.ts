import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { fleetClass, fleetStyle, MAX_CARS } from "../scenes/fleet.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { CAGES } from "../kernel/rig-spec.ts";
import { CrashRecorder } from "./engine-record.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { setGround } from "../world/ground.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";
import { FINE_HZ } from "../kernel/constants.ts";

const H = 1 / FINE_HZ;
/**
 * Two minutes of racing: the 1 Hz keyframe encode (`writeSnapshot`, `simState`) is cold code, so V8 runs it in the
 * interpreter, where every double is boxed, for its first ~40 s; the test measures the steady state after it tiers up
 * (the keyframes were 2 Hz and the warm-up a minute before `KEY_EVERY` became 1 s: the same number of keyframes).
 * Under full-suite load the tier-up comes late: the test takes the quietest of `WINDOWS` windows, so a steady per-step
 * allocation still fails every one of them.
 */
const WARM = 28800;
const WINDOWS = 5;
const MEASURE = 1200;
/**
 * Heap growth allowed per recorded step (B), summed over positive deltas: JIT and test noise, not a buffer per step.
 * The keyframes' `simState` reads each wreck's scalar fields as plain properties (read by name, V8 boxed every double:
 * ~1050 B a wreck a keyframe, 46.0 B/step at 11 wrecks; now 1.2 B/step), so no wreck allowance remains.
 */
const BOUND_B = 16;

describe(`given the highlight recorder fed a ${MAX_CARS}-car race with a third of the cars wrecked, grinding contacts and a keyframe every second`, () => {
  it("when it records minutes of steady racing with no crash opening, then it allocates no more than 16 bytes per recorded step", () => {
    const scene = new THREE.Scene();
    const cars = Array.from({ length: MAX_CARS }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i)));
    for (const [i, c] of cars.entries()) c.spawnFacing(i * 6, 0, 0, 10);
    // A third are wrecks: every keyframe encodes their netplay wreck section.
    for (let i = 0; i < MAX_CARS; i += 3) cars[i]!.applyImpact(new THREE.Vector3(i * 6, 0.5, 2.2), new THREE.Vector3(0, 0, -1), 16, 12);
    // With a course (the race's road-segment hint and props: every keyframe reads them too), not the flat field's.
    const knocks = new Uint8Array(40);
    const rec = new CrashRecorder({
      recall: (i, out) => {
        out[0] = i;
      },
      knocks: () => knocks,
    });
    rec.begin("oval", 0.35, false, MAX_CARS, () => "x", 1);
    // Grinding contact under the impact bar: the contact path runs, no cluster ever opens.
    const grind: ContactHit = { impulse: 2, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) };
    const step = (): void => {
      rec.startStep(cars);
      for (let i = 0; i + 1 < MAX_CARS; i += 2) rec.pairHit(i, i + 1, grind);
      rec.wallHit(5, 1, 0, 0);
      rec.endStep(cars, H, 0);
    };
    for (let s = 0; s < WARM; s++) step();
    // Read the heap once a recorded second (`memoryUsage` allocates its own result), positive deltas only.
    let perStep = Infinity;
    for (let w = 0; w < WINDOWS; w++) {
      let grown = 0;
      let last = process.memoryUsage().heapUsed;
      for (let s = 0; s < MEASURE; s++) {
        step();
        if (s % 240 !== 239) continue;
        const now = process.memoryUsage().heapUsed;
        if (now > last) grown += now - last;
        last = now;
      }
      perStep = Math.min(perStep, grown / MEASURE);
    }
    if (process.env.ALLOC_PRINT) console.log(`recorder: ${perStep.toFixed(1)} B/step`);
    assert.equal(rec.ledger.open.length, 0, "no cluster opened: this measures the steady state");
    assert.ok(perStep <= BOUND_B, `${perStep.toFixed(1)} B per recorded step > ${BOUND_B}: the recorder allocates in steady state`);
  });
});

/** Slots of the field below: two racers, then traffic, then police (`CrashRecorder.begin`'s `racers`). */
const RACERS = 2;
/** Each head-on pair (or the T-bone) has a lane of its own, this far apart (m): no cluster joins another. */
const LANE = 200;
const PAIRS: readonly (readonly [number, number])[] = [
  [7, 8], // cop and cop
  [2, 3], // traffic and traffic
  [9, 4], // cop and traffic
];
/** A racer (slot 0) crossing traffic car 6's way: a T-bone. Traffic car 5 drives alone and is told it hit a wall. */
const TBONE = [0, 6] as const;
const WALLER = 5;
/** The second racer (slot 1) and a police car (slot 10) drive head-on at each other. */
const RACER_HIT = [1, 10] as const;

/** The slots of the first impact of each clip an 11-car flat-field field records, once for each count in `racers` (how many of the cars are racers). */
function firstImpacts(racers: readonly number[]): number[][][] {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const cars = Array.from({ length: 11 }, (_, i) => {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i));
    assignClass(car, fleetClass(i));
    dress(car);
    return car;
  });
  for (const [k, [a, b]] of PAIRS.entries()) {
    cars[a]!.spawnFacing(0, k * LANE, Math.PI / 2, 15);
    cars[b]!.spawnFacing(40, k * LANE, -Math.PI / 2, 15);
  }
  const z = PAIRS.length * LANE;
  cars[TBONE[0]]!.spawnFacing(0, z, Math.PI / 2, 15);
  cars[TBONE[1]]!.spawnFacing(20, z - 20, 0, 15);
  cars[WALLER]!.spawnFacing(0, z + LANE, Math.PI / 2, 15);
  cars[RACER_HIT[0]]!.spawnFacing(0, z + 2 * LANE, Math.PI / 2, 15);
  cars[RACER_HIT[1]]!.spawnFacing(40, z + 2 * LANE, -Math.PI / 2, 15);
  // One sim, a recorder for each count of racers: they see the same crashes.
  const recs = racers.map((n) => {
    const rec = new CrashRecorder();
    rec.begin("flat", HANDLING.realism, false, n, (i) => `c${i}`, 1);
    return rec;
  });
  const world = newWorld(cars);
  world.pairHit = (a, b, hit) => {
    for (const rec of recs) rec.pairHit(a, b, hit);
  };
  const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
  for (let s = 0; s < 6 * 240; s++) {
    for (const rec of recs) rec.startStep(cars);
    if (s === 2 * 240) for (const rec of recs) rec.wallHit(WALLER, 40, 30, z + LANE);
    for (const car of cars) applyDrive(car, input, H);
    stepWorld(world, H);
    for (const rec of recs) rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
  }
  return recs.map((rec) => {
    rec.end();
    return rec.ledger.kept.map((c) => [c.cars[c.firstA]!.slot, ...(c.firstB >= 0 ? [c.cars[c.firstB]!.slot] : [])]);
  });
}

describe("given an eleven-car flat field where traffic and police cars crash among themselves and into a wall, one racer T-bones a traffic car and a cop hits another racer head-on", () => {
  it("when only the first two cars count as racers, then the T-bone and the cop's hit are the only highlight moments, though with every car a racer the cop pair, traffic pair, cop-on-traffic and wall hits are moments too", () => {
    // Control: with every car a racer the same field records the cop pair, the traffic pair, a cop on traffic and a wall hit.
    const both = firstImpacts([MAX_CARS, RACERS]);
    const every = both[0]!;
    assert.ok(every.some((c) => c.includes(7) && c.includes(8)), `the cop pair is no moment even with every car a racer: ${JSON.stringify(every)}`);
    assert.ok(every.some((c) => c.includes(2) && c.includes(3)), "the traffic pair is no moment even with every car a racer");
    assert.ok(every.some((c) => c.includes(9) && c.includes(4)), "the cop-on-traffic hit is no moment even with every car a racer");
    assert.ok(every.some((c) => c.length === 1 && c[0] === WALLER), "the traffic car's wall hit is no moment even with every car a racer");
    assert.ok(every.some((c) => c.includes(RACER_HIT[0]) && c.includes(RACER_HIT[1])), "the cop's hit on the racer is no moment even with every car a racer");
    const field = both[1]!;
    assert.equal(field.length, 2, `the racer's T-bone and the cop's hit on the racer are the only moments: ${JSON.stringify(field)}`);
    assert.ok(field.some((c) => c.includes(TBONE[0]) && c.includes(TBONE[1])), `the T-bone is a moment: ${JSON.stringify(field)}`);
    assert.ok(field.some((c) => c.includes(RACER_HIT[0]) && c.includes(RACER_HIT[1])), `the cop's hit on the racer is a moment: ${JSON.stringify(field)}`);
  });
});

describe("given a city race with 8 AI, traffic and police", () => {
  it("when the race starts, then its recorder counts the entrants as the racers, so the traffic and police cars beyond them make a moment only against a racer", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "quit" });
      w.race.command({ type: "options", options: { trackId: "city", laps: 2, aiCount: 8, police: true, noReset: false, aggression: 1 } });
      w.race.reseed(5);
      w.race.command({ type: "start" });
      const racers = w.race.racers.length;
      assert.equal(racers, 9, "the player and the 8 AI are the entrants");
      assert.ok(w.live().length > racers, `${w.live().length} cars on the road: no traffic or police beyond the ${racers} racers`);
      assert.equal(w.race.recorder["racers"], racers);
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given a racer that hits a cop, and the cop being destroyed later", () => {
  it("when it dies 1 s after the hit, then the death joins the racer's highlight, and when it dies 2 s after (past the 1.5 s quiet gap), then it joins nothing and opens no highlight of its own", () => {
    const scene = new THREE.Scene();
    const cars = Array.from({ length: 3 }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i)));
    for (const [i, c] of cars.entries()) c.spawnFacing(i * 6, 0, 0, 0);
    const run = (killAt: number): { open: number; kills: number } => {
      cars[2]!.deform.drivetrainAlive = true;
      const rec = new CrashRecorder();
      rec.begin("oval", HANDLING.realism, false, 2, (i) => `c${i}`, 1);
      const hit: ContactHit = { impulse: 20, contact: new THREE.Vector3(), normal: new THREE.Vector3(1, 0, 0) };
      for (let s = 0; s <= Math.round(killAt / H); s++) {
        rec.startStep(cars);
        if (s === 0) rec.pairHit(0, 2, hit);
        if (s === Math.round(killAt / H)) cars[2]!.deform.drivetrainAlive = false;
        rec.endStep(cars, H, 0);
      }
      return { open: rec.ledger.open.length, kills: rec.ledger.open.reduce((n, c) => n + c.kills, 0) };
    };
    // Control: 1 s after the racer's hit on the cop (inside QUIET_GAP) the cop's death joins the racer's cluster.
    assert.deepEqual(run(1), { open: 1, kills: 1 }, "a kill inside QUIET_GAP joins the cluster");
    // 2 s after: the cluster is still open (POST_ROLL) but an impact would not join it, so neither does the kill.
    assert.deepEqual(run(2), { open: 1, kills: 0 }, "a kill past QUIET_GAP opened a cluster of its own: a clip starting on a non-crash");
  });
});

/** A fresh car's nose took an impact 2 m ahead (`speed` m/s), then 50 steps on: cages moved, `massActive`. */
function crashed(car: DeformableCar, speed: number): void {
  car.group.updateMatrixWorld(true);
  const hit = car.group.position.clone().addScaledVector(car.forward, 2.05);
  hit.y = 0.4;
  car.applyImpact(hit, car.forward.clone().negate(), speed, speed);
  for (let s = 0; s < 50; s++) car.step(H);
}

/** The plain definition of each cage's strain, read off the car's own cages. */
function plainStrain(car: DeformableCar): number[] {
  return CAGES.map((c) => {
    const cage = car.deform["cageByPart"].get(c.name)!;
    let max = 0;
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) max = Math.max(max, Math.abs(cage.corners[a]!.distanceTo(cage.corners[b]!) - cage.restCorners[a]!.distanceTo(cage.restCorners[b]!)));
    }
    return max;
  });
}

describe("given a car the recorder read while crashed, then respawned with the recorder off and crashed gently up to the same corner serial", () => {
  /** The recorder with the first crash's row cached, the car crashed again, and the first row. */
  function setup(): { rec: CrashRecorder; car: DeformableCar; rowA: Float32Array } {
    const car = new DeformableCar({ body: 0x808080, accent: 0, name: "c0" }, new THREE.Scene(), null, fleetStyle(0));
    car.spawn(0, 0, 0);
    const rec = new CrashRecorder();
    rec.begin("oval", HANDLING.realism, false, 1, () => "c0", 1);
    crashed(car, 40);
    const rowA = new Float32Array(CAGES.length);
    rec["readStrain"](car, rowA, 0, 0);
    const serialA = car.deform.cornerSerial;
    car.spawn(0, 0, 0);
    assert.equal(car.deform.massActive, false, "the respawn left no wreck");
    car.group.updateMatrixWorld(true);
    const hit = car.group.position.clone().addScaledVector(car.forward, 2.05);
    hit.y = 0.4;
    car.applyImpact(hit, car.forward.clone().negate(), 15, 15);
    for (let s = 0; s < 2400 && car.deform.cornerSerial < serialA; s++) car.step(H);
    assert.ok(car.deform.massActive && car.deform.cornerSerial >= serialA, "the gentle crash reached the cached serial");
    return { rec, car, rowA };
  }

  it("when the recorder begins again and reads the car, then the row is the second crash's", () => {
    const { rec, car, rowA } = setup();
    rec.begin("oval", HANDLING.realism, false, 1, () => "c0", 1);
    const rowB = new Float32Array(CAGES.length);
    rec["readStrain"](car, rowB, 0, 0);
    const plain = plainStrain(car);
    for (let k = 0; k < CAGES.length; k++) assert.ok(Math.abs(rowB[k]! - plain[k]!) < 1e-6, `cage ${CAGES[k]!.name}: ${rowB[k]} != ${plain[k]}`);
    assert.ok(rowB.some((v, k) => v !== rowA[k]), "the second crash's row differs from the first's");
  });

  it("when a step starts after the respawn without a new begin, then the step's strain row is the second crash's", () => {
    const { rec, car, rowA } = setup();
    rec.startStep([car]);
    const rowB = rec["strainPre"].subarray(0, CAGES.length);
    const plain = plainStrain(car);
    for (let k = 0; k < CAGES.length; k++) assert.ok(Math.abs(rowB[k]! - plain[k]!) < 1e-6, `cage ${CAGES[k]!.name}: ${rowB[k]} != ${plain[k]}`);
    assert.ok(rowB.some((v, k) => v !== rowA[k]), "the second crash's row differs from the first's");
  });
});

describe("given a crashed car the recorder tracks, whose engine is then killed from outside the crash sim (`DeformableCar.disable`: a guard's gunfire)", () => {
  /** The recorder after a few steps with `cars[0]` a crashed wreck (its strain baseline held) and `cars[1]` a running car. */
  function setup(): { rec: CrashRecorder; cars: DeformableCar[]; firstKey: number } {
    const scene = new THREE.Scene();
    const cars = Array.from({ length: 2 }, (_, i) => new DeformableCar({ body: 0x808080, accent: 0, name: `c${i}` }, scene, null, fleetStyle(i)));
    cars[0]!.spawn(0, 0, 0);
    cars[1]!.spawn(20, 0, 0);
    crashed(cars[0]!, 30);
    const rec = new CrashRecorder();
    rec.begin("oval", HANDLING.realism, false, 2, (i) => `c${i}`, 1);
    for (let s = 0; s < 5; s++) {
      rec.startStep(cars);
      rec.endStep(cars, H, 0);
    }
    assert.equal(rec["strainCar"][0], cars[0], "the wreck's strain baseline is held");
    assert.equal(rec["keyCount"], 1, "one keyframe (the first step's)");
    return { rec, cars, firstKey: rec["keyStep"][0]! };
  }

  it("when the next step starts, then the kill step is keyed, the wreck keeps its strain baseline and no car is marked as arrived", () => {
    const { rec, cars, firstKey } = setup();
    cars[0]!.disable();
    rec.startStep(cars);
    assert.equal(rec["keyCount"], 2, "the kill step is keyed");
    assert.equal(rec["strainCar"][0], cars[0], "the strain baseline survives (the car was not put anywhere)");
    assert.equal(rec["keyPlaced"][1], 0, "no car was put on a spot in the kill step's keyframe");
    assert.equal(rec["keyShot"][1], 1, "the shot car is the keyframe's");
    assert.equal(rec["arrivedAt"](0, Infinity, 0), firstKey, "the shot car arrived at its first keyframe, not at the kill");
  });
});
