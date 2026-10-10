import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { FLAT_GROUND, Ground, STEP_UP } from "../world/ground.ts";
import { Corkscrew, CORKSCREW } from "./corkscrew.ts";
import { FleetRamps, RAMP } from "./fleet-ramps.ts";
import { collideOn } from "./ramp-collide.test-util.ts";
import { corkPose, driveOver, shapeCar, skinGap, surfaceInFrame, type DriveSetup, type Held, type Layer, type Run } from "./car-road.test-util.ts";

// docs/UNIFIED_CONTACT.md stage 0: one situation, built from different kinds of object, the same outcome.

const NO_TURN = new THREE.Euler(0, 0, 0, "YXZ");
/** Heading may differ by this much (deg): the doors' own hinge tolerance (`sameParts`). */
const HEADING = 3;

type Tol = { speed?: number; y: number; heading: number; air?: number; land?: number };

/** Where `cars` differs from the real feature, one line each (empty: the same). */
function mismatches(real: Run, cars: Run, tol: Tol): string[] {
  const out: string[] = [];
  const f = (n: number) => n.toFixed(2);
  if (tol.speed !== undefined && Math.abs(cars.speedEnd - real.speedEnd) > tol.speed * real.speedEnd) out.push(`speed ${f(cars.speedEnd)} vs ${f(real.speedEnd)} m/s`);
  if (Math.abs(cars.yMax - real.yMax) > tol.y) out.push(`rise ${f(cars.yMax)} vs ${f(real.yMax)} m`);
  if (Math.abs(cars.headingMax - real.headingMax) > tol.heading) out.push(`heading turn ${f(cars.headingMax)} vs ${f(real.headingMax)} deg`);
  if (cars.crashed !== real.crashed) out.push(`crashed ${cars.crashed} vs ${real.crashed}`);
  if (tol.air !== undefined && Math.abs(cars.airSeconds - real.airSeconds) > tol.air) out.push(`air ${f(cars.airSeconds)} vs ${f(real.airSeconds)} s`);
  if (tol.land !== undefined && real.airSeconds > 0 && cars.airSeconds > 0 && Math.abs(cars.landZ - real.landZ) > tol.land) out.push(`landing z ${f(cars.landZ)} vs ${f(real.landZ)} m`);
  if (cars.wheels.join() !== real.wheels.join()) out.push(`wheels on the feature [${cars.wheels}] vs [${real.wheels}]`);
  return out;
}

/** The same drive over the real feature (`real`) and over `held` on flat ground: what the cars' run does differently. */
function compare(real: DriveSetup, held: readonly Held[], tol: Tol, t: { diagnostic: (m: string) => void }): string[] {
  const a = driveOver(real);
  const b = driveOver({ ...real, ground: FLAT_GROUND, collide: undefined, held });
  t.diagnostic(`real: ${JSON.stringify(a)}\ncars: ${JSON.stringify(b)}`);
  return mismatches(a, b, tol);
}

