import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FRAME_HZ, GRAVITY } from "../kernel/constants.ts";
import { FLAT_GROUND, Ground } from "../world/ground.ts";
import type { Doll } from "./ragdoll-body.ts";
import { RideAlong } from "./ragdoll-ride.ts";
import { MINIGAME_AIM_LEAD, RideCam } from "./ride-cam.ts";
import { inside, occluder, type Occluder, type Sight } from "./spectate-cam.ts";

/**
 * The ride cam over a dummy flung on a ballistic path (released from the origin under the sim's gravity, 60 Hz frames, the
 * camera's own smoothing, a 16:9 frame at the default 50° lens): how often he leaves the central 95% of the frame.
 * Measured with the aim not led (the windshield shot opens the ride, frames after it counted): High jump release 11.96%,
 * Ring Fling release 27.18%. With `MINIGAME_AIM_LEAD` (the follow shot opens the ride): 0 of every frame, the first included.
 */
const FRAME_SECONDS = 1 / FRAME_HZ;
const DEFAULT_LENS_DEGREES = 50;
const ASPECT = 16 / 9;
const CENTRAL_SHARE = 0.95;
const HIGH_JUMP_RELEASE = new THREE.Vector3(4, 58, 0);
const RING_FLING_RELEASE = new THREE.Vector3(10, 12, 0);
const LONG_JUMP_RELEASE = new THREE.Vector3(23, 16, 0);
const STRAIGHT_UP_RELEASE = new THREE.Vector3(0, 58, 0);
const NEAR_STRAIGHT_UP_RELEASE = new THREE.Vector3(0.3, 58, 0);
/** The windshield shot opens on a car at this spot, facing +x, and the driver leaves it through the pane at `PANE`. */
const CAR_AT = new THREE.Vector3(-1, 0.5, 0);
const CAR_FORWARD = new THREE.Vector3(1, 0, 0);
const PANE = new THREE.Vector3(0, 1, 0);
const CAR_SPEED = 5;
/** In slow-mo he moves 0.032 × 28 m/s on screen: an aim led by the sim's speed would stray about 2.8 m, one led by the shown speed under 0.1 m. */
const SLOWMO_AIM_OFFSET_LIMIT = 0.25;
/** The follow shot's metres behind the heads (`BACK`): lifting the eye never moves it nearer than this. */
const FOLLOW_STANDOFF = 4.5;
/** Over the 5% the owner found unwatchable on the High jump. */
const FAILING_SHARE = 0.05;
const TOLERANCE = 1e-9;
/** The engine's slow-mo after a throw: the sim runs this fraction of the wall's time for the first `SLOWMO_FRAMES` wall frames (measured in the real long jump), then at 1×. */
const SLOWMO_SCALE = 0.032;
const SLOWMO_FRAMES = 300;
/** The aim eases to its target at this rate (1/s) and the follow eye at 5/s: the aim's steady lag behind a mover is `velocity × FRAME_SECONDS × (1 − share) / share` per frame's share of the ease. */
const AIM_EASE_RATE = 12;
const AIM_SHARE_PER_FRAME = 1 - Math.exp(-AIM_EASE_RATE * FRAME_SECONDS);
const AIM_LAG_SECONDS = (FRAME_SECONDS * (1 - AIM_SHARE_PER_FRAME)) / AIM_SHARE_PER_FRAME;

type FlightOptions = {
  /** Unset leaves the framing's own default (no lead). */
  aimLead?: number;
  /** The sim's share of the wall's time, per wall frame (the slow-mo). */
  timeScale?: (wallFrame: number) => number;
  /** The scene's ground, solids and car for the sight the ride is picked against. */
  sight?: () => Sight;
  /** Where the windshield shot's car stands; `exitAt` also is the thrown driver's start. */
  carAt?: THREE.Vector3;
  start?: THREE.Vector3;
  /** Where the camera stood before the ride (the drive cam behind the car), looking at the driver's start: unset, the origin. */
  eyeBefore?: THREE.Vector3;
};

type Flight = {
  frames: number;
  /** Wall frames the dummy's head is outside the central 95% of the frame (or behind the camera): the windshield shot's, then every other shot's. */
  outsideInWindshield: number;
  outsideAfterWindshield: number;
  windshieldFrames: number;
  /** Wall frames the dummy's head is outside it, the first frame included. */
  outsideAnywhere: number;
  /** The camera's position (x, y, z) and rotation (x, y, z, w) after each frame, the first frame at index 0, and the head and eye of each. */
  poses: number[][];
  heads: THREE.Vector3[];
  eyes: THREE.Vector3[];
  aimOffsets: number[];
};

