import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DerbyBrain } from "./derby-ai.ts";
import { aiCar } from "../vehicle/test-support.ts";

/**
 * Opening caution (owner 10-04): until 8 s into a heat or a car's own first hit, a driver does not drive its nose into a
 * rival at a high closing speed. One rule in the brain for every AI car; the player is untouched.
 */

/** A hungry driver 0 at 20 m/s with a rival `z` m dead ahead that is `foeVz` m/s along +z; the brain has run `age` s. */
function charge(age: number, foeVz = -20, z = 18): { brain: DerbyBrain; out: { throttle: number; brake: number; boost: boolean } } {
  const brain = new DerbyBrain();
  brain.setAggression(0, 1);
  const self = aiCar(0, { vz: 20, rear: 0.9, damage: 0.3, idle: 1000 });
  const all = [self, aiCar(1, { z, vz: foeVz })];
  brain.think(self, all, age);
  brain.meter[0] = 1;
  const out = brain.think(self, all, 1 / 60);
  return { brain, out: { throttle: out.throttle, brake: out.brake, boost: out.boost } };
}

describe("derby opening caution", () => {
  it("bad: in the opening a nose closing at 40 m/s on a rival 18 m ahead lifts and brakes, no boost", () => {
    const { out } = charge(2);
    assert.ok(out.throttle <= 0 && out.brake > 0.5 && !out.boost, JSON.stringify(out));
  });

  it("good: the same charge after 8 s is untouched: it keeps the gas", () => {
    const { out } = charge(9);
    assert.ok(out.throttle > 0 && out.brake === 0, JSON.stringify(out));
  });

  it("good: a slow closing speed in the opening is not lifted for (the derby still gets going)", () => {
    const { out } = charge(2, 18);
    assert.ok(out.throttle > 0 && out.brake === 0, JSON.stringify(out));
  });

  it("good: after the car's own first aggressive hit the caution is over", () => {
    const brain = new DerbyBrain();
    brain.setAggression(0, 1);
    const self = aiCar(0, { vz: 20, rear: 0.9, damage: 0.3, idle: 30 });
    const all = [self, aiCar(1, { z: 18, vz: -20 })];
    brain.think(self, all, 2);
    self.idle = 0; // it just landed a hit (the hit clock restarts)
    brain.think(self, all, 1 / 60);
    self.idle = 0.5;
    const out = brain.think(self, all, 1 / 60);
    assert.ok(out.throttle > 0 && out.brake === 0, JSON.stringify({ ...out }));
  });

  it("good: a rival behind the nose is not lifted for", () => {
    const { out } = charge(2, 20, -18);
    assert.ok(out.brake === 0, JSON.stringify(out));
  });
});
