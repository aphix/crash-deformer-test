import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { HIGH_JUMP_MEASURED, MINIGAME_MODE, STATION_ANCHORS, STATION_HALF_WIDTH } from "../scenes/minigame-constants.ts";
import { BOX_CELL_PITCH, BOX_COUNT, highJumpLayout } from "../scenes/minigame-high-jump.ts";
import { MinigameGround } from "../scenes/minigame-ground.ts";
import { lipHeight } from "../scenes/minigame-profile.ts";
import { setGround } from "../world/ground.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { NET_HALF_WIDTH } from "./high-jump-art.ts";
import { BOX_POSE_FLOATS, type BoxPlacement } from "./ragdoll-boxes.ts";
import { STEP } from "./ragdoll-config.ts";

const FRAME = 1 / FRAME_HZ;
const STEPS_PER_FRAME = Math.round(FRAME / STEP);
const UP = new THREE.Vector3(0, 1, 0);

/** The shipped pile: the High jump's real layout (station-local), moved to the station's place in the world as the engine does, on the real ground. */
const layout = highJumpLayout(HIGH_JUMP_MEASURED, lipHeight(MINIGAME_MODE.highJump));
const anchor = STATION_ANCHORS.highJump;
const PLACEMENTS: readonly BoxPlacement[] = layout.boxes.map((box) => ({ ...box, x: box.x + anchor.x, z: box.z + anchor.z }));
const ground = new MinigameGround({ highJump: { netX: layout.netX, netHalfWidth: NET_HALF_WIDTH, netHeight: layout.netHeight } });

/** A stack: where its top box stands (world), its top (m above the pad) and how many boxes it holds. */
type Stack = { x: number; z: number; top: number; boxCount: number };

/** The pile's stacks, tallest first: a base box is one that sits on the pad, its stack every box within half a cell of it. */
function stacksTallestFirst(): Stack[] {
  const baseTolerance = 1e-6;
  const bases = PLACEMENTS.filter((box) => box.y - box.height / 2 < baseTolerance);
  const stacks = bases.map((base) => {
    const members = PLACEMENTS.filter((box) => Math.hypot(box.x - base.x, box.z - base.z) < BOX_CELL_PITCH / 2);
    const highest = members.reduce((best, box) => (box.y + box.height / 2 > best.y + best.height / 2 ? box : best));
    return { x: highest.x, z: highest.z, top: highest.y + highest.height / 2, boxCount: members.length };
  });
  return stacks.sort((first, second) => second.top - first.top);
}
const STACKS = stacksTallestFirst();
const PILE_TOP = STACKS[0]!.top;
const PILE_MIN_X = Math.min(...PLACEMENTS.map((box) => box.x)) - BOX_CELL_PITCH / 2;
const PILE_MAX_X = Math.max(...PLACEMENTS.map((box) => box.x)) + BOX_CELL_PITCH / 2;
const PILE_MIN_Z = Math.min(...PLACEMENTS.map((box) => box.z)) - BOX_CELL_PITCH / 2;
const PILE_MAX_Z = Math.max(...PLACEMENTS.map((box) => box.z)) + BOX_CELL_PITCH / 2;

/** A ragdoll system on the real High jump ground as the range runs it (sand on), its dummies held lying where they land. */
async function system(boxes: readonly BoxPlacement[]): Promise<RagdollSystem> {
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  sys.sand = true;
  await sys.preload();
  setGround(ground);
  sys.update(FRAME, [], true, false, null);
  sys.holdThrown();
  sys.setBoxes(boxes);
  return sys;
}

function spawnDummy(sys: RagdollSystem, at: THREE.Vector3, velocity: THREE.Vector3): void {
  const lie = velocity.lengthSq() > 0 ? velocity.clone().normalize() : UP;
  sys["spawn"]({ car: 0, p: at, q: new THREE.Quaternion().setFromUnitVectors(UP, lie), v: velocity, w: new THREE.Vector3(), age: 0, cop: false, rides: true });
}