const OPEN_SIGHT = (): Sight => ({ ground: FLAT_GROUND, path: null, wallTop: 0, rim: Infinity, occ: [] });

/** Film one dummy released at `release` from `start`, until he is back at the ground. */
function filmFlight(release: THREE.Vector3, options: FlightOptions = {}): Flight {
  const cam = new RideCam();
  const camera = new THREE.PerspectiveCamera(DEFAULT_LENS_DEGREES, ASPECT, 0.1, 5000);
  const start = options.start ?? new THREE.Vector3(0, 0, 0);
  if (options.eyeBefore) {
    camera.position.copy(options.eyeBefore);
    camera.lookAt(start);
  }
  cam.begin({ group: { position: options.carAt ?? CAR_AT }, fwdFlat: CAR_FORWARD }, CAR_SPEED, PANE);
  const framing = cam.framing;
  framing.n = 1;
  framing.hold = true;
  framing.lens = DEFAULT_LENS_DEGREES;
  framing.sight = options.sight ?? OPEN_SIGHT;
  if (options.aimLead !== undefined) framing.lead = options.aimLead;
  const head = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const flight: Flight = { frames: 0, outsideInWindshield: 0, outsideAfterWindshield: 0, windshieldFrames: 0, outsideAnywhere: 0, poses: [], heads: [], eyes: [], aimOffsets: [] };
  let simSeconds = 0;
  for (let wallFrame = 0; ; wallFrame++) {
    simSeconds += FRAME_SECONDS * (options.timeScale?.(wallFrame) ?? 1);
    head.set(start.x + release.x * simSeconds, start.y + release.y * simSeconds - 0.5 * GRAVITY * simSeconds * simSeconds, start.z + release.z * simSeconds);
    if (head.y < 0 && wallFrame > 0) break;
    framing.c.copy(head);
    framing.vx = release.x;
    framing.vy = release.y - GRAVITY * simSeconds;
    framing.vz = release.z;
    cam.update(camera, FRAME_SECONDS, framing);
    camera.updateMatrixWorld();
    projected.copy(head).project(camera);
    const outside = projected.z > 1 || Math.abs(projected.x) > CENTRAL_SHARE || Math.abs(projected.y) > CENTRAL_SHARE;
    flight.frames++;
    if (outside) flight.outsideAnywhere++;
    if (cam.shot === "glass") {
      flight.windshieldFrames++;
      if (outside) flight.outsideInWindshield++;
    } else if (outside) flight.outsideAfterWindshield++;
    flight.poses.push([camera.position.x, camera.position.y, camera.position.z, camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w]);
    flight.heads.push(head.clone());
    flight.eyes.push(camera.position.clone());
    flight.aimOffsets.push(cam.look.distanceTo(head));
  }
  return flight;
}

describe("given a dummy thrown up the High jump's path (release 4, 58, 0 m/s) filmed at the default 50° lens", () => {
  it("when the aim is not led, then more than 5% of the frames after the windshield shot have him outside the central 95% (the fault)", () => {
    const flight = filmFlight(HIGH_JUMP_RELEASE);
    assert.ok(flight.windshieldFrames > 0, "the windshield shot opens the ride");
    assert.ok(flight.frames - flight.windshieldFrames > 600, "frames after the windshield shot");
    assert.ok(flight.outsideAfterWindshield / (flight.frames - flight.windshieldFrames) > FAILING_SHARE, `${flight.outsideAfterWindshield} of ${flight.frames - flight.windshieldFrames} frames outside`);
  });

  it("when the aim is led by MINIGAME_AIM_LEAD, then the ride opens on the follow shot and not one frame of the flight, the first included, has him outside the central 95%", () => {
    const flight = filmFlight(HIGH_JUMP_RELEASE, { aimLead: MINIGAME_AIM_LEAD });
    assert.ok(flight.frames > 600, "frames");
    assert.equal(flight.windshieldFrames, 0, "no windshield shot");
    assert.equal(flight.outsideAnywhere, 0, "frames outside");
  });
});

