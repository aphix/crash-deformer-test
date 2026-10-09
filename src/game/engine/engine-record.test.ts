import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { fleetClass, fleetStyle, MAX_CARS } from "../scenes/fleet.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { CrashRecorder } from "./engine-record.ts";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { assignClass, HANDLING } from "../vehicle/vehicle-classes.ts";
import { frame, makeWorld } from "../world/race-world.test-util.ts";
import { setGround } from "../world/ground.ts";
import { newWorld, settleStep, stepWorld } from "./world-step.ts";

const H = 1 / 240;
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
      for (let i = 0; i + 1 < MAX_CARS; i += 2) rec.pairHit(i, i + 1, grind, true);
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

/** The slots of the first impact of each clip a 10-car flat-field field records, `racers` of them racers. */
function firstImpacts(racers: number): number[][] {
  const { dress } = makeWorld();
  const scene = new THREE.Scene();
  const cars = Array.from({ length: 10 }, (_, i) => {
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
  cars[1]!.spawnFacing(0, z + 2 * LANE, Math.PI / 2, 0);
  const rec = new CrashRecorder();
  rec.begin("flat", HANDLING.realism, false, racers, (i) => `c${i}`, 1);
  const world = newWorld(cars);
  world.pairHit = (a, b, hit, first) => rec.pairHit(a, b, hit, first);
  const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
  for (let s = 0; s < 6 * 240; s++) {
    rec.startStep(cars);
    if (s === 2 * 240) rec.wallHit(WALLER, 40, 30, z + LANE);
    for (const [i, car] of cars.entries()) {
      input.throttle = i === 1 ? 0 : 1;
      applyDrive(car, input, H);
    }
    stepWorld(world, H);
    rec.endStep(cars, H, world.shape);
    settleStep(cars, H, false);
  }
  rec.end();
  return rec.ledger.kept.map((c) => [c.cars[c.firstA]!.slot, ...(c.firstB >= 0 ? [c.cars[c.firstB]!.slot] : [])]);
}

describe("given a ten-car flat field where traffic and police cars crash among themselves and into a wall, and one racer T-bones a traffic car", () => {
  it("when only the first two cars count as racers, then the T-bone is the only highlight moment, though with every car a racer the cop pair, traffic pair, cop-on-traffic and wall hits are moments too", () => {
    // Control: with every car a racer the same field records the cop pair, the traffic pair, a cop on traffic and a wall hit.
    const every = firstImpacts(MAX_CARS);
    assert.ok(every.some((c) => c.includes(7) && c.includes(8)), `the cop pair is no moment even with every car a racer: ${JSON.stringify(every)}`);
    assert.ok(every.some((c) => c.includes(2) && c.includes(3)), "the traffic pair is no moment even with every car a racer");
    assert.ok(every.some((c) => c.includes(9) && c.includes(4)), "the cop-on-traffic hit is no moment even with every car a racer");
    assert.ok(every.some((c) => c.length === 1 && c[0] === WALLER), "the traffic car's wall hit is no moment even with every car a racer");
    const field = firstImpacts(RACERS);
    assert.equal(field.length, 1, `the racer's T-bone alone is a moment: ${JSON.stringify(field)}`);
    assert.ok(field[0]![0] === TBONE[0] && field[0]![1] === TBONE[1], `the one moment is the T-bone: ${JSON.stringify(field)}`);
  });
});

/** Seeds tried, in order, until the clips pooled reach `MIN_CLIPS`: how busy a seeded race is moves with every trajectory change, the bars below do not. */
const SEEDS = [5, 6, 7, 8, 9, 10, 11, 12];
const MIN_CLIPS = 3;

/** A seeded 100 s city race with 8 AI, traffic and police, watched in follow mode: its racer count and the (first car, second car or -1) of each kept clip's first impact. */
function cityClips(seed: number): { racers: number; firsts: (readonly [number, number])[] } {
  const w = makeWorld();
  w.race.enter();
  try {
    w.race.command({ type: "quit" });
    w.race.command({ type: "options", options: { trackId: "city", laps: 2, aiCount: 8, police: true, noReset: false, aggression: 1 } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    w.seat.mode = "follow";
    const racers = w.race.racers.length;
    const state = { acc: 0 };
    for (let n = 0; n / 60 < 100 && w.race.phase !== "finished"; n++) frame(w, state);
    w.race.recorder.end();
    return { racers, firsts: w.race.recorder.ledger.kept.map((c) => [c.cars[c.firstA]!.slot, c.firstB >= 0 ? c.cars[c.firstB]!.slot : -1] as const) };
  } finally {
    w.race.exit();
    setGround(null);
  }
}

describe("given seeded 100 s city races with 8 AI, traffic and police, watched in follow mode, until their clips reach three", () => {
  it("when the highlight clips are listed, then at least 3 exist, every one has a racer in its first impact, and at least one is a racer hitting a cop or traffic car", () => {
    const pooled: { seed: number; racers: number; firsts: (readonly [number, number])[] }[] = [];
    for (const seed of SEEDS) {
      pooled.push({ seed, ...cityClips(seed) });
      if (pooled.reduce((n, r) => n + r.firsts.length, 0) >= MIN_CLIPS) break;
    }
    const total = pooled.reduce((n, r) => n + r.firsts.length, 0);
    assert.ok(total >= MIN_CLIPS, `${total} clips in ${pooled.length} races of 100 s: the field is too quiet to test`);
    for (const { seed, racers, firsts } of pooled) {
      assert.deepEqual(
        firsts.filter(([a, b]) => a >= racers && !(b >= 0 && b < racers)),
        [],
        `seed ${seed}, racers ${racers}: clips whose first impact has no racer: ${JSON.stringify(firsts)}`,
      );
    }
    assert.ok(
      pooled.some(({ racers, firsts }) => firsts.some(([a, b]) => a < racers && b >= racers)),
      `a racer's hit on a cop or traffic car is no moment: ${JSON.stringify(pooled)}`,
    );
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
        if (s === 0) rec.pairHit(0, 2, hit, true);
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
