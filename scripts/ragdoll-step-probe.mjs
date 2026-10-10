// Rapier step cost of the cosmetic ragdoll world, headless, in the bench's city race (docs/PERF_BENCH.md: 15 AI + the player,
// police, aggression 1, seed 1). The real race stack steps at 60 Hz frames; each ejection is launched and `RagdollSystem.update`
// runs per frame as `CrashEngine` does. Per frame: ms in `world.step()` (all steps of the frame), colliders and bodies in the
// Rapier world (all / enabled / taking part in contacts), who owns them, dummies and cars with a proxy up.
//
//   node --experimental-strip-types --no-warnings scripts/ragdoll-step-probe.mjs [--seconds 50] [--seed 1] [--cars 15] [--window 12] [--csv out.csv]
//   ... --field [--seconds 6]: the same columns for a fixed scene instead of the race (the field test of `engine-ragdoll-field.test.ts`:
//   32 cars on rings around the middle, four drivers thrown up out of their windshields at once), so two builds whose races
//   diverge (a different first crash) can be compared on one scene.
//
// Table: per race second, then p50 / p95 / max of the step ms over the frames (all, and the crash window: from the first thrown
// dummy or knocked prop's frame - 1 s for 12 s). Run it alone on a quiet machine (the worker): timings are wall ms.
import { writeFileSync } from "node:fs";
import * as THREE from "three";
import "../src/game/kernel/rapier-node.test-util.ts";
import { makeWorld, frame, FRAME } from "../src/game/world/race-world.test-util.ts";
import { makeCar } from "../src/game/contact/crash-scenarios.test-util.ts";
import { blankEjection } from "../src/game/vehicle/ejection.ts";
import { RagdollSystem } from "../src/game/present/engine-ragdoll.ts";
import { MAX_CARS } from "../src/game/scenes/fleet.ts";
import { setGround } from "../src/game/world/ground.ts";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1];
};
const SECONDS = Number(arg("seconds", 50));
const SEED = Number(arg("seed", 1));
const CARS = Number(arg("cars", 15));
const WINDOW = Number(arg("window", 12));
const csv = arg("csv", null);
const FIELD = process.argv.includes("--field");

const UP = new THREE.Vector3(0, 1, 0);
let w;
let fieldCars = [];
if (FIELD) {
  for (let i = 0; i < 32; i++) fieldCars.push(makeCar());
  w = { live: () => fieldCars, ejections: [], race: { exit() {} } };
} else {
  w = makeWorld();
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "program", options: { trackId: "city", laps: 9, aiCount: CARS, police: true, aggression: 1, spectate: false, noReset: false } });
  w.race.reseed(SEED);
  w.race.command({ type: "start" });
  w.seat.mode = "follow";
}
const driveField = (t) => {
  for (let i = 0; i < 32; i++) {
    const c = fieldCars[i];
    const r = 12 + (i % 8) * 4;
    const k = (14 / r) * (i % 2 ? 1 : -1);
    const a = k * t + (i * 2 * Math.PI) / 32;
    c.group.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    c.velocity.set(-Math.sin(a) * r * k, 0, Math.cos(a) * r * k);
    c.group.quaternion.setFromAxisAngle(UP, Math.atan2(c.velocity.x, c.velocity.z));
    c.group.updateMatrixWorld();
  }
};
const throwField = (i) => {
  const c = fieldCars[i];
  const e = blankEjection();
  e.car = i;
  e.dir.set(0, 0, 1).applyQuaternion(c.group.quaternion);
  e.pos.copy(c.group.position).addScaledVector(UP, 1.3).addScaledVector(e.dir, 0.6);
  e.quat.copy(c.group.quaternion);
  e.rel.copy(e.dir).multiplyScalar(3).addScaledVector(UP, 6);
  e.carVel.copy(c.velocity);
  e.spin.set(3, 0, 0);
  rd.launch(e, fieldCars);
};

const rd = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
await rd.preload();
if (!FIELD) w.onKnock = (index, car, vx, vy, vz) => rd.knockProp(index, car, vx, vy, vz);
const world = rd.world;
let stepMs = 0;
let steps = 0;
const step = world.step.bind(world);
world.step = (...a) => {
  const t = performance.now();
  const r = step(...a);
  stepMs += performance.now() - t;
  steps++;
  return r;
};

