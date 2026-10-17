import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCar } from "./crash-scenarios.test-util.ts";
import { faceDepth, faceExit, makeBox } from "./external-contact.ts";
import { physicsSlice } from "./sat.ts";
import { zipBound } from "./zip-bound.test-util.ts";
import { stepWorld } from "../engine/world-step.ts";
import { FRAME_HZ, QUIET_HZ } from "../kernel/constants.ts";
import { arenaWorld, leaveArena } from "../scenes/derby-arena.test-util.ts";
import type { PropHits } from "./prop-contact.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/** How far (m) the box's end plane stands inside the car's nose, in the vertex-depth cases. */
const NOSE_IN_END = 0.02;
const SPIN_RAD_S = 5;
const HOLD_S = 4;
/** The head-on hit that leaves a crushed wreck: the bullet's speed (m/s) and the settle it gets (s). */
const BULLET_MPS = 9;
const SETTLE_MAX_S = 12;
const SETTLE_STEP = 1 / QUIET_HZ;

const noseZ = (car: DeformableCar): number => {
  const { pos, panelOn } = car.cage.fields;
  const { vertexCount, vertexGroup } = car.cage.style;
  let nose = -Infinity;
  for (let k = 0; k < vertexCount; k++) {
    const group = vertexGroup[k]!;
    if (group > 0 && panelOn[group - 1] === 0) continue;
    nose = Math.max(nose, pos[k * 3 + 2]!);
  }
  return nose;
};

const vertexCases = [
  { it: "when the solid's end plane is 2 cm inside the nose and its ends are open, then the nose reads the end's 2 cm and leaves round the end", openEnds: true, expectedLeavesByEnd: true },
  { it: "when the same box is a wall's hold face (ends closed), then the nose reads its whole depth through the side face and leaves through it", openEnds: false, expectedLeavesByEnd: false },
] as const;

describe("given a car at rest whose nose stands 2 cm inside the end of a 2 m wide, 1.2 m thick box seen from its -x side", () => {
  for (const testCase of vertexCases) {
    it(testCase.it, () => {
      const car = makeCar("shape");
      launch(car, 0, 0, 0, 0, 0);
      const box = makeBox();
      box.yaw = -Math.PI / 2;
      box.hx = 1;
      box.hz = 0.6;
      box.x = 0.5;
      box.openEnds = testCase.openEnds;
      box.z = noseZ(car) - NOSE_IN_END + box.hx;
      const depth = faceDepth(car, box);
      if (testCase.expectedLeavesByEnd) {
        assert.ok(depth > 0 && depth <= NOSE_IN_END + 1e-9, `depth ${depth.toFixed(3)} m`);
        assert.ok(Math.abs(faceExit.nx) < 1e-9 && Math.abs(faceExit.nz + 1) < 1e-9, `exit (${faceExit.nx.toFixed(2)}, ${faceExit.nz.toFixed(2)})`);
        return;
      }
      assert.ok(depth > 0.5, `depth ${depth.toFixed(3)} m`);
      assert.ok(Math.abs(faceExit.nx + 1) < 1e-9 && Math.abs(faceExit.nz) < 1e-9, `exit (${faceExit.nx.toFixed(2)}, ${faceExit.nz.toFixed(2)})`);
    });
  }
});

describe("given a car at rest straddling a 0.5 m wide, 1.2 m thick open-ended post (a monument's arm, a crash pad) whose face is seen from its -x side", () => {
  it("when the car's centre stands over the post's span, then its flank reads the whole depth through the face and leaves through it, though the post's end is nearer", () => {
    const car = makeCar("shape");
    launch(car, 0, 0, 0, 0, 0);
    const box = makeBox();
    box.yaw = -Math.PI / 2;
    box.hx = 0.25;
    box.hz = 0.6;
    box.x = 0.5;
    box.z = 0;
    box.openEnds = true;
    const depth = faceDepth(car, box);
    assert.ok(depth > 0.5, `depth ${depth.toFixed(3)} m`);
    assert.ok(Math.abs(faceExit.nx + 1) < 1e-9 && Math.abs(faceExit.nz) < 1e-9, `exit (${faceExit.nx.toFixed(2)}, ${faceExit.nz.toFixed(2)})`);
  });
});

