import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { FRAME_HZ, GRAVITY } from "../kernel/constants.ts";
import { blankEjection, ejectionVelocity } from "../vehicle/ejection.ts";
import { setGround } from "../world/ground.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { BOX_POSE_FLOATS, type BoxPlacement } from "./ragdoll-boxes.ts";
import { STEP } from "./ragdoll-config.ts";

const FRAME = 1 / FRAME_HZ;
const STEPS_PER_FRAME = Math.round(FRAME / STEP);
const UP = new THREE.Vector3(0, 1, 0);
/** The pile under test: 4 x 4 towers of 3 boxes (the layout lane's proposal, 48 boxes), 0.9 m cartons a hand apart. */
const BOX_EDGE = 0.9;
const BOX_GAP = 0.05;
const PILE_COLUMNS = 4;
const PILE_LAYERS = 3;
const BOX_COUNT = PILE_COLUMNS * PILE_COLUMNS * PILE_LAYERS;
const PILE_FACE_X = 20;
const BOX_PITCH = BOX_EDGE + BOX_GAP;
const PILE_TOP = PILE_LAYERS * BOX_EDGE;
/** The shots' lateral line: through the middle of the second row of towers, not the 5 cm slot between the rows that the pile's centre falls in. */
const AIM_Z = BOX_EDGE / 2 + BOX_PITCH;
/** How far inside the pile's face (m) the shots are aimed, how steeply a high jump comes down, and how far over the pile's top (m) his torso is aimed (a torso is half a body thick). */
const AIM_DEPTH = 1;
const LANDING_DESCENT_DEGREES = 40;
const TORSO_OVER_TOP = 0.3;
/** A little yaw per box, so the pose rows see a turned box and the pile is not a perfect grid. */
const YAW_STEP = 0.04;

function pileLayout(): BoxPlacement[] {
  const boxes: BoxPlacement[] = [];
  for (let layer = 0; layer < PILE_LAYERS; layer++) {
    for (let column = 0; column < PILE_COLUMNS; column++) {
      for (let row = 0; row < PILE_COLUMNS; row++) {
        const yaw = ((boxes.length % 5) - 2) * YAW_STEP;
        boxes.push({ x: PILE_FACE_X + BOX_EDGE / 2 + column * BOX_PITCH, y: BOX_EDGE / 2 + layer * BOX_EDGE, z: row * BOX_PITCH + BOX_EDGE / 2, yaw, width: BOX_EDGE, height: BOX_EDGE, depth: BOX_EDGE });
      }
    }
  }
  return boxes;
}

/** A ragdoll system on the range's flat sand (`sand`: friction 3, as the range has it) with no cars. */
async function system(boxes: readonly BoxPlacement[]): Promise<RagdollSystem> {
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  sys.sand = true;
  await sys.preload();
  setGround(null);
  sys.update(FRAME, [], true, false, null);
  sys.setBoxes(boxes);
  return sys;
}

function spawnDummy(sys: RagdollSystem, at: THREE.Vector3, velocity: THREE.Vector3): void {
  const lie = velocity.lengthSq() > 0 ? velocity.clone().normalize() : UP;
  sys["spawn"]({ car: 0, p: at, q: new THREE.Quaternion().setFromUnitVectors(UP, lie), v: velocity, w: new THREE.Vector3(), age: 0, cop: false, rides: true });
}

/** A dummy far from the pile, thrown straight up at `speed`: it keeps the world stepping for `2 * speed / GRAVITY` s without touching a box. */
function flyFarAway(sys: RagdollSystem, speed: number): void {
  spawnDummy(sys, new THREE.Vector3(-300, 1.5, 0), new THREE.Vector3(0, speed, 0));
}

/**
 * A dummy from `distance` m before a point `AIM_DEPTH` m inside the pile's face, head first at `speed` m/s, `descentDegrees` below the
 * horizontal, aimed so that his torso reaches that point, along `AIM_Z`, at `aimHeight`.
 */
