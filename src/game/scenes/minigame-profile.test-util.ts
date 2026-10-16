import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { DriverCar } from "../match/types.ts";
import type { DriveInput } from "../vehicle/car-drive.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { layOnGround } from "../vehicle/car-air-points.ts";
import { FRAME, frame, worldOf } from "../vehicle/ground-probe.test-util.ts";
import { paint } from "../vehicle/test-support.ts";
import { armKill, assignClass, HANDLING, killClass } from "../vehicle/vehicle-classes.ts";
import { Ground, setGround, STEP_UP } from "../world/ground.ts";
import { FREEWHEEL, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { DEGREES_TO_RADIANS, LANDING_HEIGHT, LIP_BACK_FACE_PITCH_DEGREES, RUN_UP_LENGTH, START_HILL, THROW_YAW, type MinigameMode } from "./minigame-constants.ts";
import { climbFootX, floorHeightAt, stationBackX, stationFrontX, stationStartPose } from "./minigame-profile.ts";
import { holdForThrow, PRE_IMPACT_LEAD, preImpact, type PhaseClock } from "../match/phase.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { throwComing } from "../present/ragdoll-trigger.ts";
import { displayFrames, rangeCar } from "../present/range-run.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { JerseyBarrier } from "./engine-props.ts";

/** Half the width (m) of the test ground's lane: well past a car's side. */
const LANE_HALF_WIDTH = 3;
/** Plan cell (m) of the grid that stands for the analytic profile: fine enough for the bilinear height to be within 2 mm of it. */
export const FINE_CELL = 0.05;
/** Seconds the parked car is left alone before the release, to see it hold on the pad. */
const HOLD_SECONDS = 2;
/** The car stands still when slower than this (m/s). */
const STALLED_SPEED = 0.5;
/** A run that stands still this long (s) after the release has stalled. */
const STALL_SECONDS = 2;
/** A run ends at this many seconds after the release. */
const RUN_SECONDS = 60;
/** How far ahead (m) of the car along the lane the steering aims, and per metre of its speed. */
const STEER_LOOK_AHEAD = 10;
const STEER_LOOK_PER_SPEED = 0.4;
const STEER_GAIN = 2.5;
/** The landing plane reaches this far (m) down the throw and this far to each side, past anything a throw gets to. */
const LANDING_END_X = 400;
const LANDING_HALF_WIDTH = 60;

/** The run the test ground stands for: its height at local x, where the grid starts and ends, where the car parks and where the climb's foot is. */
export type DriveProfile = {
  heightAtX: (localX: number) => number;
  backX: number;
  frontX: number;
  startX: number;
  footX: number;
};

/** A grid of the profile from `backX` to `frontX` (two cells beyond, the profile's own height there too), `cell` m between nodes, then the level landing (one plane, which is what makes the ragdoll's world sand) past it. */
export class ProfileGround extends Ground {
  constructor(profile: DriveProfile, cell: number) {
    super();
    const lengthX = profile.frontX - profile.backX + 2 * cell;
    const nu = Math.ceil(lengthX / cell) + 1;
    const nv = Math.ceil((2 * LANE_HALF_WIDTH) / cell) + 1;
    const heights = new Float32Array(nu * nv);
    for (let i = 0; i < nu; i++) {
      const height = profile.heightAtX(profile.backX + i * cell);
      for (let j = 0; j < nv; j++) heights[j * nu + i] = height;
    }
    this.addGrid({ nu, nv, step: cell, stepV: cell, u0: 0, v0: 0, heights, ox: profile.backX, oy: 0, oz: -LANE_HALF_WIDTH, reach: STEP_UP });
    this.addPlane(LANDING_HEIGHT, profile.backX + (nu - 1) * cell, LANDING_END_X, -LANDING_HALF_WIDTH, LANDING_HALF_WIDTH, Infinity);
  }
}

/** The car of one setup-menu type, built as the range builds slot 0: its class on its body, its kill limits armed. */
export function dressedDriverCar(type: DriverCar): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, type.style);
  assignClass(car, type.cls);
  car.group.userData.carIndex = 0;
  armKill(car.deform, killClass(car), HANDLING.realism, "default");
  return car;
}

/** What one drive up a profile gave. */
export type ClimbRun = {
  /** The nose reached the lip's base line. */
  reachedLip: boolean;
  /** Metres the parked car slid in `HOLD_SECONDS` before the release. */
  heldSlide: number;
  /** Speed (m/s) as the car's centre crossed the climb's foot, and as its nose reached the lip (0: it never did). */
  footSpeed: number;
  lipSpeed: number;
  /** Speed (m/s) as the car's centre reached the lip's base line: its tyres then stand past it. */
  lipCentreSpeed: number;
  /** The slowest the car went (m/s) between its foot crossing and the lip, or the stall. */
  slowestOnClimb: number;
  /** Seconds from the release to the lip, or to the end of the run. */
  seconds: number;
  /** Where the car's centre was at the end (local x). */
  endX: number;
  /** The car's nose pitch (rad) as it reached the lip. */
  noseUp: number;
  /** The car's centre height (m above the pad) and whether its wheels were off the ground, as its nose reached the lip. */
  centreY: number;
  airborne: boolean;
};