/** Where a dummy thrown straight up at `FAR_THROW_SPEED` keeps the world stepping from (world): on the flat between the High jump and Ring Fling stations, clear of both. */
const FAR_SPOT = new THREE.Vector3(anchor.x + 20, 1.5, anchor.z + 60);
/** 70 m/s up is 14.6 s of flight: longer than any window below that needs the world stepping without a box being touched. */
const FAR_THROW_SPEED = 70;

/** A dummy flying far from the pile: keeps the world stepping, touching no box. */
function flyFarAway(sys: RagdollSystem): void {
  spawnDummy(sys, FAR_SPOT.clone(), new THREE.Vector3(0, FAR_THROW_SPEED, 0));
}

/** A best run's horizontal speed at the posts (m/s): the sizing table's forward 3.9 m/s. */
const FORWARD_SPEED = 3.9;
/** How far over a stack's top he starts (m): the fall to it only adds gravity's 6 m. */
const START_OVER_TOP = 6;

/** A dummy dropped on `stack`'s top box, head first, at `speed` m/s down and `FORWARD_SPEED` along the throw, as a best run lands. */
function dropOnStack(sys: RagdollSystem, stack: Stack, speed: number): void {
  const flight = START_OVER_TOP / speed;
  spawnDummy(sys, new THREE.Vector3(stack.x - FORWARD_SPEED * flight, stack.top + START_OVER_TOP, stack.z), new THREE.Vector3(FORWARD_SPEED, -speed, 0));
}

const dummyOf = (sys: RagdollSystem) => sys["dolls"][0]!;
const boxBodiesOf = (sys: RagdollSystem) => sys["boxes"]["bodies"];

const _local = new THREE.Vector3();
const _turn = new THREE.Quaternion();
/** How deep (m, positive; 0 outside it) `point` is inside box `index` of the pile, whose pose is in `poses` (`copyBoxPoses`). */
function depthInside(poses: Float32Array, index: number, point: { x: number; y: number; z: number }): number {
  const o = index * BOX_POSE_FLOATS;
  const box = PLACEMENTS[index]!;
  _turn.set(poses[o + 3]!, poses[o + 4]!, poses[o + 5]!, poses[o + 6]!).invert();
  _local.set(point.x - poses[o]!, point.y - poses[o + 1]!, point.z - poses[o + 2]!).applyQuaternion(_turn);
  const clearance = Math.max(Math.abs(_local.x) - box.width / 2, Math.abs(_local.y) - box.height / 2, Math.abs(_local.z) - box.depth / 2);
  return Math.max(0, -clearance);
}

type Settle = { stillSeconds: number; simSeconds: number; deepestInside: number; lowestPart: number; farthestBoxMove: number; torso: THREE.Vector3 };

/** Run frames until the torso has lain still `stillWanted` s (or `limit` sim s), tracking how deep any part went into any box and how low any part went. */
function runUntilStill(sys: RagdollSystem, stillWanted: number, limit: number): Settle {
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
      for (let i = 0; i < BOX_COUNT; i++) deepestInside = Math.max(deepestInside, depthInside(poses, i, centre));
    }
  }
  return { stillSeconds, simSeconds: frames * FRAME, deepestInside, lowestPart, farthestBoxMove: currentMove(sys), torso };
}

/** The farthest any box (as `copyBoxPoses` reports it) is from its placement (m). */
function currentMove(sys: RagdollSystem): number {
  const poses = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
  sys.copyBoxPoses(poses);
  let farthest = 0;
  for (let i = 0; i < BOX_COUNT; i++) {
    const o = i * BOX_POSE_FLOATS;
    const placement = PLACEMENTS[i]!;
    farthest = Math.max(farthest, Math.hypot(poses[o]! - placement.x, poses[o + 1]! - placement.y, poses[o + 2]! - placement.z));
  }
  return farthest;
}

const allAsleep = (sys: RagdollSystem) => boxBodiesOf(sys).every((body) => body.isSleeping());