const LED_RELEASES = [
  { it: "the Ring Fling's slower, lower throw (10, 12, 0)", release: RING_FLING_RELEASE },
  { it: "a throw straight up (0, 58, 0), the camera's up vector along his climb", release: STRAIGHT_UP_RELEASE },
  { it: "a throw all but straight up (0.3, 58, 0)", release: NEAR_STRAIGHT_UP_RELEASE },
  { it: "the long jump's flat throw (23, 16, 0)", release: LONG_JUMP_RELEASE },
] as const;

describe("given other throws filmed at the default 50° lens with the aim led by MINIGAME_AIM_LEAD", () => {
  for (const testCase of LED_RELEASES) {
    it(`when ${testCase.it} is filmed, then not one frame of the flight, the first included, has him outside the central 95%`, () => {
      const flight = filmFlight(testCase.release, { aimLead: MINIGAME_AIM_LEAD });
      assert.ok(flight.frames > 60, "frames");
      assert.equal(flight.windshieldFrames, 0, "no windshield shot");
      assert.equal(flight.outsideAnywhere, 0, "frames outside");
    });
  }

  it("when the Ring Fling throw is filmed with the aim not led, then the frames outside show the control can fail", () => {
    const flight = filmFlight(RING_FLING_RELEASE);
    assert.ok(flight.outsideAnywhere > 0, "the unled control loses frames");
  });
});

describe("given the long jump's throw filmed in the engine's slow-mo (the sim at 0.032 of the wall's time for 300 frames) with the aim led by MINIGAME_AIM_LEAD", () => {
  const timeScale = (wallFrame: number): number => (wallFrame < SLOWMO_FRAMES ? SLOWMO_SCALE : 1);

  it("when he is filmed, then not one frame, the first included, has him outside the central 95%, and the aim never strays from his head by more than the lead's share of what the slow-mo shows", () => {
    const flight = filmFlight(LONG_JUMP_RELEASE, { aimLead: MINIGAME_AIM_LEAD, timeScale });
    const slowMotion = flight.aimOffsets.slice(0, SLOWMO_FRAMES);
    assert.equal(flight.outsideAnywhere, 0, "frames outside");
    assert.ok(slowMotion.length === SLOWMO_FRAMES, "slow-mo frames");
    assert.ok(Math.max(...slowMotion) < SLOWMO_AIM_OFFSET_LIMIT, `the aim strayed ${Math.max(...slowMotion)} m from his head`);
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
      const pose = filmFlight(testCase.release).poses[testCase.frame]!;
      for (let index = 0; index < testCase.pose.length; index++) {
        assert.ok(Math.abs(pose[index]! - testCase.pose[index]!) < TOLERANCE, `pose[${index}] ${pose[index]} against ${testCase.pose[index]}`);
      }
    });
  }
});

/** A cup's bowl: a floor with a square rim wall round it (inner half-width `CUP_INNER`, `CUP_WALL` thick, `CUP_RIM_HEIGHT` high: the 30 cup's 1.56 m radius, 0.76 m wall). */
const CUP_INNER = 1.56;
const CUP_WALL = 0.4;
const CUP_RIM_HEIGHT = 0.76;
const BOARD_EXTENT = 60;
const LYING_HEAD_HEIGHT = 0.2;
const RESTING_SECONDS = 3;
/** The independent line test: samples every `CHECK_STEP` m, a sample under the ground by more than `CHECK_SLACK` m blocks, the last `CHECK_STOP` m short of the head. */
const CHECK_STEP = 0.05;
const CHECK_SLACK = 0.02;
const CHECK_STOP = 0.3;

function bowlGround(): Ground {
  const ground = new Ground();
  ground.addPlane(0, -BOARD_EXTENT, BOARD_EXTENT, -BOARD_EXTENT, BOARD_EXTENT, Infinity);
  const outer = CUP_INNER + CUP_WALL;
  ground.addPlane(CUP_RIM_HEIGHT, -outer, outer, -outer, -CUP_INNER, Infinity);
  ground.addPlane(CUP_RIM_HEIGHT, -outer, outer, CUP_INNER, outer, Infinity);
  ground.addPlane(CUP_RIM_HEIGHT, -outer, -CUP_INNER, -outer, outer, Infinity);
  ground.addPlane(CUP_RIM_HEIGHT, CUP_INNER, outer, -outer, outer, Infinity);
  return ground;
}

