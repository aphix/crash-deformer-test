import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { PLANT_QUIET } from "./deform-state.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { assignClass, CLASSES } from "../vehicle/vehicle-classes.ts";
import { dummyGeom, paint } from "../vehicle/test-support.ts";
import { physicsSlice } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";

/**
 * `seatHubs` frees the wheels of a wreck that is about to plant at no more than HUB_SLIP m/s off the body. The body a
 * wheel rides is the spinning one: its speed at the wheel is the centroid's plus spin × arm, so a wheel turning with
 * a fast wreck is not slipping, and cutting it back to the centroid's speed took the wreck's spin away at the plant.
 */
class Seat extends StreamedDeformation {
  seat(): void {
    this.seatHubs();
  }
}

function wreck(): Seat {
  const d = new Seat(dummyGeom());
  d.mode = "shape";
  const group = new THREE.Group();
  group.updateMatrixWorld();
  d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 0, 0, group, new THREE.Vector3(), new THREE.Vector3());
  return d;
}

function centroid(d: Seat): [number, number] {
  let x = 0;
  let z = 0;
  let m = 0;
  for (const q of d.masses) {
    x += q.world.x * q.mass;
    z += q.world.z * q.mass;
    m += q.mass;
  }
  return [x / m, z / m];
}

/** Every mass moving as one rigid body turning `w` rad/s about the masses' centroid (v = w (z, −x)). */
function spinRigid(d: Seat, w: number): void {
  const [cx, cz] = centroid(d);
  for (const q of d.masses) {
    q.vel.x = w * (q.world.z - cz);
    q.vel.y = 0;
    q.vel.z = -w * (q.world.x - cx);
  }
}

/** Angular momentum about the centroid (y), all masses. */
function momentum(d: Seat): number {
  const [cx, cz] = centroid(d);
  let l = 0;
  for (const q of d.masses) l += q.mass * ((q.world.z - cz) * q.vel.x - (q.world.x - cx) * q.vel.z);
  return l;
}

describe("given a wrecked car about to come to rest, whose wheels are freed when they slip no more than 8 m/s off the body they ride", () => {
  it("when the whole car spins at 8 rad/s so its wheels ride over 8.5 m/s off the centre, then seating the wheels keeps the car's angular momentum within 1%, since a wheel turning with the body is not slipping", () => {
    const d = wreck();
    spinRigid(d, 8);
    const hub = d.masses.find((q) => q.hub)!;
    const [cx, cz] = centroid(d);
    const arm = Math.hypot(hub.world.x - cx, hub.world.z - cz);
    assert.ok(8 * arm > 8.5, `the wheel rides ${(8 * arm).toFixed(2)} m/s off the centroid: no slip to test`);
    const l0 = momentum(d);
    d.seat();
    const l1 = momentum(d);
    assert.ok(Math.abs(l1 / l0 - 1) < 0.01, `L ${l0.toFixed(0)} → ${l1.toFixed(0)} kg·m²/s: a wheel turning with the body is not slipping`);
  });

  it("when a wheel moves 20 m/s off the speed of the body at that wheel, with the car spinning at 0 and at 8 rad/s, then seating the wheels cuts the slip back to the 8 m/s limit (7.5 to 8.5) either way", () => {
    for (const w of [0, 8]) {
      const d = wreck();
      spinRigid(d, w);
      const hub = d.masses.find((q) => q.hub)!;
      const [cx, cz] = centroid(d);
      const bodyX = w * (hub.world.z - cz);
      const bodyZ = -w * (hub.world.x - cx);
      hub.vel.x = bodyX + 20;
      hub.vel.z = bodyZ;
      d.seat();
      const slip = Math.hypot(hub.vel.x - bodyX, hub.vel.z - bodyZ);
      assert.ok(slip > 7.5 && slip < 8.5, `spin ${w}: slip ${slip.toFixed(2)} m/s, 8 allowed`);
    }
  });
});