function fireIntoPile(sys: RagdollSystem, speed: number, descentDegrees: number, aimHeight: number): void {
  const distance = 12;
  const descent = (descentDegrees * Math.PI) / 180;
  const horizontal = speed * Math.cos(descent);
  const vertical = -speed * Math.sin(descent);
  const flight = distance / horizontal;
  const startHeight = aimHeight - vertical * flight + 0.5 * GRAVITY * flight * flight;
  spawnDummy(sys, new THREE.Vector3(PILE_FACE_X + AIM_DEPTH - distance, startHeight, AIM_Z), new THREE.Vector3(horizontal, vertical, 0));
}

/** The landing after a high jump: 40 degrees down onto the pile's top, his torso a little over it. */
const fireOntoPile = (sys: RagdollSystem, speed: number) => fireIntoPile(sys, speed, LANDING_DESCENT_DEGREES, PILE_TOP + TORSO_OVER_TOP);

const dummyOf = (sys: RagdollSystem) => sys["dolls"][0]!;
const boxBodiesOf = (sys: RagdollSystem) => sys["boxes"]["bodies"];

/** The deepest a point sits inside a box (m, positive; 0 outside it), the box given as `copyBoxPoses` pose `index` and its edge. */
const _local = new THREE.Vector3();
const _turn = new THREE.Quaternion();
function depthInside(poses: Float32Array, index: number, edge: number, point: { x: number; y: number; z: number }): number {
  const o = index * BOX_POSE_FLOATS;
  _turn.set(poses[o + 3]!, poses[o + 4]!, poses[o + 5]!, poses[o + 6]!).invert();
  _local.set(point.x - poses[o]!, point.y - poses[o + 1]!, point.z - poses[o + 2]!).applyQuaternion(_turn);
  const clearance = Math.max(Math.abs(_local.x), Math.abs(_local.y), Math.abs(_local.z)) - edge / 2;
  return Math.max(0, -clearance);
}

type Settle = { stillSeconds: number; simSeconds: number; deepestInside: number; lowestPart: number; farthestBoxMove: number; nearestBox: number; torso: THREE.Vector3 };

/** Run frames until the torso has lain still `stillWanted` s (or `limit` sim s), tracking how deep any part went into any box and how low any part went. */
function runUntilStill(sys: RagdollSystem, stillWanted: number, limit: number): Settle {
  const placements = pileLayout();
  const poses = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
  const torso = new THREE.Vector3();
  const dummy = dummyOf(sys);
  let deepestInside = 0;
  let lowestPart = Infinity;
  let stillSeconds = -1;
  let frames = 0;
  for (; frames < limit * FRAME_HZ && stillSeconds < stillWanted; frames++) {
    sys.update(FRAME, [], true, false, null);
    stillSeconds = sys.latest(torso);
    sys.copyBoxPoses(poses);
    for (const part of dummy.bodies) {
      const centre = part.translation();
      lowestPart = Math.min(lowestPart, centre.y);
      for (let i = 0; i < BOX_COUNT; i++) deepestInside = Math.max(deepestInside, depthInside(poses, i, BOX_EDGE, centre));
    }
  }
  return { stillSeconds, simSeconds: frames * FRAME, deepestInside, lowestPart, farthestBoxMove: farthestMove(poses, placements), nearestBox: nearestBoxCentre(poses, torso), torso };
}

/** The distance (m) from `point` to the nearest box centre in `poses`. */
function nearestBoxCentre(poses: Float32Array, point: THREE.Vector3): number {
  let nearest = Infinity;
  for (let i = 0; i < BOX_COUNT; i++) nearest = Math.min(nearest, Math.hypot(poses[i * BOX_POSE_FLOATS]! - point.x, poses[i * BOX_POSE_FLOATS + 1]! - point.y, poses[i * BOX_POSE_FLOATS + 2]! - point.z));
  return nearest;
}

/** The farthest any box in `poses` is from its placement (m). */
function farthestMove(poses: Float32Array, placements: readonly BoxPlacement[]): number {
  let farthest = 0;
  for (let i = 0; i < placements.length; i++) {
    const o = i * BOX_POSE_FLOATS;
    const placement = placements[i]!;
    farthest = Math.max(farthest, Math.hypot(poses[o]! - placement.x, poses[o + 1]! - placement.y, poses[o + 2]! - placement.z));
  }
  return farthest;
}