/** Is `ground` between `eye` and `head` anywhere on the line, the last `CHECK_STOP` m short of the head? */
function groundBlocksLine(ground: Ground, eye: THREE.Vector3, head: THREE.Vector3): boolean {
  const length = eye.distanceTo(head);
  const point = new THREE.Vector3();
  for (let reach = 0; reach < length - CHECK_STOP; reach += CHECK_STEP) {
    point.lerpVectors(eye, head, reach / length);
    if (point.y < ground.heightAt(point.x, point.z) - CHECK_SLACK) return true;
  }
  return false;
}

/** The ride cam's eye after `RESTING_SECONDS` of a dummy lying still with his head at (0, `LYING_HEAD_HEIGHT`, 0) in the bowl; `aimLead` unset: no lead. */
function restingEye(aimLead: number | undefined, occluders: readonly Occluder[] = []): THREE.Vector3 {
  const ground = bowlGround();
  const cam = new RideCam();
  const camera = new THREE.PerspectiveCamera(DEFAULT_LENS_DEGREES, ASPECT, 0.1, 5000);
  cam.begin(null, 0, PANE);
  const framing = cam.framing;
  framing.n = 1;
  framing.hold = true;
  framing.c.set(0, LYING_HEAD_HEIGHT, 0);
  framing.sight = () => ({ ground, path: null, wallTop: 0, rim: Infinity, occ: occluders });
  if (aimLead !== undefined) framing.lead = aimLead;
  for (let frame = 0; frame < RESTING_SECONDS * FRAME_HZ; frame++) cam.update(camera, FRAME_SECONDS, framing);
  return camera.position.clone();
}

describe("given a dummy lying still in a cup's bowl with a rim wall round it, the ride cam holding on him", () => {
  const head = new THREE.Vector3(0, LYING_HEAD_HEIGHT, 0);

  it("when the aim is not led, then the rim blocks the line from the eye to him (the fault)", () => {
    const eye = restingEye(undefined);
    assert.ok(groundBlocksLine(bowlGround(), eye, head), `the eye at ${eye.toArray()} sees him over the rim`);
  });

  it("when the aim is led by MINIGAME_AIM_LEAD, then the line from the eye to him is clear of the rim, the eye stands above it and no nearer to him than the follow standoff", () => {
    const eye = restingEye(MINIGAME_AIM_LEAD);
    assert.ok(!groundBlocksLine(bowlGround(), eye, head), `the eye at ${eye.toArray()} is behind the rim`);
    assert.ok(eye.y > CUP_RIM_HEIGHT, `the eye is ${eye.y} m up`);
    assert.ok(eye.distanceTo(head) >= FOLLOW_STANDOFF, `the eye is ${eye.distanceTo(head)} m from him`);
  });
});

const SECOND_DUMMY_AT = new THREE.Vector3(10, 1.2, 0);
const CUT_FRAMES = 90;

/** The wall frames of the first `CUT_FRAMES` after the ride cuts to a dummy thrown up at `HIGH_JUMP_RELEASE` from `SECOND_DUMMY_AT`, 10 m from the one it rested on, that he is outside the central 95%. */
function framesOutsideAfterCutToClimber(aimLead: number | undefined): number {
  const cam = new RideCam();
  const camera = new THREE.PerspectiveCamera(DEFAULT_LENS_DEGREES, ASPECT, 0.1, 5000);
  cam.begin(null, 0, PANE);
  const framing = cam.framing;
  framing.n = 1;
  framing.hold = true;
  if (aimLead !== undefined) framing.lead = aimLead;
  framing.c.set(0, LYING_HEAD_HEIGHT, 0);
  for (let frame = 0; frame < RESTING_SECONDS * FRAME_HZ; frame++) cam.update(camera, FRAME_SECONDS, framing);
  framing.cut = true;
  const head = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let outside = 0;
  for (let frame = 0; frame < CUT_FRAMES; frame++) {
    const seconds = frame * FRAME_SECONDS;
    head.set(SECOND_DUMMY_AT.x + HIGH_JUMP_RELEASE.x * seconds, SECOND_DUMMY_AT.y + HIGH_JUMP_RELEASE.y * seconds - 0.5 * GRAVITY * seconds * seconds, SECOND_DUMMY_AT.z);
    framing.c.copy(head);
    framing.vx = HIGH_JUMP_RELEASE.x;
    framing.vy = HIGH_JUMP_RELEASE.y - GRAVITY * seconds;
    framing.vz = 0;
    cam.update(camera, FRAME_SECONDS, framing);
    framing.cut = false;
    camera.updateMatrixWorld();
    projected.copy(head).project(camera);
    if (projected.z > 1 || Math.abs(projected.x) > CENTRAL_SHARE || Math.abs(projected.y) > CENTRAL_SHARE) outside++;
  }
  return outside;
}

