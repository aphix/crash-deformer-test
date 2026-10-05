import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CRASH } from "../deform/physics-util.ts";
import { DEG, FRAME, frame, makeCar as probeCar, worldOf } from "./ground-probe.test-util.ts";
import { makeCar, makeWorld, runWall, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { setGround, type Ground } from "../world/ground.ts";
import type { DeformableCar } from "./car.ts";

/**
 * A wreck's yaw is resisted by its tyres: each hub on the ground carries an equal share of the weight and rubs at
 * Coulomb μ (a tyre `muSlide`, a popped hub's rim `muScuff`), so spinning on the spot the torque is τ = Σ μ (M g / n) r
 * and the angular momentum L falls at τ. Before, the slide drag took a spin down at a third of that and the quiet
 * rule (0.35 s after the last hit) set every mass to the mean velocity: any spin was zeroed there, 2 rad/s too late
 * and 12 rad/s 0.6 s too early.
 */
type Spin = { hitAt: number; elapsed: number };

/** `w0` rad/s of rigid spin about the dynamic masses' centroid, the wreck's clock back at a fresh hit (quiet 0). */
function spinUp(car: DeformableCar, w0: number): { m: number; cx: number; cz: number; inertia: number } {
  const ms = car.deform.masses;
  const dyn = ms.filter((q) => q.dynamic);
  let m = 0;
  let cx = 0;
  let cz = 0;
  for (const q of dyn) {
    m += q.mass;
    cx += q.world.x * q.mass;
    cz += q.world.z * q.mass;
  }
  cx /= m;
  cz /= m;
  let inertia = 0;
  for (const q of dyn) inertia += q.mass * ((q.world.x - cx) ** 2 + (q.world.z - cz) ** 2);
  for (const q of ms) {
    q.vel.x = w0 * (q.world.z - cz);
    q.vel.z = -w0 * (q.world.x - cx);
  }
  const clock = car.deform as unknown as Spin;
  clock.hitAt = clock.elapsed;
  return { m, cx, cz, inertia };
}

/** The masses' angular momentum about their centroid. */
function momentum(car: DeformableCar): number {
  const ms = car.deform.masses;
  let x = 0;
  let z = 0;
  let m = 0;
  for (const q of ms) {
    x += q.world.x * q.mass;
    z += q.world.z * q.mass;
    m += q.mass;
  }
  x /= m;
  z /= m;
  let l = 0;
  for (const q of ms) l += q.mass * ((q.world.z - z) * q.vel.x - (q.world.x - x) * q.vel.z);
  return l;
}

/** Coulomb yaw torque of the hubs (all on the ground) for pure spin about (cx, cz). */
function tyreTorque(car: DeformableCar, m: number, cx: number, cz: number): number {
  const hubs = car.deform.masses.filter((q) => q.dynamic && q.hub);
  let tau = 0;
  for (const h of hubs) tau += (h.popped ? CRASH.muScuff : CRASH.muSlide) * ((m * 9.81) / hubs.length) * Math.hypot(h.world.x - cx, h.world.z - cz);
  return tau;
}

describe("a spinning wreck's tyres resist its yaw", () => {
  // The 64 km/h 40 % wall wreck: a popped front hub scraping, three tyres on. Spin set at quiet 0, as a hit leaves it.
  for (const w0 of [2, 4, 6, 9, 12]) {
    it(`bad: ${w0} rad/s: L halves in ${"0.5 L0/τ"} (±30 %) and is gone by 0.95 L0/τ (×0.5 to ×1.6) of the Coulomb model`, () => {
      const car = makeCar();
      runWall(64, 0.4, "front", { car, after: 2.5 });
      car.deform.drivetrainAlive = false;
      const { m, cx, cz } = spinUp(car, w0);
      const tau = tyreTorque(car, m, cx, cz);
      const l0 = momentum(car);
      const w = makeWorld([car], false, false);
      let t = 0;
      let t50 = Infinity;
      let t95 = Infinity;
      for (let f = 0; f < 60 * 4; f++) {
        tickWorld(w, FRAME);
        t += FRAME;
        const l = Math.abs(momentum(car));
        if (t50 === Infinity && l < 0.5 * l0) t50 = t;
        if (t95 === Infinity && l < 0.05 * l0) t95 = t;
      }
      const model50 = (0.5 * l0) / tau;
      const model95 = (0.95 * l0) / tau;
      assert.ok(t50 >= 0.7 * model50 - FRAME && t50 <= 1.3 * model50 + FRAME, `L halved at ${t50.toFixed(2)} s, model ${model50.toFixed(2)} s (τ ${tau.toFixed(0)} N·m)`);
      assert.ok(t95 >= 0.5 * model95 - FRAME && t95 <= 1.6 * model95 + FRAME, `L gone at ${t95.toFixed(2)} s, model ${model95.toFixed(2)} s (τ ${tau.toFixed(0)} N·m)`);
    });
  }

  it("bad: the quiet rule does not zero a spin: a wreck spun at 9 rad/s still turns at 0.45 s (quiet past 0.35 s), with more than a fifth of its momentum", () => {
    const car = makeCar();
    runWall(64, 0.4, "front", { car, after: 2.5 });
    car.deform.drivetrainAlive = false;
    spinUp(car, 9);
    const l0 = momentum(car);
    const w = makeWorld([car], false, false);
    for (let f = 0; f < 27; f++) tickWorld(w, FRAME);
    assert.ok(car.deform.quietTime() > 0.4, `quiet ${car.deform.quietTime().toFixed(2)} s: the setup no longer passes the quiet rule`);
    assert.ok(Math.abs(momentum(car)) > 0.2 * l0, `L ${momentum(car).toFixed(0)} of ${l0.toFixed(0)} after the quiet rule`);
  });
});

/** The plane `heightAt` = x·tan(pitch) (degrees), as wreck-slope.test.ts builds it. */
function slope(pitchDeg: number): Ground {
  const tp = Math.tan(pitchDeg / DEG);
  const n = Math.hypot(tp, 1);
  return {
    heightAt: (x) => x * tp,
    normalAt: (_x, _z, out) => {
      out.x = -tp / n;
      out.y = 1 / n;
      out.z = 0;
      return out;
    },
    frictionAt: () => 1,
    surfaceAt: () => "asphalt",
  };
}

describe("a spun wreck comes to rest", () => {
  afterEach(() => setGround(null));

  for (const [name, ground] of [
    ["flat ground", slope(0)],
    ["a 6.8° slope", slope(6.8)],
  ] as const) {
    it(`good: spun at 6 rad/s on ${name}, no spin and no creep 5 s on (L < 1 %, under 1 cm in the last second)`, () => {
      setGround(ground);
      const car = probeCar("sedan");
      car.spawnFacing(0, 0, Math.PI / 2, 0);
      car.group.position.y = ground.heightAt(0, 0, 0);
      const w = worldOf(car);
      const st = { acc: 0 };
      for (let n = 0; n < 30; n++) frame(w, null, st);
      const fw = car.forward;
      car.applyImpact(car.group.position.clone().addScaledVector(fw, 2).setY(car.group.position.y + 0.5), fw.clone().negate(), 20, 12);
      for (let n = 0; n < 60; n++) frame(w, null, st);
      assert.ok(car.crashed && car.deform.massActive, "the hit did not make a wreck");
      car.deform.drivetrainAlive = false;
      spinUp(car, 6);
      const l0 = momentum(car);
      const at = car.group.position.clone();
      for (let n = 0; n < 4 * 60; n++) frame(w, null, st);
      at.copy(car.group.position);
      for (let n = 0; n < 60; n++) frame(w, null, st);
      const creep = car.group.position.distanceTo(at);
      const l = momentum(car);
      car.dispose();
      assert.ok(Math.abs(l) < 0.01 * l0, `L ${l.toFixed(0)} of ${l0.toFixed(0)} after 5 s`);
      assert.ok(creep < 0.01, `crept ${(creep * 100).toFixed(1)} cm in the last second`);
    });
  }
});