function currentMove(sys: RagdollSystem): number {
  const poses = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
  sys.copyBoxPoses(poses);
  return farthestMove(poses, pileLayout());
}

/** A dummy that has never been thrown has no statics: the first throw builds the ground the boxes stand on. */
const allAsleep = (sys: RagdollSystem) => boxBodiesOf(sys).every((body) => body.isSleeping());

/** Most a box may drift from where it was put while nothing touches it (m). */
const DRIFT_MAX = 0.05;
/** Most a dummy's part centre may sit inside a box (m): a centre lies outside the box it rests on by half the part's thickness (measured at most 0.025 m over the four shots); one step at 30 m/s is 0.06 m, so more than this is a tunnel. */
const SOAK_INSIDE_BOX = 0.05;
/** A part's centre rides over the pad (y = 0) by half its thickness (measured: 0.051 m at the lowest over the four shots, among the boxes included). */
const PAD_LEVEL = 0;
/** A box lying on a face rests with its centre half an edge up; this much lower (m) is a box sunk into the pad. */
const BOX_SETTLE_SOAK = 0.02;
/** Sim seconds the torso must have lain under 0.4 m/s (`latest()`), and the sim time allowed to get there. */
const REST_HOLD = 1;
const REST_WITHIN = 15;
/** A box he hits moves at least this far (m). */
const BOX_HIT_MOVE = 0.1;

