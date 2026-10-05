import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { RigidBody } from "@dimforge/rapier3d";
import { driverLook } from "./driver-look.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";
import { Purses, BURST_AT, ITEM_SPEED, ITEMS_MIN, PURSE_SPEED, SPREAD } from "./ragdoll-purse.ts";
import { launch, makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armKill, DEFAULT_REALISM } from "../vehicle/vehicle-classes.ts";
import { THROW_ONSET } from "../match/phase.ts";
import { RANGE } from "../scenes/range.ts";

const STEP = 1 / 120;
/** A throw out of a windscreen at 20 m/s: the torso's pose and velocity, as `RagdollSystem.eject` places them. */
const V = new THREE.Vector3(20, 3.5, 5);

function seedWhere(woman: boolean): number {
  for (let seed = 1; ; seed++) if (driverLook(seed, 0).woman === woman) return seed;
}

async function system(seed: number): Promise<RagdollSystem> {
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  ragdolls.lookSeed = seed;
  return ragdolls;
}

function throwOut(r: RagdollSystem, car = 0, cop = false): void {
  const t = { car, p: new THREE.Vector3(0, 1.4, 0), q: new THREE.Quaternion(), v: V.clone(), w: new THREE.Vector3(), age: 0, cop };
  r["spawn"](t);
}

const purses = (r: RagdollSystem): Purses => r["purses"]!;
const bodiesOf = (r: RagdollSystem): RigidBody[] => purses(r)["bodies"][0]!;
const speed = (b: RigidBody) => Math.hypot(b.linvel().x, b.linvel().y, b.linvel().z);
const bits = (n: number) => n.toString(2).replaceAll("0", "").length;

/** Steps `r` one `STEP` at a time until set 0's things burst out; the steps it took. */
function untilBurst(r: RagdollSystem): number {
  for (let n = 1; n < 200; n++) {
    r.update(STEP, [], true, true, 0, null);
    if (purses(r)["burstAt"][0]) return n;
  }
  throw new Error("the purse never burst");
}