describe("given a flat strip of ground 0.894 m high over four car lengths, and the same strip built from four held cars pressed to that height", () => {
  const H = 0.894;
  const N = 4;
  const SPACING = 2 * CAR_HALF.z + 0.1;
  const END = N * SPACING - 0.1;
  class Strip extends Ground {
    constructor() {
      super();
      this.addPlane(0, -1e7, 1e7, -1e7, 1e7, Infinity);
      this.addPlane(H, -0.9, 0.9, 0, END, STEP_UP);
    }
  }
  const strip: Ground = new Strip();
  const flat: Layer = { top: () => H, bottom: () => 0 };
  const road = () => Array.from({ length: N }, (_, k) => shapeCar(flat, { pos: new THREE.Vector3(0, 0, CAR_HALF.z + k * SPACING), rot: NO_TURN }));

  it("when each pressed car's drawn top is read against the pressed height, then the skin follows the masses within the skin's 0.2 m", (t) => {
    const [first] = road();
    const gap = skinGap(first!, flat);
    t.diagnostic(`skin vs layer ${gap.toFixed(3)} m`);
    assert.ok(gap <= 0.2, `skin ${gap.toFixed(3)} m off the pressed height`);
  });

  const stripRuns = [
    { v: 8, speed: 7.85 },
    { v: 12, speed: 11.04 },
    { v: 20, speed: 19.46 },
    { v: 28, speed: 27.22 },
  ] as const;
  // The 8 and 12 m/s rows are todo -> Stage 5 (the rigid step's position lift): the lift takes the deepest row out by moving the whole
  // body, so a rear tyre sunk 0.6 m in the strip's face (the nose already up 0.26 rad, the front tyres on the top) lifts the body 0.6 m
  // and the plain sedan's origin rises 1.29 / 1.08 m (bound 0.894 + 0.05). Measured: a lift that shares an appeared row's depth between
  // the centre and the turn (impulse at the point, `reach`) gives 0.91 / 0.89 / 1.03 / 0.94 m at 8 / 12 / 20 / 28 m/s and, run to
  // every row, 0.91 / 0.94 / 0.94 / 0.94 m; both move the settled states of cars resting on a ramp's rear lip (ground-fit: 2 + 2 cells
  // float / pen), loose parts (loose-step 'beside a parked car', equal to the bit) and a monster's head-on crush (car-cage), so it
  // is not taken here. 20 and 28 m/s pass.
  for (const testCase of stripRuns) {
    const row = testCase.v <= 12 ? it.todo : it;
    row(`when a sedan drives onto the strip itself at ${testCase.v} m/s, then it ends at ${testCase.speed} m/s within 5 %, rises to ${H} m within 5 cm, turns within 1 deg and never crashes (the road the cars must match)`, (t) => {
      const run = driveOver({ x: 0, z: -14, v: testCase.v, ground: strip, ref: strip, held: [], seconds: 7, stopZ: END + 6 });
      t.diagnostic(JSON.stringify(run));
      const wrong: string[] = [];
      if (Math.abs(run.speedEnd - testCase.speed) > 0.05 * testCase.speed) wrong.push(`speed ${run.speedEnd.toFixed(2)} m/s`);
      if (Math.abs(run.yMax - H) > 0.05) wrong.push(`rise ${run.yMax.toFixed(2)} m`);
      if (run.headingMax > 1) wrong.push(`heading turn ${run.headingMax.toFixed(2)} deg`);
      if (run.crashed) wrong.push("crashed");
      assert.deepEqual(wrong, []);
    });
  }

  // todo -> Stage 4 item 5 (car-car through the kernel) (the pair on `bodyContact`; owner's call on `WALL_CRUSH` vs a flat-topped flank). Measured on integ/s3-s4a
  // with the whole-body lift: the strip rows 20 / 28 m/s pass (the plain sedan rises 0.91 / 0.89 / 1.03 m at 8 / 12 / 20 with a lever-shared lift). Over the four
  // held cars the driven sedan is struck in its first touch slice: the pair SAT (`satCars` on the cages' plan outlines) answers with an
  // impulse equal to the whole closing speed (7.88 at 8 m/s, driver z -2.05, bumper under the pressed top of 0.894 m), `crashed` is
  // set and it ends at 0.19-0.20 m/s, rise 0.00-0.08 m (strip 7.85 / 11.46 / 19.49 / 27.22 m/s, 0.89-1.03 m). The
  // strip has no flank (a plane top with reach `STEP_UP`: its kerb lifts the bumper rows), the cars' flank is the SAT's, and a body
  // point closing on another car's top at more than `WALL_CRUSH` (5.5 m/s) from the side is the pair's crash by design
  // (`readPoints`, `crossedPlanFromSide`): 8-28 m/s all crash. Experiment: car-top patches given the strip's reach (1.2 m), the tyre
  // `topCap` 1.2 m and the side-entry rule off: the same SAT hit lands in the same slice (7.88) before the rigid step lifts the body.
  for (const v of [8, 12, 20, 28]) {
    it.todo(`when a sedan drives onto each at ${v} m/s, then its speed is within 5 %, it rises within 0.05 m, turns within 1 deg, drives over the same wheel sequence and never crashes`, (t) => {
      const real: DriveSetup = { x: 0, z: -14, v, ground: strip, ref: strip, held: [], seconds: 7, stopZ: END + 6 };
      assert.deepEqual(compare(real, road(), { speed: 0.05, y: 0.05, heading: 1 }, t), []);
    });
  }
});

