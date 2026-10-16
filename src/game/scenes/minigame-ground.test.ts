import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { FREEWHEEL } from "../contact/crash-scenarios.test-util.ts";
import { newWorld } from "../engine/world-step.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { DRIVER_CARS, type DriverCar } from "../match/types.ts";
import { GROUND_REACH, RagdollSystem } from "../present/engine-ragdoll.ts";
import { layOnGround } from "../vehicle/car-air-points.ts";
import { idleDrive, type DriveInput } from "../vehicle/car-drive.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import { FRAME, frame } from "../vehicle/ground-probe.test-util.ts";
import { activeGround, FLAT_GROUND, setGround, type Ground } from "../world/ground.ts";
import { PR_ID } from "../world/prism.ts";
import { GRID, P_OX, P_STRIDE, PRISM, Q_KIND, Q_STRIDE } from "../world/surfaces.ts";
import { MINIGAME_MODES, REST_HOLD, STATION_ANCHORS, STATION_HALF_WIDTH, type MinigameMode } from "./minigame-constants.ts";
import { MinigameGround } from "./minigame-ground.ts";
import { climbFootX, floorHeightAt, lipHeight, stationBackX, stationFrontX, stationStartPose } from "./minigame-profile.ts";
import { dressedDriverCar } from "./minigame-profile.test-util.ts";
import { RING_BACKSTOP, RING_BOARD_BOUNDS, RING_CUPS, RING_MESH_STEP, ringBoardMesh, ringHeightAt, ringScore } from "./minigame-ring.ts";
import { RANGE } from "./range.ts";

/** The net the rows hang: synthetic numbers (the real layout comes from a measurement made later): 45 m past the lip, 12 m wide, 14 m tall. */
const NET = { netX: 45, netHalfWidth: 6, netHeight: 14 } as const;

/** The grid may be this far (m) from the analytic floor, and the coarsest grid that keeps to it is not under this far from it (a finer cell than needed is wasted nodes). */
const HEIGHT_TOLERANCE = 0.002;
const COARSEST_CELL_ERROR_FLOOR = 0.001;
/** Metres between the floor samples, an irrational-ish step so the samples fall at every phase of a cell, and the lateral offsets sampled (across the lane, from its middle). */
const SAMPLE_STEP = 0.0137;
const SAMPLE_LATERAL_OFFSETS = [-STATION_HALF_WIDTH + 1, 0, 7] as const;
/** A ground must build well within this many milliseconds. */
const BUILD_BUDGET_MILLISECONDS = 1000;

/** A parked car on the start hill's pad slides no further than this (m) in `HOLD_SECONDS`. */
const PARKED_SLIDE_LIMIT = 0.5;
const HOLD_SECONDS = 2;
/** A run ends at this many seconds after the release; a car slower than `STALLED_SPEED` for `STALL_SECONDS` has stalled; after its throw the run goes on `AFTER_THROW_SECONDS` to count every ejection. */
const RUN_SECONDS = 60;
const STALLED_SPEED = 0.5;
const STALL_SECONDS = 2;
const AFTER_THROW_SECONDS = 2;
/** How far ahead (m) of the car the steering aims, and per metre of its speed, and its gain. */
const STEER_LOOK_AHEAD = 10;
const STEER_LOOK_PER_SPEED = 0.4;
const STEER_GAIN = 2.5;
/** The long jump's bar: the car's centre reaches this local x. */
const LONG_JUMP_REACH_X = -1.5;
/** The slowest (m/s) any class may carry through the high jump's last stretch, below its bar. */
const CLIMB_STALL_ALLOWANCE = 1;

