import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import { assignClass, armKill, killClass, CLASSES, HANDLING, VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { droop, sagOffsets, Suspension } from "./car-suspension.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { assertSameNumbers, DT, paint } from "./test-support.ts";

/**
 * A wreck missing wheels rests on the body corners where they were (and on the wheels it still has), as the drawn
 * body mesh: not into the ground, not hovering over an empty corner, still after a few seconds.
 */

const HUBS = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
const NAMES = ["FL", "FR", "RL", "RR"];
/** Wheel sets lost: one corner, a front, rear and side pair, a diagonal pair. */
const SETS: readonly (readonly number[])[] = [[0], [3], [0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];
const _v = new THREE.Vector3();

type Rest = { low: number; corners: number[]; speed: number; drift: number };

/** A parked car hit once (so it is a wreck), its wheels `lost` popped, run `secs` s; then the body mesh read. */
function rest(cls: VehicleClassId, lost: readonly number[], secs = 5): Rest {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  car.deform.squash = INITIAL_HUD.squash;
  car.deform.buckle = INITIAL_HUD.buckle;
  car.deform.setMode(INITIAL_HUD.deformMode);
  assignClass(car, cls);
  armKill(car.deform, killClass(car), HANDLING.realism, "default");
  car.spawnFacing(0, 0, 0, 0);
  car.group.updateMatrixWorld(true);
  car.applyImpact(car.group.position.clone().addScaledVector(car.forward, 2.05), car.forward.clone().negate(), 0.5, 0.5);
  for (const i of lost) car.deform.popHub(car.deform.masses.find((m) => m.name === HUBS[i])!);
  const w = newWorld([car]);
  const bodyY = (): number[] => {
    car.group.updateMatrixWorld(true);
    car.body.updateWorldMatrix(true, false);
    const pos = car.body.geometry.getAttribute("position");
    const hubs = HUBS.map((n) => car.deform.masses.find((m) => m.name === n)!.world);
    const low = [9, 9, 9, 9, 9];
    for (let k = 0; k < pos.count; k++) {
      _v.fromBufferAttribute(pos, k).applyMatrix4(car.body.matrixWorld);
      low[4] = Math.min(low[4]!, _v.y);
      for (let i = 0; i < 4; i++) if (Math.hypot(_v.x - hubs[i]!.x, _v.z - hubs[i]!.z) < 0.6) low[i] = Math.min(low[i]!, _v.y);
    }
    return low;
  };
  let before: number[] = [];
  for (let f = 0; f < secs * 60; f++) {
    if (f === (secs - 1) * 60) before = bodyY();
    stepWorld(w, DT);
    car.updateDeform(DT);
  }
  const low = bodyY();
  return {
    low: low[4]!,
    corners: lost.map((i) => low[i]!),
    speed: car.velocity.length(),
    drift: Math.max(...low.map((y, i) => Math.abs(y - before[i]!))),
  };
}

describe("a car missing wheels rests on the body where they were", () => {
  for (const cls of VEHICLE_CLASS_IDS) {
    it(`good: ${cls} with a corner, a pair or a diagonal off lies on the ground without sinking into it or hovering over it`, () => {
      for (const lost of SETS) {
        const r = rest(cls, lost);
        // A lifted body is held up on its standing tyres' arches before its underside reaches the ground, most of all on
        // the two diagonal tyres of a monster truck (a 0.45 m spring stroke over the ground).
        const diagonal = lost.length === 2 && lost[0]! + lost[1]! === 3;
        const touch = diagonal && CLASSES[cls].lift > 0.3 ? 0.35 : 0.03 + 0.12 * CLASSES[cls].lift;
        const tag = `${cls} minus ${lost.map((i) => NAMES[i]).join("+")}`;
        assert.ok(r.speed < 0.05, `${tag}: still moving at ${r.speed.toFixed(3)} m/s`);
        assert.ok(r.drift < 0.003, `${tag}: body still settling after 4 s, moved ${(r.drift * 1000).toFixed(1)} mm in the last second`);
        assert.ok(r.low > -0.02, `${tag}: body ${(-r.low * 100).toFixed(1)} cm into the ground`);
        assert.ok(r.low < touch, `${tag}: body hovers ${(r.low * 100).toFixed(1)} cm over the ground`);
        const hover = Math.max(...r.corners);
        assert.ok(hover < 0.1 + 0.2 * CLASSES[cls].lift + (diagonal ? 0.2 : 0), `${tag}: an empty corner hovers ${(hover * 100).toFixed(1)} cm`);
      }
    });
  }

  it("good: the body is down on its corners within 3 s of the wheel going (it eases down, it does not drop at once)", () => {
    const r = rest("sedan", [0, 3], 3);
    assert.ok(r.drift < 0.001, `still moving ${(r.drift * 1000).toFixed(2)} mm in the third second`);
    const early = rest("sedan", [0, 3], 0.1);
    assert.ok(early.low > r.low + 0.01, `after 0.1 s the body is already ${(early.low * 100).toFixed(1)} cm over the ground (at rest ${(r.low * 100).toFixed(1)} cm)`);
  });

  it("bad: four wheels on keep the stock ride (no sag where nothing is missing)", () => {
    const r = rest("sedan", []);
    assert.ok(Math.abs(r.low - 0.032) < 0.004, `belly ${r.low.toFixed(3)} m`);
  });
});

describe("sag offsets", () => {
  it("good: all four wheels on sags nothing", () => {
    const o = new Float64Array(4).fill(7);
    sagOffsets(0, 0.065, 0, o);
    assert.deepEqual([...o], [0, 0, 0, 0]);
  });

  it("close-but-wrong: a missing front corner drops that corner of the body and lifts the one across, in every class lift", () => {
    for (const lift of [0, 0.08, 0.48]) {
      const o = new Float64Array(4);
      sagOffsets(lift, 0.065 + lift, 1, o);
      const drop = (0.75 * o[0]! + 0.25 * o[1]! + 0.25 * o[2]! - 0.25 * o[3]!);
      assert.ok(drop < -0.03, `lift ${lift}: front-left corner ${drop.toFixed(3)} m`);
      assert.ok(o[3]! > o[0]!, `lift ${lift}: diagonal corner ${o[3]!.toFixed(3)} not above ${o[0]!.toFixed(3)}`);
    }
  });

  it("good: a wreck that loses a second wheel settles on the new set's corners, not the first set's", () => {
    const s = new Suspension();
    const g = new THREE.Group();
    g.updateMatrixWorld(true);
    for (const gone of [1, 3]) {
      for (let i = 0; i < 600; i++) s.step(g, [], "sedan", 0, false, false, gone, DT);
      const want = new Float64Array(4);
      sagOffsets(0, droop("sedan"), gone, want);
      assertSameNumbers(s.offset, want, `wheels gone ${gone}`, 1e-4);
    }
  });
});
