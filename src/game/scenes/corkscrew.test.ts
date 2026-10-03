import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF, WHEEL_POS } from "../vehicle/car-mesh.ts";
import { Corkscrew, CORKSCREW } from "./corkscrew.ts";
import { setGround } from "../world/ground.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { paint } from "../vehicle/test-support.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { droop } from "../vehicle/car-suspension.ts";
import { FACES, FACE_AXIS, faceFollow } from "../deform/load-crush.ts";

const FRAME = 1 / 60;
const DEG = 180 / Math.PI;
/** Car-local points that can meet the ground: tyre contacts, bumper, beltline and roof corners. */
const HULL: readonly (readonly [number, number, number])[] = [
  ...WHEEL_POS.map(([x, , z]): [number, number, number] => [x, 0, z]),
  ...[-1, 1].flatMap((sx) =>
    [-1, 1].flatMap((sz): [number, number, number][] => [
      [sx * CAR_HALF.x, 0.35, sz * CAR_HALF.z],
      [sx * CAR_HALF.x, 0.95, sz * 2.0],
      [sx * 0.7, 1.36, sz * 0.95],
    ]),
  ),
];

type Run = { air: number; landRoll: number; upY: number; dip: number; rest: "wheels" | "roof" | "side" };

/**
 * A car launched (no driver) at `v` m/s 6 m short of the mouth, stepped by the world step alone with the corkscrew
 * as the ground and its walls as the collide hook, until it rests. Air: the first flight's seconds with every hull
 * point more than 5 cm off the ground; landRoll: the body's turn about its own nose (signed, summed) when a hull
 * point first touches down again; dip: the deepest hull point under the ground from takeoff on.
 */
function launch(v: number): Run {
  const scene = new THREE.Scene();
  const cork = new Corkscrew(scene);
  setGround(cork);
  const car = new DeformableCar(paint(), scene);
  car.spawnFacing(0, CORKSCREW.mouthZ - 6, 0, v);
  const w = newWorld([car]);
  w.collide = (c) => cork.contact(c);
  const q = car.group.quaternion;
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const prevUp = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3();
  const last = new THREE.Vector3().copy(car.group.position);
  let air = 0;
  let landed = false;
  let landRoll = 0;
  let roll = 0;
  let dip = 0;
  let still = 0;
  let acc = 0;
  for (let t = 0; t < 20 && still < 1; t += FRAME) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      stepWorld(w, h);
      acc -= h;
    }
    car.updateDeform(FRAME);
    let low = Infinity;
    for (let i = 0; i < HULL.length; i++) {
      const [x, y, z] = HULL[i]!;
      p.set(x, y, z);
      // A face that yielded (`load-crush.ts`) has its body points moved in: the crushed body is what meets the ground.
      if (i >= WHEEL_POS.length) {
        for (let f = 0; f < FACES; f++) {
          const d = car.deform.crush[f]! * faceFollow(f, x, y, z);
          p.x -= FACE_AXIS[f * 3]! * d;
          p.y -= FACE_AXIS[f * 3 + 1]! * d;
          p.z -= FACE_AXIS[f * 3 + 2]! * d;
        }
      }
      p.applyQuaternion(q).add(car.group.position);
      low = Math.min(low, p.y - cork.heightAt(p.x, p.z, p.y));
    }
    up.set(0, 1, 0).applyQuaternion(q);
    fwd.set(0, 0, 1).applyQuaternion(q);
    roll += Math.atan2(p.crossVectors(prevUp, up).dot(fwd), prevUp.dot(up));
    prevUp.copy(up);
    if (low > 0.05 && !landed) air += FRAME;
    else if (air > 0.2 && !landed) {
      landed = true;
      landRoll = Math.abs(roll) * DEG;
    }
    if (air > 0) dip = Math.max(dip, -low);
    still = car.group.position.distanceTo(last) < 0.002 ? still + FRAME : 0;
    last.copy(car.group.position);
  }
  const upY = up.y;
  car.dispose();
  return { air, landRoll, upY, dip, rest: upY > 0.5 ? "wheels" : upY < 0 ? "roof" : "side" };
}

/**
 * Each band: launch speed, whether it leaves the lip, the roll it touches down with (deg), how it rests.
 * The 27 m/s roll is spin × air: the lip's spin is 189°/s on main 0902bf1 and on the airborne lane alike, the lane's
 * air 0.10 s longer there (3.15 vs 3.05 s: the body leaves the lip 0.9 m sooner, on the steeper 0.53 grade, at 14.4
 * against 13.4 m/s up, where main's constant takeoff gap held it to the flatter 0.49). Sweep 26 / 26.5 / 27 / 27.5 /
 * 28 m/s: lane 508 / 572 / 596 / 619 / 645°, main 540 / 558 / 576 / 599 / 620° — a shift of +20° at 27 m/s, 590 → 620
 * keeps the roll-and-a-half band 540° ± 80° and the 2-roll wheels landing (710° at 29 m/s) out of it.
 */
const BANDS = [
  { v: 6, name: "too slow to climb: rolls back out of the mouth, no air", air: false, roll: [0, 0], rest: "wheels" },
  { v: 14, name: "air, half a roll: lands on its roof", air: true, roll: [130, 230], rest: "roof" },
  { v: 22, name: "air, a full roll: lands back on its wheels", air: true, roll: [310, 410], rest: "wheels" },
  { v: 27, name: "air, a roll and a half: lands on its roof", air: true, roll: [490, 620], rest: "roof" },
] as const;

describe("corkscrew: launch speed decides air, the roll and how the car lands (the general car sim)", () => {
  afterEach(() => setGround(null));

  for (const b of BANDS) {
    it(`${b.v} m/s: ${b.name}; never more than the suspension's stop into the ground after takeoff`, (t) => {
      const r = launch(b.v);
      t.diagnostic(`${b.v} m/s: air ${r.air.toFixed(2)} s, touchdown roll ${r.landRoll.toFixed(0)}°, up.y ${r.upY.toFixed(2)} (${r.rest}), deepest ${r.dip.toFixed(3)} m`);
      const failures: string[] = [];
      if (b.air !== r.air > 0.2) failures.push(`air ${r.air.toFixed(2)} s`);
      if (r.landRoll < b.roll[0] || r.landRoll > b.roll[1]) failures.push(`touchdown roll ${r.landRoll.toFixed(0)}° outside ${b.roll[0]}–${b.roll[1]}°`);
      if (r.rest !== b.rest) failures.push(`rests on its ${r.rest} (up.y ${r.upY.toFixed(2)})`);
      if (r.dip > 2 * droop("sedan") + 0.001) failures.push(`body ${r.dip.toFixed(3)} m into the ground`);
      assert.deepEqual(failures, []);
    });
  }
});
