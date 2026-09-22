#!/usr/bin/env node
/**
 * Microbench the JS kernels. Run with `npm run bench`.
 * Times are wall ms for a fixed inner-loop count — compare before/after a change.
 */
import { performance } from "node:perf_hooks";
import * as m from "../src/game/shape-match-core.js";
import * as p from "../src/game/physics-core.js";

function time(name, n, fn) {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const ms = performance.now() - t0;
  const per = (ms / n) * 1e6;
  console.log(`${name.padEnd(28)} ${ms.toFixed(2).padStart(8)} ms   ${per.toFixed(1).padStart(8)} ns/op   n=${n}`);
  return ms;
}

const rest = [
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 0],
  [0, -1, 0],
].map(([x, y, z]) => ({ x, y, z, vx: 0, vy: 0, vz: 0, mass: 1 }));
const c = m.makeCluster(rest, rest.map((_, i) => i));
for (const pt of rest) pt.z *= 0.55;

const A = m.m3Id();
A[0] = 0.6;
A[8] = 1.3;
const R = m.m3();
const S = m.m3();

console.log("shape-match-core.js / physics-core.js\n");

time("m3Polar", 80_000, () => m.m3Polar(A, R, S));
time("matchCluster", 40_000, () => m.matchCluster(c, rest, 0.25));
time("applyPlasticity", 20_000, () => m.applyPlasticity(c, rest, 1 / 60, 0.4, true, 0.45));
time("transformSkinPointInto", 200_000, () => m.transformSkinPointInto(c, 0.2, 0.4, 1.1));
time("crushGate+transfer", 200_000, () => {
  const g = p.crushGate(14, p.regionSoftness("bumperFL"));
  p.forceTransfer(0.3, p.regionCrushBands("bumperFL"), false);
  p.cancelClosing(14, 0.1, 0.02, 1 / 60, 0);
  return g;
});
time("regionSoftness", 400_000, () => p.regionSoftness("railL"));