describe("given a pile of 48 cardboard boxes standing asleep on flat ground", () => {
  it("when nothing touches it while the world steps for 10 s, then no box drifts 5 cm and every box is still asleep", async () => {
    const sys = await system(pileLayout());
    flyFarAway(sys, 40);
    const stepsBefore = sys.stats.steps;
    for (let frame = 0; frame < 10 * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const stepped = sys.stats.steps - stepsBefore;
    const drift = currentMove(sys);
    const asleep = allAsleep(sys);
    sys.dispose();
    assert.ok(stepped >= 5 * Math.round(1 / STEP), `the world stepped ${stepped} times: a dummy was flying`);
    assert.ok(drift < DRIFT_MAX, `a box drifted ${drift.toFixed(3)} m`);
    assert.ok(asleep, "every box is asleep");
  });

  it("when every box is woken and left untouched for 10 s, then the pile holds: no box ends 5 cm from where it stood", async () => {
    const sys = await system(pileLayout());
    flyFarAway(sys, 40);
    for (let frame = 0; frame < 30; frame++) sys.update(FRAME, [], true, false, null);
    for (const body of boxBodiesOf(sys)) body.wakeUp();
    let maxDrift = 0;
    let awakeFrames = 0;
    for (let frame = 0; frame < 10 * FRAME_HZ; frame++) {
      sys.update(FRAME, [], true, false, null);
      maxDrift = Math.max(maxDrift, currentMove(sys));
      if (!sys["boxes"].asleep()) awakeFrames++;
    }
    sys.dispose();
    assert.ok(awakeFrames > FRAME_HZ, `the pile was awake for ${awakeFrames} frames: a jitter or a slow collapse is what that would show`);
    assert.ok(maxDrift < DRIFT_MAX, `a box moved ${maxDrift.toFixed(3)} m from its place`);
  });
});

/** "On or among the boxes": a box centre this near (m) his torso at rest (a lying dummy is 2 m long; measured at most 1.83 m over the four shots). */
const AMONG_BOXES = 2;
/** A restacked box is this near its placement (m). */
const RESTACK_TOLERANCE = 0.01;
/** Frames after a 30 m/s shot when the boxes are still tumbling (0.5 s). */
const HIT_FRAMES = FRAME_HZ / 2;
/** Sim seconds a held dummy must outlive (the owner's flow: the camera holds with no timer). */
const HELD_SECONDS = 60;

const hitCases = [
  { it: "when he is thrown at 15 m/s descending 40 degrees onto its top, then he lies on or among the boxes", speed: 15, descentDegrees: LANDING_DESCENT_DEGREES, aimHeight: PILE_TOP + TORSO_OVER_TOP },
  { it: "when he is thrown at 20 m/s descending 40 degrees onto its top, then he lies on or among the boxes", speed: 20, descentDegrees: LANDING_DESCENT_DEGREES, aimHeight: PILE_TOP + TORSO_OVER_TOP },
  { it: "when he is thrown at 25 m/s descending 40 degrees onto its top, then he lies on or among the boxes", speed: 25, descentDegrees: LANDING_DESCENT_DEGREES, aimHeight: PILE_TOP + TORSO_OVER_TOP },
  { it: "when he is thrown level at 30 m/s into its middle layer, then no part of him is ever inside a box and he lies among the boxes he shoved", speed: 30, descentDegrees: 0, aimHeight: 1.35 },
] as const;

describe("given a held dummy thrown into the pile of boxes", () => {
  for (const testCase of hitCases) {
    it(testCase.it, async () => {
      const sys = await system(pileLayout());
      sys.holdThrown();
      fireIntoPile(sys, testCase.speed, testCase.descentDegrees, testCase.aimHeight);
      const settle = runUntilStill(sys, REST_HOLD, REST_WITHIN);
      console.log(
        `boxes hit ${testCase.speed} m/s ${testCase.descentDegrees} deg: still ${settle.stillSeconds.toFixed(2)} s after ${settle.simSeconds.toFixed(2)} s, torso (${settle.torso.x.toFixed(2)}, ${settle.torso.y.toFixed(2)}, ${settle.torso.z.toFixed(2)}), deepest part in a box ${settle.deepestInside.toFixed(3)} m, lowest part ${settle.lowestPart.toFixed(3)} m, farthest box ${settle.farthestBoxMove.toFixed(2)} m`,
      );
      sys.dispose();
      assert.ok(settle.stillSeconds >= REST_HOLD, `his still-time reached ${settle.stillSeconds.toFixed(2)} s in ${settle.simSeconds.toFixed(1)} s sim`);
      assert.ok(settle.deepestInside < SOAK_INSIDE_BOX, `a part went ${settle.deepestInside.toFixed(3)} m into a box`);
      assert.ok(settle.lowestPart > PAD_LEVEL, `a part went down to ${settle.lowestPart.toFixed(3)} m: under the pad`);
      assert.ok(settle.farthestBoxMove > BOX_HIT_MOVE, `no box moved: the farthest went ${settle.farthestBoxMove.toFixed(3)} m`);
      assert.ok(settle.nearestBox < AMONG_BOXES, `the nearest box centre is ${settle.nearestBox.toFixed(2)} m from his torso at (${settle.torso.x.toFixed(2)}, ${settle.torso.z.toFixed(2)})`);
    });
  }
});

describe("given boxes a dummy has scattered", () => {
  it("when restackBoxes() is called, then every box is within 1 cm of its placement and asleep, and a second dummy scatters them again", async () => {
    const placements = pileLayout();
    const sys = await system(placements);
    sys.holdThrown();
    fireOntoPile(sys, 25);
    const first = runUntilStill(sys, REST_HOLD, REST_WITHIN);
    sys.releaseThrown();
    sys.restackBoxes();
    let farthest = 0;
    for (let i = 0; i < placements.length; i++) {
      const at = boxBodiesOf(sys)[i]!.translation();
      const placement = placements[i]!;
      farthest = Math.max(farthest, Math.hypot(at.x - placement.x, at.y - placement.y, at.z - placement.z));
    }
    const asleep = allAsleep(sys);
    const poseMove = currentMove(sys);
    sys.holdThrown();
    fireOntoPile(sys, 25);
    const second = runUntilStill(sys, REST_HOLD, REST_WITHIN);
    sys.dispose();
    assert.ok(first.farthestBoxMove > BOX_HIT_MOVE, `the first dummy scattered them ${first.farthestBoxMove.toFixed(2)} m`);
    assert.ok(farthest < RESTACK_TOLERANCE, `a box is ${farthest.toFixed(4)} m from its place`);
    assert.ok(poseMove < RESTACK_TOLERANCE, `copyBoxPoses has a box ${poseMove.toFixed(4)} m from its place`);
    assert.ok(asleep, "every box is asleep");
    assert.ok(second.farthestBoxMove > BOX_HIT_MOVE, `the second dummy moved a restacked box ${second.farthestBoxMove.toFixed(3)} m: it never woke`);
  });

  it("when the dummy is released while the boxes still tumble, then the world keeps stepping until they lie asleep above the pad", async () => {
    const sys = await system(pileLayout());
    sys.holdThrown();
    fireIntoPile(sys, 30, 0, 1.35);
    for (let frame = 0; frame < HIT_FRAMES; frame++) sys.update(FRAME, [], true, false, null);
    const awakeAtRelease = boxBodiesOf(sys).filter((body) => !body.isSleeping()).length;
    sys.releaseThrown();
    for (let frame = 0; frame < 10 * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const lowest = Math.min(...boxBodiesOf(sys).map((body) => body.translation().y));
    const asleep = allAsleep(sys);
    const poolAsleep = sys["boxes"].asleep();
    sys.dispose();
    assert.ok(awakeAtRelease > 0, "boxes were still moving when he went");
    assert.ok(asleep && poolAsleep, "every box ended asleep");
    assert.ok(lowest > BOX_EDGE / 2 - BOX_SETTLE_SOAK, `a box ended with its centre ${lowest.toFixed(3)} m up: under the pad`);
  });

  it("when the dummy falls asleep while boxes he hit still move, then the world steps on until the pile lies asleep", async () => {
    const sys = await system(pileLayout());
    sys.holdThrown();
    fireIntoPile(sys, 30, 0, 1.35);
    let awakeWhenDummySlept = -1;
    for (let frame = 0; frame < 15 * FRAME_HZ; frame++) {
      sys.update(FRAME, [], true, false, null);
      if (awakeWhenDummySlept < 0 && dummyOf(sys).bodies[0]!.isSleeping()) awakeWhenDummySlept = boxBodiesOf(sys).filter((body) => !body.isSleeping()).length;
    }
    const asleep = allAsleep(sys);
    sys.dispose();
    assert.ok(awakeWhenDummySlept > 0, `${awakeWhenDummySlept} boxes were awake when he fell asleep (-1: he never did)`);
    assert.ok(asleep, "every box ended asleep");
  });
});

/** An ejection out of the car's windshield, but far from the pile and the origin: car velocity (7, -1, 5), his own (2, 12, 3). */
function farEjection() {
  const ejection = blankEjection();
  ejection.dir.set(0, 0, 1);
  ejection.pos.set(-300, 1.5, 0);
  ejection.rel.set(2, 12, 3);
  ejection.carVel.set(7, -1, 5);
  return ejection;
}

describe("given a dummy launched through launch() from a car", () => {
  it("when holdThrown() was called and a minute of sim passes, then he is still alive and still, and releaseThrown() removes him", async () => {
    const sys = await system([]);
    const car = makeCar();
    sys.holdThrown();
    sys.launch(farEjection(), [car]);
    const torso = new THREE.Vector3();
    for (let frame = 0; frame < HELD_SECONDS * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const heldStill = sys.latest(torso);
    sys.releaseThrown();
    const afterRelease = sys.latest(torso);
    sys.dispose();
    assert.ok(heldStill > 30, `after ${HELD_SECONDS} s he has lain still for ${heldStill.toFixed(1)} s (-1: he is gone)`);
    assert.equal(afterRelease, -1, "released: he is gone");
  });

  it("when nothing was held and 11 s of sim pass, then his 10 s life is over and he is gone", async () => {
    const sys = await system([]);
    const car = makeCar();
    sys.launch(farEjection(), [car]);
    const torso = new THREE.Vector3();
    for (let frame = 0; frame < 11 * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const gone = sys.latest(torso);
    sys.dispose();
    assert.equal(gone, -1, "gone after LIFE");
  });

  it("when he was held and released, then the next dummy lives 10 s again", async () => {
    const sys = await system([]);
    const car = makeCar();
    sys.holdThrown();
    sys.releaseThrown();
    sys.launch(farEjection(), [car]);
    const torso = new THREE.Vector3();
    for (let frame = 0; frame < 11 * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const gone = sys.latest(torso);
    sys.dispose();
    assert.equal(gone, -1, "the default life is back");
  });

  it("when reset() is called while boxes stand and a dummy is held, then the boxes are gone and the next dummy lives 10 s", async () => {
    const sys = await system(pileLayout());
    sys.holdThrown();
    sys.reset();
    const out = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
    const count = sys.copyBoxPoses(out);
    const car = makeCar();
    sys.launch(farEjection(), [car]);
    const life = dummyOf(sys).life;
    sys.dispose();
    assert.equal(count, 0, "no boxes after reset");
    assert.equal(life, 10, "LIFE after reset");
  });

  it("when launched with no scale, with scale 1 and with scale 1.3, then the first two equal the ejection's own velocity bit for bit and the third is 1.3 times it", async () => {
    const car = makeCar();
    const launched = async (scale: number | null) => {
      const sys = await system([]);
      const ejection = farEjection();
      if (scale === null) sys.launch(ejection, [car]);
      else sys.launch(ejection, [car], true, scale);
      const velocity = dummyOf(sys).bodies[0]!.linvel();
      const position = dummyOf(sys).bodies[0]!.translation();
      const own = ejectionVelocity(ejection, new THREE.Vector3());
      sys.dispose();
      return { velocity, position, own };
    };
    const unscaled = await launched(null);
    const one = await launched(1);
    const boosted = await launched(1.3);
    assert.equal(unscaled.velocity.x, Math.fround(unscaled.own.x), "default x");
    assert.equal(unscaled.velocity.y, Math.fround(unscaled.own.y), "default y");
    assert.equal(unscaled.velocity.z, Math.fround(unscaled.own.z), "default z");
    assert.equal(one.velocity.x, unscaled.velocity.x, "scale 1 x");
    assert.equal(one.velocity.y, unscaled.velocity.y, "scale 1 y");
    assert.equal(one.velocity.z, unscaled.velocity.z, "scale 1 z");
    assert.equal(one.position.x, unscaled.position.x, "scale 1 starts at the same x");
    assert.ok(Math.abs(boosted.velocity.x - 1.3 * unscaled.velocity.x) < 1e-5, `boosted x ${boosted.velocity.x} vs ${1.3 * unscaled.velocity.x}`);
    assert.ok(Math.abs(boosted.velocity.y - 1.3 * unscaled.velocity.y) < 1e-5, `boosted y ${boosted.velocity.y} vs ${1.3 * unscaled.velocity.y}`);
    assert.ok(Math.abs(boosted.velocity.z - 1.3 * unscaled.velocity.z) < 1e-5, `boosted z ${boosted.velocity.z} vs ${1.3 * unscaled.velocity.z}`);
    assert.equal(boosted.position.x, unscaled.position.x, "the boost does not move him: same start x");
    assert.equal(boosted.position.y, unscaled.position.y, "the boost does not move him: same start y");
    assert.equal(boosted.position.z, unscaled.position.z, "the boost does not move him: same start z");
  });
});

describe("given the boxes a ragdoll system draws from and the bodies it holds", () => {
  it("when 48 boxes are set before and after Rapier is in, then none exist before and every one after, in placement order with the pose layout position xyz, rotation xyzw", async () => {
    const placements = pileLayout();
    const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    sys.setBoxes(placements);
    const out = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
    const before = sys.copyBoxPoses(out);
    await sys.preload();
    const bodiesBefore = sys.stats.bodies;
    const after = sys.copyBoxPoses(out);
    const farthest = Math.max(...placements.map((placement, i) => Math.hypot(out[i * 7]! - placement.x, out[i * 7 + 1]! - placement.y, out[i * 7 + 2]! - placement.z)));
    const turnError = Math.max(...placements.map((placement, i) => Math.hypot(out[i * 7 + 3]!, out[i * 7 + 4]! - Math.sin(placement.yaw / 2), out[i * 7 + 5]!, out[i * 7 + 6]! - Math.cos(placement.yaw / 2))));
    assert.throws(() => sys.copyBoxPoses(new Float32Array(BOX_POSE_FLOATS * (BOX_COUNT - 1))), RangeError, "a buffer one box short is refused");
    sys.setBoxes(placements.slice(0, 3));
    const replaced = sys.copyBoxPoses(out);
    const bodiesReplaced = sys.stats.bodies;
    sys.clearBoxes();
    const cleared = sys.copyBoxPoses(out);
    const bodiesCleared = sys.stats.bodies;
    sys.dispose();
    assert.equal(before, 0, "no boxes before Rapier");
    assert.equal(after, BOX_COUNT, "every box once Rapier is in");
    assert.ok(farthest < 1e-5, `a pose is ${farthest} m from its placement`);
    assert.ok(turnError < 1e-5, `a rotation is ${turnError} off the yaw's quaternion`);
    assert.equal(replaced, 3, "setBoxes replaces the pile");
    assert.equal(bodiesBefore - bodiesReplaced, BOX_COUNT - 3, "the replaced boxes' bodies are removed from the world");
    assert.equal(cleared, 0, "clearBoxes leaves none");
    assert.equal(bodiesBefore - bodiesCleared, BOX_COUNT, "every box's body is removed from the world");
  });

  it("when a dummy has scattered them, then copyBoxPoses reads where the bodies are", async () => {
    const sys = await system(pileLayout());
    sys.holdThrown();
    fireOntoPile(sys, 25);
    runUntilStill(sys, REST_HOLD, REST_WITHIN);
    const out = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
    sys.copyBoxPoses(out);
    let farthest = 0;
    for (let i = 0; i < BOX_COUNT; i++) {
      const at = boxBodiesOf(sys)[i]!.translation();
      farthest = Math.max(farthest, Math.hypot(out[i * 7]! - at.x, out[i * 7 + 1]! - at.y, out[i * 7 + 2]! - at.z));
    }
    sys.dispose();
    assert.ok(farthest < 1e-4, `a drawn box is ${farthest} m from its body`);
  });
});

/** Wall ms of the world steps taken since step number `stepsBefore` (`RagdollStats.log`). */
function stepMilliseconds(sys: RagdollSystem, stepsBefore: number): number {
  const { steps, log } = sys.stats;
  let milliseconds = 0;
  for (let step = stepsBefore; step < steps; step++) milliseconds += log[step % log.length]!;
  return milliseconds;
}

/** One render frame of `sys`, and the wall ms its world steps took. */
function frameCost(sys: RagdollSystem): number {
  const stepsBefore = sys.stats.steps;
  sys.update(FRAME, [], true, false, null);
  return stepMilliseconds(sys, stepsBefore);
}

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const percentile95 = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;

/** Per frame, the wall ms of one world's steps with the pile and of the same dummy's world without it (a loaded machine slows both alike: the frames alternate which runs first). */
type Costs = { withPile: number[]; without: number[]; awakeBoxes: number[] };
type CostWindow = { name: string; budgetMs: number; costs: Costs };

const newCosts = (): Costs => ({ withPile: [], without: [], awakeBoxes: [] });
const addedMedian = (costs: Costs) => median(costs.withPile) - median(costs.without);

function pairedFrame(withPile: RagdollSystem, without: RagdollSystem, frame: number, into: Costs): void {
  const pileFirst = frame % 2 === 0;
  const first = frameCost(pileFirst ? withPile : without);
  const second = frameCost(pileFirst ? without : withPile);
  into.withPile.push(pileFirst ? first : second);
  into.without.push(pileFirst ? second : first);
  into.awakeBoxes.push(withPile["boxes"]["awake"]);
}

/** The same 40 m/s upward throw far away in a world with the pile and one without: the pile asleep, then every box woken and left to settle. */
async function measureFlightWindows(): Promise<CostWindow[]> {
  const withPile = await system(pileLayout());
  const without = await system([]);
  flyFarAway(withPile, 40);
  flyFarAway(without, 40);
  for (let frame = 0; frame < COST_WARMUP_FRAMES; frame++) pairedFrame(withPile, without, frame, newCosts());
  const asleep = newCosts();
  for (let frame = 0; frame < COST_FRAMES; frame++) pairedFrame(withPile, without, frame, asleep);
  for (const body of boxBodiesOf(withPile)) body.wakeUp();
  const awake = newCosts();
  for (let frame = 0; frame < COST_FRAMES; frame++) {
    pairedFrame(withPile, without, frame, awake);
    if (withPile["boxes"]["awake"] === 0) break;
  }
  withPile.dispose();
  without.dispose();
  return [
    { name: "pile asleep", budgetMs: ASLEEP_BUDGET_MS, costs: asleep },
    { name: "every box woken, settling", budgetMs: AWAKE_BUDGET_MS, costs: awake },
  ];
}

/** The same 25 m/s shot at the pile's top layer in a world with the pile and one without (he lands on the pad there): every frame until the pile lies asleep again. */
async function measureHitWindow(): Promise<CostWindow> {
  const withPile = await system(pileLayout());
  const without = await system([]);
  for (const sys of [withPile, without]) fireOntoPile(sys, 25);
  const hit = newCosts();
  for (let frame = 0; frame < HIT_WINDOW_FRAMES; frame++) {
    pairedFrame(withPile, without, frame, hit);
    if (frame > FRAME_HZ && withPile["boxes"]["awake"] === 0) break;
  }
  withPile.dispose();
  without.dispose();
  return { name: "dummy fired through the pile", budgetMs: AWAKE_BUDGET_MS, costs: hit };
}

/** Frames measured (well inside the 8 s flight of a 40 m/s throw), frames discarded first (JIT, the first steps), and the longest hit window (s of frames). */
const COST_FRAMES = 240;
const COST_WARMUP_FRAMES = 60;
const HIT_WINDOW_FRAMES = 6 * FRAME_HZ;
/** Added Rapier step cost per render frame (ms): the budget for 48 boxes, on the machine that measured it. */
const ASLEEP_BUDGET_MS = 0.5;
const AWAKE_BUDGET_MS = 3;
/** Independent measurements of each window; the lowest added cost counts (a noisy machine only ever adds to a timing). */
const COST_ATTEMPTS = 3;

describe("given the pile of 48 boxes in the dummies' world and a dummy flying far from it or fired through it", () => {
  it("when the render frame's 8 steps run with the pile asleep, with every box awake and with a dummy fired through it, then each adds less than its budget over the same world without boxes", async () => {
    const attempts: CostWindow[][] = [];
    for (let attempt = 0; attempt < COST_ATTEMPTS; attempt++) attempts.push([...(await measureFlightWindows()), await measureHitWindow()]);
    console.log(`Rapier step cost per ${FRAME_HZ} Hz frame (${STEPS_PER_FRAME} steps of ${STEP.toFixed(5)} s), ${BOX_COUNT} boxes; median over the frames of each window, ${COST_ATTEMPTS} attempts:`);
    const best: number[] = [];
    for (let window = 0; window < attempts[0]!.length; window++) {
      const name = attempts[0]![window]!.name;
      const budgetMs = attempts[0]![window]!.budgetMs;
      const addedPerAttempt = attempts.map((windows) => addedMedian(windows[window]!.costs));
      const last = attempts[attempts.length - 1]![window]!.costs;
      console.log(
        `  ${name}: ${last.withPile.length} frames, median ${median(last.withPile).toFixed(3)} ms with / ${median(last.without).toFixed(3)} ms without, 95th percentile ${percentile95(last.withPile).toFixed(3)} / ${percentile95(last.without).toFixed(3)} ms, most boxes awake ${Math.max(...last.awakeBoxes)}; added per attempt ${addedPerAttempt.map((added) => added.toFixed(3)).join(", ")} ms (budget ${budgetMs} ms)`,
      );
      best.push(Math.min(...addedPerAttempt));
    }
    for (let window = 0; window < best.length; window++) {
      const { name, budgetMs } = attempts[0]![window]!;
      assert.ok(best[window]! < budgetMs, `${name}: the pile added ${best[window]!.toFixed(3)} ms a frame at best, over its ${budgetMs} ms budget`);
    }
    assert.ok(attempts[0]![1]!.costs.withPile.length > FRAME_HZ / 2, "the settling window has frames to measure");
  });
});
