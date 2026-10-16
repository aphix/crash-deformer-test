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
import { RANGE } from "./range.ts";
import { MinigameGround } from "./minigame-ground.ts";
import { BOX_NET_CLEARANCE, BOX_PILE_TRAIL, HighJumpCapture, highJumpLayout, POSTS_DISTANCE, type HighJumpMeasured, type TorsoSample } from "./minigame-high-jump.ts";
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
/**
 * A mid run is governed to this share of the best run's horizontal speed at the lip (the long jump: of its approach speed, the fastest before
 * the barrier). The long jump's is higher because the barrier's hit throws no driver below about 18 m/s (the muscle, truck and monster at 70%
 * of their 24.5-26.7 m/s approach do not throw at all, the monster needs 21.5), so 70% is not a run the game can score.
 */
const MID_RUN_SPEED_SHARE: Readonly<Record<MinigameMode, number>> = { longJump: 0.85, highJump: 0.7, ringFling: 0.7 };
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

/**
 * The high jump's bars. Crossing heights are the torso's metres above the lip at the posts' plane: the best class's best run (the owner's
 * 157 m was acceptable; the frame is set from it), and the least any class's best run crosses at (well over the first boards). Every class
 * must still cross the plane at `CROSSING_SHARE_TARGET` of its full-throttle lip speed (a run slower than that scores 0).
 */
const BEST_CROSSING_BAND = { minimum: 150, maximum: 160 } as const;
const BEST_RUN_CROSSING_MINIMUM = 60;
const CROSSING_SHARE_TARGET = 0.8;
/** The search for the lowest speed share a class still crosses at: between these shares, this many halvings (a resolution of 0.5%). */
const CROSSING_SEARCH = { low: 0.3, high: 1, halvings: 7 } as const;
/** The forward mutation that shrinks the flights: forward times this must stop the sedan crossing at the target share. */
const FORWARD_CUT_FACTOR = 0.8;

/** The five classes whose full-throttle speed at Ring Fling's lip is within 1% of one another (32.2 to 32.5 m/s); the muscle (35.6) and the monster (38.2) are the higher lines. */
const STANDARD_CLASS_IDS: readonly string[] = ["sedan", "truck", "police", "hatchback", "wagon"];
/** The speed shares of the best run that the Ring Fling sweep walks through. */
const RING_SWEEP = { first: 0.6, last: 1, step: 0.02 } as const;

/**
 * The long jump's bars (m past the barrier). The range's farthest sign stands at `signStep * signs` and its field ends at `length`: the best
 * class's best run must land and rest past that sign and short of the field's end; every class's mid run rests past `LONG_JUMP_MID_REACH`.
 */
const LONG_JUMP_FAR_SIGN = RANGE.signStep * RANGE.signs;
const LONG_JUMP_MID_REACH = 50;
/** The long jump's mutations: upward times the first must keep the best run from the far sign, times the second must carry it past the field's end. */
const LONG_JUMP_UPWARD_CUT = 0.5;
const LONG_JUMP_UPWARD_BOOST = 1.3;
/**
 * The classes whose slower (mid) run lands shorter than their full-throttle run. The muscle, truck and monster are left out: a slower car
 * leaves the barrier with MORE upward speed (the monster 4.7 m/s against 3.4 m/s at full throttle, its pre.y carried off the incline), a
 * ratio no boost multiplier can change, which outweighs the 15% lower horizontal speed.
 */
