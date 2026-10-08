import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import type { PropCollider } from "./placements.ts";
import { courseContact, solidGrid, type PropHits } from "../contact/prop-contact.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { bodyPoints } from "../vehicle/body-points.test-util.ts";
import { makeCar } from "../vehicle/ground-probe.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * A course wall is a row of boxes, one per drawn piece, and a car meets two of them at once where it hits a joint. On a bend the
 * pieces' faces tilt toward or away from the car; each piece alone would push the car out along its own axis or let a corner
 * through the gap. The wall below is two 8 m pieces whose road faces meet at a point (the joint), 0.6 m deep behind it.
 */

const FRAME = 1 / 60;
const PIECE = { len: 8, thick: 0.6 };
/** Most (m) any point of the body may end up past the far face of a piece it is beside, and the most it may stand in the wall. */
const PAST = 0.02;
const INSIDE = 0.05;
/** How far (m) past a piece's own end the check still reads it: the gap a bend opens at the joint is beside the piece, not beyond it. */
const END_MARGIN = 0.3;
const NO_HITS: PropHits = { knock: () => {}, fx: () => {}, wall: () => {} };

afterEach(() => setGround(null));

/**
 * The wall as the course builds it: the road on +x of the first piece (yaw 0, heading +z); the second piece turns by `bend` rad
 * (positive: toward the road, a corner pocket seen from the road; negative: away, a bulge toward it).
 */
function bentWall(bend: number): PropCollider[] {
  const half = PIECE.len / 2;
  const hx = PIECE.thick / 2;
  const piece = (index: number, yaw: number, back: number, ends: number): PropCollider => {
    // Centre: the joint, `back` along the piece's own heading, and the half thickness behind the road face (the road is on its +u side).
    const along = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const across = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    return {
      index,
      prefab: null,
      body: "solid",
      x: along.x * back - across.x * hx,
      z: along.z * back - across.z * hx,
      yaw,
      kind: "box",
      r: Math.hypot(hx, half),
      hx,
      hz: half,
      mass: 0,
      base: -0.3,
      top: 1.1,
      ends,
    };
  };
  return [piece(0, 0, -half, 1), piece(1, bend, half, 2)];
}

/** The road-facing normals of the two pieces (+u of each), summed: the way the joint's two faces point together. */
function faceBisector(bend: number): { x: number; z: number } {
  const x = 1 + Math.cos(bend);
  const z = -Math.sin(bend);
  const l = Math.hypot(x, z);
  return { x: x / l, z: z / l };
}

/**
 * How far the body reaches past the far face of a piece it is beside (m), and how deep it stands in one from the face it came at
 * (m). `side`: +1 if the car came at the pieces' +u faces (the road side), −1 at their backs.
 */
function reach(car: DeformableCar, walls: readonly PropCollider[], side: number): { past: number; inside: number } {
  let past = 0;
  let inside = 0;
  for (const c of walls) {
    const cs = Math.cos(c.yaw);
    const sn = Math.sin(c.yaw);
    for (const [x, z] of bodyPoints(car)) {
      const u = (x - c.x) * cs - (z - c.z) * sn;
      const along = (x - c.x) * sn + (z - c.z) * cs;
      if (Math.abs(along) > c.hz + END_MARGIN) continue;
      past = Math.max(past, -side * u - c.hx);
      const depth = c.hx - side * u;
      if (depth > 0 && depth < 2 * c.hx) inside = Math.max(inside, depth);
    }
  }
  return { past, inside };
}

type Row = { it: string; bend: number; fromRoad: boolean; speed: number };

const jointCases: Row[] = [];
for (const [shape, bend] of [["a 30° corner pocket", Math.PI / 6], ["a 15° corner pocket", Math.PI / 12], ["a 15° bulge", -Math.PI / 12], ["a 30° bulge", -Math.PI / 6]] as const) {
  for (const fromRoad of [true, false]) {
    for (const speed of [20, 30]) {
      jointCases.push({ it: `when a sedan coasts into the joint of ${shape} from the ${fromRoad ? "road" : "pavement"} side at ${speed} m/s, then no part of it ends more than ${PAST * 100} cm past the wall's far face and at most ${INSIDE * 100} cm of it is left in the wall`, bend, fromRoad, speed });
    }
  }
}

describe("given a wall of two pieces bending at a joint, and a sedan aimed at the joint along the two faces' common normal", () => {
  for (const testCase of jointCases) {
    it(testCase.it, (t) => {
      const walls = bentWall(testCase.bend);
      const grid = solidGrid(walls, []);
      const knocked = new Uint8Array(0);
      const car = makeCar("sedan");
      const side = testCase.fromRoad ? 1 : -1;
      // The face normal the car comes along, away from the wall on its own side: its nose points the other way.
      const n = faceBisector(testCase.bend);
      const back = 8;
      car.spawnFacing(n.x * side * back, n.z * side * back, Math.atan2(-n.x * side, -n.z * side), testCase.speed);
      const world = newWorld([car]);
      world.fine = 1 / 240;
      let hardest = 0;
      const hits: PropHits = { ...NO_HITS, wall: (_k, _i, closing) => (hardest = Math.max(hardest, closing)) };
      world.collide = (c, i, h) => courseContact(c, i, grid, walls, [], knocked, hits, h);
      let acc = 0;
      let past = 0;
      for (let f = 0; f < 3 / FRAME; f++) {
        acc = Math.min(0.05, acc + FRAME);
        while (acc > 1e-5) {
          const h = Math.fround(physicsSlice(acc, sliceSpeed(world.cars)));
          stepWorld(world, h);
          settleStep(world.cars, h, false);
          acc -= h;
        }
        car.updateSkin();
        past = Math.max(past, reach(car, walls, side).past);
      }
      const { inside } = reach(car, walls, side);
      const note = `hit the wall at ${hardest.toFixed(1)} m/s, ${past.toFixed(3)} m past the far face, ${inside.toFixed(3)} m in the wall, ended at ${(Math.hypot(car.velocity.x, car.velocity.z) * 3.6).toFixed(1)} km/h`;
      t.diagnostic(note);
      assert.ok(hardest > 0.8 * testCase.speed, `the car hit the wall hard (${note})`);
      assert.ok(past <= PAST, note);
      assert.ok(inside <= INSIDE, note);
    });
  }
});
