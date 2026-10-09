import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { setGround } from "./ground.ts";
import { solidsOf, type PropCollider } from "./placements.ts";
import { propContact, type PropHits } from "../contact/prop-contact.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, settleStep, stepWorld } from "../engine/world-step.ts";
import { DeformableCar, DOOR } from "../vehicle/car.ts";
import { DOOR_OPEN_MAX, type DetachPart } from "../vehicle/car-core.ts";
import { assertSameDigest, paint } from "../vehicle/test-support.ts";
import { assignClass, CLASSES } from "../vehicle/vehicle-classes.ts";

/**
 * A door a crash left open sticks out past the car's tyres, where the wall's footprint test never looks. Owner clip "Wall hit,
 * 74 km/h" (muy7bjjp2c): the crushed car drove on past the end of a race wall with its left door hanging open at 75° and the
 * door's skin ended 0.58 m inside the wall's 0.6 m box. The wall below is that end: one 2 m piece whose end cap the car passes
 * at 35° to the wall's own line, the near corner of the cap 1.15 m off the car's side, between the body (0.9 m) and the door's
 * tip (1.4 m).
 */

const FRAME = 1 / 60;
/** One physics slice of travel at the fastest case (9 m/s over 1/240 s) plus the door skin's thickness: how far into the wall the door may be at the end of a slice. */
const DOOR_IN = 0.05;
const NO_HITS: PropHits = { knock: () => {}, fx: () => {}, wall: () => {} };
const WALL = { halfThick: 0.3, halfLong: 1, skewRad: (35 * Math.PI) / 180, cornerLateral: 1.15, cornerAhead: 0.45 };

afterEach(() => setGround(null));

class Probe extends DeformableCar {
  door(side: -1 | 1): DetachPart {
    return this.parts.find((p) => p.name === (side < 0 ? "doorL" : "doorR"))!;
  }
}

/**
 * The wall piece, in the car's frame when the car stands at the origin heading +z with the wall on its left: its end cap faces
 * forward-right, its line runs 35° from the car's, and the cap's near corner is `cornerLateral` to the left, `cornerAhead` ahead.
 */
function endOfWall(): PropCollider {
  const { halfThick, halfLong, skewRad: yaw } = WALL;
  const along = { x: Math.sin(yaw), z: Math.cos(yaw) };
  const toCar = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const capMiddle = { x: -WALL.cornerLateral - toCar.x * halfThick, z: WALL.cornerAhead - toCar.z * halfThick };
  return {
    index: 0,
    prefab: null,
    body: "solid",
    x: capMiddle.x - along.x * halfLong,
    z: capMiddle.z - along.z * halfLong,
    yaw,
    kind: "box",
    r: Math.hypot(halfThick, halfLong),
    hx: halfThick,
    hz: halfLong,
    mass: 0,
    base: -0.3,
    top: 1.2,
    ends: 3,
  };
}

/** How deep (m, from the face the car came at) the deepest vertex of the car's drawn door `side` stands inside the wall's box; 0 if none does. */
function doorDepth(car: Probe, side: -1 | 1, wall: PropCollider): number {
  const cos = Math.cos(wall.yaw);
  const sin = Math.sin(wall.yaw);
  // The face the car came at: the one on the car's side of the wall's middle plane.
  const carSide = Math.sign((car.group.position.x - wall.x) * cos - (car.group.position.z - wall.z) * sin);
  const v = new THREE.Vector3();
  let deepest = 0;
  car.group.updateMatrixWorld(true);
  car.door(side).object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute("position");
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
      const u = (v.x - wall.x) * cos - (v.z - wall.z) * sin;
      const along = (v.x - wall.x) * sin + (v.z - wall.z) * cos;
      if (Math.abs(u) < wall.hx && Math.abs(along) < wall.hz && v.y >= wall.base && v.y <= wall.top) deepest = Math.max(deepest, wall.hx - carSide * u);
    }
  });
  return deepest;
}

const passCases = [
  { it: "when its door is jammed open by the crash and it passes at 9 m/s, then the wall tears the door off before the door is drawn into it", jam: 0.9, speed: 9, torn: true },
  { it: "when its door is jammed open by the crash and it passes at 3 m/s, then the wall tears the door off before the door is drawn into it", jam: 0.9, speed: 3, torn: true },
  { it: "when its door swings free, open to its stop, and it passes at 4 m/s, then the wall shuts the door only as far as it must and the door is never drawn into the wall", jam: 0, speed: 4, torn: false },
  { it: "when its door swings free, open to its stop, and it passes at 9 m/s, then the wall shuts the door only as far as it must, faster, and the door is never drawn into the wall", jam: 0, speed: 9, torn: false },
  { it: "when its door swings free, open to its stop, and it passes at 20 m/s, then the wall slams the door shut so hard it tears off, and it is never drawn into the wall first", jam: 0, speed: 20, torn: true },
] as const;

type Solids = { walls: PropCollider[]; props: PropCollider[] };

