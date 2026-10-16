import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FREEWHEEL } from "../contact/crash-scenarios.test-util.ts";
import { newWorld } from "../engine/world-step.ts";
import { GRAVITY } from "../kernel/constants.ts";
import { DRIVER_CARS, type DriverCar } from "../match/types.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { layOnGround } from "../vehicle/car-air-points.ts";
import { idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { EjectionWatch, ejectionVelocity, THROW_OUT, type Ejection } from "../vehicle/ejection.ts";
import { FRAME, frame } from "../vehicle/ground-probe.test-util.ts";
import { Ground, setGround, STEP_UP } from "../world/ground.ts";
import { LANDING_HEIGHT, LIP_CAR_SPEED_KEEP, STATION_ANCHORS, STATION_HALF_WIDTH, THROW_YAW } from "./minigame-constants.ts";
import { LipThrow, type LipMode } from "./minigame-lip.ts";
import { lipHeight, lipPitch } from "./minigame-profile.ts";
import { dressedDriverCar, FINE_CELL, stationDriveProfile } from "./minigame-profile.test-util.ts";
import { RING_CUPS } from "./minigame-ring.ts";

const LIP_MODES: readonly LipMode[] = ["highJump", "ringFling"];

/** The thrown driver's own upward speed over the car's (m/s): `THROW_UP` in ejection.ts (module-private), pinned by `ejection-vertical.test.ts`'s flat rows. */
const THROW_UP_PINNED = 3.5;
/** The event stores f32 numbers; a launch velocity of 40 m/s is within this of the f64 sum (m/s). */
const F32_TOLERANCE = 1e-4;
/** A velocity or a speed that must be unchanged or exactly scaled is within this (m/s). */
const EXACT_TOLERANCE = 1e-9;
/** A parked car's centre rides about this far (m) above its floor. */
const CENTRE_ABOVE_FLOOR = 0.7;
/** The lip speeds (m/s) a car crosses the plane at in the hook rows: the slow lip speed, a mid one and a very fast one (a 1/60 s step is then 0.7 m). */
const CROSSING_SPEEDS = [17, 25, 40];
/** The crossing step starts this share of a step's travel before the plane and ends 0.75 of it past: the plane is neither at the step's start nor its end. */
const BEFORE_PLANE_SHARE = -0.25;
const PAST_PLANE_SHARE = 0.75;

/** The ground rows' lane: half its width, how far down the throw the landing plane reaches and how far to each side (m), as `minigame-profile.test-util.ts` lays its own (it keeps them private). */
const LANE_HALF_WIDTH = 3;
const LANDING_END_X = 400;
const LANDING_HALF_WIDTH = 60;
/** Seconds the parked car is left alone before the release, and the run's cap (s), and when a car is stalled (m/s, for how long): as the climb rows. */
const SETTLE_SECONDS = 2;
const RUN_SECONDS = 40;
/** A car is in free fall in a frame when its vertical speed fell by more than this share of gravity's pull, and has left the ground once it has been so this long (s): a car tipping over the crest is not, one in flight is. */
const FREE_FALL_SHARE = 0.5;
const LEFT_THE_GROUND_SECONDS = 0.25;
const STALLED_SPEED = 0.5;
const STALL_SECONDS = 2;
/** How far ahead (m) of the car along the lane the steering aims, and per metre of its speed, and its gain: as the climb rows. */
const STEER_LOOK_AHEAD = 10;
const STEER_LOOK_PER_SPEED = 0.4;
const STEER_GAIN = 2.5;
/** Throttle per m/s the car is under the run-up's speed cap. */
const GOVERNOR_GAIN = 1;

const sedan = DRIVER_CARS.find((type) => type.id === "sedan")!;

after(() => setGround(null));

/** A sedan facing the throw at the station's lane middle, moving at `speed` m/s along the lip's pitch. */
function carMovingAtLip(mode: LipMode, speed: number): DeformableCar {
  const car = dressedDriverCar(sedan);
  car.spawnFacing(STATION_ANCHORS[mode].x, STATION_ANCHORS[mode].z, THROW_YAW, 0);
  car.velocity.set(speed * Math.cos(lipPitch(mode)), speed * Math.sin(lipPitch(mode)), 0);
  car.speed = speed;
  return car;
}

/** Puts the car's centre at station-local (x, z), its height the lip's plus `CENTRE_ABOVE_FLOOR`, and its matrices up to date. */
function placeAt(car: DeformableCar, mode: LipMode, localX: number, localZ = 0): void {
  const anchor = STATION_ANCHORS[mode];
  car.group.position.set(anchor.x + localX, lipHeight(mode) + CENTRE_ABOVE_FLOOR, anchor.z + localZ);
  car.group.updateMatrixWorld(true);
}

/** A lip throw on a one-car world's watch, and the watch. */
function lipThrowFor(mode: LipMode, car: DeformableCar): { lip: LipThrow; watch: EjectionWatch } {
  const watch = new EjectionWatch();
  return { lip: new LipThrow(mode, [car], watch), watch };
}

/** The car's centre moved through the station-local x values in turn, the hook called after each. */
function crossing(lip: LipThrow, car: DeformableCar, mode: LipMode, localXs: readonly number[], localZ = 0): void {
  for (const localX of localXs) {
    placeAt(car, mode, localX, localZ);
    lip.collide(car, 0);
  }
}

describe("given a car whose centre crosses the lip plane going forward at speed v", () => {
  for (const mode of LIP_MODES) {
    for (const speed of CROSSING_SPEEDS) {
      it(`when it crosses the ${mode} lip at ${speed} m/s in one step, then one windshield ejection launches the driver at the car's velocity plus the usual pop and the car keeps LIP_CAR_SPEED_KEEP of its speed`, () => {
        const car = carMovingAtLip(mode, speed);
        const { lip, watch } = lipThrowFor(mode, car);
        const step = speed * FRAME;
        placeAt(car, mode, BEFORE_PLANE_SHARE * step);
        lip.collide(car, 0);
        assert.equal(watch.take().length, 0, "no throw before the plane");
        const velocityAtLip = car.velocity.clone();
        placeAt(car, mode, PAST_PLANE_SHARE * step);
        lip.collide(car, 0);
        const events = watch.take();
        assert.equal(events.length, 1, "exactly one ejection");
        assert.equal(events[0]!.exit, "windshield", "through the windshield");
        assert.equal(car.driverOut, "windshield", "the car's driver is out");
        const launched = ejectionVelocity(events[0]!, new THREE.Vector3());
        const dir = events[0]!.dir;
        assert.ok(Math.abs(launched.x - (velocityAtLip.x + dir.x * THROW_OUT)) <= F32_TOLERANCE, `launch x ${launched.x}`);
        assert.ok(Math.abs(launched.y - (velocityAtLip.y + THROW_UP_PINNED)) <= F32_TOLERANCE, `launch y ${launched.y}`);
        assert.ok(Math.abs(launched.z - (velocityAtLip.z + dir.z * THROW_OUT)) <= F32_TOLERANCE, `launch z ${launched.z}`);
        assert.ok(Math.abs(car.speed - speed * LIP_CAR_SPEED_KEEP) <= EXACT_TOLERANCE, `car speed ${car.speed}`);
        assert.ok(Math.abs(car.velocity.length() - speed * LIP_CAR_SPEED_KEEP) <= EXACT_TOLERANCE, `car velocity ${car.velocity.length()}`);
        assert.ok(car.velocity.distanceTo(velocityAtLip.multiplyScalar(LIP_CAR_SPEED_KEEP)) <= EXACT_TOLERANCE, "every component scaled: the direction is kept");
        car.dispose();
      });
    }

    it(`when the ${mode} crossing step is cut into four slices, then the plane triggers once and the car is cut once`, () => {
      const speed = 25;
      const car = carMovingAtLip(mode, speed);
      const { lip, watch } = lipThrowFor(mode, car);
      const slice = (speed * FRAME) / 4;
      crossing(lip, car, mode, [-1.5 * slice, -0.5 * slice, 0.5 * slice, 1.5 * slice, 2.5 * slice]);
      assert.equal(watch.take().length, 1, "one ejection over the four slices");
      assert.ok(Math.abs(car.speed - speed * LIP_CAR_SPEED_KEEP) <= EXACT_TOLERANCE, `cut once: ${car.speed}`);
      car.dispose();
    });
  }
});

describe("given a car that does not cross the lip plane going forward in the lane", () => {
  for (const mode of LIP_MODES) {
    it(`when a car stops short of the ${mode} lip, then it is never thrown and keeps its speed`, () => {
      const car = carMovingAtLip(mode, 20);
      const { lip, watch } = lipThrowFor(mode, car);
      crossing(lip, car, mode, [-6, -3, -0.5, -0.5, -0.5, -0.5]);
      assert.equal(watch.take().length, 0, "no ejection");
      assert.equal(car.driverOut, null, "his driver is in");
      assert.equal(car.speed, 20, "no cut");
      car.dispose();
    });

    it(`when a car reverses over the ${mode} lip, then it is not thrown and keeps its speed`, () => {
      const car = carMovingAtLip(mode, 20);
      const { lip, watch } = lipThrowFor(mode, car);
      crossing(lip, car, mode, [2, 1, 0.5, -0.5, -1]);
      assert.equal(watch.take().length, 0, "no ejection");
      assert.equal(car.driverOut, null, "his driver is in");
      assert.equal(car.speed, 20, "no cut");
      car.dispose();
    });

    it(`when a car whose driver is already out crosses the ${mode} lip, then nothing is thrown and it is not cut again`, () => {
      const car = carMovingAtLip(mode, 20);
      car.driverOut = "doorL";
      const { lip, watch } = lipThrowFor(mode, car);
      crossing(lip, car, mode, [-0.3, 0.4, 0.8]);
      assert.equal(watch.take().length, 0, "no ejection");
      assert.equal(car.driverOut, "doorL", "his state is unchanged");
      assert.equal(car.speed, 20, "no cut");
      car.dispose();
    });

    it(`when a car is thrown at the ${mode} lip and crosses the plane again, then it is thrown and cut only the first time`, () => {
      const car = carMovingAtLip(mode, 20);
      const { lip, watch } = lipThrowFor(mode, car);
      crossing(lip, car, mode, [-0.3, 0.4, -0.3, 0.4, -0.3, 0.4]);
      assert.equal(watch.take().length, 1, "one ejection over three crossings");
      assert.ok(Math.abs(car.speed - 20 * LIP_CAR_SPEED_KEEP) <= EXACT_TOLERANCE, `cut once: ${car.speed}`);
      car.dispose();
    });

    it(`when a car crosses the ${mode} lip plane just beyond either side of the lane, then it is not thrown; just inside either side it is`, () => {
      const outside = STATION_HALF_WIDTH + 0.5;
      const inside = STATION_HALF_WIDTH - 0.5;
      for (const localZ of [-outside, outside]) {
        const car = carMovingAtLip(mode, 20);
        const { lip, watch } = lipThrowFor(mode, car);
        crossing(lip, car, mode, [-0.3, 0.4], localZ);
        assert.equal(watch.take().length, 0, `no ejection at z ${localZ}`);
        car.dispose();
      }
      for (const localZ of [-inside, inside]) {
        const car = carMovingAtLip(mode, 20);
        const { lip, watch } = lipThrowFor(mode, car);
        crossing(lip, car, mode, [-0.3, 0.4], localZ);
        assert.equal(watch.take().length, 1, `one ejection at z ${localZ}`);
        car.dispose();
      }
    });

    it(`when a car crosses the other station's lane at x = 0, then the ${mode} lip does not throw it`, () => {
      const other = LIP_MODES.find((candidate) => candidate !== mode)!;
      const car = carMovingAtLip(other, 20);
      const { lip, watch } = lipThrowFor(mode, car);
      crossing(lip, car, other, [-0.3, 0.4]);
      assert.equal(watch.take().length, 0, "no ejection");
      car.dispose();
    });

    it(`when a falling car crosses the ${mode} lip, then nothing is thrown and it is not cut`, () => {
      const car = carMovingAtLip(mode, 20);
      car.falling = true;
      const { lip, watch } = lipThrowFor(mode, car);
      crossing(lip, car, mode, [-0.3, 0.4]);
      assert.equal(watch.take().length, 0, "no ejection");
      assert.equal(car.speed, 20, "no cut");
      car.dispose();
    });

    it(`when a car first seen past the ${mode} lip is called again further on, then it is not thrown: only a crossing throws`, () => {
      const car = carMovingAtLip(mode, 20);
      const { lip, watch } = lipThrowFor(mode, car);
      crossing(lip, car, mode, [3, 4, 5]);
      assert.equal(watch.take().length, 0, "no ejection");
      car.dispose();
    });
  }
});

/** The ground of one station as the ground rows build it, at the station's anchor: the profile's grid, then the level landing past it. */
class AnchoredGround extends Ground {
  constructor(mode: LipMode) {
    super();
    const anchor = STATION_ANCHORS[mode];
    const profile = stationDriveProfile(mode);
    const cell = FINE_CELL;
    const lengthX = profile.frontX - profile.backX + 2 * cell;
    const nu = Math.ceil(lengthX / cell) + 1;
    const nv = Math.ceil((2 * LANE_HALF_WIDTH) / cell) + 1;
    const heights = new Float32Array(nu * nv);
    for (let i = 0; i < nu; i++) {
      const height = profile.heightAtX(profile.backX + i * cell);
      for (let j = 0; j < nv; j++) heights[j * nu + i] = height;
    }
    const gridX = anchor.x + profile.backX;
    this.addGrid({ nu, nv, step: cell, stepV: cell, u0: 0, v0: 0, heights, ox: gridX, oy: 0, oz: anchor.z - LANE_HALF_WIDTH, reach: STEP_UP });
    this.addPlane(LANDING_HEIGHT, gridX + (nu - 1) * cell, anchor.x + LANDING_END_X, anchor.z - LANDING_HALF_WIDTH, anchor.z + LANDING_HALF_WIDTH, Infinity);
  }
}

/** What one drive from the station's pad to the lip, the throw and the driverless car's fall gave. */
type Flight = {
  /** Every ejection the watch queued over the run: a throw is one. */
  ejections: number;
  /** The event of the throw: the car's velocity then (`carVel`, f32) and the driver's launch on top of it. */
  event: Ejection | null;
  /** The car's horizontal speed (m/s) as its driver was thrown, before the cut: what the climb rows of `minigame-profile.test.ts` call the lip speed (`car.speed`). */
  lipSpeed: number;
  /** Station-local x of the car's centre in the slice that threw him. */
  throwLocalX: number;
  /**
   * Station-local x of the driverless car's centre at the first frame its fall stopped being free (it met the ground, whatever part of
   * it) after at least `LEFT_THE_GROUND_SECONDS` of free fall since the throw, NaN if that never happened.
   */
  landingLocalX: number;
};

/**
 * `speedCap` (m/s) is the horizontal speed the throttle and brake hold the car to up to the throw (Infinity: full throttle all the
 * way), `keep` the share of its speed the car keeps at the throw (the production constant's value is `LIP_CAR_SPEED_KEEP`: any other is
 * rescaled to from it, right after the hook's cut, to measure candidates), and the run ends at the throw or, with `until` "landing", at the landing.
 */
type FlightRun = { speedCap: number; keep: number; until: "throw" | "landing" };

/**
 * One car of `type` parked on the pad of the station's ground, left alone to settle, then released and steered along the lane's middle
 * under the real `LipThrow` hook of a one-car world, as the climb rows of `minigame-profile.test.ts` drive it; once he is thrown the
 * car freewheels (a driverless car's pedals, as the engine's race director gives it).
 */
function flyFromLip(type: DriverCar, mode: LipMode, run: FlightRun): Flight {
  const anchor = STATION_ANCHORS[mode];
  const profile = stationDriveProfile(mode);
  const ground = new AnchoredGround(mode);
  setGround(ground);
  const car = dressedDriverCar(type);
  try {
    const startX = anchor.x + profile.startX;
    car.spawnFacing(startX, anchor.z, THROW_YAW, 0);
    car.group.position.y = ground.heightAt(startX, anchor.z, 0.5);
    layOnGround(car);
    car.parked = true;
    const watch = new EjectionWatch();
    const world = newWorld([car], null, watch);
    world.collide = new LipThrow(mode, [car], watch).collide;
    const clock = { acc: 0 };
    for (let n = 0; n < SETTLE_SECONDS / FRAME; n++) frame(world, null, clock);
    const flight: Flight = { ejections: 0, event: null, lipSpeed: NaN, throwLocalX: NaN, landingLocalX: NaN };
    const input: DriveInput = { ...idleDrive(), throttle: 1 };
    let secondsInFreeFall = 0;
    let previousVerticalSpeed = 0;
    const afterSlice = (): void => {
      const events = watch.take();
      flight.ejections += events.length;
      if (flight.event === null && events.length > 0) {
        flight.event = events[0]!;
        flight.lipSpeed = Math.hypot(flight.event.carVel.x, flight.event.carVel.z);
        flight.throwLocalX = car.group.position.x - anchor.x;
        const rescale = run.keep / LIP_CAR_SPEED_KEEP;
        car.velocity.multiplyScalar(rescale);
        car.speed *= rescale;
        Object.assign(input, FREEWHEEL);
      }
    };
    let stalledFor = 0;
    for (let n = 0; n < RUN_SECONDS / FRAME; n++) {
      if (flight.event === null) {
        const aheadX = car.group.position.x + STEER_LOOK_AHEAD + car.speed * STEER_LOOK_PER_SPEED;
        const error = Math.atan2(aheadX - car.group.position.x, anchor.z - car.group.position.z) - car.yaw;
        input.steer = Math.max(-1, Math.min(1, STEER_GAIN * Math.atan2(Math.sin(error), Math.cos(error))));
        const horizontalSpeed = Math.hypot(car.velocity.x, car.velocity.z);
        input.throttle = Math.max(0, Math.min(1, GOVERNOR_GAIN * (run.speedCap - horizontalSpeed)));
        input.brake = Math.max(0, Math.min(1, GOVERNOR_GAIN * (horizontalSpeed - run.speedCap)));
      }
      frame(world, input, clock, afterSlice);
      stalledFor = car.speed < STALLED_SPEED ? stalledFor + FRAME : 0;
      if (flight.event === null && stalledFor > STALL_SECONDS) break;
      if (flight.event !== null && Number.isNaN(flight.landingLocalX)) {
        const inFreeFall = car.velocity.y - previousVerticalSpeed <= -FREE_FALL_SHARE * GRAVITY * FRAME;
        if (inFreeFall) secondsInFreeFall += FRAME;
        else if (secondsInFreeFall >= LEFT_THE_GROUND_SECONDS) flight.landingLocalX = car.group.position.x - anchor.x;
        else secondsInFreeFall = 0;
      }
      previousVerticalSpeed = car.velocity.y;
      if (flight.event !== null && (run.until === "throw" || !Number.isNaN(flight.landingLocalX))) break;
    }
    return flight;
  } finally {
    car.dispose();
    setGround(null);
  }
}

/** The lip speed (m/s) of the slow runs, the plan's lowest, and how far (m/s) a governed run may be off it. */
const SLOW_LIP_SPEED = 17;
const SLOW_LIP_TOLERANCE = 0.5;
/** The caps the bisection searches (m/s) and how many halvings (a resolution of 0.07 m/s). */
const CAP_SEARCH = { low: 8, high: 45, halvings: 9 } as const;

const slowCaps = new Map<string, number>();

/**
 * The lowest speed cap (m/s) the governed run is held to at which `type` still reaches the lip at `SLOW_LIP_SPEED` or better: a car
 * loses speed up a steep kicker, so the cap is its speed at the climb's foot and the lip speed follows from it.
 */
function slowCap(type: DriverCar, mode: LipMode): number {
  const key = `${mode}:${type.id}`;
  const known = slowCaps.get(key);
  if (known !== undefined) return known;
  let low: number = CAP_SEARCH.low;
  let high: number = CAP_SEARCH.high;
  for (let halving = 0; halving < CAP_SEARCH.halvings; halving++) {
    const middle = (low + high) / 2;
    const flight = flyFromLip(type, mode, { speedCap: middle, keep: LIP_CAR_SPEED_KEEP, until: "throw" });
    if (flight.lipSpeed >= SLOW_LIP_SPEED) high = middle;
    else low = middle;
  }
  slowCaps.set(key, high);
  return high;
}

/** The station-local x a driverless car must land short of: the 10 cup's front edge less `CUP_FRONT_MARGIN` (Ring Fling), or the share of the driver's ballistic apex distance (High jump). */
const CUP_FRONT_MARGIN = 2;
const LIP_CAR_CLEAR_FRACTION = 0.5;

function landingLimit(mode: LipMode, flight: Flight): number {
  if (mode === "ringFling") {
    const nearestCup = RING_CUPS[0]!;
    return nearestCup.centreX - nearestCup.radius - CUP_FRONT_MARGIN;
  }
  const launched = ejectionVelocity(flight.event!, new THREE.Vector3());
  return (LIP_CAR_CLEAR_FRACTION * Math.hypot(launched.x, launched.z) * launched.y) / GRAVITY;
}

/** The keeps the table tries (0.2 to 0.6 in steps of 0.05), and 1 (no cut), the mutation the bars must fail. */
const CANDIDATE_KEEPS = Array.from({ length: 9 }, (_, step) => Math.round((0.2 + 0.05 * step) * 100) / 100);
const NO_CUT_KEEP = 1;

type Measure = { label: string; run: (keep: number) => Flight };

/** Every car type at its best lip speed, then at the slow one, on `mode`. */
function measures(mode: LipMode): Measure[] {
  return DRIVER_CARS.flatMap((type): Measure[] => [
    { label: `${type.id.padEnd(9)} best`, run: (keep) => flyFromLip(type, mode, { speedCap: Infinity, keep, until: "landing" }) },
    { label: `${type.id.padEnd(9)} slow`, run: (keep) => flyFromLip(type, mode, { speedCap: slowCap(type, mode), keep, until: "landing" }) },
  ]);
}

/** Per station, the candidate keeps whose driverless cars landed clear for every type at both speeds. */
const keepsClearing = new Map<LipMode, Set<number>>();

describe("given each car type driven up each station's ramp under the real lip throw", () => {
  for (const mode of LIP_MODES) {
    it(`when each reaches the ${mode} lip at its best and at the slow speed, then one ejection is one windshield throw at the plane, at the car's velocity plus the usual pop, and the slow run is within tolerance of ${SLOW_LIP_SPEED} m/s`, () => {
      for (const type of DRIVER_CARS) {
        for (const speedCap of [Infinity, slowCap(type, mode)]) {
          const flight = flyFromLip(type, mode, { speedCap, keep: LIP_CAR_SPEED_KEEP, until: "throw" });
          const event = flight.event;
          assert.ok(event !== null, `${type.id}: thrown`);
          assert.equal(flight.ejections, 1, `${type.id}: one ejection`);
          assert.equal(event.exit, "windshield", `${type.id}: windshield`);
          assert.ok(flight.throwLocalX >= 0 && flight.throwLocalX <= flight.lipSpeed * FRAME, `${type.id}: thrown as the centre crossed the plane (x ${flight.throwLocalX})`);
          const pop = Math.hypot(event.rel.x - event.dir.x * THROW_OUT, event.rel.y - THROW_UP_PINNED, event.rel.z - event.dir.z * THROW_OUT);
          assert.ok(pop <= F32_TOLERANCE, `${type.id}: the driver's own velocity is off the throw out and up by ${pop}`);
          if (speedCap !== Infinity) assert.ok(Math.abs(flight.lipSpeed - SLOW_LIP_SPEED) <= SLOW_LIP_TOLERANCE, `${type.id}: slow lip speed ${flight.lipSpeed}`);
        }
      }
    });

    it(`when each lands driverless on the ${mode}, then the table of keeps shows the chosen LIP_CAR_SPEED_KEEP is the largest candidate that clears the bars for every type at both speeds, and no cut fails them`, (t) => {
      const cases = measures(mode);
      const lines = [`${mode}: the driverless car's landing x (m from the lip) by keep ${[...CANDIDATE_KEEPS, NO_CUT_KEEP].join(" ")} (the last: no cut), then the bar and the lip speed`];
      const clearsAll = new Map<number, boolean>();
      for (const keep of [...CANDIDATE_KEEPS, NO_CUT_KEEP]) clearsAll.set(keep, true);
      for (const { label, run } of cases) {
        const cells: string[] = [];
        let limit = NaN;
        let lipSpeed = NaN;
        for (const keep of [...CANDIDATE_KEEPS, NO_CUT_KEEP]) {
          const flight = run(keep);
          assert.equal(flight.ejections, 1, `${label} at keep ${keep}: one ejection over the whole flight`);
          limit = landingLimit(mode, flight);
          lipSpeed = flight.lipSpeed;
          cells.push(flight.landingLocalX.toFixed(1).padStart(7));
          if (!(flight.landingLocalX < limit)) clearsAll.set(keep, false);
        }
        lines.push(`${label}: ${cells.join("")} | bar ${limit.toFixed(1)} lip ${lipSpeed.toFixed(1)} m/s`);
      }
      t.diagnostic(lines.join("\n"));
      keepsClearing.set(mode, new Set(CANDIDATE_KEEPS.filter((keep) => clearsAll.get(keep))));
      assert.ok(keepsClearing.get(mode)!.has(LIP_CAR_SPEED_KEEP), `LIP_CAR_SPEED_KEEP ${LIP_CAR_SPEED_KEEP} clears every bar on the ${mode}`);
      assert.equal(clearsAll.get(NO_CUT_KEEP), false, "with no cut the bars fail");
    });
  }

  it("when the keeps that clear every bar on each station are read together, then LIP_CAR_SPEED_KEEP is the largest candidate clearing both", () => {
    const both = CANDIDATE_KEEPS.filter((keep) => LIP_MODES.every((mode) => keepsClearing.get(mode)!.has(keep)));
    assert.equal(LIP_CAR_SPEED_KEEP, Math.max(...both), `candidates clearing both stations: ${both.join(", ")}`);
  });
});
