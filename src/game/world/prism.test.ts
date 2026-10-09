import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { armSolids, C_DEPTH, C_H, C_NX, C_NY, C_NZ, HIT_SIZE, KNOCK, MOUNT, pointContact, PQ_SIZE, PQ_VX, PQ_VZ, PQ_X, PQ_Y, PQ_Z, STEP_MAX, Surface, WALL } from "./surfaces.ts";
import { CLASSES } from "../vehicle/vehicle-classes.ts";
import { TYRE_R } from "../deform/deform-state.ts";
import { ENTRY_WINDOW, SOLID_AT_REST } from "./constants.ts";

/** A surface of the given prisms, armed as the scene's solids for the test that asks. */
function solids(...specs: Parameters<Surface["addPrism"]>[0][]): Surface {
  const s = new Surface();
  for (const spec of specs) s.addPrism(spec);
  armSolids(s);
  return s;
}

const q = new Float64Array(PQ_SIZE);
const out = new Float64Array(HIT_SIZE);

function ask(x: number, y: number, z: number, vx = 0, vz = 0): Float64Array {
  q[PQ_X] = x;
  q[PQ_Y] = y;
  q[PQ_Z] = z;
  q[PQ_VX] = vx;
  q[PQ_VZ] = vz;
  pointContact(q, -1, out);
  return out;
}

/** A 2 m (across) by 4 m (along) box, 1 m tall, its middle at the origin, facing +z. */
const BOX = { x: 0, z: 0, yaw: 0, hx: 1, hz: 2, base: 0, top: 1, id: 0 } as const;

describe("given a box prism in the scene's solids", () => {
  it("when a point is above its top then it answers the top's height as a floor with a gap under it", () => {
    solids(BOX);
    const hit = ask(0.2, 1.05, 0.3);
    assert.equal(hit[C_H], 1);
    assert.equal(hit[C_NY], 1);
    assert.ok(Math.abs(hit[C_DEPTH]! + 0.05) < 1e-12, `gap ${hit[C_DEPTH]}`);
    armSolids(null);
  });

  it("when a point is in it deeper than a tyre mounts then it answers a side: no floor, a level normal and the way out", () => {
    solids(BOX);
    const hit = ask(0.9, 0.5, 0, 0, 0);
    assert.equal(hit[C_H], -Infinity);
    assert.equal(hit[C_NY], 0);
    assert.ok(Math.abs(hit[C_DEPTH]! - 0.1) < 1e-12, `depth ${hit[C_DEPTH]}`);
    assert.ok(Math.abs(hit[C_NX]! - 1) < 1e-12 && Math.abs(hit[C_NZ]!) < 1e-12, `normal ${hit[C_NX]} ${hit[C_NZ]}`);
    armSolids(null);
  });

  it("when a point is in it no deeper than the step a tyre mounts then it stands on the top: the same box is a kerb for a tyre and a wall for a hull point", () => {
    solids(BOX);
    const kerb = ask(0.9, 1 - STEP_MAX * 0.9, 0);
    assert.equal(kerb[C_H], 1);
    const wall = ask(0.9, 1 - STEP_MAX * 1.1, 0);
    assert.equal(wall[C_H], -Infinity);
    armSolids(null);
  });

  it("when a point under its base is asked then the prism is no floor and no wall: a body passes beneath", () => {
    solids({ ...BOX, base: 3, top: 4 });
    const hit = ask(0, 1, 0);
    assert.equal(hit[C_H], 0, "the ground answers, as if the prism were not there");
    assert.equal(hit[C_NY], 1);
    armSolids(null);
  });

  it("when a point near a corner is closing on the near flank then it leaves through the flank it came in by, not the end that is nearer", () => {
    solids(BOX);
    // 0.3 m in from the +x flank and 0.05 m in from the +z end: nearest exit is the end, but it is moving in along -x, fast enough
    // to have crossed the flank within the step (`ENTRY_WINDOW`) it is asked in.
    const arrived = ask(0.7, 0.5, 1.95, -(0.3 / ENTRY_WINDOW) * 2, 0);
    assert.ok(Math.abs(arrived[C_NX]! - 1) < 1e-12, `normal ${arrived[C_NX]} ${arrived[C_NZ]}`);
    assert.ok(Math.abs(arrived[C_DEPTH]! - 0.3) < 1e-12, `depth ${arrived[C_DEPTH]}`);
    const resting = ask(0.7, 0.5, 1.95, 0, 0);
    assert.ok(Math.abs(resting[C_NZ]! - 1) < 1e-12, `at rest it leaves by the nearest: ${resting[C_NX]} ${resting[C_NZ]}`);
    armSolids(null);
  });

  it("when a point is deeper than its speed could have taken it in one step then it leaves through the nearest face, whatever way it drifts", () => {
    solids(BOX);
    // 0.3 m in from the +x flank, drifting in along -x at half the speed that would cross it within `ENTRY_WINDOW`: it came in earlier.
    const drifting = ask(0.7, 0.5, 1.95, -(0.3 / ENTRY_WINDOW) / 2, 0);
    assert.ok(Math.abs(drifting[C_NZ]! - 1) < 1e-12, `leaves by the nearest: ${drifting[C_NX]} ${drifting[C_NZ]}`);
    assert.ok(Math.abs(drifting[C_DEPTH]! - 0.05) < 1e-12, `depth ${drifting[C_DEPTH]}`);
    armSolids(null);
  });

  it("when a point is moving no faster than the rest speed then it leaves through the nearest face", () => {
    solids(BOX);
    const hit = ask(0.7, 0.5, 1.95, -SOLID_AT_REST * 0.5, 0);
    assert.ok(Math.abs(hit[C_NZ]! - 1) < 1e-12);
    armSolids(null);
  });

  it("when the point is the same distance in however far along the step it started then the face it entered by is the same", () => {
    solids(BOX);
    const faces = new Set<string>();
    for (let k = 0; k < 8; k++) {
      const depth = 0.02 + (k / 8) * 0.23;
      const hit = ask(1 - depth, 0.5, 1.9 - 0.3 * depth, -20, -6);
      faces.add(`${hit[C_NX]!.toFixed(3)} ${hit[C_NZ]!.toFixed(3)}`);
    }
    assert.equal(faces.size, 1, `faces ${[...faces].join(" | ")}`);
    armSolids(null);
  });

  it("when its end is a joint then the end is no face and a point at the end leaves across", () => {
    solids({ ...BOX, ends: 1 });
    const hit = ask(0.5, 0.5, 1.95, 0, 0);
    assert.ok(Math.abs(Math.abs(hit[C_NX]!) - 1) < 1e-12, `normal ${hit[C_NX]} ${hit[C_NZ]}`);
    armSolids(null);
  });

  it("when it is a prop knocked off its spot by a hit then a point query does not meet it", () => {
    solids({ ...BOX, role: KNOCK });
    const hit = ask(0.9, 0.5, 0);
    assert.equal(hit[C_H], 0, "the ground answers");
    assert.equal(hit[C_NY], 1);
    armSolids(null);
  });
});