/** Per station and car type: the least speed (m/s) its centre may have at the climb's foot and as it reaches the lip: the numbers `minigame-profile.test.ts` pins on its own 5 cm grid. */
const MINIMUM_SPEED: Readonly<Record<MinigameMode, Readonly<Record<string, { foot: number; lip: number }>>>> = {
  longJump: {
    sedan: { foot: 17.5, lip: 25 },
    muscle: { foot: 18, lip: 27 },
    truck: { foot: 17.5, lip: 24.5 },
    monster: { foot: 19, lip: 26.5 },
    police: { foot: 17.5, lip: 24.5 },
    hatchback: { foot: 17.5, lip: 25 },
    wagon: { foot: 17.5, lip: 25 },
  },
  highJump: {
    sedan: { foot: 31, lip: 26.5 },
    muscle: { foot: 34, lip: 29.5 },
    truck: { foot: 31, lip: 26 },
    monster: { foot: 34.5, lip: 35 },
    police: { foot: 31, lip: 26.5 },
    hatchback: { foot: 31, lip: 26.5 },
    wagon: { foot: 31, lip: 26.5 },
  },
  ringFling: {
    sedan: { foot: 29.5, lip: 32 },
    muscle: { foot: 32, lip: 35.5 },
    truck: { foot: 29, lip: 32 },
    monster: { foot: 32.5, lip: 37.5 },
    police: { foot: 29.5, lip: 32 },
    hatchback: { foot: 29.5, lip: 32 },
    wagon: { foot: 29.5, lip: 32 },
  },
};

/** The dummy's frame of reference: the ragdoll steps at the render frame, and a part's centre may sit this far (m) inside a solid before it is called through it. */
const RAGDOLL_FRAME = 1 / FRAME_HZ;
const SOAK = 0.15;
/** A dummy at rest lies on the ground: his torso centre is this near (m) the floor under it. */
const LYING_TORSO_HEIGHT = 0.6;
/** A throw is run until his torso has lain still `REST_HOLD`, or this many sim seconds. */
const THROW_LIMIT_SECONDS = 30;
/** The driver's seat over the lip's floor (m), where a throw starts. */
const SEAT_OVER_LIP = 1;
/** Ring Fling's design throw (`minigame-ring.test.ts`): 15-22 m/s up 35 degrees from the lip. The sweep brackets it. */
const RING_THROW_PITCH = (35 * Math.PI) / 180;
const RING_SWEEP_SPEEDS = Array.from({ length: 41 }, (_, step) => 14 + 0.25 * step);
/** The net shot: from this far (m) before the net, this high (m), at this speed (m/s) along the lane and this much (m/s) up. The net's face is allowed this much (m) past its plane for a part's soak. */
const NET_SHOT = { distanceBefore: 10, height: 6, speed: 20, rise: 3 } as const;
const NET_FACE_ALLOWANCE = 0.5;
/** The lowest speed (m/s) of the design throw: it lands on the board's front, well above the pad. */
const LOW_DESIGN_SPEED = 15;
/** An overshooting throw: far over the design speeds, which the backstop must stop. */
const OVERSHOOT_SPEED = 30;
/** The long jump's throws: the barrier's release (a car's speed, the usual pop up) and a long one that lands near the field's end. */
const LONG_JUMP_RELEASE = { speed: 36, up: 3.5 } as const;
const LONG_JUMP_FAR_THROW = { speed: 40, pitchDegrees: 20 } as const;

const systems: RagdollSystem[] = [];

function disposeSystems(): void {
  for (const system of systems.splice(0)) system.dispose();
}

afterEach(() => {
  disposeSystems();
  setGround(null);
});

function buildGround(): MinigameGround {
  return new MinigameGround({ highJump: NET });
}

describe("given the minigame ground", () => {
  it("when it is built, then it takes well under a second", (t) => {
    const before = performance.now();
    const ground = buildGround();
    const elapsed = performance.now() - before;
    t.diagnostic(`built in ${elapsed.toFixed(1)} ms: ${ground.count} patches, ${ground.meshes.length} meshes`);
    assert.ok(elapsed < BUILD_BUDGET_MILLISECONDS, `${elapsed} ms`);
  });

  it("when it is set as the active ground and then cleared, then the flat plane is back everywhere the lanes were", () => {
    const ground = buildGround();
    setGround(ground);
    assert.equal(activeGround(), ground);
    setGround(null);
    assert.equal(activeGround(), FLAT_GROUND);
    for (const mode of MINIGAME_MODES) {
      assert.equal(FLAT_GROUND.heightAt(STATION_ANCHORS[mode].x + stationBackX(mode) + 60, STATION_ANCHORS[mode].z), 0, `${mode} lane`);
    }
  });
});