describe("given the ride cam resting on one dummy, and a second thrown up fast from 10 m away that it cuts to", () => {
  it("when the aim is led by MINIGAME_AIM_LEAD, then not one of the 90 frames after the cut has him outside the central 95% (the ease from the old pose is a cut)", () => {
    assert.equal(framesOutsideAfterCutToClimber(MINIGAME_AIM_LEAD), 0, "frames outside");
  });

  it("when the aim is not led, then the ease from the old pose loses him on some of those frames (the control can fail)", () => {
    assert.ok(framesOutsideAfterCutToClimber(undefined) > 0, "frames outside");
  });
});

/** The High jump's lip: the ramp's top 9.8 m up ends at x = 1, and the ground drops to 0 beyond it. */
const LIP_HEIGHT = 9.8;
const LIP_END_X = 1;
const LIP_CAR_AT = new THREE.Vector3(0.2, LIP_HEIGHT, 0);
/** The car's tight box: x from `LIP_CAR_AT.x - CAR_HALF_X` to `+ CAR_HALF_X`, ±`CAR_HALF_Z` in z, its roof `CAR_HEIGHT` over its base (the sim's car). */
const CAR_HALF_X = 2.2;
const CAR_HALF_Z = 0.9;
const CAR_HEIGHT = 1.36;
/** The dummy leaves through the windshield: his head at the roof, 0.8 m behind the car's middle. */
const LAUNCH_HEAD = new THREE.Vector3(-0.6, LIP_HEIGHT + 1.3, 0);
const LAUNCH_SPEED = 28;
/** Where the drive cam stood behind the car on the lip before the throw (measured in the real engine: 8 m behind, 5 m below the car). */
const DRIVE_CAM_EYE = new THREE.Vector3(-7.9, 4.6, 0);
const FIRST_SECOND_FRAMES = FRAME_HZ;
/** The line from the eye to the head is sampled every `CHECK_STEP` m and counts as hidden when a sample lies inside the car's box, the last `CAR_CHECK_STOP` m short of the head (he sits at the roof). */
const CAR_CHECK_STOP = 0.5;

function lipGround(): Ground {
  const ground = new Ground();
  ground.addPlane(0, -BOARD_EXTENT, BOARD_EXTENT, -BOARD_EXTENT, BOARD_EXTENT, Infinity);
  ground.addPlane(LIP_HEIGHT, -BOARD_EXTENT, LIP_END_X, -BOARD_EXTENT, BOARD_EXTENT, Infinity);
  return ground;
}

function carBoxHidesLine(eye: THREE.Vector3, head: THREE.Vector3): boolean {
  const length = eye.distanceTo(head);
  const point = new THREE.Vector3();
  for (let reach = 0; reach < length - CAR_CHECK_STOP; reach += CHECK_STEP) {
    point.lerpVectors(eye, head, reach / length);
    const inside = Math.abs(point.x - LIP_CAR_AT.x) < CAR_HALF_X && Math.abs(point.z - LIP_CAR_AT.z) < CAR_HALF_Z && point.y > LIP_HEIGHT && point.y < LIP_HEIGHT + CAR_HEIGHT;
    if (inside) return true;
  }
  return false;
}