/** A crushed wreck: a sedan a head-on bullet hit, settled in the derby arena, its masses then turning rigidly at `SPIN_RAD_S` about their centroid every slice (a wreck steered round, as the derby's drivers hold them). */
function spinningWreckAt(x: number, z: number, vx: number, hits: PropHits) {
  const wreck = makeCar("shape");
  const bullet = makeCar("shape");
  launch(wreck, 0, 0, 0, 0, 0);
  launch(bullet, 0, 9, Math.PI, 0, -BULLET_MPS);
  const { world } = arenaWorld([wreck, bullet], hits);
  for (let t = 0; t < SETTLE_MAX_S && !(t > 2 && wreck.velocity.length() < 0.05); t += SETTLE_STEP) stepWorld(world, SETTLE_STEP);
  // The bullet stays where the hit left it, in the arena's middle, 24+ m from every grind site: moved to x = -40 (outside the ring wall, past the ground grid) it drifted off the grid and its masses' ground read threw.
  const start = dynamicCentroid(wreck);
  wreck.deform.translateMasses(x - start.x, z - start.z, 0, 0);
  wreck.group.position.x += x - start.x;
  wreck.group.position.z += z - start.z;
  wreck.velocity.set(vx, 0, 0);
  world.beforeSlice = () => {
    const centre = dynamicCentroid(wreck);
    let px = 0;
    let pz = 0;
    for (const m of wreck.deform.masses) {
      if (!m.dynamic) continue;
      px += m.vel.x * m.mass;
      pz += m.vel.z * m.mass;
    }
    for (const m of wreck.deform.masses) {
      if (!m.dynamic) continue;
      m.vel.x = px / centre.mass + SPIN_RAD_S * (m.world.z - centre.z);
      m.vel.z = pz / centre.mass - SPIN_RAD_S * (m.world.x - centre.x);
    }
    return false;
  };
  return { wreck, world };
}

function dynamicCentroid(car: DeformableCar): { x: number; z: number; mass: number } {
  let x = 0;
  let z = 0;
  let mass = 0;
  for (const m of car.deform.masses) {
    if (!m.dynamic) continue;
    x += m.world.x * m.mass;
    z += m.world.z * m.mass;
    mass += m.mass;
  }
  return { x: x / mass, z: z / mass, mass };
}

/** Holds the spinning wreck against the solid for `HOLD_S` s and returns the worst step (m over its zip bound; negative: under it everywhere) and how many times the solid was met. */
function holdAgainstSolid(x: number, z: number, vx: number): { worstOverBound: number; solidMeetings: number } {
  let solidMeetings = 0;
  const { wreck, world } = spinningWreckAt(x, z, vx, { knock() {}, fx() {}, wall: () => (solidMeetings += 1) });
  let worstOverBound = -Infinity;
  for (let t = 0; t < HOLD_S; ) {
    const step = physicsSlice(1 / FRAME_HZ, Math.max(8, wreck.speed));
    const before = dynamicCentroid(wreck);
    const speedBefore = Math.hypot(wreck.velocity.x, wreck.velocity.z);
    stepWorld(world, step);
    const after = dynamicCentroid(wreck);
    const speedAfter = Math.hypot(wreck.velocity.x, wreck.velocity.z);
    const bound = zipBound(Math.max(speedBefore, speedAfter), step);
    worstOverBound = Math.max(worstOverBound, Math.hypot(after.x - before.x, after.z - before.z) - bound);
    t += step;
  }
  return { worstOverBound, solidMeetings };
}

/** Wreck starts clear of the solid, the centroid (x, z) with the nose-to-tail turn sweeping the solid's corner, drifting at `vx` m/s. */
const holdCases = [
  { it: "when it grinds the +z end of the east rail (26.5, 0) at 5 rad/s for 4 s, then no step moves it past its zip bound", x: 24.8, z: 2.1, vx: -1.0 },
  { it: "when it grinds the same rail end from a little further south at 5 rad/s for 4 s, then no step moves it past its zip bound", x: 24.5, z: 1.8, vx: -1.0 },
  { it: "when it grinds the +z end of the rail at (21, 5) coming from the east at 5 rad/s for 4 s, then no step moves it past its zip bound", x: 24.5, z: 2.2, vx: -1.0 },
  { it: "when it grinds the ring wall (inner face 38 m out) at 5 rad/s for 4 s, then no step moves it past its zip bound", x: -34.0, z: 10.0, vx: -0.5 },
  { it: "when it grinds the ring wall further round at 5 rad/s for 4 s, then no step moves it past its zip bound", x: -35.0, z: 5.0, vx: -0.3 },
] as const;

describe("given a crushed sedan wreck turning at 5 rad/s in the derby arena", () => {
  afterEach(leaveArena);
  for (const testCase of holdCases) {
    it(testCase.it, () => {
      const { worstOverBound, solidMeetings } = holdAgainstSolid(testCase.x, testCase.z, testCase.vx);
      assert.ok(solidMeetings > 0, "the wreck never met the solid: nothing was held");
      assert.ok(worstOverBound <= 0, `the worst step moved the wreck ${(worstOverBound * 1000).toFixed(1)} mm past its zip bound (${solidMeetings} meetings)`);
    });
  }
});