describe("given each station's lane read between the nodes of the grid", () => {
  /** The largest |heightAt - floorHeightAt| (m) over the lane from the back of its pad to 1 m past its landing, every `SAMPLE_STEP`, at three lateral offsets. */
  function worstError(ground: MinigameGround, mode: MinigameMode, anchorZ = STATION_ANCHORS[mode].z): number {
    const anchor = STATION_ANCHORS[mode];
    let worst = 0;
    for (let localX = stationBackX(mode); localX <= stationFrontX(mode) + 1; localX += SAMPLE_STEP) {
      for (const offset of SAMPLE_LATERAL_OFFSETS) {
        const analytic = floorHeightAt(mode, localX, offset);
        worst = Math.max(worst, Math.abs(ground.heightAt(anchor.x + localX, anchorZ + offset, analytic + 0.5) - analytic));
      }
    }
    return worst;
  }

  for (const mode of MINIGAME_MODES) {
    it(`when the ${mode} lane is sampled, then its height is within 2 mm of the profile's floor at its anchor`, () => {
      assert.ok(worstError(buildGround(), mode) <= HEIGHT_TOLERANCE);
    });

    it(`when the ${mode} lane is sampled against a floor read at another z, then it is not within 2 mm: the grid sits at the anchor's z`, () => {
      assert.ok(worstError(buildGround(), mode, STATION_ANCHORS[mode].z + 40) > HEIGHT_TOLERANCE);
    });
  }

  it("when the high jump's kicker, the lane that bends most, is sampled, then the grid's worst error is within 1 to 2 mm: the cell is the coarsest that keeps the bar", (t) => {
    const worst = worstError(buildGround(), "highJump");
    t.diagnostic(`high jump worst error ${(worst * 1000).toFixed(2)} mm`);
    assert.ok(worst <= HEIGHT_TOLERANCE, `${worst} m: too coarse`);
    assert.ok(worst >= COARSEST_CELL_ERROR_FLOOR, `${worst} m: a finer cell than the bar needs`);
  });

  it("when the long jump's last 5 m before its barrier are read, then the floor is exactly the pad's level", () => {
    const ground = buildGround();
    for (let localX = -5; localX <= 0; localX += 0.1) assert.equal(ground.heightAt(localX, STATION_ANCHORS.longJump.z), 0, `x = ${localX}`);
  });

  it("when the long jump's incline foot is read, then it lies below the pad as the profile has it (negative heights are real)", () => {
    const ground = buildGround();
    const footHeight = floorHeightAt("longJump", climbFootX("longJump"), 0);
    assert.ok(footHeight < -1, `the profile's foot ${footHeight}`);
    assert.ok(Math.abs(ground.heightAt(STATION_ANCHORS.longJump.x + climbFootX("longJump"), STATION_ANCHORS.longJump.z, 0.5) - footHeight) <= HEIGHT_TOLERANCE);
  });
});

describe("given the ground away from the lanes", () => {
  it("when it is read between, around and past the lanes and behind and past each lane, then it is the pad at 0", () => {
    const ground = buildGround();
    const betweenLanes = [(STATION_ANCHORS.longJump.z + STATION_ANCHORS.highJump.z) / 2, (STATION_ANCHORS.highJump.z + STATION_ANCHORS.ringFling.z) / 2];
    for (const z of [-300, ...betweenLanes, 400]) {
      for (const x of [-500, -60, 0, 60, 300]) assert.equal(ground.heightAt(x, z), 0, `(${x}, ${z})`);
    }
    for (const mode of MINIGAME_MODES) {
      const anchor = STATION_ANCHORS[mode];
      assert.equal(ground.heightAt(anchor.x + stationBackX(mode) - 3, anchor.z), 0, `${mode} behind the pad`);
      assert.equal(ground.heightAt(anchor.x + stationFrontX(mode) + 3, anchor.z), 0, `${mode} landing`);
      assert.equal(ground.heightAt(anchor.x + climbFootX(mode), anchor.z + STATION_HALF_WIDTH + 0.5), 0, `${mode} beside the lane`);
    }
  });
});

