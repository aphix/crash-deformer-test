import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FRAME_HZ, GRAVITY } from "../kernel/constants.ts";
import { FLAT_GROUND } from "../world/ground.ts";
import type { Doll } from "./ragdoll-body.ts";
import { RideAlong } from "./ragdoll-ride.ts";
import { MINIGAME_AIM_LEAD, RideCam } from "./ride-cam.ts";
import type { Sight } from "./spectate-cam.ts";

/**
 * The ride cam over a dummy flung on a ballistic path (released at the origin under the sim's gravity, 60 Hz frames, the
 * camera's own smoothing): how often he leaves the central 95% of a 16:9 frame at the default 50° lens, once the
 * windshield shot is over. Measured with the aim not led: High jump release 11.96%, Ring Fling release 27.18% of those
 * frames; with `MINIGAME_AIM_LEAD`: 0 and 0.
 */
const FRAME_SECONDS = 1 / FRAME_HZ;
const DEFAULT_LENS_DEGREES = 50;
const CENTRAL_SHARE = 0.95;
const HIGH_JUMP_RELEASE = new THREE.Vector3(4, 58, 0);
const RING_FLING_RELEASE = new THREE.Vector3(10, 12, 0);
/** The windshield shot opens on a car at this spot, facing +x, and the driver leaves it through the pane at `PANE`. */
const CAR_AT = new THREE.Vector3(-1, 0.5, 0);
const CAR_FORWARD = new THREE.Vector3(1, 0, 0);
const PANE = new THREE.Vector3(0, 1, 0);
const CAR_SPEED = 5;
/** Over the 5% the owner found unwatchable on the High jump. */
const FAILING_SHARE = 0.05;
const TOLERANCE = 1e-9;

type Flight = {
  framesAfterWindshield: number;
  outsideAfterWindshield: number;
  windshieldFrames: number;
  outsideInWindshield: number;
  /** The camera's position (x, y, z) and rotation (x, y, z, w) after each frame, the first frame at index 0. */
  poses: number[][];
};

/** Film one dummy released from the origin at `release`, until he is back at the ground; `aimLead` unset leaves the cam's default framing. */
function filmFlight(release: THREE.Vector3, aimLead: number | undefined): Flight {
  const cam = new RideCam();
  const camera = new THREE.PerspectiveCamera(DEFAULT_LENS_DEGREES, 16 / 9, 0.1, 2000);
  cam.begin({ group: { position: CAR_AT }, fwdFlat: CAR_FORWARD }, CAR_SPEED, PANE);
  const framing = cam.framing;
  framing.n = 1;
  framing.hold = true;
  framing.lens = DEFAULT_LENS_DEGREES;
  if (aimLead !== undefined) framing.lead = aimLead;
  const head = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const flight: Flight = { framesAfterWindshield: 0, outsideAfterWindshield: 0, windshieldFrames: 0, outsideInWindshield: 0, poses: [] };
  let elapsed = FRAME_SECONDS;
  for (;;) {
    head.set(release.x * elapsed, release.y * elapsed - 0.5 * GRAVITY * elapsed * elapsed, 0);
    if (head.y < 0) break;
    framing.c.copy(head);
    framing.vx = release.x;
    framing.vy = release.y - GRAVITY * elapsed;
    framing.vz = 0;
    cam.update(camera, FRAME_SECONDS, framing);
    camera.updateMatrixWorld();
    projected.copy(head).project(camera);
    const outside = projected.z > 1 || Math.abs(projected.x) > CENTRAL_SHARE || Math.abs(projected.y) > CENTRAL_SHARE;
    if (cam.shot === "glass") {
      flight.windshieldFrames++;
      if (outside) flight.outsideInWindshield++;
    } else {
      flight.framesAfterWindshield++;
      if (outside) flight.outsideAfterWindshield++;
    }
    flight.poses.push([camera.position.x, camera.position.y, camera.position.z, camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w]);
    elapsed += FRAME_SECONDS;
  }
  return flight;
}

describe("given a dummy thrown up the High jump's path (release 4, 58, 0 m/s) filmed at the default 50° lens", () => {
  it("when the aim is not led, then more than 5% of the frames after the windshield shot have him outside the central 95% (the fault)", () => {
    const flight = filmFlight(HIGH_JUMP_RELEASE, undefined);
    assert.ok(flight.framesAfterWindshield > 0, "frames after the windshield shot");
    assert.ok(flight.outsideAfterWindshield / flight.framesAfterWindshield > FAILING_SHARE, `${flight.outsideAfterWindshield} of ${flight.framesAfterWindshield} frames outside`);
  });

  it("when the aim is led by MINIGAME_AIM_LEAD, then no frame after the windshield shot, nor any in it, has him outside the central 95%", () => {
    const flight = filmFlight(HIGH_JUMP_RELEASE, MINIGAME_AIM_LEAD);
    assert.ok(flight.framesAfterWindshield > 600, "frames after the windshield shot");
    assert.ok(flight.windshieldFrames > 0, "windshield frames");
    assert.equal(flight.outsideAfterWindshield, 0, "frames outside after the windshield shot");
    assert.equal(flight.outsideInWindshield, 0, "frames outside in the windshield shot");
  });
});

