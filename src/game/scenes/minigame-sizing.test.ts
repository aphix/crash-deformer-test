import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { FREEWHEEL, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { DRIVER_CARS, type DriverCar } from "../match/types.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { NO_RELEASE_SCALE, type ReleaseScale } from "../present/ragdoll-boxes.ts";
import { displayFrames } from "../present/range-run.test-util.ts";
import { layOnGround } from "../vehicle/car-air-points.ts";
import { idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { activeGround, setGround, type Ground } from "../world/ground.ts";
import { HIGH_JUMP_MEASURED, REST_HOLD, STATION_ANCHORS, THROW_BOOST, type MinigameMode } from "./minigame-constants.ts";
import { JerseyBarrier } from "./engine-props.ts";
import { MinigameGround } from "./minigame-ground.ts";
import { BOX_NET_CLEARANCE, BOX_PILE_TRAIL, highJumpLayout, type HighJumpMeasured } from "./minigame-high-jump.ts";
import { lipHeight } from "./minigame-profile.ts";
import { dressedDriverCar } from "./minigame-profile.test-util.ts";
import { RING_BACKSTOP, RING_BOARD_BOUNDS, RING_CUPS, ringScore } from "./minigame-ring.ts";

/**
 * Sizing of `THROW_BOOST` and `HIGH_JUMP_MEASURED`: every number here is measured with the real pieces. The car is driven from its parked
 * start on the real `MinigameGround` (the lip's forced throw through `collideHook`), the sim's own Ejection event is taken, and the real
 * `RagdollSystem.launch` throws the dummy with the boost under test and steps him until he lies still. A run is a car type's best (full
 * throttle) or its mid run (its throttle and brake hold its horizontal speed to `MID_RUN_SPEED_SHARE` of the best run's speed at the lip).
 */

/** The net the measurement ground hangs: far past every landing, so it never touches the throws it measures. */
const FAR_NET = { netX: 400, netHalfWidth: 6, netHeight: 14 } as const;

const FRAME = 1 / FRAME_HZ;
/** How long (s) a parked car is left alone before the release, and how long a run may last. */
const HOLD_SECONDS = 2;
const RUN_SECONDS = 60;
const STALLED_SPEED = 0.5;
const STALL_SECONDS = 2;
/** Steering: how far ahead (m) the car aims, per metre of its speed, and its gain. */
const STEER_LOOK_AHEAD = 10;
const STEER_LOOK_PER_SPEED = 0.4;
const STEER_GAIN = 2.5;
/** Throttle (and brake) per m/s the car is under (over) its horizontal speed cap: the governor of the mid runs. */
const GOVERNOR_GAIN = 1;
/** A mid run is governed to this share of the best run's horizontal speed at the lip. */
const MID_RUN_SPEED_SHARE = 0.7;
/** A thrown dummy is stepped until his torso has lain still `REST_HOLD` s, or this many sim seconds. */
const THROW_LIMIT_SECONDS = 60;
/** A ragdoll is not bit-deterministic across runs (the display's frame times change his steps): each shipped throw is made this many times, seeded `0` (steady 60 Hz) up, and the worst is held to the bar. */
const REPEATS = 3;
/** His torso has touched down when it is this near (m) the ground under it, after its apex. */
const TOUCHDOWN_HEIGHT = 1;
/** The mutations: forward times this must carry the best runs past the high jump's box piles (and Ring Fling's mid cups), upward times this must lift the monster over the apex band. */
const FORWARD_MUTATION_FACTOR = 1.5;
const UPWARD_MUTATION_FACTOR = 1.1;
/** A recomputed `HIGH_JUMP_MEASURED` number is within this share of the pinned one. */
const MEASURED_TOLERANCE = 0.02;

/** The high jump's bars (m above the lip): the best class's best apex (the owner's 157 m was acceptable, the frame top is set from it), the least any class's best run reaches (well over the first boards), the least any class's mid run reaches. */
const BEST_APEX_BAND = { minimum: 150, maximum: 160 } as const;
const BEST_RUN_APEX_MINIMUM = 60;
const MID_RUN_APEX_MINIMUM = 40;

/** The five classes whose full-throttle speed at Ring Fling's lip is within 1% of one another (32.2 to 32.5 m/s); the muscle (35.6) and the monster (38.2) are the higher lines. */
const STANDARD_CLASS_IDS: readonly string[] = ["sedan", "truck", "police", "hatchback", "wagon"];
/** The speed shares of the best run that the Ring Fling sweep walks through. */
const RING_SWEEP = { first: 0.6, last: 1, step: 0.02 } as const;

/** The long jump's bars (m past the barrier): the best class's best run lands and rests past the farthest sign, every class's mid run rests past this. The signs stand every 10 m. */
const LONG_JUMP_FAR_SIGN = 100;
const LONG_JUMP_MID_REACH = 50;
const SIGN_SPACING = 10;
/** The long jump's upward mutation: the chosen upward times this must keep the best run from the far sign. */
const LONG_JUMP_UPWARD_CUT = 0.5;

type RunKind = "best" | "mid";

/** One drive's throw: the sim's own Ejection event, the car's velocity as he left, and the horizontal speed (m/s) the run came in at: the lip's, or the fastest before the barrier's hit (the car is slowed by the hit before the event reads its velocity). */
type Capture = { event: Ejection; horizontalSpeed: number; verticalSpeed: number; approachSpeed: number };

function copyEjection(event: Ejection): Ejection {
  return { ...event, pos: event.pos.clone(), local: event.local.clone(), dir: event.dir.clone(), quat: event.quat.clone(), rel: event.rel.clone(), carVel: event.carVel.clone(), spin: event.spin.clone() };
}

const captures = new Map<string, Capture>();

/**
 * One car of `type` parked at the station's start on the real ground, left alone, then released at full throttle (the mid run: its throttle
 * and brake hold its horizontal speed to `speedCap`) and steered down the lane's middle until the sim throws its driver: at the lip on the high
 * jump and Ring Fling (`collideHook`), by the hit on the jersey barrier at the world origin on the long jump.
 */
function drive(type: DriverCar, mode: MinigameMode, speedCap: number): Capture {
  const anchor = STATION_ANCHORS[mode];
  const ground = new MinigameGround({ highJump: FAR_NET });
  setGround(ground);
  const car = dressedDriverCar(type);
  try {
    const start = ground.stationStart(mode);
    car.spawnFacing(start.x, start.z, start.yaw, 0);
    car.group.position.y = start.y;
    layOnGround(car);
    car.parked = true;
    const world = makeWorld([car], false, false, FREEWHEEL);
    if (mode === "longJump") {
      const barrier = new JerseyBarrier(new THREE.Scene(), new THREE.Group());
      barrier.orient(car.group.position, false);
      world.world.barrier = barrier;
    } else {
      world.world.collide = ground.collideHook([car], world.world.ejection!);
    }
    const outcome: { capture: Capture | null } = { capture: null };
    world.onEject = (event) => {
      outcome.capture ??= { event: copyEjection(event), horizontalSpeed: Math.hypot(event.carVel.x, event.carVel.z), verticalSpeed: event.carVel.y, approachSpeed: 0 };
    };
    for (let step = 0; step < HOLD_SECONDS / FRAME; step++) tickWorld(world);
    const input: DriveInput = { ...idleDrive(), throttle: 1 };
    world.pedals.set(car, input);
    const position = car.group.position;
    let stalledFor = 0;
    let fastestApproach = 0;
    for (let step = 0; step < RUN_SECONDS / FRAME && outcome.capture === null; step++) {
      const aheadX = position.x + STEER_LOOK_AHEAD + car.speed * STEER_LOOK_PER_SPEED;
      const error = Math.atan2(aheadX - position.x, anchor.z - position.z) - car.yaw;
      input.steer = Math.max(-1, Math.min(1, STEER_GAIN * Math.atan2(Math.sin(error), Math.cos(error))));
      const horizontalSpeed = Math.hypot(car.velocity.x, car.velocity.z);
      if (outcome.capture === null) fastestApproach = Math.max(fastestApproach, horizontalSpeed);
      input.throttle = Math.max(0, Math.min(1, GOVERNOR_GAIN * (speedCap - horizontalSpeed)));
      input.brake = Math.max(0, Math.min(1, GOVERNOR_GAIN * (horizontalSpeed - speedCap)));
      tickWorld(world);
      stalledFor = car.speed < STALLED_SPEED ? stalledFor + FRAME : 0;
      if (stalledFor > STALL_SECONDS) break;
    }
    assert.ok(outcome.capture !== null, `${type.id} on ${mode} at cap ${speedCap}: nobody was thrown`);
    outcome.capture.approachSpeed = mode === "longJump" ? fastestApproach : outcome.capture.horizontalSpeed;
    return outcome.capture;
  } finally {
    car.dispose();
    setGround(null);
  }
}

/** The throw of `type` on `mode`: the best run (full throttle) or the mid one (governed to `MID_RUN_SPEED_SHARE` of the best's horizontal speed at the lip). */
function capture(type: DriverCar, mode: MinigameMode, run: RunKind): Capture {
  const key = `${mode}:${type.id}:${run}`;
  let cached = captures.get(key);
  if (cached === undefined) {
    const speedCap = run === "best" ? Infinity : MID_RUN_SPEED_SHARE * capture(type, mode, "best").approachSpeed;
    cached = drive(type, mode, speedCap);
    captures.set(key, cached);
  }
  return cached;
}

/** A ragdoll system and the ground it was built on: its statics are built once, at its first throw, from the ground active then. */
type RagdollRange = { system: RagdollSystem; ground: Ground };

const systems: RagdollSystem[] = [];
let launchCar: DeformableCar | null = null;

after(() => {
  for (const system of systems.splice(0)) system.dispose();
  launchCar?.dispose();
});

/** A ragdoll system on `ground` as the range runs it (sand on), dummies held lying where they land. */
async function ragdollOn(ground: Ground): Promise<RagdollRange> {
  const system = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  system.sand = true;
  await system.preload();
  setGround(ground);
  system.update(FRAME, [], true, false, null);
  system.holdThrown();
  systems.push(system);
  setGround(null);
  return { system, ground };
}

const ranges = new Map<MinigameMode, Promise<RagdollRange>>();

function rangeFor(mode: MinigameMode): Promise<RagdollRange> {
  let range = ranges.get(mode);
  if (range === undefined) {
    range = ragdollOn(new MinigameGround({ highJump: FAR_NET }));
    ranges.set(mode, range);
  }
  return range;
}

/** What one thrown dummy did, in the station's frame: x past the lip, y above the lip, z off the lane's middle. */
type Flight = {
  apexHeight: number;
  apexDistance: number;
  /** Where his torso first came within `TOUCHDOWN_HEIGHT` of the ground after its apex. */
  landingDistance: number;
  /** Where his torso lay when it had been still `REST_HOLD` s, and its height (m above the pad). */
  restDistance: number;
  restLateral: number;
  restHeight: number;
  still: number;
  /** The launch velocity he left at (m/s, world): the event's, scaled. */
  release: THREE.Vector3;
};

/** `thrown`'s dummy launched through the real `RagdollSystem.launch` with `scale`, stepped (frame times seeded by `seed`) until he lies still. */
function fly(range: RagdollRange, mode: MinigameMode, thrown: Capture, scale: ReleaseScale, seed: number): Flight {
  const { system, ground } = range;
  setGround(ground);
  const anchor = STATION_ANCHORS[mode];
  const lip = lipHeight(mode);
  launchCar ??= dressedDriverCar(DRIVER_CARS[0]!);
  system.holdThrown();
  system.launch(thrown.event, [launchCar], true, scale);
  const dummy = system["dolls"].find((doll) => doll.live)!;
  const launched = dummy.bodies[0]!.linvel();
  const torso = new THREE.Vector3();
  const frameSeconds = displayFrames(FRAME_HZ, seed);
  const flight: Flight = {
    apexHeight: -Infinity,
    apexDistance: 0,
    landingDistance: NaN,
    restDistance: 0,
    restLateral: 0,
    restHeight: 0,
    still: 0,
    release: new THREE.Vector3(launched.x, launched.y, launched.z),
  };
  for (let elapsed = 0; elapsed < THROW_LIMIT_SECONDS && flight.still < REST_HOLD; ) {
    const frameDuration = frameSeconds();
    elapsed += frameDuration;
    system.update(frameDuration, [], true, false, null);
    flight.still = system.latest(torso);
    const distance = torso.x - anchor.x;
    if (torso.y - lip > flight.apexHeight) {
      flight.apexHeight = torso.y - lip;
      flight.apexDistance = distance;
    }
    const afterApex = flight.apexDistance < distance;
    if (Number.isNaN(flight.landingDistance) && afterApex && torso.y - activeGround().heightAt(torso.x, torso.z, torso.y) <= TOUCHDOWN_HEIGHT) flight.landingDistance = distance;
  }
  flight.restDistance = torso.x - anchor.x;
  flight.restLateral = torso.z - anchor.z;
  flight.restHeight = torso.y;
  system.releaseThrown();
  setGround(null);
  return flight;
}

/** One car type's run on a station with a boost: the drive's throw and every repeat's flight. */
type Measurement = { type: DriverCar; run: RunKind; thrown: Capture; flights: Flight[] };

const measurements = new Map<string, Measurement[]>();

/** Every class's best and mid run through `mode` with `scale`, each thrown `repeats` times. */
async function measure(mode: MinigameMode, scale: ReleaseScale, repeats: number): Promise<Measurement[]> {
  const key = `${mode}:${scale.forward}:${scale.upward}:${repeats}`;
  let cached = measurements.get(key);
  if (cached === undefined) {
    const range = await rangeFor(mode);
    cached = [];
    for (const type of DRIVER_CARS) {
      for (const run of ["best", "mid"] as const) {
        const thrown = capture(type, mode, run);
        cached.push({ type, run, thrown, flights: Array.from({ length: repeats }, (_, seed) => fly(range, mode, thrown, scale, seed)) });
      }
    }
    measurements.set(key, cached);
  }
  return cached;
}

const lowest = (measurement: Measurement, pick: (flight: Flight) => number): number => Math.min(...measurement.flights.map(pick));
const highest = (measurement: Measurement, pick: (flight: Flight) => number): number => Math.max(...measurement.flights.map(pick));
const apexHeightOf = (flight: Flight): number => flight.apexHeight;
const landingOf = (flight: Flight): number => flight.landingDistance;
const restOf = (flight: Flight): number => flight.restDistance;

const bestRunsOf = (rows: readonly Measurement[]): Measurement[] => rows.filter((row) => row.run === "best");
const midRunsOf = (rows: readonly Measurement[]): Measurement[] => rows.filter((row) => row.run === "mid");

/** The class whose best run flies highest: the one the frame is sized to. */
function bestClassRun(rows: readonly Measurement[]): Measurement {
  return bestRunsOf(rows).reduce((best, row) => (lowest(row, apexHeightOf) > lowest(best, apexHeightOf) ? row : best));
}

const scaled = (scale: ReleaseScale, factors: Partial<ReleaseScale>): ReleaseScale => ({ forward: scale.forward * (factors.forward ?? 1), upward: scale.upward * (factors.upward ?? 1) });
const metres = (value: number): string => value.toFixed(1);

/** The best class's best run as `highJumpLayout` takes it: the first (steady 60 Hz) repeat. */
function measuredBest(rows: readonly Measurement[]): HighJumpMeasured {
  const flight = bestClassRun(rows).flights[0]!;
  return { apexHeight: flight.apexHeight, apexDistance: flight.apexDistance, landingDistance: flight.landingDistance };
}

/** What a high jump boost breaks, from every class's best and mid run: empty when every bar holds. */
function highJumpViolations(rows: readonly Measurement[]): string[] {
  const violations: string[] = [];
  const bestClass = bestClassRun(rows);
  const layout = highJumpLayout(measuredBest(rows), lipHeight("highJump"));
  if (lowest(bestClass, apexHeightOf) < BEST_APEX_BAND.minimum) violations.push(`the ${bestClass.type.id}'s best apex is ${metres(lowest(bestClass, apexHeightOf))} m, under ${BEST_APEX_BAND.minimum}`);
  if (highest(bestClass, apexHeightOf) > BEST_APEX_BAND.maximum) violations.push(`the ${bestClass.type.id}'s best apex is ${metres(highest(bestClass, apexHeightOf))} m, over ${BEST_APEX_BAND.maximum}`);
  for (const row of bestRunsOf(rows)) {
    if (lowest(row, apexHeightOf) < BEST_RUN_APEX_MINIMUM) violations.push(`the ${row.type.id}'s best run reaches only ${metres(lowest(row, apexHeightOf))} m`);
    if (lowest(row, landingOf) < layout.postsX) violations.push(`the ${row.type.id}'s best run lands at ${metres(lowest(row, landingOf))} m, before the posts at ${metres(layout.postsX)}`);
    if (highest(row, landingOf) + BOX_PILE_TRAIL > layout.netX - BOX_NET_CLEARANCE) violations.push(`the ${row.type.id}'s best run lands at ${metres(highest(row, landingOf))} m, past the box piles' end (net at ${metres(layout.netX)})`);
  }
  for (const row of midRunsOf(rows)) {
    if (lowest(row, apexHeightOf) < MID_RUN_APEX_MINIMUM) violations.push(`the ${row.type.id}'s mid run reaches only ${metres(lowest(row, apexHeightOf))} m`);
  }
  return violations;
}

/** The mid cups' band along the lane (m past the lip): from the 30 cup's near edge to the 40 cup's far edge. */
const MID_CUP_BAND = { near: RING_CUPS[2]!.centreX - RING_CUPS[2]!.radius, far: RING_CUPS[3]!.centreX + RING_CUPS[3]!.radius } as const;
/** The backstop's back face (m past the lip): a resting torso never lies past it. */
const BACKSTOP_BACK_FACE = RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard + RING_BACKSTOP.thickness;

/** What a Ring Fling boost breaks: the standard classes' full-throttle runs come down in the mid cups' band, and no class's run is carried past the backstop. */
function ringFlingViolations(rows: readonly Measurement[]): string[] {
  const violations: string[] = [];
  for (const row of bestRunsOf(rows)) {
    if (STANDARD_CLASS_IDS.includes(row.type.id)) {
      for (const [name, pick] of [["lands", landingOf], ["rests", restOf]] as const) {
        const near = lowest(row, pick);
        const far = highest(row, pick);
        if (near < MID_CUP_BAND.near || far > MID_CUP_BAND.far) violations.push(`the ${row.type.id}'s full-throttle run ${name} at ${metres(near)} to ${metres(far)} m, outside the mid cups' ${metres(MID_CUP_BAND.near)} to ${metres(MID_CUP_BAND.far)}`);
      }
    }
    if (highest(row, restOf) > BACKSTOP_BACK_FACE) violations.push(`the ${row.type.id}'s full-throttle run rests at ${metres(highest(row, restOf))} m, past the backstop (${metres(BACKSTOP_BACK_FACE)})`);
  }
  return violations;
}

/** What a long jump boost breaks: the best class's best run must land and rest past the farthest sign, and every class's mid run past `LONG_JUMP_MID_REACH`. */
function longJumpViolations(rows: readonly Measurement[]): string[] {
  const violations: string[] = [];
  const bestClass = bestRunsOf(rows).reduce((best, row) => (lowest(row, restOf) > lowest(best, restOf) ? row : best));
  if (lowest(bestClass, landingOf) < LONG_JUMP_FAR_SIGN) violations.push(`the ${bestClass.type.id}'s best run lands at ${metres(lowest(bestClass, landingOf))} m, short of the ${LONG_JUMP_FAR_SIGN} m sign`);
  if (lowest(bestClass, restOf) < LONG_JUMP_FAR_SIGN) violations.push(`the ${bestClass.type.id}'s best run rests at ${metres(lowest(bestClass, restOf))} m, short of the ${LONG_JUMP_FAR_SIGN} m sign`);
  for (const row of midRunsOf(rows)) {
    if (lowest(row, restOf) < LONG_JUMP_MID_REACH) violations.push(`the ${row.type.id}'s mid run rests at ${metres(lowest(row, restOf))} m, short of ${LONG_JUMP_MID_REACH} m`);
  }
  return violations;
}

/** One compact line per run: lip speed (horizontal/vertical), release speed (horizontal/vertical), apex (height @ distance), first touchdown, rest, and `zone`. */
function tableOf(rows: readonly Measurement[], zone: (flight: Flight) => string): string {
  return rows
    .map((row) => {
      const flight = row.flights[0]!;
      const release = `${metres(Math.hypot(flight.release.x, flight.release.z))}/${metres(flight.release.y)}`;
      return `| ${row.type.id} | ${row.run} | ${metres(row.thrown.horizontalSpeed)}/${metres(row.thrown.verticalSpeed)} | ${release} | ${metres(flight.apexHeight)} @ ${metres(flight.apexDistance)} | ${metres(flight.landingDistance)} | ${metres(flight.restDistance)} | ${zone(flight)} |`;
    })
    .join("\n");
}

const TABLE_HEADER = "| class | run | lip h/v (m/s) | release h/v (m/s) | apex (m @ m) | lands (m) | rests (m) | zone |";

describe("given the high jump with THROW_BOOST.highJump on the real ground, car and ragdoll", () => {
  it("when each of the 7 classes' best and mid runs is thrown, then the best class tops out at 150-160 m, every class reaches the boards and comes down between the posts and the net", async (t) => {
    const rows = await measure("highJump", THROW_BOOST.highJump, REPEATS);
    const layout = highJumpLayout(measuredBest(rows), lipHeight("highJump"));
    t.diagnostic(`THROW_BOOST.highJump ${JSON.stringify(THROW_BOOST.highJump)}; posts ${metres(layout.postsX)} m, net ${metres(layout.netX)} m, frame top ${layout.frameTop} m\n${TABLE_HEADER}\n${tableOf(rows, (flight) => `${metres(flight.landingDistance - layout.postsX)} past the posts`)}`);
    assert.deepEqual(highJumpViolations(rows), []);
  });

  it("when the boost is the identity (the throw as the sim has it), then the bars break: the monster flies far over the frame and every landing is far past the net", async () => {
    const violations = highJumpViolations(await measure("highJump", NO_RELEASE_SCALE, 1));
    assert.ok(violations.length > 0);
    assert.ok(violations.some((violation) => violation.includes("best apex")), violations.join("; "));
    assert.ok(violations.some((violation) => violation.includes("past the box piles")), violations.join("; "));
  });

  it(`when forward is ${FORWARD_MUTATION_FACTOR} times the chosen, then the best runs land past the box piles' end (the window holds only at the chosen forward)`, async () => {
    const violations = highJumpViolations(await measure("highJump", scaled(THROW_BOOST.highJump, { forward: FORWARD_MUTATION_FACTOR }), 1));
    assert.ok(violations.some((violation) => violation.includes("past the box piles")), violations.join("; "));
  });

  it(`when upward is ${UPWARD_MUTATION_FACTOR} times the chosen, then the monster's apex goes over the band`, async () => {
    const violations = highJumpViolations(await measure("highJump", scaled(THROW_BOOST.highJump, { upward: UPWARD_MUTATION_FACTOR }), 1));
    assert.ok(violations.some((violation) => violation.includes("best apex") && violation.includes("over")), violations.join("; "));
  });

  it("when the best class's best run is thrown again, then HIGH_JUMP_MEASURED is its apex height, apex distance and landing within 2%", async () => {
    const rows = await measure("highJump", THROW_BOOST.highJump, REPEATS);
    for (const flight of bestClassRun(rows).flights) {
      for (const key of ["apexHeight", "apexDistance", "landingDistance"] as const) {
        const measured: HighJumpMeasured = { apexHeight: flight.apexHeight, apexDistance: flight.apexDistance, landingDistance: flight.landingDistance };
        assert.ok(Math.abs(measured[key] - HIGH_JUMP_MEASURED[key]) <= MEASURED_TOLERANCE * HIGH_JUMP_MEASURED[key], `${key}: measured ${metres(measured[key])} against pinned ${HIGH_JUMP_MEASURED[key]}`);
      }
    }
  });
});

describe("given Ring Fling with THROW_BOOST.ringFling on the real ground, car and ragdoll", () => {
  it("when each of the 7 classes' best and mid runs is thrown, then the standard classes' full-throttle runs come down in the mid cups and the backstop holds the rest", async (t) => {
    const rows = await measure("ringFling", THROW_BOOST.ringFling, REPEATS);
    t.diagnostic(`THROW_BOOST.ringFling ${JSON.stringify(THROW_BOOST.ringFling)}\n${TABLE_HEADER}\n${tableOf(rows, (flight) => `cup ${ringScore(flight.restDistance, flight.restLateral)}`)}`);
    assert.deepEqual(ringFlingViolations(rows), []);
  });

  it("when the boost is the identity (the throw as the sim has it), then every full-throttle run is carried far past the board", async () => {
    const violations = ringFlingViolations(await measure("ringFling", NO_RELEASE_SCALE, 1));
    assert.ok(violations.some((violation) => violation.includes("outside the mid cups")), violations.join("; "));
  });

  it(`when forward is ${FORWARD_MUTATION_FACTOR} times the chosen, then the standard classes' full-throttle runs overshoot the mid cups`, async () => {
    const violations = ringFlingViolations(await measure("ringFling", scaled(THROW_BOOST.ringFling, { forward: FORWARD_MUTATION_FACTOR }), 1));
    assert.ok(violations.some((violation) => violation.includes("outside the mid cups")), violations.join("; "));
  });

  it("when the sedan's best run is slowed from full throttle down to 60% of its speed, then the 10, 20 and 30 cups each hold a rest at some speed", async (t) => {
    const range = await rangeFor("ringFling");
    const sedan = DRIVER_CARS.find((type) => type.id === "sedan")!;
    const thrown = capture(sedan, "ringFling", "best");
    const sweepRows: string[] = [];
    const cupsHeld = new Set<number>();
    for (let share = RING_SWEEP.first; share <= RING_SWEEP.last + 1e-9; share += RING_SWEEP.step) {
      const flight = fly(range, "ringFling", thrown, scaled(THROW_BOOST.ringFling, { forward: share, upward: share }), 0);
      const cup = ringScore(flight.restDistance, flight.restLateral);
      sweepRows.push(`${share.toFixed(2)} x lip speed (${metres(share * thrown.horizontalSpeed)} m/s): lands ${metres(flight.landingDistance)} rests ${metres(flight.restDistance)} cup ${cup}`);
      if (cup > 0) cupsHeld.add(cup);
    }
    t.diagnostic(`lip speed share -> where the sedan's dummy lands:\n${sweepRows.join("\n")}`);
    for (const cup of [10, 20, 30]) assert.ok(cupsHeld.has(cup), `no run in the sweep rested in the ${cup} cup: ${[...cupsHeld].join(", ")}`);
  });
});

describe("given the long jump with THROW_BOOST.longJump on the real ground, car, barrier and ragdoll", () => {
  it("when each of the 7 classes' best and mid runs is thrown, then the best class's best run lands past the 100 m sign and every mid run past 50 m", async (t) => {
    const rows = await measure("longJump", THROW_BOOST.longJump, REPEATS);
    t.diagnostic(`THROW_BOOST.longJump ${JSON.stringify(THROW_BOOST.longJump)}\n${TABLE_HEADER}\n${tableOf(rows, (flight) => `sign ${Math.min(LONG_JUMP_FAR_SIGN, Math.floor(flight.restDistance / SIGN_SPACING) * SIGN_SPACING)} m`)}`);
    assert.deepEqual(longJumpViolations(rows), []);
  });

  it("when the boost is the identity (the throw as the sim has it), then the best run is far short of the 100 m sign", async () => {
    const violations = longJumpViolations(await measure("longJump", NO_RELEASE_SCALE, 1));
    assert.ok(violations.some((violation) => violation.includes("best run")), violations.join("; "));
  });

  it(`when upward is ${LONG_JUMP_UPWARD_CUT} times the chosen, then the best run falls short of the 100 m sign`, async () => {
    const violations = longJumpViolations(await measure("longJump", scaled(THROW_BOOST.longJump, { upward: LONG_JUMP_UPWARD_CUT }), 1));
    assert.ok(violations.some((violation) => violation.includes("best run")), violations.join("; "));
  });
});