describe("given each station's start", () => {
  for (const mode of MINIGAME_MODES) {
    it(`when ${mode}'s start is asked, then it is the parked pose at the anchor on the floor's height facing the throw`, () => {
      const ground = buildGround();
      const start = ground.stationStart(mode);
      const pose = stationStartPose(mode);
      const anchor = STATION_ANCHORS[mode];
      assert.equal(start.x, anchor.x + pose.x);
      assert.equal(start.z, anchor.z + pose.z);
      assert.equal(start.yaw, pose.yaw);
      assert.equal(start.y, floorHeightAt(mode, pose.x, pose.z));
    });
  }

  it("when the bounds are asked, then they hold every lane from its pad's back, its landing to the field's end, the Ring Fling backstop and the net", () => {
    const bounds = buildGround().minigameBounds();
    for (const mode of MINIGAME_MODES) {
      const anchor = STATION_ANCHORS[mode];
      assert.ok(bounds.minX <= anchor.x + stationBackX(mode) && bounds.minZ <= anchor.z - STATION_HALF_WIDTH && bounds.maxZ >= anchor.z + STATION_HALF_WIDTH, mode);
    }
    const backstopFar = STATION_ANCHORS.ringFling.x + RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard + RING_BACKSTOP.thickness;
    assert.ok(bounds.maxX >= RANGE.length && bounds.maxX >= backstopFar && bounds.maxX >= STATION_ANCHORS.highJump.x + NET.netX, `${bounds.maxX}`);
  });
});

/** What one drive from a station's start to its lip gave. */
type Drive = {
  /** Metres the parked car slid in `HOLD_SECONDS`. */
  heldSlide: number;
  /** Every ejection the watch queued over the run. */
  ejections: number;
  /** Speeds (m/s) as the car's centre crossed the climb's foot and the lip's base line (the throw's, before the cut, where there is one), and the slowest between. */
  footSpeed: number;
  lipSpeed: number;
  slowestOnClimb: number;
  /** The car's centre got to the long jump's reach and to the lip's plane (local x). */
  reachedLongJumpBar: boolean;
  reachedLip: boolean;
};

/**
 * One car of `type` parked at the station's start on the real ground (laid on the floor, the parked flag set), left alone, then
 * released at full throttle and steered down the lane's middle with the ground's hook on the world (`assignHook`: the control without it).
 * It ends at its throw plus `AFTER_THROW_SECONDS` (the thrown driver's car freewheels), or at the long jump's lip, or a stall.
 */
function driveFromStart(type: DriverCar, mode: MinigameMode, assignHook = true): Drive {
  const anchor = STATION_ANCHORS[mode];
  const ground = buildGround();
  setGround(ground);
  const car = dressedDriverCar(type);
  try {
    const start = ground.stationStart(mode);
    car.spawnFacing(start.x, start.z, start.yaw, 0);
    car.group.position.y = start.y;
    layOnGround(car);
    car.parked = true;
    const watch = new EjectionWatch();
    const world = newWorld([car], null, watch);
    if (assignHook) world.collide = ground.collideHook([car], watch);
    const clock = { acc: 0 };
    for (let step = 0; step < HOLD_SECONDS / FRAME; step++) frame(world, null, clock);
    const drive: Drive = { heldSlide: Math.abs(car.group.position.x - start.x), ejections: 0, footSpeed: 0, lipSpeed: 0, slowestOnClimb: Infinity, reachedLongJumpBar: false, reachedLip: false };
    const input: DriveInput = { ...idleDrive(), throttle: 1 };
    const position = car.group.position;
    const footX = anchor.x + climbFootX(mode);
    let crossedFoot = false;
    let stalledFor = 0;
    let secondsSinceThrow = 0;
    let thrown = false;
    const afterSlice = (): void => {
      const events = watch.take();
      drive.ejections += events.length;
      if (events.length === 0 || thrown) return;
      thrown = true;
      drive.lipSpeed = Math.hypot(events[0]!.carVel.x, events[0]!.carVel.z);
      Object.assign(input, FREEWHEEL);
    };
    for (let step = 0; step < RUN_SECONDS / FRAME; step++) {
      if (!thrown) {
        const aheadX = position.x + STEER_LOOK_AHEAD + car.speed * STEER_LOOK_PER_SPEED;
        const error = Math.atan2(aheadX - position.x, anchor.z - position.z) - car.yaw;
        input.steer = Math.max(-1, Math.min(1, STEER_GAIN * Math.atan2(Math.sin(error), Math.cos(error))));
      }
      frame(world, input, clock, afterSlice);
      if (!crossedFoot && position.x >= footX) {
        crossedFoot = true;
        drive.footSpeed = car.speed;
      }
      if (crossedFoot && !thrown) drive.slowestOnClimb = Math.min(drive.slowestOnClimb, car.speed);
      if (position.x - anchor.x >= LONG_JUMP_REACH_X) drive.reachedLongJumpBar = true;
      if (!drive.reachedLip && position.x >= anchor.x) {
        drive.reachedLip = true;
        if (!thrown) drive.lipSpeed = car.speed;
        if (mode === "longJump") break;
      }
      stalledFor = car.speed < STALLED_SPEED ? stalledFor + FRAME : 0;
      if (stalledFor > STALL_SECONDS) break;
      if (thrown) secondsSinceThrow += FRAME;
      if (secondsSinceThrow >= AFTER_THROW_SECONDS) break;
    }
    return drive;
  } finally {
    car.dispose();
    setGround(null);
  }
}

