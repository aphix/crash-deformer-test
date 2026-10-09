import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { recordFlat, type Spawn } from "./replay-fidelity.test-util.ts";
import { ClipSim } from "./engine-replay.ts";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * Owner, 2026-10-09 (docs/HIGHLIGHTS.md, clip review issue 6): in a slow-mo replay every drawn part of a car moves on every drawn frame, the
 * torn and hinged parts and the popped wheels included. The reel draws through live play's `PoseBlend` (`ClipSim.present`): every part the
 * blend carries is between the pose before the step it is in and the one it left. Measured on the lane before the change (the group alone
 * was blended): DYZ7-QCXS `6.bumperF` moved on 27.8 % of its moving frames, `3.archFR` on 45.3 %, torn parts 91.5 % / 94.2 % at 60 / 120 fps.
 * The bar is the owner's: at least 95 % of the slow-mo frames on which a part really moves (more than 5 mm over the 3 frames either side).
 */
const HEAD = Math.PI / 2;
/** The pile-up of replay-fidelity.test.ts: two head-on, one behind, one across; wrecks shed parts and pop wheels. */
const PILE: Spawn[] = [
  { x: 0, z: 0, yaw: HEAD, speed: 20, throttle: 1 },
  { x: 80, z: 0, yaw: -HEAD, speed: 20, throttle: 1 },
  { x: -12, z: 0.5, yaw: HEAD, speed: 20, throttle: 1 },
  { x: 40, z: 60, yaw: Math.PI, speed: 20, throttle: 1 },
];
/** Slow-mo: the clip's time per drawn frame (s): a 1/60 s frame at 0.1x (about 0.4 of a 1/240 s step) and at 0.2x. */
const FRAME_S = [1 / 600, 1 / 300];
/** An entity moves on a frame when its world position or orientation changed by more than this. */
const EPS_POS = 1e-5;
const EPS_ROT = 1e-6;
/** It really moves where it is further than this (m) from itself 3 frames either side. */
const MOVING = 0.005;
const BAR = 0.95;

type Class = "group" | "classLift" | "wheel" | "part";
type Pose = { p: THREE.Vector3; q: THREE.Quaternion };

function entities(cars: readonly DeformableCar[]): { cls: Class; object: THREE.Object3D }[] {
  const out: { cls: Class; object: THREE.Object3D }[] = [];
  for (const c of cars) {
    out.push({ cls: "group", object: c.group });
    const body = c["classBodyObject"]();
    if (body) out.push({ cls: "classLift", object: body });
    for (const w of c.wheels) out.push({ cls: "wheel", object: w });
    for (const p of c["parts"]) out.push({ cls: "part", object: p.object });
  }
  return out;
}

function sample(object: THREE.Object3D): Pose {
  object.updateWorldMatrix(true, false);
  return { p: object.getWorldPosition(new THREE.Vector3()), q: object.getWorldQuaternion(new THREE.Quaternion()) };
}

/** Per class: the frames on which an entity moves, and the ones among them on which its drawn pose changed since the frame before. */
function shares(dt: number): Record<Class, { moving: number; changed: number }> {
  const rec = recordFlat(PILE, 8, false);
  const cars = rec.clip.cars.map((c) => rec.cars[c.slot]!);
  const blend = rec.scene.blend;
  const sim = new ClipSim(rec.clip, cars, rec.scene);
  sim.restart();
  const ents = entities(cars);
  const series: Pose[][] = ents.map(() => []);
  let t = 0;
  while (t < sim.length - dt) {
    t += dt;
    sim.advanceTo(t);
    sim.present(t);
    for (let i = 0; i < ents.length; i++) series[i]!.push(sample(ents[i]!.object));
    blend.restore();
  }
  const out: Record<Class, { moving: number; changed: number }> = { group: { moving: 0, changed: 0 }, classLift: { moving: 0, changed: 0 }, wheel: { moving: 0, changed: 0 }, part: { moving: 0, changed: 0 } };
  for (let i = 0; i < ents.length; i++) {
    const s = series[i]!;
    for (let f = 3; f < s.length - 3; f++) {
      if (s[f - 3]!.p.distanceTo(s[f + 3]!.p) <= MOVING) continue;
      out[ents[i]!.cls].moving++;
      if (s[f]!.p.distanceTo(s[f - 1]!.p) > EPS_POS || s[f]!.q.angleTo(s[f - 1]!.q) > EPS_ROT) out[ents[i]!.cls].changed++;
    }
  }
  return out;
}

describe("given a crash replayed in slow motion from its clip", () => {
  for (const frame of FRAME_S) {
    it(`when frames of ${(frame * 1000).toFixed(2)} ms of the clip (a 1/60 s frame at ${(frame * 60).toFixed(1)}x) are drawn, then every class of drawn part changes pose on at least ${BAR * 100} % of the frames it moves on`, () => {
      const s = shares(frame);
      const rows = (Object.keys(s) as Class[]).map((c) => `${c} ${s[c].changed}/${s[c].moving}`).join(", ");
      assert.ok(s.part.moving > 100, `the clip sheds parts that move (${rows})`);
      assert.ok(s.wheel.moving > 100 && s.classLift.moving > 100 && s.group.moving > 100, rows);
      for (const c of Object.keys(s) as Class[]) assert.ok(s[c].changed >= BAR * s[c].moving, `${c}: ${(s[c].changed / s[c].moving).toFixed(3)} of its moving frames change (${rows})`);
    });
  }

  it("when a frame is drawn between two steps and handed back, then the sim's own pose of every car is exactly what it was", () => {
    const rec = recordFlat(PILE, 8, false);
    const cars = rec.clip.cars.map((c) => rec.cars[c.slot]!);
    const sim = new ClipSim(rec.clip, cars, rec.scene);
    sim.restart();
    sim.advanceTo(2.3);
    const before = cars.map((c) => [c.group.position.toArray(), c.group.quaternion.toArray()]);
    sim.present(sim.time - 0.001);
    assert.notDeepEqual(
      before,
      cars.map((c) => [c.group.position.toArray(), c.group.quaternion.toArray()]),
      "the drawn pose is between the steps",
    );
    rec.scene.blend.restore();
    assert.deepEqual(
      cars.map((c) => [c.group.position.toArray(), c.group.quaternion.toArray()]),
      before,
    );
  });
});