describe("given a driver thrown from a car on the High jump's lip, filmed for the first second of his throw", () => {
  const release = new THREE.Vector3(LAUNCH_SPEED * 0.14, LAUNCH_SPEED * 2, 0);
  const options = (aimLead: number | undefined): FlightOptions => ({ aimLead, carAt: LIP_CAR_AT, start: LAUNCH_HEAD, eyeBefore: DRIVE_CAM_EYE, sight: () => ({ ground: lipGround(), path: null, wallTop: 0, rim: Infinity, occ: [] }) });

  it("when the aim is not led, then the car's own box hides his head from the eye on some of those frames (the fault)", () => {
    const flight = filmFlight(release, options(undefined));
    let hidden = 0;
    for (let frame = 0; frame < FIRST_SECOND_FRAMES; frame++) if (carBoxHidesLine(flight.eyes[frame]!, flight.heads[frame]!)) hidden++;
    assert.ok(hidden > 0, `${hidden} of ${FIRST_SECOND_FRAMES} frames hidden`);
  });

  it("when the aim is led by MINIGAME_AIM_LEAD, then the car's box hides him on none of the frames after the first of that second (the first is the old camera's own view) and he is inside the central 95% on every frame of the flight", () => {
    const flight = filmFlight(release, options(MINIGAME_AIM_LEAD));
    let hidden = 0;
    for (let frame = 1; frame < FIRST_SECOND_FRAMES; frame++) if (carBoxHidesLine(flight.eyes[frame]!, flight.heads[frame]!)) hidden++;
    assert.equal(hidden, 0, "frames hidden by the car after the first");
    assert.equal(flight.outsideAnywhere, 0, "frames outside");
  });
});

/** The High jump's frame across the throw: the posts' plane, a board `BOARD_HALF_THICKNESS` thick, `BOARD_HALF_SPAN` m either side of the lane (the posts 3 m out, up to 1 m thick), as tall as the flight. */
const POSTS_PLANE_X = 11;
const BOARD_HALF_THICKNESS = 0.075;
const BOARD_HALF_SPAN = 3.5;
const BOARD_TOP = 400;
const BOARD_PADDING = 0.5;
const BOARD_CROSSING_RELEASE = new THREE.Vector3(7, 58, 0);
/** The opening ease (`LEAD_OPEN_BLEND_T`, a quarter second of frames) and two frames more: the eye is then at the follow shot's. */
const OPENING_EASE_FRAMES = 17;
const STANDOFF_TOLERANCE = 0.1;
const STANDOFF_PER_SPEED = 0.25;
const STANDOFF_MAX = 12;
const AT_REST_STANDOFF = 8;
const AT_REST_HEIGHT = 6;
const FRAME_BOARD = occluder(POSTS_PLANE_X, 0, 0, BOARD_HALF_THICKNESS, BOARD_HALF_SPAN, false, 0, BOARD_TOP);

describe("given a dummy thrown up past the High jump's frame (release 7, 58, 0 m/s), its board across the lane at the posts' plane", () => {
  const boardSight = (): Sight => ({ ground: FLAT_GROUND, path: null, wallTop: 0, rim: Infinity, occ: [FRAME_BOARD] });

  it("when the aim is led by MINIGAME_AIM_LEAD, then the eye crosses the posts' plane and stands within the board's padded box on none of the frames", () => {
    const flight = filmFlight(BOARD_CROSSING_RELEASE, { aimLead: MINIGAME_AIM_LEAD, sight: boardSight });
    const eyeXs = flight.eyes.map((eye) => eye.x);
    let pressed = 0;
    for (const eye of flight.eyes) if (inside(FRAME_BOARD, eye.x, eye.y, eye.z, BOARD_PADDING)) pressed++;
    assert.ok(Math.min(...eyeXs) < POSTS_PLANE_X && Math.max(...eyeXs) > POSTS_PLANE_X, "the eye crosses the posts' plane");
    assert.equal(pressed, 0, "frames the eye is in or against the board");
    assert.equal(flight.outsideAnywhere, 0, "frames outside");
  });
});

describe("given a dummy thrown up the High jump's path (release 4, 58, 0 m/s) filmed with the aim led by MINIGAME_AIM_LEAD", () => {
  it("when he climbs, then on every frame after the opening ease the eye is at least a quarter second of his speed (at most 12 m) from him", () => {
    const flight = filmFlight(HIGH_JUMP_RELEASE, { aimLead: MINIGAME_AIM_LEAD });
    let nearest = Infinity;
    let shortfall = 0;
    for (let frame = OPENING_EASE_FRAMES; frame < flight.frames; frame++) {
      const seconds = (frame + 1) * FRAME_SECONDS;
      const climb = HIGH_JUMP_RELEASE.y - GRAVITY * seconds;
      if (climb <= 0) break;
      const speed = Math.hypot(HIGH_JUMP_RELEASE.x, climb);
      const wanted = Math.min(STANDOFF_MAX, STANDOFF_PER_SPEED * speed);
      const distance = flight.eyes[frame]!.distanceTo(flight.heads[frame]!);
      nearest = Math.min(nearest, distance - wanted);
      if (distance < wanted - STANDOFF_TOLERANCE) shortfall++;
    }
    assert.ok(nearest > -STANDOFF_TOLERANCE, `the eye was ${-nearest} m short of the standoff at its worst`);
    assert.equal(shortfall, 0, "frames nearer than the standoff");
  });
});