describe("given each of the 7 car types parked at each station's start on the real ground and released at full throttle", () => {
  for (const mode of MINIGAME_MODES) {
    it(`when each rides the ${mode} from its start, then it holds still parked, reaches the lip at the profile's speeds${mode === "longJump" ? " and the long jump's reach" : " and is thrown exactly once"}`, (t) => {
      const rows: string[] = [];
      for (const type of DRIVER_CARS) {
        const drive = driveFromStart(type, mode);
        const minimum = MINIMUM_SPEED[mode][type.id]!;
        rows.push(`${type.id.padEnd(9)} slid ${drive.heldSlide.toFixed(2)} foot ${drive.footSpeed.toFixed(1)} lip ${drive.lipSpeed.toFixed(1)} slowest ${drive.slowestOnClimb.toFixed(1)} m/s ejections ${drive.ejections}`);
        assert.ok(drive.heldSlide <= PARKED_SLIDE_LIMIT, `${type.id} slid ${drive.heldSlide} m parked`);
        assert.ok(drive.reachedLip, `${type.id} reached the lip`);
        assert.ok(drive.footSpeed >= minimum.foot, `${type.id} at the foot ${drive.footSpeed} against ${minimum.foot}`);
        assert.ok(drive.lipSpeed >= minimum.lip, `${type.id} at the lip ${drive.lipSpeed} against ${minimum.lip}`);
        assert.ok(drive.slowestOnClimb >= minimum.lip - CLIMB_STALL_ALLOWANCE - 1e-9 || mode !== "highJump", `${type.id} slowest ${drive.slowestOnClimb}`);
        if (mode === "longJump") assert.ok(drive.reachedLongJumpBar, `${type.id} reached x = ${LONG_JUMP_REACH_X}`);
        else assert.equal(drive.ejections, 1, `${type.id}: ${drive.ejections} ejections`);
      }
      t.diagnostic(`${mode}:\n${rows.join("\n")}`);
    });
  }

  it("when the world's collide hook is not assigned, then the sedan reaches the high jump's lip and Ring Fling's and nobody is thrown: the hook is what throws", () => {
    const sedan = DRIVER_CARS.find((type) => type.id === "sedan")!;
    for (const mode of ["highJump", "ringFling"] as const) {
      const drive = driveFromStart(sedan, mode, false);
      assert.ok(drive.reachedLip, `${mode} reached`);
      assert.equal(drive.ejections, 0, `${mode} thrown without the hook`);
    }
  });
});

/** The patch indices of `ground` that `isWanted` accepts, by the patch's kind (`GRID` or `PRISM`) and index. */
function patchesOf(ground: Ground, kind: number, isWanted: (patch: number) => boolean): number[] {
  const found: number[] = [];
  for (let patch = 0; patch < ground.count; patch++) {
    if (ground.q[patch * Q_STRIDE + Q_KIND] === kind && isWanted(patch)) found.push(patch);
  }
  return found;
}

const BACKSTOP_PRISM_ID = 0;
const NET_PRISM_ID = 1;