describe("given a thrown crash-test dummy driver who may carry a handbag (a woman civilian) that bursts open into small items", () => {
  it("when a civilian woman is thrown, then 1 handbag leaves at 0.85× her speed on her heading and, at the burst, 4-7 items fly at 0.85× the handbag's speed inside the spread cone", async () => {
    const r = await system(seedWhere(true));
    throwOut(r);
    assert.ok(purses(r).active(0));
    const purse = bodiesOf(r)[0]!;
    assert.ok(Math.abs(speed(purse) / V.length() - PURSE_SPEED) < 1e-3, `purse ${(speed(purse) / V.length()).toFixed(4)} of her speed`);
    const heading = V.clone().normalize();
    const pv = new THREE.Vector3().copy(purse.linvel()).normalize();
    assert.ok(pv.dot(heading) > 0.99999, "the purse leaves on her heading");
    const steps = untilBurst(r);
    assert.ok(Math.abs(steps * STEP - BURST_AT) <= STEP + 1e-9, `burst after ${steps} steps`);
    const u = new THREE.Vector3().copy(purse.linvel());
    const items = bodiesOf(r).slice(1).filter((b) => b.isEnabled());
    assert.ok(items.length >= ITEMS_MIN && items.length <= 7, `${items.length} things`);
    assert.equal(bits(purses(r)["on"][0]! >> 1), items.length);
    for (const b of items) {
      const v = new THREE.Vector3().copy(b.linvel());
      assert.ok(Math.abs(v.length() / u.length() - ITEM_SPEED) < 5e-3, `thing at ${(v.length() / u.length()).toFixed(4)} of the purse's speed`);
      const angle = v.angleTo(u);
      assert.ok(angle <= Math.atan(SPREAD) + 1e-3, `thing ${((angle * 180) / Math.PI).toFixed(1)}° off the purse's heading`);
      assert.ok(v.dot(u) > 0, "same way");
    }
    r.dispose();
  });

  it("when a man is thrown, or a policewoman is thrown, then no handbag and no items appear", async () => {
    const man = await system(seedWhere(false));
    throwOut(man);
    for (let n = 0; n < 60; n++) man.update(STEP, [], true, true, 0, null);
    assert.equal(purses(man).active(0), false);
    assert.equal(bodiesOf(man).some((b) => b.isEnabled()), false);
    man.dispose();
    const cop = await system(seedWhere(true));
    throwOut(cop, 0, true);
    for (let n = 0; n < 60; n++) cop.update(STEP, [], true, true, 0, null);
    assert.equal(purses(cop).active(0), false, "a policewoman carries no purse");
    assert.equal(bodiesOf(cop).some((b) => b.isEnabled()), false);
    cop.dispose();
  });

  it("when a civilian woman is thrown and 8 seconds pass, then the handbag and its items land on the ground, travel the way she went and come to rest", async () => {
    const r = await system(seedWhere(true));
    throwOut(r);
    let low = Infinity;
    for (let n = 0; n < 8 * 120; n++) {
      r.update(STEP, [], true, true, 0, null);
      for (const b of bodiesOf(r)) if (b.isEnabled()) low = Math.min(low, b.translation().y);
    }
    assert.ok(low > -0.05, `lowest centre ${low.toFixed(3)} m: nothing fell through the ground`);
    const live = bodiesOf(r).filter((b) => b.isEnabled());
    assert.ok(live.length >= 1 + ITEMS_MIN);
    for (const b of live) {
      assert.ok(b.translation().x > 5, `rest at x = ${b.translation().x.toFixed(1)} m: it travelled her way`);
      assert.ok(b.translation().y < 0.3, "on the ground");
      assert.ok(speed(b) < 0.5, `at rest (${speed(b).toFixed(2)} m/s)`);
    }
    r.dispose();
  });

  it("when the same throw is run twice with Math.random forbidden, then the handbag and items end up in exactly the same places", async () => {
    const seed = seedWhere(true);
    const real = Math.random;
    const poses: number[][] = [];
    for (let run = 0; run < 2; run++) {
      const r = await system(seed);
      // (three.js itself draws UUIDs from it, so only the throw is under the stub.)
      Math.random = () => {
        throw new Error("Math.random in a ragdoll throw");
      };
      try {
        throwOut(r);
        for (let n = 0; n < 150; n++) r.update(STEP, [], true, true, 0, null);
      } finally {
        Math.random = real;
      }
      poses.push(bodiesOf(r).flatMap((b) => (b.isEnabled() ? [b.translation().x, b.translation().y, b.translation().z] : [])));
      r.dispose();
    }
    assert.ok(poses[0]!.length >= 3 * (1 + ITEMS_MIN));
    assertSameNumbers(poses[0]!, poses[1]!, "the replayed throw");
  });

  it("when the dummy is removed, the game is reset, or the system is disposed, then the handbag and its items are cleared with it", async () => {
    const r = await system(seedWhere(true));
    throwOut(r);
    untilBurst(r);
    assert.ok(bodiesOf(r).filter((b) => b.isEnabled()).length >= 1 + ITEMS_MIN);
    r["despawn"](0);
    assert.equal(purses(r).active(0), false);
    assert.equal(bodiesOf(r).some((b) => b.isEnabled()), false, "dummy gone, purse gone");
    assert.equal(purses(r).mesh.count, 0);
    throwOut(r);
    untilBurst(r);
    r.reset();
    assert.equal(bodiesOf(r).some((b) => b.isEnabled()), false, "a new run clears the purse");
    throwOut(r);
    const scene = purses(r).mesh;
    r.dispose();
    assert.equal(scene.parent, null, "dispose takes the props mesh out of the scene");
  });

  it("when a driver is thrown again after a reset, then he keeps the same look, and when the next race changes the look seed, the look changes", async () => {
    const r = await system(7);
    const colors = () => Float32Array.from(r["mesh"].instanceColor!.array);
    throwOut(r, 3);
    const first = colors();
    r.reset();
    throwOut(r, 3);
    assertSameNumbers(colors(), first, "the same tee and hair after a reset and a re-throw");
    r.reset();
    r.lookSeed = 8;
    throwOut(r, 3);
    assert.ok(colors().some((v, i) => v !== first[i]), "the next race's driver looks different");
    r.dispose();
  });

  it("when a civilian woman is thrown from a 100 km/h crash into the barrier on sand at the ejection range, then she lands 20-40 m on, the handbag rests within 8 m of her instead of 30 m on, and no body spins faster than the spin cap", async () => {
    const car = makeCar("shape", 0.32, 0.45);
    armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
    launch(car, -RANGE.run, 0, Math.PI / 2, RANGE.kph / 3.6, 0);
    const w = makeWorld([car], true, false);
    w.onEject = (e) => r.launch(e, [car]);
    w.clock.slomoAt = THROW_ONSET;
    const r = await system(seedWhere(true));
    r.sand = true;
    let spin = 0;
    let torso = NaN;
    let still = 0;
    for (let wall = 0; wall < 14 && still < 3; wall += 1 / 60) {
      tickWorld(w, 1 / 60);
      r.update((1 / 60) * w.clock.timeScale, [car], true, true, 0, new THREE.Group());
      const d = r["dolls"].find((x) => x.live);
      if (!d) continue;
      for (const b of bodiesOf(r)) if (b.isEnabled()) spin = Math.max(spin, Math.hypot(b.angvel().x, b.angvel().y, b.angvel().z));
      torso = d.bodies[0]!.translation().x;
      still = d.still;
    }
    const purse = bodiesOf(r)[0]!.translation();
    r.dispose();
    // Before the spin cap: the purse spun at 79 rad/s, skipped on and came to rest 30 m past the dummy (58.6 m against 28.4 m).
    assert.ok(torso > 20 && torso < 40, `she landed at ${torso.toFixed(1)} m`);
    assert.ok(Math.abs(purse.x - torso) < 8, `the purse rests ${(purse.x - torso).toFixed(1)} m from her`);
    assert.ok(spin <= 15.5, `fastest spin ${spin.toFixed(1)} rad/s`);
  });
});
