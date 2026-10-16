import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FRAME_HZ } from "../kernel/constants.ts";
import { makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { buildCar, TOP_PARTS } from "./drawn-body.test-util.ts";
import { makeLampUnit } from "./car-materials.ts";
import type { CarStyleId } from "./car-variants.ts";
import type { DeformableCar } from "./car.ts";
import type { VehicleClassId } from "./vehicle-classes.ts";

/**
 * A wreck lying on its roof or its side rests so that what is drawn stays out of the ground: the body and the roof crown within the
 * cage's few centimetres, the mirrors and the lamps clear. Every number is read off the drawn meshes (the world vertices of the
 * body, door, mirror and lamp meshes), not off the contact points the solver rests the body on, which cannot see what they leave out.
 */

type Fleet = readonly { style: CarStyleId; cls: VehicleClassId }[];
const FLEET: Fleet = [
  { style: "sedan", cls: "sedan" },
  { style: "pickup", cls: "truck" },
  { style: "sedan", cls: "monster" },
];
/** The attitudes a car is dropped in (pitch, yaw, roll about the car's own axes, radians): flat on its roof, on its left flank, on its right flank. */
const ATTITUDE = {
  roof: [0, 0, Math.PI],
  left: [0, 0, Math.PI / 2],
  right: [0, 0, -Math.PI / 2],
  wheels: [0, 0, 0],
} as const;
type Attitude = keyof typeof ATTITUDE;
const DROP_SECONDS = 5;
/** A body or crown vertex lies within this (m) of the ground at worst: the cage's decimation (220 vertices) leaves drawn vertices between its own, measured up to 0.030 m. */
const BODY_SINK_M = 0.04;
/** A mirror or lamp lies out of the ground to within the drawn parts' own tolerance (m). */
const PART_SINK_M = 0.02;
/** A door's window frame stands out of a crushed roof by the crush, so a roof-down wreck's door reaches this far (m) into the ground at worst (measured 0.102). */
const DOOR_ON_ROOF_SINK_M = 0.12;
/** The crown is the drawn cabin's vertices within this (m) of its highest. */
const CROWN_DEPTH_M = 0.15;
/** Where along the car's nose (m from its middle) the hit that makes a wreck of it lands. */
const NOSE_HIT_M = 2.05;
/** A mirror of a car on its wheels is at least this high (m): it stands on the door, a good half metre up. */
const MIRROR_ON_WHEELS_MIN_M = 0.3;

const _v = new THREE.Vector3();

function lowestY(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, only?: (vertex: number) => boolean): number {
  const position = geometry.getAttribute("position");
  let low = Infinity;
  for (let k = 0; k < position.count; k++) {
    if (only && !only(k)) continue;
    low = Math.min(low, _v.fromBufferAttribute(position, k).applyMatrix4(matrix).y);
  }
  return low;
}

type Lowest = { body: number; crown: number; mirrors: number; doors: number; lamps: number };

/** The vertices of the drawn body's cabin within `CROWN_DEPTH_M` of its highest, found on the fresh body. */
function crownVertices(car: DeformableCar): ReadonlySet<number> {
  const position = car.body.geometry.getAttribute("position");
  const inCabin = (k: number): boolean => position.getX(k) >= TOP_PARTS.cabin.x0 && position.getX(k) <= TOP_PARTS.cabin.x1 && position.getZ(k) >= TOP_PARTS.cabin.z0 && position.getZ(k) <= TOP_PARTS.cabin.z1;
  let top = -Infinity;
  for (let k = 0; k < position.count; k++) if (inCabin(k)) top = Math.max(top, position.getY(k));
  const crown = new Set<number>();
  for (let k = 0; k < position.count; k++) if (inCabin(k) && position.getY(k) > top - CROWN_DEPTH_M) crown.add(k);
  return crown;
}

/** The lowest world y of each drawn part of `car` (m): its body, its roof crown, its mirrors (attached or loose), its doors without their mirrors, its lamps. */
function lowestDrawn(car: DeformableCar, crown: ReadonlySet<number>): Lowest {
  car.flushDeferredSkin();
  car.updateSkin();
  car.group.updateMatrixWorld(true);
  car.body.updateWorldMatrix(true, false);
  const parts = car["parts"];
  const mirrors = parts.filter((p) => p.mirror).map((p) => p.object as THREE.Mesh);
  let low: Lowest = { body: lowestY(car.body.geometry, car.body.matrixWorld), crown: lowestY(car.body.geometry, car.body.matrixWorld, (k) => crown.has(k)), mirrors: Infinity, doors: Infinity, lamps: Infinity };
  for (const mirror of mirrors) {
    mirror.updateWorldMatrix(true, false);
    low = { ...low, mirrors: Math.min(low.mirrors, lowestY(mirror.geometry, mirror.matrixWorld)) };
  }
  for (const door of parts.filter((p) => p.hinge === "door")) {
    door.object.updateWorldMatrix(true, false);
    door.object.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || mirrors.includes(o)) return;
      low = { ...low, doors: Math.min(low.doors, lowestY(o.geometry, o.matrixWorld)) };
    });
  }
  for (const lamp of car.lamps) {
    lamp.seat.updateWorldMatrix(true, false);
    low = { ...low, lamps: Math.min(low.lamps, lowestY(makeLampUnit(lamp.kind), lamp.seat.matrixWorld)) };
  }
  return low;
}