const rows = [];
const state = { acc: 0 };
let seen = 0;
let first = -1;
for (let n = 0; n * FRAME < SECONDS; n++) {
  if (FIELD) {
    driveField(n * FRAME);
    if (n === 0) for (let i = 0; i < 4; i++) throwField(i);
  } else frame(w, state);
  for (; seen < w.ejections.length; seen++) rd.launch(w.ejections[seen], w.live());
  stepMs = 0;
  steps = 0;
  const t0 = performance.now();
  rd.update(FRAME, w.live(), true, false, 0, null);
  const updateMs = performance.now() - t0;
  const dolls = rd.dolls.filter((d) => d.live).length;
  const knocked = rd.props.count ?? 0;
  if (first < 0 && (dolls > 0 || knocked > 0)) first = n;
  // Who owns what: a collider's parent body is one of the car bodies (proxy), a doll's, a prop's, or none (the world's statics).
  const owner = new Map();
  const carOf = new Map();
  rd.carBodies.forEach((b, i) => carOf.set(b.handle, i));
  const dollOf = new Set(rd.dolls.flatMap((d) => d.bodies.map((b) => b.handle)));
  let all = 0;
  let enabled = 0;
  let active = 0;
  let leaves = 0;
  let panes = 0;
  let dollC = 0;
  let other = 0;
  world.colliders.forEach((c) => {
    all++;
    const p = c.parent();
    const on = c.isEnabled() && (!p || p.isEnabled());
    if (on) enabled++;
    const g = c.collisionGroups();
    if (on && (g >>> 16) !== 0 && (g & 0xffff) !== 0) active++;
    if (p && carOf.has(p.handle)) {
      if (!on) return;
      if (c.shape.halfExtents !== undefined && c.halfExtents().z < 0.035 && c.halfExtents().z > 0.025) panes++;
      else leaves++;
    } else if (p && dollOf.has(p.handle)) dollC++;
    else other++;
  });
  let dyn = 0;
  let awake = 0;
  world.bodies.forEach((b) => {
    if (!b.isDynamic() || !b.isEnabled()) return;
    dyn++;
    if (!b.isSleeping()) awake++;
  });
  // Contact pairs and manifold points the narrow phase holds for the dummies' colliders (a dummy-dummy pair counts twice).
  let pairs = 0;
  let points = 0;
  for (const d of rd.dolls) {
    if (!d.live) continue;
    for (const b of d.bodies) {
      const c = b.collider(0);
      world.narrowPhase.contactPairsWith(c, (o) => {
        world.narrowPhase.contactPair(c, o, (m) => {
          const k = m.numContacts();
          if (k > 0) pairs++;
          points += k;
        });
      });
    }
  }
  let cars = 0;
  for (let i = 0; i < MAX_CARS; i++) if (rd.on[i]) cars++;
  rows.push({ n, t: n * FRAME, stepMs, steps, updateMs, all, enabled, active, bodies: world.bodies.len(), dyn, awake, pairs, points, leaves, panes, dollC, other, cars, dolls, knocked });
}
rd.dispose();
w.race.exit();
setGround(null);

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const f = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(3));
console.log(`cars in race: ${w.live().length}, frames ${rows.length}, first dummy/knocked prop at race frame ${first} (${(first * FRAME).toFixed(2)} s)`);
console.log("sec  step ms (sum)  steps  colliders all/enabled/active  bodies dyn/awake  pairs/points  leaves panes dollC other  carsOn dolls knocked");
for (let s = 0; s * 60 < rows.length; s++) {
  const r = rows.slice(s * 60, s * 60 + 60);
  const m = (k) => r.reduce((a, x) => a + x[k], 0) / r.length;
  const mx = (k) => Math.max(...r.map((x) => x[k]));
  console.log(`${String(s).padStart(3)}  ${f(m("stepMs"))}  ${f(m("steps"))}  ${f(mx("all"))}/${f(mx("enabled"))}/${f(mx("active"))}  ${f(mx("bodies"))} ${f(mx("dyn"))}/${f(mx("awake"))}  ${f(mx("pairs"))}/${f(mx("points"))}  ${f(mx("leaves"))} ${f(mx("panes"))} ${f(mx("dollC"))} ${f(mx("other"))}  ${f(mx("cars"))} ${f(mx("dolls"))} ${f(mx("knocked"))}`);
}
const win = first < 0 ? [] : rows.slice(Math.max(0, first - 60), first - 60 + WINDOW * 60);
for (const [name, r] of [["all frames", rows], [`crash window (${WINDOW} s from 1 s before the first dummy or knocked prop)`, win]]) {
  if (!r.length) continue;
  const ms = r.map((x) => x.stepMs);
  console.log(`${name}: step ms p50 ${f(pct(ms, 0.5))} p95 ${f(pct(ms, 0.95))} max ${f(Math.max(...ms))}; update ms p50 ${f(pct(r.map((x) => x.updateMs), 0.5))} p95 ${f(pct(r.map((x) => x.updateMs), 0.95))}; colliders in world max ${Math.max(...r.map((x) => x.all))}, enabled max ${Math.max(...r.map((x) => x.enabled))}, active max ${Math.max(...r.map((x) => x.active))}; bodies max ${Math.max(...r.map((x) => x.bodies))}`);
}
if (csv) {
  const keys = Object.keys(rows[0]);
  writeFileSync(csv, `${keys.join(",")}\n${rows.map((r) => keys.map((k) => r[k]).join(",")).join("\n")}\n`);
}