/** The ground with the prism of `prismId` (the backstop's or the net's) taken out: the control a row's wall must make a difference against. */
function withoutPrism(ground: MinigameGround, prismId: number): MinigameGround {
  for (const patch of patchesOf(ground, PRISM, (candidate) => ground.p[candidate * P_STRIDE + PR_ID] === prismId)) ground.disable(patch);
  return ground;
}

/** A ragdoll system on `ground` as the range runs it (sand on), dummies held lying where they land. */
async function ragdollOn(ground: Ground): Promise<RagdollSystem> {
  const system = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  system.sand = true;
  await system.preload();
  setGround(ground);
  system.update(RAGDOLL_FRAME, [], true, false, null);
  system.holdThrown();
  systems.push(system);
  return system;
}

const UP = new THREE.Vector3(0, 1, 0);

type ThrowResult = {
  torso: THREE.Vector3;
  /** Sim seconds the torso has lain still at the end, and how long the throw ran. */
  still: number;
  seconds: number;
  /** Over the whole run: the lowest height and the furthest +x any part's centre got to. */
  lowestPartY: number;
  furthestPartX: number;
  /** The dummy touched down (`ground`) and calmed (`settled`). */
  onGround: boolean;
};

/**
 * A dummy thrown from `from` at `velocity` (lying along it, head first), the system stepped until his torso has lain still `REST_HOLD` s
 * or `THROW_LIMIT_SECONDS`, then released so the same system can throw again.
 */
function throwDummy(system: RagdollSystem, from: THREE.Vector3, velocity: THREE.Vector3): ThrowResult {
  const lie = velocity.clone().normalize();
  system["spawn"]({ car: 0, p: from.clone(), q: new THREE.Quaternion().setFromUnitVectors(UP, lie), v: velocity.clone(), w: new THREE.Vector3(), age: 0, cop: false, rides: true });
  const dummy = system["dolls"].find((doll) => doll.live)!;
  const torso = new THREE.Vector3();
  const result: ThrowResult = { torso, still: 0, seconds: 0, lowestPartY: Infinity, furthestPartX: -Infinity, onGround: false };
  for (let step = 0; step < THROW_LIMIT_SECONDS / RAGDOLL_FRAME && result.still < REST_HOLD; step++) {
    system.update(RAGDOLL_FRAME, [], true, false, null);
    result.still = system.latest(torso);
    result.seconds = (step + 1) * RAGDOLL_FRAME;
    for (const part of dummy.bodies) {
      const centre = part.translation();
      result.lowestPartY = Math.min(result.lowestPartY, centre.y);
      result.furthestPartX = Math.max(result.furthestPartX, centre.x);
    }
  }
  result.onGround = dummy.ground;
  system.releaseThrown();
  return result;
}