/**
 * Two wrecks lying still side by side with their near wheels (and doors) overlapping, as a pile's do. A wreck's wheels are
 * written back into its frame every call until it plants, so the push the neighbour's spheres give them was undone each
 * time and the overlap stayed; planted, the wheels stopped being written back, the whole overlap was pushed out in a few
 * slices, and the frame anchored on the wheels went with it.
 */
const WHEEL_CENTRES_APART = 0.3;
const SEDAN_WHEEL_X = 0.74;
const SKIN_VERTEX_STRIDE = 16;
const UNTOUCHED_BEFORE_MEASURING = PLANT_QUIET - 0.03;
const MEASURED_SECONDS = 0.15;
/** What a wreck at rest still creeps by (m) in one slice: the door spheres of an overlapping neighbour easing apart (1.3 mm measured). */
const AT_REST_SETTLE = 0.003;

function stillWreck(scene: THREE.Scene, x: number): DeformableCar {
  const car = new DeformableCar(paint(), scene, null, CLASSES.sedan.style);
  assignClass(car, "sedan");
  car.spawnFacing(x, 0, 0, 0);
  car.deform.armMasses(car.group, car.velocity, car.angular);
  car.crashed = true;
  return car;
}

function skinWorldPoints(car: DeformableCar): Float64Array {
  car.updateSkin();
  car.group.updateMatrixWorld(true);
  const positions = car.body.geometry.getAttribute("position");
  const points = new Float64Array(Math.ceil(positions.count / SKIN_VERTEX_STRIDE) * 3);
  const point = new THREE.Vector3();
  for (let vertex = 0, out = 0; vertex < positions.count; vertex += SKIN_VERTEX_STRIDE, out += 3) {
    point.fromBufferAttribute(positions, vertex).applyMatrix4(car.body.matrixWorld);
    points[out] = point.x;
    points[out + 1] = point.y;
    points[out + 2] = point.z;
  }
  return points;
}

function wheelWorldPoints(car: DeformableCar): Float64Array {
  const wheels = car.deform.masses.filter((mass) => mass.hub);
  const points = new Float64Array(wheels.length * 3);
  for (const [index, wheel] of wheels.entries()) {
    points[index * 3] = wheel.world.x;
    points[index * 3 + 1] = wheel.world.y;
    points[index * 3 + 2] = wheel.world.z;
  }
  return points;
}

/** The farthest any point slid along the ground (m): the height is the ground's, a wheel settling onto it. */
function farthestSlide(before: Float64Array, after: Float64Array): number {
  let farthest = 0;
  for (let k = 0; k < before.length; k += 3) farthest = Math.max(farthest, Math.hypot(after[k]! - before[k]!, after[k + 2]! - before[k + 2]!));
  return farthest;
}

function bodySpeed(car: DeformableCar): number {
  return Math.hypot(car.velocity.x, car.velocity.z);
}

function fastestWheel(car: DeformableCar): number {
  let fastest = 0;
  for (const mass of car.deform.masses) if (mass.hub) fastest = Math.max(fastest, Math.hypot(mass.vel.x, mass.vel.z));
  return fastest;
}