/** Cardboard stacks round a resting dummy: a stack `STACK_HEIGHT` tall (two boxes) at (`STACK_AT_X`, `STACK_AT_Z`), `STACK_HALF` either side, between the eye and the dummy. */
const STACK_HEIGHT = 2.6;
const STACK_AT_X = -1.75;
const STACK_AT_Z = -2.8;
const STACK_HALF = 0.8;
const STACK = occluder(STACK_AT_X, STACK_AT_Z, 0, STACK_HALF, STACK_HALF, false, 0, STACK_HEIGHT);
const LINE_STEP = 0.05;

/** Does the stack (not padded) hold any sample of the line from `eye` to `head`, the last `CHECK_STOP` m short of it? */
function stackBlocksLine(eye: THREE.Vector3, head: THREE.Vector3): boolean {
  const length = eye.distanceTo(head);
  const point = new THREE.Vector3();
  for (let reach = 0; reach < length - CHECK_STOP; reach += LINE_STEP) {
    point.lerpVectors(eye, head, reach / length);
    if (inside(STACK, point.x, point.y, point.z, 0)) return true;
  }
  return false;
}

describe("given a dummy lying still in a field of cardboard stacks, a 2.6 m stack 3.3 m from him between him and the eye", () => {
  const head = new THREE.Vector3(0, LYING_HEAD_HEIGHT, 0);

  it("when the aim is not led, then the stack blocks the line from the eye to him (the fault)", () => {
    const eye = restingEye(undefined, [STACK]);
    assert.ok(stackBlocksLine(eye, head), `the eye at ${eye.toArray()} sees him past the stack`);
  });

  it("when the aim is led by MINIGAME_AIM_LEAD, then the eye stands at least 6 m over his head and 8 m back, and the stack does not block the line to him", () => {
    const eye = restingEye(MINIGAME_AIM_LEAD, [STACK]);
    assert.ok(eye.y >= head.y + AT_REST_HEIGHT, `the eye is ${eye.y - head.y} m over him`);
    assert.ok(Math.hypot(eye.x - head.x, eye.z - head.z) >= AT_REST_STANDOFF, `the eye is ${Math.hypot(eye.x - head.x, eye.z - head.z)} m back`);
    assert.ok(!stackBlocksLine(eye, head), `the eye at ${eye.toArray()} is behind the stack`);
  });

  it("when the aim is led and no stack stands near him, then the eye still stands at least 6 m over his head and 8 m back", () => {
    const eye = restingEye(MINIGAME_AIM_LEAD);
    assert.ok(eye.y >= head.y + AT_REST_HEIGHT, `the eye is ${eye.y - head.y} m over him`);
    assert.ok(Math.hypot(eye.x - head.x, eye.z - head.z) >= AT_REST_STANDOFF, `the eye is ${Math.hypot(eye.x - head.x, eye.z - head.z)} m back`);
  });
});

const OPEN_JUMP_LIMIT = 3;
const OPEN_FIRST_FRAME_LIMIT = 3;

describe("given a driver thrown from the High jump's lip with the drive cam behind and below the car", () => {
  const options: FlightOptions = { aimLead: MINIGAME_AIM_LEAD, carAt: LIP_CAR_AT, start: LAUNCH_HEAD, eyeBefore: DRIVE_CAM_EYE, sight: () => ({ ground: lipGround(), path: null, wallTop: 0, rim: Infinity, occ: [] }) };

  it("when the ride opens with a lead, then the first frame's eye is within 3 m of where the drive cam stood, no later frame's eye moves more than 3 m from the one before, and he is inside the central 95% on every frame", () => {
    const release = new THREE.Vector3(LAUNCH_SPEED * 0.14, LAUNCH_SPEED * 2, 0);
    const flight = filmFlight(release, options);
    let largestJump = 0;
    for (let frame = 1; frame < flight.frames; frame++) largestJump = Math.max(largestJump, flight.eyes[frame]!.distanceTo(flight.eyes[frame - 1]!));
    assert.ok(flight.eyes[0]!.distanceTo(DRIVE_CAM_EYE) < OPEN_FIRST_FRAME_LIMIT, `the first frame's eye is ${flight.eyes[0]!.distanceTo(DRIVE_CAM_EYE)} m from the drive cam`);
    assert.ok(largestJump < OPEN_JUMP_LIMIT, `an eye jumped ${largestJump} m between two frames`);
    assert.equal(flight.outsideAnywhere, 0, "frames outside");
  });
});

