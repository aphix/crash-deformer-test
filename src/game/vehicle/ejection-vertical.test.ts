import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FREEWHEEL, launch, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import { RANGE } from "../scenes/range.ts";
import { Ground, setGround } from "../world/ground.ts";
import { solidsOf } from "../world/placements.ts";
import type { Surface } from "../world/surfaces.ts";
import type { DeformableCar } from "./car.ts";
import { EjectionWatch, ejectionVelocity, THROW_OUT, type Ejection } from "./ejection.ts";
import { classCar } from "./ejection.test-util.ts";
import { VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { RAD, Wedge } from "./wedge.test-util.ts";

/** The thrown driver's own upward speed over the car's (m/s): `THROW_UP`, pinned by the flat rows. */
const FLAT_THROW_UP = 3.5;
const FLAT_TOLERANCE = 0.05;
/** How far (m/s) the launch's vertical speed may be from the pre-hit car's plus `FLAT_THROW_UP`: the sample the watch reads is within a frame of the one the rows read. */
const CARRY_TOLERANCE = 0.5;
/** Frames (60 Hz) a run lasts: 2.5 s, past every throw below. */
const FRAMES = 150;
/** The watch's look-back (`PRE`, 0.35 s) in frames: a run longer than this has lost its first samples when the throw is judged. */
const WATCH_LOOKBACK_FRAMES = 21;
/** The wedges the plan-only contact kernel still kills a driver on at 25 m/s (a 22 degree one leaves the block at health 0.72, a 45 degree one at 1.0). */
const KILLING_WEDGE_DEG = 20;
/** Where the wall stands on the wedge (m of x; the wedge's face runs x -10 to 10), and the car's speed along the face, for the one-car row and the whole fleet's. */
const WALL_X = 9;
/** A car starts this far (m of x) down the wedge's face (the foot is at -10): about 0.4 s of climb before the wall, beyond the watch's look-back. */
const LEAD_START_X = -4;
const SEDAN_CLIMB_MPS = 28;
const FLEET_CLIMB_MPS = 33;
/** The ledge a car drives off (m above the sand) and where its wall stands past the edge: the car falls 0.8 s, 7 m/s, before it. */
const LEDGE_HEIGHT = 6;
const LEDGE_WALL_X = 20;
const LEDGE_SPEED = 25;
/** The forced throw's wedge, as steep as a high jump's lip, and its speed along the face. */
const LIP_WEDGE_DEG = 60;
const LIP_SPEED = 25;
const F32_TOLERANCE = 1e-4;
/** The wall of the seed row: so near the car's nose that it is killed on its first frames. */
const SEED_WALL_X = 2;
const SEED_FRAMES = 1;
const NO_HITS: PropHits = { knock() {}, fx() {}, wall() {} };
const UP = new THREE.Vector3(0, 1, 0);

after(() => setGround(null));

/** Flat road to x = 0, then `height` m lower sand: a car driven +x leaves the edge and falls. */
class Ledge extends Ground {
  constructor(height: number) {
    super();
    this.addPlane(height, -1e4, 0, -1e4, 1e4, Infinity);
    this.addPlane(0, 0, 1e4, -1e4, 1e4, Infinity);
  }
}

/** A wall across the lane (z), thin along x, standing from `base` to `top` m above the world's zero, as a fixed solid. */
function wallPrism(x: number, base: number, top: number): Surface {
  return solidsOf([], [{ index: 0, prefab: null, body: "solid", x, z: 0, yaw: 0, kind: "box", r: 8, hx: 0.5, hz: 8, mass: 0, base, top, ends: 3 }]);
}

/** A car of `cls` on the face of `wedge` at x = `startX`, nose up the face, driving up it at `speed` m/s along the face. */
function climbing(cls: VehicleClassId, wedge: Wedge, speed: number, startX = 0): DeformableCar {
  const car = classCar(cls);
  launch(car, startX, 0, Math.PI / 2, 0, 0);
  const normal = new THREE.Vector3(-Math.sin(wedge.deg * RAD), Math.cos(wedge.deg * RAD), 0);
  car.group.quaternion.setFromUnitVectors(UP, normal).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2));
  const euler = new THREE.Euler().setFromQuaternion(car.group.quaternion, "YXZ");
  car.yaw = euler.y;
  car.pitch = euler.x;
  car.roll = euler.z;
  car.group.position.set(startX, wedge.heightAt(startX, 0), 0);
  car.velocity.set(speed * Math.cos(wedge.deg * RAD), speed * Math.sin(wedge.deg * RAD), 0);
  car.speed = speed;
  car.spawnSpeed = speed;
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
  return car;
}

type Throw = {
  /** The car's velocity at the start of every frame up to and including the throw's. */
  history: { vx: number; vy: number }[];
  events: readonly Ejection[];
  /** The launch velocity of the first event: the car's, the driver's own throw out and up. */
  launched: THREE.Vector3;
};