const SPEED_MONOTONE_CLASS_IDS: readonly string[] = ["sedan", "muscle", "police", "hatchback", "wagon"];

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
    const speedCap = run === "best" ? Infinity : MID_RUN_SPEED_SHARE[mode] * capture(type, mode, "best").approachSpeed;
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
  /** His torso's height above the lip as it crosses the posts' plane (`HighJumpCapture`, the score's own rule): 0 if he never crosses it. */
  crossingHeight: number;
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
  const crossingCapture = new HighJumpCapture();
  let previousSample: TorsoSample | null = null;
  const flight: Flight = {
    apexHeight: -Infinity,
    apexDistance: 0,
    crossingHeight: 0,
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
    const sample: TorsoSample = { x: distance, y: torso.y, z: torso.z - anchor.z, still: flight.still };
    flight.crossingHeight = crossingCapture.step(previousSample, sample, POSTS_DISTANCE, lip) ?? flight.crossingHeight;
    previousSample = sample;
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
const crossingOf = (flight: Flight): number => flight.crossingHeight;
const landingOf = (flight: Flight): number => flight.landingDistance;
const restOf = (flight: Flight): number => flight.restDistance;

const bestRunsOf = (rows: readonly Measurement[]): Measurement[] => rows.filter((row) => row.run === "best");
const midRunsOf = (rows: readonly Measurement[]): Measurement[] => rows.filter((row) => row.run === "mid");

/** The class whose best run crosses the posts' plane highest: the one the frame is sized to. */
function bestClassRun(rows: readonly Measurement[]): Measurement {
  return bestRunsOf(rows).reduce((best, row) => (lowest(row, crossingOf) > lowest(best, crossingOf) ? row : best));
}

const scaled = (scale: ReleaseScale, factors: Partial<ReleaseScale>): ReleaseScale => ({ forward: scale.forward * (factors.forward ?? 1), upward: scale.upward * (factors.upward ?? 1) });
const metres = (value: number): string => value.toFixed(1);

/** What `highJumpLayout` is given from repeat `repeat`: the best class's best crossing, and the farthest any class's best run lands. */
function measuredBest(rows: readonly Measurement[], repeat: number): HighJumpMeasured {
  return {
    crossingHeight: bestClassRun(rows).flights[repeat]!.crossingHeight,
    landingDistance: Math.max(...bestRunsOf(rows).map((row) => row.flights[repeat]!.landingDistance)),
  };
}

/** What a high jump boost breaks, from every class's best run: empty when every bar holds. */
function highJumpViolations(rows: readonly Measurement[]): string[] {
  const violations: string[] = [];
  const bestClass = bestClassRun(rows);
  const layout = highJumpLayout(measuredBest(rows, 0), lipHeight("highJump"));
  if (lowest(bestClass, crossingOf) < BEST_CROSSING_BAND.minimum) violations.push(`the ${bestClass.type.id}'s best crossing is ${metres(lowest(bestClass, crossingOf))} m, under ${BEST_CROSSING_BAND.minimum}`);
  if (highest(bestClass, crossingOf) > BEST_CROSSING_BAND.maximum) violations.push(`the ${bestClass.type.id}'s best crossing is ${metres(highest(bestClass, crossingOf))} m, over ${BEST_CROSSING_BAND.maximum}`);
  for (const row of bestRunsOf(rows)) {
    if (lowest(row, crossingOf) < BEST_RUN_CROSSING_MINIMUM) violations.push(`the ${row.type.id}'s best run crosses at only ${metres(lowest(row, crossingOf))} m`);
    if (highest(row, landingOf) + BOX_PILE_TRAIL > layout.netX - BOX_NET_CLEARANCE) violations.push(`the ${row.type.id}'s best run lands at ${metres(highest(row, landingOf))} m, past the box piles' end (net at ${metres(layout.netX)})`);
  }
  return violations;
}

/** Per class: the lowest share of its full-throttle lip speed (the release scaled alike, horizontal and vertical) at which his torso still crosses the posts' plane. */
async function crossingShares(scale: ReleaseScale): Promise<Map<string, number>> {
  const range = await rangeFor("highJump");
  const shares = new Map<string, number>();
  for (const type of DRIVER_CARS) {
    const thrown = capture(type, "highJump", "best");
    let low: number = CROSSING_SEARCH.low;
    let high: number = CROSSING_SEARCH.high;
    for (let halving = 0; halving < CROSSING_SEARCH.halvings; halving++) {
      const middle = (low + high) / 2;
      if (fly(range, "highJump", thrown, scaled(scale, { forward: middle, upward: middle }), 0).crossingHeight > 0) high = middle;
      else low = middle;
    }
    shares.set(type.id, high);
  }
  return shares;
}

/** The classes that stop crossing the posts' plane above `CROSSING_SHARE_TARGET` of their full-throttle speed. */
function crossingShareViolations(shares: ReadonlyMap<string, number>): string[] {
  return [...shares].filter(([, share]) => share > CROSSING_SHARE_TARGET).map(([id, share]) => `the ${id} stops crossing the posts below ${share.toFixed(2)} of full speed, over ${CROSSING_SHARE_TARGET}`);
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

/** What a long jump boost breaks, from every class's best and mid run: empty when every bar holds. The best class is the one whose best run lands farthest (a rest is a skid lottery on top of the landing). */
function longJumpViolations(rows: readonly Measurement[]): string[] {
  const violations: string[] = [];
  const bestClass = bestRunsOf(rows).reduce((best, row) => (lowest(row, landingOf) > lowest(best, landingOf) ? row : best));
  if (lowest(bestClass, landingOf) < LONG_JUMP_FAR_SIGN) violations.push(`the ${bestClass.type.id}'s best run lands at ${metres(lowest(bestClass, landingOf))} m, short of the ${LONG_JUMP_FAR_SIGN} m sign`);
  if (lowest(bestClass, restOf) < LONG_JUMP_FAR_SIGN) violations.push(`the ${bestClass.type.id}'s best run rests at ${metres(lowest(bestClass, restOf))} m, short of the ${LONG_JUMP_FAR_SIGN} m sign`);
  if (highest(bestClass, restOf) > RANGE.length) violations.push(`the ${bestClass.type.id}'s best run rests at ${metres(highest(bestClass, restOf))} m, past the field's end at ${RANGE.length} m`);
  for (const row of midRunsOf(rows)) {
    if (lowest(row, restOf) < LONG_JUMP_MID_REACH) violations.push(`the ${row.type.id}'s mid run rests at ${metres(lowest(row, restOf))} m, short of ${LONG_JUMP_MID_REACH} m`);
  }
  for (const id of SPEED_MONOTONE_CLASS_IDS) {
    const best = bestRunsOf(rows).find((row) => row.type.id === id)!;
    const mid = midRunsOf(rows).find((row) => row.type.id === id)!;
    if (lowest(best, landingOf) <= highest(mid, landingOf)) violations.push(`the ${id}'s mid run lands at ${metres(highest(mid, landingOf))} m, no shorter than its best run's ${metres(lowest(best, landingOf))} m`);
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
  it("when each of the 7 classes' best and mid runs is thrown, then the best class crosses the posts at 150-160 m, every class's best run is well up the boards and lands in the box field, and every class still crosses at 80% of full speed", async (t) => {
    const rows = await measure("highJump", THROW_BOOST.highJump, REPEATS);
    const shares = await crossingShares(THROW_BOOST.highJump);
    const layout = highJumpLayout(measuredBest(rows, 0), lipHeight("highJump"));
    const shareLines = [...shares].map(([id, share]) => `${id} ${share.toFixed(2)}`).join(", ");
    t.diagnostic(`THROW_BOOST.highJump ${JSON.stringify(THROW_BOOST.highJump)}; posts ${layout.postsX} m, net ${layout.netX} m, box piles end ${metres(layout.boxes.reduce((end, box) => Math.max(end, box.x), 0))} m, frame top ${layout.frameTop} m\nlowest speed share that still crosses the posts: ${shareLines}\n${TABLE_HEADER}\n${tableOf(rows, (flight) => `crosses at ${metres(flight.crossingHeight)} m`)}`);
    assert.deepEqual(highJumpViolations(rows), []);
    assert.deepEqual(crossingShareViolations(shares), []);
  });

  it("when the boost is the identity (the throw as the sim has it), then the bars break: the best class crosses far under the band and every landing is far past the net", async () => {
    const violations = highJumpViolations(await measure("highJump", NO_RELEASE_SCALE, 1));
    assert.ok(violations.some((violation) => violation.includes("best crossing")), violations.join("; "));
    assert.ok(violations.some((violation) => violation.includes("past the box piles")), violations.join("; "));
  });

  it(`when forward is ${FORWARD_MUTATION_FACTOR} times the chosen, then the best runs land past the box piles' end (the window holds only at the chosen forward)`, async () => {
    const violations = highJumpViolations(await measure("highJump", scaled(THROW_BOOST.highJump, { forward: FORWARD_MUTATION_FACTOR }), 1));
    assert.ok(violations.some((violation) => violation.includes("past the box piles")), violations.join("; "));
  });

  it(`when upward is ${UPWARD_MUTATION_FACTOR} times the chosen, then the best class crosses over the band`, async () => {
    const violations = highJumpViolations(await measure("highJump", scaled(THROW_BOOST.highJump, { upward: UPWARD_MUTATION_FACTOR }), 1));
    assert.ok(violations.some((violation) => violation.includes("best crossing") && violation.includes("over")), violations.join("; "));
  });

  it(`when forward is ${FORWARD_CUT_FACTOR} times the chosen, then a class stops crossing the posts above ${CROSSING_SHARE_TARGET} of full speed`, async () => {
    const violations = crossingShareViolations(await crossingShares(scaled(THROW_BOOST.highJump, { forward: FORWARD_CUT_FACTOR })));
    assert.ok(violations.length > 0);
  });

  it("when the best class's best run is thrown again, then HIGH_JUMP_MEASURED is its crossing height and the farthest best landing, within 2%", async () => {
    const rows = await measure("highJump", THROW_BOOST.highJump, REPEATS);
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      const measured = measuredBest(rows, repeat);
      for (const key of ["crossingHeight", "landingDistance"] as const) {
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
  it("when each of the 7 classes' best and mid runs is thrown, then the best class's best run lands and rests between the 100 m sign and the field's end, every mid run rests past 50 m, and a slower run lands shorter for the classes whose carry allows", async (t) => {
    const rows = await measure("longJump", THROW_BOOST.longJump, REPEATS);
    t.diagnostic(`THROW_BOOST.longJump ${JSON.stringify(THROW_BOOST.longJump)}\n${TABLE_HEADER}\n${tableOf(rows, (flight) => `sign ${Math.min(LONG_JUMP_FAR_SIGN, Math.floor(flight.restDistance / RANGE.signStep) * RANGE.signStep)} m`)}`);
    assert.deepEqual(longJumpViolations(rows), []);
  });

  it("when the boost is the identity (the throw as the sim has it), then the best run is far short of the 100 m sign", async () => {
    const violations = longJumpViolations(await measure("longJump", NO_RELEASE_SCALE, 1));
    assert.ok(violations.some((violation) => violation.includes("best run lands") && violation.includes("short of")), violations.join("; "));
  });

  it(`when upward is ${LONG_JUMP_UPWARD_CUT} times the chosen, then the best run falls short of the 100 m sign`, async () => {
    const violations = longJumpViolations(await measure("longJump", scaled(THROW_BOOST.longJump, { upward: LONG_JUMP_UPWARD_CUT }), 1));
    assert.ok(violations.some((violation) => violation.includes("best run lands") && violation.includes("short of")), violations.join("; "));
  });

  it(`when upward is ${LONG_JUMP_UPWARD_BOOST} times the chosen, then the best run is carried past the field's end`, async () => {
    const violations = longJumpViolations(await measure("longJump", scaled(THROW_BOOST.longJump, { upward: LONG_JUMP_UPWARD_BOOST }), 1));
    assert.ok(violations.some((violation) => violation.includes("past the field's end")), violations.join("; "));
  });
});