/** A car of `style` and `cls` dropped in `attitude` from `height` m (its lowest drawn point) on the flat pad and left `DROP_SECONDS` s, a wreck once its nose is hit first if `struck`; with the crown it had fresh. */
function dropped(style: CarStyleId, cls: VehicleClassId, attitude: Attitude, height: number, struck = false): { car: DeformableCar; lowest: Lowest } {
  const car = buildCar(style, cls);
  car.spawnFacing(0, 0, 0, 0);
  car.updateSkin();
  const crown = crownVertices(car);
  if (struck) car.applyImpact(car.group.position.clone().addScaledVector(car.forward, NOSE_HIT_M), car.forward.clone().negate(), 0.5, 0.5);
  const [pitch, yaw, roll] = ATTITUDE[attitude];
  car.group.rotation.set(pitch, yaw, roll, "YXZ");
  car.group.updateMatrixWorld(true);
  car.group.position.y += height - new THREE.Box3().setFromObject(car.group).min.y;
  car.airborne = true;
  car.parked = true;
  const world = makeWorld([car], false, false);
  for (let f = 0; f < DROP_SECONDS * FRAME_HZ; f++) tickWorld(world, 1 / FRAME_HZ);
  return { car, lowest: lowestDrawn(car, crown) };
}

const cm = (m: number): string => `${(m * 100).toFixed(1)} cm`;

describe("given a car dropped onto its roof on the flat pad, from 0.5 and from 2 m, and left to rest", () => {
  for (const { style, cls } of FLEET) {
    it(`when it is a ${cls}, then the drawn body and roof crown stay out of the ground, and its mirrors and lamps with them`, () => {
      for (const height of [0.5, 2]) {
        const { car, lowest } = dropped(style, cls, "roof", height);
        const tag = `${cls} dropped on its roof from ${height} m`;
        assert.ok(lowest.body > -BODY_SINK_M, `${tag}: body ${cm(-lowest.body)} into the ground`);
        assert.ok(lowest.crown > -BODY_SINK_M, `${tag}: roof crown ${cm(-lowest.crown)} into the ground`);
        assert.ok(lowest.mirrors > -PART_SINK_M, `${tag}: a mirror ${cm(-lowest.mirrors)} into the ground`);
        assert.ok(lowest.lamps > -PART_SINK_M, `${tag}: a lamp ${cm(-lowest.lamps)} into the ground`);
        assert.ok(!car.partOff("mirrorL") && !car.partOff("mirrorR"), `${tag}: a mirror that stands clear of the ground was torn off`);
      }
    });
  }

  it("when a sedan rests on its roof from 0.5 m, then its doors are not lowered into the ground by more than the window frame stands out of the crushed roof", () => {
    const { lowest } = dropped("sedan", "sedan", "roof", 0.5);
    assert.ok(lowest.doors > -DOOR_ON_ROOF_SINK_M, `a door ${cm(-lowest.doors)} into the ground`);
  });
});

describe("given a car dropped onto its left or right flank on the flat pad, from 0.5 and from 2 m, and left to rest", () => {
  for (const { style, cls } of FLEET) {
    it(`when it is a ${cls}, then the drawn body stays out of the ground, the mirror it lies on is torn off and rests on the ground, and the other mirror and the lamps are left as they were`, () => {
      for (const side of ["left", "right"] as const) {
        for (const height of [0.5, 2]) {
          const { car, lowest } = dropped(style, cls, side, height);
          const tag = `${cls} dropped on its ${side} flank from ${height} m`;
          const [down, up] = side === "left" ? (["mirrorL", "mirrorR"] as const) : (["mirrorR", "mirrorL"] as const);
          assert.ok(lowest.body > -BODY_SINK_M, `${tag}: body ${cm(-lowest.body)} into the ground`);
          assert.ok(lowest.mirrors > -PART_SINK_M, `${tag}: a mirror ${cm(-lowest.mirrors)} into the ground`);
          assert.ok(lowest.lamps > -PART_SINK_M, `${tag}: a lamp ${cm(-lowest.lamps)} into the ground`);
          assert.ok(car.partOff(down), `${tag}: the mirror under the car is still on it`);
          assert.ok(!car.partOff(up), `${tag}: the mirror above the car was torn off`);
        }
      }
    });
  }
});

describe("given a car dropped on its wheels on the flat pad", () => {
  it("when it settles for 5 s, then it keeps both mirrors: nothing of it lies over far enough to put one into the ground", () => {
    for (const { style, cls } of FLEET) {
      const { car, lowest } = dropped(style, cls, "wheels", 0.5, true);
      assert.ok(car.crashed, `${cls}: the nose hit did not make it a wreck, so nothing here could tear a mirror`);
      assert.ok(!car.partOff("mirrorL") && !car.partOff("mirrorR"), `${cls}: a mirror was torn off a car standing on its wheels`);
      assert.ok(lowest.mirrors > MIRROR_ON_WHEELS_MIN_M, `${cls}: a mirror ${cm(lowest.mirrors)} over the ground, not up where it stands`);
    }
  });
});

describe("given a car lying on its roof, with its doors drawn on their rest seats", () => {
  it.todo("when it rests after a 2 m drop, then each door's window frame is out of the ground (today 0.19 m into it: the doors stay on their rest seats while the roof crushes)");
});
