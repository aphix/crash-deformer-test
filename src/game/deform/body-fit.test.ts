import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BodyFit } from "./body-fit.ts";

/** A body's masses in its own frame: (x, z, kg). */
const BODY: readonly (readonly [number, number, number])[] = [
  [0, 0, 260],
  [-0.4, 1.2, 88],
  [0.4, 1.2, 88],
  [0, -1.4, 64],
  [-0.5, 2.0, 9],
  [0.5, 2.0, 9],
  [-0.75, 0, 22],
  [0.75, 0, 22],
  [0, -0.9, 48],
];

describe("given a BodyFit (works out a body's spin rate from its parts' momentum) fed a body of nine parts", () => {
  /** The body moving as one rigid body (v = w (z, −x) about its centroid) at (vx, vz), plus `extra` rad/s for the one mass `who`. */
  function spinOf(w: number, vx: number, vz: number, who = -1, extra = 0): number {
    let m = 0;
    let cx = 0;
    let cz = 0;
    for (const [x, z, k] of BODY) {
      m += k;
      cx += x * k;
      cz += z * k;
    }
    cx /= m;
    cz /= m;
    const fit = new BodyFit();
    fit.reset();
    BODY.forEach(([x, z, k], i) => {
      const ww = i === who ? w + extra : w;
      fit.addSpin(k, x + 40, z - 9, vx + ww * (z - cz), vz - ww * (x - cx));
    });
    return fit.spin();
  }

  it("when the body turns rigidly at 2, -3.5 or 0.4 rad/s, with any body velocity and reference position, then the spin reads that rate to within 1e-9", () => {
    for (const [w, vx, vz] of [[2, 0, 0], [-3.5, 12, -4], [0.4, -30, 30]] as const) assert.ok(Math.abs(spinOf(w, vx, vz) - w) < 1e-9, `${w} rad/s at (${vx}, ${vz})`);
  });

  it("when the body only translates, or a single part is given, then the spin is 0", () => {
    assert.ok(Math.abs(spinOf(0, 9, -2)) < 1e-9);
    const fit = new BodyFit();
    fit.reset();
    fit.addSpin(100, 1, 2, 3, 4);
    assert.equal(fit.spin(), 0);
  });

  it("when one 9 kg corner runs at 20 rad/s instead of 2, then the body's spin rises by only that corner's share of the inertia, by under 1.5 rad/s, not by 18", () => {
    const base = spinOf(2, 0, 0);
    const jelly = spinOf(2, 0, 0, 4, 18);
    assert.ok(jelly > base && jelly < base + 1.5, `${base.toFixed(2)} -> ${jelly.toFixed(2)} rad/s`);
  });
});
