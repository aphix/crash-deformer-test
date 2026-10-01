import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pistonAhead, pistonBearing, pistonToGo } from "./engine-pistons.ts";
import { PistonRig } from "./piston-rig.ts";

const STEP = Math.PI / 4;

describe("piston loop hops paced by the orbit", () => {
  it("each piston's bearing puts the camera behind its ram, looking down its axis", () => {
    for (const h of new PistonRig().heads) {
      const want = Math.atan2(-h.nx, -h.nz);
      assert.ok(Math.abs(Math.sin(pistonBearing(h.index) - want)) < 1e-9 && Math.cos(pistonBearing(h.index) - want) > 0, h.id);
    }
  });

  it("picks the next ram in the orbit's direction from the camera's bearing, not the next index", () => {
    // Just past the front ram (bearing 0): front-right comes next, then right.
    assert.equal(pistonAhead(0.01, 0), 2);
    assert.equal(pistonAhead(STEP + 0.01, 0), 3);
    // Camera already behind the rear-left corner: rear-left is passed, left (−90°) is next.
    assert.equal(pistonAhead(-3 * STEP + 0.05, 0), 7);
    // Unwrapped orbit angles (the camera keeps counting turns).
    assert.equal(pistonAhead(0.01 + 4 * Math.PI, 0), 2);
    assert.equal(pistonAhead(0.01 - 6 * Math.PI, 0), 2);
  });

  it("a lead skips a ram the camera reaches too soon to park the car for it", () => {
    assert.equal(pistonAhead(STEP - 0.05, 0), 2);
    assert.equal(pistonAhead(STEP - 0.05, 0.12), 3);
  });

  it("rad to go shrinks to zero as the orbit reaches the ram, then goes negative", () => {
    const i = pistonAhead(0.3, 0);
    assert.ok(Math.abs(pistonToGo(i, 0.3) - (STEP - 0.3)) < 1e-9);
    assert.ok(Math.abs(pistonToGo(i, STEP)) < 1e-9);
    assert.ok(pistonToGo(i, STEP + 0.01) < 0);
    // One hop per eighth of a turn at any orbit offset: the next ram is always within 45° ahead.
    for (let b = -7; b < 7; b += 0.137) {
      const t = pistonToGo(pistonAhead(b, 0), b);
      assert.ok(t > 0 && t <= STEP + 1e-9, `bearing ${b}: ${t}`);
    }
  });
});