/** Most a box may drift from where it was put while nothing touches it (m). */
const DRIFT_MAX = 0.05;
/** Lowest a part centre may be (m): under the pad by at most this much, as a 60 m/s landing on the pad itself sinks (measured 0.042 m at worst; the repo's other dummy-on-ground rows allow 0.05). */
const PAD_SOAK = 0.05;
/** A box lying on a face rests with its centre half an edge up; this much lower (m) is a box sunk into the pad. */
const BOX_SETTLE_SOAK = 0.02;
/** Sim seconds the torso must have lain under 0.4 m/s (`latest()`), and the sim time allowed to get there. */
const REST_HOLD = 1;
const REST_WITHIN = 20;
/** A box he hits moves at least this far (m). */
const BOX_HIT_MOVE = 0.1;
/** A restacked box is this near its placement (m). */
const RESTACK_TOLERANCE = 0.01;
/** A lying dummy's length (m): his torso may rest this far past the station's band, and counts as perched when it lies within this of a stack's top. */
const LYING_LENGTH = 2;
/** The drop that scatters boxes in the rows that need scattered boxes: the 4th tallest stack at the fastest landing (his shot there moves boxes 6 m; the tallest's at 60 m/s leaves him lying on top). */
const SCATTER_STACK = STACKS[3]!;
const SCATTER_SPEED = 60;
/** The drops that must show a moved box, and a rest near the pile (of 15; measured 14 and 13). */
const MOST_DROPS = 12;
/** Frames after a shot while the boxes still tumble (0.5 s). */
const HIT_FRAMES = FRAME_HZ / 2;
/** Impact speeds (m/s): where the sizing table's best runs come down on the pile. */
const IMPACT_SPEEDS = [40, 50, 60] as const;