const _forward = new THREE.Vector3();

/**
 * One car of `type` parked on the profile's pad (laid on the ground, the parked flag set), left alone to see it hold, then released at
 * full throttle and steered along the lane's middle until its nose reaches the lip's base line (x = 0), it stalls, or time runs out.
 */
export function driveToLip(type: DriverCar, profile: DriveProfile, cell: number): ClimbRun {
  const ground = new ProfileGround(profile, cell);
  setGround(ground);
  const car = dressedDriverCar(type);
  try {
    car.spawnFacing(profile.startX, 0, THROW_YAW, 0);
    car.group.position.y = ground.heightAt(profile.startX, 0, 0.5);
    layOnGround(car);
    car.parked = true;
    const world = worldOf(car);
    const clock = { acc: 0 };
    for (let n = 0; n < HOLD_SECONDS / FRAME; n++) frame(world, null, clock);
    const noseReach = car.cage.fields.planBox[3]!;
    const heldSlide = Math.abs(car.group.position.x - profile.startX);
    const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
    const run: ClimbRun = { reachedLip: false, heldSlide, footSpeed: 0, lipSpeed: 0, lipCentreSpeed: 0, slowestOnClimb: Infinity, seconds: 0, endX: 0, noseUp: 0, centreY: 0, airborne: false };
    let crossedFoot = false;
    let stalledFor = 0;
    const position = car.group.position;
    for (let n = 0; n < RUN_SECONDS / FRAME; n++) {
      const aheadX = position.x + STEER_LOOK_AHEAD + car.speed * STEER_LOOK_PER_SPEED;
      const error = Math.atan2(aheadX - position.x, -position.z) - car.yaw;
      input.steer = Math.max(-1, Math.min(1, STEER_GAIN * Math.atan2(Math.sin(error), Math.cos(error))));
      frame(world, input, clock);
      run.seconds = (n + 1) * FRAME;
      run.endX = position.x;
      if (!crossedFoot && position.x >= profile.footX) {
        crossedFoot = true;
        run.footSpeed = car.speed;
      }
      if (crossedFoot) run.slowestOnClimb = Math.min(run.slowestOnClimb, car.speed);
      stalledFor = car.speed < STALLED_SPEED ? stalledFor + FRAME : 0;
      if (!run.reachedLip && position.x + noseReach >= 0) {
        run.reachedLip = true;
        run.lipSpeed = car.speed;
        car.group.getWorldDirection(_forward);
        run.noseUp = Math.asin(_forward.y);
        run.centreY = position.y;
        run.airborne = car.airborne;
      }
      if (position.x >= 0) {
        run.lipCentreSpeed = car.speed;
        break;
      }
      if (stalledFor > STALL_SECONDS) break;
    }
    return run;
  } finally {
    car.dispose();
    setGround(null);
  }
}

/** The station `mode` as it ships, as a drive profile. */
export function stationDriveProfile(mode: MinigameMode): DriveProfile {
  return {
    heightAtX: (localX) => floorHeightAt(mode, localX, 0),
    backX: stationBackX(mode),
    frontX: stationFrontX(mode),
    startX: stationStartPose(mode).x,
    footX: climbFootX(mode),
  };
}

/**
 * The high jump with its kicker an arc of `radius` m up to `pitchDegrees` (its back face as shipped) and its run-up `runUp` m long: the
 * pad and start hill are the shipped ones moved to meet it. At the shipped radius, pitch and run-up it is the shipped station.
 */
export function highJumpVariant(radius: number, pitchDegrees: number, runUp: number): DriveProfile {
  const shipped = stationDriveProfile("highJump");
  const footX = -radius * Math.sin(pitchDegrees * DEGREES_TO_RADIANS);
  const hillFootX = footX - runUp;
  const shift = shipped.footX - RUN_UP_LENGTH.highJump - hillFootX;
  const lipY = -START_HILL.drop + radius - Math.sqrt(radius * radius - footX * footX);
  const backFaceSlope = Math.tan(LIP_BACK_FACE_PITCH_DEGREES * DEGREES_TO_RADIANS);
  return {
    heightAtX: (localX) => {
      if (localX >= 0) return Math.max(LANDING_HEIGHT, lipY - localX * backFaceSlope);
      if (localX > footX) return -START_HILL.drop + radius - Math.sqrt(radius * radius - (localX - footX) ** 2);
      if (localX > hillFootX) return -START_HILL.drop;
      return floorHeightAt("highJump", localX + shift, 0);
    },
    backX: shipped.backX - shift,
    frontX: (lipY - LANDING_HEIGHT) / backFaceSlope,
    startX: shipped.startX - shift,
    footX,
  };
}

/** Wall seconds a throw run may last, and wall seconds after the hit with nobody thrown before it is called a no-throw. */
const THROW_WALL_MAX = 60;
const NO_THROW_AFTER = 8;
/** How far back (s) the ejection reads the car's velocity before the hit (`PRE` in the ejection watch, which keeps it private). */
const EJECTION_PRE_SECONDS = 0.35;