describe("given the fleet's jump wedge, and a car pressed into its profile and held at its high end", () => {
  const scene = new THREE.Scene();
  const ramps = new FleetRamps(scene);
  ramps.place(0, null);
  const zc = -RAMP.start - CAR_HALF.z;
  const layer: Layer = { top: (z) => ramps.heightAt(0, zc + z), bottom: () => 0 };
  const wedge = () => [shapeCar(layer, { pos: new THREE.Vector3(0, 0, zc), rot: NO_TURN })];

  it("when the drawn top of the pressed car is read against the wedge's, then the skin follows the masses within the skin's 0.2 m", (t) => {
    const gap = skinGap(wedge()[0]!, layer);
    t.diagnostic(`skin vs wedge ${gap.toFixed(3)} m`);
    assert.ok(gap <= 0.2, `skin ${gap.toFixed(3)} m off the wedge`);
  });

  // todo -> Stage 4 item 5 (car-car through the kernel), the same cause as the strip rows above. Measured: the driven sedan's first pair hit is the plan SAT's with an
  // impulse equal to its closing speed (7.88 at 8 m/s, 11.70 at 12 m/s, both at driver z -8.6 m, y 0.00): it ends crashed with rise
  // 0.00-0.01 m (real wedge 1.36 / 1.72 m), air 0.00 s (0.13 / 0.68 s), wheels [4] (real [4,2,0,2,4]).
  for (const v of [8, 12]) {
    it.todo(`when a sedan drives up each at ${v} m/s, then it rises within 0.1 m, stays in the air within 0.1 s, lands within 0.5 m, turns within ${HEADING} deg and touches down on the same wheels`, (t) => {
      // Past the landing: a flight is recorded when it ends, and the 12 m/s jump comes down about 10 m beyond the high end.
      const real: DriveSetup = { x: 0, z: -16, v, ground: ramps, collide: (c, h) => collideOn(ramps)(c, 0, h), ref: ramps, held: [], seconds: 6, stopZ: 30 };
      assert.deepEqual(compare(real, wedge(), { y: 0.1, air: 0.1, land: 0.5, heading: HEADING }, t), []);
    });
  }
});

describe("given the corkscrew channel, and cars pressed into its floor along its length and held", () => {
  const cork = new Corkscrew(new THREE.Scene());
  const PITCH = 2 * CAR_HALF.z + 0.1;
  const floor = () =>
    Array.from({ length: Math.ceil(CORKSCREW.len / PITCH) }, (_, k) => {
      const pose = corkPose(cork, PITCH / 2 + k * PITCH);
      const top = surfaceInFrame((x, z) => cork.heightAt(x, z), pose);
      return shapeCar({ top, bottom: (z) => top(z) - 0.5 }, pose);
    });

  // todo -> Stage 4 item 5 (car-car through the kernel), the same cause as the strip rows, plus one of its own. Measured: the pressed cars lie along the twisting
  // floor with plans that overlap their neighbours, so the pair SAT hits the held cars against each other in the first slice (cars 1-2
  // impulse 0.45, 2-3 impulse 2.30, before any driver contact, driver at z -39.9) and the road crushes itself; the driven sedan never
  // leaves the floor level (crashed at 6 m/s): rise 0.00-0.01 m (real 1.96 / 6.02 / 11.37 / 15.16 m), air 0.00 s (real 0 / 1.42 / 2.47 / 3.00 s).
  for (const v of [6, 14, 22, 27]) {
    it.todo(`when a driverless sedan is launched at ${v} m/s 6 m short of each, then it rises within 0.1 m, stays in the air within 0.1 s, lands within 0.5 m, turns within ${HEADING} deg and touches down on the same wheels`, (t) => {
      const real: DriveSetup = { x: 0, z: CORKSCREW.mouthZ - 6, v, ground: cork, collide: (c) => cork.contact(c), ref: cork, held: [], seconds: 12, coast: true, stopStill: 90 };
      assert.deepEqual(compare(real, floor(), { y: 0.1, air: 0.1, land: 0.5, heading: HEADING }, t), []);
    });
  }
});