describe("given the High jump's real pile of 48 cardboard boxes standing asleep on the real ground", () => {
  it("when the layout is read, then it holds 48 boxes in 3-high stacks of 1.6-2.6 m boxes at the station", () => {
    assert.equal(PLACEMENTS.length, BOX_COUNT, "box count");
    assert.equal(STACKS[0]!.boxCount, 3, "the tallest stack is 3 boxes high");
    assert.ok(PILE_TOP > 5, `the tallest stack's top is ${PILE_TOP.toFixed(2)} m`);
    assert.ok(PLACEMENTS.every((box) => box.z > anchor.z - 6 && box.z < anchor.z + 6), "the boxes stand in the lane at the station's z");
  });

  it("when nothing touches it while the world steps for 10 s, then no box drifts 5 cm and every box is still asleep", async () => {
    const sys = await system(PLACEMENTS);
    flyFarAway(sys);
    const stepsBefore = sys.stats.steps;
    for (let frame = 0; frame < 10 * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const stepped = sys.stats.steps - stepsBefore;
    const drift = currentMove(sys);
    const asleep = allAsleep(sys);
    sys.dispose();
    assert.ok(stepped >= 10 * STEPS_PER_FRAME * FRAME_HZ - STEPS_PER_FRAME, `the world stepped ${stepped} times: a dummy was flying`);
    assert.ok(drift < DRIFT_MAX, `a box drifted ${drift.toFixed(3)} m`);
    assert.ok(asleep, "every box is asleep");
  });

  it("when every box is woken and left untouched for 10 s, then the 3-high stacks hold: no box ends 5 cm from where it stood", async () => {
    const sys = await system(PLACEMENTS);
    flyFarAway(sys);
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

type Shot = Settle & { stack: Stack; speed: number; perched: boolean; outsidePile: number };

/** How far (m) the point (x, z) is from the pile's cells, 0 over them. */
function distanceOutsidePile(x: number, z: number): number {
  return Math.hypot(Math.max(PILE_MIN_X - x, 0, x - PILE_MAX_X), Math.max(PILE_MIN_Z - z, 0, z - PILE_MAX_Z));
}

/** The drops, each run once however many rows read it: a held dummy dropped on stack `rank` (0: the tallest) at `speed` m/s, run until he lies still. */
const shots = new Map<string, Promise<Shot>>();
function shotOf(rank: number, speed: number): Promise<Shot> {
  const key = `${rank}@${speed}`;
  const known = shots.get(key);
  if (known) return known;
  const shot = (async () => {
    const stack = STACKS[rank]!;
    const sys = await system(PLACEMENTS);
    dropOnStack(sys, stack, speed);
    const settle = runUntilStill(sys, REST_HOLD, REST_WITHIN);
    sys.dispose();
    return { ...settle, stack, speed, perched: settle.torso.y > stack.top - LYING_LENGTH, outsidePile: distanceOutsidePile(settle.torso.x, settle.torso.z) };
  })();
  shots.set(key, shot);
  return shot;
}

const RANKS = [0, 1, 2, 3, 4] as const;
const hitCases = RANKS.flatMap((rank) => IMPACT_SPEEDS.map((speed) => ({ it: `when he is dropped on stack ${rank + 1} of the 5 tallest at ${speed} m/s, then he lies still in the landing field, no part tunnels a box or sinks under the pad, and the boxes move or he lies on the stack`, rank, speed })));

describe("given a held dummy dropped on the pile's five tallest stacks, 3 boxes high, at the best runs' landing speeds", () => {
  for (const testCase of hitCases) {
    it(testCase.it, async () => {
      const shot = await shotOf(testCase.rank, testCase.speed);
      console.log(
        `boxes ${shot.speed} m/s on the stack topping ${shot.stack.top.toFixed(1)} m at (${shot.stack.x.toFixed(1)}, ${(shot.stack.z - anchor.z).toFixed(1)}): still ${shot.stillSeconds.toFixed(2)} s after ${shot.simSeconds.toFixed(2)} s, torso (${shot.torso.x.toFixed(1)}, ${shot.torso.y.toFixed(2)}, ${(shot.torso.z - anchor.z).toFixed(1)}) ${shot.outsidePile.toFixed(1)} m outside the pile${shot.perched ? ", on the stack" : ""}, deepest part in a box ${shot.deepestInside.toFixed(3)} m, lowest part ${shot.lowestPart.toFixed(3)} m, farthest box ${shot.farthestBoxMove.toFixed(2)} m`,
      );
      const stepTravel = shot.speed * STEP;
      const inLandingField = shot.torso.x > anchor.x && shot.torso.x < anchor.x + layout.netX && Math.abs(shot.torso.z - anchor.z) < STATION_HALF_WIDTH + LYING_LENGTH;
      assert.ok(shot.stillSeconds >= REST_HOLD, `his still-time reached ${shot.stillSeconds.toFixed(2)} s in ${shot.simSeconds.toFixed(1)} s sim`);
      assert.ok(shot.deepestInside < stepTravel, `a part went ${shot.deepestInside.toFixed(3)} m into a box: more than a step's ${stepTravel.toFixed(3)} m travel is a tunnel`);
      assert.ok(shot.lowestPart > -PAD_SOAK, `a part went down to ${shot.lowestPart.toFixed(3)} m: under the pad`);
      assert.ok(shot.perched || shot.farthestBoxMove > BOX_HIT_MOVE, `no box moved (the farthest went ${shot.farthestBoxMove.toFixed(3)} m) and he is not on the stack (torso ${shot.torso.y.toFixed(2)} m up, top ${shot.stack.top.toFixed(2)} m)`);
      assert.ok(inLandingField, `his torso lies at (${(shot.torso.x - anchor.x).toFixed(1)}, ${(shot.torso.z - anchor.z).toFixed(1)}) in the station's frame: outside the landing field`);
    });
  }

  it("when the 15 drops are read together, then the boxes moved in at least 12 of them and he rested within 2 m of the pile in at least 12", async () => {
    const all = await Promise.all(RANKS.flatMap((rank) => IMPACT_SPEEDS.map((speed) => shotOf(rank, speed))));
    const moved = all.filter((shot) => shot.farthestBoxMove > BOX_HIT_MOVE).length;
    const nearPile = all.filter((shot) => shot.outsidePile <= LYING_LENGTH).length;
    console.log(`boxes: ${all.length} drops, boxes moved in ${moved}, he lay within ${LYING_LENGTH} m of the pile in ${nearPile}, on a stack in ${all.filter((shot) => shot.perched).length}`);
    assert.equal(all.length, RANKS.length * IMPACT_SPEEDS.length, "every drop ran");
    assert.ok(moved >= MOST_DROPS, `the boxes moved in only ${moved} of ${all.length} drops`);
    assert.ok(nearPile >= MOST_DROPS, `he lay within ${LYING_LENGTH} m of the pile in only ${nearPile} of ${all.length} drops`);
  });
});

describe("given boxes a dummy has scattered", () => {
  it("when restackBoxes() is called, then every box is within 1 cm of its placement and asleep, and a second dummy scatters them again", async () => {
    const sys = await system(PLACEMENTS);
    dropOnStack(sys, SCATTER_STACK, SCATTER_SPEED);
    const first = runUntilStill(sys, REST_HOLD, REST_WITHIN);
    sys.releaseThrown();
    sys.restackBoxes();
    let farthest = 0;
    for (let i = 0; i < PLACEMENTS.length; i++) {
      const at = boxBodiesOf(sys)[i]!.translation();
      const placement = PLACEMENTS[i]!;
      farthest = Math.max(farthest, Math.hypot(at.x - placement.x, at.y - placement.y, at.z - placement.z));
    }
    const asleep = allAsleep(sys);
    const poseMove = currentMove(sys);
    sys.holdThrown();
    dropOnStack(sys, SCATTER_STACK, SCATTER_SPEED);
    const second = runUntilStill(sys, REST_HOLD, REST_WITHIN);
    sys.dispose();
    assert.ok(first.farthestBoxMove > BOX_HIT_MOVE, `the first dummy scattered them ${first.farthestBoxMove.toFixed(2)} m`);
    assert.ok(farthest < RESTACK_TOLERANCE, `a box is ${farthest.toFixed(4)} m from its place`);
    assert.ok(poseMove < RESTACK_TOLERANCE, `copyBoxPoses has a box ${poseMove.toFixed(4)} m from its place`);
    assert.ok(asleep, "every box is asleep");
    assert.ok(second.farthestBoxMove > BOX_HIT_MOVE, `the second dummy moved a restacked box ${second.farthestBoxMove.toFixed(3)} m: it never woke`);
  });

  it("when the dummy is released while the boxes still tumble, then the world keeps stepping until they lie asleep above the pad", async () => {
    const sys = await system(PLACEMENTS);
    dropOnStack(sys, SCATTER_STACK, SCATTER_SPEED);
    for (let frame = 0; frame < HIT_FRAMES; frame++) sys.update(FRAME, [], true, false, null);
    const awakeAtRelease = boxBodiesOf(sys).filter((body) => !body.isSleeping()).length;
    sys.releaseThrown();
    for (let frame = 0; frame < 20 * FRAME_HZ; frame++) sys.update(FRAME, [], true, false, null);
    const lowest = Math.min(...boxBodiesOf(sys).map((body, i) => body.translation().y - Math.min(PLACEMENTS[i]!.width, PLACEMENTS[i]!.height, PLACEMENTS[i]!.depth) / 2));
    const asleep = allAsleep(sys);
    const poolAsleep = sys["boxes"].asleep();
    sys.dispose();
    assert.ok(awakeAtRelease > 0, "boxes were still moving when he went");
    assert.ok(asleep && poolAsleep, "every box ended asleep");
    assert.ok(lowest > -BOX_SETTLE_SOAK, `a box ended with its lowest face ${lowest.toFixed(3)} m: under the pad`);
  });

  it("when the dummy falls asleep while boxes he hit still move, then the world steps on until the pile lies asleep", async () => {
    const sys = await system(PLACEMENTS);
    dropOnStack(sys, SCATTER_STACK, SCATTER_SPEED);
    let awakeWhenDummySlept = -1;
    for (let frame = 0; frame < 20 * FRAME_HZ; frame++) {
      sys.update(FRAME, [], true, false, null);
      if (awakeWhenDummySlept < 0 && dummyOf(sys).bodies[0]!.isSleeping()) awakeWhenDummySlept = boxBodiesOf(sys).filter((body) => !body.isSleeping()).length;
    }
    const asleep = allAsleep(sys);
    sys.dispose();
    assert.ok(awakeWhenDummySlept >= 0, "he fell asleep");
    assert.ok(asleep, "every box ended asleep");
  });
});

describe("given the boxes a ragdoll system draws from and the bodies it holds", () => {
  it("when 48 boxes are set before and after Rapier is in, then none exist before and every one after, in placement order with the pose layout position xyz, rotation xyzw", async () => {
    const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    sys.setBoxes(PLACEMENTS);
    const out = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
    const before = sys.copyBoxPoses(out);
    await sys.preload();
    const bodiesBefore = sys.stats.bodies;
    const after = sys.copyBoxPoses(out);
    const farthest = Math.max(...PLACEMENTS.map((placement, i) => Math.hypot(out[i * 7]! - placement.x, out[i * 7 + 1]! - placement.y, out[i * 7 + 2]! - placement.z)));
    const turnError = Math.max(...PLACEMENTS.map((placement, i) => Math.hypot(out[i * 7 + 3]!, out[i * 7 + 4]! - Math.sin(placement.yaw / 2), out[i * 7 + 5]!, out[i * 7 + 6]! - Math.cos(placement.yaw / 2))));
    assert.throws(() => sys.copyBoxPoses(new Float32Array(BOX_POSE_FLOATS * (BOX_COUNT - 1))), RangeError, "a buffer one box short is refused");
    sys.setBoxes(PLACEMENTS.slice(0, 3));
    const replaced = sys.copyBoxPoses(out);
    const bodiesReplaced = sys.stats.bodies;
    sys.clearBoxes();
    const cleared = sys.copyBoxPoses(out);
    const bodiesCleared = sys.stats.bodies;
    sys.dispose();
    assert.equal(before, 0, "no boxes before Rapier");
    assert.equal(after, BOX_COUNT, "every box once Rapier is in");
    assert.ok(farthest < 1e-4, `a pose is ${farthest} m from its placement`);
    assert.ok(turnError < 1e-5, `a rotation is ${turnError} off the yaw's quaternion`);
    assert.equal(replaced, 3, "setBoxes replaces the pile");
    assert.equal(bodiesBefore - bodiesReplaced, BOX_COUNT - 3, "the replaced boxes' bodies are removed from the world");
    assert.equal(cleared, 0, "clearBoxes leaves none");
    assert.equal(bodiesBefore - bodiesCleared, BOX_COUNT, "every box's body is removed from the world");
  });

  it("when a dummy has scattered them, then copyBoxPoses reads where the bodies are", async () => {
    const sys = await system(PLACEMENTS);
    dropOnStack(sys, SCATTER_STACK, SCATTER_SPEED);
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

/** The same 70 m/s upward throw far away in a world with the pile and one without: the pile asleep, then every box woken and left to settle. */
async function measureFlightWindows(): Promise<CostWindow[]> {
  const withPile = await system(PLACEMENTS);
  const without = await system([]);
  flyFarAway(withPile);
  flyFarAway(without);
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

/** The same 60 m/s drop on the tallest stack in a world with the pile and one without (he lands on the pad there): every frame until the pile lies asleep again. */
async function measureHitWindow(): Promise<CostWindow> {
  const withPile = await system(PLACEMENTS);
  const without = await system([]);
  for (const sys of [withPile, without]) dropOnStack(sys, SCATTER_STACK, SCATTER_SPEED);
  const hit = newCosts();
  for (let frame = 0; frame < HIT_WINDOW_FRAMES; frame++) {
    pairedFrame(withPile, without, frame, hit);
    if (frame > FRAME_HZ && withPile["boxes"]["awake"] === 0) break;
  }
  withPile.dispose();
  without.dispose();
  return { name: "dummy dropped through the pile", budgetMs: AWAKE_BUDGET_MS, costs: hit };
}

/** Frames measured (well inside the 14 s flight of a 70 m/s throw), frames discarded first (JIT, the first steps), and the longest hit window (frames). */
const COST_FRAMES = 240;
const COST_WARMUP_FRAMES = 60;
const HIT_WINDOW_FRAMES = 10 * FRAME_HZ;
/** Added Rapier step cost per render frame (ms): the budget for 48 boxes, on the machine that measured it. */
const ASLEEP_BUDGET_MS = 0.5;
const AWAKE_BUDGET_MS = 3;
/** Independent measurements of each window; the lowest added cost counts (a noisy machine only ever adds to a timing). */
const COST_ATTEMPTS = 3;

describe("given the real pile of 48 boxes in the dummies' world and a dummy flying far from it or dropped through it", () => {
  it("when the render frame's 8 steps run with the pile asleep, with every box awake and with a dummy dropped through it, then each adds less than its budget over the same world without boxes", async () => {
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