/** How a car drives into the barrier: its pedals lift past `liftX` (local x), and `carryVertical` adds to the thrown driver the car's vertical velocity as it was `EJECTION_PRE_SECONDS` before the hit (what the ejection will carry once it does). */
export type BarrierRun = { liftX: number; carryVertical: boolean };

/** What one drive into the barrier gave. */
export type BarrierThrow = {
  /** Drivers thrown out of the car. */
  ejections: number;
  /** The fastest the car went (m/s) before the first ejection. */
  carSpeed: number;
  /** The thrown driver's torso x (m past the barrier) when his life ended, or null if nobody was thrown. */
  distance: number | null;
  /** His torso's highest point (m above the pad) in flight. */
  apex: number;
  /** The torso's launch velocity (m/s) read at the first ejection. */
  release: THREE.Vector3;
};

/** `CrashEngine.maybePreSlowmo` for the one car at sim second `simulated`: the engine's rule on the barrier's contact time. */
function slowMotionBeforeImpact(clock: PhaseClock, car: DeformableCar, barrier: JerseyBarrier, wallDt: number, simulated: number): void {
  if (clock.phase !== "approach") return;
  car.refreshBasis();
  preImpact(clock, barrier.contactEta([car], Number.POSITIVE_INFINITY), simulated, Math.max(PRE_IMPACT_LEAD, wallDt + 1 / FRAME_HZ), 1 / FRAME_HZ, () => throwComing([car], barrier));
}

/**
 * One car of `type` parked at local x `startX` of `ground` (null: the range's flat ground), released at full throttle and steered down
 * +x, its pedals lifted past `liftX` (the range's cars coast into the barrier in neutral), into the jersey barrier at the world origin, its
 * driver thrown as the range throws him (`rangeThrow`'s engine frames, ragdoll and slow motion). Runs until his dummy is gone; `distance` is where his torso lay.
 */
export async function driveIntoBarrier(type: DriverCar, ground: Ground | null, startX: number, run: BarrierRun): Promise<BarrierThrow> {
  setGround(ground);
  const car = rangeCar(type);
  car.spawnFacing(startX, 0, THROW_YAW, 0);
  car.group.position.y = ground ? ground.heightAt(startX, 0, 0.5) : 0;
  if (ground) layOnGround(car);
  const barrier = new JerseyBarrier(new THREE.Scene(), new THREE.Group());
  barrier.orient(car.group.position, false);
  const world = makeWorld([car], false, true, FREEWHEEL);
  world.world.barrier = barrier;
  const input: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };
  const inner = world.world.beforeSlice!;
  world.world.beforeSlice = (slice) => {
    const aheadX = car.group.position.x + STEER_LOOK_AHEAD + car.speed * STEER_LOOK_PER_SPEED;
    const error = Math.atan2(aheadX - car.group.position.x, -car.group.position.z) - car.yaw;
    input.steer = Math.max(-1, Math.min(1, STEER_GAIN * Math.atan2(Math.sin(error), Math.cos(error))));
    if (car.group.position.x < run.liftX) world.pedals.set(car, input);
    else world.pedals.delete(car);
    return inner(slice);
  };
  const system = new RagdollSystem(new THREE.Scene(), () => holdForThrow(world.clock), () => {});
  await system.preload();
  system.sand = true;
  const out: BarrierThrow = { ejections: 0, carSpeed: 0, distance: null, apex: -Infinity, release: new THREE.Vector3() };
  let thrown: (typeof system)["dolls"][number] | null = null;
  const verticalHistory: { at: number; velocityY: number }[] = [];
  let simulated = 0;
  world.onEject = (ejection) => {
    out.ejections++;
    if (run.carryVertical) ejection.rel.y += verticalHistory.findLast((sample) => sample.at <= simulated - EJECTION_PRE_SECONDS)?.velocityY ?? 0;
    system.launch(ejection, [car]);
    if (thrown) return;
    thrown = system["dolls"].find((doll) => doll.live)!;
    const velocity = thrown.bodies[0]!.linvel();
    out.release.set(velocity.x, velocity.y, velocity.z);
  };
  const frameSeconds = displayFrames(60);
  let wall = 0;
  for (let dt = frameSeconds(); wall < THROW_WALL_MAX; wall += dt, dt = frameSeconds()) {
    verticalHistory.push({ at: simulated, velocityY: car.velocity.y });
    if (!thrown) out.carSpeed = Math.max(out.carSpeed, car.speed);
    slowMotionBeforeImpact(world.clock, car, barrier, dt, simulated);
    tickWorld(world, dt);
    const simulatedDt = dt * world.clock.timeScale;
    simulated += simulatedDt;
    barrier.step(simulatedDt);
    system.update(simulatedDt, [car], true, true, barrier.group);
    if (!thrown || !thrown.live) {
      if (thrown) break;
      if (world.clock.phase !== "approach" && world.clock.wallSinceImpact > NO_THROW_AFTER) break;
      continue;
    }
    const torso = thrown.bodies[0]!.translation();
    out.distance = torso.x;
    out.apex = Math.max(out.apex, torso.y);
  }
  system.dispose();
  car.dispose();
  setGround(null);
  return out;
}