describe("given a dummy thrown from the Ring Fling lip at the design speeds on the real ground", () => {
  const anchor = STATION_ANCHORS.ringFling;
  const seat = new THREE.Vector3(anchor.x, lipHeight("ringFling") + SEAT_OVER_LIP, anchor.z);

  /** A dummy thrown from the lip at `speed` m/s up the design pitch. */
  const throwAtSpeed = (system: RagdollSystem, speed: number): ThrowResult =>
    throwDummy(system, seat, new THREE.Vector3(speed * Math.cos(RING_THROW_PITCH), speed * Math.sin(RING_THROW_PITCH), 0));

  it("when throws from 14 to 24 m/s are run, then each cup 10 to 50 holds a resting dummy at some speed", async (t) => {
    const system = await ragdollOn(buildGround());
    const rows: string[] = [];
    const cupsHeld = new Set<number>();
    for (const speed of RING_SWEEP_SPEEDS) {
      const result = throwAtSpeed(system, speed);
      const localX = result.torso.x - anchor.x;
      const localZ = result.torso.z - anchor.z;
      const score = ringScore(localX, localZ);
      rows.push(`${speed.toFixed(2)} m/s -> x ${localX.toFixed(2)} z ${localZ.toFixed(2)} zone ${score} still ${result.still.toFixed(2)} after ${result.seconds.toFixed(1)} s ground ${result.onGround}`);
      if (result.still >= REST_HOLD && score > 0) cupsHeld.add(score);
    }
    t.diagnostic(`lip speed -> where the dummy rests:\n${rows.join("\n")}`);
    for (const cup of RING_CUPS) assert.ok(cupsHeld.has(cup.score), `no throw rested in the ${cup.score} cup: ${[...cupsHeld].join(", ")}`);
  });

  it("when the dummy rests on the board, then he is on the ground (the board is in the height grid the settle reads, and without it he is not)", async () => {
    const result = throwAtSpeed(await ragdollOn(buildGround()), LOW_DESIGN_SPEED);
    assert.ok(result.torso.y >= GROUND_REACH, `his torso rests ${result.torso.y} m up: the pad alone could not tell he landed`);
    assert.ok(result.still >= REST_HOLD && result.onGround, "he is on the ground");
    disposeSystems();
    const without = buildGround();
    for (const patch of patchesOf(without, GRID, (candidate) => without.p[candidate * P_STRIDE + P_OX] === anchor.x + RING_BOARD_BOUNDS.minX)) without.disable(patch);
    const control = throwAtSpeed(await ragdollOn(without), LOW_DESIGN_SPEED);
    assert.ok(control.torso.y >= GROUND_REACH, `his torso rests ${control.torso.y} m up`);
    assert.equal(control.onGround, false, "without the board in the height grid he never reads as on the ground");
  });

  it("when the board is read, then it starts past where the lane's cars reach (nothing drives there) and its height is the board's at the cups' centres", () => {
    const ground = buildGround();
    assert.ok(RING_BOARD_BOUNDS.minX > stationFrontX("ringFling"));
    for (const cup of RING_CUPS) {
      assert.ok(Math.abs(ground.heightAt(anchor.x + cup.centreX, anchor.z + cup.centreZ) - ringHeightAt(cup.centreX, cup.centreZ)) <= HEIGHT_TOLERANCE, `${cup.score} cup`);
    }
  });

  it("when the board's mesh is read, then it is the board's mesh shifted to the anchor", () => {
    const board = ringBoardMesh(RING_MESH_STEP);
    const ground = buildGround();
    const placed = ground.meshes.find((mesh) => mesh.vertices.length === board.vertices.length && mesh.indices.length === board.indices.length)!;
    assert.ok(placed, "the board's mesh is among the ground's");
    for (let at = 0; at < board.vertices.length; at += 3) {
      assert.equal(placed.vertices[at], Math.fround(board.vertices[at]! + anchor.x));
      assert.equal(placed.vertices[at + 1], board.vertices[at + 1]);
      assert.equal(placed.vertices[at + 2], Math.fround(board.vertices[at + 2]! + anchor.z));
    }
  });
});

describe("given a dummy thrown far past the Ring Fling board", () => {
  it("when he is thrown at 30 m/s, then the backstop stops him and he never gets past it (and without the backstop he does)", async () => {
    const anchor = STATION_ANCHORS.ringFling;
    const seat = new THREE.Vector3(anchor.x, lipHeight("ringFling") + SEAT_OVER_LIP, anchor.z);
    const velocity = new THREE.Vector3(OVERSHOOT_SPEED * Math.cos(RING_THROW_PITCH), OVERSHOOT_SPEED * Math.sin(RING_THROW_PITCH), 0);
    const backFaceX = anchor.x + RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard + RING_BACKSTOP.thickness;
    const stopped = throwDummy(await ragdollOn(buildGround()), seat, velocity);
    assert.ok(stopped.furthestPartX <= backFaceX + SOAK, `a part reached x ${stopped.furthestPartX - anchor.x} past the backstop's back face at ${backFaceX - anchor.x}`);
    assert.ok(stopped.still >= REST_HOLD, `still ${stopped.still}`);
    disposeSystems();
    const control = throwDummy(await ragdollOn(withoutPrism(buildGround(), BACKSTOP_PRISM_ID)), seat, velocity);
    assert.ok(control.furthestPartX > backFaceX + 5, `without the backstop he got to x ${control.furthestPartX - anchor.x}`);
  });
});