/** A live dummy: only the head pose (offset 7 of `prev` and `cur`) and the velocity are read by the ride. */
function dollAt(head: THREE.Vector3, velocity: THREE.Vector3): Doll {
  const pose = new Float32Array(14);
  pose.set([head.x, head.y, head.z, 0, 0, 0, 1], 7);
  return {
    bodies: [], live: true, age: 0, life: 10, still: 0, patch: [], car: -1, rides: true, prev: pose, cur: pose, ground: false, settled: false, calm: 0, speed: 0,
    vel: new Float32Array([velocity.x, velocity.y, velocity.z]),
  };
}

const WALL_SECONDS = FRAME_SECONDS;
const AIM_TOLERANCE = 0.02;
const SETTLE_FRAMES = 90;
const HEAD_OFFSET = 7;

describe("given two dummies climbing together, 0.5 m apart in height, the sim run at half the wall's pace", () => {
  const climbs = [new THREE.Vector3(3, 50, 0), new THREE.Vector3(3, 50, 0)];
  const meanVelocity = new THREE.Vector3(3, 50, 0);
  const shownScale = 0.5;

  /** The aim's offset from the heads' centre after `SETTLE_FRAMES` frames, the dummies moving `shownScale` of their sim velocity per wall second. */
  function aimOffsetAfterSettling(lead: number | undefined): THREE.Vector3 {
    const dolls = climbs.map((climb, index) => dollAt(new THREE.Vector3(0, 100 + 0.5 * index, 0), climb));
    const ride = new RideAlong();
    const camera = new THREE.PerspectiveCamera(DEFAULT_LENS_DEGREES, ASPECT, 0.1, 5000);
    ride.follow(dolls[0], 0, []);
    const centre = new THREE.Vector3();
    for (let frame = 0; frame < SETTLE_FRAMES; frame++) {
      centre.set(0, 0, 0);
      for (const [index, doll] of dolls.entries()) {
        const shown = climbs[index]!.clone().multiplyScalar(shownScale * frame * FRAME_SECONDS).add(new THREE.Vector3(0, 100 + 0.5 * index, 0));
        doll.cur.set([shown.x, shown.y, shown.z], HEAD_OFFSET);
        centre.add(shown);
      }
      centre.multiplyScalar(1 / dolls.length);
      if (lead === undefined) ride.frame(dolls, 1, camera, WALL_SECONDS, true, -1, false, DEFAULT_LENS_DEGREES, OPEN_SIGHT);
      else ride.frame(dolls, 1, camera, WALL_SECONDS, true, -1, false, DEFAULT_LENS_DEGREES, OPEN_SIGHT, lead);
      if (frame === SETTLE_FRAMES - 1) return ride.cam.look.clone().sub(centre);
    }
    throw new Error("no frames");
  }

  it("when the ride is framed with no lead passed, then the aim trails the heads' centre by their shown velocity's share of the ease", () => {
    const aim = aimOffsetAfterSettling(undefined);
    const expected = meanVelocity.clone().multiplyScalar(-shownScale * AIM_LAG_SECONDS);
    assert.ok(aim.distanceTo(expected) < AIM_TOLERANCE, `aim offset ${aim.toArray()} against ${expected.toArray()}`);
  });

  it("when the ride is framed with a lead of 0.1 s, then the aim settles where the lead and the ease's trail leave it, by the shown and not the sim's velocity", () => {
    const aim = aimOffsetAfterSettling(MINIGAME_AIM_LEAD);
    const expected = meanVelocity.clone().multiplyScalar(shownScale * (MINIGAME_AIM_LEAD - AIM_LAG_SECONDS));
    assert.ok(aim.distanceTo(expected) < AIM_TOLERANCE, `aim offset ${aim.toArray()} against ${expected.toArray()}`);
  });
});