/** A sedan with its left door open (jammed by `jam`, 0 for free) driven at `speed` along the line past the end of `shape`, through `solids`; the car, and how deep the door's skin was ever drawn into `shape`. */
function driveBy(jam: number, speed: number, shape: PropCollider, solids: Solids): { car: Probe; deepest: number } {
  const prisms = solidsOf(solids.walls, solids.props);
  const car = new Probe(paint(), new THREE.Scene(), null, CLASSES.sedan.style);
  assignClass(car, "sedan");
  car.spawnFacing(0, -8, 0, speed);
  car.setDoorOpen(-1, DOOR_OPEN_MAX);
  car.door(-1).hingeT = jam;
  const world = newWorld([car]);
  world.fine = 1 / 240;
  world.collide = (c, i, h) => propContact(c, i, prisms, new Uint8Array(0), NO_HITS, h);
  let acc = 0;
  let deepest = 0;
  for (let f = 0; f < 8 / FRAME && car.group.position.z < WALL.cornerAhead + 3; f++) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = Math.fround(physicsSlice(acc, sliceSpeed(world.cars)));
      stepWorld(world, h);
      settleStep(world.cars, h, false);
      acc -= h;
      if (!car.partOff("doorL")) deepest = Math.max(deepest, doorDepth(car, -1, shape));
    }
  }
  return { car, deepest };
}

describe("given a sedan with its left door hanging open, driving past the end of a wall that stands between its body and the door's tip", () => {
  for (const testCase of passCases) {
    it(testCase.it, () => {
      const wall = endOfWall();
      const { car, deepest } = driveBy(testCase.jam, testCase.speed, wall, { walls: [wall], props: [] });
      const note = `the door was drawn up to ${deepest.toFixed(3)} m into the wall, ${car.partOff("doorL") ? "and tore off" : `and ended open at ${car.doorHinge(-1).theta.toFixed(2)} rad`}`;
      assert.ok(car.group.position.z >= WALL.cornerAhead + 3, `the car drove past the wall's end (it stopped ${car.group.position.z.toFixed(1)} m along)`);
      assert.ok(deepest <= DOOR_IN, note);
      assert.equal(car.partOff("doorL"), testCase.torn, note);
    });
  }
});

describe("given the same open door passing a wall piece, and passing a placed solid prop of the same plan shape", () => {
  for (const testCase of passCases) {
    it(`when the pass is made at ${testCase.speed} m/s with the door ${testCase.jam > 0 ? "jammed open" : "swinging free"}, then the door and the car end in the same state against both`, () => {
      const piece = endOfWall();
      const prop: PropCollider = { ...piece, prefab: "stucco" };
      const againstWall = driveBy(testCase.jam, testCase.speed, piece, { walls: [piece], props: [] });
      const againstProp = driveBy(testCase.jam, testCase.speed, prop, { walls: [], props: [prop] });
      assert.equal(againstProp.car.partOff("doorL"), againstWall.car.partOff("doorL"), "the door was off against one and on against the other");
      assertSameDigest({ ...againstProp.car.doorHinge(-1) }, { ...againstWall.car.doorHinge(-1) }, "the door's hinge");
      assert.equal(againstProp.deepest, againstWall.deepest, "the door was drawn to different depths");
      assertSameDigest(againstProp.car.snapshot(), againstWall.car.snapshot(), "the car's state");
    });
  }
});

const POST_RADIUS = 0.1;

/** Where door `side`'s tip is (world, xz) at the angle the car draws it open. */
function doorTip(car: Probe, side: -1 | 1): { x: number; z: number } {
  const theta = car.doorAngle(side);
  const across = side * (DOOR.hingeX + DOOR.length * Math.sin(theta));
  const along = DOOR.hingeZ - DOOR.length * Math.cos(theta);
  return { x: car.group.position.x + car.rightFlat.x * across + car.fwdFlat.x * along, z: car.group.position.z + car.rightFlat.z * across + car.fwdFlat.z * along };
}

describe("given a parked sedan with its left door swinging free at its stop, and a round post standing on the door's tip", () => {
  it("when the post meets the door over one frame, then the door is shut until its tip stands clear of the post, and stays on", () => {
    const car = new Probe(paint(), new THREE.Scene(), null, CLASSES.sedan.style);
    assignClass(car, "sedan");
    car.spawnFacing(0, 0, 0, 0);
    car.setDoorOpen(-1, DOOR_OPEN_MAX);
    const open = car.doorAngle(-1);
    const tip = doorTip(car, -1);
    const post: PropCollider = { index: 0, prefab: "lamp", body: "solid", x: tip.x, z: tip.z, yaw: 0, kind: "circle", r: POST_RADIUS, hx: POST_RADIUS, hz: POST_RADIUS, mass: 0, base: -1, top: 3, ends: 3 };
    propContact(car, 0, solidsOf([], [post]), new Uint8Array(0), NO_HITS, FRAME);
    const shut = doorTip(car, -1);
    assert.ok(car.doorAngle(-1) < open, `the door stayed open at ${car.doorAngle(-1).toFixed(2)} rad`);
    assert.ok(Math.hypot(shut.x - post.x, shut.z - post.z) >= POST_RADIUS, `the door's tip is ${Math.hypot(shut.x - post.x, shut.z - post.z).toFixed(3)} m from the post's middle, inside its ${POST_RADIUS} m radius`);
    assert.ok(!car.partOff("doorL"), "the door tore off");
  });
});