describe("given a circle prism and a ramp prism", () => {
  it("when a point is inside the circle then it leaves along the radius by the way out", () => {
    solids({ x: 3, z: 0, yaw: 0, hx: 0.5, hz: 0.5, circle: true, base: 0, top: 3, id: 0 });
    const hit = ask(3.3, 1, 0, -1, 0);
    assert.ok(Math.abs(hit[C_DEPTH]! - 0.2) < 1e-12 && Math.abs(hit[C_NX]! - 1) < 1e-12, `depth ${hit[C_DEPTH]} nx ${hit[C_NX]}`);
    armSolids(null);
  });

  it("when the top is tilted then the floor's normal leans away from the high side and its height is the plane's", () => {
    solids({ ...BOX, top: 1, gw: -0.25 });
    const hit = ask(0, 3, 1);
    assert.ok(Math.abs(hit[C_H]! - 0.75) < 1e-12, `height ${hit[C_H]}`);
    assert.ok(hit[C_NZ]! > 0 && Math.abs(hit[C_NZ]! - 0.25 / Math.hypot(0.25, 1)) < 1e-12, `normal ${hit[C_NZ]}`);
    armSolids(null);
  });

  it("when its pose is moved after the seal then the point query follows it", () => {
    const s = new Surface();
    const i = s.addPrism({ ...BOX, moves: true });
    armSolids(s);
    assert.equal(ask(5, 0.5, 0)[C_H], 0, "the prism is not there yet");
    s.movePrism(i, 5.5, 0, 0, 2, 0);
    assert.equal(ask(5, 0.5, 0, 0, 0)[C_H], -Infinity, "it is now");
    armSolids(null);
  });
});

describe("given the step a tyre mounts", () => {
  it("when it is derived from the classes then it is the biggest tyre's share of its radius", () => {
    const biggest = Math.max(...Object.values(CLASSES).map((c) => c.wheelScale));
    assert.ok(Math.abs(STEP_MAX - MOUNT * TYRE_R * biggest) < 1e-9, `${STEP_MAX} against ${MOUNT * TYRE_R * biggest}`);
  });

  it("when prisms are listed near a point then each one is listed once, and the ones far away are not", () => {
    const s = new Surface();
    for (let k = 0; k < 20; k++) s.addPrism({ ...BOX, x: k * 30, id: k, role: WALL });
    s.seal();
    const count = s.prismsNear(60, 0, 5);
    assert.equal(count, 1);
    assert.equal(s.nearList[0], 2);
    assert.equal(s.prismsNear(45, 0, 20), 2);
  });
});