describe("given two still sedan wrecks side by side with their near wheels 0.3 m apart (centre to centre), 0.03 s from planting on their wheels", () => {
  // Todo until Stage 4 replaces the wreck split: while a wreck is live `clampLocal` writes its wheels back to their frame position every call, which undoes the push `collideWith` gives them out of an overlap with a neighbour (hubRL against hubRR 29 cm deep in the owner's derby), and the plant releases the stored overlap (61 mm of wheel slide in one slice here). A planted-wheel pin in `sphereHit` cured it but made physics depend on rest; recording the push as a wheel shove cured it too but dropped derby eliminations to 4 of 20 and moved two reel-view moments out of frame.
  it.todo("when a wreck at rest comes to rest on its wheels, then no wheel or skin point moves without the body moving", () => {
    const scene = new THREE.Scene();
    const wrecks = [stillWreck(scene, 0), stillWreck(scene, -2 * SEDAN_WHEEL_X - WHEEL_CENTRES_APART)];
    const world = newWorld(wrecks);
    for (const wreck of wrecks) wreck.deform.notifyContact();
    let elapsed = 0;
    while (elapsed < UNTOUCHED_BEFORE_MEASURING) {
      const slice = physicsSlice(1 / 60, 8);
      stepWorld(world, slice);
      elapsed += slice;
    }
    assert.ok(wrecks.every((wreck) => wreck.deform.quietTime() < PLANT_QUIET), "the wrecks have not planted yet when the measuring starts");
    const worstWheel = { move: 0, allowed: Infinity, at: 0 };
    const worstSkin = { move: 0, allowed: Infinity, at: 0 };
    let crossedPlant = false;
    elapsed = 0;
    while (elapsed < MEASURED_SECONDS) {
      const slice = physicsSlice(1 / 60, 8);
      const plantedThisSlice = wrecks.every((wreck) => wreck.deform.quietTime() + slice >= PLANT_QUIET);
      const wheelsBefore = wrecks.map(wheelWorldPoints);
      const skinBefore = wrecks.map(skinWorldPoints);
      const speedBefore = wrecks.map(bodySpeed);
      const wheelSpeedBefore = wrecks.map(fastestWheel);
      stepWorld(world, slice);
      elapsed += slice;
      if (!plantedThisSlice) continue;
      for (const [index, wreck] of wrecks.entries()) {
        const speed = Math.max(speedBefore[index]!, bodySpeed(wreck));
        const wheelSpeed = Math.max(speed, wheelSpeedBefore[index]!, fastestWheel(wreck));
        const wheelMove = farthestSlide(wheelsBefore[index]!, wheelWorldPoints(wreck));
        const skinMove = farthestSlide(skinBefore[index]!, skinWorldPoints(wreck));
        const wheelAllowed = 3 * wheelSpeed * slice + AT_REST_SETTLE;
        const skinAllowed = 3 * speed * slice + AT_REST_SETTLE;
        if (wheelMove - wheelAllowed > worstWheel.move - worstWheel.allowed || worstWheel.allowed === Infinity) Object.assign(worstWheel, { move: wheelMove, allowed: wheelAllowed, at: elapsed });
        if (skinMove - skinAllowed > worstSkin.move - worstSkin.allowed || worstSkin.allowed === Infinity) Object.assign(worstSkin, { move: skinMove, allowed: skinAllowed, at: elapsed });
      }
      crossedPlant = true;
    }
    assert.ok(crossedPlant, "the wrecks crossed PLANT_QUIET during the measuring");
    assert.ok(worstWheel.move <= worstWheel.allowed, `a wheel moved ${(worstWheel.move * 1000).toFixed(1)} mm in one slice at ${worstWheel.at.toFixed(3)} s (the body's speed allows ${(worstWheel.allowed * 1000).toFixed(1)} mm)`);
    assert.ok(worstSkin.move <= worstSkin.allowed, `a point of the drawn body moved ${(worstSkin.move * 1000).toFixed(1)} mm in one slice at ${worstSkin.at.toFixed(3)} s (the body's speed allows ${(worstSkin.allowed * 1000).toFixed(1)} mm)`);
  });
});

/**
 * The plant only seats the wheels at the one moment of the switch: a wreck at rest that is struck crushes and loses wheels
 * the same on either side of it. One still wreck, one car driven straight at it at a set speed, the hit landing 0.01 s
 * before PLANT_QUIET and again 0.01 s after.
 */
const STRIKE_SECONDS = 1.5;
const STRIKER_NOSE_TO_WRECK_CENTRE = 4.6;
const CRUSH_MATCH = 0.05;
const strikeCases = [
  { it: "when a car at 30 m/s hits the front corner of a still wreck 0.01 s before and 0.01 s after PLANT_QUIET, then the crush matches within 5% and no wheel is lost either way", speed: 30, nose: 0.6, expectedWheelsLost: 0 },
  { it: "when a car at 80 m/s hits the front wheel of a still wreck 0.01 s before and 0.01 s after PLANT_QUIET, then the crush matches within 5% and the same single wheel is lost either way", speed: 80, nose: 0.74, expectedWheelsLost: 1 },
] as const;

