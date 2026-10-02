import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FLEET_MIN_SEP, MAX_CARS, layoutFleet } from "./fleet.ts";

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("layoutFleet", () => {
  it("good: 1–2 cars sit opposite and never overlap", () => {
    const one = layoutFleet(1, 10, 10, rngFrom(1));
    assert.equal(one.length, 1);
    assert.ok(Math.hypot(one[0]!.x, one[0]!.z) > 8);

    const two = layoutFleet(2, 8, 12, rngFrom(2));
    assert.equal(two.length, 2);
    const d = Math.hypot(two[0]!.x - two[1]!.x, two[0]!.z - two[1]!.z);
    assert.ok(d > FLEET_MIN_SEP * 2, `head-on pair only ${d.toFixed(2)} m apart`);
  });

  it("good: 8 cars keep min separation", () => {
    const slots = layoutFleet(8, 0, 20, rngFrom(7));
    assert.equal(slots.length, 8);
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i]!.x - slots[j]!.x, slots[i]!.z - slots[j]!.z);
        assert.ok(d >= FLEET_MIN_SEP - 0.05, `pair ${i},${j} at ${d.toFixed(2)} m`);
      }
    }
  });

  it("bad: min speed 0 is allowed and can actually spawn a parked car", () => {
    const slots = layoutFleet(6, 0, 0, rngFrom(3));
    assert.ok(slots.every((s) => s.speed === 0));
  });

  it("close-but-wrong: min=max pins every car to that speed, not a 0–max roll", () => {
    const slots = layoutFleet(5, 14, 14, rngFrom(9));
    assert.ok(slots.every((s) => s.speed === 14));
  });

  it("good: count is clamped to MAX_CARS", () => {
    assert.equal(layoutFleet(99, 1, 2, rngFrom(4)).length, MAX_CARS);
    assert.equal(layoutFleet(0, 1, 2, rngFrom(4)).length, 1);
  });
});