/** `car` run 2.5 s in neutral into the fixed `wall` through the engine's own step and ejection watch, until its driver is thrown. */
function runIntoWall(car: DeformableCar, wall: Surface): Throw {
  const world = makeWorld([car], false, false, FREEWHEEL);
  const knocked = new Uint8Array(1);
  world.world.collide = (c, _i, h) => propContact(c, 0, wall, knocked, NO_HITS, h);
  const history: Throw["history"] = [];
  for (let f = 0; f < FRAMES && world.ejections.length === 0; f++) {
    history.push({ vx: car.velocity.x, vy: car.velocity.y });
    tickWorld(world);
  }
  const launched = world.ejections[0] ? ejectionVelocity(world.ejections[0], new THREE.Vector3()) : new THREE.Vector3(NaN, NaN, NaN);
  return { history, events: world.ejections, launched };
}

/** The vertical speed (m/s) of the sample the watch reads: the one the car closed on the wall fastest at, the latest of equals (as the watch walks back from the newest sample). */
function peakClosingVerticalSpeed(history: Throw["history"]): number {
  let peak = history[history.length - 1]!;
  for (let k = history.length - 1; k >= 0; k--) if (history[k]!.vx > peak.vx) peak = history[k]!;
  return peak.vy;
}

const CLIMBS = [
  { it: `when a sedan climbs a 20 degree wedge at ${SEDAN_CLIMB_MPS} m/s into a wall, then its driver is thrown with the car's vertical speed at the fastest-closing sample plus 3.5 m/s`, cls: "sedan", mps: SEDAN_CLIMB_MPS },
  ...VEHICLE_CLASS_IDS.map((cls) => ({ it: `when a ${cls} climbs a 20 degree wedge at ${FLEET_CLIMB_MPS} m/s into a wall, then its driver is thrown with the car's vertical speed at the fastest-closing sample plus 3.5 m/s`, cls, mps: FLEET_CLIMB_MPS })),
] as const;

describe("given a car climbing a wedge into a wall that kills it (a ramp's flat-up carry)", () => {
  for (const testCase of CLIMBS) {
    it(testCase.it, () => {
      const wedge = new Wedge(KILLING_WEDGE_DEG);
      setGround(wedge);
      const top = wedge.heightAt(WALL_X, 0);
      const car = climbing(testCase.cls, wedge, testCase.mps, LEAD_START_X);
      const run = runIntoWall(car, wallPrism(WALL_X, top - 3, top + 12));
      assert.ok(run.history.length > WATCH_LOOKBACK_FRAMES, "the throw comes after the look-back has passed the placement sample");
      const climbSpeed = peakClosingVerticalSpeed(run.history.slice(-WATCH_LOOKBACK_FRAMES));
      car.dispose();
      assert.equal(run.events.length, 1, "one throw");
      assert.equal(run.events[0]!.exit, "windshield", "thrown out of the windshield");
      assert.ok(climbSpeed > 2 * FLAT_THROW_UP, `the car was climbing at ${climbSpeed.toFixed(2)} m/s`);
      assert.ok(Math.abs(run.launched.y - (climbSpeed + FLAT_THROW_UP)) <= CARRY_TOLERANCE, `launched ${run.launched.y.toFixed(2)} m/s up, the climb ${climbSpeed.toFixed(2)} + ${FLAT_THROW_UP}`);
    });
  }
});

describe("given a car driving off a ledge and falling into a wall that kills it", () => {
  it("when a sedan falls at 7 m/s into the wall, then its driver keeps the fall (the sign carried) and is thrown with the fall plus 3.5 m/s", () => {
    setGround(new Ledge(LEDGE_HEIGHT));
    const car = classCar("sedan");
    launch(car, -10, 0, Math.PI / 2, LEDGE_SPEED, 0);
    car.group.position.y = LEDGE_HEIGHT;
    const run = runIntoWall(car, wallPrism(LEDGE_WALL_X, 0, LEDGE_HEIGHT + 3));
    const fallSpeed = peakClosingVerticalSpeed(run.history.slice(-WATCH_LOOKBACK_FRAMES));
    car.dispose();
    assert.equal(run.events.length, 1, "one throw");
    assert.ok(fallSpeed < -FLAT_THROW_UP, `the car was falling at ${fallSpeed.toFixed(2)} m/s`);
    assert.ok(Math.abs(run.launched.y - (fallSpeed + FLAT_THROW_UP)) <= CARRY_TOLERANCE, `launched ${run.launched.y.toFixed(2)} m/s, the fall ${fallSpeed.toFixed(2)} + ${FLAT_THROW_UP}`);
    assert.ok(run.launched.y < 0, "he leaves the car still going down");
  });
});

