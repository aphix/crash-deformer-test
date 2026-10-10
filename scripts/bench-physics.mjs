#!/usr/bin/env node
/**
 * Microbench the JS kernels. Run with `npm run bench`.
 * Times are wall ms for a fixed inner-loop count — compare before/after a change.
 * "static" rows repeat one input (a warm-started solver converges on the first
 * call); "animated" rows step through a moving deformation like a crash does.
 */
import { performance } from "node:perf_hooks";
import * as m from "../src/game/kernel/shape-match-core.js";
import * as p from "../src/game/kernel/physics-core.js";

function time(name, n, fn) {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const ms = performance.now() - t0;
  const per = (ms / n) * 1e6;
  console.log(`${name.padEnd(30)} ${ms.toFixed(2).padStart(8)} ms   ${per.toFixed(1).padStart(8)} ns/op   n=${n}`);
  return ms;
}

const particles = (pts) => pts.map(([x, y, z]) => ({ x, y, z, vx: 0, vy: 0, vz: 0, mass: 1 }));
const restPts = [
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 0],
  [0, -1, 0],
];
const rest = particles(restPts);
const c = m.makeCluster(rest, rest.map((_, i) => i));
for (const pt of rest) pt.z *= 0.55;

const A = m.m3Id();
A[0] = 0.6;
A[8] = 1.3;
const R = m.m3();
const S = m.m3();
const q = m.quatId();

// A_k = rot((0.3, 1, 0.2), 0.6 sin 0.05k) · diag(0.6 + 0.2 sin 0.07k, 1, 1.3)
const FRAMES = 1024;
const anim = Array.from({ length: FRAMES }, (_, k) => {
  const ax = [0.3, 1, 0.2];
  const n = Math.hypot(...ax);
  const ang = 0.6 * Math.sin(0.05 * k);
  const s = Math.sin(ang / 2) / n;
  const x = ax[0] * s, y = ax[1] * s, z = ax[2] * s, w = Math.cos(ang / 2);
  const rot = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  const d = [0.6 + 0.2 * Math.sin(0.07 * k), 1, 1.3];
  return Float64Array.from(rot.map((v, i) => v * d[i % 3]));
});
let frame = 0;
function pose(ps, pts, k) {
  const a = anim[k];
  for (let i = 0; i < ps.length; i++) {
    const [x, y, z] = pts[i];
    ps[i].x = a[0] * x + a[1] * y + a[2] * z;
    ps[i].y = a[3] * x + a[4] * y + a[5] * z;
    ps[i].z = a[6] * x + a[7] * y + a[8] * z;
  }
}

const moving = particles(restPts);
const cm = m.makeCluster(moving, moving.map((_, i) => i));
const triPts = [
  [1, 0, 0],
  [-0.5, 0, 0.8],
  [-0.5, 0, -0.8],
];
const tri = particles(triPts);
const ct = m.makeCluster(tri, [0, 1, 2]);
const skinRest = restPts.map(([x, y, z]) => ({ x, y, z }));
const skinLocal = restPts.map(([x, y, z]) => ({ x, y, z: z * 0.55 }));
const skinMass = restPts.map(() => 1);
const cs = m.makeCluster(particles(restPts), restPts.map((_, i) => i));
const csa = m.makeCluster(particles(restPts), restPts.map((_, i) => i));

console.log("shape-match-core.js / physics-core.js\n");

time("m3Polar", 80_000, () => m.m3Polar(A, q, R, S));
time("m3Polar cold", 80_000, () => m.m3Polar(A, m.quatId(q), R, S));
time("m3Polar animated", 80_000, () => m.m3Polar(anim[frame++ & (FRAMES - 1)], q, R, S));
time("matchCluster", 40_000, () => m.matchCluster(c, rest, 0.25));
time("matchCluster animated", 40_000, () => {
  pose(moving, restPts, frame++ & (FRAMES - 1));
  m.matchCluster(cm, moving, 0.25);
});
time("matchCluster 3-particle anim", 40_000, () => {
  pose(tri, triPts, frame++ & (FRAMES - 1));
  m.matchCluster(ct, tri, 0.25);
});
time("applyPlasticity", 20_000, () => {
  m.PLASTIC.set([1 / 60, 0.4, 0.45]);
  m.applyPlasticity(c, rest);
});
time("matchSkinLocal", 40_000, () => m.matchSkinLocal(cs, skinRest, skinLocal, skinMass, 0.8));
time("matchSkinLocal animated", 40_000, () => {
  const a = anim[frame++ & (FRAMES - 1)];
  for (let i = 0; i < restPts.length; i++) {
    const [x, y, z] = restPts[i];
    const l = skinLocal[i];
    l.x = a[0] * x + a[1] * y + a[2] * z;
    l.y = a[3] * x + a[4] * y + a[5] * z;
    l.z = a[6] * x + a[7] * y + a[8] * z;
  }
  m.matchSkinLocal(csa, skinRest, skinLocal, skinMass, 0.8);
});
time("transformSkinPointInto", 200_000, () => m.transformSkinPointInto(c, 0.2, 0.4, 1.1));
time("crushGate+transfer", 200_000, () => {
  const g = p.crushGate(14, p.regionSoftness("bumperFL"));
  p.forceTransfer(0.3, p.regionCrushBands("bumperFL"), false);
  p.cancelClosing(14, 0.1, 0.02, 1 / 60, 0);
  return g;
});
time("regionSoftness", 400_000, () => p.regionSoftness("railL"));
