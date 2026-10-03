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
 * A minute of racing: the 2 Hz keyframe encode (`writeSnapshot`) is cold code, so V8 runs it in the
 * interpreter, where every double is boxed, for its first ~20 s; the test measures the steady state after
 * it tiers up. Measured after 10 s: 26–30 B/step (the codec, a few KB per keyframe until tier-up).
 * Under full-suite load the tier-up comes late (63.5 B/step in one 20 s window): the test takes the quietest
 * of `WINDOWS` windows, so a steady per-step allocation still fails every one of them.
 */
const WARM = 14400;
const WINDOWS = 5;
const MEASURE = 1200;
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
    rec.begin("oval", 0.35, false, MAX_CARS, () => "x", 1);
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
  PAIRS.forEach(([a, b], k) => {
    cars[a]!.spawnFacing(0, k * LANE, Math.PI / 2, 15);
    cars[b]!.spawnFacing(40, k * LANE, -Math.PI / 2, 15);
  });
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
    cars.forEach((car, i) => {
      input.throttle = i === 1 ? 0 : 1;
      applyDrive(car, input, H);
    });
    stepWorld(world, H);
    rec.endStep(cars, H);
    settleStep(cars, H, false);
  }
  rec.end();
  return rec.ledger.kept.map((c) => [c.cars[c.firstA]!.slot, ...(c.firstB >= 0 ? [c.cars[c.firstB]!.slot] : [])]);
}

describe("highlight moments by who is involved", () => {
  it("bad: traffic and police make a moment only against a racer; a racer's T-bone on traffic still does", () => {
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

  it("bad: a seeded city race with traffic and police records only moments with a racer in their first impact, and keeps a racer's hit on a cop or traffic car", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      w.race.command({ type: "quit" });
      w.race.command({ type: "options", options: { trackId: "city", laps: 2, aiCount: 8, police: true, noReset: false, aggression: 1 } });
      w.race.reseed(5);
      w.race.command({ type: "start" });
      w.seat.mode = "follow";
      const racers = w.race.racers.length;
      const state = { acc: 0 };
      for (let n = 0; n / 60 < 100 && w.race.phase !== "finished"; n++) frame(w, state);
      w.race.recorder.end();
      const firsts = w.race.recorder.ledger.kept.map((c) => [c.cars[c.firstA]!.slot, c.firstB >= 0 ? c.cars[c.firstB]!.slot : -1] as const);
      assert.ok(firsts.length >= 3, `${firsts.length} clips in 100 s: the field is too quiet to test`);
      assert.deepEqual(
        firsts.filter(([a, b]) => a >= racers && !(b >= 0 && b < racers)),
        [],
        `racers ${racers}: clips whose first impact has no racer: ${JSON.stringify(firsts)}`,
      );
      assert.ok(
        firsts.some(([a, b]) => a < racers && b >= racers),
        `a racer's hit on a cop or traffic car is no moment: ${JSON.stringify(firsts)}`,
      );
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