describe("given the ejection range: a straight head-on into the barrier on flat ground", () => {
  for (const cls of VEHICLE_CLASS_IDS) {
    it(`when a ${cls} drives at ${RANGE.kph} km/h straight into the barrier, then the driver is launched up at 3.5 m/s as before`, () => {
      setGround(null);
      const car = classCar(cls);
      const mps = RANGE.kph / 3.6;
      launch(car, -RANGE.run, 0, Math.PI / 2, mps, 0);
      const world = makeWorld([car], true, false, FREEWHEEL);
      for (let f = 0; f < FRAMES; f++) tickWorld(world);
      car.dispose();
      assert.equal(world.ejections.length, 1, "one throw");
      const launched = ejectionVelocity(world.ejections[0]!, new THREE.Vector3());
      assert.ok(Math.abs(launched.y - FLAT_THROW_UP) <= FLAT_TOLERANCE, `launched ${launched.y.toFixed(3)} m/s up`);
    });
  }
});

describe("given a car thrown on the throw's own step with no velocity sample yet but the one it was placed with", () => {
  it("when a sedan placed climbing a 20 degree wedge is killed by a wall inside its first frames, then its driver carries the vertical speed it was placed with", () => {
    const wedge = new Wedge(KILLING_WEDGE_DEG);
    setGround(wedge);
    const top = wedge.heightAt(0, 0);
    const car = climbing("sedan", wedge, FLEET_CLIMB_MPS);
    const run = runIntoWall(car, wallPrism(SEED_WALL_X, top - 3, top + 12));
    car.dispose();
    assert.equal(run.events.length, 1, "one throw");
    assert.equal(run.history.length, SEED_FRAMES, "killed on its first frames");
    assert.ok(Math.abs(run.launched.y - (FLEET_CLIMB_MPS * Math.sin(KILLING_WEDGE_DEG * RAD) + FLAT_THROW_UP)) <= CARRY_TOLERANCE, `launched ${run.launched.y.toFixed(2)} m/s up`);
  });
});

describe("given the sim throwing a driver out on demand (a ramp's lip), whatever the car hit", () => {
  it("when a car climbing a 60 degree wedge at 25 m/s is thrown now, then one windshield event launches him at the car's velocity plus the throw out and up", () => {
    const wedge = new Wedge(LIP_WEDGE_DEG);
    setGround(wedge);
    const car = climbing("sedan", wedge, LIP_SPEED);
    const watch = new EjectionWatch();
    watch.throwDriverNow([car], 0);
    const events = watch.take();
    assert.equal(events.length, 1, "one event");
    assert.equal(events[0]!.exit, "windshield", "windshield");
    assert.equal(car.driverOut, "windshield", "the car's driver is out");
    const launched = ejectionVelocity(events[0]!, new THREE.Vector3());
    const dir = events[0]!.dir;
    assert.ok(Math.abs(launched.x - (car.velocity.x + dir.x * THROW_OUT)) <= F32_TOLERANCE, `x ${launched.x}`);
    assert.ok(Math.abs(launched.y - (car.velocity.y + FLAT_THROW_UP)) <= F32_TOLERANCE, `y ${launched.y} against the car's ${car.velocity.y}`);
    assert.ok(Math.abs(launched.z - (car.velocity.z + dir.z * THROW_OUT)) <= F32_TOLERANCE, `z ${launched.z}`);
    car.dispose();
  });

  it("when the same car is thrown now twice, then the second call gives nothing", () => {
    setGround(new Wedge(LIP_WEDGE_DEG));
    const car = climbing("sedan", new Wedge(LIP_WEDGE_DEG), LIP_SPEED);
    const watch = new EjectionWatch();
    watch.throwDriverNow([car], 0);
    assert.equal(watch.take().length, 1, "the first call throws him");
    watch.throwDriverNow([car], 0);
    assert.equal(watch.take().length, 0, "the second call gives nothing");
    car.dispose();
  });

  const NOT_THROWABLE = [
    { it: "when a falling car is thrown now, then nothing is thrown", falling: true, vaporized: false, driverOut: null },
    { it: "when a vaporized car is thrown now, then nothing is thrown", falling: false, vaporized: true, driverOut: null },
    { it: "when a car whose driver is already out is thrown now, then nothing is thrown", falling: false, vaporized: false, driverOut: "doorL" },
  ] as const;
  for (const testCase of NOT_THROWABLE) {
    it(testCase.it, () => {
      setGround(new Wedge(LIP_WEDGE_DEG));
      const car = climbing("sedan", new Wedge(LIP_WEDGE_DEG), LIP_SPEED);
      car.falling = testCase.falling;
      car.vaporized = testCase.vaporized;
      car.driverOut = testCase.driverOut;
      const watch = new EjectionWatch();
      watch.throwDriverNow([car], 0);
      assert.equal(watch.take().length, 0, "no event");
      assert.equal(car.driverOut, testCase.driverOut, "the car's driver state is unchanged");
      car.dispose();
    });
  }
});

