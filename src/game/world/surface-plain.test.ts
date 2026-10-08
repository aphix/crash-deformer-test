import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ground } from "./ground.ts";
import { activate, C_H, contactIn, HIT_SIZE, pointContact, PQ_SIZE, PQ_X, PQ_Y, PQ_Z } from "./surfaces.ts";

/**
 * A ground's plain grid (level, unbounded, the world's, no disc or per-node factors) is read straight (`plainOffer`) only while it
 * is as it was sealed; a grid that changed after the seal (its node data, its owner, its box) is read by the full query, so every
 * query answers what the changed grid says.
 */

const H = 1;
const DROP = 0.2;
const AUX = 0.5;
const N = 3;
const CAR = 3;
const OTHER_CAR = 5;
/** Half the side (m) of the square the grid's box is clipped to, about its far corner (N − 1, N − 1). */
const CLIP = 0.25;

function plainGround(): { g: Ground; i: number; heights: Float32Array } {
  const g = new Ground();
  const heights = new Float32Array(N * N).fill(H);
  const i = g.addGrid({ nu: N, nv: N, step: 1, stepV: 1, u0: 0, v0: 0, heights, ox: 0, oy: 0, oz: 0, reach: Infinity, drop: DROP, unbounded: true });
  return { g, i, heights };
}

function contactAt(skip: number): number {
  const q = new Float64Array(PQ_SIZE);
  const out = new Float64Array(HIT_SIZE);
  q[PQ_X] = 0.5;
  q[PQ_Z] = 0.5;
  q[PQ_Y] = Infinity;
  pointContact(q, skip, out);
  return out[C_H]!;
}

describe("given a ground of one plain 3 × 3 grid at height 1 with a 0.2 m crush drop that has answered a query", () => {
  it("when per-node factors of 0.5 are set, then heightAt and contactIn answer the height less the drop times the factor", () => {
    const { g, i, heights } = plainGround();
    assert.equal(g.heightAt(0.5, 0.5), H - DROP, "sealed as it was built: no factor, the whole drop");
    g.setGridData(i, N, N, 1, 1, 0, 0, heights, new Float32Array(N * N).fill(AUX), H);
    const q = new Float64Array(PQ_SIZE);
    const out = new Float64Array(HIT_SIZE);
    q[PQ_X] = 0.5;
    q[PQ_Z] = 0.5;
    q[PQ_Y] = Infinity;
    contactIn(g, q, out);
    assert.equal(out[C_H], H - DROP * AUX, "contactIn reads the factor");
    assert.equal(g.heightAt(0.5, 0.5), H - DROP * AUX, "heightAt reads the factor");
  });

  it("when the grid becomes car 3's, then car 3 finds nothing under it and car 5 still stands on it", () => {
    const { g, i } = plainGround();
    activate(g);
    try {
      assert.equal(contactAt(CAR), H - DROP, "the world's grid is under every car");
      g.own(i, CAR);
      assert.equal(contactAt(CAR), -Infinity, "its own grid is not under car 3");
      assert.equal(contactAt(OTHER_CAR), H - DROP, "car 5 stands on car 3's grid");
    } finally {
      activate(null);
    }
  });

  it("when its box is clipped to a small square about its far corner, then a point outside that square finds nothing", () => {
    const { g, i } = plainGround();
    activate(g);
    try {
      assert.equal(contactAt(OTHER_CAR), H - DROP, "the whole grid answers before the clip");
      g.clipBox(i, N - 1, N - 1, CLIP);
      assert.equal(contactAt(OTHER_CAR), -Infinity, "the point is outside the clipped box");
    } finally {
      activate(null);
    }
  });
});