describe("given a dummy thrown at the high jump's net", () => {
  const anchor = STATION_ANCHORS.highJump;
  const seat = new THREE.Vector3(anchor.x + NET.netX - NET_SHOT.distanceBefore, NET_SHOT.height, anchor.z);
  const velocity = new THREE.Vector3(NET_SHOT.speed, NET_SHOT.rise, 0);

  it("when he is thrown at the net, then it stops him and he ends on the ground (and without the net he flies on)", async () => {
    const netBackFaceX = anchor.x + NET.netX + NET_FACE_ALLOWANCE;
    const caught = throwDummy(await ragdollOn(buildGround()), seat, velocity);
    assert.ok(caught.furthestPartX <= netBackFaceX, `a part reached x ${caught.furthestPartX - anchor.x} past the net at ${NET.netX}`);
    assert.ok(caught.still >= REST_HOLD, `still ${caught.still}`);
    assert.ok(caught.torso.y <= LYING_TORSO_HEIGHT, `his torso rests ${caught.torso.y} m up`);
    assert.ok(caught.onGround, "he is on the ground");
    disposeSystems();
    const control = throwDummy(await ragdollOn(withoutPrism(buildGround(), NET_PRISM_ID)), seat, velocity);
    assert.ok(control.furthestPartX > netBackFaceX + 3, `without the net he got to x ${control.furthestPartX - anchor.x}`);
  });
});

describe("given a dummy dropped over the back face of the high jump's lip", () => {
  it("when he is dropped 2 m over it, then he lands on the face and stays above it (and without the lane's meshes he falls through the ramp)", async () => {
    const anchor = STATION_ANCHORS.highJump;
    const atX = stationFrontX("highJump") / 2;
    const seat = new THREE.Vector3(anchor.x + atX, floorHeightAt("highJump", atX, 0) + 2, anchor.z);
    const landed = throwDummy(await ragdollOn(buildGround()), seat, new THREE.Vector3(0.5, 0, 0));
    assert.ok(landed.lowestPartY >= -SOAK, `lowest part ${landed.lowestPartY}`);
    assert.ok(landed.still >= REST_HOLD, `still ${landed.still}`);
    disposeSystems();
    const hollow = buildGround();
    hollow.meshes.length = 0;
    const fell = throwDummy(await ragdollOn(hollow), seat, new THREE.Vector3(0.5, 0, 0));
    assert.ok(fell.lowestPartY < -SOAK || fell.torso.y < floorHeightAt("highJump", atX, 0) - 1, `without the meshes his lowest part was ${fell.lowestPartY}`);
  });
});

describe("given a dummy thrown from the long jump's barrier", () => {
  const anchor = STATION_ANCHORS.longJump;
  const seat = new THREE.Vector3(anchor.x, lipHeight("longJump") + SEAT_OVER_LIP, anchor.z);

  it("when he is thrown at the barrier's release, then he lands on the sand past the lip and rests, never below it", async () => {
    const result = throwDummy(await ragdollOn(buildGround()), seat, new THREE.Vector3(LONG_JUMP_RELEASE.speed, LONG_JUMP_RELEASE.up, 0));
    assert.ok(result.still >= REST_HOLD, `still ${result.still}`);
    assert.ok(result.torso.x > anchor.x + 10 && result.torso.x < anchor.x + RANGE.length, `rested at x ${result.torso.x}`);
    assert.ok(result.torso.y <= LYING_TORSO_HEIGHT, `his torso rests ${result.torso.y} m up`);
    assert.ok(result.lowestPartY >= -SOAK, `lowest part ${result.lowestPartY}`);
  });

  it("when he is thrown so that he flies 100 m and more, then no part of him goes below the sand anywhere along the field", async () => {
    const pitch = (LONG_JUMP_FAR_THROW.pitchDegrees * Math.PI) / 180;
    const result = throwDummy(await ragdollOn(buildGround()), seat, new THREE.Vector3(LONG_JUMP_FAR_THROW.speed * Math.cos(pitch), LONG_JUMP_FAR_THROW.speed * Math.sin(pitch), 0));
    assert.ok(result.furthestPartX > anchor.x + 100, `he got to x ${result.furthestPartX}`);
    assert.ok(result.lowestPartY >= -SOAK, `lowest part ${result.lowestPartY}`);
    assert.ok(result.still >= REST_HOLD, `still ${result.still}`);
  });
});
