import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { SEAT_SPEED } from "./deform-contact.ts";
import { dummyGeom, mass } from "../vehicle/test-support.ts";
import { stepWreck, type WreckRig } from "./physics-util.test-util.ts";
import { FINE_HZ } from "../kernel/constants.ts";
import { Ground, setGround } from "../world/ground.ts";

/**
 * A wreck seats on its cell (`followGroup`: the body follows what the cell drifts off its seat, no faster than SEAT_SPEED), along the
 * body's own x and z. For a wreck lying on its side (or standing on its nose) a body axis IS the world vertical, so a seat step built in
 * the body frame moved the wreck up or down against the ground: derby seed 8's c2 went from +0.9 to -4.4 m (3-5 mm a step, the
 * velocity at 0, the contact re-making the offset every step) while its prop contact kept the wreck live.
 */
const STEP = 1 / FINE_HZ;
const SECONDS = 1;
const SIDE = Math.PI / 2;
/** A wreck's tilt (rad) off lying flat on its roof: 16°, upY -0.96, what the derby's sunk wreck lay at. */
const TILT = 0.28;

/** A wreck lying at `roll` (about the body's z) and `pitch` (about its x), `y` m up, over a ground with a prism beside it. */
function wreckAt(roll: number, pitch: number): WreckRig {
  const d = new StreamedDeformation(dummyGeom());
  d.mode = "shape";
  const group = new THREE.Group();
  group.rotation.set(pitch, 0, roll, "YXZ");
  group.position.y = 0.9;
  group.updateMatrixWorld();
  const vel = new THREE.Vector3();
  const omega = new THREE.Vector3();
  d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 0, 0, group, vel, omega);
  return { d, group, vel, omega };
}

/** The wreck held live against a prism for SECONDS of sim time at the fixed step: each step its cell stands `dx`, `dz` (body frame, m) off its seat. */
function hold(s: WreckRig, dx: number, dz: number): THREE.Vector3 {
  const cell = mass(s.d, "cell");
  const start = s.group.position.clone();
  for (let i = 0; i < SECONDS * FINE_HZ; i++) {
    stepWreck(s, STEP, () => {
      s.d.notifyContact();
      cell.world.set(cell.rest.x + dx, cell.rest.y, cell.rest.z + dz).applyMatrix4(s.group.matrixWorld);
    });
  }
  assert.ok(s.d.quietTime() < STEP * 2, `quiet ${s.d.quietTime().toFixed(3)} s: the wreck is no longer in contact`);
  return s.group.position.clone().sub(start);
}

class Prism extends Ground {
  constructor() {
    super();
    this.addPrism({ x: 5, z: 0, yaw: 0, hx: 1, hz: 1, base: 0, top: 3, id: 0 });
  }
}

describe("given a wreck held against a prism with its cell 1-6 cm off its seat for one second of fixed steps", () => {
  afterEach(() => setGround(null));

  // 1 µm over the second: nothing but the seat moves this body (no gravity, velocity 0), so the fixed wreck's drift is float noise only,
  // measured under 1 nm (the limit run at 1e-9 passed every row); the unfixed step moved it 0.6-1.0 m (4.2 mm a step).
  const DRIFT_LIMIT = 1e-6;
  const sideCases = [
    { name: "rolled onto one side (+90°), cell 1 cm off along body x", roll: SIDE, pitch: 0, dx: -0.01, dz: 0 },
    { name: "rolled onto one side (+90°), cell 6 cm off along body x", roll: SIDE, pitch: 0, dx: -0.06, dz: 0 },
    { name: "rolled onto the other side (-90°), cell 3 cm off along body x", roll: -SIDE, pitch: 0, dx: -0.03, dz: 0 },
    { name: "on its roof, cell 3 cm off along body x", roll: Math.PI, pitch: 0, dx: -0.03, dz: 0 },
    { name: "standing on its nose, cell 3 cm off along body z", roll: 0, pitch: SIDE, dx: 0, dz: -0.03 },
    { name: "standing on its tail, cell 3 cm off along body z", roll: 0, pitch: -SIDE, dx: 0, dz: -0.03 },
    // A wreck not quite flat on its roof: the plane the seat steps in is tilted 16°, so the step has a world-vertical part of sin 16° of SEAT_SPEED = 0.28 m/s, either way. Its tyres hold nothing up and the rigid step lifts a resting wreck out of the floor by at most REST_SPEED = 0.16 m/s, so a roof-down wreck held against a wall with its cell off its seat sank 8 cm/s into the arena's floor (derby seed 6 c9, 0.5 m under at 63 s, 4 m at 113 s).
    { name: "on its roof 16° short of flat, cell 3 cm off along body x", roll: Math.PI - TILT, pitch: 0, dx: -0.03, dz: 0 },
    { name: "on its roof 16° short of flat, cell 3 cm off the other way along body x", roll: Math.PI - TILT, pitch: 0, dx: 0.03, dz: 0 },
    { name: "on its roof 16° short of flat the other way, cell 3 cm off along body x", roll: Math.PI + TILT, pitch: 0, dx: -0.03, dz: 0 },
    { name: "on its roof 16° nose short of flat, cell 3 cm off along body z", roll: Math.PI, pitch: TILT, dx: 0, dz: -0.03 },
  ];
  for (const c of sideCases) {
    it(`when it is ${c.name}, then its height drifts under 1 µm over the second`, () => {
      setGround(new Prism());
      const moved = hold(wreckAt(c.roll, c.pitch), c.dx, c.dz);
      assert.ok(Math.abs(moved.y) < DRIFT_LIMIT, `the wreck moved ${(moved.y * 1000).toFixed(3)} mm in height over ${SECONDS} s (seat step ${(STEP * SEAT_SPEED * 1000).toFixed(1)} mm)`);
    });
  }

  // The same wreck upright: the seat moves it its full SEAT_SPEED along the offset (body x → world x, z → world z).
  const upright = [
    { name: "3 cm off along x", dx: -0.03, dz: 0, along: "x" as const },
    { name: "3 cm off along z", dx: 0, dz: -0.03, along: "z" as const },
  ];
  for (const c of upright) {
    it(`when it stands upright with its cell ${c.name}, then the seat still moves it ${SEAT_SPEED} m/s along ${c.along} toward the cell (within 10%)`, () => {
      setGround(new Prism());
      const moved = hold(wreckAt(0, 0), c.dx, c.dz);
      const want = -SEAT_SPEED * SECONDS;
      assert.ok(Math.abs(moved[c.along] / want - 1) < 0.1, `moved ${moved[c.along].toFixed(3)} m along ${c.along}, ${want} m wanted`);
    });
  }
});