describe("given a dummy thrown on the Ring Fling's slower, lower path (release 10, 12, 0 m/s) filmed at the default 50° lens", () => {
  it("when the aim is led by MINIGAME_AIM_LEAD, then no frame after the windshield shot has him outside, where an unled aim loses some", () => {
    const unled = filmFlight(RING_FLING_RELEASE, undefined);
    const led = filmFlight(RING_FLING_RELEASE, MINIGAME_AIM_LEAD);
    assert.ok(unled.outsideAfterWindshield > 0, "the unled control loses frames");
    assert.equal(led.framesAfterWindshield, unled.framesAfterWindshield, "same frames after the windshield shot");
    assert.equal(led.outsideAfterWindshield, 0, "frames outside, led");
    assert.equal(led.outsideInWindshield, 0, "frames outside in the windshield shot, led");
  });
});

/** Camera poses a ride cam at its default framing (no lead) gave over each path before the lead existed: frame index (0 first), pose. */
const UNCHANGED_POSES = [
  { it: "the High jump path, frame 120", release: HIGH_JUMP_RELEASE, frame: 119, pose: [5.100226247559617, 30.617308552858937, 0.5887506368884301, 0.49960957172233206, 0.18245120430047626, -0.3179321766515528, 0.784870030605284] },
  { it: "the High jump path, frame 240", release: HIGH_JUMP_RELEASE, frame: 239, pose: [10.732870510274214, 152.3726309414169, 1.7999999999999998, 0.09793471337795458, -0.5699997725585184, 0.06867181812202833, 0.8128918947773008] },
  { it: "the Ring Fling path, frame 60", release: RING_FLING_RELEASE, frame: 59, pose: [6.065559755725496, 2.2120401147301036, 0.16918571393626006, 0.5393681119997217, 0.3166570789214994, -0.40755661206526356, 0.6653630152695924] },
] as const;

describe("given a ride cam whose framing has no lead set", () => {
  it("when it is built, then the lead is 0", () => {
    assert.equal(new RideCam().framing.lead, 0, "lead");
  });

  for (const testCase of UNCHANGED_POSES) {
    it(`when it films ${testCase.it}, then the camera stands exactly where it did before the lead existed`, () => {
      const pose = filmFlight(testCase.release, undefined).poses[testCase.frame]!;
      for (let index = 0; index < testCase.pose.length; index++) {
        assert.ok(Math.abs(pose[index]! - testCase.pose[index]!) < TOLERANCE, `pose[${index}] ${pose[index]} against ${testCase.pose[index]}`);
      }
    });
  }
});

/** A live dummy `head` m up, moving at `velocity` (m/s): only the head pose (offset 7) and the velocity are read by the ride. */
function dollAt(head: THREE.Vector3, velocity: THREE.Vector3): Doll {
  const pose = new Float32Array(14);
  pose.set([head.x, head.y, head.z, 0, 0, 0, 1], 7);
  return {
    bodies: [], live: true, age: 0, life: 10, still: 0, patch: [], car: -1, rides: true, prev: pose, cur: pose, ground: false, settled: false, calm: 0, speed: 0,
    vel: new Float32Array([velocity.x, velocity.y, velocity.z]),
  };
}

const OPEN_SIGHT = (): Sight => ({ ground: FLAT_GROUND, path: null, wallTop: 0, rim: Infinity, occ: [] });
const WALL_SECONDS = 1;
const AIM_TOLERANCE = 1e-3;

describe("given two dummies climbing together (mean velocity 3, 50, 0 m/s), 0.5 m apart in height", () => {
  const dolls = [dollAt(new THREE.Vector3(0, 100, 0), new THREE.Vector3(2, 40, 0)), dollAt(new THREE.Vector3(0, 100.5, 0), new THREE.Vector3(4, 60, 0))];
  const heads = new THREE.Vector3(0, 100.25, 0);

  function aimAfterOneFrame(lead: number | undefined): THREE.Vector3 {
    const ride = new RideAlong();
    const camera = new THREE.PerspectiveCamera(DEFAULT_LENS_DEGREES, 16 / 9, 0.1, 2000);
    ride.follow(dolls[0], 0, []);
    if (lead === undefined) ride.frame(dolls, 1, camera, WALL_SECONDS, true, -1, false, DEFAULT_LENS_DEGREES, OPEN_SIGHT);
    else ride.frame(dolls, 1, camera, WALL_SECONDS, true, -1, false, DEFAULT_LENS_DEGREES, OPEN_SIGHT, lead);
    return ride.cam.look.clone();
  }

  it("when the ride is framed with no lead passed, then the aim settles on their heads' centre", () => {
    const aim = aimAfterOneFrame(undefined);
    assert.ok(aim.distanceTo(heads) < AIM_TOLERANCE, `aim ${aim.toArray()} against ${heads.toArray()}`);
  });

  it("when the ride is framed with a lead of 0.1 s, then the aim settles 0.1 s of their mean velocity ahead of their heads' centre", () => {
    const aim = aimAfterOneFrame(MINIGAME_AIM_LEAD);
    const expected = heads.clone().add(new THREE.Vector3(3, 50, 0).multiplyScalar(MINIGAME_AIM_LEAD));
    assert.ok(aim.distanceTo(expected) < AIM_TOLERANCE, `aim ${aim.toArray()} against ${expected.toArray()}`);
  });
});