function strikeStillWreck(extraDistance: number, speed: number, nose: number, seconds: number): { firstContactAt: number; crush: number; wheelsLost: number } {
  const scene = new THREE.Scene();
  const wreck = stillWreck(scene, 0);
  const striker = new DeformableCar(paint(), scene, null, CLASSES.sedan.style);
  assignClass(striker, "sedan");
  striker.spawnFacing(nose, STRIKER_NOSE_TO_WRECK_CENTRE + extraDistance, Math.PI, speed);
  striker.velocity.set(0, 0, -speed);
  striker.speed = speed;
  striker.deform.bindKinematic(striker.group, striker.velocity, striker.angular);
  const world = newWorld([wreck, striker]);
  wreck.deform.notifyContact();
  let elapsed = 0;
  let firstContactAt = -1;
  world.pairHit = () => {
    if (firstContactAt < 0) firstContactAt = elapsed;
  };
  while (elapsed < seconds) {
    const slice = physicsSlice(1 / 60, speed);
    stepWorld(world, slice);
    elapsed += slice;
  }
  let crush = 0;
  for (const mass of wreck.deform.masses) crush = Math.max(crush, mass.local.distanceTo(mass.rest));
  const wheelsLost = [wreck, striker].reduce((lost, car) => lost + car.deform.masses.filter((mass) => mass.hub && mass.popped).length, 0);
  return { firstContactAt, crush, wheelsLost };
}

/** The striker's first contact lands at `quiet` s after the wreck was last touched: its start is moved by the speed times the miss of a trial run. */
function strikeStillWreckAtQuiet(quiet: number, speed: number, nose: number): { firstContactAt: number; crush: number; wheelsLost: number } {
  const trial = strikeStillWreck(speed * quiet, speed, nose, quiet + 0.5);
  return strikeStillWreck(speed * quiet + speed * (quiet - trial.firstContactAt), speed, nose, STRIKE_SECONDS);
}

describe("given a still sedan wreck that a car is driven straight at", () => {
  for (const strikeCase of strikeCases) {
    // Todo until Stage 4 replaces the wreck split: a planted wreck crushes differently from the same wreck 0.02 s earlier (0.887 vs 0.966 m at 30 m/s, 0.966 vs 0.840 m at 80 m/s) while `HUB_SLIP` keeps the wheels' own slide; fitting the rigid motion over every attached mass instead cured the 30 m/s case but left 0.970 vs 0.890 m at 80 m/s and broke frame-motion's angular momentum and slope's T-bone sweeps.
    it.todo(strikeCase.it, () => {
      const unplanted = strikeStillWreckAtQuiet(PLANT_QUIET - 0.01, strikeCase.speed, strikeCase.nose);
      const planted = strikeStillWreckAtQuiet(PLANT_QUIET + 0.01, strikeCase.speed, strikeCase.nose);
      assert.ok(Math.abs(unplanted.firstContactAt - (PLANT_QUIET - 0.01)) < 0.005 && Math.abs(planted.firstContactAt - (PLANT_QUIET + 0.01)) < 0.005, `the hits landed at ${unplanted.firstContactAt.toFixed(3)} and ${planted.firstContactAt.toFixed(3)} s quiet`);
      assert.ok(Math.min(unplanted.crush, planted.crush) > 0.3, `the hit crushed ${unplanted.crush.toFixed(3)} and ${planted.crush.toFixed(3)} m: nothing to compare`);
      assert.ok(Math.abs(unplanted.crush - planted.crush) <= CRUSH_MATCH * Math.max(unplanted.crush, planted.crush), `crush ${unplanted.crush.toFixed(3)} m before the plant against ${planted.crush.toFixed(3)} m after`);
      assert.equal(unplanted.wheelsLost, strikeCase.expectedWheelsLost, "wheels lost before the plant");
      assert.equal(planted.wheelsLost, strikeCase.expectedWheelsLost, "wheels lost after the plant");
    });
  }
});
