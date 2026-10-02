import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { Corkscrew, CORKSCREW } from "./corkscrew.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { paint } from "../vehicle/test-support.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";

const FRAME = 1 / 60;
const DEG = 180 / Math.PI;

type Run = { air: number; roll: number; upY: number; dip: number; wall: number; rest: "wheels" | "roof" | "side" };

/** A car launched at `v` m/s 6 m short of the mouth, stepped as the engine steps the scene, until it rests. */
function launch(v: number): Run {
  const scene = new THREE.Scene();
  const cork = new Corkscrew(scene);
  const car = new DeformableCar(paint(), scene);
  car.spawnFacing(0, CORKSCREW.mouthZ - 6, 0, v);
  const w = newWorld([car]);
  w.beforeSlice = (h) => cork.step(car, h);
  let captured = false;
  let acc = 0;
  for (let t = 0; t < 20; t += FRAME) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      stepWorld(w, h);
      acc -= h;
    }
    car.updateDeform(FRAME);
    captured ||= cork.phase !== "free";
    if (cork.phase === "rest" || (captured && cork.phase === "free")) break;
  }
  car.group.updateWorldMatrix(true, true);
  const upY = car.group.matrixWorld.elements[5]!;
  const run: Run = {
    air: cork.airTime,
    // The lip's bank plus the turn in the air: how far the car has rolled when it comes down.
    roll: (cork.airTime > 0 ? CORKSCREW.bank + cork.airTurn : 0) * DEG,
    upY,
    dip: cork.floorDip,
    wall: cork.wallOver,
    rest: upY > 0.5 ? "wheels" : upY < -0.5 ? "roof" : "side",
  };
  car.dispose();
  return run;
}

/** Each band: launch speed, whether it leaves the lip, the roll it comes down with (deg), how it rests. */
const BANDS = [
  { v: 6, name: "too slow to climb: rolls back out of the mouth, no air", air: false, roll: [0, 0], rest: "wheels" },
  { v: 13, name: "air, half a roll: lands on its roof", air: true, roll: [120, 240], rest: "roof" },
  { v: 19, name: "air, a full roll: back on its wheels", air: true, roll: [300, 420], rest: "wheels" },
  { v: 25, name: "air, a roll and a half: lands on its roof", air: true, roll: [480, 600], rest: "roof" },
] as const;

describe("corkscrew: launch speed decides air, the roll and how the car lands", () => {
  for (const b of BANDS) {
    it(`${b.v} m/s: ${b.name}; never more than 12 cm into the floor or past a wall`, (t) => {
      const r = launch(b.v);
      t.diagnostic(
        `${b.v} m/s: air ${r.air.toFixed(2)} s, roll ${r.roll.toFixed(0)}°, up.y ${r.upY.toFixed(2)} (${r.rest}), floor dip ${r.dip.toFixed(3)} m, past wall ${r.wall.toFixed(3)} m`,
      );
      const failures: string[] = [];
      if (b.air !== r.air > 0.2) failures.push(`air ${r.air.toFixed(2)} s`);
      if (r.roll < b.roll[0] || r.roll > b.roll[1]) failures.push(`roll ${r.roll.toFixed(0)}° outside ${b.roll[0]}–${b.roll[1]}°`);
      if (r.rest !== b.rest) failures.push(`rests on its ${r.rest} (up.y ${r.upY.toFixed(2)})`);
      if (r.dip > 0.12) failures.push(`body ${r.dip.toFixed(3)} m into the floor`);
      if (r.wall > 0) failures.push(`body ${r.wall.toFixed(3)} m past a wall`);
      assert.deepEqual(failures, []);
    });
  }
});
