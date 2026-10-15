import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { launch, makeCar } from "../contact/crash-scenarios.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { blankStrike, fell, runsDown } from "../scenes/figure-strike.ts";
import { RagdollSystem, type Throw } from "./engine-ragdoll.ts";
import { PARTS } from "./ragdoll-body.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

const FIRST_WORKER_ID = 7;
const FRAME = 1 / FRAME_HZ;
/** Torso height (m) of the dummy standing on the ground (`PARTS`), and his upper arm's height hanging against raised over his head. */
const TORSO_STANDING = PARTS[0].c[1];
const ARM_HANGING = PARTS[2].c[1];
/** Metres from the car's origin to its nose, and how far (m) a figure struck by it stands ahead of that. */
const NOSE = 2.1;
const AHEAD = 0.25;

/** A car at `mps` m/s along +z, its nose `AHEAD` m short of the origin where guard `guard` stands, and the strike it makes (`fell`). */
function struck(guard: number, mps: number) {
  const car = makeCar();
  launch(car, 0.3, -NOSE - AHEAD, 0, 0, mps);
  assert.ok(runsDown(car, 0, 0, 0), "the car meets the figure");
  return { car, cars: [car], strike: fell(car, 0, guard, 0, 0, 0, 0, 1, blankStrike()) };
}

/** A ragdoll system whose dummies' world is a worker that only records the throws sent to it (the worker mode of a race course). */
function systemWithWorker() {
  const sent: { t: Throw; purse: boolean }[] = [];
  const worker = {
    throwDummy: (t: Throw, purse: boolean) => {
      sent.push({ t: { ...t, p: t.p.clone(), v: t.v.clone() }, purse });
      return FIRST_WORKER_ID + sent.length - 1;
    },
  };
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  ragdolls["mode"] = "remote";
  Object.assign(ragdolls, { remote: worker });
  return { ragdolls, sent };
}

/** Frames of the dummies' world with the car going on at `mps` along +z, `seconds` of them; the dummy in slot 0's torso then. */
function fly(ragdolls: RagdollSystem, car: DeformableCar, mps: number, seconds: number) {
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let t = 0; t < seconds; t += FRAME) {
    car.group.position.z += mps * FRAME;
    ragdolls.update(FRAME, [car], true, false, null);
  }
  ragdolls.torso(0, p, v);
  return { p, speed: v.length() };
}

const workerCases = [
  { it: "when a navy-uniformed guard is run down at 15 m/s, then the worker is sent one dummy standing where he stood in his uniform, hands at his sides, flying with the car", guard: 0, expectedCop: true, expectedShirt: 0x16181d, expectedPortly: undefined },
  { it: "when a black-suited guard is run down, then he is dressed as an agent", guard: 1, expectedCop: false, expectedShirt: 0x16181d, expectedPortly: undefined },
  { it: "when the VIP is run down, then he is dressed as the portly man in the blue suit", guard: -1, expectedCop: false, expectedShirt: 0x1f3463, expectedPortly: true },
] as const;

describe("given the dummies' world in the ragdoll worker (race courses) and a standing figure a car ran down", () => {
  for (const testCase of workerCases) {
    it(testCase.it, () => {
      const { cars, strike } = struck(testCase.guard, 15);
      const { ragdolls, sent } = systemWithWorker();
      ragdolls.throwFigure(strike, cars);
      assert.equal(sent.length, 1, "one throw reached the worker");
      const { t, purse } = sent[0]!;
      assert.equal(t.cop, testCase.expectedCop, "the navy uniform");
      assert.equal(t.armsDown, true, "arms hanging, not raised over his head");
      assert.equal(t.car, 0, "he ignores the car that struck him at first");
      assert.equal(t.rides, false, "the ride-along never frames him");
      assert.equal(purse, false, "no purse");
      assert.ok(Math.abs(t.p.y - TORSO_STANDING) < 1e-6 && Math.abs(t.p.x) < 1e-6 && Math.abs(t.p.z) < 1e-6, "his torso where he stood");
      assert.ok(Math.abs(t.v.x - strike.vx) < 1e-6 && Math.abs(t.v.y - strike.vy) < 1e-6 && Math.abs(t.v.z - strike.vz) < 1e-6, "the strike's velocity");
      const look = ragdolls["dressing"].get(FIRST_WORKER_ID)!.look;
      assert.equal(look.shirt, testCase.expectedShirt, "his suit");
      assert.equal(look.portly, testCase.expectedPortly, "portly or not");
    });
  }

  it("when a figure is thrown after a driver, then the driver's own throw record is untouched", () => {
    const { cars, strike } = struck(0, 15);
    const { ragdolls } = systemWithWorker();
    const before = ragdolls["next"].rides;
    ragdolls.throwFigure(strike, cars);
    assert.equal(ragdolls["next"].rides, before, "the latest driver's record");
    assert.equal(ragdolls["next"].armsDown, undefined, "no hanging arms on it");
  });
});

describe("given the dummies' world on this thread (the fallback, and every scene that is not a race course) and a standing figure a car ran down", () => {
  it("when a car at 15 m/s runs him down, then one dummy is out standing with his hands down, flies on past the car's nose, lands to the side clear of its path and lies still", async () => {
    const { car, cars, strike } = struck(0, 15);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    await ragdolls.preload();
    ragdolls.throwFigure(strike, cars);
    const dolls: { live: boolean; cur: Float32Array }[] = ragdolls["dolls"];
    const out = dolls.filter((d) => d.live);
    assert.equal(out.length, 1, "one dummy out");
    assert.ok(Math.abs(out[0]!.cur[7 * 2 + 1]! - ARM_HANGING) < 1e-3, "his upper arm hangs at his side");
    const { p, speed } = fly(ragdolls, car, 15, 3);
    assert.ok(p.z > 12 && p.z < 25, `he lies ${p.z.toFixed(1)} m along the car's way`);
    assert.ok(Math.abs(p.x) > 1.2, `${Math.abs(p.x).toFixed(1)} m off the car's centre line, clear of its path`);
    assert.ok(p.y < 0.3, `lying on the ground at ${p.y.toFixed(2)} m`);
    assert.ok(speed < 0.2, `still, at ${speed.toFixed(2)} m/s`);
  });

  it("when Rapier is not in yet, then he is thrown once it is, in the dress he was thrown in", async () => {
    const { car, cars, strike } = struck(1, 15);
    const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
    ragdolls.throwFigure(strike, cars);
    assert.equal(ragdolls["pending"].length, 1, "waiting for Rapier");
    await ragdolls.preload();
    fly(ragdolls, car, 15, FRAME);
    const dolls: { live: boolean }[] = ragdolls["dolls"];
    assert.equal(dolls.filter((d) => d.live).length, 1, "thrown");
    assert.equal(ragdolls["pending"].length, 0, "nothing left waiting");
  });
});
